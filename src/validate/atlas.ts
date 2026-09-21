import {
	ATLAS_PALETTE_ROOT_FACT,
	ATLAS_SEPARATOR_FACT,
	isFactActive,
} from "../profiles/versions.ts";
import { parseResourceLocation } from "./resource-location.ts";

/**
 * Atlas sprite sources, executed read-only over already-parsed pack JSON
 * documents plus the file lists of the same layers. Every
 * `assets/<namespace>/atlases/*.json` file contributes the sprite set its
 * `sources` stitch into the atlas named after the file stem (`blocks.json`
 * defines the `blocks` atlas).
 *
 * The map is sprite centered (`sprite id` onto an entity picture or a
 * generated source). Layers merge in load order (vanilla, reversed
 * dependencies, current pack); files run in byte order and each file's
 * `sources` run in definition order, adding or removing sprites:
 * - `directory` maps every visible `textures/<source>/` picture onto
 *   `prefix` plus its relative path, keeping the picture's own namespace.
 * - `single` maps one `resource` onto its optional `sprite` (defaulting to
 *   the resource itself).
 * - `filter` removes the sprites its nested `pattern` matches, with the
 *   game matcher (`find`, substring semantics) per field.
 * - `paletted_permutations` generates one sprite per texture and
 *   permutation key; its separator and palette root follow their version
 *   gates, and unconfirmable base or palette files stay unknown.
 * - `unstitch` and unknown types are never guessed.
 *
 * Coverage is tri-state: `covered` after a complete run holds the sprite,
 * `not-covered` after a complete run confirms its absence, and `unknown`
 * marks source, regex, dependency, or context gaps, each with its
 * diagnosis. Callers skip verdicts on `unknown` instead of accusing.
 */

export interface AtlasPolicy {
	itemAtlas: string;
	blockAtlas: string;
}

export type AtlasCoverage = "covered" | "not-covered" | "unknown";

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
export function atlasNameOf(
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

function normalizeDirectorySource(source: unknown): string | undefined {
	if (typeof source !== "string") {
		return undefined;
	}
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
	// Namespaced directory sources single out one foreign tree; the engine
	// searches every visible namespace instead, so they stay uninterpreted.
	if (out.includes(":")) {
		return undefined;
	}
	return out;
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
 * Sprite-centered execution model. One ordered layer stack carries
 * already-parsed atlas documents plus the file list of the same layer,
 * from the lowest priority layer (vanilla) through reversed dependencies
 * up to the current pack. Every `assets/<namespace>/atlases/*.json` file
 * contributes the sprite set its `sources` stitch into the atlas named
 * after the file stem, executed file by file in byte order and source by
 * source in definition order.
 */

export interface AtlasLayerInput {
	docs: Map<string, unknown>;
	files: Set<string>;
}

export interface AtlasParseOptions {
	packFormat?: string | undefined;
	hasVanilla?: boolean | undefined;
}

export type AtlasSkipKind = "atlas-source" | "atlas-filter";

export interface AtlasSkip {
	kind: AtlasSkipKind;
	reason: string;
	target: string;
	atlas: string;
	detail?: string | undefined;
}

export interface AtlasSpriteEntry {
	origin: "entity" | "generated";
	entity?: string | undefined;
}

export interface AtlasSpriteRules {
	sprites: Map<string, AtlasSpriteEntry>;
	unknownSprites: Set<string>;
	complete: boolean;
	definitionFiles: string[];
}

export interface AtlasLayersParseResult {
	atlases: Map<string, AtlasSpriteRules>;
	unknownSourceTypes: string[];
	skips: AtlasSkip[];
}

export interface AtlasCoverageDiagnosis {
	status: AtlasCoverage;
	complete: boolean;
	hasDefinitions: boolean;
	unknownSprite: boolean;
}

/** Sprite execution over one ordered layer stack. */
export function parseAtlasLayers(
	layers: AtlasLayerInput[],
	options?: AtlasParseOptions,
): AtlasLayersParseResult {
	const packFormat = options?.packFormat;
	const hasVanilla = options?.hasVanilla ?? false;
	const atlases = new Map<string, MutableAtlasRules>();
	const unknownTypes = new Set<string>();
	const skips: AtlasSkip[] = [];
	const getAtlas = (name: string): MutableAtlasRules => {
		let rules = atlases.get(name);
		if (rules === undefined) {
			rules = {
				sprites: new Map(),
				unknownSprites: new Set(),
				complete: true,
				definitionFiles: [],
			};
			atlases.set(name, rules);
		}
		return rules;
	};
	const noteFile = (rules: MutableAtlasRules, rel: string): void => {
		if (!rules.definitionFiles.includes(rel)) {
			rules.definitionFiles.push(rel);
		}
	};
	layers.forEach((layer) => {
		const rels = [...layer.docs.keys()].sort(compareBytes);
		for (const rel of rels) {
			const atlas = atlasNameOf(rel);
			if (atlas === undefined) {
				continue;
			}
			const rules = getAtlas(atlas.name);
			noteFile(rules, rel);
			const doc = layer.docs.get(rel);
			if (!isRecord(doc) || !Array.isArray(doc.sources)) {
				// Parsed JSON without a `sources` array is unusable: the
				// atlas stays unknown instead of guessed.
				rules.complete = false;
				skips.push({
					kind: "atlas-source",
					reason: "invalid-source",
					target: rel,
					atlas: atlas.name,
					detail: "atlas document has no usable sources array",
				});
				continue;
			}
			const shared: AtlasExecuteShared = {
				rules,
				atlasName: atlas.name,
				rel,
				layers,
				packFormat,
				hasVanilla,
				skips,
				unknownTypes,
				noteFile,
			};
			for (const source of doc.sources) {
				executeAtlasSource(shared, source);
			}
		}
	});
	return {
		atlases,
		unknownSourceTypes: [...unknownTypes].sort(compareBytes),
		skips,
	};
}

/** Sprite lookup over an executed layer stack. */
export function atlasSpriteCoverageFor(
	result: AtlasLayersParseResult,
	atlasName: string,
	spriteId: string,
): AtlasCoverage {
	return atlasCoverageDetail(result, atlasName, spriteId).status;
}

/**
 * Coverage with its diagnosis: `unknown` splits into a missing atlas, a
 * partially understood atlas, or one sprite whose generated dependencies
 * cannot be confirmed. Callers turn every unknown into a coverage skip
 * instead of an accusation.
 */
export function atlasCoverageDetail(
	result: AtlasLayersParseResult,
	atlasName: string,
	spriteId: string,
): AtlasCoverageDiagnosis {
	const rules = result.atlases.get(atlasName);
	if (rules === undefined || rules.definitionFiles.length === 0) {
		return {
			status: "unknown",
			complete: false,
			hasDefinitions: false,
			unknownSprite: false,
		};
	}
	if (!rules.complete) {
		return {
			status: "unknown",
			complete: false,
			hasDefinitions: true,
			unknownSprite: rules.unknownSprites.has(spriteId),
		};
	}
	if (rules.unknownSprites.has(spriteId)) {
		return {
			status: "unknown",
			complete: true,
			hasDefinitions: true,
			unknownSprite: true,
		};
	}
	return {
		status: rules.sprites.has(spriteId) ? "covered" : "not-covered",
		complete: true,
		hasDefinitions: true,
		unknownSprite: false,
	};
}

/**
 * Model texture reference onto its atlas sprite id: the resource location
 * with one trailing `.png` removed. Texture variables have no sprite and
 * answer undefined so the caller skips them.
 */
export function spriteIdForTextureValue(value: string): string | undefined {
	if (
		typeof value !== "string" ||
		value.trim() === "" ||
		value.startsWith("#")
	) {
		return undefined;
	}
	const parsed = parseResourceLocation(value);
	if (parsed.namespace === "" || parsed.path === "") {
		return undefined;
	}
	return `${parsed.namespace}:${stripPngSuffix(parsed.path)}`;
}

interface MutableAtlasRules {
	sprites: Map<string, AtlasSpriteEntry>;
	unknownSprites: Set<string>;
	complete: boolean;
	definitionFiles: string[];
}

interface AtlasExecuteShared {
	rules: MutableAtlasRules;
	atlasName: string;
	rel: string;
	layers: AtlasLayerInput[];
	packFormat: string | undefined;
	hasVanilla: boolean;
	skips: AtlasSkip[];
	unknownTypes: Set<string>;
	noteFile: (rules: MutableAtlasRules, rel: string) => void;
}

function stripPngSuffix(path: string): string {
	return path.toLowerCase().endsWith(".png")
		? path.slice(0, -".png".length)
		: path;
}

function entityRelForResource(value: string): string | undefined {
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

/** Atlas types arrive namespaced (`minecraft:filter`) or bare (`filter`). */
function normalizeSourceType(raw: unknown): string | undefined {
	if (typeof raw !== "string") {
		return undefined;
	}
	const cut = raw.lastIndexOf(":");
	return cut < 0 ? raw : raw.slice(cut + 1);
}

function executeAtlasSource(shared: AtlasExecuteShared, source: unknown): void {
	const skipSource = (
		kind: AtlasSkipKind,
		reason: string,
		detail: string,
	): void => {
		shared.rules.complete = false;
		shared.noteFile(shared.rules, shared.rel);
		shared.skips.push({
			kind,
			reason,
			target: shared.rel,
			atlas: shared.atlasName,
			detail,
		});
	};
	if (!isRecord(source)) {
		shared.unknownTypes.add(MISSING_TYPE_BUCKET);
		skipSource(
			"atlas-source",
			"unsupported-source-type",
			"source entry is not an object",
		);
		return;
	}
	if (typeof source.type !== "string") {
		shared.unknownTypes.add(MISSING_TYPE_BUCKET);
		skipSource(
			"atlas-source",
			"unsupported-source-type",
			"source entry has no type",
		);
		return;
	}
	const type = normalizeSourceType(source.type);
	if (type === "directory") {
		executeDirectorySource(shared, source, skipSource);
		return;
	}
	if (type === "single") {
		executeSingleSource(shared, source, skipSource);
		return;
	}
	if (type === "filter") {
		executeFilterSource(shared, source, skipSource);
		return;
	}
	if (type === "paletted_permutations") {
		executePalettedSource(shared, source, skipSource);
		return;
	}
	// `unstitch` and every unknown type: recorded, never guessed.
	shared.unknownTypes.add(source.type);
	skipSource(
		"atlas-source",
		"unsupported-source-type",
		`source type "${source.type}" is not interpreted`,
	);
}

function executeDirectorySource(
	shared: AtlasExecuteShared,
	source: Record<string, unknown>,
	skipSource: (kind: AtlasSkipKind, reason: string, detail: string) => void,
): void {
	const dirSource = normalizeDirectorySource(source.source);
	const prefix = typeof source.prefix === "string" ? source.prefix : "";
	if (dirSource === undefined) {
		skipSource(
			"atlas-source",
			"invalid-source",
			`directory source has no usable "source" field`,
		);
		return;
	}
	// Every visible layer contributes in load order, so a higher priority
	// layer re-adds the same sprite with its own file as the entity.
	for (const layer of shared.layers) {
		const files = [...layer.files].sort(compareBytes);
		for (const fileRel of files) {
			const sprite = directorySpriteForFile(fileRel, dirSource, prefix);
			if (sprite === undefined) {
				continue;
			}
			shared.rules.sprites.set(sprite, {
				origin: "entity",
				entity: fileRel,
			});
			shared.rules.unknownSprites.delete(sprite);
		}
	}
}

function directorySpriteForFile(
	fileRel: string,
	source: string,
	prefix: string,
): string | undefined {
	const split = splitNamespace(fileRel);
	if (split === undefined || split.namespace === "") {
		return undefined;
	}
	if (!split.rest.startsWith("textures/")) {
		return undefined;
	}
	if (!fileRel.endsWith(".png")) {
		return undefined;
	}
	const local = split.rest.slice("textures/".length);
	const want = source === "" ? "" : `${source}/`;
	if (!local.startsWith(want)) {
		return undefined;
	}
	const relative = local.slice(want.length);
	if (relative === "" || relative.endsWith("/")) {
		return undefined;
	}
	return `${split.namespace}:${prefix}${relative.slice(0, -".png".length)}`;
}

function executeSingleSource(
	shared: AtlasExecuteShared,
	source: Record<string, unknown>,
	skipSource: (kind: AtlasSkipKind, reason: string, detail: string) => void,
): void {
	if (
		typeof source.resource !== "string" ||
		(source.resource as string).trim() === ""
	) {
		skipSource(
			"atlas-source",
			"invalid-source",
			`single source has no usable "resource" field`,
		);
		return;
	}
	let spriteValue = source.resource as string;
	if (source.sprite !== undefined) {
		if (
			typeof source.sprite !== "string" ||
			(source.sprite as string).trim() === ""
		) {
			skipSource(
				"atlas-source",
				"invalid-source",
				`single source has no usable "sprite" field`,
			);
			return;
		}
		spriteValue = source.sprite as string;
	}
	const sprite = spriteIdForTextureValue(spriteValue);
	const entity = entityRelForResource(source.resource as string);
	if (sprite === undefined || entity === undefined) {
		skipSource(
			"atlas-source",
			"invalid-source",
			`single source names no usable resource location`,
		);
		return;
	}
	// Declared sprites join the stitch set; the entity file itself may
	// live in any visible layer, so its existence is not rechecked here.
	shared.rules.sprites.set(sprite, { origin: "entity", entity });
	shared.rules.unknownSprites.delete(sprite);
}

function executeFilterSource(
	shared: AtlasExecuteShared,
	source: Record<string, unknown>,
	skipSource: (kind: AtlasSkipKind, reason: string, detail: string) => void,
): void {
	if (!isRecord(source.pattern)) {
		skipSource(
			"atlas-source",
			"invalid-source",
			`filter source has no usable "pattern" object`,
		);
		return;
	}
	const namespaceRaw = source.pattern.namespace;
	const pathRaw = source.pattern.path;
	if (
		(namespaceRaw !== undefined && typeof namespaceRaw !== "string") ||
		(pathRaw !== undefined && typeof pathRaw !== "string")
	) {
		skipSource(
			"atlas-source",
			"invalid-source",
			`filter source has no usable pattern fields`,
		);
		return;
	}
	let namespaceRe: RegExp | undefined;
	let pathRe: RegExp | undefined;
	if (namespaceRaw !== undefined) {
		namespaceRe = compileAtlasPattern(namespaceRaw);
		if (namespaceRe === undefined) {
			skipSource(
				"atlas-filter",
				"unsupported-regex",
				`filter pattern namespace "${namespaceRaw}" needs a Java-only construct`,
			);
			return;
		}
	}
	if (pathRaw !== undefined) {
		pathRe = compileAtlasPattern(pathRaw);
		if (pathRe === undefined) {
			skipSource(
				"atlas-filter",
				"unsupported-regex",
				`filter pattern path "${pathRaw}" needs a Java-only construct`,
			);
			return;
		}
	}
	// Missing fields match everything; matching follows the game matcher
	// (`find`, substring semantics) in execution order.
	for (const sprite of [...shared.rules.sprites.keys()]) {
		const cut = sprite.indexOf(":");
		const namespace = sprite.slice(0, cut);
		const path = sprite.slice(cut + 1);
		const namespaceHit =
			namespaceRe === undefined ? true : namespaceRe.test(namespace);
		const pathHit = pathRe === undefined ? true : pathRe.test(path);
		if (namespaceHit && pathHit) {
			shared.rules.sprites.delete(sprite);
			shared.rules.unknownSprites.delete(sprite);
		}
	}
}

/**
 * Java regex subset the engine can run: compilable by JavaScript and free
 * of Java-only constructs (quoters, possessive quantifiers, atomic groups,
 * Java inline flags, unicode property classes). Anything else answers
 * undefined so the whole filter stays unapplied.
 */
function compileAtlasPattern(raw: string): RegExp | undefined {
	if (hasUnsupportedRegexFeatures(raw)) {
		return undefined;
	}
	try {
		return new RegExp(raw);
	} catch {
		return undefined;
	}
}

function hasUnsupportedRegexFeatures(raw: string): boolean {
	if (raw.includes("\\Q") || raw.includes("\\E")) {
		return true;
	}
	if (raw.includes("(?>")) {
		return true;
	}
	if (/\\[pP]\{/.test(raw)) {
		return true;
	}
	if (
		/\*\+/.test(raw) ||
		/\+\+/.test(raw) ||
		/\?\+/.test(raw) ||
		/\{[^}]*\}\+/.test(raw)
	) {
		return true;
	}
	let at = raw.indexOf("(?");
	while (at >= 0) {
		const rest = raw.slice(at + 2);
		const first = rest[0];
		if (
			first === ":" ||
			first === "=" ||
			first === "!" ||
			first === "<" ||
			/^[A-Za-z-]*:/.test(rest)
		) {
			at = raw.indexOf("(?", at + 2);
			continue;
		}
		return true;
	}
	return false;
}

function executePalettedSource(
	shared: AtlasExecuteShared,
	source: Record<string, unknown>,
	skipSource: (kind: AtlasSkipKind, reason: string, detail: string) => void,
): void {
	if (shared.packFormat === undefined) {
		skipSource(
			"atlas-source",
			"version-undetermined",
			`paletted_permutations needs a determined pack format`,
		);
		return;
	}
	if (
		!Array.isArray(source.textures) ||
		source.textures.some((entry) => typeof entry !== "string")
	) {
		skipSource(
			"atlas-source",
			"invalid-source",
			`paletted_permutations has no usable "textures" list`,
		);
		return;
	}
	if (
		typeof source.palette_key !== "string" ||
		(source.palette_key as string).trim() === ""
	) {
		skipSource(
			"atlas-source",
			"invalid-source",
			`paletted_permutations has no usable "palette_key" field`,
		);
		return;
	}
	if (!isRecord(source.permutations)) {
		skipSource(
			"atlas-source",
			"invalid-source",
			`paletted_permutations has no usable "permutations" map`,
		);
		return;
	}
	const keys = Object.keys(source.permutations).sort(compareBytes);
	for (const key of keys) {
		if (typeof source.permutations[key] !== "string") {
			skipSource(
				"atlas-source",
				"invalid-source",
				`paletted_permutations permutation "${key}" names no palette`,
			);
			return;
		}
	}
	// The separator field only exists from its version gate on; below it
	// the game never sees the field, so the default always applies.
	const separatorField =
		typeof source.separator === "string" ? source.separator : "_";
	const separator =
		shared.packFormat !== undefined &&
		isFactActive(ATLAS_SEPARATOR_FACT, shared.packFormat)
			? separatorField
			: "_";
	const paletteRoot =
		shared.packFormat !== undefined &&
		isFactActive(ATLAS_PALETTE_ROOT_FACT, shared.packFormat)
			? "textures/palettes/"
			: "textures/";
	const keyFile = paletteFileFor(source.palette_key as string, paletteRoot);
	if (keyFile === undefined) {
		skipSource(
			"atlas-source",
			"invalid-source",
			`paletted_permutations names no usable palette key`,
		);
		return;
	}
	const emittedReasons = new Set<string>();
	for (const rawTexture of source.textures as string[]) {
		const parsedTexture = parseResourceLocation(rawTexture);
		if (parsedTexture.namespace === "" || parsedTexture.path === "") {
			skipSource(
				"atlas-source",
				"invalid-source",
				`paletted_permutations names no usable texture`,
			);
			return;
		}
		const basePath = stripPngSuffix(parsedTexture.path);
		const baseFile =
			parsedTexture.path.lastIndexOf(".") < 0
				? `assets/${parsedTexture.namespace}/textures/${parsedTexture.path}.png`
				: `assets/${parsedTexture.namespace}/textures/${parsedTexture.path}`;
		const baseStatus = fileStatusInLayers(
			shared.layers,
			shared.hasVanilla,
			baseFile,
			parsedTexture.namespace,
		);
		for (const key of keys) {
			const paletteFile = paletteFileFor(
				source.permutations[key] as string,
				paletteRoot,
			);
			if (paletteFile === undefined) {
				skipSource(
					"atlas-source",
					"invalid-source",
					`paletted_permutations permutation "${key}" names no palette`,
				);
				return;
			}
			const sprite = `${parsedTexture.namespace}:${basePath}${separator}${key}`;
			const keyStatus = fileStatusInLayers(
				shared.layers,
				shared.hasVanilla,
				keyFile,
				parseResourceLocation(source.palette_key as string).namespace,
			);
			const paletteStatus = fileStatusInLayers(
				shared.layers,
				shared.hasVanilla,
				paletteFile,
				parseResourceLocation(source.permutations[key] as string).namespace,
			);
			const blocker = firstUnresolvedDependency([
				{ label: "base texture", file: baseFile, status: baseStatus },
				{ label: "palette key", file: keyFile, status: keyStatus },
				{
					label: "permutation palette",
					file: paletteFile,
					status: paletteStatus,
				},
			]);
			if (blocker === undefined) {
				shared.rules.sprites.set(sprite, { origin: "generated" });
				shared.rules.unknownSprites.delete(sprite);
				continue;
			}
			// Generated sprites whose files cannot be confirmed stay
			// unknown with their diagnosis; later sources may still win.
			shared.rules.sprites.delete(sprite);
			shared.rules.unknownSprites.add(sprite);
			const reason =
				blocker.status === "unresolved"
					? "unresolved-dependency"
					: "missing-dependency";
			if (!emittedReasons.has(reason)) {
				emittedReasons.add(reason);
				skipSource(
					"atlas-source",
					reason,
					`sprite "${sprite}" needs ${blocker.label} "${blocker.file}" (${blocker.status})`,
				);
			}
		}
	}
}

function paletteFileFor(
	value: string,
	paletteRoot: string,
): string | undefined {
	const parsed = parseResourceLocation(value);
	if (parsed.namespace === "" || parsed.path === "") {
		return undefined;
	}
	const leaf =
		parsed.path.lastIndexOf(".") < 0 ? `${parsed.path}.png` : parsed.path;
	return `assets/${parsed.namespace}/${paletteRoot}${leaf}`;
}

function fileStatusInLayers(
	layers: AtlasLayerInput[],
	hasVanilla: boolean,
	rel: string,
	namespace: string,
): "resolved" | "unresolved" | "missing" {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		if (layers[index]?.files.has(rel) === true) {
			return "resolved";
		}
	}
	if (namespace === "minecraft" && !hasVanilla) {
		return "unresolved";
	}
	return "missing";
}

function firstUnresolvedDependency(
	candidates: Array<{
		label: string;
		file: string;
		status: "resolved" | "unresolved" | "missing";
	}>,
):
	| { label: string; file: string; status: "unresolved" | "missing" }
	| undefined {
	for (const candidate of candidates) {
		if (candidate.status !== "resolved") {
			return {
				label: candidate.label,
				file: candidate.file,
				status: candidate.status,
			};
		}
	}
	return undefined;
}
