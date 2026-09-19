import process from "node:process";
import { McAssetError } from "../core/errors.ts";
import { emitEnvelope, emitLog, routeStreams } from "./channels.ts";
import { errorEnvelope } from "./envelope.ts";
import { exitCodeForMcAssetError } from "./exit.ts";
import { buildProgram } from "./program.ts";

function isCommanderDisplayError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false;
	}
	const code = (error as { code?: unknown }).code;
	return code === "commander.helpDisplayed" || code === "commander.version";
}

/** CLI entry: `bun src/cli/index.ts`. Commander owns --help/--version. */
async function main(): Promise<void> {
	const program = buildProgram();
	try {
		await program.parseAsync(process.argv);
	} catch (error) {
		if (isCommanderDisplayError(error)) {
			return;
		}
		const wantsJson = process.argv.includes("--json");
		const streams = { stdout: process.stdout, stderr: process.stderr };
		const route = routeStreams({ json: wantsJson, stdoutArtifact: false });
		if (error instanceof McAssetError) {
			if (wantsJson) {
				const message = error.message.replace(/^\[[A-Z_]+\] /, "");
				emitEnvelope(
					errorEnvelope(error.code, message, error.details),
					streams,
					route,
				);
			} else {
				emitLog(error.message, streams, route);
			}
			process.exitCode = exitCodeForMcAssetError(error);
			return;
		}
		const asError = error instanceof Error ? error : new Error(String(error));
		const code = (error as { code?: unknown }).code;
		const exitCode =
			code === "commander.unknownOption" ||
			code === "commander.missingArgument" ||
			code === "commander.excessArguments" ||
			code === "commander.invalidArgument"
				? 2
				: 1;
		if (wantsJson) {
			emitEnvelope(
				errorEnvelope(
					exitCode === 2 ? "INVALID_ARGUMENT" : "INTERNAL_ERROR",
					asError.message,
				),
				streams,
				route,
			);
		} else {
			emitLog(asError.message, streams, route);
		}
		process.exitCode = exitCode;
	}
}

await main();
