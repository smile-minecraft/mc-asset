import { readFile } from "node:fs/promises";
import { McAssetError } from "../core/errors.ts";
import { decodePng } from "../io/png.ts";
import { type ValidateReport, validateCanvas } from "../validate/checks.ts";
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

export interface ValidateCommandOptions {
	profile?: string | undefined;
	minecraftVersion?: string | undefined;
	resourcePackVersion?: string | undefined;
}

export interface ValidateResult extends ValidateReport {
	version: {
		minecraftVersion?: string | undefined;
		resourcePackVersion?: string | undefined;
		packFormat?: number | undefined;
	};
	target: string;
}

/** Minimal human verdict: the JSON envelope is the primary output. */
export function formatHumanReport(report: ValidateReport): string {
	const lines = [
		`verdict: ${report.verdict}`,
		`dimensions: ${report.dimensions.width}x${report.dimensions.height}`,
		`colors: ${report.colorCount}`,
		`alpha: predicted ${report.alpha.predictedClassification} (opaque=${report.alpha.opaquePixels} transparent=${report.alpha.transparentPixels} partial=${report.alpha.partialAlphaPixels})`,
		`profile: ${report.profile.predictedDescription}`,
	];
	for (const finding of report.findings) {
		lines.push(`${finding.level} [${finding.code}] ${finding.message}`);
	}
	return lines.join("\n");
}

function summarize(report: ValidateReport): string {
	let errors = 0;
	let warnings = 0;
	for (const finding of report.findings) {
		if (finding.level === "error") {
			errors += 1;
		} else {
			warnings += 1;
		}
	}
	return `validation failed: ${errors} error(s), ${warnings} warning(s).`;
}

/**
 * Read-only verdict command: reads the input file, runs the pure engine,
 * prints the report. Exit 3 (VALIDATION_FAILED) means the tool worked but
 * the asset failed; every tool failure keeps its own exit code. The input
 * file is only read, never written.
 */
export async function runValidate(
	asset: string | undefined,
	options: ValidateCommandOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({ json: globalJson, stdoutArtifact: false });
	let failed: ValidateReport | undefined;
	try {
		if (asset === undefined || asset === "") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"validate needs an asset path argument.",
			);
		}
		const profile = parseProfile(options.profile);
		const target = resolveVersionTarget({
			minecraftVersion: options.minecraftVersion,
			resourcePackVersion: options.resourcePackVersion,
		});
		let input: Uint8Array;
		try {
			input = new Uint8Array(await readFile(asset));
		} catch {
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Cannot read input: ${asset}.`,
			);
		}
		const decoded = decodePng(input);
		const version = versionReportShape(target);
		const targetSummary = formatVersionTarget(target);
		const report: ValidateReport = validateCanvas(decoded.canvas, {
			profile,
			packFormat: target.packFormat,
			sourceWarnings: decoded.warnings,
			filename: asset,
		});
		const result: ValidateResult = {
			...report,
			version,
			target: targetSummary,
		};
		if (report.verdict === "fail") {
			failed = result;
			throw new McAssetError("VALIDATION_FAILED", summarize(report));
		}
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
					error.code === "VALIDATION_FAILED" && failed !== undefined
						? errorEnvelope(error.code, message, undefined, failed)
						: errorEnvelope(error.code, message, error.details),
					streams,
					route,
				);
			} else {
				if (error.code === "VALIDATION_FAILED" && failed !== undefined) {
					const targetLine =
						"target" in failed && typeof failed.target === "string"
							? `\ntarget: ${failed.target}`
							: "";
					emitLog(
						`${formatHumanReport(failed)}${targetLine}\nerror [VALIDATION_FAILED] ${message}`,
						streams,
						route,
					);
				} else {
					emitLog(`error [${error.code}] ${message}`, streams, route);
				}
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
