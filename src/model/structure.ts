import { McAssetError } from "../core/errors.ts";
import { type JsonNode, jsonPointer } from "./json-document.ts";
import { MODEL_LIMITS } from "./limits.ts";
import type { ModelRules } from "./versions.ts";

export type ModelStructureCode =
	| "MODEL_INVALID_STRUCTURE"
	| "MODEL_INVALID_UV"
	| "MODEL_INVALID_ROTATION"
	| "MODEL_INVALID_DISPLAY"
	| "MODEL_VERSION_FEATURE"
	| "MODEL_SUSPICIOUS_VALUE";

export type ModelReferenceCode =
	| "PACK_BROKEN_REFERENCE"
	| "PACK_MISSING_ASSET"
	| "PACK_MISSING_TEXTURE"
	| "PACK_REFERENCE_CYCLE"
	| "PACK_UNRESOLVED_EXTERNAL"
	| "PACK_CASE_MISMATCH"
	| "PACK_UNRESOLVED_VARIABLE";

export interface ModelFinding {
	readonly code: ModelStructureCode | ModelReferenceCode;
	readonly level: "error" | "warning";
	readonly message: string;
	readonly pointer: string;
}

export interface ModelCoverageSkip {
	readonly kind: string;
	readonly reason: string;
	readonly target: string;
	readonly detail?: string;
}

export interface ModelStructureResult {
	readonly findings: readonly ModelFinding[];
	readonly skipped: readonly ModelCoverageSkip[];
}

const directions = new Set(["down", "up", "north", "south", "west", "east"]);
const rootFields = new Set([
	"parent",
	"ambientocclusion",
	"gui_light",
	"textures",
	"elements",
	"display",
	"overrides",
	"texture_size",
]);
const elementFields = new Set([
	"name",
	"from",
	"to",
	"rotation",
	"shade",
	"shade_direction_override",
	"light_emission",
	"faces",
]);
const faceFields = new Set([
	"uv",
	"texture",
	"cullface",
	"rotation",
	"tintindex",
]);
const rotationFields = new Set([
	"origin",
	"axis",
	"angle",
	"x",
	"y",
	"z",
	"rescale",
]);
const displayFields = new Set(["rotation", "translation", "scale"]);
const textureObjectFields = new Set(["sprite", "force_translucent"]);
const codeOrder = [
	"MODEL_INVALID_STRUCTURE",
	"MODEL_INVALID_UV",
	"MODEL_INVALID_ROTATION",
	"MODEL_INVALID_DISPLAY",
	"MODEL_VERSION_FEATURE",
	"MODEL_SUSPICIOUS_VALUE",
	"PACK_BROKEN_REFERENCE",
	"PACK_MISSING_ASSET",
	"PACK_MISSING_TEXTURE",
	"PACK_REFERENCE_CYCLE",
	"PACK_UNRESOLVED_EXTERNAL",
	"PACK_CASE_MISMATCH",
] as const;
const encoder = new TextEncoder();

function compareBytes(left: string, right: string): number {
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
		const difference = (a[index] as number) - (b[index] as number);
		if (difference !== 0) return difference;
	}
	return a.length - b.length;
}

function member(node: JsonNode, key: string): JsonNode | undefined {
	return node.type === "object"
		? node.members.find((entry) => entry.key === key)?.value
		: undefined;
}
function numberValue(node: JsonNode | undefined): number | undefined {
	return node?.type === "number" ? node.value : undefined;
}
function stringValue(node: JsonNode | undefined): string | undefined {
	return node?.type === "string" ? node.value : undefined;
}
function isObject(
	node: JsonNode | undefined,
): node is Extract<JsonNode, { type: "object" }> {
	return node?.type === "object";
}
function vector(
	node: JsonNode | undefined,
	length: number,
): number[] | undefined {
	if (node?.type !== "array" || node.items.length !== length) return undefined;
	const values = node.items.map(numberValue);
	if (values.some((value) => value === undefined || !Number.isFinite(value)))
		return undefined;
	return values as number[];
}
function skipTarget(rel: string, pointer: string): string {
	return `${rel}#${pointer}`;
}

export function validateModelStructure(
	root: JsonNode,
	rules: ModelRules,
	rel: string,
): ModelStructureResult {
	if (!isObject(root)) return { findings: [], skipped: [] };
	const findings: ModelFinding[] = [];
	const skipped: ModelCoverageSkip[] = [];
	const knownVersion = rules.status !== "undetermined";
	const report = (
		code: ModelStructureCode,
		level: "error" | "warning",
		pointer: readonly (string | number)[],
		message: string,
	): void => {
		findings.push({ code, level, pointer: jsonPointer(pointer), message });
	};
	const featureSkip = (feature: string): void => {
		if (!knownVersion)
			skipped.push({
				kind: "model-version-rules",
				target: skipTarget(rel, ""),
				reason: "feature-version-unknown",
				detail: feature,
			});
	};
	const unknown = (
		object: Extract<JsonNode, { type: "object" }>,
		allowed: ReadonlySet<string>,
		base: readonly (string | number)[],
	): void => {
		for (const entry of object.members) {
			if (!allowed.has(entry.key)) {
				const pointer = jsonPointer([...base, entry.key]);
				skipped.push({
					kind: "model-unknown-field",
					target: skipTarget(rel, pointer),
					reason: "field-not-interpreted",
				});
			}
		}
	};

	if (rules.status !== "verified")
		skipped.push({
			kind: "model-version-rules",
			target: skipTarget(rel, ""),
			reason:
				rules.status === "inferred"
					? "rules-inferred"
					: "version-not-determined",
		});
	unknown(root, rootFields, []);

	const ambient = member(root, "ambientocclusion");
	if (ambient !== undefined && ambient.type !== "boolean")
		report(
			"MODEL_INVALID_STRUCTURE",
			"error",
			["ambientocclusion"],
			"ambientocclusion must be a boolean.",
		);
	const guiLight = member(root, "gui_light");
	if (
		guiLight !== undefined &&
		!["front", "side"].includes(stringValue(guiLight) ?? "")
	)
		report(
			"MODEL_INVALID_STRUCTURE",
			"error",
			["gui_light"],
			'gui_light must be "front" or "side".',
		);

	const textures = member(root, "textures");
	if (isObject(textures)) {
		if (textures.members.length > MODEL_LIMITS.maxTextures)
			throw new McAssetError(
				"RESOURCE_LIMIT_EXCEEDED",
				"Model texture variable limit exceeded.",
				{ limit: MODEL_LIMITS.maxTextures, actual: textures.members.length },
			);
		for (const entry of textures.members) {
			const base = ["textures", entry.key] as const;
			if (entry.value.type === "object") {
				const allowed = rules.has("texturesObjectForm");
				if (allowed === false)
					report(
						"MODEL_VERSION_FEATURE",
						"error",
						base,
						"Texture object form requires texturesObjectForm.",
					);
				if (allowed === undefined) featureSkip("texturesObjectForm");
				unknown(entry.value, textureObjectFields, base);
				const sprite = stringValue(member(entry.value, "sprite"));
				if (sprite === undefined)
					report(
						"MODEL_INVALID_STRUCTURE",
						"error",
						[...base, "sprite"],
						"Texture sprite must be a resource location string.",
					);
				else if (sprite.startsWith("#"))
					report(
						"MODEL_INVALID_STRUCTURE",
						"error",
						[...base, "sprite"],
						"Texture sprite cannot reference another variable.",
					);
				const translucent = member(entry.value, "force_translucent");
				if (translucent !== undefined && translucent.type !== "boolean")
					report(
						"MODEL_INVALID_STRUCTURE",
						"error",
						[...base, "force_translucent"],
						"force_translucent must be a boolean.",
					);
			} else if (
				entry.value.type !== "string" &&
				rules.has("texturesObjectForm") === true
			) {
				report(
					"MODEL_INVALID_STRUCTURE",
					"error",
					base,
					"Texture entry must be a string or texture object.",
				);
			}
		}
	}

	const overrides = member(root, "overrides");
	if (overrides !== undefined) {
		if (rules.has("itemDefinitions") === true)
			report(
				"MODEL_VERSION_FEATURE",
				"warning",
				["overrides"],
				"overrides is ignored when item definitions are available.",
			);
		else if (rules.has("itemDefinitions") === false)
			skipped.push({
				kind: "model-overrides",
				target: skipTarget(rel, "/overrides"),
				reason: "predicates-not-interpreted",
			});
		else featureSkip("itemDefinitions");
	}

	const display = member(root, "display");
	if (display !== undefined && !isObject(display))
		report(
			"MODEL_INVALID_DISPLAY",
			"error",
			["display"],
			"display must be an object.",
		);
	if (isObject(display)) {
		for (const position of display.members) {
			const base = ["display", position.key] as const;
			if (
				![
					"thirdperson_righthand",
					"thirdperson_lefthand",
					"firstperson_righthand",
					"firstperson_lefthand",
					"gui",
					"head",
					"ground",
					"fixed",
					"on_shelf",
				].includes(position.key)
			)
				report(
					"MODEL_SUSPICIOUS_VALUE",
					"warning",
					base,
					"Unknown display position.",
				);
			if (position.key === "on_shelf") {
				if (rules.has("displayOnShelf") === false)
					report(
						"MODEL_VERSION_FEATURE",
						"warning",
						base,
						"on_shelf requires displayOnShelf.",
					);
				else if (rules.has("displayOnShelf") === undefined)
					featureSkip("displayOnShelf");
			}
			if (!isObject(position.value)) {
				report(
					"MODEL_INVALID_DISPLAY",
					"error",
					base,
					"Display position must be an object.",
				);
				continue;
			}
			unknown(position.value, displayFields, base);
			for (const key of ["rotation", "translation", "scale"] as const) {
				const value = member(position.value, key);
				if (value === undefined) continue;
				const values = vector(value, 3);
				const pointer = [...base, key] as const;
				if (values === undefined) {
					report(
						"MODEL_INVALID_DISPLAY",
						"error",
						pointer,
						`${key} must be three finite numbers.`,
					);
					continue;
				}
				if (
					key === "translation" &&
					values.some((component) => Math.abs(component) > 80)
				)
					report(
						"MODEL_SUSPICIOUS_VALUE",
						"warning",
						pointer,
						"translation exceeds the game clamp range.",
					);
				if (key === "scale" && values.some((component) => component > 4))
					report(
						"MODEL_SUSPICIOUS_VALUE",
						"warning",
						pointer,
						"scale exceeds the game clamp range.",
					);
			}
		}
	}

	const elements = member(root, "elements");
	if (elements !== undefined && elements.type !== "array")
		report(
			"MODEL_INVALID_STRUCTURE",
			"error",
			["elements"],
			"elements must be an array.",
		);
	if (elements?.type === "array") {
		if (elements.items.length > MODEL_LIMITS.maxElements)
			throw new McAssetError(
				"RESOURCE_LIMIT_EXCEEDED",
				"Model element limit exceeded.",
				{ limit: MODEL_LIMITS.maxElements, actual: elements.items.length },
			);
		for (const [index, element] of elements.items.entries()) {
			const base = ["elements", index] as const;
			if (!isObject(element)) {
				report(
					"MODEL_INVALID_STRUCTURE",
					"error",
					base,
					"Element must be an object.",
				);
				continue;
			}
			unknown(element, elementFields, base);
			const from = vector(member(element, "from"), 3);
			const to = vector(member(element, "to"), 3);
			if (from === undefined)
				report(
					"MODEL_INVALID_STRUCTURE",
					"error",
					[...base, "from"],
					"from must contain three finite numbers.",
				);
			if (to === undefined)
				report(
					"MODEL_INVALID_STRUCTURE",
					"error",
					[...base, "to"],
					"to must contain three finite numbers.",
				);
			if (from !== undefined && to !== undefined) {
				let zeroAxes = 0;
				let inverted = false;
				for (let axis = 0; axis < 3; axis += 1) {
					const start = from[axis] as number;
					const end = to[axis] as number;
					if (start > end) inverted = true;
					if (start === end) zeroAxes += 1;
				}
				if (from.some((value) => value < -16 || value > 32))
					report(
						"MODEL_INVALID_STRUCTURE",
						"error",
						[...base, "from"],
						"from coordinates must be between -16 and 32.",
					);
				if (to.some((value) => value < -16 || value > 32))
					report(
						"MODEL_INVALID_STRUCTURE",
						"error",
						[...base, "to"],
						"to coordinates must be between -16 and 32.",
					);
				if (inverted)
					report(
						"MODEL_SUSPICIOUS_VALUE",
						"warning",
						base,
						"Element has an inverted extent.",
					);
				if (zeroAxes > 1)
					report(
						"MODEL_SUSPICIOUS_VALUE",
						"warning",
						base,
						"Element has no surface area.",
					);
			}

			const rotation = member(element, "rotation");
			if (rotation !== undefined)
				validateRotation(rotation, base, rules, report, unknown, featureSkip);
			const emission = member(element, "light_emission");
			if (emission !== undefined) {
				const value = numberValue(emission);
				if (
					value === undefined ||
					!Number.isInteger(value) ||
					value < 0 ||
					value > 15
				)
					report(
						"MODEL_INVALID_STRUCTURE",
						"error",
						[...base, "light_emission"],
						"light_emission must be an integer from 0 to 15.",
					);
				else if (rules.has("lightEmission") === false)
					report(
						"MODEL_VERSION_FEATURE",
						"warning",
						[...base, "light_emission"],
						"light_emission requires lightEmission.",
					);
				else if (rules.has("lightEmission") === undefined)
					featureSkip("lightEmission");
			}
			const shade = member(element, "shade");
			if (shade !== undefined) {
				if (shade.type !== "boolean")
					report(
						"MODEL_INVALID_STRUCTURE",
						"error",
						[...base, "shade"],
						"shade must be a boolean.",
					);
				else if (rules.shadeField === "shade_direction_override")
					report(
						"MODEL_VERSION_FEATURE",
						"warning",
						[...base, "shade"],
						"shade is removed in this version range.",
					);
				else if (rules.shadeField === "unknown") featureSkip("shadeField");
			}
			const shadeOverride = member(element, "shade_direction_override");
			if (shadeOverride !== undefined) {
				const direction = stringValue(shadeOverride);
				if (direction === undefined || !directions.has(direction))
					report(
						"MODEL_INVALID_STRUCTURE",
						"error",
						[...base, "shade_direction_override"],
						"shade_direction_override must be a direction.",
					);
				else if (rules.has("shadeDirectionOverride") === false)
					report(
						"MODEL_VERSION_FEATURE",
						"warning",
						[...base, "shade_direction_override"],
						"shade_direction_override requires its version feature.",
					);
				else if (rules.has("shadeDirectionOverride") === undefined)
					featureSkip("shadeDirectionOverride");
			}

			const faces = member(element, "faces");
			if (
				faces === undefined ||
				(isObject(faces) && faces.members.length === 0)
			)
				report(
					"MODEL_SUSPICIOUS_VALUE",
					"warning",
					[...base, "faces"],
					"Element has no faces and will not render.",
				);
			else if (!isObject(faces))
				report(
					"MODEL_INVALID_STRUCTURE",
					"error",
					[...base, "faces"],
					"faces must be an object.",
				);
			else {
				unknown(faces, directions, [...base, "faces"]);
				for (const face of faces.members) {
					const faceBase = [...base, "faces", face.key] as const;
					if (!directions.has(face.key)) {
						report(
							"MODEL_INVALID_STRUCTURE",
							"error",
							faceBase,
							"Face name must be a direction.",
						);
						continue;
					}
					if (!isObject(face.value)) {
						report(
							"MODEL_INVALID_STRUCTURE",
							"error",
							faceBase,
							"Face must be an object.",
						);
						continue;
					}
					unknown(face.value, faceFields, faceBase);
					const texture = member(face.value, "texture");
					if (stringValue(texture) === undefined)
						report(
							"MODEL_INVALID_STRUCTURE",
							"error",
							[...faceBase, "texture"],
							"Face texture must be a string.",
						);
					const uv = member(face.value, "uv");
					if (uv !== undefined) {
						const values = vector(uv, 4);
						if (values === undefined)
							report(
								"MODEL_INVALID_UV",
								"error",
								[...faceBase, "uv"],
								"uv must contain four finite numbers.",
							);
						else if (
							values.some((value) => value < 0 || value > 16) ||
							values[0] === values[2] ||
							values[1] === values[3]
						)
							report(
								"MODEL_SUSPICIOUS_VALUE",
								"warning",
								[...faceBase, "uv"],
								"uv is outside the usual atlas range or has zero area.",
							);
					}
					const cullface = member(face.value, "cullface");
					if (
						cullface !== undefined &&
						!directions.has(stringValue(cullface) ?? "")
					)
						report(
							"MODEL_INVALID_STRUCTURE",
							"error",
							[...faceBase, "cullface"],
							"cullface must be a direction.",
						);
					const tintindex = member(face.value, "tintindex");
					if (
						tintindex !== undefined &&
						(numberValue(tintindex) === undefined ||
							!Number.isInteger(numberValue(tintindex)))
					)
						report(
							"MODEL_INVALID_STRUCTURE",
							"error",
							[...faceBase, "tintindex"],
							"tintindex must be an integer.",
						);
					const faceRotation = member(face.value, "rotation");
					if (
						faceRotation !== undefined &&
						![0, 90, 180, 270].includes(numberValue(faceRotation) ?? Number.NaN)
					)
						report(
							"MODEL_INVALID_ROTATION",
							"error",
							[...faceBase, "rotation"],
							"Face rotation must be 0, 90, 180, or 270.",
						);
				}
			}
		}
	}

	findings.sort(
		(a, b) =>
			compareBytes(a.pointer, b.pointer) ||
			codeOrder.indexOf(a.code as (typeof codeOrder)[number]) -
				codeOrder.indexOf(b.code as (typeof codeOrder)[number]) ||
			compareBytes(a.message, b.message),
	);
	skipped.sort(
		(a, b) =>
			compareBytes(a.kind, b.kind) ||
			compareBytes(a.target, b.target) ||
			compareBytes(a.reason, b.reason),
	);
	return { findings, skipped };
}

function validateRotation(
	rotation: JsonNode,
	base: readonly (string | number)[],
	rules: ModelRules,
	report: (
		code: ModelStructureCode,
		level: "error" | "warning",
		pointer: readonly (string | number)[],
		message: string,
	) => void,
	unknown: (
		object: Extract<JsonNode, { type: "object" }>,
		allowed: ReadonlySet<string>,
		base: readonly (string | number)[],
	) => void,
	featureSkip: (feature: string) => void,
): void {
	const pointer = [...base, "rotation"] as const;
	if (!isObject(rotation)) {
		report(
			"MODEL_INVALID_ROTATION",
			"error",
			pointer,
			"rotation must be an object.",
		);
		return;
	}
	unknown(rotation, rotationFields, pointer);
	const origin = vector(member(rotation, "origin"), 3);
	if (origin === undefined)
		report(
			"MODEL_INVALID_ROTATION",
			"error",
			[...pointer, "origin"],
			"origin must contain three finite numbers.",
		);
	const axisNode = member(rotation, "axis");
	const angleNode = member(rotation, "angle");
	const axis = stringValue(axisNode);
	const angle = numberValue(angleNode);
	const hasAxisAngle = axisNode !== undefined || angleNode !== undefined;
	const xyzKeys = ["x", "y", "z"] as const;
	const xyzPresent = xyzKeys.some((key) => member(rotation, key) !== undefined);
	let xyzValid = true;
	for (const key of xyzKeys) {
		const value = member(rotation, key);
		if (
			value !== undefined &&
			(numberValue(value) === undefined || !Number.isFinite(numberValue(value)))
		) {
			report(
				"MODEL_INVALID_ROTATION",
				"error",
				[...pointer, key],
				`${key} must be a finite number.`,
			);
			xyzValid = false;
		}
	}
	if (
		hasAxisAngle &&
		(axisNode === undefined ||
			angleNode === undefined ||
			!["x", "y", "z"].includes(axis ?? "") ||
			angle === undefined ||
			!Number.isFinite(angle))
	) {
		if (
			axisNode === undefined ||
			(axisNode !== undefined && !["x", "y", "z"].includes(axis ?? ""))
		)
			report(
				"MODEL_INVALID_ROTATION",
				"error",
				[...pointer, "axis"],
				"axis must be x, y, or z.",
			);
		if (
			angleNode === undefined ||
			angle === undefined ||
			!Number.isFinite(angle)
		)
			report(
				"MODEL_INVALID_ROTATION",
				"error",
				[...pointer, "angle"],
				"angle must be finite.",
			);
	}
	if (!hasAxisAngle && !xyzPresent)
		report(
			"MODEL_INVALID_ROTATION",
			"error",
			pointer,
			"rotation must specify axis/angle or at least one xyz component.",
		);
	if (
		hasAxisAngle &&
		axisNode !== undefined &&
		angle !== undefined &&
		Number.isFinite(angle)
	) {
		if (
			rules.rotationAngle === "multiples-of-22.5" &&
			![-45, -22.5, 0, 22.5, 45].includes(angle)
		)
			report(
				"MODEL_INVALID_ROTATION",
				"error",
				[...pointer, "angle"],
				"angle must be a multiple of 22.5 from -45 through 45.",
			);
		if (rules.rotationAngle === "within-45" && (angle < -45 || angle > 45))
			report(
				"MODEL_INVALID_ROTATION",
				"error",
				[...pointer, "angle"],
				"angle must be between -45 and 45.",
			);
	}
	if (xyzPresent) {
		const supported = rules.has("rotationXyz");
		if (supported === false)
			report(
				"MODEL_VERSION_FEATURE",
				hasAxisAngle ? "warning" : "error",
				pointer,
				"xyz rotation requires rotationXyz.",
			);
		else if (supported === undefined) featureSkip("rotationXyz");
	}
	if (hasAxisAngle && xyzPresent && xyzValid) {
		if (rules.has("rotationXyz") === true)
			report(
				"MODEL_SUSPICIOUS_VALUE",
				"warning",
				pointer,
				"Both rotation forms are present; axis-angle takes precedence.",
			);
	}
	const rescale = member(rotation, "rescale");
	if (rescale !== undefined && rescale.type !== "boolean")
		report(
			"MODEL_INVALID_ROTATION",
			"error",
			[...pointer, "rescale"],
			"rescale must be a boolean.",
		);
}
