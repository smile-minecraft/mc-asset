import { McAssetError } from "../core/errors.ts";
import {
	normalizeKeepColors,
	parseKeepColorOption,
} from "../core/quantize-palette.ts";
import {
	assertMcpxPaletteCapacity,
	validateColorsOption,
} from "../core/quantizer.ts";
import { encodePng } from "../io/png.ts";
import { collectCanvasColors } from "../mcpx/index.ts";
import {
	assertMinecraftOutputPath,
	emitCommandFailure,
	emitCommandSuccess,
	ensureMcpxText,
	resolveArtifactTargets,
	resolveInputPath,
	type WarningNote,
} from "./artifacts.ts";
import {
	loadEditableCanvas,
	resolveCommandSelection,
	restoreUnselectedPixels,
	snapshotLayerBytes,
} from "./canvas-input.ts";
import { emitArtifact, type OutputStreams, routeStreams } from "./channels.ts";
import { parseProfile } from "./profiles.ts";
import {
	quantizeCanvasScope,
	resolveLayerQuantizeScope,
} from "./quantize-canvas.ts";
import {
	planQuantizeOutputs,
	writeQuantizeOutputs,
} from "./quantize-output.ts";
import { resolveQuantizePalette } from "./quantize-palette-source.ts";

export interface QuantizeOptions {
	colors?: string | undefined;
	palette?: string | undefined;
	keepColor?: string[] | undefined;
	output?: string | undefined;
	stdout?: boolean | undefined;
	source?: string | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
	inPlace?: boolean | undefined;
	input?: string | undefined;
	profile?: string | undefined;
	selection?: string | undefined;
}

/**
 * Color-budget or palette entry: exactly one of --colors/--palette is
 * required (both is ARGUMENT_CONFLICT, neither is INVALID_ARGUMENT).
 * --colors must be an integer in [1, 4096]; --palette takes a builtin
 * material id or an .mcpx path with at most 4096 colors. --keep-color
 * entries stay byte-identical. With --keep-color or --palette, --selection
 * scopes the budget and the mapping to the selected pixels of each layer.
 * Without them, each whole layer is quantized and unselected pixels are
 * restored verbatim afterwards.
 */
export async function runQuantize(
	input: string | undefined,
	options: QuantizeOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({
		json: globalJson,
		stdoutArtifact: options.stdout === true,
	});
	try {
		const profile = parseProfile(options.profile);
		const inputPath = resolveInputPath(input, options.input, "quantize");
		const hasColors = options.colors !== undefined && options.colors !== "";
		const palettePath =
			options.palette === undefined || options.palette === ""
				? undefined
				: options.palette;
		if (hasColors && palettePath !== undefined) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				"--colors and --palette cannot be combined; pass one.",
				{},
			);
		}
		if (!hasColors && palettePath === undefined) {
			validateColorsOption(undefined);
		}
		const keepColors = normalizeKeepColors(
			(options.keepColor ?? []).map((entry) => parseKeepColorOption(entry)),
		);
		const colors = hasColors
			? validateColorsOption(Number(options.colors))
			: undefined;
		const resolvedPalette =
			palettePath === undefined
				? undefined
				: await resolveQuantizePalette(palettePath);
		const scope = resolveLayerQuantizeScope({
			colors,
			palette: resolvedPalette?.colors,
			keepColors,
		});
		const inPlaceKind =
			options.inPlace === true && inputPath.toLowerCase().endsWith(".mcpx")
				? "build"
				: "import";
		const targets = resolveArtifactTargets({
			command: inPlaceKind,
			output: options.output,
			stdout: options.stdout,
			source: options.source,
			force: options.force,
			inPlace: options.inPlace,
			inputPath,
		});
		if (options.output !== undefined && options.output !== "") {
			assertMinecraftOutputPath(profile, options.output);
		}
		const loaded = await loadEditableCanvas(inputPath);
		const canvas = loaded.canvas;
		const warnings: WarningNote[] = loaded.warnings;
		const selection = resolveCommandSelection(canvas, options.selection, false);
		const before = snapshotLayerBytes(canvas);
		const colorCount = quantizeCanvasScope(canvas, selection, scope);
		const modifiedPixels = restoreUnselectedPixels(canvas, before, selection);
		if (targets.mcpxFiles.length > 0) {
			assertMcpxPaletteCapacity(collectCanvasColors(canvas).length);
		}
		let pngBytes: Uint8Array | undefined;
		if (targets.pngStdout || targets.pngFiles.length > 0) {
			pngBytes = encodePng(canvas);
		}
		let mcpxText: string | undefined;
		if (targets.mcpxFiles.length > 0) {
			mcpxText = ensureMcpxText(canvas, (warning) => {
				warnings.push({ code: warning.code, message: warning.message });
			});
		}
		// File-target preflight runs before any stdout artifact byte, so a
		// conflict keeps stdout empty.
		const outputPlan = await planQuantizeOutputs(targets, {
			inputPath,
			palette: palettePath,
			inPlace: options.inPlace,
			mkdir: options.mkdir,
		});
		if (pngBytes !== undefined && targets.pngStdout) {
			emitArtifact(pngBytes, streams, route);
		}
		await writeQuantizeOutputs(
			outputPlan,
			targets,
			pngBytes,
			mcpxText,
			options.mkdir,
		);
		emitCommandSuccess(streams, route, globalJson, {
			command: "quantize",
			profile,
			applied: 0,
			operations: [],
			warnings,
			details: {
				...(scope.kind === "colors" ? { colors: scope.colors } : {}),
				...(resolvedPalette === undefined
					? {}
					: { palette: resolvedPalette.label }),
				...(scope.keepColors.length > 0
					? { keepColors: scope.keepColors.map((color) => ({ ...color })) }
					: {}),
				colorCount,
				modifiedPixels,
				...(selection.kind !== "all" ? { selection: options.selection } : {}),
			},
			...(targets.pngFiles[0] !== undefined
				? { output: targets.pngFiles[0].path }
				: {}),
			...(targets.mcpxFiles[0] !== undefined
				? { source: targets.mcpxFiles[0].path }
				: {}),
			...(targets.pngStdout ? { stdout: true as const } : {}),
		});
		return 0;
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}
