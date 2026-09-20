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

export interface ResourcePackFormatValue {
	format: "97.1";
}

export interface PngOnlyValue {
	format: "png";
}

/**
 * §95 compatibility facts as version-interval data. Facts whose starting
 * packFormat is confirmed carry it in `since`; facts still waiting on a
 * version mapping (§95 table rows 1-2 and 6-8) leave `since` empty and only
 * ever produce warnings. A packFormat of 75 on the 1.21.11 rows repeats
 * the §95 structural example, not a verified version mapping, so later
 * steps must not treat it as a version boundary.
 */
export const RESOURCE_PACK_FORMAT_FACT: VersionedFact<ResourcePackFormatValue> =
	{
		fact: "resource-pack-format",
		since: {},
		value: { format: "97.1" },
		status: "verified",
		source:
			"§95; Minecraft Wiki `Template:Resource pack format` (Java Edition 26.3)",
		checkedAt: "2026-09-19",
	};

export const TRIM_PALETTE_FACT: VersionedFact<TrimPaletteValue> = {
	fact: "trim-palette-location",
	since: {},
	value: {
		from: "textures/trim/color_palettes/",
		to: "textures/palettes/trim/",
	},
	status: "verified",
	source:
		"§95; Minecraft Wiki `Template:Resource pack format` (26.3 / RP 97.1)",
	checkedAt: "2026-09-19",
};

export const ITEMS_ATLAS_FACT: VersionedFact<ItemsAtlasValue> = {
	fact: "items-atlas-separated",
	since: { packFormat: 75 },
	value: { atlas: "items", mipmapped: false },
	status: "verified",
	source: "§95; Minecraft Java Edition 1.21.11 release notes",
	checkedAt: "2026-09-19",
};

export const ITEM_ATLAS_PLACEMENT_FACT: VersionedFact<AtlasPlacementValue> = {
	fact: "item-same-atlas-block-blocks-atlas",
	since: { packFormat: 75 },
	value: { itemSameAtlas: true, blockAtlas: "blocks" },
	status: "verified",
	source: "§95; Minecraft Java Edition 1.21.11 release notes",
	checkedAt: "2026-09-19",
};

export const TEXTURE_MIPMAP_FACT: VersionedFact<TextureMipmapValue> = {
	fact: "texture-mipmap-fields",
	since: { packFormat: 75 },
	value: { fields: ["mipmap_strategy", "alpha_cutoff_bias"] },
	status: "verified",
	source: "§95; Minecraft Java Edition 1.21.11 release notes",
	checkedAt: "2026-09-19",
};

export const BLOCK_RENDER_PASS_FACT: VersionedFact<BlockRenderPassValue> = {
	fact: "block-render-pass-auto",
	since: {},
	value: {
		predictedClasses: ["solid", "cutout", "translucent"],
	},
	status: "verified",
	source: "§95; Minecraft 26.1 release notes",
	checkedAt: "2026-09-19",
};

export const BLOCK_FORCE_TRANSLUCENT_FACT: VersionedFact<BlockForceTranslucentValue> =
	{
		fact: "block-force-translucent",
		since: {},
		value: { field: "force_translucent", entryForm: "object" },
		status: "verified",
		source: "§95; Minecraft 26.1 release notes",
		checkedAt: "2026-09-19",
	};

/**
 * The PNG-only texture rule still lacks an official source for its starting
 * pack format (§95). It stays in the table so the gap is visible, but it
 * only ever produces a warning, never an enforcement value.
 */
export const PNG_ONLY_FACT: VersionedFact<PngOnlyValue> = {
	fact: "texture-png-only",
	since: {},
	value: { format: "png" },
	status: "pending-source",
	source: "§95; pending official source",
	checkedAt: "2026-09-19",
};

export const COMPAT_FACTS: VersionedFact<unknown>[] = [
	RESOURCE_PACK_FORMAT_FACT,
	TRIM_PALETTE_FACT,
	ITEMS_ATLAS_FACT,
	ITEM_ATLAS_PLACEMENT_FACT,
	TEXTURE_MIPMAP_FACT,
	BLOCK_RENDER_PASS_FACT,
	BLOCK_FORCE_TRANSLUCENT_FACT,
	PNG_ONLY_FACT,
];

export function validatePackFormat(packFormat: number): number {
	if (
		typeof packFormat !== "number" ||
		!Number.isInteger(packFormat) ||
		packFormat < 1
	) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"packFormat must be a positive integer.",
			{ packFormat },
		);
	}
	return packFormat;
}

export function isFactActive<Value>(
	fact: VersionedFact<Value>,
	packFormat: number,
): boolean {
	validatePackFormat(packFormat);
	if (fact.since.packFormat === undefined) {
		return false;
	}
	return packFormat >= fact.since.packFormat;
}

export function resolveVersionedFact<Value>(
	fact: VersionedFact<Value>,
	packFormat: number,
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
	packFormat: number,
): { preferredAtlas: "items"; mipmapped: false } | undefined {
	const value = resolveVersionedFact(ITEMS_ATLAS_FACT, packFormat);
	if (value === undefined) {
		return undefined;
	}
	return { preferredAtlas: value.atlas, mipmapped: value.mipmapped };
}

/**
 * Gated facts (§95) surface as warnings only, never as errors: pending-source
 * entries plus facts whose since.packFormat is still undetermined.
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
