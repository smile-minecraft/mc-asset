import { type AnalyzeReport, analyzeCanvas } from "../analyze/metrics.ts";
import { McAssetError } from "../core/errors.ts";
import { loadRasterCanvas } from "./canvas-input.ts";
import {
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { errorEnvelope, successEnvelope } from "./envelope.ts";
import { exitCodeForMcAssetError } from "./exit.ts";
import { parseProfile } from "./profiles.ts";
import {
	formatVersionTarget,
	resolveVersionTarget,
	versionReportShape,
} from "./version-options.ts";

export interface AnalyzeCommandOptions {
	profile?: string | undefined;
	minecraftVersion?: string | undefined;
	resourcePackVersion?: string | undefined;
}

export interface AnalyzeResult extends AnalyzeReport {
	version: {
		minecraftVersion?: string | undefined;
		resourcePackVersion?: string | undefined;
		packFormat?: number | undefined;
	};
	target: string;
}

/** Minimal human report: the JSON envelope is the primary output. */
export function formatHumanReport(report: AnalyzeReport): string {
	const pixelArt = report.pixelArtCharacteristics;
	const palette = report.paletteCharacteristics;
	const recommended = report.recommended;
	const cleanup =
		recommended.cleanup.classes.length > 0
			? recommended.cleanup.classes.join(",")
			: "none";
	const lines = [
		`dimensions: ${report.dimensions.width}x${report.dimensions.height}`,
		`colors: ${report.colorCount}`,
		`alpha: predicted ${report.alpha.predictedClassification} (opaque=${report.alpha.opaquePixels} transparent=${report.alpha.transparentPixels} partial=${report.alpha.partialAlphaPixels})`,
		`dominant: ${report.dominantColors.map((entry) => `${entry.hex} x${entry.count} (${entry.ratio})`).join(", ")}`,
		`profile: ${report.profile.predictedDescription}`,
		`palette: colorCount=${palette.colorCount} alphaLevels=${palette.alphaLevels} transparent=${palette.transparentPixels} partial=${palette.partialAlphaPixels}`,
		`pixel-art: ${pixelArt.resolution.width}x${pixelArt.resolution.height} aspect=${pixelArt.aspect} isolated=${pixelArt.isolatedPixels} semiTransparent=${pixelArt.semiTransparentPixels} tileFriendly=${pixelArt.tileFriendly}`,
		`recommended: quantize.colors=${recommended.quantize.colors} cleanup=${cleanup} resize=${recommended.resize.mode}`,
	];
	if (report.warnings.length > 0) {
		for (const warning of report.warnings) {
			lines.push(`warning [${warning.code}] ${warning.message}`);
		}
	}
	return lines.join("\n");
}

/**
 * Read-only report command: reads the input file, runs the pure engine,
 * prints the report. The input file is only read, never written. Raster
 * intake accepts PNG, JPEG, and WebP; .mcpx sources are rejected as
 * UNSUPPORTED_IMAGE_FORMAT.
 */
export async function runAnalyze(
	image: string | undefined,
	options: AnalyzeCommandOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({ json: globalJson, stdoutArtifact: false });
	try {
		if (image === undefined || image === "") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"analyze needs an image path argument.",
			);
		}
		const profile = parseProfile(options.profile);
		const target = resolveVersionTarget({
			minecraftVersion: options.minecraftVersion,
			resourcePackVersion: options.resourcePackVersion,
		});
		const loaded = await loadRasterCanvas(image);
		const report = analyzeCanvas(loaded.canvas, {
			profile,
			packFormat: target.packFormat,
			sourceWarnings: loaded.warnings,
		});
		const version = versionReportShape(target);
		const targetSummary = formatVersionTarget(target);
		const result: AnalyzeResult = {
			...report,
			version,
			target: targetSummary,
		};
		if (globalJson) {
			emitEnvelope(successEnvelope(result), streams, route);
		} else {
			emitLog(
				`${formatHumanReport(report)}\ntarget: ${targetSummary}`,
				streams,
				route,
			);
		}
		return 0;
	} catch (error) {
		if (error instanceof McAssetError) {
			const message = error.message.replace(/^\[[A-Z_]+\] /, "");
			if (globalJson) {
				emitEnvelope(
					errorEnvelope(error.code, message, error.details),
					streams,
					route,
				);
			} else {
				emitLog(`error [${error.code}] ${message}`, streams, route);
			}
			return exitCodeForMcAssetError(error);
		}
		if (error instanceof Error) {
			if (globalJson) {
				emitEnvelope(
					errorEnvelope("INTERNAL_ERROR", error.message),
					streams,
					route,
				);
			} else {
				emitLog(`error [INTERNAL_ERROR] ${error.message}`, streams, route);
			}
			return 1;
		}
		const message = String(error);
		if (globalJson) {
			emitEnvelope(errorEnvelope("INTERNAL_ERROR", message), streams, route);
		} else {
			emitLog(`error [INTERNAL_ERROR] ${message}`, streams, route);
		}
		return 1;
	}
}
