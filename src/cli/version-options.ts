import { McAssetError } from "../core/errors.ts";
import { normalizePackFormat } from "../profiles/versions.ts";

/**
 * Version-flag resolution for analyze/validate (§73, §95).
 *
 * Supported Minecraft targets run from Java Edition release 1.19.3 through
 * 26.3, each mapped onto its dotted resource-pack format. The engine
 * packFormat is a normalized major.minor string ("75" input becomes "75.0"),
 * and --resource-pack-version accepts N or N.M forms directly.
 */

/**
 * Single ordered source for supported releases: [minecraftVersion,
 * packFormat] entries (design §2). The supported list and the lookup map
 * below both derive from it.
 */
const MINECRAFT_VERSION_PACK_FORMAT_ENTRIES = [
	["1.19.3", "12.0"],
	["1.19.4", "13.0"],
	["1.20", "15.0"],
	["1.20.1", "15.0"],
	["1.20.2", "18.0"],
	["1.20.3", "22.0"],
	["1.20.4", "22.0"],
	["1.20.5", "32.0"],
	["1.20.6", "32.0"],
	["1.21", "34.0"],
	["1.21.1", "34.0"],
	["1.21.2", "42.0"],
	["1.21.3", "42.0"],
	["1.21.4", "46.0"],
	["1.21.5", "55.0"],
	["1.21.6", "63.0"],
	["1.21.7", "64.0"],
	["1.21.8", "64.0"],
	["1.21.9", "69.0"],
	["1.21.10", "69.0"],
	["1.21.11", "75.0"],
	["26.1", "84.0"],
	["26.1.1", "84.0"],
	["26.1.2", "84.0"],
	["26.2", "88.0"],
	["26.3", "97.1"],
] as const;

export const SUPPORTED_MINECRAFT_VERSIONS: ReadonlyArray<string> =
	MINECRAFT_VERSION_PACK_FORMAT_ENTRIES.map(([version]) => version);

export type SupportedMinecraftVersion =
	(typeof MINECRAFT_VERSION_PACK_FORMAT_ENTRIES)[number][0];

/** Minecraft version onto dotted resource-pack format (design §2). */
const MINECRAFT_VERSION_RESOURCE_PACK: Record<string, string> =
	Object.fromEntries(MINECRAFT_VERSION_PACK_FORMAT_ENTRIES);

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
				`Unsupported --minecraft-version "${minecraftVersion}". Supported release versions 1.19.3 through 26.3 (for example "1.19.3", "1.21.4", "26.3").`,
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
