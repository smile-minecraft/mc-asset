import { McAssetError } from "../core/errors.ts";

/** Frozen profile set: generic plus the five Minecraft asset profiles. */
export const SUPPORTED_PROFILES = [
	"generic",
	"minecraft:item",
	"minecraft:block",
	"minecraft:gui",
	"minecraft:particle",
	"minecraft:entity",
] as const;

export type SupportedProfile = (typeof SUPPORTED_PROFILES)[number];

/**
 * The INVALID_PROFILE message is frozen byte-for-byte: `minecraft:entity`
 * is accepted as a pure addition and does not widen the printed list.
 */
const PRINTED_SUPPORTED_PROFILES = [
	"generic",
	"minecraft:item",
	"minecraft:block",
	"minecraft:gui",
	"minecraft:particle",
] as const;

function isSupportedProfile(value: string): value is SupportedProfile {
	return (SUPPORTED_PROFILES as readonly string[]).includes(value);
}

/** Omitted profile defaults to generic; anything else unknown is INVALID_PROFILE. */
export function parseProfile(value: string | undefined): SupportedProfile {
	if (value === undefined) {
		return "generic";
	}
	if (isSupportedProfile(value)) {
		return value;
	}
	throw new McAssetError(
		"INVALID_PROFILE",
		`Unknown profile "${value}". Supported: ${PRINTED_SUPPORTED_PROFILES.join(", ")}.`,
	);
}
