import { McAssetError } from "../core/errors.ts";
import type { ProfileWarning, VersionedFact } from "./types.ts";

export interface ItemsAtlasValue {
	atlas: "items";
	mipmapped: false;
}

export interface BlockRenderPassValue {
	predictedClasses: ["solid", "cutout", "translucent"];
	forceTranslucentOverride: true;
}

export interface TextureMipmapValue {
	fields: ["mipmap_strategy", "alpha_cutoff_bias"];
}

export interface PngOnlyValue {
	format: "png";
}

/**
 * §95 compatibility facts as version-interval data. V0.1 keeps a single
 * version group keyed by packFormat so callers can already switch behavior
 * by passing packFormat; finer splits arrive with later Minecraft versions.
 */
export const ITEMS_ATLAS_FACT: VersionedFact<ItemsAtlasValue> = {
	fact: "items-atlas-separated",
	since: { packFormat: 75 },
	value: { atlas: "items", mipmapped: false },
	status: "verified",
	source: "Minecraft Java Edition 1.21.11 release notes",
	checkedAt: "2026-09-19",
};

export const BLOCK_RENDER_PASS_FACT: VersionedFact<BlockRenderPassValue> = {
	fact: "block-render-pass-auto",
	since: { packFormat: 75 },
	value: {
		predictedClasses: ["solid", "cutout", "translucent"],
		forceTranslucentOverride: true,
	},
	status: "verified",
	source: "Minecraft 26.1 release notes",
	checkedAt: "2026-09-19",
};

export const TEXTURE_MIPMAP_FACT: VersionedFact<TextureMipmapValue> = {
	fact: "texture-mipmap-strategy",
	since: { packFormat: 75 },
	value: { fields: ["mipmap_strategy", "alpha_cutoff_bias"] },
	status: "verified",
	source: "Minecraft Java Edition 1.21.11 release notes",
	checkedAt: "2026-09-19",
};

/**
 * The PNG-only texture rule still lacks an official source for its starting
 * pack format (§95). It stays in the table so the gap is visible, but it
 * only ever produces a warning, never an enforcement value.
 */
export const PNG_ONLY_FACT: VersionedFact<PngOnlyValue> = {
	fact: "texture-png-only",
	since: { packFormat: 75 },
	value: { format: "png" },
	status: "pending-source",
	source: "pending official source",
	checkedAt: "2026-09-19",
};

export const COMPAT_FACTS: VersionedFact<unknown>[] = [
	ITEMS_ATLAS_FACT,
	BLOCK_RENDER_PASS_FACT,
	TEXTURE_MIPMAP_FACT,
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

/** Pending-source entries (§95) surface as warnings only, never as errors. */
export function pendingSourceWarnings(): ProfileWarning[] {
	const out: ProfileWarning[] = [];
	for (const fact of COMPAT_FACTS) {
		if (fact.status !== "pending-source") {
			continue;
		}
		out.push({
			code: "PENDING_SOURCE_PNG_ONLY",
			level: "warning",
			message: `Compat fact "${fact.fact}" is pending an official source; reported as warning only.`,
		});
	}
	return out;
}
