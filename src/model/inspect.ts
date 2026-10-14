import type { ResolutionSource } from "../validate/resource-context.ts";
import { validateResourceLocation } from "../validate/resource-location.ts";
import {
	createStandaloneContext,
	type ModelResolutionContext,
} from "./context.ts";
import {
	type JsonNode,
	jsonPointer,
	parseJsonDocument,
} from "./json-document.ts";
import { MODEL_LIMITS } from "./limits.ts";
import {
	byteCompare,
	type ModelDocument,
	type ModelReferenceResolution,
	modelResourcePath,
	resolveModelReference,
	resolveTextureReference,
} from "./references.ts";
import {
	type ModelCoverageSkip,
	type ModelFinding,
	validateModelStructure,
} from "./structure.ts";
import {
	DIRECTIONS,
	DISPLAY_POSITIONS,
	type Direction,
	type FaceRotation,
	type Uv4,
	type Vec3,
} from "./types.ts";
import {
	type ModelRuleReason,
	type ModelRuleStatus,
	resolveModelRules,
} from "./versions.ts";

export interface ModelVersionInfo {
	readonly packFormat?: string;
	readonly minecraftVersion?: string;
	readonly rules: ModelRuleStatus;
	readonly rulesReason: ModelRuleReason;
}
export interface ModelCoverage {
	readonly status: "complete" | "partial";
	readonly skipped: readonly ModelCoverageSkip[];
}
export interface ModelTextureResolution {
	readonly resolvedTo?: string;
	readonly status:
		| "resolved"
		| "unresolved"
		| "missing"
		| "undefined-variable"
		| "cycle"
		| "external";
	readonly source?: ResolutionSource;
	readonly via: readonly string[];
}
export interface ModelFaceView {
	readonly face: Direction;
	readonly texture: string;
	readonly textureResolution: ModelTextureResolution;
	readonly uv?: Uv4;
	readonly rotation: FaceRotation;
	readonly cullface?: Direction;
	readonly tintindex?: number;
}
export interface ModelElementView {
	readonly index: number;
	readonly name?: string;
	readonly from: Vec3;
	readonly to: Vec3;
	readonly size: Vec3;
	readonly rotation?: {
		readonly form: "axis-angle" | "xyz" | "both" | "invalid";
		readonly origin?: Vec3;
		readonly axis?: "x" | "y" | "z";
		readonly angle?: number;
		readonly x?: number;
		readonly y?: number;
		readonly z?: number;
		readonly rescale?: boolean;
	};
	readonly shade?: boolean;
	readonly shadeDirectionOverride?: Direction;
	readonly lightEmission?: number;
	readonly faces: readonly ModelFaceView[];
}
export interface ModelParentLink {
	readonly id: string;
	readonly source: ResolutionSource;
	readonly target: string;
}
export interface ModelInspectReport {
	readonly command: "model";
	readonly mode: "inspect";
	readonly path: string;
	readonly modelId?: string;
	readonly kind: "block" | "item" | "unknown";
	readonly target: string;
	readonly version: ModelVersionInfo;
	readonly verdict: "pass" | "fail";
	readonly findings: readonly ModelFinding[];
	readonly coverage: ModelCoverage;
	readonly parent?: {
		readonly value: string;
		readonly status: "resolved" | "unresolved" | "missing" | "builtin";
		readonly source?: ResolutionSource;
		readonly target?: string;
	};
	readonly parentChain: readonly ModelParentLink[];
	readonly properties: {
		readonly ambientocclusion?: boolean;
		readonly guiLight?: "front" | "side";
	};
	readonly textures: readonly {
		readonly name: string;
		readonly value: string;
		readonly forceTranslucent?: boolean;
		readonly resolution: ModelTextureResolution;
	}[];
	readonly inheritedTextures: readonly {
		readonly name: string;
		readonly value: string;
		readonly from: string;
	}[];
	readonly elements: readonly ModelElementView[];
	readonly elementsSource: {
		readonly from: "own" | "inherited" | "none";
		readonly parent?: string;
	};
	readonly display: readonly {
		readonly position: string;
		readonly from: string;
		readonly rotation?: Vec3;
		readonly translation?: Vec3;
		readonly scale?: Vec3;
	}[];
	readonly preservedUnknown: readonly string[];
	readonly summary: {
		readonly elementCount: number;
		readonly faceCount: number;
		readonly textureCount: number;
	};
}
export interface ModelValidateReport {
	readonly command: "model";
	readonly mode: "validate";
	readonly path: string;
	readonly target: string;
	readonly version: ModelVersionInfo;
	readonly verdict: "pass" | "fail";
	readonly findings: readonly ModelFinding[];
	readonly coverage: ModelCoverage;
}
export interface ModelAnalyzeOptions {
	readonly packFormat?: string | undefined;
	readonly minecraftVersion?: string | undefined;
	readonly modelId?: string | undefined;
	readonly context?: ModelResolutionContext | undefined;
	readonly path: string;
}

function member(node: JsonNode, key: string): JsonNode | undefined {
	return node.type === "object"
		? node.members.find((entry) => entry.key === key)?.value
		: undefined;
}
function object(
	node: JsonNode | undefined,
): Extract<JsonNode, { type: "object" }> | undefined {
	return node?.type === "object" ? node : undefined;
}
function string(node: JsonNode | undefined): string | undefined {
	return node?.type === "string" ? node.value : undefined;
}
function number(node: JsonNode | undefined): number | undefined {
	return node?.type === "number" ? node.value : undefined;
}
function bool(node: JsonNode | undefined): boolean | undefined {
	return node?.type === "boolean" ? node.value : undefined;
}
function numberVector(
	node: JsonNode | undefined,
	length: number,
): number[] | undefined {
	if (node?.type !== "array" || node.items.length !== length) return undefined;
	const values = node.items.map(number);
	if (values.some((value) => value === undefined || !Number.isFinite(value)))
		return undefined;
	return values as number[];
}
function kindFromPath(path: string): "block" | "item" | "unknown" {
	if (path.includes("/models/block/")) return "block";
	if (path.includes("/models/item/")) return "item";
	return "unknown";
}
function rootProperty(root: JsonNode, key: string): JsonNode | undefined {
	return member(root, key);
}
function addSkip(
	skipped: ModelCoverageSkip[],
	kind: string,
	reason: string,
	target: string,
	detail?: string,
): void {
	if (
		skipped.some(
			(entry) =>
				entry.kind === kind &&
				entry.reason === reason &&
				entry.target === target &&
				entry.detail === detail,
		)
	)
		return;
	skipped.push({
		kind,
		reason,
		target,
		...(detail === undefined ? {} : { detail }),
	});
}
function referenceFinding(
	findings: ModelFinding[],
	code: ModelFinding["code"],
	level: "error" | "warning",
	pointer: string,
	message: string,
): void {
	findings.push({ code, level, pointer, message });
}
function mapReferenceStatus(
	status: ModelReferenceResolution["status"],
): ModelTextureResolution["status"] {
	if (status === "case-mismatch") return "missing";
	if (status === "builtin") return "resolved";
	return status;
}
interface TextureEntry {
	readonly value: string | undefined;
	readonly forceTranslucent?: boolean;
	readonly invalidReference?: boolean;
}

type ParentTermination =
	| { readonly status: "complete"; readonly reason: "no-parent" | "builtin" }
	| { readonly status: "incomplete"; readonly reason: string };

function validateReferenceValue(
	value: string | undefined,
	kind: "model" | "texture",
	pointer: string,
	findings: ModelFinding[],
	allowVariable = false,
): value is string {
	if (value === undefined || value.trim() === "" || value === "#") {
		referenceFinding(
			findings,
			"PACK_BROKEN_REFERENCE",
			"error",
			pointer,
			`Referenced ${kind} must be a nonempty resource location${allowVariable ? " or named texture variable" : ""}.`,
		);
		return false;
	}
	if (allowVariable && value.startsWith("#")) return true;
	if (
		(kind === "model" && value.toLowerCase().endsWith(".png")) ||
		(kind === "texture" && value.toLowerCase().endsWith(".json"))
	) {
		referenceFinding(
			findings,
			"PACK_BROKEN_REFERENCE",
			"error",
			pointer,
			`Referenced ${kind} ${value} points to the wrong asset kind.`,
		);
		return false;
	}
	const problems = validateResourceLocation(value).filter(
		(finding) => finding.code !== "PENDING_SOURCE_PNG_ONLY",
	);
	for (const problem of problems) {
		referenceFinding(
			findings,
			problem.code === "PACK_CASE_MISMATCH"
				? "PACK_CASE_MISMATCH"
				: "PACK_BROKEN_REFERENCE",
			problem.level,
			pointer,
			problem.message,
		);
	}
	return problems.length === 0;
}

function addResolutionFinding(
	resolution: ModelReferenceResolution,
	kind: "model" | "texture",
	pointer: string,
	findings: ModelFinding[],
	skipped: ModelCoverageSkip[],
): void {
	if (resolution.status === "missing") {
		referenceFinding(
			findings,
			kind === "model" ? "PACK_MISSING_ASSET" : "PACK_MISSING_TEXTURE",
			"error",
			pointer,
			`Referenced ${kind} ${resolution.resourceLocation} was not found.`,
		);
	} else if (resolution.status === "case-mismatch") {
		referenceFinding(
			findings,
			"PACK_CASE_MISMATCH",
			"error",
			pointer,
			`Referenced ${kind} ${resolution.resourceLocation} differs only by case from ${resolution.target}.`,
		);
	} else if (resolution.status === "unresolved") {
		const reason = resolution.reason ?? "no-resolution-context";
		referenceFinding(
			findings,
			"PACK_UNRESOLVED_EXTERNAL",
			"warning",
			pointer,
			`Referenced ${kind} ${resolution.resourceLocation} could not be checked (${reason}).`,
		);
		addSkip(skipped, "external-reference", reason, resolution.resourceLocation);
	}
}

async function analyze(
	text: string,
	options: ModelAnalyzeOptions,
): Promise<{
	root: JsonNode;
	report: ModelInspectReport;
}> {
	const root = parseJsonDocument(text);
	const rules = resolveModelRules(options.packFormat);
	const context = options.context ?? createStandaloneContext();
	const target = options.modelId ?? options.path;
	const findings: ModelFinding[] = [];
	const skipped: ModelCoverageSkip[] = [];
	const own: ModelDocument = {
		id: options.modelId ?? options.path,
		rel: options.path,
		source: "own",
		root,
	};
	const structure = validateModelStructure(root, rules, options.path);
	findings.push(...structure.findings);
	skipped.push(...structure.skipped);

	const checkedParent = (
		document: ModelDocument,
		pointer: string,
	): string | undefined => {
		const node = rootProperty(document.root, "parent");
		if (node === undefined) return undefined;
		const value = string(node);
		return validateReferenceValue(value, "model", pointer, findings)
			? value
			: undefined;
	};
	const ownParent = checkedParent(own, "/parent");
	let parentTermination: ParentTermination =
		member(root, "parent") !== undefined && ownParent === undefined
			? { status: "incomplete", reason: "invalid-reference" }
			: { status: "complete", reason: "no-parent" };
	let parentReport: ModelInspectReport["parent"];
	const parentChain: ModelParentLink[] = [];
	const documents: ModelDocument[] = [own];
	const seen = new Set<string>([own.id]);
	let nextParent = ownParent;
	for (let depth = 0; nextParent !== undefined; depth += 1) {
		const pointer = depth === 0 ? "/parent" : "";
		const resolution = resolveModelReference(context, nextParent);
		if (depth === 0) {
			parentReport = {
				value: nextParent,
				status:
					resolution.status === "case-mismatch" ? "missing" : resolution.status,
				...(resolution.source === undefined
					? {}
					: { source: resolution.source }),
				...(resolution.target === undefined
					? {}
					: { target: resolution.target }),
			};
		}
		if (resolution.status === "builtin") {
			parentTermination = { status: "complete", reason: "builtin" };
			break;
		}
		if (
			resolution.status === "missing" ||
			resolution.status === "case-mismatch" ||
			resolution.status === "unresolved"
		) {
			addResolutionFinding(resolution, "model", pointer, findings, skipped);
			parentTermination = {
				status: "incomplete",
				reason: resolution.reason ?? resolution.status,
			};
			break;
		}
		const id = nextParent;
		if (seen.has(id)) {
			parentTermination = { status: "incomplete", reason: "parent-cycle" };
			referenceFinding(
				findings,
				"PACK_REFERENCE_CYCLE",
				"error",
				pointer,
				`Model parent cycle includes ${[...seen, id].join(" -> ")}.`,
			);
			break;
		}
		if (depth >= MODEL_LIMITS.maxParentDepth) {
			parentTermination = { status: "incomplete", reason: "depth-limit" };
			addSkip(
				skipped,
				"model-parent",
				"depth-limit",
				options.path,
				`Parent depth exceeds ${MODEL_LIMITS.maxParentDepth}.`,
			);
			break;
		}
		const layer = resolution.layer;
		const rel = resolution.target ?? modelResourcePath(id);
		if (layer === undefined) {
			parentTermination = {
				status: "incomplete",
				reason: "document-unreadable",
			};
			addSkip(skipped, "model-parent", parentTermination.reason, rel);
			break;
		}
		let bytes: Uint8Array | undefined;
		try {
			bytes = await layer.read(rel);
		} catch {
			parentTermination = {
				status: "incomplete",
				reason: "document-unreadable",
			};
			addSkip(skipped, "model-parent", "document-unreadable", rel);
			break;
		}
		if (bytes === undefined) {
			parentTermination = {
				status: "incomplete",
				reason: "document-unreadable",
			};
			addSkip(skipped, "model-parent", "document-unreadable", rel);
			break;
		}
		if (bytes.byteLength > MODEL_LIMITS.maxFileBytes) {
			parentTermination = {
				status: "incomplete",
				reason: "document-too-large",
			};
			addSkip(skipped, "model-parent", "document-too-large", rel);
			break;
		}
		let parentRoot: JsonNode;
		try {
			parentRoot = parseJsonDocument(
				new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			);
		} catch {
			parentTermination = {
				status: "incomplete",
				reason: "document-invalid-json",
			};
			addSkip(skipped, "model-parent", "document-invalid-json", rel);
			break;
		}
		seen.add(id);
		const source = resolution.source;
		if (source === undefined) {
			parentTermination = {
				status: "incomplete",
				reason: "document-unreadable",
			};
			addSkip(skipped, "model-parent", parentTermination.reason, rel);
			break;
		}
		parentChain.push({ id, source, target: rel });
		documents.push({ id, rel, source, root: parentRoot });
		const document = documents[documents.length - 1] as ModelDocument;
		nextParent = checkedParent(document, "");
		parentTermination =
			member(parentRoot, "parent") !== undefined && nextParent === undefined
				? { status: "incomplete", reason: "invalid-reference" }
				: { status: "complete", reason: "no-parent" };
	}

	const version: ModelVersionInfo = {
		...(options.packFormat === undefined
			? {}
			: { packFormat: options.packFormat }),
		...(options.minecraftVersion === undefined
			? {}
			: { minecraftVersion: options.minecraftVersion }),
		rules: rules.status,
		rulesReason: rules.reason,
	};
	const textureMaps = documents.map((document, documentIndex) => {
		const result = new Map<string, TextureEntry>();
		const node = member(document.root, "textures");
		if (node === undefined) return result;
		if (node.type !== "object") {
			referenceFinding(
				findings,
				"PACK_BROKEN_REFERENCE",
				"error",
				"/textures",
				"textures must be an object.",
			);
			return result;
		}
		for (const entry of node.members) {
			const isSprite = entry.value.type === "object";
			const spriteNode = isSprite ? member(entry.value, "sprite") : entry.value;
			const value = string(spriteNode);
			const pointer = jsonPointer(
				isSprite ? ["textures", entry.key, "sprite"] : ["textures", entry.key],
			);
			const invalidType =
				value === undefined &&
				(isSprite || rules.has("texturesObjectForm") === true);
			if (invalidType && documentIndex > 0)
				referenceFinding(
					findings,
					"MODEL_INVALID_STRUCTURE",
					"error",
					pointer,
					isSprite
						? "Texture sprite must be a resource location string."
						: "Texture entry must be a string or texture object.",
				);
			// Own structure checks already report these types; every definition still shadows ancestors.
			const valid = invalidType
				? false
				: validateReferenceValue(
						value,
						"texture",
						pointer,
						findings,
						!isSprite,
					);
			const forceTranslucent = isSprite
				? bool(member(entry.value, "force_translucent"))
				: undefined;
			result.set(entry.key, {
				value,
				invalidReference: !valid,
				...(forceTranslucent === undefined ? {} : { forceTranslucent }),
			});
		}
		return result;
	});
	const ownTextureMap = textureMaps[0] as Map<string, TextureEntry>;
	const inheritedTextures: ModelInspectReport["inheritedTextures"][number][] =
		[];
	const inheritedNames = new Set(ownTextureMap.keys());
	for (const [index, document] of documents.entries()) {
		if (index === 0) continue;
		for (const [name, entry] of textureMaps[index] as Map<
			string,
			TextureEntry
		>) {
			if (inheritedNames.has(name)) continue;
			inheritedNames.add(name);
			if (entry.value === undefined) continue;
			inheritedTextures.push({ name, value: entry.value, from: document.id });
		}
	}
	inheritedTextures.sort((a, b) => byteCompare(a.name, b.name));

	const resolveTextureValue = (
		texture: string,
		pointer: string,
	): ModelTextureResolution => {
		const via: string[] = [];
		let current = texture;
		const visited = new Set<string>();
		while (current.startsWith("#")) {
			const name = current.slice(1);
			via.push(current);
			if (visited.has(name)) return { status: "cycle", via };
			visited.add(name);
			let entry: TextureEntry | undefined;
			for (const map of textureMaps) {
				entry = map.get(name);
				if (entry !== undefined) break;
			}
			if (entry === undefined)
				return {
					status:
						parentTermination.status === "incomplete"
							? "external"
							: "undefined-variable",
					via,
				};
			if (entry.invalidReference || entry.value === undefined)
				return { status: "missing", via };
			current = entry.value;
		}
		if (!validateReferenceValue(current, "texture", pointer, findings))
			return { status: "missing", via };
		const resolved = resolveTextureReference(context, current);
		addResolutionFinding(resolved, "texture", pointer, findings, skipped);
		return {
			status: mapReferenceStatus(resolved.status),
			...(resolved.status === "resolved" ||
			resolved.status === "missing" ||
			resolved.status === "case-mismatch"
				? { resolvedTo: current }
				: {}),
			...(resolved.source === undefined ? {} : { source: resolved.source }),
			via,
		};
	};
	const textureSkipReason = (
		status: ModelTextureResolution["status"],
	): string =>
		status === "external"
			? parentTermination.reason
			: context.layers.length === 0
				? "no-resolution-context"
				: "vanilla-not-provided";

	const textureReports: ModelInspectReport["textures"][number][] = [];
	for (const [name, entry] of ownTextureMap) {
		if (entry.value === undefined) continue;
		const resolved = entry.invalidReference
			? { status: "missing" as const, via: [] }
			: resolveTextureValue(entry.value, jsonPointer(["textures", name]));
		const reportEntry = {
			name,
			value: entry.value,
			...(entry.forceTranslucent === undefined
				? {}
				: { forceTranslucent: entry.forceTranslucent }),
			resolution: resolved,
		};
		textureReports.push(reportEntry);

		if (resolved.status === "undefined-variable")
			referenceFinding(
				findings,
				"PACK_BROKEN_REFERENCE",
				"error",
				jsonPointer(["textures", name]),
				`Texture variable ${entry.value} is undefined.`,
			);
		if (resolved.status === "cycle")
			referenceFinding(
				findings,
				"PACK_REFERENCE_CYCLE",
				"error",
				jsonPointer(["textures", name]),
				`Texture variable cycle: ${resolved.via.join(" -> ")}.`,
			);
		if (resolved.status === "unresolved" || resolved.status === "external")
			addSkip(
				skipped,
				"external-reference",
				textureSkipReason(resolved.status),
				entry.value,
			);
	}
	textureReports.sort((a, b) => byteCompare(a.name, b.name));

	let elementsSource: ModelInspectReport["elementsSource"] = { from: "none" };
	let effectiveElements: JsonNode | undefined;
	const ownElements = member(root, "elements");
	if (ownElements?.type === "array") {
		effectiveElements = ownElements;
		elementsSource = { from: "own" };
	} else {
		for (const document of documents.slice(1)) {
			const elements = member(document.root, "elements");
			if (elements?.type === "array") {
				effectiveElements = elements;
				elementsSource = { from: "inherited", parent: document.id };
				break;
			}
		}
	}

	const elementViews: ModelElementView[] = [];
	if (effectiveElements?.type === "array") {
		for (const [index, element] of effectiveElements.items.entries()) {
			if (element.type !== "object") continue;
			const from = numberVector(member(element, "from"), 3);
			const to = numberVector(member(element, "to"), 3);
			if (from === undefined || to === undefined) continue;
			const name = string(member(element, "name"));
			const rotationNode = member(element, "rotation");
			let rotation: ModelElementView["rotation"];
			if (rotationNode !== undefined) {
				const rotationObject = object(rotationNode);
				if (rotationObject === undefined) rotation = { form: "invalid" };
				else {
					const origin = numberVector(member(rotationObject, "origin"), 3);
					const axis = string(member(rotationObject, "axis"));
					const angle = number(member(rotationObject, "angle"));
					const xyz = ["x", "y", "z"].some(
						(key) => member(rotationObject, key) !== undefined,
					);
					const axisAngle =
						member(rotationObject, "axis") !== undefined ||
						member(rotationObject, "angle") !== undefined;
					const form =
						axisAngle && xyz
							? "both"
							: axisAngle
								? "axis-angle"
								: xyz
									? "xyz"
									: "invalid";
					const xValue = number(member(rotationObject, "x"));
					const yValue = number(member(rotationObject, "y"));
					const zValue = number(member(rotationObject, "z"));
					const rescaleValue = bool(member(rotationObject, "rescale"));
					rotation = {
						form,
						...(origin === undefined
							? {}
							: { origin: origin as unknown as Vec3 }),
						...(axis === "x" || axis === "y" || axis === "z" ? { axis } : {}),
						...(angle === undefined ? {} : { angle }),
						...(xValue === undefined ? {} : { x: xValue }),
						...(yValue === undefined ? {} : { y: yValue }),
						...(zValue === undefined ? {} : { z: zValue }),
						...(rescaleValue === undefined ? {} : { rescale: rescaleValue }),
					};
				}
			}
			const faceViews: ModelFaceView[] = [];
			const faces = object(member(element, "faces"));
			if (faces !== undefined) {
				for (const face of faces.members) {
					if (
						!(DIRECTIONS as readonly string[]).includes(face.key) ||
						face.value.type !== "object"
					)
						continue;
					const texture = string(member(face.value, "texture"));
					if (texture === undefined) continue;
					const uv = numberVector(member(face.value, "uv"), 4);
					const faceRotation = number(member(face.value, "rotation"));
					const cullface = string(member(face.value, "cullface"));
					const tintindex = number(member(face.value, "tintindex"));
					const texturePointer = jsonPointer([
						"elements",
						index,
						"faces",
						face.key,
						"texture",
					]);
					const textureResolution = validateReferenceValue(
						texture,
						"texture",
						texturePointer,
						findings,
						true,
					)
						? resolveTextureValue(texture, texturePointer)
						: { status: "missing" as const, via: [] };
					if (textureResolution.status === "undefined-variable")
						referenceFinding(
							findings,
							"PACK_BROKEN_REFERENCE",
							"error",
							jsonPointer(["elements", index, "faces", face.key, "texture"]),
							`Texture variable ${texture} is undefined.`,
						);
					if (textureResolution.status === "cycle")
						referenceFinding(
							findings,
							"PACK_REFERENCE_CYCLE",
							"error",
							jsonPointer(["elements", index, "faces", face.key, "texture"]),
							`Texture variable cycle: ${textureResolution.via.join(" -> ")}.`,
						);
					if (
						textureResolution.status === "external" ||
						textureResolution.status === "unresolved"
					)
						addSkip(
							skipped,
							"external-reference",
							textureSkipReason(textureResolution.status),
							texture,
						);
					faceViews.push({
						face: face.key as Direction,
						texture,
						textureResolution,
						...(uv === undefined ? {} : { uv: uv as unknown as Uv4 }),
						rotation: ([0, 90, 180, 270].includes(faceRotation ?? Number.NaN)
							? faceRotation
							: 0) as FaceRotation,
						...(DIRECTIONS.includes(cullface as Direction)
							? { cullface: cullface as Direction }
							: {}),
						...(tintindex === undefined ? {} : { tintindex }),
					});
				}
			}
			faceViews.sort(
				(a, b) => DIRECTIONS.indexOf(a.face) - DIRECTIONS.indexOf(b.face),
			);
			elementViews.push({
				index,
				...(name === undefined ? {} : { name }),
				from: from as unknown as Vec3,
				to: to as unknown as Vec3,
				size: [to[0] - from[0], to[1] - from[1], to[2] - from[2]],
				...(rotation === undefined ? {} : { rotation }),
				...(bool(member(element, "shade")) === undefined
					? {}
					: { shade: bool(member(element, "shade")) as boolean }),
				...(DIRECTIONS.includes(
					string(member(element, "shade_direction_override")) as Direction,
				)
					? {
							shadeDirectionOverride: string(
								member(element, "shade_direction_override"),
							) as Direction,
						}
					: {}),
				...(number(member(element, "light_emission")) === undefined
					? {}
					: {
							lightEmission: number(
								member(element, "light_emission"),
							) as number,
						}),
				faces: faceViews,
			});
		}
	}

	const properties: {
		ambientocclusion?: boolean;
		guiLight?: "front" | "side";
	} = {};
	for (const document of documents) {
		if (properties.ambientocclusion === undefined) {
			const value = bool(member(document.root, "ambientocclusion"));
			if (value !== undefined) properties.ambientocclusion = value;
		}
		if (properties.guiLight === undefined) {
			const value = string(member(document.root, "gui_light"));
			if (value === "front" || value === "side") properties.guiLight = value;
		}
	}
	const displayEntries = new Map<string, { node: JsonNode; from: string }>();
	for (const document of documents) {
		const display = object(member(document.root, "display"));
		if (display === undefined) continue;
		for (const position of display.members)
			if (!displayEntries.has(position.key))
				displayEntries.set(position.key, {
					node: position.value,
					from: document.source === "own" ? "own" : document.id,
				});
	}
	const displays: ModelInspectReport["display"][number][] = [];
	for (const position of [...DISPLAY_POSITIONS].sort(byteCompare)) {
		const entry = displayEntries.get(position);
		if (entry === undefined) continue;
		const values = object(entry.node);
		if (values === undefined) continue;
		const rotation = numberVector(member(values, "rotation"), 3);
		const translation = numberVector(member(values, "translation"), 3);
		const scale = numberVector(member(values, "scale"), 3);
		displays.push({
			position,
			from: entry.from,
			...(rotation === undefined
				? {}
				: { rotation: rotation as unknown as Vec3 }),
			...(translation === undefined
				? {}
				: { translation: translation as unknown as Vec3 }),
			...(scale === undefined ? {} : { scale: scale as unknown as Vec3 }),
		});
	}

	const preservedUnknown = [
		...new Set(
			skipped
				.filter((entry) => entry.kind === "model-unknown-field")
				.map((entry) => entry.target.slice(options.path.length + 1)),
		),
	].sort(byteCompare);
	findings.sort(
		(a, b) =>
			byteCompare(a.pointer, b.pointer) ||
			byteCompare(a.code, b.code) ||
			byteCompare(a.message, b.message),
	);
	skipped.sort(
		(a, b) =>
			byteCompare(a.kind, b.kind) ||
			byteCompare(a.target, b.target) ||
			byteCompare(a.reason, b.reason),
	);
	const coverage: ModelCoverage = {
		status: skipped.length === 0 ? "complete" : "partial",
		skipped,
	};
	const report: ModelInspectReport = {
		command: "model",
		mode: "inspect",
		path: options.path,
		...(options.modelId === undefined ? {} : { modelId: options.modelId }),
		kind: kindFromPath(options.path),
		target,
		version,
		verdict: findings.some((finding) => finding.level === "error")
			? "fail"
			: "pass",
		findings,
		coverage,
		...(parentReport === undefined ? {} : { parent: parentReport }),
		parentChain,
		properties,
		textures: textureReports,
		inheritedTextures,
		elements: elementViews,
		elementsSource,
		display: displays,
		preservedUnknown,
		summary: {
			elementCount: elementViews.length,
			faceCount: elementViews.reduce(
				(total, element) => total + element.faces.length,
				0,
			),
			textureCount: textureReports.length,
		},
	};
	return { root, report };
}

export async function inspectModel(
	text: string,
	options: ModelAnalyzeOptions,
): Promise<ModelInspectReport> {
	return (await analyze(text, options)).report;
}
export async function validateModel(
	text: string,
	options: ModelAnalyzeOptions,
): Promise<ModelValidateReport> {
	const report = (await analyze(text, options)).report;
	return {
		command: "model",
		mode: "validate",
		path: report.path,
		target: report.target,
		version: report.version,
		verdict: report.verdict,
		findings: report.findings,
		coverage: report.coverage,
	};
}
