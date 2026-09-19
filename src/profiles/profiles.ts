import { McAssetError } from "../core/errors.ts";
import type { AssetProfile, AssetProfileId } from "./types.ts";
import { getItemAtlasPolicy, validatePackFormat } from "./versions.ts";

export const GENERIC_PROFILE: AssetProfile = {
	id: "generic",
	description:
		"Generic pixels without Minecraft-specific restrictions; predicted handling only.",
};

export const ITEM_PROFILE: AssetProfile = {
	id: "minecraft:item",
	preferredAtlas: "items",
	mipmapped: false,
	description:
		"Minecraft item texture for the separate items atlas without mipmaps; predicted handling only.",
};

export const BLOCK_PROFILE: AssetProfile = {
	id: "minecraft:block",
	preferredAtlas: "blocks",
	mipmapAware: true,
	alphaClassificationAware: true,
	description:
		"Minecraft block texture from the blocks atlas; mipmap-aware and predicted alpha-aware.",
};

const PROFILES: Record<AssetProfileId, AssetProfile> = {
	generic: GENERIC_PROFILE,
	"minecraft:item": ITEM_PROFILE,
	"minecraft:block": BLOCK_PROFILE,
};

export function listAssetProfileIds(): AssetProfileId[] {
	return ["generic", "minecraft:item", "minecraft:block"];
}

export function isAssetProfileId(value: unknown): value is AssetProfileId {
	return (
		value === "generic" ||
		value === "minecraft:item" ||
		value === "minecraft:block"
	);
}

export function getAssetProfile(id: string): AssetProfile {
	if (!isAssetProfileId(id)) {
		throw new McAssetError("INVALID_PROFILE", "Unknown asset profile.", {
			id,
		});
	}
	const profile = PROFILES[id];
	return { ...profile };
}

/**
 * One-line predicted narrative for reports. Always says predicted and never
 * claims the final in-game render result.
 */
export function describeAssetProfilePredicted(
	id: string,
	packFormat?: number,
): string {
	const profile = getAssetProfile(id);
	if (packFormat !== undefined) {
		validatePackFormat(packFormat);
	}
	if (profile.id === "minecraft:item") {
		const policy =
			packFormat === undefined ? undefined : getItemAtlasPolicy(packFormat);
		if (policy !== undefined) {
			return `predicted profile minecraft:item prefers the ${policy.preferredAtlas} atlas without mipmaps.`;
		}
		return "predicted profile minecraft:item prefers the items atlas without mipmaps.";
	}
	if (profile.id === "minecraft:block") {
		return "predicted profile minecraft:block uses the blocks atlas with mipmap-aware predicted alpha.";
	}
	return "predicted profile generic has no Minecraft-specific restrictions.";
}
