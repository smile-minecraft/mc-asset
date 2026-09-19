import { readFile } from "node:fs/promises";
import { type AnalyzeReport, analyzeCanvas } from "../analyze/metrics.ts";
import { McAssetError } from "../core/errors.ts";
import { decodePng } from "../io/png.ts";
import {
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { errorEnvelope, successEnvelope } from "./envelope.ts";
import { exitCodeForMcAssetError } from "./exit.ts";
import { parseProfile } from "./profiles.ts";

export interface AnalyzeCommandOptions {
	profile?: string | undefined;
}

/** Minimal human report: the JSON envelope is the primary output. */
export function formatHumanReport(report: AnalyzeReport): string {
	const lines = [
		`dimensions: ${report.dimensions.width}x${report.dimensions.height}`,
		`colors: ${report.colorCount}`,
		`alpha: predicted ${report.alpha.predictedClassification} (opaque=${report.alpha.opaquePixels} transparent=${report.alpha.transparentPixels} partial=${report.alpha.partialAlphaPixels})`,
		`dominant: ${report.dominantColors.map((entry) => `${entry.hex} x${entry.count} (${entry.ratio})`).join(", ")}`,
		`profile: ${report.profile.predictedDescription}`,
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
 * prints the report. The input file is only read, never written.
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
		let input: Uint8Array;
		try {
			input = new Uint8Array(await readFile(image));
		} catch {
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Cannot read input: ${image}.`,
			);
		}
		const decoded = decodePng(input);
		const report = analyzeCanvas(decoded.canvas, {
			profile,
			sourceWarnings: decoded.warnings,
		});
		if (globalJson) {
			emitEnvelope(successEnvelope(report), streams, route);
		} else {
			emitLog(formatHumanReport(report), streams, route);
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
