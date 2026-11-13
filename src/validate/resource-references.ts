import {
	comparePackFormats,
	EQUIPMENT_TRIM_OVERRIDES_FACT,
	POST_EFFECT_FACT,
	SOUND_EVENT_FACT,
	WAYPOINT_STYLE_FACT,
} from "../profiles/versions.ts";
import type { PackCoverageSkip } from "./pack.ts";
import type { LayerIndex, ResourceContext } from "./resource-context.ts";
import {
	parseResourceLocation,
	validateResourceLocation,
} from "./resource-location.ts";

/**
 * Reference checks for the equipment, particle, font, sound, post-effect
 * and waypoint-style resource types.
 *
 * Each checker reads one already-parsed JSON document and reports through
 * a sink, so the pack scan keeps ownership of findings, error tracking and
 * coverage. Resolution follows the same rules as every other reference:
 * a miss is an error, a `minecraft:` reference with no vanilla tree
 * provided is an unresolved external, and a case-only difference is a case
 * mismatch. A `minecraft:` sound miss with a vanilla tree that carries no
 * `assets/minecraft/sounds/` files is an unresolved external too, because
 * the client jars ship no sounds and the miss proves nothing.
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
 * - sound `sounds[]` names: `assets/<ns>/sounds/<path>.ogg`; a `type`
 *   of `event` names another sound event, not a file.
 * - post effect `passes[].vertex_shader` and `.fragment_shader`:
 *   `assets/<ns>/shaders/<path>.vsh` and `.fsh`; an input `location`:
 *   `assets/<ns>/textures/effect/<path>.png`.
 * - waypoint style `sprites[]`: the id gets the game's
 *   `hud/locator_bar_dot/` prefix and resolves to
 *   `assets/<ns>/textures/gui/sprites/hud/locator_bar_dot/<path>.png`.
 * - equipment `trim_overrides[].texture` (97.1+):
 *   `assets/<ns>/textures/trims/entity/<layerType>/<path>.png` for each
 *   trim-capable layer type the definition declares; `palette` (97.1+):
 *   `assets/<ns>/textures/palettes/<path>.png`.
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
	/** The pack replaces the GUI atlas, so waypoint sprites may come from elsewhere. */
	guiAtlasCustomized: "gui-atlas-customized",
	/**
	 * `trim_overrides` sits in a pack older than 97.1, where the game
	 * ignores the field, so those textures are not read.
	 */
	trimOverridesNotInterpreted: "trim-overrides-not-interpreted",
} as const;

/** Pack format at which `models/equipment/` holds equipment definitions. */
const LEGACY_EQUIPMENT_FORMAT = "42.0";

/** Pack format from which `equipment/` is read (Minecraft 1.21.4). */
const EQUIPMENT_DIRECTORY_FORMAT = "46.0";

/** Pack format from which a font `reference` provider is read. */
const FONT_REFERENCE_FORMAT = "15.0";

/** Pack format from which `post_effect/` is read (Minecraft 1.21.2). */
const POST_EFFECT_FORMAT = POST_EFFECT_FACT.since.packFormat ?? "42.0";

/** Pack format from which a pass names split vertex/fragment shaders. */
const POST_EFFECT_SPLIT_SHADERS_FORMAT =
	POST_EFFECT_FACT.value.splitShadersSince;

/** Pack format from which `waypoint_style/` is read (Minecraft 1.21.6). */
const WAYPOINT_STYLE_FORMAT = WAYPOINT_STYLE_FACT.since.packFormat ?? "63.0";

/** Pack format from which `trim_overrides` is read (Minecraft 26.3). */
const TRIM_OVERRIDES_FORMAT =
	EQUIPMENT_TRIM_OVERRIDES_FACT.since.packFormat ?? "97.1";

/** Pack format from which `sounds.json` is read (oldest covered release). */
const SOUND_EVENT_FORMAT = SOUND_EVENT_FACT.since.packFormat ?? "12.0";

/** The game prefixes every waypoint style sprite with this directory. */
const WAYPOINT_SPRITE_PREFIX = WAYPOINT_STYLE_FACT.value.spritePrefix;

/**
 * Layer types whose renderer asks for a trim texture. Other equipment
 * layers (humanoid_baby, saddles, wings, horse body) never request one,
 * so an override texture is not checked against them.
 */
const TRIM_LAYER_TYPES: ReadonlySet<string> = new Set(
	EQUIPMENT_TRIM_OVERRIDES_FACT.value.trimLayerTypes,
);

/** The particle atlas. A pack that replaces it may add sprites. */
const PARTICLE_ATLAS_REL = "assets/minecraft/atlases/particles.json";

/** The GUI atlas, which maps every waypoint sprite to its texture. */
const GUI_ATLAS_REL = "assets/minecraft/atlases/gui.json";

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

/**
 * Whether the vanilla tree carries any `assets/minecraft/sounds/` file.
 * A vanilla tree built from a client jar ships no sounds, so a miss there
 * proves nothing; a tree merged with an asset index does carry them.
 */
function hasVanillaSounds(context: ResourceContext): boolean {
	const vanilla = context.vanilla;
	if (vanilla === undefined) {
		return false;
	}
	const prefix = `assets/minecraft/${SOUND_EVENT_FACT.value.soundRoot}`;
	for (const file of vanilla.files) {
		if (file.startsWith(prefix)) {
			return true;
		}
	}
	return false;
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
 * never produces an error. Unlike allowedFormat this sets no lower bound:
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
 * The effective pack format when a file may be read at it, or undefined when
 * it may not. Below the feature, or with no format at all, the target records
 * one skip and the file is not checked, so a file the scan cannot place never
 * produces an error.
 */
function allowedFormat(
	input: ResourceReferenceInput,
	target: string,
	since: string,
): string | undefined {
	const { packFormat, sink } = input;
	if (packFormat === undefined) {
		skipAt(sink, target, RESOURCE_REFERENCE_SKIP_REASONS.versionNotDetermined);
		return undefined;
	}
	if (comparePackFormats(packFormat, since) < 0) {
		skipAt(
			sink,
			target,
			RESOURCE_REFERENCE_SKIP_REASONS.featureNotInVersion,
			`pack format ${packFormat} predates ${since}`,
		);
		return undefined;
	}
	return packFormat;
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

/** The same rule for the GUI atlas: a replacement may move waypoint sprites. */
function replacesGuiAtlas(context: ResourceContext): boolean {
	return (
		context.current.files.has(GUI_ATLAS_REL) ||
		context.dependencies.some((index) => index.files.has(GUI_ATLAS_REL))
	);
}

/**
 * Equipment definitions. The layer type is a directory under
 * `textures/entity/equipment/`, so it is part of every texture path.
 * `trim_overrides` is read from pack format 97.1 (26.3), where the game
 * gained the field; older packs keep the previous coverage skip because
 * the game ignores the field there. From 97.1, `texture` resolves under
 * `textures/trims/entity/<layerType>/` for every trim-rendered layer the
 * definition declares, and `palette` under `textures/palettes/`. A layer
 * whose entry list is empty is never rendered, so it asks for no trim
 * texture.
 */
export function checkEquipmentReferences(input: ResourceReferenceInput): void {
	const { rel, doc, sink } = input;
	if (
		!isLegacyEquipmentLocation(rel, input.packFormat) &&
		allowedFormat(input, rel, EQUIPMENT_DIRECTORY_FORMAT) === undefined
	) {
		return;
	}
	if (!isRecord(doc)) {
		skipShape(sink, rel, []);
		return;
	}
	const layers = doc.layers;
	if (!isRecord(layers)) {
		skipShape(sink, rel, ["layers"]);
		return;
	}
	const trimLayers: string[] = [];
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
		if (TRIM_LAYER_TYPES.has(layerType)) {
			trimLayers.push(layerType);
		}
		for (let index = 0; index < entries.length; index += 1) {
			checkEquipmentLayer(input, layerType, index, entries[index]);
		}
	}
	if (doc.trim_overrides !== undefined) {
		const target = pointerTarget(rel, ["trim_overrides"]);
		if (input.packFormat === undefined) {
			skipAt(
				sink,
				target,
				RESOURCE_REFERENCE_SKIP_REASONS.versionNotDetermined,
			);
		} else if (
			comparePackFormats(input.packFormat, TRIM_OVERRIDES_FORMAT) < 0
		) {
			skipAt(
				sink,
				target,
				RESOURCE_REFERENCE_SKIP_REASONS.trimOverridesNotInterpreted,
				`pack format ${input.packFormat} predates ${TRIM_OVERRIDES_FORMAT}`,
			);
		} else {
			checkEquipmentTrimOverrides(input, doc.trim_overrides, trimLayers);
		}
	}
}

/**
 * One `trim_overrides[]` entry. `when` selects a trim material or pattern
 * (data-pack ids, not files); `texture` and `palette` name resource files
 * and at least one must be present.
 */
function checkEquipmentTrimOverrides(
	input: ResourceReferenceInput,
	value: unknown,
	trimLayers: readonly string[],
): void {
	const { rel, sink } = input;
	if (!Array.isArray(value)) {
		skipShape(sink, rel, ["trim_overrides"]);
		return;
	}
	for (let index = 0; index < value.length; index += 1) {
		const entry = value[index];
		const at = ["trim_overrides", index];
		if (!isRecord(entry)) {
			skipShape(sink, rel, at);
			continue;
		}
		if (!isRecord(entry.when)) {
			skipShape(sink, rel, [...at, "when"]);
			continue;
		}
		const texture = entry.texture;
		const palette = entry.palette;
		if (texture === undefined && palette === undefined) {
			skipShape(sink, rel, at);
			continue;
		}
		if (texture !== undefined) {
			if (typeof texture !== "string") {
				skipShape(sink, rel, [...at, "texture"]);
			} else {
				checkTrimOverrideTexture(input, index, texture, trimLayers);
			}
		}
		if (palette !== undefined) {
			if (typeof palette !== "string") {
				skipShape(sink, rel, [...at, "palette"]);
			} else {
				checkTrimOverridePalette(input, index, palette);
			}
		}
	}
}

/**
 * A trim override texture is a trim pattern asset id. The renderer builds
 * `trims/entity/<layerType>/<path>` per trim-capable layer, and the texture
 * loader adds `textures/` and `.png`.
 */
function checkTrimOverrideTexture(
	input: ResourceReferenceInput,
	index: number,
	texture: string,
	trimLayers: readonly string[],
): void {
	const { rel, context, sink } = input;
	const field = `trim_overrides[${index}].texture`;
	if (!isUsableLocation(sink, rel, field, texture) || trimLayers.length === 0) {
		return;
	}
	const parsed = parseResourceLocation(texture);
	const leaf = parsed.path.endsWith(".png")
		? parsed.path
		: `${parsed.path}.png`;
	for (const layerType of trimLayers) {
		const target = `assets/${parsed.namespace}/textures/trims/entity/${layerType}/${leaf}`;
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
				"PACK_BROKEN_REFERENCE",
				`"${field}" "${texture}" in "${rel}" has no trim texture at "${target}".`,
				rel,
			);
		}
	}
}

/** A trim override palette is a palette texture under `textures/palettes/`. */
function checkTrimOverridePalette(
	input: ResourceReferenceInput,
	index: number,
	palette: string,
): void {
	const { rel, context, sink } = input;
	const field = `trim_overrides[${index}].palette`;
	if (!isUsableLocation(sink, rel, field, palette)) {
		return;
	}
	const parsed = parseResourceLocation(palette);
	const leaf = parsed.path.endsWith(".png")
		? parsed.path
		: `${parsed.path}.png`;
	const target = `assets/${parsed.namespace}/textures/palettes/${leaf}`;
	const outcome = resolveFile(
		context,
		sink,
		rel,
		field,
		palette,
		target,
		"texture",
	);
	if (outcome === "missing") {
		sink.problem(
			"PACK_MISSING_TEXTURE",
			`"${field}" "${palette}" in "${rel}" has no texture at "${target}".`,
			rel,
		);
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
	if (
		allowedFormat(input, pointerTarget(rel, at), FONT_REFERENCE_FORMAT) ===
		undefined
	) {
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

/**
 * A namespace-level `sounds.json`. Every event carries a `sounds` list whose
 * entries are a sound name string or an object with a `name`; both resolve
 * to `assets/<ns>/sounds/<name>.ogg`. `type` is `file` (the default) or
 * `event`; an event names another sound event and is not a file reference.
 */
export function checkSoundReferences(input: ResourceReferenceInput): void {
	const { rel, doc, sink, context } = input;
	if (allowedFormat(input, rel, SOUND_EVENT_FORMAT) === undefined) {
		return;
	}
	if (!isRecord(doc)) {
		skipShape(sink, rel, []);
		return;
	}
	const vanillaSounds = hasVanillaSounds(context);
	for (const event of Object.keys(doc)) {
		const definition = doc[event];
		const at = [event];
		if (!isRecord(definition)) {
			skipShape(sink, rel, at);
			continue;
		}
		const sounds = definition.sounds;
		if (!Array.isArray(sounds)) {
			skipShape(sink, rel, [...at, "sounds"]);
			continue;
		}
		for (let index = 0; index < sounds.length; index += 1) {
			checkSoundEntry(input, event, index, sounds[index], vanillaSounds);
		}
	}
}

/** One `sounds[]` entry: a name string, or an object with `name`/`type`. */
function checkSoundEntry(
	input: ResourceReferenceInput,
	event: string,
	index: number,
	entry: unknown,
	vanillaSounds: boolean,
): void {
	const { rel, context, sink } = input;
	const at = [event, "sounds", index];
	let name: string;
	if (typeof entry === "string") {
		name = entry;
	} else if (isRecord(entry)) {
		if (typeof entry.name !== "string") {
			skipShape(sink, rel, [...at, "name"]);
			return;
		}
		const type = entry.type;
		if (type === "event") {
			return;
		}
		if (type !== undefined && type !== "file") {
			skipAt(
				sink,
				pointerTarget(rel, [...at, "type"]),
				RESOURCE_REFERENCE_SKIP_REASONS.unexpectedShape,
				`sound type "${String(type)}" is not interpreted`,
			);
			return;
		}
		name = entry.name;
	} else {
		skipShape(sink, rel, at);
		return;
	}
	const field = `${event}.sounds[${index}]`;
	if (!isUsableLocation(sink, rel, field, name)) {
		return;
	}
	const parsed = parseResourceLocation(name);
	const leaf = parsed.path.endsWith(SOUND_EVENT_FACT.value.extension)
		? parsed.path
		: `${parsed.path}${SOUND_EVENT_FACT.value.extension}`;
	const target = `assets/${parsed.namespace}/${SOUND_EVENT_FACT.value.soundRoot}${leaf}`;
	const outcome = resolveFile(
		context,
		sink,
		rel,
		field,
		name,
		target,
		"resource-file",
	);
	if (outcome === "missing") {
		// A vanilla tree built from a client jar ships no sounds, so a
		// `minecraft:` miss against it proves nothing; treat it as an
		// external this scan cannot check, like having no vanilla tree.
		if (parsed.namespace === "minecraft" && !vanillaSounds) {
			sink.unresolved({
				kind: "resource-file",
				field,
				value: name,
				target,
				rel,
			});
			return;
		}
		sink.problem(
			"PACK_MISSING_ASSET",
			`sound event "${event}" entry ${index} "${name}" in "${rel}" has no sound at "${target}".`,
			rel,
		);
	}
}

/**
 * Post-effect passes. Each pass names a vertex and a fragment shader under
 * `shaders/`, and an input either names a render target (not a file) or a
 * texture `location` under `textures/effect/`.
 */
export function checkPostEffectReferences(input: ResourceReferenceInput): void {
	const { rel, doc, sink } = input;
	const packFormat = allowedFormat(input, rel, POST_EFFECT_FORMAT);
	if (packFormat === undefined) {
		return;
	}
	if (!isRecord(doc)) {
		skipShape(sink, rel, []);
		return;
	}
	const passes = doc.passes;
	if (!Array.isArray(passes)) {
		skipShape(sink, rel, ["passes"]);
		return;
	}
	for (let index = 0; index < passes.length; index += 1) {
		checkPostEffectPass(input, packFormat, index, passes[index]);
	}
}

function checkPostEffectPass(
	input: ResourceReferenceInput,
	packFormat: string,
	index: number,
	pass: unknown,
): void {
	const { rel, sink } = input;
	const at = ["passes", index];
	if (!isRecord(pass)) {
		skipShape(sink, rel, at);
		return;
	}
	const splitShaders =
		comparePackFormats(packFormat, POST_EFFECT_SPLIT_SHADERS_FORMAT) >= 0;
	if (splitShaders) {
		checkPostEffectShader(input, index, pass, "vertex_shader", "vsh");
		checkPostEffectShader(input, index, pass, "fragment_shader", "fsh");
	} else {
		checkPostEffectProgram(input, index, pass);
	}
	const inputs = pass.inputs;
	if (inputs === undefined) {
		return;
	}
	if (!Array.isArray(inputs)) {
		skipShape(sink, rel, [...at, "inputs"]);
		return;
	}
	for (let inputIndex = 0; inputIndex < inputs.length; inputIndex += 1) {
		checkPostEffectInput(input, index, inputIndex, inputs[inputIndex]);
	}
}

/**
 * Before pack format 55.0 a pass names one `program`, a shader program
 * document under `shaders/<path>.json`; that document names the .vsh and
 * .fsh files the game compiles.
 */
function checkPostEffectProgram(
	input: ResourceReferenceInput,
	passIndex: number,
	pass: Record<string, unknown>,
): void {
	const { rel, context, sink } = input;
	const value = pass.program;
	const at = ["passes", passIndex, "program"];
	if (typeof value !== "string") {
		skipShape(sink, rel, at);
		return;
	}
	const field = `passes[${passIndex}].program`;
	if (!isUsableLocation(sink, rel, field, value)) {
		return;
	}
	const parsed = parseResourceLocation(value);
	const leaf = parsed.path.endsWith(".json")
		? parsed.path
		: `${parsed.path}.json`;
	const target = `assets/${parsed.namespace}/${POST_EFFECT_FACT.value.shaderRoot}${leaf}`;
	const outcome = resolveFile(
		context,
		sink,
		rel,
		field,
		value,
		target,
		"resource-file",
	);
	if (outcome === "missing") {
		sink.problem(
			"PACK_MISSING_ASSET",
			`"${field}" "${value}" in "${rel}" has no shader program at "${target}".`,
			rel,
		);
	}
}

/** A pass shader id resolves under `shaders/` with the program extension. */
function checkPostEffectShader(
	input: ResourceReferenceInput,
	passIndex: number,
	pass: Record<string, unknown>,
	field: "vertex_shader" | "fragment_shader",
	extension: "vsh" | "fsh",
): void {
	const { rel, context, sink } = input;
	const value = pass[field];
	const at = ["passes", passIndex, field];
	if (typeof value !== "string") {
		skipShape(sink, rel, at);
		return;
	}
	const fieldPath = `passes[${passIndex}].${field}`;
	if (!isUsableLocation(sink, rel, fieldPath, value)) {
		return;
	}
	const parsed = parseResourceLocation(value);
	const leaf = parsed.path.endsWith(`.${extension}`)
		? parsed.path
		: `${parsed.path}.${extension}`;
	const target = `assets/${parsed.namespace}/${POST_EFFECT_FACT.value.shaderRoot}${leaf}`;
	const outcome = resolveFile(
		context,
		sink,
		rel,
		fieldPath,
		value,
		target,
		"resource-file",
	);
	if (outcome === "missing") {
		sink.problem(
			"PACK_MISSING_ASSET",
			`"${fieldPath}" "${value}" in "${rel}" has no shader at "${target}".`,
			rel,
		);
	}
}

/** A post-effect input with `location` names a texture under `effect/`. */
function checkPostEffectInput(
	input: ResourceReferenceInput,
	passIndex: number,
	inputIndex: number,
	entry: unknown,
): void {
	const { rel, context, sink } = input;
	const at = ["passes", passIndex, "inputs", inputIndex];
	if (!isRecord(entry)) {
		skipShape(sink, rel, at);
		return;
	}
	const location = entry.location;
	if (location === undefined) {
		return;
	}
	if (typeof location !== "string") {
		skipShape(sink, rel, [...at, "location"]);
		return;
	}
	const field = `passes[${passIndex}].inputs[${inputIndex}].location`;
	if (!isUsableLocation(sink, rel, field, location)) {
		return;
	}
	const parsed = parseResourceLocation(location);
	const leaf = parsed.path.endsWith(".png")
		? parsed.path
		: `${parsed.path}.png`;
	const target = `assets/${parsed.namespace}/${POST_EFFECT_FACT.value.textureRoot}${leaf}`;
	const outcome = resolveFile(
		context,
		sink,
		rel,
		field,
		location,
		target,
		"texture",
	);
	if (outcome === "missing") {
		sink.problem(
			"PACK_MISSING_TEXTURE",
			`"${field}" "${location}" in "${rel}" has no texture at "${target}".`,
			rel,
		);
	}
}

/**
 * Waypoint styles. Every `sprites[]` id gets the game's locator-bar prefix
 * and resolves as a GUI sprite under `textures/gui/sprites/`.
 */
export function checkWaypointStyleReferences(
	input: ResourceReferenceInput,
): void {
	const { rel, doc, sink } = input;
	if (allowedFormat(input, rel, WAYPOINT_STYLE_FORMAT) === undefined) {
		return;
	}
	if (!isRecord(doc)) {
		skipShape(sink, rel, []);
		return;
	}
	const sprites = doc.sprites;
	if (!Array.isArray(sprites)) {
		skipShape(sink, rel, ["sprites"]);
		return;
	}
	for (let index = 0; index < sprites.length; index += 1) {
		const value = sprites[index];
		const at = ["sprites", index];
		if (typeof value !== "string") {
			skipShape(sink, rel, at);
			continue;
		}
		const field = `sprites[${index}]`;
		if (!isUsableLocation(sink, rel, field, value)) {
			continue;
		}
		const parsed = parseResourceLocation(value);
		const leaf = parsed.path.endsWith(".png")
			? parsed.path
			: `${parsed.path}.png`;
		const target = `assets/${parsed.namespace}/${WAYPOINT_STYLE_FACT.value.spriteRoot}${WAYPOINT_SPRITE_PREFIX}${leaf}`;
		const outcome = resolveFile(
			input.context,
			sink,
			rel,
			field,
			value,
			target,
			"texture",
		);
		if (outcome !== "missing") {
			continue;
		}
		if (replacesGuiAtlas(input.context)) {
			skipAt(
				sink,
				pointerTarget(rel, at),
				RESOURCE_REFERENCE_SKIP_REASONS.guiAtlasCustomized,
			);
			continue;
		}
		sink.problem(
			"PACK_MISSING_TEXTURE",
			`"${field}" "${value}" in "${rel}" has no texture at "${target}".`,
			rel,
		);
	}
}
