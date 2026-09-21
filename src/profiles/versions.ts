import { McAssetError } from "../core/errors.ts";
import type { ProfileWarning, VersionedFact } from "./types.ts";

export interface ItemsAtlasValue {
	atlas: "items";
	mipmapped: false;
}

export interface AtlasPlacementValue {
	itemSameAtlas: true;
	blockAtlas: "blocks";
}

export interface BlockRenderPassValue {
	predictedClasses: ["solid", "cutout", "translucent"];
}

export interface BlockForceTranslucentValue {
	field: "force_translucent";
	entryForm: "object";
}

export interface TextureMipmapValue {
	fields: ["mipmap_strategy", "alpha_cutoff_bias"];
}

export interface TrimPaletteValue {
	from: "textures/trim/color_palettes/";
	to: "textures/palettes/trim/";
}

export interface PngOnlyValue {
	format: "png";
}

export interface ItemModelDefinitionsValue {
	directory: "items/";
}

/**
 * §95 compatibility facts as version-interval data. Every fact carries its
 * sourced starting packFormat in `since` as a dotted string; the
 * version-to-format mapping itself lives in the version table
 * (`src/cli/version-options.ts`), which supersedes the retired
 * resource-pack-format fact. All eight facts are determined as of
 * 2026-09-21; `pendingSourceWarnings` stays as the guard for any future
 * undetermined fact.
 */
export const TRIM_PALETTE_FACT: VersionedFact<TrimPaletteValue> = {
	fact: "trim-palette-location",
	since: { packFormat: "97.1" },
	value: {
		from: "textures/trim/color_palettes/",
		to: "textures/palettes/trim/",
	},
	status: "verified",
	source:
		"§95; Minecraft Wiki Template:Resource pack format (26.3-snap1 / RP 97.1)",
	checkedAt: "2026-09-20",
};

export const ITEMS_ATLAS_FACT: VersionedFact<ItemsAtlasValue> = {
	fact: "items-atlas-separated",
	since: { packFormat: "75.0" },
	value: { atlas: "items", mipmapped: false },
	status: "verified",
	source:
		"§95; Minecraft Java Edition 1.21.11 release notes; Minecraft Wiki Template:Resource pack format (1.21.11 / RP 75.0)",
	checkedAt: "2026-09-20",
};

export const ITEM_ATLAS_PLACEMENT_FACT: VersionedFact<AtlasPlacementValue> = {
	fact: "item-same-atlas-block-blocks-atlas",
	since: { packFormat: "75.0" },
	value: { itemSameAtlas: true, blockAtlas: "blocks" },
	status: "verified",
	source:
		"§95; Minecraft Java Edition 1.21.11 release notes; Minecraft Wiki Template:Resource pack format (1.21.11 / RP 75.0)",
	checkedAt: "2026-09-20",
};

export const TEXTURE_MIPMAP_FACT: VersionedFact<TextureMipmapValue> = {
	fact: "texture-mipmap-fields",
	since: { packFormat: "75.0" },
	value: { fields: ["mipmap_strategy", "alpha_cutoff_bias"] },
	status: "verified",
	source:
		"§95; Minecraft Java Edition 1.21.11 release notes; Minecraft Wiki Template:Resource pack format (1.21.11 / RP 75.0)",
	checkedAt: "2026-09-20",
};

export const BLOCK_RENDER_PASS_FACT: VersionedFact<BlockRenderPassValue> = {
	fact: "block-render-pass-auto",
	since: { packFormat: "84.0" },
	value: {
		predictedClasses: ["solid", "cutout", "translucent"],
	},
	status: "verified",
	source:
		"§95; Minecraft 26.1 release notes; Minecraft Wiki Java Edition 26.1 (Block model)",
	checkedAt: "2026-09-20",
};

export const BLOCK_FORCE_TRANSLUCENT_FACT: VersionedFact<BlockForceTranslucentValue> =
	{
		fact: "block-force-translucent",
		since: { packFormat: "84.0" },
		value: { field: "force_translucent", entryForm: "object" },
		status: "verified",
		source:
			"§95; Minecraft 26.1 release notes; Minecraft Wiki Java Edition 26.1 (Block model)",
		checkedAt: "2026-09-20",
	};

export const PNG_ONLY_FACT: VersionedFact<PngOnlyValue> = {
	fact: "texture-png-only",
	since: { packFormat: "22.0" },
	value: { format: "png" },
	status: "verified",
	source:
		"§95; Minecraft Wiki Template:Resource pack format (1.20.3 / RP 22.0)",
	checkedAt: "2026-09-20",
};

export const ITEM_MODEL_DEFINITIONS_FACT: VersionedFact<ItemModelDefinitionsValue> =
	{
		fact: "item-model-definitions",
		since: { packFormat: "46.0" },
		value: { directory: "items/" },
		status: "verified",
		source: "§95; Minecraft Wiki Items model definition (1.21.4 / RP 46.0)",
		checkedAt: "2026-09-21",
	};

export const COMPAT_FACTS: VersionedFact<unknown>[] = [
	TRIM_PALETTE_FACT,
	ITEMS_ATLAS_FACT,
	ITEM_ATLAS_PLACEMENT_FACT,
	TEXTURE_MIPMAP_FACT,
	BLOCK_RENDER_PASS_FACT,
	BLOCK_FORCE_TRANSLUCENT_FACT,
	PNG_ONLY_FACT,
	ITEM_MODEL_DEFINITIONS_FACT,
];

/**
 * Validate and normalize a dotted resource-pack format to major.minor
 * (e.g. "75" becomes "75.0", "97.1" stays "97.1"). Only N or N.M digit
 * forms with a major of at least 1 count; anything else ("abc", "0",
 * "1.") is INVALID_ARGUMENT.
 */
export function normalizePackFormat(raw: string): string {
	const trimmed = raw.trim();
	const dotted = /^(\d+)\.(\d+)$/.exec(trimmed);
	const whole = /^(\d+)$/.exec(trimmed);
	if (dotted === null && whole === null) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`packFormat must be N or N.M digits (for example "75" or "97.1").`,
			{ packFormat: raw },
		);
	}
	const major = Number((dotted?.[1] ?? whole?.[1]) as string);
	const minor = dotted === null ? 0 : Number(dotted[2] as string);
	if (!Number.isSafeInteger(major) || major < 1) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`packFormat must be N or N.M digits (for example "75" or "97.1").`,
			{ packFormat: raw },
		);
	}
	return `${major}.${minor}`;
}

function parsePackFormatTuple(value: string): [number, number] {
	const match = /^(\d+)\.(\d+)$/.exec(value.trim());
	if (match === null) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`packFormat must be a normalized major.minor string (for example "75.0").`,
			{ packFormat: value },
		);
	}
	return [Number(match[1]), Number(match[2])];
}

/**
 * Tuple-order comparison over (major, minor): numeric, never lexical, so
 * "9.0" still sorts below "75.0". Shared by the CLI and the engine.
 */
export function comparePackFormats(a: string, b: string): number {
	const [aMajor, aMinor] = parsePackFormatTuple(a);
	const [bMajor, bMinor] = parsePackFormatTuple(b);
	if (aMajor !== bMajor) {
		return aMajor - bMajor;
	}
	return aMinor - bMinor;
}

export function isFactActive<Value>(
	fact: VersionedFact<Value>,
	packFormat: string,
): boolean {
	normalizePackFormat(packFormat);
	if (fact.since.packFormat === undefined) {
		return false;
	}
	return comparePackFormats(packFormat, fact.since.packFormat) >= 0;
}

export function resolveVersionedFact<Value>(
	fact: VersionedFact<Value>,
	packFormat: string,
): Value | undefined {
	if (!isFactActive(fact, packFormat)) {
		return undefined;
	}
	if (fact.status === "pending-source") {
		return undefined;
	}
	return fact.value;
}

export function getItemAtlasPolicy(
	packFormat: string,
): { preferredAtlas: "items"; mipmapped: false } | undefined {
	const value = resolveVersionedFact(ITEMS_ATLAS_FACT, packFormat);
	if (value === undefined) {
		return undefined;
	}
	return { preferredAtlas: value.atlas, mipmapped: value.mipmapped };
}

/**
 * Gated facts (§95) surface as warnings only, never as errors: pending-source
 * entries plus facts whose since.packFormat is still undetermined. Every
 * current fact is determined, so this naturally returns []; the mechanism
 * stays to guard any future undetermined fact.
 */
export function pendingSourceWarnings(): ProfileWarning[] {
	const out: ProfileWarning[] = [];
	for (const fact of COMPAT_FACTS) {
		if (fact.status === "pending-source") {
			out.push({
				code: "PENDING_SOURCE_PNG_ONLY",
				level: "warning",
				message: `Compat fact "${fact.fact}" is pending an official source; reported as warning only.`,
			});
		} else if (fact.since.packFormat === undefined) {
			out.push({
				code: "VERSION_FACT_UNDETERMINED",
				level: "warning",
				message: `Compat fact "${fact.fact}" has no determined since.packFormat; reported as warning only, never applied.`,
			});
		}
	}
	return out;
}
