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
import { type CompareCliOptions, runCompare } from "./cmd-compare.ts";
import { type GenerateOptions, runGenerate } from "./cmd-generate.ts";
import { type GuiScaleOptions, runGuiScale } from "./cmd-gui-scale.ts";
import { type ImportOptions, runImport } from "./cmd-import.ts";
import { type InspectOptions, runInspect } from "./cmd-inspect.ts";
import { type MaterialOptions, runMaterial } from "./cmd-material.ts";
import {
	type McmetaCliOptions,
	type McmetaMode,
	runMcmeta,
} from "./cmd-mcmeta.ts";
import { runMcp } from "./cmd-mcp.ts";
import { type ModelCliOptions, type ModelMode, runModel } from "./cmd-model.ts";
import { runOptimize } from "./cmd-optimize.ts";
import { type PackOptions, runPack } from "./cmd-pack.ts";
import { type PaletteOptions, runPalette } from "./cmd-palette.ts";
import {
	type PixelizeCommandOptions,
	runPixelizeCommand,
} from "./cmd-pixelize.ts";
import { type PreviewOptions, runPreview } from "./cmd-preview.ts";
import { type QuantizeOptions, runQuantize } from "./cmd-quantize.ts";
import { type RecolorOptions, runRecolor } from "./cmd-recolor.ts";
import { type RenderOptions, runRender } from "./cmd-render.ts";
import { runStyle, type StyleOptions } from "./cmd-style.ts";
import { runTile, type TileOptions } from "./cmd-tile.ts";
import { runTransform, type TransformOptions } from "./cmd-transform.ts";
import { runValidatePack } from "./cmd-validate-pack.ts";
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

export function realStreams(): OutputStreams {
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
/**
 * Process-independent entry: build the program, parse one argv, and map a
 * thrown error to the same envelope, log line, and exit code the CLI entry
 * uses. Tests inject memory streams so both runtimes exercise one path.
 */
export async function runCli(
	argv: readonly string[],
	streams: OutputStreams,
): Promise<number> {
	const program = buildProgram(streams);
	const wantsJson = argv.includes("--json");
	const route = routeStreams({ json: wantsJson, stdoutArtifact: false });
	try {
		await program.parseAsync([...argv]);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			((error as { code?: unknown }).code === "commander.helpDisplayed" ||
				(error as { code?: unknown }).code === "commander.version")
		) {
			return 0;
		}
		if (error instanceof McAssetError) {
			const message = error.message.replace(/^\[[A-Z_]+\] /, "");
			if (wantsJson) {
				emitEnvelope(
					errorEnvelope(error.code, message, error.details),
					streams,
					route,
				);
			} else {
				emitLog(error.message, streams, route);
			}
			return exitCodeForMcAssetError(error);
		}
		const asError = error instanceof Error ? error : new Error(String(error));
		const code = (error as { code?: unknown }).code;
		const exitCode =
			code === "commander.unknownOption" ||
			code === "commander.missingArgument" ||
			code === "commander.missingMandatoryOptionValue" ||
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
		return exitCode;
	}
	const code = typeof process.exitCode === "number" ? process.exitCode : 0;
	return code;
}

export function buildProgram(streams: OutputStreams = realStreams()): Command {
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

	// Internal mount probe: registered hidden so `--help` only advertises the
	// commands a user can actually run, while the CLI skeleton keeps calling
	// it to exercise the output contract.
	const stub = new Command("stub")
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
	program.addCommand(stub, { hidden: true });

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
			"Target Minecraft version (release 1.19.3 through 26.3).",
			singleUseOption("--minecraft-version"),
		)
		.option(
			"--resource-pack-version <version>",
			"Target resource-pack version as N or N.M (e.g. 84, 97.1).",
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
			"Target Minecraft version (release 1.19.3 through 26.3).",
			singleUseOption("--minecraft-version"),
		)
		.option(
			"--resource-pack-version <version>",
			"Target resource-pack version as N or N.M (e.g. 84, 97.1).",
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
			"Target Minecraft version (release 1.19.3 through 26.3).",
			singleUseOption("--minecraft-version"),
		)
		.option(
			"--resource-pack-version <version>",
			"Target resource-pack version as N or N.M (e.g. 84, 97.1).",
			singleUseOption("--resource-pack-version"),
		)
		.option(
			"--vanilla <path>",
			"Vanilla assets directory used to resolve minecraft references.",
			singleUseOption("--vanilla"),
		)
		.option(
			"--dependency <path>",
			"Dependency pack root; repeatable, first given wins.",
			(value: string, previous: string[]): string[] => [...previous, value],
			[] as string[],
		)
		.action(
			async (
				path: string,
				options: {
					minecraftVersion?: string | undefined;
					resourcePackVersion?: string | undefined;
					vanilla?: string | undefined;
					dependency?: string[] | undefined;
				},
				command: Command,
			) => {
				const globals = command.optsWithGlobals<{ json?: boolean }>();
				const dependencies = options.dependency ?? [];
				const code = await runValidatePack(
					path,
					{
						minecraftVersion: options.minecraftVersion,
						resourcePackVersion: options.resourcePackVersion,
						...(options.vanilla === undefined
							? {}
							: { vanillaPath: options.vanilla }),
						...(dependencies.length === 0
							? {}
							: { dependencyPaths: dependencies }),
					},
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
		.command("gui-scale <input>")
		.description(
			"Scale a GUI sprite to N or WxH with the mcmeta stretch/tile/nine_slice mapping (PNG only).",
		)
		.option("--size <size>", "Target size: N or WxH positive integers.")
		.option(
			"--mcmeta <path>",
			"Explicit mcmeta path for the scaling section; a sibling file is never derived.",
		)
		.option(
			"--minecraft-version <version>",
			"Target Minecraft version (release 1.19.3 through 26.3).",
			singleUseOption("--minecraft-version"),
		)
		.option(
			"--resource-pack-version <version>",
			"Target resource-pack version as N or N.M (e.g. 84, 97.1).",
			singleUseOption("--resource-pack-version"),
		)
		.option("--output <path>", "Explicit PNG output file path.")
		.option("--stdout", "Write PNG bytes to stdout.")
		.option("--force", "Allow overwriting an existing output file.")
		.option("--mkdir", "Create missing parent directories.")
		.option("--input <path>", "Input path used with --in-place.")
		.option(
			"--profile <name>",
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.action(
			async (input: string, options: GuiScaleOptions, command: Command) => {
				const globals = command.optsWithGlobals<{ json?: boolean }>();
				const code = await runGuiScale(
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
		.description(
			"Reduce the color count with the integer median-cut, or map onto an explicit palette.",
		)
		.option(
			"--colors <n>",
			"Color budget, an integer in [1, 4096]; give this or --palette.",
		)
		.option(
			"--palette <name|path>",
			"Explicit palette source (builtin material id or .mcpx path); conflicts with --colors.",
		)
		.option(
			"--keep-color <r,g,b,a>",
			"Reserved RGBA color kept byte-identical; repeatable.",
			(value: string, previous: string[]): string[] => [...previous, value],
			[] as string[],
		)
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
			"Scope pixel writes (rect:<x>,<y>,<w>,<h>, region:<id>, alpha:, color:, connected:, or a JSON expression starting with {).",
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
			"Scope pixel writes (rect:<x>,<y>,<w>,<h>, region:<id>, alpha:, color:, connected:, or a JSON expression starting with {).",
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

	const style = program
		.command("style")
		.description(
			"Style presets, the palette library, custom style files, and per-asset checks.",
		);
	style
		.command("list")
		.description("List the builtin style presets.")
		.action(async (_options: StyleOptions, command: Command) => {
			const globals = command.optsWithGlobals<{ json?: boolean }>();
			const code = await runStyle(
				"list",
				undefined,
				{},
				globals.json === true,
				realStreams(),
			);
			process.exitCode = code;
		});
	style
		.command("show <style>")
		.description("Show one resolved style (builtin id or .style.json path).")
		.action(
			async (source: string, _options: StyleOptions, command: Command) => {
				const globals = command.optsWithGlobals<{ json?: boolean }>();
				const code = await runStyle(
					"show",
					source,
					{},
					globals.json === true,
					realStreams(),
				);
				process.exitCode = code;
			},
		);
	style
		.command("export-palette <style>")
		.description("Export one family, or every family, as an .mcpx palette.")
		.option("--family <id|all>", "Family id, or all for every family.")
		.option("--output <path>", "Explicit .mcpx palette output file path.")
		.option("--force", "Allow overwriting an existing output file.")
		.option("--mkdir", "Create missing parent directories.")
		.action(async (source: string, options: StyleOptions, command: Command) => {
			const globals = command.optsWithGlobals<{ json?: boolean }>();
			const code = await runStyle(
				"export-palette",
				source,
				options,
				globals.json === true,
				realStreams(),
			);
			process.exitCode = code;
		});
	style
		.command("create")
		.description("Write a new .style.json document.")
		.option("--id <id>", "Style id written into the new document.")
		.option("--name <name>", "Display name; defaults to the id.")
		.option(
			"--extends <base>",
			"Builtin id or .style.json path to inherit; defaults to vanilla.",
		)
		.option("--output <path>", "Explicit .style.json output file path.")
		.option("--force", "Allow overwriting an existing output file.")
		.option("--mkdir", "Create missing parent directories.")
		.action(async (options: StyleOptions, command: Command) => {
			const globals = command.optsWithGlobals<{ json?: boolean }>();
			const code = await runStyle(
				"create",
				undefined,
				options,
				globals.json === true,
				realStreams(),
			);
			process.exitCode = code;
		});
	style
		.command("lint <path>")
		.description("Measure one image and check it against a style.")
		.option(
			"--style <id|path>",
			"Builtin id or .style.json path; defaults to vanilla.",
		)
		.option(
			"--category <name>",
			"Item category id, so its threshold overrides apply.",
		)
		.action(async (source: string, options: StyleOptions, command: Command) => {
			const globals = command.optsWithGlobals<{ json?: boolean }>();
			const code = await runStyle(
				"lint",
				source,
				options,
				globals.json === true,
				realStreams(),
			);
			process.exitCode = code;
		});

	const pack = program
		.command("pack")
		.description("Resource pack projects: skeleton, settings, and checks.");
	pack
		.command("build")
		.description("Build a pack project from its recipe(s).")
		.option("--project <file>", "Project document (mc-asset.pack.json).")
		.option("--recipe <file>", "Single recipe file.")
		.option("--dry-run", "Plan only, write nothing.")
		.action(async (options: PackOptions, command: Command) => {
			const globals = command.optsWithGlobals<{ json?: boolean }>();
			const code = await runPack(
				"build",
				undefined,
				options,
				globals.json === true,
				realStreams(),
			);
			process.exitCode = code;
		});
	pack
		.command("init <dir>")
		.description(
			"Write one project skeleton: the project document, the pack root metadata, the placeholder icon, and the resource pack directories.",
		)
		.option("--namespace <ns>", "Required resource namespace of the pack.")
		.option(
			"--minecraft-version <version>",
			"Required release version 1.19.3 through 26.3.",
		)
		.option("--name <name>", "Project name; defaults to the directory name.")
		.option("--description <text>", "Pack description; defaults to the name.")
		.option("--style <id|path>", "Builtin style id or .style.json path.")
		.option(
			"--resource-pack-version <N>",
			"Resource-pack format N or N.M, overriding the release version.",
		)
		.option(
			"--allow-minecraft-namespace",
			"Allow the reserved minecraft namespace.",
		)
		.action(async (target: string, options: PackOptions, command: Command) => {
			const globals = command.optsWithGlobals<{ json?: boolean }>();
			const code = await runPack(
				"init",
				target,
				options,
				globals.json === true,
				realStreams(),
			);
			process.exitCode = code;
		});
	pack
		.command("catalog")
		.description("List textures in a vanilla tree with mask families.")
		.requiredOption("--vanilla <path>", "Vanilla tree containing assets/.")
		.option("--category <c>", "Exact texture category filter.")
		.option("--page <n>", "Page number, starting at 1.")
		.option("--page-size <n>", "Entries per page, at most 1000.")
		.option("--include-families", "Include the mask family index.")
		.action(async (options: PackOptions, command: Command) => {
			const globals = command.optsWithGlobals<{ json?: boolean }>();
			const code = await runPack(
				"catalog",
				undefined,
				{
					...options,
					includeFamilies: options.includeFamilies === true ? true : undefined,
				},
				globals.json === true,
				realStreams(),
			);
			process.exitCode = code;
		});
	pack
		.command("extract")
		.description("Extract assets/ entries from a client jar.")
		.requiredOption("--jar <path>", "Caller-specified client jar path.")
		.requiredOption(
			"--output-dir <dir>",
			"Directory receiving assets/ entries.",
		)
		.option("--force", "Allow overwriting existing files.")
		.option("--mkdir", "Create missing parent directories.")
		.action(async (options: PackOptions, command: Command) => {
			const globals = command.optsWithGlobals<{ json?: boolean }>();
			const code = await runPack(
				"extract",
				undefined,
				options,
				globals.json === true,
				realStreams(),
			);
			process.exitCode = code;
		});

	program
		.command("recolor <source>")
		.description("Recolor an editable .mcpx source with a builtin material.")
		.option("--material <name>", "Builtin material id.")
		.option("--family <name>", "Palette family id to recolor with.")
		.option(
			"--style <id|path>",
			"Style preset id or .style.json file path (defaults to vanilla).",
		)
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
			"Scope pixel writes (rect:<x>,<y>,<w>,<h>, region:<id>, alpha:, color:, connected:, or a JSON expression starting with {).",
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
		.option("--families <list>", "Comma-separated palette family ids.")
		.option(
			"--style <id|path>",
			"Style preset id or .style.json file path (defaults to vanilla).",
		)
		.option(
			"--selection <scope>",
			"Scope pixel writes (rect:<x>,<y>,<w>,<h>, region:<id>, alpha:, color:, connected:, or a JSON expression starting with {).",
		)
		.option("--region <id>", "Limit the write to one region id.")
		.option(
			"--name-template <template>",
			"Output filename template using {stem} and {name} (default: {stem}_{name}).",
		)
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
			"FrameSet animation: pack / sweep / unpack / reorder / resize / validate / preview.",
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
		.command("sweep <input>")
		.description(
			"Sweep a highlight band across one still image into a vertical sheet PNG.",
		)
		.option(
			"--style <id|path>",
			"Style preset id or .style.json path (default vanilla).",
		)
		.option("--angle <degrees>", "Band angle: 45, 90, 135, or 180.")
		.option("--width <N>", "Band width in pixels, 1 to 8.")
		.option("--color <#RRGGBB>", "Opaque band colour.")
		.option(
			"--frames <N>",
			"Frame count including the untouched first frame, 1 to 64.",
		)
		.option("--frametime <N>", "Ticks per frame of the generated document.")
		.option("--hold-ticks <N>", "Ticks the first frame rests for.")
		.option("--output <path>", "Explicit PNG output file path.")
		.option("--stdout", "Write PNG bytes to stdout.")
		.option(
			"--output-mcmeta <path>",
			"Optional companion .mcmeta output file path.",
		)
		.option("--force", "Allow overwriting an existing output file.")
		.option("--mkdir", "Create missing parent directories.")
		.option(
			"--profile <name>",
			"Asset profile (generic, minecraft:item, minecraft:block, minecraft:gui, minecraft:particle).",
		)
		.action(
			async (input: string, options: AnimateOptions, command: Command) => {
				const globals = command.optsWithGlobals<{ json?: boolean }>();
				const code = await runAnimate(
					"sweep",
					input,
					options,
					globals.json === true,
					realStreams(),
				);
				process.exitCode = code;
			},
		);
	animate
		.command("unpack <sheet>")
		.description("Unpack a sprite sheet PNG into a frames directory.")
		.option("--layout <layout>", "Sheet layout: vertical, horizontal, grid.")
		.option("--frame-size <size>", "Frame size: N or WxH.")
		.option("--columns <N>", "Grid column count (required with grid).")
		.option(
			"--format <format>",
			"Per-frame output format: mcpx (default) or png.",
		)
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
			"Resize sampling (nearest, box, pixel-aware). Default nearest.",
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
		.option(
			"--output <path>",
			"Optional sheet PNG; without it nothing is written.",
		)
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
		.command("inspect <input>")
		.description(
			"Inspect structure or the composited view of an image or .mcpx source (read-only, no artifact files).",
		)
		.option("--mode <mode>", 'Inspect mode: "structure" (default) or "view".')
		.option(
			"--crop <scope>",
			"View-only crop scope (rect:<x>,<y>,<w>,<h>, region:<id>, alpha:, color:, connected:, or a JSON expression starting with {).",
		)
		.option(
			"--scale <N>",
			"View-only integer upscale factor in [1, 16] with nearest sampling (default 1).",
		)
		.option("--output <path>", "Rejected: reports take no file flags.")
		.option("--stdout", "Rejected: reports take no file flags.")
		.option("--source <path>", "Rejected: reports take no file flags.")
		.option("--force", "Rejected: reports take no file flags.")
		.option("--mkdir", "Rejected: reports take no file flags.")
		.option("--in-place", "Rejected: reports take no file flags.")
		.option("--input <path>", "Rejected: reports take no file flags.")
		.option("--profile <name>", "Rejected: reports take no profile flag.")
		.action(
			async (input: string, options: InspectOptions, command: Command) => {
				const globals = command.optsWithGlobals<{ json?: boolean }>();
				const code = await runInspect(
					input,
					options,
					globals.json === true,
					realStreams(),
				);
				process.exitCode = code;
			},
		);

	program
		.command("mcp")
		.description("Start the MCP server over stdio (tool surface for agents).")
		.action(async () => {
			const code = await runMcp();
			process.exitCode = code;
		});

	program
		.command("optimize [input...]")
		.option("--input-dir <dir>")
		.option("--recursive")
		.option("--output <path>")
		.option("--output-dir <dir>")
		.option("--stdout")
		.option("--dry-run")
		.option("--mode <mode>", "Exact encoding mode", "auto")
		.option("--ancillary <policy>", "Metadata policy", "preserve")
		.option("--force")
		.option("--mkdir")
		.action(async (input, options, command) => {
			process.exitCode = await runOptimize(
				input,
				options,
				command.optsWithGlobals().json === true,
				streams,
			);
		});
	program
		.command("compare <before> <after>")
		.description(
			"Compare two same-size PNGs; optionally render diagnostic differences.",
		)
		.option("--output <path>", "Explicit diagnostic .png path.")
		.option("--stdout", "Write diagnostic PNG to stdout.")
		.option("--scale <N>", "Nearest scale from 1 to 16.")
		.option("--force", "Replace an existing output.")
		.option("--mkdir", "Create missing output parents.")
		.action(
			async (
				before: string,
				after: string,
				options: CompareCliOptions,
				current: Command,
			) => {
				process.exitCode = await runCompare(
					before,
					after,
					options,
					current.optsWithGlobals().json === true,
					streams,
				);
			},
		);
	const mcmeta = program
		.command("mcmeta")
		.description(
			"Generate a .mcmeta animation or GUI scaling document from a PNG.",
		);
	for (const mode of ["animation", "gui"] as const) {
		const command = mcmeta
			.command(`${mode} <png>`)
			.description(
				mode === "animation"
					? "Write an animation section for a sprite sheet."
					: "Write a gui.scaling section sized from the PNG.",
			);
		if (mode === "animation") {
			command
				.option("--frame-size <size>", "Frame size: N or WxH.")
				.option(
					"--frametime <N>",
					"Ticks per frame, a positive integer (default 1).",
				)
				.option(
					"--frames <json>",
					"Playback order: JSON array of indices and/or {index,time} objects.",
				)
				.option(
					"--preset <preset>",
					"Timeline shape: hold-and-sweep, ping-pong, or pulse; conflicts with --frames.",
				)
				.option(
					"--hold-ticks <N>",
					"Ticks the first frame rests for with --preset.",
				)
				.option("--interpolate", "Blend between frames.");
		} else {
			command
				.option("--type <type>", "Scaling type: stretch, tile, or nine_slice.")
				.option(
					"--border <N|json>",
					"nine_slice border: N or {left,top,right,bottom}.",
				)
				.option("--stretch-inner", "nine_slice only: stretch the inner bands.");
		}
		command
			.option(
				"--minecraft-version <v>",
				"Minecraft version",
				singleUseOption("--minecraft-version"),
			)
			.option(
				"--resource-pack-version <v>",
				"Pack version",
				singleUseOption("--resource-pack-version"),
			)
			.option("--output <path>", "Explicit .mcmeta output file path.")
			.option("--stdout", "Write the document to stdout.")
			.option("--force", "Replace an existing output file as a whole.")
			.option("--mkdir", "Create missing parent directories.")
			.action(
				async (png: string, options: McmetaCliOptions, current: Command) => {
					process.exitCode = await runMcmeta(
						mode as McmetaMode,
						png,
						options,
						current.optsWithGlobals().json === true,
						streams,
					);
				},
			);
	}
	const model = program.command("model");
	for (const mode of [
		"inspect",
		"validate",
		"create",
		"apply",
		"export",
		"preview",
	] as const) {
		const command = model.command(mode + (mode === "create" ? "" : " <file>"));
		command
			.option(
				"--minecraft-version <v>",
				"Minecraft version",
				singleUseOption("--minecraft-version"),
			)
			.option(
				"--resource-pack-version <v>",
				"Pack version",
				singleUseOption("--resource-pack-version"),
			);
		if (
			mode === "inspect" ||
			mode === "validate" ||
			mode === "export" ||
			mode === "preview"
		)
			command.option("--pack <dir>");
		if (mode === "inspect" || mode === "validate" || mode === "preview")
			command
				.option("--vanilla <dir>")
				.option(
					"--dependency <dir>",
					"Dependency root",
					(value: string, previous: string[]) => [...previous, value],
					[],
				);
		if (mode === "create") command.requiredOption("--spec <file>");
		if (mode === "apply") command.requiredOption("--operations <file>");
		if (mode === "export")
			command
				.option("--binding <file>")
				.option("--item-output <file>")
				.option("--blockstate-output <file>");
		if (mode === "create" || mode === "apply" || mode === "export")
			command.option("--output <file>").option("--force").option("--mkdir");
		if (mode === "preview")
			command
				.option("--size <n>", "Panel edge: 64, 128, or 256 (default 64).")
				.option("--output <file>")
				.option("--force")
				.option("--mkdir");
		if (mode === "create" || mode === "apply" || mode === "preview")
			command.option("--stdout");
		command.action(async (...args: unknown[]) => {
			const current = args[args.length - 1] as Command;
			process.exitCode = await runModel(
				mode as ModelMode,
				mode === "create" ? undefined : (args[0] as string),
				current.opts() as ModelCliOptions,
				current.optsWithGlobals().json === true,
				streams,
			);
		});
	}

	return program;
}
