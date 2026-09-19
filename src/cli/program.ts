import process from "node:process";
import { Command } from "commander";
import { McAssetError } from "../core/errors.ts";
import { VERSION } from "../index.ts";
import {
	emitArtifact,
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { errorEnvelope, successEnvelope } from "./envelope.ts";
import { exitCodeForMcAssetError } from "./exit.ts";
import { atomicWriteFile } from "./filesystem.ts";
import { resolveOutputTarget } from "./output-guard.ts";
import { parseProfile } from "./profiles.ts";

export interface StubOptions {
	output?: string | undefined;
	stdout?: boolean | undefined;
	inPlace?: boolean | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
	profile?: string | undefined;
	input?: string | undefined;
}

const STUB_ARTIFACT_PREFIX = "stub-ok";

function realStreams(): OutputStreams {
	return { stdout: process.stdout, stderr: process.stderr };
}

function toErrorEnvelope(error: unknown): {
	code: "INTERNAL_ERROR" | McAssetError["code"];
	message: string;
	details: unknown;
} {
	if (error instanceof McAssetError) {
		const message = error.message.replace(/^\[[A-Z_]+\] /, "");
		return { code: error.code, message, details: error.details };
	}
	if (error instanceof Error) {
		return {
			code: "INTERNAL_ERROR",
			message: error.message,
			details: undefined,
		};
	}
	return { code: "INTERNAL_ERROR", message: String(error), details: undefined };
}

/**
 * Mount-probe stub: exercises the section 98 framework (output guard,
 * atomic write, channel routing, exit wiring) with a fixed payload so
 * later commands can copy the wiring. Product logic lives in t08.
 */
export async function runStub(
	options: StubOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({
		json: globalJson,
		stdoutArtifact: options.stdout === true,
	});
	try {
		const profile = parseProfile(options.profile);
		const target = resolveOutputTarget({
			output: options.output,
			stdout: options.stdout,
			inPlace: options.inPlace,
			force: options.force,
			input: options.input,
		});
		const artifact = new TextEncoder().encode(
			`${STUB_ARTIFACT_PREFIX} profile=${profile}\n`,
		);
		if (target.mode === "stdout") {
			emitArtifact(artifact, streams, route);
			if (globalJson) {
				emitEnvelope(
					successEnvelope({ profile, mode: "stdout" }),
					streams,
					route,
				);
			} else {
				emitLog(`ok stub profile=${profile}`, streams, route);
			}
			return 0;
		}
		await atomicWriteFile(target.path, artifact, {
			force: options.force,
			mkdir: options.mkdir,
		});
		if (globalJson) {
			emitEnvelope(
				successEnvelope({ profile, mode: "file", path: target.path }),
				streams,
				route,
			);
		} else {
			emitLog(`ok stub profile=${profile} path=${target.path}`, streams, route);
		}
		return 0;
	} catch (error) {
		const shaped = toErrorEnvelope(error);
		if (globalJson) {
			emitEnvelope(
				errorEnvelope(shaped.code, shaped.message, shaped.details),
				streams,
				route,
			);
		} else {
			emitLog(`error [${shaped.code}] ${shaped.message}`, streams, route);
		}
		if (error instanceof McAssetError) {
			return exitCodeForMcAssetError(error);
		}
		return 1;
	}
}

/** Program skeleton: global --json plus the stub mount point for t08. */
export function buildProgram(): Command {
	const program = new Command();
	program
		.name("mc-asset")
		.description("Pixel-native Minecraft asset toolchain (V0.1 CLI skeleton).")
		.version(VERSION)
		.option(
			"--json",
			"Emit a JSON envelope; logs and diagnostics go to stderr.",
		)
		.exitOverride();

	program
		.command("stub")
		.description("Framework mount probe used by CLI skeleton tests.")
		.option("--output <path>", "Explicit output file path.")
		.option("--stdout", "Write artifact bytes to stdout.")
		.option("--force", "Allow overwriting an existing output file.")
		.option("--mkdir", "Create missing parent directories.")
		.option(
			"--in-place",
			"Target the input path (implies output+force semantics).",
		)
		.option("--input <path>", "Input path used with --in-place.")
		.option(
			"--profile <name>",
			"Asset profile (V0.1: generic, minecraft:item, minecraft:block).",
		)
		.action(async (options: StubOptions, command: Command) => {
			const globals = command.optsWithGlobals<{ json?: boolean }>();
			const code = await runStub(options, globals.json === true, realStreams());
			process.exitCode = code;
		});

	return program;
}
