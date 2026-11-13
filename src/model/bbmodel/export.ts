/**
 * Export a Java model JSON plus PNG texture bytes as a Blockbench Java
 * Block/Item project (.bbmodel).
 *
 * The output mirrors what Blockbench itself saves (JannisX11/blockbench,
 * master ec0b2827104d0799c153bfb5f867579c0c44652f): meta with
 * format_version 5.0 / model_format java_block, resolution, cube elements
 * with origin/rotation/faces (texture = index into the textures array),
 * outliner, embedded base64 textures, and display.
 *
 * A face may name its texture through a `#variable` or a bare resource
 * location; a bare location becomes its own synthetic texture variable so the
 * project still carries an indexed textures array.
 */

import { Buffer } from "node:buffer";
import { McAssetError } from "../../core/errors.ts";
import { decodePng } from "../../io/png.ts";
import { validateResourceLocation } from "../../validate/resource-location.ts";
import { formatNumber } from "../edit-support.ts";
import {
	type JsonNode,
	jsonPointer,
	parseJsonDocument,
	serializeJsonDocument,
} from "../json-document.ts";
import { MODEL_LIMITS } from "../limits.ts";
import {
	DIRECTIONS,
	type Direction,
	type DisplayPosition,
	type ElementRotationSpec,
	type Vec3,
} from "../types.ts";
import { checkFileBytes, checkStringBytes } from "./document.ts";
import type { BbmodelExportResult, BbmodelWarning } from "./types.ts";

type JsonObject = Extract<JsonNode, { type: "object" }>;

const CUBE_FACE_ORDER = [
	"north",
	"east",
	"south",
	"west",
	"up",
	"down",
] as const;

const DISPLAY_POSITIONS = [
	"thirdperson_righthand",
	"thirdperson_lefthand",
	"firstperson_righthand",
	"firstperson_lefthand",
	"gui",
	"head",
	"ground",
	"fixed",
	"on_shelf",
] as const satisfies readonly DisplayPosition[];

const PNG_DATA_URL = "data:image/png;base64,";

function member(node: JsonNode | undefined, key: string): JsonNode | undefined {
	return node?.type === "object"
		? node.members.find((entry) => entry.key === key)?.value
		: undefined;
}

function asObject(node: JsonNode | undefined): JsonObject | undefined {
	return node?.type === "object" ? node : undefined;
}

function asString(node: JsonNode | undefined): string | undefined {
	return node?.type === "string" ? node.value : undefined;
}

function asNumber(node: JsonNode | undefined): number | undefined {
	return node?.type === "number" ? node.value : undefined;
}

function asBoolean(node: JsonNode | undefined): boolean | undefined {
	return node?.type === "boolean" ? node.value : undefined;
}

function structureError(
	reason: string,
	details: Record<string, unknown>,
): never {
	throw new McAssetError(
		"MODEL_INVALID_STRUCTURE",
		`The model cannot be exported as .bbmodel: ${reason}.`,
		{ reason, ...details },
	);
}

function tupleOf(
	node: JsonNode | undefined,
	length: number,
	pointer: string,
): number[] | undefined {
	if (node === undefined) return undefined;
	if (node.type !== "array" || node.items.length !== length) {
		structureError("invalid-array", { pointer, expected: length });
	}
	const values: number[] = [];
	for (const [index, item] of node.items.entries()) {
		const value = asNumber(item);
		if (value === undefined || !Number.isFinite(value)) {
			structureError("invalid-number", {
				pointer: `${pointer}/${index}`,
			});
		}
		values.push(value);
	}
	return values;
}

function vec3(values: readonly number[]): Vec3 {
	return [values[0] as number, values[1] as number, values[2] as number];
}

interface TextureVariable {
	readonly key: string;
	readonly value: string;
	readonly forceTranslucent: boolean;
}

function readTextureVariables(root: JsonNode): TextureVariable[] {
	const textures = asObject(member(root, "textures"));
	if (textures === undefined) return [];
	if (textures.members.length > MODEL_LIMITS.maxTextures) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			"The model texture variable limit is exceeded.",
			{ limit: MODEL_LIMITS.maxTextures, actual: textures.members.length },
		);
	}
	const variables: TextureVariable[] = [];
	for (const entry of textures.members) {
		let value: string;
		let forceTranslucent = false;
		if (entry.value.type === "string") {
			value = entry.value.value;
		} else if (entry.value.type === "object") {
			const sprite = asString(member(entry.value, "sprite"));
			if (sprite === undefined) {
				structureError("invalid-texture", {
					pointer: jsonPointer(["textures", entry.key]),
				});
			}
			value = sprite;
			forceTranslucent =
				asBoolean(member(entry.value, "force_translucent")) === true;
		} else {
			structureError("invalid-texture", {
				pointer: jsonPointer(["textures", entry.key]),
			});
		}
		checkStringBytes(entry.key, `Texture variable ${entry.key}`);
		checkStringBytes(value, `Texture value for ${entry.key}`);
		if (!value.startsWith("#")) {
			const invalid = validateResourceLocation(value).some(
				(finding) => finding.level === "error",
			);
			if (invalid || hasPathEscape(value)) {
				structureError("invalid-texture-link", {
					pointer: jsonPointer(["textures", entry.key]),
					value,
				});
			}
		} else if (value.length === 1) {
			structureError("invalid-texture-link", {
				pointer: jsonPointer(["textures", entry.key]),
				value,
			});
		}
		variables.push({ key: entry.key, value, forceTranslucent });
	}
	return variables;
}

function hasPathEscape(value: string): boolean {
	const path = value.includes(":")
		? value.slice(value.indexOf(":") + 1)
		: value;
	return path
		.split("/")
		.some((segment) => segment === "" || segment === "." || segment === "..");
}

function addReachableTexture(
	key: string,
	variables: ReadonlyMap<string, TextureVariable>,
	reachable: Set<string>,
): void {
	const seen = new Set<string>();
	let current = key;
	for (;;) {
		if (seen.has(current)) {
			structureError("texture-cycle", {
				pointer: jsonPointer(["textures", current]),
				via: [...seen, current],
			});
		}
		seen.add(current);
		if (reachable.has(current)) return;
		const variable = variables.get(current);
		if (variable === undefined) {
			structureError("undefined-texture-variable", {
				pointer: jsonPointer(["textures", current]),
			});
		}
		reachable.add(current);
		if (!variable.value.startsWith("#")) return;
		current = variable.value.slice(1);
	}
}

function textureIdentity(sprite: string): {
	namespace: string;
	folder?: string;
	name: string;
} {
	const namespace = sprite.includes(":")
		? (sprite.slice(0, sprite.indexOf(":")) as string)
		: "minecraft";
	const path = sprite.includes(":")
		? sprite.slice(sprite.indexOf(":") + 1)
		: sprite;
	const slash = path.lastIndexOf("/");
	return {
		namespace,
		...(slash < 0 ? {} : { folder: path.slice(0, slash) }),
		name: path.slice(slash + 1),
	};
}

function hash32(text: string, seed: number): number {
	let hash = seed >>> 0;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

function uuidFor(text: string): string {
	let hex = "";
	for (let index = 0; index < 4; index += 1) {
		hex += hash32(text, 0x811c9dc5 + index * 0x9e3779b9)
			.toString(16)
			.padStart(8, "0");
	}
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

interface ExportedFace {
	readonly texture: string;
	readonly uv?: readonly number[];
	readonly rotation?: number;
	readonly cullface?: string;
	readonly tintindex?: number;
}

interface ExportedElement {
	readonly name?: string;
	readonly from: readonly number[];
	readonly to: readonly number[];
	readonly rotation?: ElementRotationSpec;
	readonly shade?: boolean;
	readonly shadeDirectionOverride?: Direction;
	readonly lightEmission?: number;
	readonly faces: Readonly<Record<string, ExportedFace>>;
	/** 2 when no face has uv (Blockbench auto-maps); 0 otherwise. */
	readonly autouv: 0 | 2;
}

function readRotation(
	element: JsonObject,
	pointer: string,
): ElementRotationSpec | undefined {
	const rotation = asObject(member(element, "rotation"));
	if (rotation === undefined) {
		if (member(element, "rotation") !== undefined) {
			throw new McAssetError(
				"MODEL_INVALID_ROTATION",
				"Rotation must be an object.",
				{ pointer },
			);
		}
		return undefined;
	}
	const origin = tupleOf(member(rotation, "origin"), 3, `${pointer}/origin`);
	if (origin === undefined) {
		throw new McAssetError(
			"MODEL_INVALID_ROTATION",
			"Rotation needs an origin.",
			{ pointer, reason: "origin" },
		);
	}
	const axis = asString(member(rotation, "axis"));
	const angle = asNumber(member(rotation, "angle"));
	const xyz = { x: 0, y: 0, z: 0 };
	let xyzPresent = false;
	for (const key of ["x", "y", "z"] as const) {
		const value = asNumber(member(rotation, key));
		if (value !== undefined) {
			xyz[key] = value;
			xyzPresent = true;
		}
	}
	const rescale = asBoolean(member(rotation, "rescale")) === true;
	if ((axis !== undefined || angle !== undefined) && xyzPresent) {
		throw new McAssetError(
			"MODEL_INVALID_ROTATION",
			"Rotation must not mix axis/angle with xyz.",
			{ pointer, reason: "ambiguous" },
		);
	}
	if (axis !== undefined || angle !== undefined) {
		if (
			axis === undefined ||
			angle === undefined ||
			!["x", "y", "z"].includes(axis) ||
			!Number.isFinite(angle)
		) {
			throw new McAssetError(
				"MODEL_INVALID_ROTATION",
				"Axis rotation needs a valid axis and angle.",
				{ pointer, reason: "axis-angle" },
			);
		}
		return {
			origin: vec3(origin),
			axis: axis as "x" | "y" | "z",
			angle,
			...(rescale ? { rescale } : {}),
		};
	}
	if (!xyzPresent) {
		throw new McAssetError(
			"MODEL_INVALID_ROTATION",
			"Rotation must specify axis/angle or xyz.",
			{ pointer, reason: "empty" },
		);
	}
	return {
		origin: vec3(origin),
		x: xyz.x,
		y: xyz.y,
		z: xyz.z,
		...(rescale ? { rescale: true } : {}),
	};
}

function readElements(
	root: JsonNode,
	variableKeys: ReadonlySet<string>,
): { elements: ExportedElement[]; warnsPartialUv: boolean } {
	const elementsNode = member(root, "elements");
	if (elementsNode === undefined)
		return { elements: [], warnsPartialUv: false };
	if (elementsNode.type !== "array") {
		structureError("elements-not-array", {
			pointer: jsonPointer(["elements"]),
		});
	}
	if (elementsNode.items.length > MODEL_LIMITS.maxElements) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			"The model element limit is exceeded.",
			{ limit: MODEL_LIMITS.maxElements, actual: elementsNode.items.length },
		);
	}
	const elements: ExportedElement[] = [];
	let sawMissingUv = false;
	let sawPresentUv = false;
	for (const [index, node] of elementsNode.items.entries()) {
		const element = asObject(node);
		if (element === undefined) {
			structureError("element-not-object", {
				pointer: jsonPointer(["elements", index]),
			});
		}
		const pointer = jsonPointer(["elements", index]);
		const from = tupleOf(member(element, "from"), 3, `${pointer}/from`);
		const to = tupleOf(member(element, "to"), 3, `${pointer}/to`);
		if (from === undefined || to === undefined) {
			structureError("element-extent", { pointer });
		}
		const facesNode = asObject(member(element, "faces"));
		const faces: Record<string, ExportedFace> = {};
		let faceCount = 0;
		let missingUvCount = 0;
		if (facesNode !== undefined) {
			for (const face of facesNode.members) {
				if (!(DIRECTIONS as readonly string[]).includes(face.key)) {
					structureError("unknown-face", {
						pointer: `${pointer}/faces/${face.key}`,
					});
				}
				const value = asObject(face.value);
				const texture =
					value === undefined ? undefined : asString(member(value, "texture"));
				if (value === undefined || texture === undefined) {
					structureError("face-texture", {
						pointer: `${pointer}/faces/${face.key}`,
					});
				}
				checkStringBytes(texture, "A face texture");
				if (!texture.startsWith("#")) {
					const invalid = validateResourceLocation(texture).some(
						(finding) => finding.level === "error",
					);
					if (invalid || hasPathEscape(texture)) {
						structureError("invalid-texture-link", {
							pointer: `${pointer}/faces/${face.key}/texture`,
							texture,
						});
					}
				} else {
					const key = texture.slice(1);
					if (!variableKeys.has(key)) {
						structureError("undefined-texture-variable", {
							pointer: `${pointer}/faces/${face.key}/texture`,
							texture,
						});
					}
				}
				const uv = tupleOf(
					member(value, "uv"),
					4,
					`${pointer}/faces/${face.key}/uv`,
				);
				faceCount += 1;
				if (uv === undefined) {
					sawMissingUv = true;
					missingUvCount += 1;
				} else sawPresentUv = true;
				const rotation = asNumber(member(value, "rotation"));
				if (rotation !== undefined && ![0, 90, 180, 270].includes(rotation)) {
					throw new McAssetError(
						"MODEL_INVALID_UV",
						"Face rotation must be 0, 90, 180, or 270.",
						{ pointer: `${pointer}/faces/${face.key}/rotation` },
					);
				}
				const cullface = asString(member(value, "cullface"));
				if (
					cullface !== undefined &&
					!(DIRECTIONS as readonly string[]).includes(cullface)
				) {
					structureError("face-cullface", {
						pointer: `${pointer}/faces/${face.key}/cullface`,
					});
				}
				const tintindex = asNumber(member(value, "tintindex"));
				if (tintindex !== undefined && !Number.isInteger(tintindex)) {
					structureError("face-tint", {
						pointer: `${pointer}/faces/${face.key}/tintindex`,
					});
				}
				faces[face.key] = {
					texture,
					...(uv === undefined ? {} : { uv }),
					...(rotation === undefined ? {} : { rotation }),
					...(cullface === undefined ? {} : { cullface }),
					...(tintindex === undefined ? {} : { tintindex }),
				};
			}
		}
		const name = asString(member(element, "name"));
		const shade = asBoolean(member(element, "shade"));
		const shadeDirectionOverride = asString(
			member(element, "shade_direction_override"),
		);
		if (
			shadeDirectionOverride !== undefined &&
			!(DIRECTIONS as readonly string[]).includes(shadeDirectionOverride)
		) {
			structureError("shade-direction", {
				pointer: `${pointer}/shade_direction_override`,
			});
		}
		const lightEmission = asNumber(member(element, "light_emission"));
		if (
			lightEmission !== undefined &&
			(!Number.isInteger(lightEmission) ||
				lightEmission < 0 ||
				lightEmission > 15)
		) {
			structureError("light-emission", {
				pointer: `${pointer}/light_emission`,
			});
		}
		elements.push({
			...(name === undefined ? {} : { name }),
			from,
			to,
			...(member(element, "rotation") === undefined
				? {}
				: {
						rotation: readRotation(
							element,
							`${pointer}/rotation`,
						) as ElementRotationSpec,
					}),
			...(shade === undefined ? {} : { shade }),
			...(shadeDirectionOverride === undefined
				? {}
				: { shadeDirectionOverride: shadeDirectionOverride as Direction }),
			...(lightEmission === undefined ? {} : { lightEmission }),
			faces,
			autouv: missingUvCount === 0 || missingUvCount < faceCount ? 0 : 2,
		});
	}
	return { elements, warnsPartialUv: sawMissingUv && sawPresentUv };
}

function readResolution(root: JsonNode): { width: number; height: number } {
	const size = member(root, "texture_size");
	if (size === undefined) return { width: 16, height: 16 };
	const values = tupleOf(size, 2, "/texture_size");
	if (
		values === undefined ||
		values.some(
			(value) => !Number.isInteger(value) || value < 1 || value > 4096,
		)
	) {
		structureError("invalid-texture-size", {
			pointer: "/texture_size",
		});
	}
	return { width: values[0] as number, height: values[1] as number };
}

function scaleUv(
	uv: readonly number[],
	resolution: Readonly<{ width: number; height: number }>,
): readonly number[] {
	if (resolution.width === 16 && resolution.height === 16) return uv;
	return [
		((uv[0] as number) * resolution.width) / 16,
		((uv[1] as number) * resolution.height) / 16,
		((uv[2] as number) * resolution.width) / 16,
		((uv[3] as number) * resolution.height) / 16,
	];
}

function numberNode(value: number): JsonNode {
	return { type: "number", raw: formatNumber(value), value };
}
function stringNode(value: string): JsonNode {
	return { type: "string", value };
}
function booleanNode(value: boolean): JsonNode {
	return { type: "boolean", value };
}
function arrayNode(items: readonly JsonNode[]): JsonNode {
	return { type: "array", items };
}
function objectNode(
	members: readonly { key: string; value: JsonNode }[],
): JsonNode {
	return { type: "object", members };
}

interface TextureSlot {
	/** .bbmodel texture id, which becomes the Java texture variable name. */
	readonly id: string;
	/** Sprite resource location, or "#other" for an alias. */
	readonly value: string;
	readonly forceTranslucent: boolean;
	/** Key in the caller's PNG map; absent for aliases. */
	readonly bytesKey?: string;
}

interface TextureSlots {
	/** One entry per .bbmodel texture: declared variables, then direct sprites. */
	readonly slots: readonly TextureSlot[];
	/** Face texture reference (`#name` or a bare sprite) to the textures index. */
	readonly indexByReference: ReadonlyMap<string, number>;
}

/** A direct face sprite needs a texture variable name Blockbench can show. */
function uniqueTextureKey(sprite: string, used: ReadonlySet<string>): string {
	const leaf = textureIdentity(sprite).name;
	const sanitized = leaf.replace(/[^A-Za-z0-9_]/g, "_");
	const stem = sanitized === "" ? "texture" : sanitized;
	if (!used.has(stem)) return stem;
	let suffix = 2;
	while (used.has(`${stem}_${suffix}`)) suffix += 1;
	return `${stem}_${suffix}`;
}

/**
 * Every texture the project must carry: the reachable variables in declaration
 * order, then one synthetic variable per sprite a face names directly. A face
 * may write `#name` or a bare resource location; both resolve to one index.
 */
function collectTextureSlots(
	variables: readonly TextureVariable[],
	reachable: ReadonlySet<string>,
	directSprites: readonly string[],
): TextureSlots {
	const included = variables.filter((variable) => reachable.has(variable.key));
	const used = new Set(included.map((variable) => variable.key));
	// "particle" is Blockbench's particle flag, not a free texture variable name.
	used.add("particle");
	const slots: TextureSlot[] = [];
	const indexByReference = new Map<string, number>();
	for (const variable of included) {
		indexByReference.set(`#${variable.key}`, slots.length);
		slots.push({
			id: variable.key,
			value: variable.value,
			forceTranslucent: variable.forceTranslucent,
			...(variable.value.startsWith("#") ? {} : { bytesKey: variable.key }),
		});
	}
	for (const sprite of directSprites) {
		const id = uniqueTextureKey(sprite, used);
		used.add(id);
		indexByReference.set(sprite, slots.length);
		slots.push({
			id,
			value: sprite,
			forceTranslucent: false,
			bytesKey: sprite,
		});
	}
	if (slots.length > MODEL_LIMITS.maxTextures) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			"The .bbmodel texture limit is exceeded.",
			{ limit: MODEL_LIMITS.maxTextures, actual: slots.length },
		);
	}
	return { slots, indexByReference };
}

function buildTextures(
	textureSlots: TextureSlots,
	textureBytes: ReadonlyMap<string, Uint8Array>,
	resolution: Readonly<{ width: number; height: number }>,
): readonly JsonNode[] {
	const needed = new Set<string>();
	const aliases = new Set<string>();
	for (const slot of textureSlots.slots) {
		if (slot.bytesKey === undefined) aliases.add(slot.id);
		else needed.add(slot.bytesKey);
	}
	for (const key of textureBytes.keys()) {
		if (needed.has(key)) continue;
		if (aliases.has(key)) {
			throw new McAssetError(
				"BBMODEL_INVALID_TEXTURE",
				`Texture ${key} is an alias; supply the texture it points to.`,
				{ reason: "alias-texture", key },
			);
		}
		throw new McAssetError(
			"BBMODEL_INVALID_TEXTURE",
			`Texture ${key} is not used by the model.`,
			{ reason: "unknown-texture", key },
		);
	}
	const missing: string[] = [];
	const nodes: JsonNode[] = [];
	for (const slot of textureSlots.slots) {
		const uuid = uuidFor(`texture:${slot.id}`);
		const members: { key: string; value: JsonNode }[] = [];
		members.push(
			{ key: "path", value: stringNode("") },
			{
				key: "name",
				value: stringNode(
					slot.value.startsWith("#")
						? slot.value
						: textureIdentity(slot.value).name,
				),
			},
		);
		const identity = slot.value.startsWith("#")
			? undefined
			: textureIdentity(slot.value);
		if (identity?.folder !== undefined) {
			members.push({ key: "folder", value: stringNode(identity.folder) });
		}
		members.push(
			{ key: "namespace", value: stringNode(identity?.namespace ?? "") },
			{ key: "id", value: stringNode(slot.id) },
		);
		if (slot.bytesKey === undefined) {
			members.push(
				{ key: "width", value: numberNode(0) },
				{ key: "height", value: numberNode(0) },
				{ key: "uv_width", value: numberNode(0) },
				{ key: "uv_height", value: numberNode(0) },
				{ key: "particle", value: booleanNode(slot.id === "particle") },
				{ key: "visible", value: booleanNode(true) },
				{ key: "internal", value: booleanNode(true) },
				{ key: "saved", value: booleanNode(false) },
				{ key: "uuid", value: stringNode(uuid) },
			);
			nodes.push(objectNode(members));
			continue;
		}
		const bytes = textureBytes.get(slot.bytesKey);
		if (bytes === undefined) {
			missing.push(slot.bytesKey);
			continue;
		}
		let width: number;
		let height: number;
		try {
			const decoded = decodePng(bytes);
			width = decoded.canvas.width;
			height = decoded.canvas.height;
		} catch {
			throw new McAssetError(
				"BBMODEL_INVALID_TEXTURE",
				`Texture ${slot.bytesKey} is not a decodable PNG.`,
				{ reason: "png", key: slot.bytesKey },
			);
		}
		members.push(
			{ key: "width", value: numberNode(width) },
			{ key: "height", value: numberNode(height) },
			{ key: "uv_width", value: numberNode(resolution.width) },
			{ key: "uv_height", value: numberNode(resolution.height) },
			{ key: "particle", value: booleanNode(slot.id === "particle") },
		);
		if (slot.forceTranslucent) {
			members.push({ key: "force_translucent", value: booleanNode(true) });
		}
		members.push(
			{ key: "use_as_default", value: booleanNode(false) },
			{ key: "render_mode", value: stringNode("default") },
			{ key: "visible", value: booleanNode(true) },
			{ key: "internal", value: booleanNode(true) },
			{ key: "saved", value: booleanNode(false) },
			{ key: "uuid", value: stringNode(uuid) },
			{
				key: "source",
				value: stringNode(
					`${PNG_DATA_URL}${Buffer.from(bytes).toString("base64")}`,
				),
			},
		);
		nodes.push(objectNode(members));
	}
	if (missing.length > 0) {
		throw new McAssetError(
			"BBMODEL_MISSING_TEXTURE",
			`Textures are missing for: ${missing.join(", ")}.`,
			{ reason: "missing-texture", keys: missing },
		);
	}
	return nodes;
}

function buildElements(
	elements: readonly ExportedElement[],
	indexByReference: ReadonlyMap<string, number>,
	resolution: Readonly<{ width: number; height: number }>,
): JsonNode[] {
	return elements.map((element, index) => {
		const rotation = element.rotation;
		const angles: readonly number[] =
			rotation === undefined
				? [0, 0, 0]
				: "axis" in rotation
					? [
							rotation.axis === "x" ? rotation.angle : 0,
							rotation.axis === "y" ? rotation.angle : 0,
							rotation.axis === "z" ? rotation.angle : 0,
						]
					: [rotation.x ?? 0, rotation.y ?? 0, rotation.z ?? 0];
		const faces: { key: string; value: JsonNode }[] = [];
		for (const face of CUBE_FACE_ORDER) {
			const value = element.faces[face];
			if (value === undefined) continue;
			const faceMembers: { key: string; value: JsonNode }[] = [];
			if (value.uv !== undefined) {
				faceMembers.push({
					key: "uv",
					value: arrayNode(scaleUv(value.uv, resolution).map(numberNode)),
				});
			}
			const textureIndex = indexByReference.get(value.texture);
			if (textureIndex === undefined) {
				structureError("face-texture-unresolved", {
					texture: value.texture,
				});
			}
			faceMembers.push({
				key: "texture",
				value: numberNode(textureIndex),
			});
			if (value.rotation !== undefined) {
				faceMembers.push({
					key: "rotation",
					value: numberNode(value.rotation),
				});
			}
			if (value.cullface !== undefined) {
				faceMembers.push({
					key: "cullface",
					value: stringNode(value.cullface),
				});
			}
			if (value.tintindex !== undefined) {
				faceMembers.push({
					key: "tint",
					value: numberNode(value.tintindex),
				});
			}
			faces.push({ key: face, value: objectNode(faceMembers) });
		}
		const members: { key: string; value: JsonNode }[] = [];
		if (element.name !== undefined) {
			members.push({ key: "name", value: stringNode(element.name) });
		}
		members.push({ key: "box_uv", value: booleanNode(false) });
		if (rotation?.rescale === true) {
			members.push({ key: "rescale", value: booleanNode(true) });
		}
		members.push(
			{ key: "from", value: arrayNode(element.from.map(numberNode)) },
			{ key: "to", value: arrayNode(element.to.map(numberNode)) },
			{ key: "autouv", value: numberNode(element.autouv) },
			{
				key: "origin",
				value: arrayNode(
					(rotation === undefined ? [0, 0, 0] : rotation.origin).map(
						numberNode,
					),
				),
			},
			{ key: "rotation", value: arrayNode(angles.map(numberNode)) },
			{ key: "faces", value: objectNode(faces) },
			{ key: "type", value: stringNode("cube") },
			{ key: "uuid", value: stringNode(uuidFor(`element:${index}`)) },
		);
		return objectNode(members);
	});
}

function buildDisplay(root: JsonNode): JsonNode | undefined {
	const display = asObject(member(root, "display"));
	if (display === undefined) {
		if (member(root, "display") !== undefined) {
			throw new McAssetError(
				"MODEL_INVALID_DISPLAY",
				"Display must be an object.",
				{ pointer: "/display" },
			);
		}
		return undefined;
	}
	const members: { key: string; value: JsonNode }[] = [];
	for (const position of DISPLAY_POSITIONS) {
		const value = display.members.find(
			(entry) => entry.key === position,
		)?.value;
		if (value === undefined) continue;
		const transform = asObject(value);
		if (transform === undefined) {
			throw new McAssetError(
				"MODEL_INVALID_DISPLAY",
				"Display position must be an object.",
				{ pointer: jsonPointer(["display", position]) },
			);
		}
		const transformMembers: { key: string; value: JsonNode }[] = [];
		for (const key of ["rotation", "translation", "scale"] as const) {
			const field = member(transform, key);
			if (field === undefined) continue;
			const values = tupleOf(field, 3, jsonPointer(["display", position, key]));
			if (values === undefined) continue;
			transformMembers.push({
				key,
				value: arrayNode(values.map(numberNode)),
			});
		}
		if (transformMembers.length === 0) continue;
		members.push({ key: position, value: objectNode(transformMembers) });
	}
	return members.length === 0 ? undefined : objectNode(members);
}

export function exportBbmodel(
	modelText: string,
	textureBytes: ReadonlyMap<string, Uint8Array>,
): BbmodelExportResult {
	const root = parseJsonDocument(modelText);
	const variables = readTextureVariables(root);
	const variableMap = new Map(
		variables.map((variable) => [variable.key, variable]),
	);
	const variableKeys = new Set(variableMap.keys());
	const { elements, warnsPartialUv } = readElements(root, variableKeys);
	const resolution = readResolution(root);

	const reachable = new Set<string>();
	const directSprites: string[] = [];
	const seenSprites = new Set<string>();
	for (const element of elements) {
		for (const face of Object.values(element.faces)) {
			if (face.texture.startsWith("#")) {
				addReachableTexture(face.texture.slice(1), variableMap, reachable);
			} else if (!seenSprites.has(face.texture)) {
				seenSprites.add(face.texture);
				directSprites.push(face.texture);
			}
		}
	}
	// A model without elements only carries texture variables (Blockbench's
	// isTexturesOnlyModel); keep every declared variable reachable.
	if (elements.length === 0) {
		for (const variable of variables) {
			addReachableTexture(variable.key, variableMap, reachable);
		}
	}
	if (variableKeys.has("particle")) {
		addReachableTexture("particle", variableMap, reachable);
	}

	const warnings: BbmodelWarning[] = [];
	if (warnsPartialUv) {
		warnings.push({
			code: "BBMODEL_UV_PARTIAL",
			message:
				"Some faces have no uv; .bbmodel keeps them without uv and Blockbench may re-derive them.",
		});
	}
	const textureSlots = collectTextureSlots(variables, reachable, directSprites);
	const builtTextures = buildTextures(textureSlots, textureBytes, resolution);
	const builtElements = buildElements(
		elements,
		textureSlots.indexByReference,
		resolution,
	);
	const parent = asString(member(root, "parent"));
	const ambientocclusion = asBoolean(member(root, "ambientocclusion"));
	const guiLight = asString(member(root, "gui_light"));
	const display = buildDisplay(root);

	const outliner = builtElements.map((element) => {
		const uuid = asString(member(element, "uuid"));
		return stringNode(uuid ?? "");
	});

	const rootMembers: { key: string; value: JsonNode }[] = [
		{
			key: "meta",
			value: objectNode([
				{ key: "format_version", value: stringNode("5.0") },
				{ key: "model_format", value: stringNode("java_block") },
				{ key: "box_uv", value: booleanNode(false) },
			]),
		},
		{ key: "name", value: stringNode("model") },
	];
	if (parent !== undefined && parent !== "") {
		rootMembers.push({ key: "parent", value: stringNode(parent) });
	}
	if (ambientocclusion === false) {
		rootMembers.push({ key: "ambientocclusion", value: booleanNode(false) });
	}
	if (guiLight === "front") {
		rootMembers.push({ key: "front_gui_light", value: booleanNode(true) });
	}
	rootMembers.push(
		{ key: "java_block_version", value: stringNode("26.3") },
		{
			key: "resolution",
			value: objectNode([
				{ key: "width", value: numberNode(resolution.width) },
				{ key: "height", value: numberNode(resolution.height) },
			]),
		},
		{ key: "elements", value: arrayNode(builtElements) },
		{ key: "outliner", value: arrayNode(outliner) },
		{ key: "textures", value: arrayNode(builtTextures) },
	);
	if (display !== undefined) {
		rootMembers.push({ key: "display", value: display });
	}
	const text = serializeJsonDocument(objectNode(rootMembers));
	checkFileBytes(text, "The .bbmodel output");

	return {
		text,
		formatVersion: "5.0",
		elementCount: elements.length,
		textureCount: builtTextures.length,
		warnings,
	};
}
