/**
 * Import a Blockbench Java Block/Item project (.bbmodel) as a Java model JSON
 * plus the embedded PNG textures.
 *
 * Field sources (JannisX11/blockbench, master ec0b2827104d0799c153bfb5f867579c0c44652f):
 * - js/formats/bbmodel.js: meta, resolution, elements, textures, display.
 * - js/formats/java/java_block.ts: Java export rules (UV scale, rotation axis,
 *   texture links, shade, light_emission, display).
 * - js/outliner/types/cube.js and js/outliner/abstract/face.ts: cube and face
 *   save fields, including box UV and per-face texture indices.
 * - js/texturing/textures.js: texture id/name/folder/namespace and data URLs.
 */

import { Buffer } from "node:buffer";
import { McAssetError } from "../../core/errors.ts";
import { decodePng } from "../../io/png.ts";
import { validateResourceLocation } from "../../validate/resource-location.ts";
import { formatNumber } from "../edit-support.ts";
import {
	type JsonMember,
	type JsonNode,
	serializeJsonDocument,
} from "../json-document.ts";
import { MODEL_LIMITS } from "../limits.ts";
import { textureResourcePath } from "../references.ts";
import {
	DIRECTIONS,
	type Direction,
	type DisplayPosition,
	type DisplayTransformSpec,
	type ElementRotationSpec,
	type ElementSpec,
	type FaceRotation,
	type FaceSpec,
	type ModelSpec,
	type TextureEntry,
	type Vec3,
} from "../types.ts";
import { type ModelRules, resolveModelRules } from "../versions.ts";
import {
	arrayField,
	booleanField,
	checkFileBytes,
	checkStringBytes,
	invalidDocument,
	isObject,
	numberField,
	numberTuple,
	objectField,
	parseBbmodelDocument,
	stringField,
	unsupportedFormat,
} from "./document.ts";
import type {
	BbmodelImportResult,
	BbmodelTexture,
	BbmodelWarning,
	ImportOptions,
} from "./types.ts";

type JsonObject = Extract<JsonNode, { type: "object" }>;

/** Blockbench saves cubes with these six directions. */
const CUBE_FACES = ["north", "east", "south", "west", "up", "down"] as const;

/** Face order in the Java model follows the model module's direction order. */
const JAVA_FACE_ORDER: readonly Direction[] = DIRECTIONS;

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
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Blockbench's `Project.java_block_version` menu values and the resource-pack
 * formats they target. "1.9.0" spans 1.9 through 1.21.5, so its oldest format
 * (12.0) decides which model features the project may use.
 */
const JAVA_BLOCK_VERSION_PACK_FORMAT: Readonly<Record<string, string>> = {
	"1.9.0": "12.0",
	"1.21.6": "63.0",
	"1.21.11": "75.0",
	"26.3": "97.1",
};

function compareVersionText(left: string, right: string): number {
	const a = left.split(".").map((part) => Number(part));
	const b = right.split(".").map((part) => Number(part));
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

function formatVersionOf(meta: Record<string, unknown>): string {
	const version = stringField(meta, "format_version", "meta");
	if (version === undefined) return "3.0";
	if (!/^[0-9]+(?:\.[0-9]+)*$/.test(version)) {
		invalidDocument("meta.format_version is not a version number");
	}
	if (compareVersionText(version, "5.0") > 0) {
		throw new McAssetError(
			"BBMODEL_UNSUPPORTED_VERSION",
			`.bbmodel format_version ${version} is newer than the supported 5.0.`,
			{ reason: "format-version", formatVersion: version, supported: "5.0" },
		);
	}
	return version;
}

function resolutionOf(
	root: Record<string, unknown>,
): Readonly<{ width: number; height: number }> {
	const resolution = objectField(root, "resolution", "root");
	if (resolution === undefined) return { width: 16, height: 16 };
	const width = numberField(resolution, "width", "resolution") ?? 16;
	const height = numberField(resolution, "height", "resolution") ?? 16;
	for (const value of [width, height]) {
		if (!Number.isInteger(value) || value < 1 || value > 4096) {
			invalidDocument("resolution must be integers from 1 to 4096");
		}
	}
	return { width, height };
}

function packFormatFor(
	root: Record<string, unknown>,
	options: ImportOptions,
): string | undefined {
	if (options.packFormat !== undefined) return options.packFormat;
	const version = stringField(root, "java_block_version", "root");
	if (version === undefined) return undefined;
	return JAVA_BLOCK_VERSION_PACK_FORMAT[version];
}

function hasTexturePathEscape(sprite: string): boolean {
	const path = sprite.includes(":")
		? sprite.slice(sprite.indexOf(":") + 1)
		: sprite;
	return path
		.split("/")
		.some((segment) => segment === "" || segment === "." || segment === "..");
}

function assertTextureSprite(sprite: string, key: string): void {
	const invalid = validateResourceLocation(sprite).some(
		(finding) => finding.level === "error",
	);
	if (hasTexturePathEscape(sprite) || invalid) {
		invalidDocument("texture link is not a valid resource location", {
			reason: "texture-link",
			key,
			sprite,
		});
	}
}

interface ReadTextures {
	readonly textures: readonly BbmodelTexture[];
	readonly entries: readonly { key: string; entry: TextureEntry }[];
}

function readTextureBytes(
	source: string,
	key: string,
): Readonly<{ png: Uint8Array; width: number; height: number }> {
	if (!source.startsWith(PNG_DATA_URL)) {
		throw new McAssetError(
			"BBMODEL_INVALID_TEXTURE",
			`Texture ${key} is not an embedded PNG data URL.`,
			{ reason: "not-png-data-url", key },
		);
	}
	const payload = source.slice(PNG_DATA_URL.length);
	if (
		payload.length === 0 ||
		payload.length % 4 !== 0 ||
		!BASE64.test(payload)
	) {
		throw new McAssetError(
			"BBMODEL_INVALID_TEXTURE",
			`Texture ${key} has invalid base64 data.`,
			{ reason: "base64", key },
		);
	}
	const png = new Uint8Array(Buffer.from(payload, "base64"));
	try {
		const decoded = decodePng(png);
		return {
			png,
			width: decoded.canvas.width,
			height: decoded.canvas.height,
		};
	} catch (error) {
		throw new McAssetError(
			"BBMODEL_INVALID_TEXTURE",
			`Texture ${key} is not a decodable PNG.`,
			{
				reason: "png",
				key,
				cause: error instanceof McAssetError ? error.code : undefined,
			},
		);
	}
}

function deriveTextureKey(
	name: string | undefined,
	path: string | undefined,
	index: number,
): string {
	const leaf = (name ?? path ?? "").replace(/\\/g, "/");
	const base = leaf.slice(leaf.lastIndexOf("/") + 1);
	const withoutExtension = base.replace(/\.\w{2,8}$/, "");
	return withoutExtension === "" ? `texture${index}` : withoutExtension;
}

function readTextures(
	root: Record<string, unknown>,
	warnings: BbmodelWarning[],
): ReadTextures {
	const items = arrayField(root, "textures", "root") ?? [];
	if (items.length > MODEL_LIMITS.maxTextures) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			"The .bbmodel texture limit is exceeded.",
			{ limit: MODEL_LIMITS.maxTextures, actual: items.length },
		);
	}
	const keys = new Set<string>();
	const textures: BbmodelTexture[] = [];
	const entries: { key: string; entry: TextureEntry }[] = [];
	let particleLink: string | undefined;
	let particleKey: string | undefined;
	let particleTranslucent = false;

	for (const [index, item] of items.entries()) {
		if (!isObject(item)) invalidDocument(`textures[${index}] is not an object`);
		const context = `textures[${index}]`;
		const name = stringField(item, "name", context);
		const folder = stringField(item, "folder", context);
		const namespace = stringField(item, "namespace", context);
		const path = stringField(item, "path", context);
		const rawId = stringField(item, "id", context);
		const source = stringField(item, "source", context);
		const particle = booleanField(item, "particle", context) === true;
		const forceTranslucent =
			booleanField(item, "force_translucent", context) === true;

		let key =
			rawId !== undefined && rawId !== ""
				? rawId
				: deriveTextureKey(name, path, index);
		if (keys.has(key)) {
			let suffix = 2;
			while (keys.has(`${key}_${suffix}`)) suffix += 1;
			key = `${key}_${suffix}`;
		}
		keys.add(key);
		checkStringBytes(key, `Texture variable ${key}`);

		let sprite: string;
		let isAlias = false;
		if (name?.startsWith("#")) {
			sprite = name;
			isAlias = true;
			if (sprite.length === 1) {
				invalidDocument("texture alias has no target", { key });
			}
		} else {
			const rawNs =
				namespace !== undefined && namespace !== "" ? namespace : "minecraft";
			const rawFolder = folder ?? "";
			const rawName =
				name !== undefined && name !== ""
					? name
					: path !== undefined
						? path.replace(/\\/g, "/").slice(path.lastIndexOf("/") + 1)
						: "";
			if (rawName === "") {
				invalidDocument("texture has neither a name nor a path", {
					reason: "texture-name",
					key,
				});
			}
			const lowerNs = rawNs.toLowerCase();
			const rawFolderPath = rawFolder.replace(/^\/+|\/+$/g, "");
			const rawBaseName = rawName.replace(/\.\w{2,8}$/, "");
			const lowerFolder = rawFolderPath.toLowerCase();
			const lowerName = rawBaseName.toLowerCase();
			const lowerPath =
				lowerFolder === "" ? lowerName : `${lowerFolder}/${lowerName}`;
			const rawPath =
				rawFolderPath === "" ? rawBaseName : `${rawFolderPath}/${rawBaseName}`;
			const lowerSprite =
				lowerNs === "minecraft" ? lowerPath : `${lowerNs}:${lowerPath}`;
			const rawSprite = rawNs === "minecraft" ? rawPath : `${rawNs}:${rawPath}`;
			sprite = lowerSprite;
			if (lowerSprite !== rawSprite) {
				warnings.push({
					code: "BBMODEL_TEXTURE_LOWERCASED",
					message: `Texture ${key} link was lowercased from ${rawSprite} to ${sprite}.`,
				});
			}
			assertTextureSprite(sprite, key);
		}
		checkStringBytes(sprite, `Texture link for ${key}`);

		let png: Uint8Array | undefined;
		let width: number | undefined;
		let height: number | undefined;
		if (source !== undefined && source !== "") {
			const embedded = readTextureBytes(source, key);
			png = embedded.png;
			width = embedded.width;
			height = embedded.height;
		}

		const relativePath = isAlias ? undefined : textureResourcePath(sprite);
		textures.push({
			key,
			sprite,
			name: name ?? key,
			namespace:
				namespace !== undefined && namespace !== "" ? namespace : "minecraft",
			...(folder === undefined || folder === "" ? {} : { folder }),
			...(relativePath === undefined ? {} : { relativePath }),
			...(png === undefined ? {} : { png }),
			...(width === undefined ? {} : { width }),
			...(height === undefined ? {} : { height }),
			forceTranslucent,
			particle,
		});
		if (particle) {
			particleLink = sprite;
			particleKey = key;
			particleTranslucent = forceTranslucent;
		}
		entries.push({
			key,
			entry: forceTranslucent ? { sprite, forceTranslucent: true } : sprite,
		});
	}

	if (particleLink !== undefined && particleKey !== "particle") {
		if (keys.has("particle")) {
			invalidDocument("two textures claim the particle variable", {
				reason: "particle-conflict",
			});
		}
		keys.add("particle");
		entries.push({
			key: "particle",
			entry: particleTranslucent
				? { sprite: particleLink, forceTranslucent: true }
				: particleLink,
		});
	}

	return { textures, entries };
}

function floorSize(value: number): number {
	return Math.floor(value + 1e-7);
}

function vec3(values: readonly number[]): Vec3 {
	return [values[0] as number, values[1] as number, values[2] as number];
}

interface BoxFace {
	readonly face: Direction;
	from: [number, number];
	size: [number, number];
}

/**
 * The box UV layout Blockbench bakes into per-face UVs
 * (Cube.preview_controller.updateUV): east, west, up, down, south, north in
 * order, with mirrored UVs swapping the east and west rectangles.
 */
function boxFaceUvs(
	cube: Record<string, unknown>,
	from: readonly number[],
	to: readonly number[],
): Readonly<Partial<Record<Direction, readonly number[]>>> {
	const sx = floorSize((to[0] as number) - (from[0] as number));
	const sy = floorSize((to[1] as number) - (from[1] as number));
	const sz = floorSize((to[2] as number) - (from[2] as number));
	const offset = numberTuple(
		cube.uv_offset ?? [0, 0],
		2,
		"element.uv_offset",
	) as [number, number];
	const list: BoxFace[] = [
		{ face: "east", from: [0, sz], size: [sz, sy] },
		{ face: "west", from: [sz + sx, sz], size: [sz, sy] },
		{ face: "up", from: [sz + sx, sz], size: [-sx, -sz] },
		{ face: "down", from: [sz + sx * 2, 0], size: [-sx, sz] },
		{ face: "south", from: [sz * 2 + sx, sz], size: [sx, sy] },
		{ face: "north", from: [sz, sz], size: [sx, sy] },
	];
	if (cube.mirror_uv === true) {
		for (const box of list) {
			box.from[0] += box.size[0];
			box.size[0] *= -1;
		}
		const east = list[0] as BoxFace;
		const west = list[1] as BoxFace;
		[list[0], list[1]] = [west, east];
		[list[0].from, list[1].from] = [list[1].from, list[0].from];
		[list[0].size, list[1].size] = [list[1].size, list[0].size];
	}
	const uvs: Partial<Record<Direction, readonly number[]>> = {};
	for (const box of list) {
		uvs[box.face] = [
			box.from[0] + offset[0],
			box.from[1] + offset[1],
			box.from[0] + box.size[0] + offset[0],
			box.from[1] + box.size[1] + offset[1],
		];
	}
	return uvs;
}

/**
 * Blockbench's Java export scales UV by the UV editor's active texture size,
 * which a project file does not record; the project resolution is the only
 * recoverable default and matches projects whose textures share one UV size.
 */
function scaleUv(
	uv: readonly number[],
	resolution: Readonly<{ width: number; height: number }>,
): readonly [number, number, number, number] {
	if (resolution.width === 16 && resolution.height === 16) {
		return [uv[0] as number, uv[1] as number, uv[2] as number, uv[3] as number];
	}
	return [
		((uv[0] as number) * 16) / resolution.width,
		((uv[1] as number) * 16) / resolution.height,
		((uv[2] as number) * 16) / resolution.width,
		((uv[3] as number) * 16) / resolution.height,
	];
}

function readFaces(
	element: Record<string, unknown>,
	context: string,
	textures: readonly BbmodelTexture[],
	boxUvs: Readonly<Partial<Record<Direction, readonly number[]>>> | undefined,
	resolution: Readonly<{ width: number; height: number }>,
): Partial<Record<Direction, FaceSpec>> {
	const facesNode = objectField(element, "faces", context);
	const faces: Partial<Record<Direction, FaceSpec>> = {};
	if (facesNode === undefined) return faces;
	for (const key of Object.keys(facesNode)) {
		if (!(CUBE_FACES as readonly string[]).includes(key)) {
			invalidDocument(`unknown cube face ${JSON.stringify(key)}`, {
				reason: "unknown-face",
				face: key,
			});
		}
	}
	for (const faceName of CUBE_FACES) {
		const raw = facesNode[faceName];
		if (raw === undefined) continue;
		if (!isObject(raw))
			invalidDocument(`${context}.faces.${faceName} is not an object`);
		const faceContext = `${context}.faces.${faceName}`;
		const textureIndex = raw.texture;
		if (textureIndex === null) continue;
		let texture: string;
		if (typeof textureIndex === "number") {
			if (
				!Number.isInteger(textureIndex) ||
				textureIndex < 0 ||
				textureIndex >= textures.length
			) {
				invalidDocument("face texture index is out of range", {
					reason: "texture-index",
					context: faceContext,
					index: textureIndex,
				});
			}
			texture = `#${(textures[textureIndex] as BbmodelTexture).key}`;
		} else if (textureIndex === undefined || textureIndex === false) {
			texture = "#missing";
		} else {
			invalidDocument("face texture must be an index or null", {
				reason: "face-texture",
				context: faceContext,
			});
		}

		let uv: readonly [number, number, number, number] | undefined;
		if (raw.enabled !== false) {
			const sourceUv = boxUvs?.[faceName as Direction];
			if (sourceUv !== undefined) {
				uv = scaleUv(sourceUv, resolution);
			} else if (raw.uv !== undefined) {
				uv = scaleUv(numberTuple(raw.uv, 4, `${faceContext}.uv`), resolution);
			}
		}

		const rotation = numberField(raw, "rotation", faceContext);
		if (rotation !== undefined && ![0, 90, 180, 270].includes(rotation)) {
			invalidDocument(`${faceContext}.rotation must be 0, 90, 180, or 270`, {
				reason: "face-rotation",
			});
		}
		const tint = numberField(raw, "tint", faceContext);
		if (tint !== undefined && (!Number.isInteger(tint) || tint < -1)) {
			invalidDocument(`${faceContext}.tint must be an integer`, {
				reason: "face-tint",
			});
		}
		const cullface = stringField(raw, "cullface", faceContext);
		if (
			cullface !== undefined &&
			cullface !== "" &&
			!(DIRECTIONS as readonly string[]).includes(cullface)
		) {
			invalidDocument(`${faceContext}.cullface is not a direction`, {
				reason: "face-cullface",
			});
		}
		faces[faceName as Direction] = {
			texture,
			...(uv === undefined ? {} : { uv }),
			...(rotation === undefined || rotation === 0
				? {}
				: { rotation: rotation as FaceRotation }),
			...(tint === undefined || tint < 0 ? {} : { tintindex: tint }),
			...(cullface === undefined || cullface === ""
				? {}
				: { cullface: cullface as Direction }),
		};
	}
	return faces;
}

function readRotation(
	element: Record<string, unknown>,
	context: string,
	rules: ModelRules,
	warnings: BbmodelWarning[],
): ElementRotationSpec | undefined {
	const raw = element.rotation;
	const rescale = booleanField(element, "rescale", context) === true;
	const originValues =
		element.origin === undefined
			? ([0, 0, 0] as const)
			: vec3(numberTuple(element.origin, 3, `${context}.origin`));
	if (raw === undefined) {
		if (!rescale) return undefined;
		return { origin: originValues, axis: "y", angle: 0, rescale: true };
	}
	const angles = numberTuple(raw, 3, `${context}.rotation`);
	const nonZero = angles.filter((angle) => angle !== 0);
	const origin = originValues;
	if (nonZero.length === 0) {
		if (!rescale) return undefined;
		return { origin, axis: "y", angle: 0, rescale: true };
	}
	if (nonZero.length === 1) {
		const axisIndex = angles.findIndex((angle) => angle !== 0);
		const axis = (["x", "y", "z"] as const)[axisIndex] as "x" | "y" | "z";
		return {
			origin,
			axis,
			angle: angles[axisIndex] as number,
			...(rescale ? { rescale: true } : {}),
		};
	}
	const supportsXyz = rules.has("rotationXyz");
	if (supportsXyz === false) {
		throw new McAssetError(
			"MODEL_UNSUPPORTED_VERSION",
			"Rotation on more than one axis needs the xyz rotation feature.",
			{
				feature: "rotationXyz",
				since: "75.0",
				packFormat: rules.packFormat,
			},
		);
	}
	if (supportsXyz === undefined) {
		warnings.push({
			code: "BBMODEL_ROTATION_VERSION",
			message: "xyz rotation needs a known target version to verify.",
		});
	}
	return {
		origin,
		x: angles[0] as number,
		y: angles[1] as number,
		z: angles[2] as number,
		...(rescale ? { rescale: true } : {}),
	};
}

function readElements(
	root: Record<string, unknown>,
	textures: readonly BbmodelTexture[],
	resolution: Readonly<{ width: number; height: number }>,
	rules: ModelRules,
	warnings: BbmodelWarning[],
): ElementSpec[] {
	const items = arrayField(root, "elements", "root") ?? [];
	if (items.length > MODEL_LIMITS.maxElements) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			"The .bbmodel element limit is exceeded.",
			{ limit: MODEL_LIMITS.maxElements, actual: items.length },
		);
	}
	const projectBoxUv = isObject(root.meta) && root.meta.box_uv === true;
	const elements: ElementSpec[] = [];
	for (const [index, item] of items.entries()) {
		if (!isObject(item)) invalidDocument(`elements[${index}] is not an object`);
		const context = `elements[${index}]`;
		// Editor-only elements (for example generated item placeholders) are not part of the exported model.
		if (item.export === false) continue;
		const type = stringField(item, "type", context);
		if (type !== undefined && type !== "cube") {
			invalidDocument("only cube elements are representable", {
				reason: "unsupported-element-type",
				type,
			});
		}
		const stretch = arrayField(item, "stretch", context);
		if (
			stretch !== undefined &&
			(stretch.length !== 3 ||
				stretch.some((value) => typeof value !== "number" || value !== 1))
		) {
			invalidDocument("stretched cubes are not representable", {
				reason: "unsupported-stretch",
			});
		}

		const rawFrom = vec3(numberTuple(item.from, 3, `${context}.from`));
		const rawTo = vec3(numberTuple(item.to, 3, `${context}.to`));
		const inflate = numberField(item, "inflate", context) ?? 0;
		const from = vec3(
			rawFrom.map((value) => (inflate === 0 ? value : value - inflate)),
		);
		const to = vec3(
			rawTo.map((value) => (inflate === 0 ? value : value + inflate)),
		);

		const boxUv =
			item.box_uv === true || (item.box_uv === undefined && projectBoxUv);
		const boxUvs = boxUv ? boxFaceUvs(item, rawFrom, rawTo) : undefined;
		const faces = readFaces(item, context, textures, boxUvs, resolution);
		const rotation = readRotation(item, context, rules, warnings);
		const name = stringField(item, "name", context);
		const lightEmission = numberField(item, "light_emission", context);
		if (
			lightEmission !== undefined &&
			(!Number.isInteger(lightEmission) ||
				lightEmission < 0 ||
				lightEmission > 15)
		) {
			invalidDocument(
				`${context}.light_emission must be an integer from 0 to 15`,
				{
					reason: "light-emission",
				},
			);
		}
		let shade: boolean | undefined;
		let shadeDirectionOverride: Direction | undefined;
		const shadeFlag = item.shade;
		const shadeOverride = stringField(
			item,
			"shade_direction_override",
			context,
		);
		if (shadeOverride !== undefined && shadeOverride !== "") {
			if (!(DIRECTIONS as readonly string[]).includes(shadeOverride)) {
				invalidDocument(
					`${context}.shade_direction_override is not a direction`,
					{
						reason: "shade-direction",
					},
				);
			}
			if (rules.shadeField === "shade") {
				if (shadeFlag !== false) {
					shade = false;
					warnings.push({
						code: "BBMODEL_SHADE_CONVERTED",
						message: `Element ${index} shade direction was converted to shade=false for the older target version.`,
					});
				}
			} else {
				shadeDirectionOverride = shadeOverride as Direction;
			}
		} else if (shadeFlag === false) {
			if (rules.shadeField === "shade_direction_override") {
				shadeDirectionOverride = "up";
			} else {
				shade = false;
			}
		}
		if (
			lightEmission !== undefined &&
			lightEmission > 0 &&
			rules.has("lightEmission") === false
		) {
			warnings.push({
				code: "BBMODEL_LIGHT_EMISSION_VERSION",
				message: `Element ${index} light_emission is newer than the target version.`,
			});
		}

		elements.push({
			...(name === undefined || name === "" ? {} : { name }),
			from,
			to,
			...(rotation === undefined ? {} : { rotation }),
			...(shade === undefined ? {} : { shade }),
			...(shadeDirectionOverride === undefined
				? {}
				: { shadeDirectionOverride }),
			...(lightEmission === undefined || lightEmission === 0
				? {}
				: { lightEmission }),
			faces,
		});
	}
	return elements;
}

function readDisplay(
	root: Record<string, unknown>,
): Partial<Record<DisplayPosition, DisplayTransformSpec>> | undefined {
	const raw = objectField(root, "display", "root");
	if (raw === undefined) return undefined;
	const display: Partial<Record<DisplayPosition, DisplayTransformSpec>> = {};
	for (const position of DISPLAY_POSITIONS) {
		const value = raw[position];
		if (value === undefined) continue;
		if (!isObject(value)) {
			invalidDocument(`display.${position} is not an object`, {
				reason: "display",
			});
		}
		const transform: {
			rotation?: Vec3;
			translation?: Vec3;
			scale?: Vec3;
		} = {};
		for (const key of ["rotation", "translation", "scale"] as const) {
			const field = value[key];
			if (field === undefined) continue;
			transform[key] = vec3(
				numberTuple(field, 3, `display.${position}.${key}`),
			);
		}
		if (Object.keys(transform).length === 0) continue;
		display[position] = transform;
	}
	return Object.keys(display).length === 0 ? undefined : display;
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

function finiteArray(values: readonly number[]): JsonNode {
	return { type: "array", items: values.map(numberNode) };
}

function objectNode(members: readonly JsonMember[]): JsonObject {
	return { type: "object", members };
}

function textureEntryNode(entry: TextureEntry): JsonNode {
	if (typeof entry === "string") return stringNode(entry);
	const members: JsonMember[] = [
		{ key: "sprite", value: stringNode(entry.sprite) },
	];
	if (entry.forceTranslucent !== undefined) {
		members.push({
			key: "force_translucent",
			value: booleanNode(entry.forceTranslucent),
		});
	}
	return objectNode(members);
}

function elementNode(element: ElementSpec): JsonObject {
	const members: JsonMember[] = [];
	if (element.name !== undefined) {
		members.push({ key: "name", value: stringNode(element.name) });
	}
	members.push({ key: "from", value: finiteArray(element.from) });
	members.push({ key: "to", value: finiteArray(element.to) });
	if (element.rotation !== undefined) {
		const rotation = element.rotation;
		const rotationMembers: JsonMember[] = [
			{ key: "origin", value: finiteArray(rotation.origin) },
		];
		if ("axis" in rotation) {
			rotationMembers.push(
				{ key: "axis", value: stringNode(rotation.axis) },
				{ key: "angle", value: numberNode(rotation.angle) },
			);
		} else {
			if (rotation.x !== undefined)
				rotationMembers.push({ key: "x", value: numberNode(rotation.x) });
			if (rotation.y !== undefined)
				rotationMembers.push({ key: "y", value: numberNode(rotation.y) });
			if (rotation.z !== undefined)
				rotationMembers.push({ key: "z", value: numberNode(rotation.z) });
		}
		if (rotation.rescale !== undefined) {
			rotationMembers.push({
				key: "rescale",
				value: booleanNode(rotation.rescale),
			});
		}
		members.push({ key: "rotation", value: objectNode(rotationMembers) });
	}
	if (element.shade !== undefined) {
		members.push({ key: "shade", value: booleanNode(element.shade) });
	}
	if (element.shadeDirectionOverride !== undefined) {
		members.push({
			key: "shade_direction_override",
			value: stringNode(element.shadeDirectionOverride),
		});
	}
	if (element.lightEmission !== undefined) {
		members.push({
			key: "light_emission",
			value: numberNode(element.lightEmission),
		});
	}
	const faces: JsonMember[] = [];
	for (const direction of JAVA_FACE_ORDER) {
		const face = element.faces[direction];
		if (face === undefined) continue;
		const faceMembers: JsonMember[] = [
			{ key: "texture", value: stringNode(face.texture) },
		];
		if (face.uv !== undefined) {
			faceMembers.push({ key: "uv", value: finiteArray(face.uv) });
		}
		if (face.rotation !== undefined) {
			faceMembers.push({ key: "rotation", value: numberNode(face.rotation) });
		}
		if (face.cullface !== undefined) {
			faceMembers.push({
				key: "cullface",
				value: stringNode(face.cullface),
			});
		}
		if (face.tintindex !== undefined) {
			faceMembers.push({
				key: "tintindex",
				value: numberNode(face.tintindex),
			});
		}
		faces.push({ key: direction, value: objectNode(faceMembers) });
	}
	members.push({ key: "faces", value: objectNode(faces) });
	return objectNode(members);
}

function modelNode(
	spec: ModelSpec,
	resolution: Readonly<{ width: number; height: number }>,
): JsonObject {
	const members: JsonMember[] = [];
	if (spec.parent !== undefined) {
		members.push({ key: "parent", value: stringNode(spec.parent) });
	}
	if (spec.ambientocclusion !== undefined) {
		members.push({
			key: "ambientocclusion",
			value: booleanNode(spec.ambientocclusion),
		});
	}
	if (spec.guiLight !== undefined) {
		members.push({ key: "gui_light", value: stringNode(spec.guiLight) });
	}
	if (resolution.width !== 16 || resolution.height !== 16) {
		members.push({
			key: "texture_size",
			value: finiteArray([resolution.width, resolution.height]),
		});
	}
	if (spec.textures !== undefined) {
		members.push({
			key: "textures",
			value: objectNode(
				Object.keys(spec.textures).map((key) => ({
					key,
					value: textureEntryNode(spec.textures?.[key] as TextureEntry),
				})),
			),
		});
	}
	if (spec.elements !== undefined) {
		members.push({
			key: "elements",
			value: {
				type: "array",
				items: spec.elements.map(elementNode),
			},
		});
	}
	if (spec.display !== undefined) {
		const displayMembers: JsonMember[] = [];
		for (const position of DISPLAY_POSITIONS) {
			const transform = spec.display[position];
			if (transform === undefined) continue;
			const transformMembers: JsonMember[] = [];
			if (transform.rotation !== undefined) {
				transformMembers.push({
					key: "rotation",
					value: finiteArray(transform.rotation),
				});
			}
			if (transform.translation !== undefined) {
				transformMembers.push({
					key: "translation",
					value: finiteArray(transform.translation),
				});
			}
			if (transform.scale !== undefined) {
				transformMembers.push({
					key: "scale",
					value: finiteArray(transform.scale),
				});
			}
			displayMembers.push({
				key: position,
				value: objectNode(transformMembers),
			});
		}
		members.push({ key: "display", value: objectNode(displayMembers) });
	}
	return objectNode(members);
}

function checkNodeLimits(node: JsonNode): void {
	if (node.type === "string") {
		checkStringBytes(node.value, "A model string");
		return;
	}
	if (node.type === "array") {
		for (const item of node.items) checkNodeLimits(item);
		return;
	}
	if (node.type === "object") {
		for (const member of node.members) {
			checkStringBytes(member.key, "A model key");
			checkNodeLimits(member.value);
		}
	}
}

export function importBbmodel(
	text: string,
	options: ImportOptions = {},
): BbmodelImportResult {
	const root = parseBbmodelDocument(text);
	const meta = objectField(root, "meta", "root");
	if (meta === undefined)
		unsupportedFormat(undefined, { reason: "missing-meta" });
	const formatVersion = formatVersionOf(meta);
	const modelFormat = meta.model_format;
	if (modelFormat === undefined) {
		if (meta.bone_rig === true)
			unsupportedFormat(undefined, { reason: "bone-rig" });
	} else if (modelFormat !== "java_block") {
		unsupportedFormat(modelFormat);
	}
	const resolution = resolutionOf(root);
	const packFormat = packFormatFor(root, options);
	const rules = resolveModelRules(packFormat);
	const warnings: BbmodelWarning[] = [];
	const { textures, entries } = readTextures(root, warnings);
	const elements = readElements(root, textures, resolution, rules, warnings);
	const parent = stringField(root, "parent", "root");
	const ambientocclusion = booleanField(root, "ambientocclusion", "root");
	const frontGuiLight = booleanField(root, "front_gui_light", "root");
	const display = readDisplay(root);

	const textureRecord: Record<string, TextureEntry> = {};
	for (const { key, entry } of entries) textureRecord[key] = entry;
	for (const { entry } of entries) {
		if (typeof entry !== "string") {
			if (rules.has("texturesObjectForm") === false) {
				throw new McAssetError(
					"MODEL_UNSUPPORTED_VERSION",
					"A texture object form needs the texturesObjectForm feature.",
					{
						feature: "texturesObjectForm",
						since: "84.0",
						packFormat: rules.packFormat,
					},
				);
			}
		}
	}

	const spec: ModelSpec = {
		...(parent === undefined || parent === "" ? {} : { parent }),
		...(ambientocclusion === false ? { ambientocclusion: false } : {}),
		...(frontGuiLight === true ? { guiLight: "front" as const } : {}),
		...(Object.keys(textureRecord).length === 0
			? {}
			: { textures: textureRecord }),
		...(elements.length === 0 ? {} : { elements }),
		...(display === undefined ? {} : { display }),
	};
	const node = modelNode(spec, resolution);
	checkNodeLimits(node);
	const modelText = serializeJsonDocument(node);
	checkFileBytes(modelText, "The generated model JSON");

	return {
		modelText,
		spec,
		textures,
		formatVersion,
		resolution,
		...(packFormat === undefined ? {} : { packFormat }),
		warnings,
	};
}
