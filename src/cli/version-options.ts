import { McAssetError } from "../core/errors.ts";
import { normalizePackFormat } from "../profiles/versions.ts";

/**
 * Version-flag resolution for analyze/validate (§73, §95).
 *
 * Supported Minecraft targets run from Java Edition 1.21.11 through 26.3,
 * each mapped onto its dotted resource-pack format. The engine packFormat
 * is a normalized major.minor string ("75" input becomes "75.0"), and
 * --resource-pack-version accepts N or N.M forms directly.
 */

export const SUPPORTED_MINECRAFT_VERSIONS = [
	"1.21.11",
	"26.1",
	"26.1.1",
	"26.1.2",
	"26.2",
	"26.3",
] as const;

export type SupportedMinecraftVersion =
	(typeof SUPPORTED_MINECRAFT_VERSIONS)[number];

/** Minecraft version onto dotted resource-pack format (design §2.1). */
const MINECRAFT_VERSION_RESOURCE_PACK: Record<string, string> = {
	"1.21.11": "75.0",
	"26.1": "84.0",
	"26.1.1": "84.0",
	"26.1.2": "84.0",
	"26.2": "88.0",
	"26.3": "97.1",
};

export interface VersionFlagOptions {
	minecraftVersion?: string | undefined;
	resourcePackVersion?: string | undefined;
}

export interface ResolvedVersionTarget {
	packFormat: string | undefined;
	minecraftVersion: string | undefined;
	resourcePackVersion: string | undefined;
}

export interface VersionReportShape {
	minecraftVersion?: string | undefined;
	resourcePackVersion?: string | undefined;
}

function fail(message: string): never {
	throw new McAssetError("INVALID_ARGUMENT", message);
}

/**
 * Resolve at most one version flag to an engine packFormat plus the
 * display echo. No flags means engine defaults. Both flags together,
 * an unknown Minecraft version, or a malformed resource-pack version
 * are INVALID_ARGUMENT; the existing exit wiring maps that to exit 2.
 */
export function resolveVersionTarget(
	options: VersionFlagOptions,
): ResolvedVersionTarget {
	const minecraftVersion = options.minecraftVersion;
	const resourcePackVersion = options.resourcePackVersion;
	if (minecraftVersion !== undefined && resourcePackVersion !== undefined) {
		fail(
			"Use only one of --minecraft-version or --resource-pack-version, not both.",
		);
	}
	if (minecraftVersion !== undefined) {
		const resourcePack = MINECRAFT_VERSION_RESOURCE_PACK[minecraftVersion];
		if (resourcePack === undefined) {
			fail(
				`Unsupported --minecraft-version "${minecraftVersion}". Supported: ${SUPPORTED_MINECRAFT_VERSIONS.join(", ")}.`,
			);
		}
		return {
			packFormat: resourcePack,
			minecraftVersion,
			resourcePackVersion: resourcePack,
		};
	}
	if (resourcePackVersion !== undefined) {
		let packFormat: string;
		try {
			packFormat = normalizePackFormat(resourcePackVersion);
		} catch {
			fail(
				`Invalid --resource-pack-version "${resourcePackVersion}". Takes N or N.M (for example "84" or "97.1").`,
			);
		}
		return {
			packFormat,
			minecraftVersion: undefined,
			resourcePackVersion: packFormat,
		};
	}
	return {
		packFormat: undefined,
		minecraftVersion: undefined,
		resourcePackVersion: undefined,
	};
}

/** Report echo: only defined fields are kept, so the default is `{}`. */
export function versionReportShape(
	target: ResolvedVersionTarget,
): VersionReportShape {
	const shape: VersionReportShape = {};
	if (target.minecraftVersion !== undefined) {
		shape.minecraftVersion = target.minecraftVersion;
	}
	if (target.resourcePackVersion !== undefined) {
		shape.resourcePackVersion = target.resourcePackVersion;
	}
	return shape;
}

/** One-line target summary for the human report. */
export function formatVersionTarget(target: ResolvedVersionTarget): string {
	if (
		target.packFormat === undefined &&
		target.minecraftVersion === undefined &&
		target.resourcePackVersion === undefined
	) {
		return "default (engine defaults)";
	}
	const parts: string[] = [];
	if (target.minecraftVersion !== undefined) {
		parts.push(`minecraft ${target.minecraftVersion}`);
	}
	if (target.resourcePackVersion !== undefined) {
		parts.push(`resource-pack ${target.resourcePackVersion}`);
	}
	return parts.join(" / ");
}
