import { parseResourceLocation } from "./resource-location.ts";

/**
 * Atlas sources parsing (starter). Read-only over already-parsed pack JSON
 * documents: every `assets/<namespace>/atlases/*.json` file contributes the
 * texture set its `sources` stitch into the atlas named after the file stem
 * (`blocks.json` defines the `blocks` atlas).
 *
 * Starter coverage is deliberately narrow so no schema is invented:
 * - `directory` contributes same-namespace textures under its `source`
 *   prefix (`prefix` only renames sprites, so it never affects membership).
 * - `single` contributes the one texture its `resource` points at.
 * - Every other source type (including `filter` and
 *   `paletted_permutations`, whose exclusion and permutation semantics have
 *   no in-repo source) contributes nothing: the source is skipped and its
 *   type is reported back in `unknownSourceTypes` instead of guessed.
 *
 * An atlas with any skipped source is `complete: false`, and coverage
 * queries against a missing or incomplete atlas answer `unknown` so the
 * caller skips the verdict instead of accusing on partial knowledge.
 */

export interface AtlasPolicy {
	itemAtlas: string;
	blockAtlas: string;
}

interface AtlasRules {
	singleTextures: Set<string>;
	directoryPrefixes: Map<string, string[]>;
	complete: boolean;
}

export interface AtlasParseResult {
	atlases: Map<string, AtlasRules>;
	unknownSourceTypes: string[];
}

export type AtlasCoverage = "covered" | "not-covered" | "unknown";

const KNOWN_SOURCE_TYPES: ReadonlySet<string> = new Set([
	"directory",
	"single",
]);

const MISSING_TYPE_BUCKET = "(missing)";

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

function splitNamespace(
	rel: string,
): { namespace: string; rest: string } | undefined {
	if (!rel.startsWith("assets/")) {
		return undefined;
	}
	const inner = rel.slice("assets/".length);
	const cut = inner.indexOf("/");
	if (cut < 0) {
		return undefined;
	}
	return {
		namespace: inner.slice(0, cut),
		rest: inner.slice(cut + 1),
	};
}

/** File stem of `assets/<namespace>/atlases/<name>.json`, if shaped so. */
function atlasNameOf(
	rel: string,
): { namespace: string; name: string } | undefined {
	const split = splitNamespace(rel);
	if (split === undefined || split.namespace === "") {
		return undefined;
	}
	if (!split.rest.startsWith("atlases/")) {
		return undefined;
	}
	const leaf = split.rest.slice("atlases/".length);
	if (leaf === "" || leaf.includes("/")) {
		return undefined;
	}
	if (!leaf.toLowerCase().endsWith(".json")) {
		return undefined;
	}
	const name = leaf.slice(0, -".json".length);
	if (name === "") {
		return undefined;
	}
	return { namespace: split.namespace, name };
}

function normalizeDirectorySource(source: string): string | undefined {
	let out = source;
	while (out.startsWith("/")) {
		out = out.slice(1);
	}
	while (out.endsWith("/") && out !== "") {
		out = out.slice(0, -1);
	}
	if (out === "") {
		return "";
	}
	// Cross-namespace directory sources have no in-repo meaning here;
	// skipping them beats inventing one.
	if (out.includes(":")) {
		return undefined;
	}
	return out;
}

function textureRelForResource(value: string): string | undefined {
	if (typeof value !== "string" || value.trim() === "") {
		return undefined;
	}
	const parsed = parseResourceLocation(value);
	if (parsed.namespace === "" || parsed.path === "") {
		return undefined;
	}
	const leaf =
		parsed.path.lastIndexOf(".") < 0 ? `${parsed.path}.png` : parsed.path;
	return `assets/${parsed.namespace}/textures/${leaf}`;
}

/**
 * Parse every atlas definition found in already-parsed pack documents.
 * Keys are read in byte order, so reruns over the same tree agree.
 */
export function parseAtlasDefinitions(
	docs: Map<string, unknown>,
): AtlasParseResult {
	const atlases = new Map<string, AtlasRules>();
	const unknownTypes = new Set<string>();
	const rels = [...docs.keys()].sort(compareBytes);
	for (const rel of rels) {
		const atlas = atlasNameOf(rel);
		if (atlas === undefined) {
			continue;
		}
		let rules = atlases.get(atlas.name);
		if (rules === undefined) {
			rules = {
				singleTextures: new Set(),
				directoryPrefixes: new Map(),
				complete: true,
			};
			atlases.set(atlas.name, rules);
		}
		const skip = (type: unknown): void => {
			rules.complete = false;
			unknownTypes.add(typeof type === "string" ? type : MISSING_TYPE_BUCKET);
		};
		const doc = docs.get(rel);
		if (!isRecord(doc) || !Array.isArray(doc.sources)) {
			// Unparseable JSON never reaches here (it becomes a
			// PACK_INVALID_JSON finding and stays out of `docs`); a parsed
			// document without a `sources` array is simply unusable.
			rules.complete = false;
			continue;
		}
		for (const source of doc.sources) {
			if (!isRecord(source)) {
				skip(undefined);
				continue;
			}
			if (
				typeof source.type !== "string" ||
				!KNOWN_SOURCE_TYPES.has(source.type)
			) {
				skip(source.type);
				continue;
			}
			if (source.type === "directory") {
				if (typeof source.source !== "string") {
					skip(source.type);
					continue;
				}
				const normalized = normalizeDirectorySource(source.source);
				if (normalized === undefined) {
					skip(source.type);
					continue;
				}
				const prefix = normalized === "" ? "" : `${normalized}/`;
				const known = rules.directoryPrefixes.get(atlas.namespace) ?? [];
				known.push(prefix);
				rules.directoryPrefixes.set(atlas.namespace, known);
				continue;
			}
			const target = textureRelForResource(
				source.resource as unknown as string,
			);
			if (target === undefined) {
				skip(source.type);
				continue;
			}
			rules.singleTextures.add(target);
		}
	}
	return {
		atlases,
		unknownSourceTypes: [...unknownTypes].sort(compareBytes),
	};
}

/**
 * Required atlas for one model file. `block` and `item` are pack-layout
 * kinds (the §54 Block Model / Item Model split); the atlas names
 * themselves always arrive through `policy`, never hardcoded here.
 */
export function requiredAtlasForModel(
	modelRel: string,
	policy: AtlasPolicy,
): string | undefined {
	const split = splitNamespace(modelRel);
	if (split === undefined || !split.rest.startsWith("models/")) {
		return undefined;
	}
	const kind = split.rest.slice("models/".length).split("/")[0];
	if (kind === "block") {
		return policy.blockAtlas;
	}
	if (kind === "item") {
		return policy.itemAtlas;
	}
	return undefined;
}

/**
 * Tri-state membership: `unknown` means the atlas is undefined or was
 * built from partially understood sources, and the caller must skip the
 * verdict rather than accuse.
 */
export function atlasCoverageFor(
	result: AtlasParseResult,
	atlasName: string,
	textureRel: string,
): AtlasCoverage {
	const rules = result.atlases.get(atlasName);
	if (rules === undefined || !rules.complete) {
		return "unknown";
	}
	if (rules.singleTextures.has(textureRel)) {
		return "covered";
	}
	const split = splitNamespace(textureRel);
	if (split === undefined || !split.rest.startsWith("textures/")) {
		return "not-covered";
	}
	const local = split.rest.slice("textures/".length);
	const prefixes = rules.directoryPrefixes.get(split.namespace) ?? [];
	for (const prefix of prefixes) {
		if (prefix === "" || local.startsWith(prefix)) {
			return "covered";
		}
	}
	return "not-covered";
}
