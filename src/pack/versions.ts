import {
	resolveVersionTarget,
	SUPPORTED_MINECRAFT_VERSIONS,
} from "../cli/version-options.ts";

/**
 * Release-version lookup for a project target. The supported list and the
 * version-to-resource-pack mapping live with the CLI version flags; a
 * project target and a flag target are the same fact, so a project document
 * resolves its release version through that one table instead of keeping a
 * second copy that could drift.
 */

/**
 * Dotted resource pack format of a supported release version, or undefined
 * when the version table does not know the release. The caller decides the
 * refusal shape; an unknown release is refused, never guessed at.
 */
export function releasePackFormat(
	minecraftVersion: string,
): string | undefined {
	if (!SUPPORTED_MINECRAFT_VERSIONS.includes(minecraftVersion)) {
		return undefined;
	}
	return resolveVersionTarget({ minecraftVersion }).packFormat;
}
