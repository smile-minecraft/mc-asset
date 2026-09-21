import { parseResourceLocation } from "./resource-location.ts";

/**
 * Resource reference graph: blockstates and item definitions as entries,
 * model parent chains and texture variables as edges, textures as leaves.
 * Pure and read-only: every function runs over already-parsed JSON docs,
 * never touches the disk, and stays integer-only with byte-ordered output.
 */

export type ReferenceKind = "parent" | "textures" | "blockstate" | "item-model";

export type ReferenceStatus = "resolved" | "unresolved" | "missing";

export interface ReferenceEdge {
	sourceFile: string;
	fieldPath: string;
	target: string;
	status: ReferenceStatus;
	sourceLayer?: string | undefined;
	kind: ReferenceKind;
}

export interface BlockstateRef {
	fieldPath: string;
	value: unknown;
}

export interface BlockstateBroken {
	fieldPath: string;
	reason: string;
}

export interface ItemRef {
	fieldPath: string;
	value: unknown;
}

export interface ItemSkip {
	kind: "item-model-node" | "item-model-special";
	reason: "unknown-node-type" | "renderer-fields-not-interpreted";
	fieldPath: string;
	rawType: string;
}

export interface ModelUsage {
	items: boolean;
	blockstates: boolean;
}

const encoder = new TextEncoder();

function compareBytes(a: string, b: string): number {
	const ab = encoder.encode(a);
	const bb = encoder.encode(b);
	const end = ab.length < bb.length ? ab.length : bb.length;
	for (let i = 0; i < end; i += 1) {
		const x = ab[i] as number;
		const y = bb[i] as number;
		if (x !== y) {
			return x - y;
		}
	}
	return ab.length - bb.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Model rel for a model resource location value, undefined when unparsable. */
export function modelRelForValue(value: string): string | undefined {
	if (typeof value !== "string" || value.trim() === "") {
		return undefined;
	}
	try {
		const parsed = parseResourceLocation(value);
		if (parsed.namespace === "" || parsed.path === "") {
			return undefined;
		}
		const leaf = parsed.path.endsWith(".json")
			? parsed.path
			: `${parsed.path}.json`;
		return `assets/${parsed.namespace}/models/${leaf}`;
	} catch {
		return undefined;
	}
}

/** Parent target rel for a parent value, undefined when not a model path. */
export function parentRelForValue(value: unknown): string | undefined {
	if (typeof value !== "string" || value.trim() === "") {
		return undefined;
	}
	if (value.toLowerCase().endsWith(".png")) {
		return undefined;
	}
	return modelRelForValue(value);
}

function quoteKey(key: string): string {
	return `variants["${key}"]`;
}

function handleBlockstateEntry(
	entry: unknown,
	basePath: string,
	refs: BlockstateRef[],
	broken: BlockstateBroken[],
): void {
	if (!isRecord(entry)) {
		broken.push({
			fieldPath: basePath,
			reason: "entry is not an object",
		});
		return;
	}
	if (!("model" in entry) || entry.model === undefined) {
		return;
	}
	const fieldPath = `${basePath}.model`;
	if (typeof entry.model !== "string" || entry.model.trim() === "") {
		broken.push({
			fieldPath,
			reason: "model field is not a usable resource location",
		});
		return;
	}
	refs.push({ fieldPath, value: entry.model });
}

/**
 * Blockstate model references (`assets/<namespace>/blockstates/*.json`).
 * `variants` maps each state key onto one entry or an entry array;
 * `multipart` is an array whose elements carry `apply` as one entry or an
 * entry array. Anything else shaped is broken, never skipped silently.
 */
export function collectBlockstateModelRefs(doc: unknown): {
	refs: BlockstateRef[];
	broken: BlockstateBroken[];
} {
	const refs: BlockstateRef[] = [];
	const broken: BlockstateBroken[] = [];
	if (!isRecord(doc)) {
		broken.push({ fieldPath: "", reason: "document is not an object" });
		return { refs, broken };
	}
	const variants = doc.variants;
	if (variants !== undefined) {
		if (!isRecord(variants)) {
			broken.push({
				fieldPath: "variants",
				reason: "variants section is not an object",
			});
		} else {
			const keys = Object.keys(variants).sort(compareBytes);
			for (const key of keys) {
				const base = quoteKey(key);
				const value = (variants as Record<string, unknown>)[key];
				if (isRecord(value)) {
					handleBlockstateEntry(value, base, refs, broken);
				} else if (Array.isArray(value)) {
					for (let index = 0; index < value.length; index += 1) {
						handleBlockstateEntry(
							value[index],
							`${base}[${index}]`,
							refs,
							broken,
						);
					}
				} else {
					broken.push({
						fieldPath: base,
						reason: "variant value is neither an entry nor an entry array",
					});
				}
			}
		}
	}
	const multipart = doc.multipart;
	if (multipart !== undefined) {
		if (!Array.isArray(multipart)) {
			broken.push({
				fieldPath: "multipart",
				reason: "multipart section is not an array",
			});
		} else {
			for (let index = 0; index < multipart.length; index += 1) {
				const element = multipart[index];
				const base = `multipart[${index}]`;
				if (!isRecord(element)) {
					broken.push({
						fieldPath: base,
						reason: "multipart element is not an object",
					});
					continue;
				}
				const apply = (element as Record<string, unknown>).apply;
				if (apply === undefined) {
					broken.push({
						fieldPath: `${base}.apply`,
						reason: "multipart element has no usable apply field",
					});
					continue;
				}
				if (isRecord(apply)) {
					handleBlockstateEntry(apply, `${base}.apply`, refs, broken);
				} else if (Array.isArray(apply)) {
					for (let j = 0; j < apply.length; j += 1) {
						handleBlockstateEntry(
							apply[j],
							`${base}.apply[${j}]`,
							refs,
							broken,
						);
					}
				} else {
					broken.push({
						fieldPath: `${base}.apply`,
						reason: "apply value is neither an entry nor an entry array",
					});
				}
			}
		}
	}
	return { refs, broken };
}

const KNOWN_ITEM_NODES: ReadonlySet<string> = new Set([
	"model",
	"composite",
	"condition",
	"select",
	"range_dispatch",
	"empty",
	"bundle/selected_item",
	"special",
]);

function splitItemType(raw: string): { namespace: string; name: string } {
	const cut = raw.indexOf(":");
	if (cut < 0) {
		return { namespace: "", name: raw };
	}
	return {
		namespace: raw.slice(0, cut),
		name: raw.slice(cut + 1),
	};
}

function walkItemNode(
	node: unknown,
	path: string,
	refs: ItemRef[],
	skips: ItemSkip[],
): void {
	if (typeof node === "string") {
		if (node.trim() !== "" && !node.startsWith("#")) {
			refs.push({ fieldPath: path, value: node });
		}
		return;
	}
	if (!isRecord(node)) {
		return;
	}
	const rawType = node.type;
	if (typeof rawType !== "string" || rawType.trim() === "") {
		skips.push({
			kind: "item-model-node",
			reason: "unknown-node-type",
			fieldPath: path,
			rawType:
				typeof rawType === "string" && rawType !== "" ? rawType : "(missing)",
		});
		return;
	}
	const split = splitItemType(rawType);
	if (split.namespace !== "" && split.namespace !== "minecraft") {
		skips.push({
			kind: "item-model-node",
			reason: "unknown-node-type",
			fieldPath: path,
			rawType,
		});
		return;
	}
	if (!KNOWN_ITEM_NODES.has(split.name)) {
		skips.push({
			kind: "item-model-node",
			reason: "unknown-node-type",
			fieldPath: path,
			rawType,
		});
		return;
	}
	switch (split.name) {
		case "model": {
			walkItemNode(node.model, `${path}.model`, refs, skips);
			return;
		}
		case "composite": {
			const models = node.models;
			if (Array.isArray(models)) {
				for (let index = 0; index < models.length; index += 1) {
					walkItemNode(models[index], `${path}.models[${index}]`, refs, skips);
				}
			}
			return;
		}
		case "condition": {
			walkItemNode(node.on_true, `${path}.on_true`, refs, skips);
			walkItemNode(node.on_false, `${path}.on_false`, refs, skips);
			return;
		}
		case "select": {
			const cases = node.cases;
			if (Array.isArray(cases)) {
				for (let index = 0; index < cases.length; index += 1) {
					const entry = cases[index];
					if (isRecord(entry)) {
						walkItemNode(
							(entry as Record<string, unknown>).model,
							`${path}.cases[${index}].model`,
							refs,
							skips,
						);
					}
				}
			}
			walkItemNode(node.fallback, `${path}.fallback`, refs, skips);
			return;
		}
		case "range_dispatch": {
			const entries = node.entries;
			if (Array.isArray(entries)) {
				for (let index = 0; index < entries.length; index += 1) {
					const entry = entries[index];
					if (isRecord(entry)) {
						walkItemNode(
							(entry as Record<string, unknown>).model,
							`${path}.entries[${index}].model`,
							refs,
							skips,
						);
					}
				}
			}
			walkItemNode(node.fallback, `${path}.fallback`, refs, skips);
			return;
		}
		case "special": {
			if ("base" in node) {
				refs.push({ fieldPath: `${path}.base`, value: node.base });
			}
			skips.push({
				kind: "item-model-special",
				reason: "renderer-fields-not-interpreted",
				fieldPath: path,
				rawType,
			});
			return;
		}
		default: {
			return;
		}
	}
}

/**
 * Item model tree references under an items definition `model` field.
 * Only `minecraft` (or missing) namespaces run vanilla semantics; foreign
 * namespaces and unknown types become coverage skips, never accusations.
 * Tag (`#`) leaves stay silent. `special` contributes its `base` model
 * reference plus one renderer-fields skip; nested renderer fields are
 * never interpreted.
 */
export function collectItemModelRefs(modelNode: unknown): {
	refs: ItemRef[];
	skips: ItemSkip[];
} {
	const refs: ItemRef[] = [];
	const skips: ItemSkip[] = [];
	if (modelNode === undefined) {
		return { refs, skips };
	}
	walkItemNode(modelNode, "model", refs, skips);
	return { refs, skips };
}

export interface ModelDocView {
	textures: Record<string, unknown>;
	parent: unknown;
}

export type VariableResolution =
	| { status: "resolved"; value: string; chain: string[] }
	| { status: "cycle"; chain: string[] }
	| { status: "not-found"; chain: string[] }
	| { status: "external"; chain: string[]; exitRel: string };

/**
 * Texture variable resolution: `#name` looks at the model's own
 * `textures` first, then walks up the parent chain. A `#other` definition
 * re-resolves from the same model. Cycles report their chain; leaving the
 * known docs reports external so the caller skips instead of accusing.
 */
export function resolveTextureVariable(
	docs: Map<string, ModelDocView>,
	startRel: string,
	variable: string,
): VariableResolution {
	const chain: string[] = [];
	const visited = new Set<string>();
	let currentRel = startRel;
	let currentVar = variable;
	// Termination rests on visited alone: every step records one
	// (model, variable) key from a finite set, so a revisit is exactly a
	// cycle and a fresh key always makes progress. No step budget is used
	// here because alias chains inside one model can run longer than any
	// doc-count bound.
	for (;;) {
		const key = `${currentRel}\u0000${currentVar}`;
		if (visited.has(key)) {
			return { status: "cycle", chain: [...chain, key] };
		}
		visited.add(key);
		chain.push(`${currentRel}#${currentVar}`);
		const doc = docs.get(currentRel);
		if (doc === undefined) {
			return { status: "external", chain, exitRel: currentRel };
		}
		const raw = doc.textures[currentVar];
		if (raw !== undefined) {
			if (typeof raw !== "string" || raw.trim() === "") {
				return { status: "not-found", chain };
			}
			if (!raw.startsWith("#")) {
				return { status: "resolved", value: raw, chain };
			}
			const next = raw.slice(1);
			if (next === "") {
				return { status: "not-found", chain };
			}
			currentVar = next;
			continue;
		}
		const parentRel = parentRelForValue(doc.parent);
		if (parentRel === undefined) {
			return { status: "not-found", chain };
		}
		if (!docs.has(parentRel)) {
			return { status: "external", chain, exitRel: parentRel };
		}
		currentRel = parentRel;
	}
}

export interface TextureVariableExternalDiagnosis {
	message: string;
	reason: "model-documents-not-loaded";
	target: string;
}

/**
 * Neutral diagnosis for a texture variable that leaves the current pack's
 * model documents: dependency and vanilla documents are never loaded for
 * variable resolution by design, so the reference skips with the exit rel
 * as its target instead of blaming the vanilla tree.
 */
export function diagnoseTextureVariableExternal(
	field: string,
	value: string,
	firstRel: string,
	exitRel: string,
): TextureVariableExternalDiagnosis {
	return {
		message: `"${field}" "${value}" in "${firstRel}" leaves the current pack's model documents at "${exitRel}"; dependency and vanilla model documents are not loaded for texture-variable resolution, so the reference is skipped.`,
		reason: "model-documents-not-loaded",
		target: exitRel,
	};
}

/**
 * Parent cycles over already-known model docs: only edges whose target is
 * also a known doc can form a detectable cycle. Each cycle lists its rels
 * in visit order, closed by repeating the entry rel.
 */
export function findParentCycles(
	parentOf: Map<string, string | undefined>,
): string[][] {
	const cycles: string[][] = [];
	const seen = new Set<string>();
	const visiting = new Set<string>();
	const stack: string[] = [];
	function visit(rel: string): void {
		if (visiting.has(rel)) {
			const at = stack.indexOf(rel);
			const body = at < 0 ? [rel] : stack.slice(at);
			const closed = [...body, rel];
			const key = [...closed].sort(compareBytes).join("\u0000");
			if (!seen.has(key)) {
				seen.add(key);
				cycles.push(closed);
			}
			return;
		}
		if (seen.has(`node\u0000${rel}`)) {
			return;
		}
		visiting.add(rel);
		stack.push(rel);
		const next = parentOf.get(rel);
		if (next !== undefined && parentOf.has(next)) {
			visit(next);
		}
		stack.pop();
		visiting.delete(rel);
		seen.add(`node\u0000${rel}`);
	}
	const rels = [...parentOf.keys()].sort(compareBytes);
	for (const rel of rels) {
		visit(rel);
	}
	return cycles;
}

/**
 * Entry reachability over model parent edges: blockstate and item entries
 * mark their target models, then usage flows up the parent chain so a
 * shared parent inherits every usage that reaches it.
 */
export function computeModelReachability(
	parentOf: Map<string, string | undefined>,
	blockEntries: string[],
	itemEntries: string[],
): Map<string, ModelUsage> {
	const usage = new Map<string, ModelUsage>();
	const queue: string[] = [];
	function mark(rel: string, next: ModelUsage): void {
		const current = usage.get(rel) ?? { items: false, blockstates: false };
		const merged: ModelUsage = {
			items: current.items || next.items,
			blockstates: current.blockstates || next.blockstates,
		};
		const changed =
			merged.items !== current.items ||
			merged.blockstates !== current.blockstates;
		usage.set(rel, merged);
		if (changed) {
			queue.push(rel);
		} else if (!queue.includes(rel) && !merged.items && !merged.blockstates) {
			queue.push(rel);
		}
	}
	for (const rel of blockEntries) {
		if (parentOf.has(rel)) {
			mark(rel, { items: false, blockstates: true });
		}
	}
	for (const rel of itemEntries) {
		if (parentOf.has(rel)) {
			mark(rel, { items: true, blockstates: false });
		}
	}
	while (queue.length > 0) {
		const rel = queue.shift() as string;
		const current = usage.get(rel);
		if (current === undefined) {
			continue;
		}
		const parent = parentOf.get(rel);
		if (parent === undefined || !parentOf.has(parent)) {
			continue;
		}
		mark(parent, current);
	}
	return usage;
}
