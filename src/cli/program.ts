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
import { type AnimateOptions, runAnimate } from "./cmd-animate.ts";
import { type BuildOptions, runBuild } from "./cmd-build.ts";
import { type CleanupOptions, runCleanup } from "./cmd-cleanup.ts";
import { type GenerateOptions, runGenerate } from "./cmd-generate.ts";
import { type ImportOptions, runImport } from "./cmd-import.ts";
import { type MaterialOptions, runMaterial } from "./cmd-material.ts";
import { runMcp } from "./cmd-mcp.ts";
import { type PaletteOptions, runPalette } from "./cmd-palette.ts";
import {
	type PixelizeCommandOptions,
	runPixelizeCommand,
} from "./cmd-pixelize.ts";
import { type PreviewOptions, runPreview } from "./cmd-preview.ts";
import { type QuantizeOptions, runQuantize } from "./cmd-quantize.ts";
import { type RecolorOptions, runRecolor } from "./cmd-recolor.ts";
import { type RenderOptions, runRender } from "./cmd-render.ts";
import { runTile, type TileOptions } from "./cmd-tile.ts";
import { runTransform, type TransformOptions } from "./cmd-transform.ts";
import {
	runValidatePack,
	type ValidatePackCommandOptions,
} from "./cmd-validate-pack.ts";
import { runVariant, type VariantOptions } from "./cmd-variant.ts";
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

/**
 * Reject a repeated version flag at parse time: commander keeps the last
 * value silently, but the version contract treats repetition as
 * INVALID_ARGUMENT, so each flag may appear at most once per invocation.
 */
function singleUseOption(flag: string): (value: string) => string {
	let seen = false;
	return (value: string): string => {
		if (seen) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				`Duplicate ${flag}: specify it at most once.`,
			);
		}
		seen = true;
		return value;
	};
}

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
		.description("Pixel-native Minecraft asset toolchain.")
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
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
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
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.option(
			"--minecraft-version <version>",
			"Target Minecraft version (e.g. 26.3).",
			singleUseOption("--minecraft-version"),
		)
		.option(
			"--resource-pack-version <version>",
			"Target resource packFormat as a positive integer (e.g. 75).",
			singleUseOption("--resource-pack-version"),
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
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.option(
			"--minecraft-version <version>",
			"Target Minecraft version (e.g. 26.3).",
			singleUseOption("--minecraft-version"),
		)
		.option(
			"--resource-pack-version <version>",
			"Target resource packFormat as a positive integer (e.g. 75).",
			singleUseOption("--resource-pack-version"),
		)
		.option(
			"--mcmeta <path>",
			"Explicit mcmeta path for texture and animation checks; a sibling file is never derived.",
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
		.command("validate-pack <path>")
		.description(
			"Validate a resource pack directory and print a read-only verdict (exit 3 when the pack fails).",
		)
		.option(
			"--minecraft-version <version>",
			"Target Minecraft version (e.g. 26.3).",
			singleUseOption("--minecraft-version"),
		)
		.option(
			"--resource-pack-version <version>",
			"Target resource packFormat as a positive integer (e.g. 75).",
			singleUseOption("--resource-pack-version"),
		)
		.action(
			async (
				path: string,
				options: ValidatePackCommandOptions,
				command: Command,
			) => {
				const globals = command.optsWithGlobals<{ json?: boolean }>();
				const code = await runValidatePack(
					path,
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
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
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
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
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
		.command("transform <input>")
		.description(
			"Apply exactly one geometry operation (flip, rotate, crop, pad, resize, translate).",
		)
		.option("--flip <direction>", "Mirror horizontally (h) or vertically (v).")
		.option("--rotate <degrees>", "Rotate by 90, 180, or 270 degrees.")
		.option("--crop <x,y,w,h>", "Crop to an integer rectangle.")
		.option("--pad <l,t,r,b>", "Pad every side by integer amounts.")
		.option(
			"--pad-color <color>",
			"Pad fill (transparent, #RRGGBB, #RRGGBBAA).",
		)
		.option("--resize <WxH>", "Resize to WxH integer dimensions.")
		.option(
			"--resize-mode <mode>",
			"Resize sampling (nearest, box, pixel-aware).",
		)
		.option("--translate <dx,dy>", "Shift contents by integer offsets.")
		.option("--output <path>", "Explicit PNG output file path.")
		.option("--stdout", "Write PNG bytes to stdout.")
		.option("--source <path>", "Write the editable .mcpx source file.")
		.option("--force", "Allow overwriting an existing output file.")
		.option("--mkdir", "Create missing parent directories.")
		.option(
			"--in-place",
			"Rewrite the input in its own kind (implies force for that target).",
		)
		.option("--input <path>", "Input path used with --in-place.")
		.option(
			"--profile <name>",
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.option(
			"--selection <scope>",
			"Rejected with geometry (ARGUMENT_CONFLICT).",
		)
		.action(
			async (input: string, options: TransformOptions, command: Command) => {
				const globals = command.optsWithGlobals<{ json?: boolean }>();
				const code = await runTransform(
					input,
					options,
					globals.json === true,
					realStreams(),
				);
				process.exitCode = code;
			},
		);

	program
		.command("quantize <input>")
		.description("Reduce the color count with the integer median-cut.")
		.option("--colors <n>", "Required color budget, an integer in [1, 4096].")
		.option("--output <path>", "Explicit PNG output file path.")
		.option("--stdout", "Write PNG bytes to stdout.")
		.option("--source <path>", "Write the editable .mcpx source file.")
		.option("--force", "Allow overwriting an existing output file.")
		.option("--mkdir", "Create missing parent directories.")
		.option(
			"--in-place",
			"Rewrite the input in its own kind (implies force for that target).",
		)
		.option("--input <path>", "Input path used with --in-place.")
		.option(
			"--profile <name>",
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.option(
			"--selection <scope>",
			"Scope pixel writes (rect:<x>,<y>,<w>,<h> or region:<id>).",
		)
		.action(
			async (input: string, options: QuantizeOptions, command: Command) => {
				const globals = command.optsWithGlobals<{ json?: boolean }>();
				const code = await runQuantize(
					input,
					options,
					globals.json === true,
					realStreams(),
				);
				process.exitCode = code;
			},
		);

	program
		.command("cleanup <input>")
		.description(
			"Detect pixel defects; fix only the --fix classes with explicit authorization.",
		)
		.option(
			"--fix <classes>",
			"Comma list of isolated, noise, cluster, fringe, outlier, hole, aa. Omitted means detect and report only.",
		)
		.option("--allow-render-pass-change", "Authorize alpha-affecting classes.")
		.option("--output <path>", "Explicit PNG output file path.")
		.option("--stdout", "Write PNG bytes to stdout.")
		.option("--source <path>", "Write the editable .mcpx source file.")
		.option("--force", "Allow overwriting an existing output file.")
		.option("--mkdir", "Create missing parent directories.")
		.option(
			"--in-place",
			"Rewrite the input in its own kind (implies force for that target).",
		)
		.option("--input <path>", "Input path used with --in-place.")
		.option(
			"--profile <name>",
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.option(
			"--selection <scope>",
			"Scope pixel writes (rect:<x>,<y>,<w>,<h> or region:<id>).",
		)
		.action(
			async (input: string, options: CleanupOptions, command: Command) => {
				const globals = command.optsWithGlobals<{ json?: boolean }>();
				const code = await runCleanup(
					input,
					options,
					globals.json === true,
					realStreams(),
				);
				process.exitCode = code;
			},
		);

	const palette = program
		.command("palette")
		.description("Read-only palette reports (no artifact files).");
	palette
		.command("extract <image>")
		.description("Report the distinct colors as an authoring palette.")
		.option("--output <path>", "Rejected: reports take no file flags.")
		.option("--stdout", "Rejected: reports take no file flags.")
		.option("--source <path>", "Rejected: reports take no file flags.")
		.option("--force", "Rejected: reports take no file flags.")
		.option("--mkdir", "Rejected: reports take no file flags.")
		.option("--in-place", "Rejected: reports take no file flags.")
		.option("--input <path>", "Rejected: reports take no file flags.")
		.option(
			"--profile <name>",
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.action(
			async (image: string, options: PaletteOptions, command: Command) => {
				const globals = command.optsWithGlobals<{ json?: boolean }>();
				const code = await runPalette(
					"extract",
					image,
					options,
					globals.json === true,
					realStreams(),
				);
				process.exitCode = code;
			},
		);
	palette
		.command("inspect <image>")
		.description("Report palette characteristics in the frozen shape.")
		.option("--output <path>", "Rejected: reports take no file flags.")
		.option("--stdout", "Rejected: reports take no file flags.")
		.option("--source <path>", "Rejected: reports take no file flags.")
		.option("--force", "Rejected: reports take no file flags.")
		.option("--mkdir", "Rejected: reports take no file flags.")
		.option("--in-place", "Rejected: reports take no file flags.")
		.option("--input <path>", "Rejected: reports take no file flags.")
		.option(
			"--profile <name>",
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.action(
			async (image: string, options: PaletteOptions, command: Command) => {
				const globals = command.optsWithGlobals<{ json?: boolean }>();
				const code = await runPalette(
					"inspect",
					image,
					options,
					globals.json === true,
					realStreams(),
				);
				process.exitCode = code;
			},
		);

	const material = program
		.command("material")
		.description("Read-only material queries (no artifact files).");
	material
		.command("list")
		.description("List the builtin material ids in registry order.")
		.option("--output <path>", "Rejected: reports take no file flags.")
		.option("--stdout", "Rejected: reports take no file flags.")
		.option("--source <path>", "Rejected: reports take no file flags.")
		.option("--force", "Rejected: reports take no file flags.")
		.option("--mkdir", "Rejected: reports take no file flags.")
		.option("--in-place", "Rejected: reports take no file flags.")
		.option("--input <path>", "Rejected: reports take no file flags.")
		.option(
			"--profile <name>",
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.action(async (options: MaterialOptions, command: Command) => {
			const globals = command.optsWithGlobals<{ json?: boolean }>();
			const code = await runMaterial(
				"list",
				undefined,
				options,
				globals.json === true,
				realStreams(),
			);
			process.exitCode = code;
		});
	material
		.command("show <name>")
		.description("Show one builtin material definition.")
		.option("--output <path>", "Rejected: reports take no file flags.")
		.option("--stdout", "Rejected: reports take no file flags.")
		.option("--source <path>", "Rejected: reports take no file flags.")
		.option("--force", "Rejected: reports take no file flags.")
		.option("--mkdir", "Rejected: reports take no file flags.")
		.option("--in-place", "Rejected: reports take no file flags.")
		.option("--input <path>", "Rejected: reports take no file flags.")
		.option(
			"--profile <name>",
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.action(
			async (name: string, options: MaterialOptions, command: Command) => {
				const globals = command.optsWithGlobals<{ json?: boolean }>();
				const code = await runMaterial(
					"show",
					name,
					options,
					globals.json === true,
					realStreams(),
				);
				process.exitCode = code;
			},
		);

	program
		.command("recolor <source>")
		.description("Recolor an editable .mcpx source with a builtin material.")
		.option("--material <name>", "Required builtin material id.")
		.option("--region <id>", "Limit the write to one region id.")
		.option("--output <path>", "Explicit PNG output file path.")
		.option("--stdout", "Write PNG bytes to stdout.")
		.option("--source <path>", "Write the editable .mcpx source file.")
		.option("--force", "Allow overwriting an existing output file.")
		.option("--mkdir", "Create missing parent directories.")
		.option(
			"--in-place",
			"Rewrite the input .mcpx (implies force for that target).",
		)
		.option("--input <path>", "Input path used with --in-place.")
		.option(
			"--profile <name>",
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.option(
			"--selection <scope>",
			"Scope pixel writes (rect:<x>,<y>,<w>,<h> or region:<id>).",
		)
		.action(
			async (source: string, options: RecolorOptions, command: Command) => {
				const globals = command.optsWithGlobals<{ json?: boolean }>();
				const code = await runRecolor(
					source,
					options,
					globals.json === true,
					realStreams(),
				);
				process.exitCode = code;
			},
		);

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
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
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

	program
		.command("pixelize <image>")
		.description("Run a reference image through the pixelize pipeline.")
		.option("--size <size>", "Output size: 16, 32, 64, 128, or WxH.")
		.option(
			"--preset <name>",
			"Processing preset: item, block, generic, gui, particle.",
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
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.option(
			"--selection <scope>",
			"Rejected with pixelize (ARGUMENT_CONFLICT).",
		)
		.action(
			async (
				image: string,
				options: PixelizeCommandOptions,
				command: Command,
			) => {
				const globals = command.optsWithGlobals<{ json?: boolean }>();
				const code = await runPixelizeCommand(
					image,
					options,
					globals.json === true,
					realStreams(),
				);
				process.exitCode = code;
			},
		);

	program
		.command("variant <source>")
		.description("Recolor an editable .mcpx source into per-material variants.")
		.option("--materials <list>", "Comma-separated builtin material ids.")
		.option("--output-dir <path>", "Required explicit output directory.")
		.option("--output <path>", "Rejected on variant (ARGUMENT_CONFLICT).")
		.option("--force", "Allow overwriting existing variant files.")
		.option("--mkdir", "Create missing parent directories.")
		.option(
			"--profile <name>",
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.action(
			async (source: string, options: VariantOptions, command: Command) => {
				const globals = command.optsWithGlobals<{ json?: boolean }>();
				const code = await runVariant(
					source,
					options,
					globals.json === true,
					realStreams(),
				);
				process.exitCode = code;
			},
		);

	program
		.command("tile <input>")
		.description(
			"Analyze block-texture seams and repetition; optionally write a corrected tile or an NxN preview PNG.",
		)
		.option("--preview <size>", "Repeat preview size: 2x2, 4x4, or 8x8.")
		.option(
			"--edge-match <axis>",
			"Align seam edge pixels: horizontal, vertical, or both.",
		)
		.option(
			"--brightness-match <axis>",
			"Align seam edge brightness: horizontal, vertical, or both.",
		)
		.option("--output <path>", "Explicit PNG output file path.")
		.option("--stdout", "Write PNG bytes to stdout.")
		.option("--force", "Allow overwriting an existing output file.")
		.option("--mkdir", "Create missing parent directories.")
		.option("--input <path>", "Input path aliasing the positional input.")
		.option(
			"--profile <name>",
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.action(async (input: string, options: TileOptions, command: Command) => {
			const globals = command.optsWithGlobals<{ json?: boolean }>();
			const code = await runTile(
				input,
				options,
				globals.json === true,
				realStreams(),
			);
			process.exitCode = code;
		});

	program
		.command("generate <pattern>")
		.description(
			"Synthesize a deterministic pattern swatch from a palette and seed.",
		)
		.option("--size <size>", "Required canvas size: N or WxH.")
		.option(
			"--palette <name|path>",
			"Required builtin material id or .mcpx palette path.",
		)
		.option("--seed <int>", "Required integer seed in [0, 4294967295].")
		.option("--output <path>", "Explicit PNG output file path.")
		.option("--stdout", "Write PNG bytes to stdout.")
		.option("--source <path>", "Write the editable .mcpx source file.")
		.option("--force", "Allow overwriting an existing output file.")
		.option("--mkdir", "Create missing parent directories.")
		.option(
			"--profile <name>",
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.action(
			async (pattern: string, options: GenerateOptions, command: Command) => {
				const globals = command.optsWithGlobals<{ json?: boolean }>();
				const code = await runGenerate(
					pattern,
					options,
					globals.json === true,
					realStreams(),
				);
				process.exitCode = code;
			},
		);

	program
		.command("preview <input>")
		.description(
			"Preview an image as a .grid-compatible ASCII document, a palette map report, a scaled PNG, or a nine-slice border report.",
		)
		.option(
			"--ascii",
			"Report the flattened canvas as a .grid-compatible ASCII document.",
		)
		.option("--palette-map", "Report the palette map JSON.")
		.option(
			"--scale <N>",
			"Integer nearest-neighbor upscale factor; needs --output or --stdout.",
		)
		.option(
			"--nine-slice",
			"Report the mcmeta nine-slice geometry, or write a 1:1 border-guide PNG with --output or --stdout; needs --mcmeta.",
		)
		.option(
			"--mcmeta <path>",
			"Explicit mcmeta path for --nine-slice; a sibling file is never derived.",
		)
		.option("--output <path>", "Explicit PNG output file path.")
		.option("--stdout", "Write PNG bytes to stdout.")
		.option("--force", "Allow overwriting an existing output file.")
		.option("--mkdir", "Create missing parent directories.")
		.option("--input <path>", "Input path aliasing the positional input.")
		.option(
			"--profile <name>",
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.action(
			async (input: string, options: PreviewOptions, command: Command) => {
				const globals = command.optsWithGlobals<{ json?: boolean }>();
				const code = await runPreview(
					input,
					options,
					globals.json === true,
					realStreams(),
				);
				process.exitCode = code;
			},
		);

	const animate = program
		.command("animate")
		.description(
			"FrameSet animation: pack / unpack / reorder / resize / validate / preview.",
		);
	animate
		.command("pack")
		.description("Pack a frames directory into a sprite sheet PNG.")
		.option("--frames-dir <dir>", "Frames directory (one .mcpx per frame).")
		.option("--layout <layout>", "Sheet layout: vertical, horizontal, grid.")
		.option("--columns <N>", "Grid column count (required with grid).")
		.option("--output <path>", "Explicit PNG output file path.")
		.option("--stdout", "Write PNG bytes to stdout.")
		.option("--force", "Allow overwriting an existing output file.")
		.option("--mkdir", "Create missing parent directories.")
		.option(
			"--profile <name>",
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.action(async (options: AnimateOptions, command: Command) => {
			const globals = command.optsWithGlobals<{ json?: boolean }>();
			const code = await runAnimate(
				"pack",
				undefined,
				options,
				globals.json === true,
				realStreams(),
			);
			process.exitCode = code;
		});
	animate
		.command("unpack <sheet>")
		.description("Unpack a sprite sheet PNG into a frames directory.")
		.option("--layout <layout>", "Sheet layout: vertical, horizontal, grid.")
		.option("--frame-size <size>", "Frame size: N or WxH.")
		.option("--columns <N>", "Grid column count (required with grid).")
		.option("--output-dir <path>", "Required explicit output directory.")
		.option("--output <path>", "Rejected on unpack (ARGUMENT_CONFLICT).")
		.option(
			"--mcmeta <path>",
			"Explicit mcmeta path for the frame geometry guard; a sibling file is never derived.",
		)
		.option("--force", "Allow overwriting existing frame files.")
		.option("--mkdir", "Create missing parent directories.")
		.option(
			"--profile <name>",
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.action(
			async (sheet: string, options: AnimateOptions, command: Command) => {
				const globals = command.optsWithGlobals<{ json?: boolean }>();
				const code = await runAnimate(
					"unpack",
					sheet,
					options,
					globals.json === true,
					realStreams(),
				);
				process.exitCode = code;
			},
		);
	animate
		.command("reorder")
		.description("Reorder a frames directory with an explicit permutation.")
		.option("--frames-dir <dir>", "Frames directory (one .mcpx per frame).")
		.option("--order <list>", "Permutation of [0, count), e.g. 2,0,1.")
		.option("--output-dir <path>", "Required explicit output directory.")
		.option("--output <path>", "Rejected on reorder (ARGUMENT_CONFLICT).")
		.option("--force", "Allow overwriting existing frame files.")
		.option("--mkdir", "Create missing parent directories.")
		.option(
			"--profile <name>",
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.action(async (options: AnimateOptions, command: Command) => {
			const globals = command.optsWithGlobals<{ json?: boolean }>();
			const code = await runAnimate(
				"reorder",
				undefined,
				options,
				globals.json === true,
				realStreams(),
			);
			process.exitCode = code;
		});
	animate
		.command("resize")
		.description("Resize every frame in a frames directory.")
		.option("--frames-dir <dir>", "Frames directory (one .mcpx per frame).")
		.option("--frame-size <size>", "Target frame size: N or WxH.")
		.option(
			"--resize-mode <mode>",
			"Resize sampling (nearest, box). Default nearest.",
		)
		.option("--output-dir <path>", "Required explicit output directory.")
		.option("--output <path>", "Rejected on resize (ARGUMENT_CONFLICT).")
		.option("--force", "Allow overwriting existing frame files.")
		.option("--mkdir", "Create missing parent directories.")
		.option(
			"--profile <name>",
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.action(async (options: AnimateOptions, command: Command) => {
			const globals = command.optsWithGlobals<{ json?: boolean }>();
			const code = await runAnimate(
				"resize",
				undefined,
				options,
				globals.json === true,
				realStreams(),
			);
			process.exitCode = code;
		});
	animate
		.command("validate")
		.description("Read-only geometry check of a frames directory.")
		.option("--frames-dir <dir>", "Frames directory (one .mcpx per frame).")
		.option(
			"--mcmeta <path>",
			"Explicit mcmeta path for the frame correspondence check; a sibling file is never derived.",
		)
		.option("--output <path>", "Rejected: reports take no file flags.")
		.option("--stdout", "Rejected: reports take no file flags.")
		.option("--output-dir <path>", "Rejected: reports take no file flags.")
		.option("--force", "Rejected: reports take no file flags.")
		.option("--mkdir", "Rejected: reports take no file flags.")
		.option(
			"--profile <name>",
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.action(async (options: AnimateOptions, command: Command) => {
			const globals = command.optsWithGlobals<{ json?: boolean }>();
			const code = await runAnimate(
				"validate",
				undefined,
				options,
				globals.json === true,
				realStreams(),
			);
			process.exitCode = code;
		});
	animate
		.command("preview")
		.description("Read-only animation structure report, or sheet ASCII.")
		.option("--frames-dir <dir>", "Frames directory (one .mcpx per frame).")
		.option("--layout <layout>", "Sheet layout: vertical, horizontal, grid.")
		.option("--columns <N>", "Grid column count (required with grid).")
		.option("--ascii", "Sheet pixels as a .grid-compatible ASCII document.")
		.option("--output <path>", "Rejected: reports take no file flags.")
		.option("--stdout", "Rejected: reports take no file flags.")
		.option("--output-dir <path>", "Rejected: reports take no file flags.")
		.option("--force", "Rejected: reports take no file flags.")
		.option("--mkdir", "Rejected: reports take no file flags.")
		.option(
			"--profile <name>",
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.action(async (options: AnimateOptions, command: Command) => {
			const globals = command.optsWithGlobals<{ json?: boolean }>();
			const code = await runAnimate(
				"preview",
				undefined,
				options,
				globals.json === true,
				realStreams(),
			);
			process.exitCode = code;
		});

	program
		.command("mcp")
		.description("Start the MCP server over stdio (tool surface for agents).")
		.action(async () => {
			const code = await runMcp();
			process.exitCode = code;
		});

	return program;
}
