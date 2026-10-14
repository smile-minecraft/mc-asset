import { McAssetError } from "../core/errors.ts";
import type { ModelEditResult } from "./edit.ts";
import {
	type JsonNode,
	jsonPointer,
	parseJsonDocument,
	serializeJsonDocument,
} from "./json-document.ts";
import { MODEL_LIMITS } from "./limits.ts";
import type { ModelCoverageSkip, ModelFinding } from "./structure.ts";
import { validateModelStructure } from "./structure.ts";
import {
	MODEL_FEATURE_SINCE,
	type ModelFeature,
	type ModelRules,
} from "./versions.ts";

/** `details.reason` values for an operation that cannot be applied. */
export const OPERATION_REASONS = {
	emptyChange: "empty-change",
	invalidValue: "invalid-value",
	wouldDropUnknownMembers: "would-drop-unknown-members",
	notFound: "not-found",
	indexOutOfRange: "index-out-of-range",
	elementNotFound: "element-not-found",
	faceExists: "face-exists",
	faceNotFound: "face-not-found",
	invalidExisting: "invalid-existing",
	unknownOp: "unknown-op",
} as const;

export type OperationReason =
	(typeof OPERATION_REASONS)[keyof typeof OPERATION_REASONS];

/** A threshold feature found in a document that the target rules cannot confirm. */
export interface UnrepresentableFeature {
	readonly feature: string;
	readonly since: string;
	readonly pointer: string;
}

/** Number text for a value written by an edit; untouched number nodes keep their raw text. */
export function formatNumber(value: number): string {
	if (!Number.isFinite(value)) {
		throw new McAssetError(
			"MODEL_INVALID_OPERATION",
			"Model numbers must be finite.",
			{
				reason: OPERATION_REASONS.invalidValue,
			},
		);
	}
	return Object.is(value, -0) ? "0" : String(value);
}

/** Source-tree nodes reused by apply are exempt from representability checks. */
export type UntouchedNodes = ReadonlySet<JsonNode>;

type JsonObject = Extract<JsonNode, { type: "object" }>;

function member(node: JsonNode, key: string): JsonNode | undefined {
	return node.type === "object"
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

function firstUnsupported(
	feature: ModelFeature,
	pointer: readonly (string | number)[],
	node: JsonNode,
	rules: ModelRules,
	untouched: UntouchedNodes | undefined,
): UnrepresentableFeature | undefined {
	if (rules.has(feature) === true || untouched?.has(node)) return undefined;
	return {
		feature,
		since: MODEL_FEATURE_SINCE[feature],
		pointer: jsonPointer(pointer),
	};
}

/** A `textures` variable in object form needs its version feature; string values are version-free. */
function checkTextureForms(
	textures: JsonObject,
	path: readonly (string | number)[],
	rules: ModelRules,
	untouched: UntouchedNodes | undefined,
): UnrepresentableFeature | undefined {
	for (const texture of textures.members) {
		if (texture.value.type !== "object") continue;
		const result = firstUnsupported(
			"texturesObjectForm",
			[...path, texture.key],
			texture.value,
			rules,
			untouched,
		);
		if (result !== undefined) return result;
	}
	return undefined;
}

/** Only a `display` position named `on_shelf` is version-gated; the vectors inside are not. */
function checkDisplayPositions(
	display: JsonObject,
	path: readonly (string | number)[],
	rules: ModelRules,
	untouched: UntouchedNodes | undefined,
): UnrepresentableFeature | undefined {
	for (const position of display.members) {
		if (position.key !== "on_shelf") continue;
		const result = firstUnsupported(
			"displayOnShelf",
			[...path, position.key],
			position.value,
			rules,
			untouched,
		);
		if (result !== undefined) return result;
	}
	return undefined;
}

/** Angle and x/y/z members of one element rotation, in the rotation's member order. */
function checkElementRotation(
	rotation: JsonObject,
	path: readonly (string | number)[],
	rules: ModelRules,
	untouched: UntouchedNodes | undefined,
): UnrepresentableFeature | undefined {
	for (const rotationMember of rotation.members) {
		const rotationPath = [...path, rotationMember.key];
		let result: UnrepresentableFeature | undefined;
		if (["x", "y", "z"].includes(rotationMember.key)) {
			result = firstUnsupported(
				"rotationXyz",
				rotationPath,
				rotationMember.value,
				rules,
				untouched,
			);
		} else if (rotationMember.key === "angle") {
			const angle = asNumber(rotationMember.value);
			if (angle !== undefined && Number.isFinite(angle)) {
				if (
					(rules.rotationAngle === "multiples-of-22.5" &&
						![-45, -22.5, 0, 22.5, 45].includes(angle)) ||
					(rules.rotationAngle === "unknown" &&
						Math.abs(angle) <= 45 &&
						!Number.isInteger(angle / 22.5))
				) {
					result = firstUnsupported(
						"rotationAnyAngle",
						rotationPath,
						rotationMember.value,
						rules,
						untouched,
					);
				} else if (
					(rules.rotationAngle === "within-45" && Math.abs(angle) > 45) ||
					(rules.rotationAngle === "unknown" && Math.abs(angle) > 45)
				) {
					result = firstUnsupported(
						"rotationXyz",
						rotationPath,
						rotationMember.value,
						rules,
						untouched,
					);
				}
			}
		}
		if (result !== undefined) return result;
	}
	return undefined;
}

/** Version-gated members of one element; unknown element members keep their names unchecked. */
function checkElement(
	element: JsonObject,
	path: readonly (string | number)[],
	rules: ModelRules,
	untouched: UntouchedNodes | undefined,
): UnrepresentableFeature | undefined {
	for (const entry of element.members) {
		const childPath = [...path, entry.key];
		let result: UnrepresentableFeature | undefined;
		if (entry.key === "light_emission") {
			result = firstUnsupported(
				"lightEmission",
				childPath,
				entry.value,
				rules,
				untouched,
			);
		} else if (entry.key === "shade_direction_override") {
			result = firstUnsupported(
				"shadeDirectionOverride",
				childPath,
				entry.value,
				rules,
				untouched,
			);
		} else if (
			entry.key === "shade" &&
			rules.shadeField === "shade_direction_override"
		) {
			result = {
				feature: "shadeDirectionOverride",
				since: MODEL_FEATURE_SINCE.shadeDirectionOverride,
				pointer: jsonPointer(childPath),
			};
			if (untouched?.has(entry.value)) result = undefined;
		} else if (entry.key === "rotation" && entry.value.type === "object") {
			result = checkElementRotation(entry.value, childPath, rules, untouched);
		}
		if (result !== undefined) return result;
	}
	return undefined;
}

/**
 * Return the first newly unsupported use, following the document's member order.
 *
 * Only spec-defined positions are read: the root `transformation`, `textures`,
 * and `display` members, and each element's `light_emission`, `shade`,
 * `shade_direction_override`, and `rotation` members. Unknown fields keep their
 * names, so the gate never descends into their subtrees looking for same-named keys.
 */
export function findUnrepresentableFeature(
	root: JsonNode,
	rules: ModelRules,
	untouched?: UntouchedNodes,
): UnrepresentableFeature | undefined {
	if (root.type !== "object") return undefined;
	for (const entry of root.members) {
		const childPath: readonly (string | number)[] = [entry.key];
		let result: UnrepresentableFeature | undefined;
		if (entry.key === "transformation") {
			result = firstUnsupported(
				"itemTransformation",
				childPath,
				entry.value,
				rules,
				untouched,
			);
		} else if (entry.key === "textures" && entry.value.type === "object") {
			result = checkTextureForms(entry.value, childPath, rules, untouched);
		} else if (entry.key === "display" && entry.value.type === "object") {
			result = checkDisplayPositions(entry.value, childPath, rules, untouched);
		} else if (entry.key === "elements" && entry.value.type === "array") {
			for (const [index, element] of entry.value.items.entries()) {
				if (element.type !== "object") continue;
				result = checkElement(element, [...childPath, index], rules, untouched);
				if (result !== undefined) break;
			}
		}
		if (result !== undefined) return result;
	}
	return undefined;
}

function byteSortedUnique(values: readonly string[]): string[] {
	return [...new Set(values)].sort(byteCompare);
}

/** Pointers of model-unknown-field skips, de-duplicated and sorted by UTF-8 byte order. */
export function unknownFieldPointers(
	skipped: readonly ModelCoverageSkip[],
	_rel: string,
): string[] {
	return byteSortedUnique(
		skipped
			.filter((entry) => entry.kind === "model-unknown-field")
			.map((entry) => {
				const separator = entry.target.indexOf("#");
				return separator < 0 ? entry.target : entry.target.slice(separator + 1);
			}),
	);
}

function pointerSegments(pointer: string): readonly string[] {
	if (pointer === "") return [];
	return pointer
		.slice(1)
		.split("/")
		.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function atPointer(root: JsonNode, pointer: string): JsonNode | undefined {
	let current: JsonNode | undefined = root;
	for (const segment of pointerSegments(pointer)) {
		if (current?.type === "object")
			current = current.members.find((entry) => entry.key === segment)?.value;
		else if (current?.type === "array")
			current = current.items[Number(segment)];
		else return undefined;
	}
	return current;
}

function variableMap(
	root: JsonObject,
): ReadonlyMap<string, string | undefined> {
	const textures = asObject(member(root, "textures"));
	const result = new Map<string, string | undefined>();
	for (const entry of textures?.members ?? []) {
		const value =
			entry.value.type === "object"
				? asString(member(entry.value, "sprite"))
				: asString(entry.value);
		result.set(entry.key, value);
	}
	return result;
}

/** Check face texture variables locally when this document has no parent. */
export function checkDocumentVariables(root: JsonNode): ModelFinding[] {
	if (root.type !== "object" || member(root, "parent") !== undefined) return [];
	const variables = variableMap(root);
	const findings: ModelFinding[] = [];
	const elements = member(root, "elements");
	if (elements?.type !== "array") return findings;

	for (const [elementIndex, element] of elements.items.entries()) {
		const faces = asObject(member(element, "faces"));
		if (element.type !== "object" || faces === undefined) continue;
		for (const face of faces.members) {
			if (face.value.type !== "object") continue;
			const textureNode = member(face.value, "texture");
			const texture = asString(textureNode);
			if (
				textureNode === undefined ||
				texture === undefined ||
				!texture.startsWith("#")
			)
				continue;
			const pointer = jsonPointer([
				"elements",
				elementIndex,
				"faces",
				face.key,
				"texture",
			]);
			let name = texture.slice(1);
			const visited = new Set<string>();
			let valid = true;
			while (true) {
				if (visited.has(name)) {
					valid = false;
					break;
				}
				visited.add(name);
				const value = variables.get(name);
				if (value === undefined) {
					valid = false;
					break;
				}
				if (!value.startsWith("#")) break;
				name = value.slice(1);
			}
			if (!valid) {
				findings.push({
					code: "PACK_BROKEN_REFERENCE",
					level: "error",
					message: `Texture variable ${texture} is undefined or cyclic.`,
					pointer,
				});
			}
		}
	}
	return findings;
}

export interface CloseOptions {
	readonly sourceText?: string;
	readonly untouched?: UntouchedNodes;
}

function invalidOperation(findings: readonly ModelFinding[]): never {
	throw new McAssetError(
		"MODEL_INVALID_OPERATION",
		"The resulting model document is invalid.",
		{ findings },
	);
}

const outputEncoder = new TextEncoder();

function stringBytes(value: string): number {
	return outputEncoder.encode(value).length;
}

/** Every string value and every object key must fit in maxStringBytes (UTF-8 bytes). */
function checkOutputStrings(root: JsonNode): void {
	const visit = (node: JsonNode): void => {
		if (node.type === "string") {
			const actual = stringBytes(node.value);
			if (actual > MODEL_LIMITS.maxStringBytes)
				resourceLimit(
					"Model JSON string exceeds the byte limit.",
					MODEL_LIMITS.maxStringBytes,
					actual,
				);
			return;
		}
		if (node.type === "object") {
			for (const entry of node.members) {
				const keyBytes = stringBytes(entry.key);
				if (keyBytes > MODEL_LIMITS.maxStringBytes)
					resourceLimit(
						"Model JSON string exceeds the byte limit.",
						MODEL_LIMITS.maxStringBytes,
						keyBytes,
					);
				visit(entry.value);
			}
			return;
		}
		if (node.type === "array") for (const item of node.items) visit(item);
	};
	visit(root);
}

/** Run representability, structure/reference checks, and canonical serialization in that order. */
export function closeDocument(
	root: JsonNode,
	rules: ModelRules,
	applied: number,
	options: CloseOptions,
): ModelEditResult {
	const unsupported = findUnrepresentableFeature(
		root,
		rules,
		options.untouched,
	);
	if (unsupported !== undefined) {
		throw new McAssetError(
			"MODEL_UNSUPPORTED_VERSION",
			`The target pack format cannot represent ${unsupported.feature}.`,
			{
				feature: unsupported.feature,
				since: unsupported.since,
				target: rules.packFormat ?? "unspecified",
				pointer: unsupported.pointer,
			},
		);
	}

	const structural = validateModelStructure(root, rules, "");
	const findings = [
		...structural.findings.filter((finding) => {
			if (
				finding.level !== "error" ||
				options.untouched === undefined ||
				finding.code === "MODEL_INVALID_STRUCTURE" ||
				finding.code === "MODEL_INVALID_UV" ||
				finding.code === "MODEL_INVALID_DISPLAY"
			)
				return true;
			if (finding.code === "MODEL_VERSION_FEATURE") {
				const featureNode = atPointer(root, finding.pointer);
				if (featureNode !== undefined && options.untouched.has(featureNode))
					return false;
				const rotation = atPointer(root, finding.pointer);
				if (
					rotation?.type === "object" &&
					rotation.members.some(
						(entry) =>
							["x", "y", "z"].includes(entry.key) &&
							options.untouched?.has(entry.value),
					)
				)
					return false;
				return true;
			}
			if (
				finding.code === "MODEL_INVALID_ROTATION" &&
				/\/angle$/.test(finding.pointer)
			) {
				const angle = atPointer(root, finding.pointer);
				if (angle?.type === "number" && options.untouched.has(angle))
					return false;
			}
			return true;
		}),
		...checkDocumentVariables(root),
	];
	if (findings.some((finding) => finding.level === "error"))
		invalidOperation(findings);

	checkOutputStrings(root);
	const text = serializeJsonDocument(root);
	const fileBytes = stringBytes(text);
	if (fileBytes > MODEL_LIMITS.maxFileBytes)
		resourceLimit(
			"Model JSON exceeds the file byte limit.",
			MODEL_LIMITS.maxFileBytes,
			fileBytes,
		);
	return {
		text,
		changed:
			options.sourceText === undefined ? true : text !== options.sourceText,
		applied,
		warnings: findings.filter((finding) => finding.level === "warning"),
		preservedUnknown: unknownFieldPointers(structural.skipped, ""),
	};
}

export function parseModelDocument(sourceText: string): JsonObject {
	return parseJsonDocument(sourceText) as JsonObject;
}

export function collectNodeIdentities(root: JsonNode): Set<JsonNode> {
	const nodes = new Set<JsonNode>();
	const visit = (node: JsonNode): void => {
		nodes.add(node);
		if (node.type === "object")
			for (const entry of node.members) visit(entry.value);
		else if (node.type === "array") for (const item of node.items) visit(item);
	};
	visit(root);
	return nodes;
}

export function resourceLimit(
	message: string,
	limit: number,
	actual: number,
): never {
	throw new McAssetError("RESOURCE_LIMIT_EXCEEDED", message, { limit, actual });
}

export function operationFailure(
	index: number,
	op: string,
	reason: OperationReason,
): never {
	throw new McAssetError(
		"MODEL_INVALID_OPERATION",
		`Operation ${op} failed: ${reason}.`,
		{ index, op, reason },
	);
}

export function checkedOperationCount(count: number): void {
	if (count > MODEL_LIMITS.maxOperations)
		resourceLimit(
			"Model operation limit exceeded.",
			MODEL_LIMITS.maxOperations,
			count,
		);
}
