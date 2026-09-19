import { replaceLayerPixels } from "../core/canvas.ts";
import {
	assertMcpxPaletteCapacity,
	quantizePixels,
	validateColorsOption,
} from "../core/quantizer.ts";
import { encodePng } from "../io/png.ts";
import { collectCanvasColors } from "../mcpx/index.ts";
import {
	assertMinecraftOutputPath,
	emitCommandFailure,
	emitCommandSuccess,
	ensureMcpxText,
	preflightArtifactTargets,
	resolveArtifactTargets,
	resolveInputPath,
	type WarningNote,
	writeArtifactPayloads,
} from "./artifacts.ts";
import {
	loadEditableCanvas,
	resolveCommandSelection,
	restoreUnselectedPixels,
	snapshotLayerBytes,
} from "./canvas-input.ts";
import { emitArtifact, type OutputStreams, routeStreams } from "./channels.ts";
import { parseProfile } from "./profiles.ts";

export interface QuantizeOptions {
	colors?: string | undefined;
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
 * Color-budget entry: --colors is required (missing is INVALID_ARGUMENT,
 * not OUTPUT_REQUIRED) and must be an integer in [1, 4096]. Each layer is
 * quantized to at most that many colors with the frozen integer
 * median-cut; --selection restores unselected pixels verbatim afterwards.
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
		const colors =
			options.colors === undefined || options.colors === ""
				? validateColorsOption(undefined)
				: validateColorsOption(Number(options.colors));
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
		let colorCount = 0;
		for (const layer of canvas.layers) {
			const result = quantizePixels(layer.pixels, colors);
			replaceLayerPixels(canvas, layer.id, result.pixels);
			if (result.colorCount > colorCount) {
				colorCount = result.colorCount;
			}
		}
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
		// conflict keeps stdout empty (same TOCTOU note as the V0.1 path).
		await preflightArtifactTargets(targets, {
			inputPath,
			inPlace: options.inPlace,
			mkdir: options.mkdir,
		});
		if (pngBytes !== undefined && targets.pngStdout) {
			emitArtifact(pngBytes, streams, route);
		}
		await writeArtifactPayloads(
			[
				...(targets.pngFiles.length > 0 && pngBytes !== undefined
					? [{ targets: targets.pngFiles, data: pngBytes }]
					: []),
				...(targets.mcpxFiles.length > 0 && mcpxText !== undefined
					? [{ targets: targets.mcpxFiles, data: mcpxText }]
					: []),
			],
			options.mkdir,
		);
		emitCommandSuccess(streams, route, globalJson, {
			command: "quantize",
			profile,
			applied: 0,
			operations: [],
			warnings,
			details: {
				colors,
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
