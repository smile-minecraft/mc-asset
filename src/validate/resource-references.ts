import { comparePackFormats } from "../profiles/versions.ts";
import type { PackCoverageSkip } from "./pack.ts";
import type { LayerIndex, ResourceContext } from "./resource-context.ts";
import {
	parseResourceLocation,
	validateResourceLocation,
} from "./resource-location.ts";

/**
 * Reference checks for the equipment, particle and font resource types.
 *
 * Each checker reads one already-parsed JSON document and reports through
 * a sink, so the pack scan keeps ownership of findings, error tracking and
 * coverage. Resolution follows the same rules as every other reference:
 * a miss is an error, a `minecraft:` reference with no vanilla tree
 * provided is an unresolved external, and a case-only difference is a case
 * mismatch.
 *
 * Path rules (each prefix is inserted between the namespace directory and
 * the reference path):
 *
 * - equipment `layers.<layerType>[].texture`:
 *   `assets/<ns>/textures/entity/equipment/<layerType>/<path>.png`. The
 *   layer type is part of the path; a plain `textures/<path>.png` guess
 *   would flag every valid definition. Any layer key that is a plain path
 *   segment is used verbatim, with no list of known layer types.
 * - particle `textures[]`: `assets/<ns>/textures/particle/<path>.png`,
 *   the sprite directory of the default particle atlas.
 * - font `bitmap.file`: `assets/<ns>/textures/<path>` (already `.png`).
 * - font `reference.id`: `assets/<ns>/font/<path>.json`.
 * - font `ttf.file`: `assets/<ns>/font/<path>`.
 *
 * Anything whose shape or version is uncertain is a coverage skip, never
 * an error: a false error turns a user's CI red, a missed check only keeps
 * the previous behavior.
 */

/** Coverage skip kind shared by every skip this module records. */
export const RESOURCE_REFERENCE_SKIP_KIND = "resource-reference";

/** Skip reasons, pinned because reports and tests name them. */
export const RESOURCE_REFERENCE_SKIP_REASONS = {
	/** A value has a different type than the documented shape. */
	unexpectedShape: "unexpected-shape",
	/** A particle texture entry starting with `#`. */
	internalReference: "internal-reference",
	/** A `legacy_unicode` template that expands to many textures. */
	patternReference: "pattern-reference",
	/** A font provider type whose files are not checked, or is unknown. */
	providerNotInterpreted: "provider-not-interpreted",
	/** The pack format is unknown, so the feature cannot be placed. */
	versionNotDetermined: "version-not-determined",
	/** The pack format predates the feature. */
	featureNotInVersion: "feature-not-in-version",
	/** The pack replaces the particle atlas, so sprites may come from elsewhere. */
	particleAtlasCustomized: "particle-atlas-customized",
	/**
	 * `trim_overrides[].texture` names a trim pattern asset whose path rule
	 * is not confirmed, so those textures are not read.
	 */
	trimOverridesNotInterpreted: "trim-overrides-not-interpreted",
} as const;

/** Pack format at which `models/equipment/` holds equipment definitions. */
const LEGACY_EQUIPMENT_FORMAT = "42.0";

/** Pack format from which `equipment/` is read (Minecraft 1.21.4). */
const EQUIPMENT_DIRECTORY_FORMAT = "46.0";

/** Pack format from which a font `reference` provider is read. */
const FONT_REFERENCE_FORMAT = "15.0";

/** The default particle atlas. A pack that replaces it may add sprites. */
const PARTICLE_ATLAS_REL = "assets/minecraft/atlases/particles.json";

/** A layer key that is safe to insert as one path segment, verbatim. */
const PLAIN_SEGMENT = /^[a-z0-9._-]+$/;

export interface ReferenceSink {
	/** Record a determined defect at error level and mark the file as failed. */
	problem(
		code:
			| "PACK_MISSING_TEXTURE"
			| "PACK_MISSING_ASSET"
			| "PACK_BROKEN_REFERENCE"
			| "PACK_CASE_MISMATCH"
			| "PACK_WRONG_PATH"
			| "PACK_NAMESPACE_PROBLEM"
			| "PACK_INVALID_FILENAME",
		message: string,
		rel: string,
	): void;
	/** A `minecraft:` reference with no vanilla tree to check against. */
	unresolved(entry: {
		kind: "texture" | "resource-file";
		field: string;
		value: string;
		target: string;
		rel: string;
	}): void;
	/** A texture that a covered source uses, so it is not an orphan. */
	referencedTexture(rel: string): void;
	skip(skip: PackCoverageSkip): void;
}

export interface ResourceReferenceInput {
	rel: string;
	doc: unknown;
	context: ResourceContext;
	/** Effective resource-pack format, or undefined when undetermined. */
	packFormat: string | undefined;
	sink: ReferenceSink;
}

/**
 * Equipment definitions moved from `models/equipment/` (pack format 42.0,
 * Minecraft 1.21.2 and 1.21.3) to `equipment/` (46.0, 1.21.4). The older
 * location is read as equipment only at 42.0; anywhere else the file keeps
 * going through the model checks, as before.
 */
export function isLegacyEquipmentLocation(
	rel: string,
	packFormat: string | undefined,
): boolean {
	if (packFormat !== LEGACY_EQUIPMENT_FORMAT) {
		return false;
	}
	const parts = rel.toLowerCase().split("/");
	return (
		parts.length >= 5 &&
		parts[0] === "assets" &&
		parts[2] === "models" &&
		parts[3] === "equipment"
	);
}

/** One file layer in load order. `current` marks the pack being scanned. */
interface Layer {
	current: boolean;
	index: LayerIndex;
}

/** Current pack first, then each dependency, then the vanilla tree. */
function layersOf(context: ResourceContext): Layer[] {
	const layers: Layer[] = [{ current: true, index: context.current }];
	for (const index of context.dependencies) {
		layers.push({ current: false, index });
	}
	if (context.vanilla !== undefined) {
		layers.push({ current: false, index: context.vanilla });
	}
	return layers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keys that can stand as one segment: no separators, not `.` or `..`. */
function isPlainSegment(key: string): boolean {
	return PLAIN_SEGMENT.test(key) && key !== "." && key !== "..";
}

/** JSON pointer (RFC 6901) into a file; the bare file for the root. */
function pointerTarget(
	rel: string,
	segments: ReadonlyArray<string | number>,
): string {
	if (segments.length === 0) {
		return rel;
	}
	const pointer = segments
		.map((segment) => String(segment).replace(/~/g, "~0"))
		.map((segment) => `/${segment.replace(/\//g, "~1")}`)
		.join("");
	return `${rel}#${pointer}`;
}

function skipAt(
	sink: ReferenceSink,
	target: string,
	reason: string,
	detail?: string,
): void {
	sink.skip({
		kind: RESOURCE_REFERENCE_SKIP_KIND,
		reason,
		target,
		...(detail === undefined ? {} : { detail }),
	});
}

/** A value with the wrong JSON shape: one skip, never an error. */
function skipShape(
	sink: ReferenceSink,
	rel: string,
	segments: ReadonlyArray<string | number>,
): void {
	skipAt(
		sink,
		pointerTarget(rel, segments),
		RESOURCE_REFERENCE_SKIP_REASONS.unexpectedShape,
	);
}

/**
 * Whether the pack format is known at all. With no format, the target
 * records one skip and is not checked, so a file the scan cannot place
 * never produces an error. Unlike formatAllows this sets no lower bound:
 * the first version of these features is unconfirmed, so any known
 * format keeps the existing checks.
 */
function versionKnown(input: ResourceReferenceInput, target: string): boolean {
	if (input.packFormat !== undefined) {
		return true;
	}
	skipAt(
		input.sink,
		target,
		RESOURCE_REFERENCE_SKIP_REASONS.versionNotDetermined,
	);
	return false;
}

/**
 * Whether a file may be read at this pack format. Below the feature, or with
 * no format at all, the target records one skip and is not checked, so a file
 * the scan cannot place never produces an error.
 */
function formatAllows(
	input: ResourceReferenceInput,
	target: string,
	since: string,
): boolean {
	const { packFormat, sink } = input;
	if (packFormat === undefined) {
		skipAt(sink, target, RESOURCE_REFERENCE_SKIP_REASONS.versionNotDetermined);
		return false;
	}
	if (comparePackFormats(packFormat, since) < 0) {
		skipAt(
			sink,
			target,
			RESOURCE_REFERENCE_SKIP_REASONS.featureNotInVersion,
			`pack format ${packFormat} predates ${since}`,
		);
		return false;
	}
	return true;
}

/**
 * A reference string must be a resource location, checked by the same engine
 * as the model references, preserving the engine's specific defect codes.
 * The engine's extension warning does not apply to references, so it is
 * dropped here.
 */
function isUsableLocation(
	sink: ReferenceSink,
	rel: string,
	field: string,
	value: string,
): boolean {
	if (value.trim() === "") {
		sink.problem(
			"PACK_BROKEN_REFERENCE",
			`"${rel}" has a "${field}" reference that is not a usable resource location.`,
			rel,
		);
		return false;
	}
	const problems = validateResourceLocation(value).filter(
		(finding) => finding.code !== "PENDING_SOURCE_PNG_ONLY",
	);
	for (const finding of problems) {
		if (
			finding.code === "PACK_CASE_MISMATCH" ||
			finding.code === "PACK_WRONG_PATH" ||
			finding.code === "PACK_NAMESPACE_PROBLEM" ||
			finding.code === "PACK_INVALID_FILENAME"
		) {
			sink.problem(finding.code, finding.message, rel);
		}
	}
	return problems.length === 0;
}

/**
 * Locate one file in load order. An exact file in any layer resolves; a
 * case-only variant in any layer is PACK_CASE_MISMATCH; a `minecraft:` file
 * with no vanilla tree is an unresolved external. Anything else is "missing",
 * and the caller reports it, because the code depends on the reference type.
 * Only textures feed the orphan check, so only they are marked as referenced.
 */
function resolveFile(
	context: ResourceContext,
	sink: ReferenceSink,
	rel: string,
	field: string,
	value: string,
	target: string,
	kind: "texture" | "resource-file",
): "resolved" | "reported" | "missing" {
	const layers = layersOf(context);
	for (const layer of layers) {
		if (layer.index.files.has(target)) {
			if (layer.current && kind === "texture") {
				sink.referencedTexture(target);
			}
			return "resolved";
		}
	}
	const key = target.toLowerCase();
	for (const layer of layers) {
		const folded = layer.index.folded.get(key);
		if (folded !== undefined) {
			sink.problem(
				"PACK_CASE_MISMATCH",
				`"${field}" "${value}" in "${rel}" differs from "${folded}" by case only.`,
				rel,
			);
			if (layer.current && kind === "texture") {
				sink.referencedTexture(folded);
			}
			return "reported";
		}
	}
	if (
		parseResourceLocation(value).namespace === "minecraft" &&
		!context.hasVanilla
	) {
		sink.unresolved({ kind, field, value, target, rel });
		return "reported";
	}
	return "missing";
}

/**
 * The vanilla particle atlas always exists, so only the current pack and its
 * dependencies count here. A replacement there may add sprite sources, so a
 * particle miss may name a sprite this scan cannot see.
 */
function replacesParticleAtlas(context: ResourceContext): boolean {
	return (
		context.current.files.has(PARTICLE_ATLAS_REL) ||
		context.dependencies.some((index) => index.files.has(PARTICLE_ATLAS_REL))
	);
}

/**
 * Equipment definitions. The layer type is a directory under
 * `textures/entity/equipment/`, so it is part of every texture path. Only
 * `layers` is read; `dyeable` is not, and `trim_overrides` is recorded as a
 * coverage skip because its texture path rule is unconfirmed.
 */
export function checkEquipmentReferences(input: ResourceReferenceInput): void {
	const { rel, doc, sink } = input;
	if (
		!isLegacyEquipmentLocation(rel, input.packFormat) &&
		!formatAllows(input, rel, EQUIPMENT_DIRECTORY_FORMAT)
	) {
		return;
	}
	if (!isRecord(doc)) {
		skipShape(sink, rel, []);
		return;
	}
	if (doc.trim_overrides !== undefined) {
		skipAt(
			sink,
			pointerTarget(rel, ["trim_overrides"]),
			RESOURCE_REFERENCE_SKIP_REASONS.trimOverridesNotInterpreted,
			"trim override textures are not resolved",
		);
	}
	const layers = doc.layers;
	if (!isRecord(layers)) {
		skipShape(sink, rel, ["layers"]);
		return;
	}
	for (const layerType of Object.keys(layers)) {
		const entries = layers[layerType];
		if (
			!isPlainSegment(layerType) ||
			!Array.isArray(entries) ||
			entries.length === 0
		) {
			skipShape(sink, rel, ["layers", layerType]);
			continue;
		}
		for (let index = 0; index < entries.length; index += 1) {
			checkEquipmentLayer(input, layerType, index, entries[index]);
		}
	}
}

/** One `{ "texture": <resource location> }` entry of a layer type. */
function checkEquipmentLayer(
	input: ResourceReferenceInput,
	layerType: string,
	index: number,
	entry: unknown,
): void {
	const { rel, context, sink } = input;
	const at = ["layers", layerType, index];
	if (!isRecord(entry)) {
		skipShape(sink, rel, at);
		return;
	}
	const texture = entry.texture;
	if (typeof texture !== "string") {
		skipShape(sink, rel, [...at, "texture"]);
		return;
	}
	const field = `layers.${layerType}[${index}].texture`;
	if (!isUsableLocation(sink, rel, field, texture)) {
		return;
	}
	const parsed = parseResourceLocation(texture);
	const target = `assets/${parsed.namespace}/textures/entity/equipment/${layerType}/${parsed.path}.png`;
	const outcome = resolveFile(
		context,
		sink,
		rel,
		field,
		texture,
		target,
		"texture",
	);
	if (outcome === "missing") {
		sink.problem(
			"PACK_MISSING_TEXTURE",
			`"${field}" "${texture}" in "${rel}" has no texture at "${target}".`,
			rel,
		);
	}
}

/**
 * Particle sprites. Each entry names a sprite in the particle directory of
 * the default atlas. A `#` entry points at another atlas entry and is skipped.
 */
export function checkParticleReferences(input: ResourceReferenceInput): void {
	const { rel, doc, context, sink } = input;
	if (!versionKnown(input, rel)) {
		return;
	}
	if (!isRecord(doc)) {
		skipShape(sink, rel, []);
		return;
	}
	const textures = doc.textures;
	if (!Array.isArray(textures)) {
		skipShape(sink, rel, ["textures"]);
		return;
	}
	for (let index = 0; index < textures.length; index += 1) {
		const entry: unknown = textures[index];
		const at = ["textures", index];
		if (typeof entry !== "string") {
			skipShape(sink, rel, at);
			continue;
		}
		if (entry.startsWith("#")) {
			skipAt(
				sink,
				pointerTarget(rel, at),
				RESOURCE_REFERENCE_SKIP_REASONS.internalReference,
			);
			continue;
		}
		const field = `textures[${index}]`;
		if (!isUsableLocation(sink, rel, field, entry)) {
			continue;
		}
		const parsed = parseResourceLocation(entry);
		const target = `assets/${parsed.namespace}/textures/particle/${parsed.path}.png`;
		const outcome = resolveFile(
			context,
			sink,
			rel,
			field,
			entry,
			target,
			"texture",
		);
		if (outcome !== "missing") {
			continue;
		}
		if (replacesParticleAtlas(context)) {
			skipAt(
				sink,
				pointerTarget(rel, at),
				RESOURCE_REFERENCE_SKIP_REASONS.particleAtlasCustomized,
			);
			continue;
		}
		sink.problem(
			"PACK_MISSING_TEXTURE",
			`"${field}" "${entry}" in "${rel}" has no texture at "${target}".`,
			rel,
		);
	}
}

/**
 * Font providers. Bitmap and TTF providers each name one file, and a
 * reference provider names another font document. `legacy_unicode` expands a
 * template that is not checked; `space`, `unihex` and unknown types are not
 * interpreted at all.
 */
export function checkFontReferences(input: ResourceReferenceInput): void {
	const { rel, doc, sink } = input;
	if (!isRecord(doc)) {
		skipShape(sink, rel, []);
		return;
	}
	const providers = doc.providers;
	if (!Array.isArray(providers)) {
		skipShape(sink, rel, ["providers"]);
		return;
	}
	for (let index = 0; index < providers.length; index += 1) {
		checkFontProvider(input, index, providers[index]);
	}
}

function checkFontProvider(
	input: ResourceReferenceInput,
	index: number,
	provider: unknown,
): void {
	const { rel, sink } = input;
	const at = ["providers", index];
	if (!isRecord(provider)) {
		skipShape(sink, rel, at);
		return;
	}
	const type = provider.type;
	if (typeof type !== "string") {
		skipShape(sink, rel, [...at, "type"]);
		return;
	}
	if (type === "bitmap") {
		checkBitmapProvider(input, index, provider);
	} else if (type === "ttf") {
		checkTtfProvider(input, index, provider);
	} else if (type === "reference") {
		checkReferenceProvider(input, index, provider);
	} else if (type === "legacy_unicode") {
		skipAt(
			sink,
			pointerTarget(rel, at),
			RESOURCE_REFERENCE_SKIP_REASONS.patternReference,
		);
	} else {
		skipAt(
			sink,
			pointerTarget(rel, at),
			RESOURCE_REFERENCE_SKIP_REASONS.providerNotInterpreted,
			`provider type "${type}" is not interpreted`,
		);
	}
}

/** A bitmap `file` is a texture path under `textures/`, `.png` included. */
function checkBitmapProvider(
	input: ResourceReferenceInput,
	index: number,
	provider: Record<string, unknown>,
): void {
	const { rel, context, sink } = input;
	const at = ["providers", index];
	if (!versionKnown(input, pointerTarget(rel, at))) {
		return;
	}
	const file = provider.file;
	if (typeof file !== "string") {
		skipShape(sink, rel, ["providers", index, "file"]);
		return;
	}
	const field = `providers[${index}].file`;
	if (!isUsableLocation(sink, rel, field, file)) {
		return;
	}
	const parsed = parseResourceLocation(file);
	const target = `assets/${parsed.namespace}/textures/${parsed.path}`;
	const outcome = resolveFile(
		context,
		sink,
		rel,
		field,
		file,
		target,
		"texture",
	);
	if (outcome === "missing") {
		sink.problem(
			"PACK_MISSING_TEXTURE",
			`"${field}" "${file}" in "${rel}" has no texture at "${target}".`,
			rel,
		);
	}
}

/** A TTF `file` is a font file path under `font/`, extension included. */
function checkTtfProvider(
	input: ResourceReferenceInput,
	index: number,
	provider: Record<string, unknown>,
): void {
	const { rel, context, sink } = input;
	const at = ["providers", index];
	if (!versionKnown(input, pointerTarget(rel, at))) {
		return;
	}
	const file = provider.file;
	if (typeof file !== "string") {
		skipShape(sink, rel, ["providers", index, "file"]);
		return;
	}
	const field = `providers[${index}].file`;
	if (!isUsableLocation(sink, rel, field, file)) {
		return;
	}
	const parsed = parseResourceLocation(file);
	const target = `assets/${parsed.namespace}/font/${parsed.path}`;
	const outcome = resolveFile(
		context,
		sink,
		rel,
		field,
		file,
		target,
		"resource-file",
	);
	if (outcome === "missing") {
		sink.problem(
			"PACK_MISSING_ASSET",
			`"${field}" "${file}" in "${rel}" has no font file at "${target}".`,
			rel,
		);
	}
}

/** A reference `id` names a font document under `font/`, and needs 15.0. */
function checkReferenceProvider(
	input: ResourceReferenceInput,
	index: number,
	provider: Record<string, unknown>,
): void {
	const { rel, context, sink } = input;
	const at = ["providers", index];
	if (!formatAllows(input, pointerTarget(rel, at), FONT_REFERENCE_FORMAT)) {
		return;
	}
	const id = provider.id;
	if (typeof id !== "string") {
		skipShape(sink, rel, [...at, "id"]);
		return;
	}
	const field = `providers[${index}].id`;
	if (!isUsableLocation(sink, rel, field, id)) {
		return;
	}
	const parsed = parseResourceLocation(id);
	const target = `assets/${parsed.namespace}/font/${parsed.path}.json`;
	const outcome = resolveFile(
		context,
		sink,
		rel,
		field,
		id,
		target,
		"resource-file",
	);
	if (outcome === "missing") {
		sink.problem(
			"PACK_MISSING_ASSET",
			`"${field}" "${id}" in "${rel}" has no font file at "${target}".`,
			rel,
		);
	}
}
