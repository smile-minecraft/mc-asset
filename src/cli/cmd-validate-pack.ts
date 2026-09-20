import { readdir, stat } from "node:fs/promises";
import { McAssetError } from "../core/errors.ts";
import { type PackReport, scanPack } from "../validate/pack.ts";
import {
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { errorEnvelope, successEnvelope } from "./envelope.ts";
import { exitCodeForMcAssetError } from "./exit.ts";
import {
	formatVersionTarget,
	resolveVersionTarget,
} from "./version-options.ts";

export interface ValidatePackCommandOptions {
	minecraftVersion?: string | undefined;
	resourcePackVersion?: string | undefined;
}

/** Minimal human verdict: the JSON envelope is the primary output. */
export function formatHumanPackReport(report: PackReport): string {
	const lines = [
		`command: ${report.command}`,
		`path: ${report.path}`,
		`target: ${report.target}`,
		`verdict: ${report.verdict}`,
	];
	for (const finding of report.findings) {
		const where = finding.path === undefined ? "" : ` ${finding.path}:`;
		lines.push(`${finding.level} [${finding.code}]${where} ${finding.message}`);
	}
	return lines.join("\n");
}

function summarize(report: PackReport): string {
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
 * Read-only pack verdict command: scans the pack root, runs the pure
 * engine, prints the report. Exit 3 (VALIDATION_FAILED) means the tool
 * worked but the pack failed; every tool failure keeps its own exit code.
 * The pack tree is only read, never written, and no file flag exists.
 */
export async function runValidatePack(
	packPath: string | undefined,
	options: ValidatePackCommandOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({ json: globalJson, stdoutArtifact: false });
	let failed: PackReport | undefined;
	try {
		if (packPath === undefined || packPath === "") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"validate-pack needs a pack root path argument.",
			);
		}
		const target = resolveVersionTarget({
			minecraftVersion: options.minecraftVersion,
			resourcePackVersion: options.resourcePackVersion,
		});
		try {
			const root = await stat(packPath);
			if (!root.isDirectory()) {
				throw new McAssetError(
					"FILESYSTEM_ERROR",
					`Pack root is not a directory: ${packPath}.`,
				);
			}
			await readdir(packPath);
		} catch (error) {
			if (error instanceof McAssetError) {
				throw error;
			}
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Cannot read pack root: ${packPath}.`,
			);
		}
		const targetSummary = formatVersionTarget(target);
		const report = await scanPack(packPath, {
			packFormat: target.packFormat,
			target: targetSummary,
		});
		if (report.verdict === "fail") {
			failed = report;
			throw new McAssetError("VALIDATION_FAILED", summarize(report));
		}
		if (globalJson) {
			emitEnvelope(successEnvelope(report), streams, route);
		} else {
			emitLog(formatHumanPackReport(report), streams, route);
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
					emitLog(
						`${formatHumanPackReport(failed)}\nerror [VALIDATION_FAILED] ${message}`,
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
