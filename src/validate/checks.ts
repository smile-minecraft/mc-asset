import {
	type AnalyzeAlphaSection,
	type AnalyzeReport,
	analyzeCanvas,
} from "../analyze/metrics.ts";
import type { PixelCanvas } from "../core/types.ts";
import type { PngWarning } from "../io/png.ts";
import { validateDiskFilename } from "./resource-location.ts";

/**
 * Basic validate engine. Pure and read-only: an analyze report plus
 * check rules fold into a verdict. The canvas is only read through the
 * analyze step, never written. No I/O, no timestamps, no randomness.
 */

export type ValidateVerdict = "pass" | "fail";

export type ValidateFindingLevel = "error" | "warning";

export interface ValidateFinding {
	code: string;
	level: ValidateFindingLevel;
	message: string;
}

export interface ValidateReport {
	verdict: ValidateVerdict;
	profile: { id: string; predictedDescription: string };
	dimensions: { width: number; height: number };
	totalPixels: number;
	colorCount: number;
	alpha: AnalyzeAlphaSection;
	findings: ValidateFinding[];
}

export interface ValidateOptions {
	profile?: string | undefined;
	packFormat?: string | undefined;
	/**
	 * Normalization notes from decodePng, forwarded to the analyze step so
	 * the engine stays pure: it never touches the file or the decoder.
	 */
	sourceWarnings?: PngWarning[] | undefined;
	/**
	 * Input path or bare filename for the filename check (§55). Omitted
	 * skips that check; anything else in the report still validates.
	 */
	filename?: string | undefined;
}

export interface ValidateReportOptions {
	filename?: string | undefined;
}

/**
 * Pixel-art hygiene heuristic, warning-only. There is no Minecraft
 * rule behind this number: textures are RGBA8 with no palette cap, so a
 * large distinct-color count only suggests the asset may not be
 * hand-authored pixel art. It MUST NOT fail validation.
 */
export const PALETTE_SIZE_WARN_THRESHOLD = 256;

const MINECRAFT_PROFILES: ReadonlyArray<string> = [
	"minecraft:item",
	"minecraft:block",
];

function basenameOf(path: string): string {
	const slash = path.lastIndexOf("/");
	const backslash = path.lastIndexOf("\\");
	const cut = slash > backslash ? slash : backslash;
	return cut < 0 ? path : path.slice(cut + 1);
}

/**
 * §34 / §55 filename check. Minecraft profiles only carry PNG textures
 * (the "minecraft profiles output PNG only" rule stands regardless of the
 * §95 pending source), so a non-.png name is an error there. The match is
 * exact lowercase: resource locations are case-sensitive, so `Sword.PNG`
 * is rejected the same as `tile.webp`. Generic has no Minecraft-specific
 * restrictions (§44) and skips this check entirely.
 */
function checkFilename(
	profileId: string,
	filename: string | undefined,
): ValidateFinding[] {
	if (filename === undefined) {
		return [];
	}
	if (!MINECRAFT_PROFILES.includes(profileId)) {
		return [];
	}
	const base = basenameOf(filename);
	if (base.endsWith(".png")) {
		return [];
	}
	return [
		{
			code: "FILENAME_EXTENSION_NOT_PNG",
			level: "error",
			message: `profile ${profileId} only carries PNG textures; expected a lowercase .png filename, got "${base}".`,
		},
	];
}

/**
 * §108.6 stem-level filename check. Minecraft profiles only (§44 leaves
 * generic unrestricted): an uppercase stem is PACK_CASE_MISMATCH, a stem
 * outside the conservative set is PACK_INVALID_FILENAME, both error. The
 * gate reuses the §34 profile list on purpose: widening it to gui/particle
 * would newly fail previously-passing assets and is out of scope here.
 */
function checkResourceFilename(
	profileId: string,
	filename: string | undefined,
): ValidateFinding[] {
	if (filename === undefined) {
		return [];
	}
	if (!MINECRAFT_PROFILES.includes(profileId)) {
		return [];
	}
	return validateDiskFilename(filename);
}

/**
 * Palette-size note. Warning-only by construction: see
 * PALETTE_SIZE_WARN_THRESHOLD for why this number is not a rule.
 */
function checkPaletteSize(colorCount: number): ValidateFinding[] {
	if (colorCount <= PALETTE_SIZE_WARN_THRESHOLD) {
		return [];
	}
	return [
		{
			code: "PALETTE_SIZE_LARGE",
			level: "warning",
			message: `distinct color count ${colorCount} exceeds the pixel-art hygiene note of ${PALETTE_SIZE_WARN_THRESHOLD}; not a Minecraft rule, the asset remains loadable.`,
		},
	];
}

/**
 * Fold one analyze report plus the basic checks into a verdict.
 * Analyze warnings (partial alpha, block resolution, pending-source,
 * gAMA / iCCP notes) merge verbatim with their warning level kept, so a
 * §95 pending-source entry can never become an error here. The verdict
 * fails only when an error-level finding exists.
 *
 * Notes on the §41 list: valid PNG, dimensions, and RGBA are established
 * before this function runs (decode normalizes every input to RGBA8 per
 * §101.2 and rejects bad bytes / out-of-range sizes itself). Those
 * failures surface as tool errors (exit 2 / 5), never as exit 3. What this
 * function adds is the per-profile verdict on top of a decodable asset.
 */
export function validateReport(
	report: AnalyzeReport,
	options: ValidateReportOptions,
): ValidateReport {
	const findings: ValidateFinding[] = [
		...checkFilename(report.profile.id, options.filename),
		...checkResourceFilename(report.profile.id, options.filename),
		...checkPaletteSize(report.colorCount),
	];
	for (const warning of report.warnings) {
		findings.push({
			code: warning.code,
			level: "warning",
			message: warning.message,
		});
	}
	const verdict: ValidateVerdict = findings.some(
		(finding) => finding.level === "error",
	)
		? "fail"
		: "pass";
	return {
		verdict,
		profile: { ...report.profile },
		dimensions: { ...report.dimensions },
		totalPixels: report.totalPixels,
		colorCount: report.colorCount,
		alpha: {
			...report.alpha,
			partialAlphaValues: [...report.alpha.partialAlphaValues],
		},
		findings,
	};
}

/**
 * Analyze the canvas, then fold the report into a verdict. Read-only end
 * to end: neither this function nor the analyze step writes the canvas.
 */
export function validateCanvas(
	canvas: PixelCanvas,
	options: ValidateOptions,
): ValidateReport {
	const report = analyzeCanvas(canvas, {
		profile: options.profile,
		packFormat: options.packFormat,
		sourceWarnings: options.sourceWarnings,
	});
	return validateReport(report, { filename: options.filename });
}
