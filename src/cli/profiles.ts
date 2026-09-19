import { McAssetError } from "../core/errors.ts";

/** Frozen V0.1 profile set per section 104.3. No --preset flag exists. */
export const SUPPORTED_PROFILES = [
	"generic",
	"minecraft:item",
	"minecraft:block",
] as const;

export type SupportedProfile = (typeof SUPPORTED_PROFILES)[number];

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
		`Unknown profile "${value}". V0.1 supports: ${SUPPORTED_PROFILES.join(", ")}.`,
	);
}
