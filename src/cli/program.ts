import process from "node:process";
import { Command } from "commander";
import { McAssetError } from "../core/errors.ts";
import { VERSION } from "../index.ts";
import { type AnalyzeCommandOptions, runAnalyze } from "./analyze.ts";
import {
	emitArtifact,
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { type BuildOptions, runBuild } from "./cmd-build.ts";
import { type ImportOptions, runImport } from "./cmd-import.ts";
import { type RenderOptions, runRender } from "./cmd-render.ts";
import { errorEnvelope, successEnvelope } from "./envelope.ts";
import { exitCodeForMcAssetError } from "./exit.ts";
import { atomicWriteFile } from "./filesystem.ts";
import { resolveOutputTarget } from "./output-guard.ts";
import { parseProfile } from "./profiles.ts";
import { runValidate, type ValidateCommandOptions } from "./validate.ts";

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

/** Program skeleton: global --json plus the write commands and analyze. */
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

	program
		.command("analyze <image>")
		.description(
			"Analyze an image and print a read-only report (predicted classification, never effective).",
		)
		.option(
			"--profile <name>",
			"Asset profile (V0.1: generic, minecraft:item, minecraft:block).",
		)
		.action(
			async (
				image: string,
				options: AnalyzeCommandOptions,
				command: Command,
			) => {
				const globals = command.optsWithGlobals<{ json?: boolean }>();
				const code = await runAnalyze(
					image,
					options,
					globals.json === true,
					realStreams(),
				);
				process.exitCode = code;
			},
		);

	program
		.command("validate <asset>")
		.description(
			"Validate an asset file and print a read-only verdict (exit 3 when the asset fails).",
		)
		.option(
			"--profile <name>",
			"Asset profile (V0.1: generic, minecraft:item, minecraft:block).",
		)
		.action(
			async (
				asset: string,
				options: ValidateCommandOptions,
				command: Command,
			) => {
				const globals = command.optsWithGlobals<{ json?: boolean }>();
				const code = await runValidate(
					asset,
					options,
					globals.json === true,
					realStreams(),
				);
				process.exitCode = code;
			},
		);

	program
		.command("import <image>")
		.description("Decode a raster image into PNG and/or editable .mcpx.")
		.option("--output <path>", "Explicit PNG output file path.")
		.option("--stdout", "Write PNG bytes to stdout.")
		.option("--source <path>", "Write the editable .mcpx source file.")
		.option("--force", "Allow overwriting an existing output file.")
		.option("--mkdir", "Create missing parent directories.")
		.option(
			"--in-place",
			"Write the PNG back to the input path (implies force for that target).",
		)
		.option("--input <path>", "Input path used with --in-place.")
		.option(
			"--profile <name>",
			"Asset profile (V0.1: generic, minecraft:item, minecraft:block).",
		)
		.option(
			"--operations <path>",
			'Batch operations JSON file ("-" reads stdin).',
		)
		.action(async (image: string, options: ImportOptions, command: Command) => {
			const globals = command.optsWithGlobals<{ json?: boolean }>();
			const code = await runImport(
				image,
				options,
				globals.json === true,
				realStreams(),
			);
			process.exitCode = code;
		});

	program
		.command("render <grid>")
		.description(
			"Render a hand-authored ASCII Grid file into PNG and/or .mcpx.",
		)
		.option("--output <path>", "Explicit PNG output file path.")
		.option("--stdout", "Write PNG bytes to stdout.")
		.option("--source <path>", "Write the editable .mcpx source file.")
		.option("--force", "Allow overwriting an existing output file.")
		.option("--mkdir", "Create missing parent directories.")
		.option(
			"--in-place",
			"Write the PNG back to the input path (implies force for that target).",
		)
		.option("--input <path>", "Input path used with --in-place.")
		.option(
			"--profile <name>",
			"Asset profile (V0.1: generic, minecraft:item, minecraft:block).",
		)
		.option(
			"--operations <path>",
			'Batch operations JSON file ("-" reads stdin).',
		)
		.action(async (grid: string, options: RenderOptions, command: Command) => {
			const globals = command.optsWithGlobals<{ json?: boolean }>();
			const code = await runRender(
				grid,
				options,
				globals.json === true,
				realStreams(),
			);
			process.exitCode = code;
		});

	program
		.command("build [source]")
		.description("Build a .mcpx source file (or stdin) into PNG and/or .mcpx.")
		.option("--stdin", "Read the .mcpx source from stdin.")
		.option("--output <path>", "Explicit PNG output file path.")
		.option("--stdout", "Write PNG bytes to stdout.")
		.option("--source <path>", "Write the re-serialized .mcpx source file.")
		.option("--force", "Allow overwriting an existing output file.")
		.option("--mkdir", "Create missing parent directories.")
		.option(
			"--in-place",
			"Rewrite the input .mcpx with the new source (implies force for that target).",
		)
		.option("--input <path>", "Input path used with --in-place.")
		.option(
			"--profile <name>",
			"Asset profile (V0.1: generic, minecraft:item, minecraft:block).",
		)
		.option(
			"--operations <path>",
			'Batch operations JSON file ("-" reads stdin).',
		)
		.action(
			async (
				source: string | undefined,
				options: BuildOptions,
				command: Command,
			) => {
				const globals = command.optsWithGlobals<{ json?: boolean }>();
				const code = await runBuild(
					source,
					options,
					globals.json === true,
					realStreams(),
				);
				process.exitCode = code;
			},
		);

	return program;
}
