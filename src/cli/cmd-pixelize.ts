import { McAssetError } from "../core/errors.ts";
import { describePixelizePreset, runPixelize } from "../core/pixelize.ts";
import { assertMcpxPaletteCapacity } from "../core/quantizer.ts";
import { encodePng } from "../io/png.ts";
import { collectCanvasColors } from "../mcpx/index.ts";
import {
	assertMinecraftOutputPath,
	emitCommandFailure,
	ensureMcpxText,
	preflightArtifactTargets,
	resolveArtifactTargets,
	resolveInputPath,
	type WarningNote,
	writeArtifactPayloads,
} from "./artifacts.ts";
import { loadRasterCanvas } from "./canvas-input.ts";
import {
	emitArtifact,
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { successEnvelope } from "./envelope.ts";
import { parseProfile } from "./profiles.ts";

export interface PixelizeCommandOptions {
	size?: string | undefined;
	preset?: string | undefined;
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
 * Reference-image entry: decode PNG/JPEG/WebP, run the fixed eleven-stage
 * pipeline, emit PNG bytes and/or the editable .mcpx source. The .mcpx
 * source format is never accepted here (UNSUPPORTED_IMAGE_FORMAT); that
 * input belongs to build/quantize/cleanup/recolor.
 *
 * Success emission mirrors artifacts.emitCommandSuccess field-for-field
 * (command/profile/applied/operations/warnings plus flat details), but is
 * spelled out here because the shared WriteCommandName union is frozen
 * without pixelize and must not be widened by this command.
 */
export async function runPixelizeCommand(
	image: string | undefined,
	options: PixelizeCommandOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({
		json: globalJson,
		stdoutArtifact: options.stdout === true,
	});
	try {
		const profile = parseProfile(options.profile);
		const inputPath = resolveInputPath(image, options.input, "pixelize");
		if (options.selection !== undefined && options.selection !== "") {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				"--selection cannot be combined with pixelize: the pipeline owns cropping and resizing.",
			);
		}
		if (inputPath.toLowerCase().endsWith(".mcpx")) {
			throw new McAssetError(
				"UNSUPPORTED_IMAGE_FORMAT",
				"pixelize takes a raster image (PNG, JPEG, WebP), not an editable .mcpx source.",
				{ inputPath },
			);
		}
		// Raster in-place rewrites the input file as PNG (the "import" kind);
		// --force with --in-place stays ARGUMENT_CONFLICT via the resolver.
		const targets = resolveArtifactTargets({
			command: "import",
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
		const decoded = await loadRasterCanvas(inputPath);
		const warnings: WarningNote[] = decoded.warnings;
		const report = runPixelize(decoded.canvas, {
			size: options.size,
			preset: options.preset,
		});
		if (report.nonStandardResolution) {
			warnings.push({
				code: "NON_STANDARD_RESOLUTION",
				message: `non-standard resolution ${report.width}x${report.height}; recommendation only, the texture remains loadable.`,
			});
		}
		if (targets.mcpxFiles.length > 0) {
			assertMcpxPaletteCapacity(collectCanvasColors(report.canvas).length);
		}
		let pngBytes: Uint8Array | undefined;
		if (targets.pngStdout || targets.pngFiles.length > 0) {
			pngBytes = encodePng(report.canvas);
		}
		let mcpxText: string | undefined;
		if (targets.mcpxFiles.length > 0) {
			mcpxText = ensureMcpxText(report.canvas, (warning) => {
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
		const result = {
			command: "pixelize",
			profile,
			applied: 0,
			operations: [],
			warnings,
			size: options.size,
			preset: report.preset,
			presetDetail: describePixelizePreset(report.preset),
			width: report.width,
			height: report.height,
			colors: report.colors,
			colorCount: report.colorCount,
			stages: report.stages,
			...(targets.pngFiles[0] !== undefined
				? { output: targets.pngFiles[0].path }
				: {}),
			...(targets.mcpxFiles[0] !== undefined
				? { source: targets.mcpxFiles[0].path }
				: {}),
			...(targets.pngStdout ? { stdout: true as const } : {}),
		};
		if (globalJson) {
			emitEnvelope(successEnvelope(result), streams, route);
		} else {
			const parts = [`ok pixelize profile=${profile} applied=0`];
			if (result.output !== undefined) {
				parts.push(`output=${result.output}`);
			}
			if (result.source !== undefined) {
				parts.push(`source=${result.source}`);
			}
			if (result.stdout === true) {
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
