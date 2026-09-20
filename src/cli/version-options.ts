import { McAssetError } from "../core/errors.ts";
import { validatePackFormat } from "../profiles/versions.ts";

/**
 * V0.1 version-flag resolution for analyze/validate (§73, §95).
 *
 * The spec verifies a single Minecraft target: Java Edition 26.3 with
 * Resource Pack Format 97.1 (§95 table, source
 * "Minecraft Wiki `Template:Resource pack format`"). The engine keeps one
 * version group keyed by integer packFormat 75 (the §95 structural example
 * `{ fact, since: { packFormat }, value }`), so V0.1 maps the sole
 * supported `--minecraft-version` onto that group and accepts integer
 * `--resource-pack-version` values through the existing
 * `validatePackFormat` check. Dotted resource-pack versions (including
 * "97.1" itself) stay unsupported until the full version-fact layer lands:
 * they are not positive integers, so they fail here with INVALID_ARGUMENT
 * instead of being silently truncated. Multi-group splits and atlas/pack
 * validators are later work; the no-flag pack.mcmeta fallback
 * (pack.pack_format as target, warning with no default otherwise) lives
 * in the validate-pack engine, never here.
 */

export const SUPPORTED_MINECRAFT_VERSIONS = ["26.3"] as const;

export type SupportedMinecraftVersion =
	(typeof SUPPORTED_MINECRAFT_VERSIONS)[number];

/** V0.1 single-group mapping: 26.3 exercises the packFormat 75 facts. */
const MINECRAFT_VERSION_PACK_FORMAT: Record<string, number> = {
	"26.3": 75,
};

/** Resource Pack Format recorded alongside 26.3 in the §95 table. */
const MINECRAFT_VERSION_RESOURCE_PACK: Record<string, string> = {
	"26.3": "97.1",
};

export interface VersionFlagOptions {
	minecraftVersion?: string | undefined;
	resourcePackVersion?: string | undefined;
}

export interface ResolvedVersionTarget {
	packFormat: number | undefined;
	minecraftVersion: string | undefined;
	resourcePackVersion: string | undefined;
}

export interface VersionReportShape {
	minecraftVersion?: string | undefined;
	resourcePackVersion?: string | undefined;
	packFormat?: number | undefined;
}

function fail(message: string): never {
	throw new McAssetError("INVALID_ARGUMENT", message);
}

/**
 * Resolve at most one version flag to an engine packFormat plus the
 * display echo. No flags means engine defaults. Both flags together,
 * an unknown Minecraft version, or a non-integer resource-pack version
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
		const packFormat = MINECRAFT_VERSION_PACK_FORMAT[minecraftVersion];
		if (packFormat === undefined) {
			fail(
				`Unsupported --minecraft-version "${minecraftVersion}". V0.1 supports: ${SUPPORTED_MINECRAFT_VERSIONS.join(", ")}.`,
			);
		}
		const resourcePack = MINECRAFT_VERSION_RESOURCE_PACK[minecraftVersion];
		return {
			packFormat,
			minecraftVersion,
			resourcePackVersion: resourcePack,
		};
	}
	if (resourcePackVersion !== undefined) {
		if (!/^[0-9]+$/.test(resourcePackVersion.trim())) {
			fail(
				`Invalid --resource-pack-version "${resourcePackVersion}". V0.1 takes a positive integer packFormat (for example "75"); dotted versions such as "97.1" arrive with the full version-fact layer, so target 26.3 via --minecraft-version instead.`,
			);
		}
		const packFormat = validatePackFormat(Number(resourcePackVersion.trim()));
		return {
			packFormat,
			minecraftVersion: undefined,
			resourcePackVersion: resourcePackVersion.trim(),
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
	if (target.packFormat !== undefined) {
		shape.packFormat = target.packFormat;
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
	if (target.packFormat !== undefined) {
		parts.push(`packFormat ${target.packFormat}`);
	}
	return parts.join(" / ");
}
