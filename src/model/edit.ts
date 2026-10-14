import { McAssetError } from "../core/errors.ts";
import {
	checkedOperationCount,
	closeDocument,
	collectNodeIdentities,
	formatNumber,
	OPERATION_REASONS,
	type OperationReason,
	operationFailure,
	resourceLimit,
	type UntouchedNodes,
} from "./edit-support.ts";
import {
	type JsonMember,
	type JsonNode,
	parseJsonDocument,
} from "./json-document.ts";
import { MODEL_LIMITS } from "./limits.ts";
import type { ModelFinding } from "./structure.ts";
import {
	DIRECTIONS,
	DISPLAY_POSITIONS,
	type Direction,
	type DisplayPosition,
	type DisplayTransformSpec,
	type ElementRotationSpec,
	type ElementSpec,
	type FaceRotation,
	type FaceSpec,
	type ModelSpec,
	type TextureEntry,
	type Uv4,
	type Vec3,
} from "./types.ts";
import type { ModelRules } from "./versions.ts";

export type ElementChanges = {
	readonly name?: string | null;
	readonly from?: Vec3;
	readonly to?: Vec3;
	readonly rotation?: ElementRotationSpec | null;
	readonly shade?: boolean | null;
	readonly shadeDirectionOverride?: Direction | null;
	readonly lightEmission?: number | null;
};

export type FaceChanges = {
	readonly texture?: string;
	readonly uv?: Uv4 | null;
	readonly rotation?: FaceRotation | null;
	readonly cullface?: Direction | null;
	readonly tintindex?: number | null;
};

export type ModelOperation =
	| { readonly op: "set_parent"; readonly parent: string | null }
	| {
			readonly op: "set_property";
			readonly ambientocclusion?: boolean | null;
			readonly guiLight?: "front" | "side" | null;
	  }
	| {
			readonly op: "set_texture";
			readonly name: string;
			readonly value: TextureEntry;
	  }
	| { readonly op: "remove_texture"; readonly name: string }
	| {
			readonly op: "add_element";
			readonly element: ElementSpec;
			readonly index?: number;
	  }
	| {
			readonly op: "update_element";
			readonly index: number;
			readonly changes: ElementChanges;
	  }
	| { readonly op: "remove_element"; readonly index: number }
	| {
			readonly op: "add_face";
			readonly element: number;
			readonly face: Direction;
			readonly value: FaceSpec;
	  }
	| {
			readonly op: "update_face";
			readonly element: number;
			readonly face: Direction;
			readonly changes: FaceChanges;
	  }
	| {
			readonly op: "remove_face";
			readonly element: number;
			readonly face: Direction;
	  }
	| {
			readonly op: "set_display";
			readonly position: DisplayPosition;
			readonly value: DisplayTransformSpec;
	  }
	| { readonly op: "remove_display"; readonly position: DisplayPosition };

export interface ModelEditResult {
	/** Serialized document (serializeJsonDocument). */
	readonly text: string;
	readonly changed: boolean;
	readonly applied: number;
	/** Warnings from the post-edit structure check; errors throw instead. */
	readonly warnings: readonly ModelFinding[];
	/** Pointers of unknown fields carried through untouched. */
	readonly preservedUnknown: readonly string[];
}

type JsonObject = Extract<JsonNode, { type: "object" }>;
type JsonArray = Extract<JsonNode, { type: "array" }>;
const rotationFields = new Set([
	"origin",
	"axis",
	"angle",
	"x",
	"y",
	"z",
	"rescale",
]);
const textureObjectFields = new Set(["sprite", "force_translucent"]);

function booleanNode(value: boolean): JsonNode {
	return { type: "boolean", value };
}
function stringNode(value: string): JsonNode {
	return { type: "string", value };
}
function numberNode(value: number): JsonNode {
	return { type: "number", raw: formatNumber(value), value };
}
function arrayNode(values: readonly JsonNode[]): JsonNode {
	return { type: "array", items: values };
}
function objectNode(members: readonly JsonMember[]): JsonObject {
	return { type: "object", members };
}
function member(node: JsonNode, key: string): JsonNode | undefined {
	return node.type === "object"
		? node.members.find((entry) => entry.key === key)?.value
		: undefined;
}
function byteCompare(left: string, right: string): number {
	const encoder = new TextEncoder();
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
		const difference = (a[index] as number) - (b[index] as number);
		if (difference !== 0) return difference;
	}
	return a.length - b.length;
}

function getMember(object: JsonObject, key: string): JsonMember | undefined {
	return object.members.find((entry) => entry.key === key);
}
function setMember(
	object: JsonObject,
	key: string,
	value: JsonNode,
): JsonObject {
	const index = object.members.findIndex((entry) => entry.key === key);
	const members = [...object.members];
	if (index < 0) members.push({ key, value });
	else members[index] = { key, value };
	return objectNode(members);
}
function removeMember(object: JsonObject, key: string): JsonObject {
	return objectNode(object.members.filter((entry) => entry.key !== key));
}
function updateRoot(
	root: JsonObject,
	key: string,
	value: JsonNode | undefined,
): JsonObject {
	return value === undefined
		? removeMember(root, key)
		: setMember(root, key, value);
}
function requiredObject(
	value: JsonNode | undefined,
	index: number,
	op: string,
): JsonObject {
	if (value?.type !== "object")
		operationFailure(index, op, OPERATION_REASONS.invalidExisting);
	return value;
}
function requiredArray(
	value: JsonNode | undefined,
	index: number,
	op: string,
): JsonArray {
	if (value?.type !== "array")
		operationFailure(index, op, OPERATION_REASONS.invalidExisting);
	return value;
}
function asObject(value: JsonNode | undefined): JsonObject | undefined {
	return value?.type === "object" ? value : undefined;
}
function validIndex(index: number, length: number): boolean {
	return Number.isInteger(index) && index >= 0 && index < length;
}
function finiteArray(values: readonly number[]): JsonArray {
	return arrayNode(values.map(numberNode)) as JsonArray;
}

function faceNode(face: FaceSpec): JsonObject {
	const members: JsonMember[] = [];
	if (face.uv !== undefined)
		members.push({ key: "uv", value: finiteArray(face.uv) });
	members.push({ key: "texture", value: stringNode(face.texture) });
	if (face.cullface !== undefined)
		members.push({ key: "cullface", value: stringNode(face.cullface) });
	if (face.rotation !== undefined)
		members.push({ key: "rotation", value: numberNode(face.rotation) });
	if (face.tintindex !== undefined)
		members.push({ key: "tintindex", value: numberNode(face.tintindex) });
	return objectNode(members);
}

function rotationNode(rotation: ElementRotationSpec): JsonObject {
	const members: JsonMember[] = [
		{ key: "origin", value: finiteArray(rotation.origin) },
	];
	if ("axis" in rotation) {
		members.push({ key: "axis", value: stringNode(rotation.axis) });
		members.push({ key: "angle", value: numberNode(rotation.angle) });
	} else {
		for (const key of ["x", "y", "z"] as const) {
			const value = rotation[key];
			if (value !== undefined) members.push({ key, value: numberNode(value) });
		}
	}
	if (rotation.rescale !== undefined)
		members.push({ key: "rescale", value: booleanNode(rotation.rescale) });
	return objectNode(members);
}

function elementNode(element: ElementSpec): JsonObject {
	const members: JsonMember[] = [];
	if (element.name !== undefined)
		members.push({ key: "name", value: stringNode(element.name) });
	members.push({ key: "from", value: finiteArray(element.from) });
	members.push({ key: "to", value: finiteArray(element.to) });
	if (element.rotation !== undefined)
		members.push({ key: "rotation", value: rotationNode(element.rotation) });
	if (element.shade !== undefined)
		members.push({ key: "shade", value: booleanNode(element.shade) });
	if (element.shadeDirectionOverride !== undefined)
		members.push({
			key: "shade_direction_override",
			value: stringNode(element.shadeDirectionOverride),
		});
	if (element.lightEmission !== undefined)
		members.push({
			key: "light_emission",
			value: numberNode(element.lightEmission),
		});
	const faces: JsonMember[] = [];
	for (const direction of DIRECTIONS) {
		const face = element.faces[direction];
		if (face !== undefined)
			faces.push({ key: direction, value: faceNode(face) });
	}
	members.push({ key: "faces", value: objectNode(faces) });
	return objectNode(members);
}

function displayNode(display: DisplayTransformSpec): JsonObject {
	const members: JsonMember[] = [];
	if (display.rotation !== undefined)
		members.push({ key: "rotation", value: finiteArray(display.rotation) });
	if (display.translation !== undefined)
		members.push({
			key: "translation",
			value: finiteArray(display.translation),
		});
	if (display.scale !== undefined)
		members.push({ key: "scale", value: finiteArray(display.scale) });
	return objectNode(members);
}

function textureEntryNode(value: TextureEntry): JsonNode {
	if (typeof value === "string") return stringNode(value);
	const members: JsonMember[] = [
		{ key: "sprite", value: stringNode(value.sprite) },
	];
	if (value.forceTranslucent !== undefined)
		members.push({
			key: "force_translucent",
			value: booleanNode(value.forceTranslucent),
		});
	return objectNode(members);
}

function createRoot(spec: ModelSpec): JsonObject {
	const members: JsonMember[] = [];
	if (spec.parent !== undefined)
		members.push({ key: "parent", value: stringNode(spec.parent) });
	if (spec.ambientocclusion !== undefined)
		members.push({
			key: "ambientocclusion",
			value: booleanNode(spec.ambientocclusion),
		});
	if (spec.guiLight !== undefined)
		members.push({ key: "gui_light", value: stringNode(spec.guiLight) });
	if (spec.textures !== undefined) {
		const names = Object.keys(spec.textures).sort(byteCompare);
		members.push({
			key: "textures",
			value: objectNode(
				names.map((name) => ({
					key: name,
					value: textureEntryNode(spec.textures?.[name] as TextureEntry),
				})),
			),
		});
	}
	if (spec.elements !== undefined)
		members.push({
			key: "elements",
			value: arrayNode(spec.elements.map(elementNode)),
		});
	if (spec.display !== undefined) {
		const displayMembers: JsonMember[] = [];
		for (const position of DISPLAY_POSITIONS) {
			const transform = spec.display[position];
			if (transform !== undefined)
				displayMembers.push({ key: position, value: displayNode(transform) });
		}
		members.push({ key: "display", value: objectNode(displayMembers) });
	}
	return objectNode(members);
}

function emptyObjectAt(
	root: JsonObject,
	key: string,
	index: number,
	op: string,
): JsonObject {
	const value = member(root, key);
	if (value === undefined) return objectNode([]);
	if (value.type !== "object")
		operationFailure(index, op, OPERATION_REASONS.invalidExisting);
	return value;
}
function replaceArrayAt(
	root: JsonObject,
	key: string,
	items: readonly JsonNode[],
): JsonObject {
	return setMember(root, key, arrayNode(items));
}
function replaceObjectAt(
	root: JsonObject,
	key: string,
	object: JsonObject,
): JsonObject {
	return setMember(root, key, object);
}

function validateTextureValue(
	value: TextureEntry,
	index: number,
	op: string,
): JsonNode {
	if (typeof value === "string") return stringNode(value);
	if (
		typeof value !== "object" ||
		value === null ||
		typeof value.sprite !== "string" ||
		(value.forceTranslucent !== undefined &&
			typeof value.forceTranslucent !== "boolean")
	)
		operationFailure(index, op, OPERATION_REASONS.invalidValue);
	return textureEntryNode(value);
}

function validateChanges(changes: object, index: number, op: string): void {
	if (Object.keys(changes).length === 0)
		operationFailure(index, op, OPERATION_REASONS.emptyChange);
}

function checkExistingTextureUnknown(
	value: JsonNode | undefined,
	index: number,
): void {
	if (value?.type !== "object") return;
	if (value.members.some((entry) => !textureObjectFields.has(entry.key)))
		operationFailure(
			index,
			"set_texture",
			OPERATION_REASONS.wouldDropUnknownMembers,
		);
}

function replaceKnownMembers(
	existing: JsonObject,
	replacement: JsonObject,
	knownKeys: ReadonlySet<string>,
): JsonObject {
	const replacementByKey = new Map(
		replacement.members.map((entry) => [entry.key, entry.value]),
	);
	const result: JsonMember[] = [];
	for (const entry of existing.members) {
		if (!knownKeys.has(entry.key)) result.push(entry);
		else {
			const value = replacementByKey.get(entry.key);
			if (value !== undefined) {
				result.push({ key: entry.key, value });
				replacementByKey.delete(entry.key);
			}
		}
	}
	for (const entry of replacement.members) {
		const value = replacementByKey.get(entry.key);
		if (value !== undefined) result.push({ key: entry.key, value });
	}
	return objectNode(result);
}

function applyOne(
	root: JsonObject,
	operation: ModelOperation,
	index: number,
): JsonObject {
	const op = (operation as { readonly op?: unknown }).op;
	if (typeof op !== "string")
		operationFailure(index, String(op ?? ""), OPERATION_REASONS.unknownOp);

	switch (operation.op) {
		case "set_parent": {
			const parent = operation as Extract<
				ModelOperation,
				{ readonly op: "set_parent" }
			>;
			if (parent.parent !== null && typeof parent.parent !== "string")
				operationFailure(index, op, OPERATION_REASONS.invalidValue);
			return updateRoot(
				root,
				"parent",
				parent.parent === null ? undefined : stringNode(parent.parent),
			);
		}
		case "set_property": {
			const properties = operation as Extract<
				ModelOperation,
				{ readonly op: "set_property" }
			>;
			const entries = Object.entries(properties).filter(
				([key]) => key !== "op",
			);
			if (entries.length === 0)
				operationFailure(index, op, OPERATION_REASONS.emptyChange);
			let next = root;
			for (const [key, value] of entries) {
				if (key === "ambientocclusion") {
					if (value !== null && typeof value !== "boolean")
						operationFailure(index, op, OPERATION_REASONS.invalidValue);
					next = updateRoot(
						next,
						key,
						value === null ? undefined : booleanNode(value),
					);
				} else if (key === "guiLight") {
					if (value !== null && typeof value !== "string")
						operationFailure(index, op, OPERATION_REASONS.invalidValue);
					next = updateRoot(
						next,
						"gui_light",
						value === null ? undefined : stringNode(value),
					);
				} else operationFailure(index, op, OPERATION_REASONS.invalidValue);
			}
			return next;
		}
		case "set_texture": {
			const name = (operation as { readonly name?: unknown }).name;
			const entry = operation as { readonly value?: TextureEntry };
			if (typeof name !== "string" || name.length === 0)
				operationFailure(index, op, OPERATION_REASONS.invalidValue);
			const currentTextures = emptyObjectAt(root, "textures", index, op);
			const existing = getMember(currentTextures, name);
			checkExistingTextureUnknown(existing?.value, index);
			const value = validateTextureValue(
				entry.value as TextureEntry,
				index,
				op,
			);
			const textures = setMember(currentTextures, name, value);
			if (textures.members.length > MODEL_LIMITS.maxTextures)
				resourceLimit(
					"Model texture variable limit exceeded.",
					MODEL_LIMITS.maxTextures,
					textures.members.length,
				);
			return replaceObjectAt(root, "textures", textures);
		}
		case "remove_texture": {
			const textures = requiredObject(member(root, "textures"), index, op);
			if (getMember(textures, operation.name) === undefined)
				operationFailure(index, op, OPERATION_REASONS.notFound);
			return replaceObjectAt(
				root,
				"textures",
				removeMember(textures, operation.name),
			);
		}
		case "add_element": {
			const add = operation as Extract<
				ModelOperation,
				{ readonly op: "add_element" }
			>;
			const current = member(root, "elements");
			const elements =
				current === undefined ? [] : requiredArray(current, index, op).items;
			const insertion = add.index === undefined ? elements.length : add.index;
			if (
				!Number.isInteger(insertion) ||
				insertion < 0 ||
				insertion > elements.length
			)
				operationFailure(index, op, OPERATION_REASONS.indexOutOfRange);
			if (elements.length >= MODEL_LIMITS.maxElements)
				resourceLimit(
					"Model element limit exceeded.",
					MODEL_LIMITS.maxElements,
					elements.length + 1,
				);
			const next = [...elements];
			next.splice(insertion, 0, elementNode(add.element));
			return replaceArrayAt(root, "elements", next);
		}
		case "update_element": {
			const update = operation as Extract<
				ModelOperation,
				{ readonly op: "update_element" }
			>;
			const elements = requiredArray(member(root, "elements"), index, op);
			if (!validIndex(update.index, elements.items.length))
				operationFailure(index, op, OPERATION_REASONS.elementNotFound);
			validateChanges(update.changes, index, op);
			const current = asObject(elements.items[update.index]);
			if (current === undefined)
				operationFailure(index, op, OPERATION_REASONS.invalidExisting);
			const replacements: JsonMember[] = [];
			for (const [key, value] of Object.entries(update.changes)) {
				switch (key) {
					case "name":
						if (value !== null && typeof value !== "string")
							operationFailure(index, op, OPERATION_REASONS.invalidValue);
						if (value !== null)
							replacements.push({ key: "name", value: stringNode(value) });
						break;
					case "from":
					case "to":
						if (
							!Array.isArray(value) ||
							value.length !== 3 ||
							value.some(
								(part) => typeof part !== "number" || !Number.isFinite(part),
							)
						)
							operationFailure(index, op, OPERATION_REASONS.invalidValue);
						replacements.push({
							key,
							value: finiteArray(value as readonly number[]),
						});
						break;
					case "rotation":
						if (value === null) break;
						if (
							typeof value !== "object" ||
							value === null ||
							!("origin" in value)
						)
							operationFailure(index, op, OPERATION_REASONS.invalidValue);
						{
							const rotation = rotationNode(value as ElementRotationSpec);
							const previous = asObject(member(current, "rotation"));
							const merged =
								previous === undefined
									? rotation
									: replaceKnownMembers(previous, rotation, rotationFields);
							replacements.push({ key: "rotation", value: merged });
						}
						break;
					case "shade":
						if (value !== null && typeof value !== "boolean")
							operationFailure(index, op, OPERATION_REASONS.invalidValue);
						if (value !== null)
							replacements.push({ key: "shade", value: booleanNode(value) });
						break;
					case "shadeDirectionOverride":
						if (
							value !== null &&
							!(DIRECTIONS as readonly unknown[]).includes(value)
						)
							operationFailure(index, op, OPERATION_REASONS.invalidValue);
						if (value !== null)
							replacements.push({
								key: "shade_direction_override",
								value: stringNode(value as string),
							});
						break;
					case "lightEmission":
						if (
							value !== null &&
							(typeof value !== "number" || !Number.isFinite(value))
						)
							operationFailure(index, op, OPERATION_REASONS.invalidValue);
						if (value !== null)
							replacements.push({
								key: "light_emission",
								value: numberNode(value as number),
							});
						break;
					default:
						operationFailure(index, op, OPERATION_REASONS.invalidValue);
				}
			}
			let nextElement = current;
			for (const [key, value] of Object.entries(update.changes)) {
				const jsonKey =
					key === "shadeDirectionOverride"
						? "shade_direction_override"
						: key === "lightEmission"
							? "light_emission"
							: key;
				if (key === "from" || key === "to") {
					const replacement = replacements.find(
						(entry) => entry.key === jsonKey,
					);
					nextElement = setMember(
						nextElement,
						jsonKey,
						replacement?.value as JsonNode,
					);
				} else if (key === "rotation") {
					const replacement = replacements.find(
						(entry) => entry.key === "rotation",
					);
					nextElement = updateRoot(
						nextElement,
						jsonKey,
						value === null ? undefined : replacement?.value,
					);
				} else {
					const replacement = replacements.find(
						(entry) => entry.key === jsonKey,
					);
					nextElement = updateRoot(
						nextElement,
						jsonKey,
						value === null ? undefined : replacement?.value,
					);
				}
			}
			const nextElements = [...elements.items];
			nextElements[update.index] = nextElement;
			return replaceArrayAt(root, "elements", nextElements);
		}
		case "remove_element": {
			const remove = operation as Extract<
				ModelOperation,
				{ readonly op: "remove_element" }
			>;
			const elements = requiredArray(member(root, "elements"), index, op);
			if (!validIndex(remove.index, elements.items.length))
				operationFailure(index, op, OPERATION_REASONS.elementNotFound);
			return replaceArrayAt(
				root,
				"elements",
				elements.items.filter((_, i) => i !== remove.index),
			);
		}
		case "add_face":
		case "update_face":
		case "remove_face": {
			const faceOperation = operation as Extract<
				ModelOperation,
				{ readonly op: "add_face" | "update_face" | "remove_face" }
			>;
			const elements = requiredArray(member(root, "elements"), index, op);
			if (!validIndex(faceOperation.element, elements.items.length))
				operationFailure(index, op, OPERATION_REASONS.elementNotFound);
			const element = asObject(elements.items[faceOperation.element]);
			if (element === undefined)
				operationFailure(index, op, OPERATION_REASONS.invalidExisting);
			const faces = emptyObjectAt(element, "faces", index, op);
			const existingFace = getMember(faces, faceOperation.face);
			let nextFaces: JsonObject;
			if (op === "add_face") {
				if (existingFace !== undefined)
					operationFailure(index, op, OPERATION_REASONS.faceExists);
				nextFaces = setMember(
					faces,
					faceOperation.face,
					faceNode(
						(
							faceOperation as Extract<
								ModelOperation,
								{ readonly op: "add_face" }
							>
						).value,
					),
				);
			} else if (op === "remove_face") {
				if (existingFace === undefined)
					operationFailure(index, op, OPERATION_REASONS.faceNotFound);
				nextFaces = removeMember(faces, faceOperation.face);
			} else {
				if (existingFace === undefined)
					operationFailure(index, op, OPERATION_REASONS.faceNotFound);
				const faceChanges = (
					faceOperation as Extract<
						ModelOperation,
						{ readonly op: "update_face" }
					>
				).changes;
				validateChanges(faceChanges, index, op);
				const currentFace = asObject(existingFace.value);
				if (currentFace === undefined)
					operationFailure(index, op, OPERATION_REASONS.invalidExisting);
				let nextFace = currentFace;
				for (const [key, value] of Object.entries(faceChanges)) {
					const jsonKey = key;
					let encoded: JsonNode | undefined;
					if (key === "texture") {
						if (typeof value !== "string")
							operationFailure(index, op, OPERATION_REASONS.invalidValue);
						encoded = stringNode(value);
					} else if (key === "uv") {
						if (
							value !== null &&
							(!Array.isArray(value) ||
								value.length !== 4 ||
								value.some(
									(part) => typeof part !== "number" || !Number.isFinite(part),
								))
						)
							operationFailure(index, op, OPERATION_REASONS.invalidValue);
						encoded =
							value === null
								? undefined
								: finiteArray(value as readonly number[]);
					} else if (key === "rotation") {
						if (value !== null && ![0, 90, 180, 270].includes(value as number))
							operationFailure(index, op, OPERATION_REASONS.invalidValue);
						encoded = value === null ? undefined : numberNode(value as number);
					} else if (key === "cullface") {
						if (
							value !== null &&
							!(DIRECTIONS as readonly unknown[]).includes(value)
						)
							operationFailure(index, op, OPERATION_REASONS.invalidValue);
						encoded = value === null ? undefined : stringNode(value as string);
					} else if (key === "tintindex") {
						if (
							value !== null &&
							(typeof value !== "number" || !Number.isInteger(value))
						)
							operationFailure(index, op, OPERATION_REASONS.invalidValue);
						encoded = value === null ? undefined : numberNode(value as number);
					} else operationFailure(index, op, OPERATION_REASONS.invalidValue);
					nextFace = updateRoot(nextFace, jsonKey, encoded);
				}
				nextFaces = setMember(faces, operation.face, nextFace);
			}
			const nextElement = setMember(element, "faces", nextFaces);
			const nextElements = [...elements.items];
			nextElements[operation.element] = nextElement;
			return replaceArrayAt(root, "elements", nextElements);
		}
		case "set_display": {
			const displayOperation = operation as Extract<
				ModelOperation,
				{ readonly op: "set_display" }
			>;
			const currentDisplay = emptyObjectAt(root, "display", index, op);
			const currentPosition = getMember(
				currentDisplay,
				displayOperation.position,
			);
			const value = displayOperation.value;
			validateChanges(value, index, op);
			if (
				currentPosition !== undefined &&
				currentPosition.value.type !== "object"
			)
				operationFailure(index, op, OPERATION_REASONS.invalidExisting);
			let position =
				currentPosition === undefined
					? objectNode([])
					: (currentPosition.value as JsonObject);
			const ordered = ["rotation", "translation", "scale"] as const;
			for (const key of ordered) {
				const part = (value as Record<string, unknown>)[key];
				if (part === undefined) continue;
				if (
					!Array.isArray(part) ||
					part.length !== 3 ||
					part.some(
						(item) => typeof item !== "number" || !Number.isFinite(item),
					)
				)
					operationFailure(index, op, OPERATION_REASONS.invalidValue);
				position = setMember(
					position,
					key,
					finiteArray(part as readonly number[]),
				);
			}
			for (const key of Object.keys(value)) {
				if (!["rotation", "translation", "scale"].includes(key))
					operationFailure(index, op, OPERATION_REASONS.invalidValue);
			}
			return replaceObjectAt(
				root,
				"display",
				setMember(currentDisplay, displayOperation.position, position),
			);
		}
		case "remove_display": {
			const remove = operation as Extract<
				ModelOperation,
				{ readonly op: "remove_display" }
			>;
			const display = requiredObject(member(root, "display"), index, op);
			if (getMember(display, remove.position) === undefined)
				operationFailure(index, op, OPERATION_REASONS.notFound);
			return replaceObjectAt(
				root,
				"display",
				removeMember(display, remove.position),
			);
		}
		default:
			operationFailure(index, op, OPERATION_REASONS.unknownOp);
	}
}

/** Builds a model document from a typed specification and validates the result. */
export function createModelDocument(
	spec: ModelSpec,
	rules: ModelRules,
): ModelEditResult {
	return closeDocument(createRoot(spec), rules, 0, {});
}

/** Apply model edits in order to a lossless immutable JSON tree. */
export function applyModelOperations(
	sourceText: string,
	operations: readonly ModelOperation[],
	rules: ModelRules,
): ModelEditResult {
	checkedOperationCount(operations.length);
	let root = parseJsonDocument(sourceText) as JsonObject;
	const untouched: UntouchedNodes = collectNodeIdentities(root);
	for (const [index, operation] of operations.entries()) {
		try {
			root = applyOne(root, operation, index);
		} catch (error) {
			if (
				error instanceof McAssetError &&
				error.code === "MODEL_INVALID_OPERATION"
			) {
				const details = error.details as Record<string, unknown> | undefined;
				if (details?.index === index && details.op !== undefined) throw error;
				const op = String((operation as { readonly op?: unknown }).op ?? "");
				const reason =
					typeof details?.reason === "string"
						? (details.reason as OperationReason)
						: OPERATION_REASONS.invalidValue;
				operationFailure(index, op, reason);
			}
			throw error;
		}
	}
	return closeDocument(root, rules, operations.length, {
		sourceText,
		untouched,
	});
}
