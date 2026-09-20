import { addLayer, createCanvas, replaceLayerPixels } from "../core/canvas.ts";
import { McAssetError } from "../core/errors.ts";
import {
	applyTileCorrections,
	buildTilePreview,
	formatTileScore,
	parsePreviewSize,
	parseTileAxis,
	repetitionScore,
	seamMetrics,
	type TileAxis,
	type TileRepetitionReport,
	type TileSeamReport,
} from "../core/tile.ts";
import { validateDimension } from "../core/validate.ts";
import { encodePng, flattenCanvas } from "../io/png.ts";
import {
	assertMinecraftOutputPath,
	emitCommandFailure,
	preflightArtifactTargets,
	resolveArtifactTargets,
	resolveInputPath,
	type WarningNote,
	writeArtifactPayloads,
} from "./artifacts.ts";
import { loadEditableCanvas } from "./canvas-input.ts";
import {
	emitArtifact,
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { successEnvelope } from "./envelope.ts";
import { parseProfile } from "./profiles.ts";

export interface TileOptions {
	preview?: string | undefined;
	edgeMatch?: string | undefined;
	brightnessMatch?: string | undefined;
	output?: string | undefined;
	stdout?: boolean | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
	input?: string | undefined;
	profile?: string | undefined;
}

interface TileAxisSelection {
	edge: TileAxis | undefined;
	brightness: TileAxis | undefined;
}

function parseCorrectionAxes(options: TileOptions): TileAxisSelection {
	let edge: TileAxis | undefined;
	if (options.edgeMatch !== undefined && options.edgeMatch !== "") {
		edge = parseTileAxis(options.edgeMatch, "--edge-match");
	}
	let brightness: TileAxis | undefined;
	if (options.brightnessMatch !== undefined && options.brightnessMatch !== "") {
		brightness = parseTileAxis(options.brightnessMatch, "--brightness-match");
	}
	return { edge, brightness };
}

function toJsonSeam(report: TileSeamReport): Record<string, unknown> {
	const shape = (entry: { raw: number; pairs: number; score: number }) => ({
		raw: entry.raw,
		pairs: entry.pairs,
		score: formatTileScore(entry.score),
	});
	return {
		horizontal: shape(report.horizontal),
		vertical: shape(report.vertical),
		corner: shape(report.corner),
	};
}

function toJsonRepeat(report: TileRepetitionReport): Record<string, unknown> {
	return {
		score: formatTileScore(report.score),
		periodX: report.periodX,
		periodY: report.periodY,
	};
}

/**
 * Tile report and synthesis: report-only without outputs, single-tile PNG
 * with --output, or an NxN repeat preview with --preview plus --output.
 * The seam and repeat sections always describe the loaded input; with
 * correction flags a corrected section describes the written pixels.
 * Only --edge-match / --brightness-match modify pixels, and only the
 * written artifact: uncorrected --output bytes match the input flatten.
 */
export async function runTile(
	input: string | undefined,
	options: TileOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({
		json: globalJson,
		stdoutArtifact: options.stdout === true,
	});
	try {
		const profile = parseProfile(options.profile);
		const inputPath = resolveInputPath(input, options.input, "tile");
		let previewTimes: 2 | 4 | 8 | undefined;
		if (options.preview !== undefined && options.preview !== "") {
			previewTimes =
				typeof options.preview === "string"
					? parsePreviewSize(options.preview)
					: parsePreviewSize(String(options.preview));
		}
		const { edge, brightness } = parseCorrectionAxes(options);
		const hasOutputTarget =
			(options.output !== undefined && options.output !== "") ||
			options.stdout === true;
		if (previewTimes !== undefined && !hasOutputTarget) {
			throw new McAssetError(
				"OUTPUT_REQUIRED",
				"--preview needs --output to write the NxN preview PNG.",
			);
		}
		const loaded = await loadEditableCanvas(inputPath);
		const warnings: WarningNote[] = loaded.warnings;
		const canvas = loaded.canvas;
		const width = canvas.width;
		const height = canvas.height;
		const inputPixels = flattenCanvas(canvas);
		const seam = seamMetrics(inputPixels, width, height);
		const repeat = repetitionScore(inputPixels, width, height);
		const { pixels: correctedPixels, corrections } = applyTileCorrections(
			inputPixels,
			width,
			height,
			edge,
			brightness,
		);
		const corrected =
			corrections.length > 0
				? {
						seam: toJsonSeam(seamMetrics(correctedPixels, width, height)),
						repeat: toJsonRepeat(
							repetitionScore(correctedPixels, width, height),
						),
					}
				: undefined;
		if (!hasOutputTarget) {
			const result: Record<string, unknown> = {
				command: "tile",
				profile,
				width,
				height,
				seam: toJsonSeam(seam),
				repeat: toJsonRepeat(repeat),
				corrections,
				...(corrected !== undefined ? { corrected } : {}),
			};
			if (globalJson) {
				emitEnvelope(successEnvelope(result), streams, route);
			} else {
				emitLog(
					`ok tile profile=${profile} seam=h:${formatTileScore(seam.horizontal.score)} v:${formatTileScore(seam.vertical.score)} c:${formatTileScore(seam.corner.score)} repeat=${formatTileScore(repeat.score)}`,
					streams,
					route,
				);
				for (const warning of warnings) {
					emitLog(
						`warning [${warning.code}] ${warning.message}`,
						streams,
						route,
					);
				}
			}
			return 0;
		}
		// PNG-only write path (tile declares no --source / --in-place):
		// resolve through the shared union guard under the raster label.
		const targets = resolveArtifactTargets({
			command: "import",
			output: options.output,
			stdout: options.stdout,
			source: undefined,
			force: options.force,
			inPlace: undefined,
			inputPath,
		});
		if (options.output !== undefined && options.output !== "") {
			assertMinecraftOutputPath(profile, options.output);
		}
		let artifactPixels = correctedPixels;
		let artifactWidth = width;
		let artifactHeight = height;
		if (previewTimes !== undefined) {
			const preview = buildTilePreview(
				correctedPixels,
				width,
				height,
				previewTimes,
			);
			artifactPixels = preview.pixels;
			artifactWidth = preview.width;
			artifactHeight = preview.height;
			validateDimension(artifactWidth);
			validateDimension(artifactHeight);
		}
		const artifactCanvas = createCanvas(artifactWidth, artifactHeight);
		const layer = addLayer(artifactCanvas, { id: "base" });
		replaceLayerPixels(artifactCanvas, layer.id, artifactPixels);
		const pngBytes = encodePng(artifactCanvas);
		// File-target preflight runs before any stdout artifact byte, so a
		// refusal keeps stdout empty (same TOCTOU note as the V0.1 path).
		await preflightArtifactTargets(targets, {
			inputPath,
			inPlace: undefined,
			mkdir: options.mkdir,
		});
		if (targets.pngStdout) {
			emitArtifact(pngBytes, streams, route);
		}
		await writeArtifactPayloads(
			targets.pngFiles.length > 0
				? [{ targets: targets.pngFiles, data: pngBytes }]
				: [],
			options.mkdir,
		);
		const result: Record<string, unknown> = {
			command: "tile",
			profile,
			width,
			height,
			seam: toJsonSeam(seam),
			repeat: toJsonRepeat(repeat),
			corrections,
			...(corrected !== undefined ? { corrected } : {}),
			...(targets.pngFiles[0] !== undefined
				? { output: targets.pngFiles[0].path }
				: {}),
			...(targets.pngStdout ? { stdout: true as const } : {}),
		};
		if (globalJson) {
			emitEnvelope(successEnvelope(result), streams, route);
		} else {
			const parts = [
				`ok tile profile=${profile} seam=h:${formatTileScore(seam.horizontal.score)} v:${formatTileScore(seam.vertical.score)} c:${formatTileScore(seam.corner.score)} repeat=${formatTileScore(repeat.score)}`,
			];
			if (targets.pngFiles[0] !== undefined) {
				parts.push(`output=${targets.pngFiles[0].path}`);
			}
			if (targets.pngStdout) {
				parts.push("stdout=true");
			}
			emitLog(parts.join(" "), streams, route);
			for (const warning of warnings) {
				emitLog(`warning [${warning.code}] ${warning.message}`, streams, route);
			}
		}
		return 0;
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}
