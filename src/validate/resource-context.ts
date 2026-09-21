import { readdir } from "node:fs/promises";
import { McAssetError } from "../core/errors.ts";
import { isBuiltinModel } from "../profiles/builtin-models.ts";
import { parseResourceLocation } from "./resource-location.ts";

/**
 * Shared resource resolution context for pack validation. One ordered stack
 * of file layers plus the builtin registry answers "where does this model
 * or texture reference live": the current pack first, then each caller
 * supplied dependency pack in provision order, then the caller supplied
 * vanilla tree, then the builtin model registry. Pure and read-only once
 * the layer indexes exist; only the async index builder touches the disk,
 * and it reads the same assets/** plus optional root pack.mcmeta shape as
 * the pack scan, never writing and never inventing paths.
 */

export type ResolutionKind = "model" | "texture";

export type ResolutionSource =
	| "current"
	| `dependency:${number}`
	| "vanilla"
	| "builtin";

export type ResolutionStatus = "resolved" | "unresolved" | "missing";

export interface ResolutionResult {
	resourceLocation: string;
	kind: ResolutionKind;
	source?: ResolutionSource | undefined;
	target?: string | undefined;
	status: ResolutionStatus;
	reason?: string | undefined;
}

export interface LayerIndex {
	files: Set<string>;
	folded: Map<string, string>;
}

export interface ResourceContext {
	current: LayerIndex;
	dependencies: LayerIndex[];
	vanilla?: LayerIndex | undefined;
	hasVanilla: boolean;
}

/** Unresolved means the caller gave no vanilla tree to check against. */
export const UNRESOLVED_REASON = "vanilla-not-provided";

/** Determined miss after every provided layer came up empty. */
export const MISSING_REASON = "not-found";

/** Same scan ceiling as the pack engine: an absurd tree is exit 5. */
const MAX_LAYER_FILES = 50000;

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

/** Pure index over already-enumerated rel paths; first spelling wins folds. */
export function layerIndexFromRels(rels: string[]): LayerIndex {
	const files = new Set(rels);
	const folded = new Map<string, string>();
	const sorted = [...rels].sort(compareBytes);
	for (const rel of sorted) {
		const key = rel.toLowerCase();
		if (!folded.has(key)) {
			folded.set(key, rel);
		}
	}
	return { files, folded };
}

async function collectLayerRelPaths(root: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(dirRel: string): Promise<void> {
		const entries = (await readdir(`${root}/${dirRel}`)).sort();
		for (const entry of entries) {
			const rel = dirRel === "" ? entry : `${dirRel}/${entry}`;
			let children: string[] | undefined;
			try {
				children = (await readdir(`${root}/${rel}`)).sort();
			} catch {
				children = undefined;
			}
			if (children !== undefined) {
				await walk(rel);
			} else {
				out.push(rel);
			}
		}
	}
	try {
		await walk("assets");
	} catch {
		throw new McAssetError(
			`FILESYSTEM_ERROR`,
			`Cannot read pack root: ${root}.`,
			{
				path: root,
			},
		);
	}
	out.sort(compareBytes);
	if (out.length > MAX_LAYER_FILES) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			`Pack holds ${out.length} files, above the scan limit of ${MAX_LAYER_FILES}.`,
			{ files: out.length, limit: MAX_LAYER_FILES },
		);
	}
	return out;
}

/**
 * Read-only index of one file layer (current pack, one dependency, or the
 * vanilla tree). An unreadable root is FILESYSTEM_ERROR, never an empty
 * layer, so a typoed --vanilla or --dependency path cannot silently
 * resolve everything to unresolved.
 */
export async function buildLayerIndex(root: string): Promise<LayerIndex> {
	return layerIndexFromRels(await collectLayerRelPaths(root));
}

export function createResourceContext(
	current: LayerIndex,
	dependencies?: LayerIndex[],
	vanilla?: LayerIndex | undefined,
): ResourceContext {
	return {
		current,
		dependencies: dependencies === undefined ? [] : [...dependencies],
		...(vanilla === undefined ? {} : { vanilla }),
		hasVanilla: vanilla !== undefined,
	};
}

function modelRelFor(namespace: string, path: string): string {
	const leaf = path.endsWith(".json") ? path : `${path}.json`;
	return `assets/${namespace}/models/${leaf}`;
}

function textureRelFor(namespace: string, path: string): string {
	const cut = path.lastIndexOf(".");
	const leaf = cut < 0 ? `${path}.png` : path;
	return `assets/${namespace}/textures/${leaf}`;
}

function orderedLayers(context: ResourceContext): Array<{
	source: ResolutionSource;
	index: LayerIndex;
}> {
	const layers: Array<{ source: ResolutionSource; index: LayerIndex }> = [
		{ source: "current", index: context.current },
	];
	context.dependencies.forEach((index, position) => {
		layers.push({ source: `dependency:${position}`, index });
	});
	if (context.vanilla !== undefined) {
		layers.push({ source: "vanilla", index: context.vanilla });
	}
	return layers;
}

function resolveReference(
	context: ResourceContext,
	kind: ResolutionKind,
	value: string,
): ResolutionResult {
	const parsed = parseResourceLocation(value);
	const resourceLocation = value;
	const rel =
		kind === "model"
			? modelRelFor(parsed.namespace, parsed.path)
			: textureRelFor(parsed.namespace, parsed.path);
	for (const layer of orderedLayers(context)) {
		if (layer.index.files.has(rel)) {
			return {
				resourceLocation,
				kind,
				source: layer.source,
				target: rel,
				status: "resolved",
			};
		}
	}
	if (
		kind === "model" &&
		isBuiltinModel(`${parsed.namespace}:${parsed.path}`)
	) {
		return {
			resourceLocation,
			kind,
			source: "builtin",
			target: `${parsed.namespace}:${parsed.path}`,
			status: "resolved",
		};
	}
	if (parsed.namespace === "minecraft" && !context.hasVanilla) {
		return {
			resourceLocation,
			kind,
			status: "unresolved",
			reason: UNRESOLVED_REASON,
		};
	}
	return {
		resourceLocation,
		kind,
		status: "missing",
		reason: MISSING_REASON,
	};
}

/** Model reference (parent chains, item definitions) across every layer. */
export function resolveModelReference(
	context: ResourceContext,
	value: string,
): ResolutionResult {
	return resolveReference(context, "model", value);
}

/** Texture reference (model textures sections) across every layer. */
export function resolveTextureReference(
	context: ResourceContext,
	value: string,
): ResolutionResult {
	return resolveReference(context, "texture", value);
}

/**
 * Case-only variant search across every layer in priority order: the first
 * layer holding a folded spelling wins, so current beats dependency zero
 * and dependency zero beats vanilla. Answers undefined when no layer
 * holds any spelling; exact hits never reach this helper.
 */
export function findCaseVariant(
	context: ResourceContext,
	kind: ResolutionKind,
	value: string,
): { source: ResolutionSource; target: string } | undefined {
	const parsed = parseResourceLocation(value);
	const rel =
		kind === "model"
			? modelRelFor(parsed.namespace, parsed.path)
			: textureRelFor(parsed.namespace, parsed.path);
	const key = rel.toLowerCase();
	for (const layer of orderedLayers(context)) {
		const hit = layer.index.folded.get(key);
		if (hit !== undefined) {
			return { source: layer.source, target: hit };
		}
	}
	return undefined;
}
