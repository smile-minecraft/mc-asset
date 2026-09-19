import { McAssetError } from "../core/errors.ts";
import { isBuiltinMaterialId } from "../core/material.ts";
import { recolorLayer } from "../core/recolor.ts";
import { encodePng } from "../io/png.ts";
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

export interface RecolorOptions {
	material?: string | undefined;
	region?: string | undefined;
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
 * Material recolor entry: the source is the editable .mcpx format, every
 * layer is recolored to the target builtin material, and an optional
 * --region limits the write to that region's mask (region-external pixels
 * stay byte-identical). --selection scopes the write-back the same way;
 * combining both intersects them. The region mask itself is never
 * rewritten.
 */
export async function runRecolor(
	source: string | undefined,
	options: RecolorOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({
		json: globalJson,
		stdoutArtifact: options.stdout === true,
	});
	try {
		const profile = parseProfile(options.profile);
		const inputPath = resolveInputPath(source, options.input, "recolor");
		if (options.material === undefined || options.material === "") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"recolor needs --material with a builtin material id.",
			);
		}
		if (!isBuiltinMaterialId(options.material)) {
			throw new McAssetError("INVALID_ARGUMENT", "Unknown material id.", {
				id: options.material,
			});
		}
		const regionId =
			options.region === undefined || options.region === ""
				? undefined
				: options.region;
		const targets = resolveArtifactTargets({
			command: "build",
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
		if (!inputPath.toLowerCase().endsWith(".mcpx")) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"recolor reads an editable .mcpx source.",
				{ input: inputPath },
			);
		}
		const loaded = await loadEditableCanvas(inputPath);
		const canvas = loaded.canvas;
		const warnings: WarningNote[] = loaded.warnings;
		const selection = resolveCommandSelection(canvas, options.selection, false);
		const before = snapshotLayerBytes(canvas);
		let pixelsChanged = 0;
		for (const layer of canvas.layers) {
			const report = recolorLayer(canvas, layer.id, options.material, {
				...(regionId !== undefined ? { regionId } : {}),
			});
			pixelsChanged += report.pixelsChanged;
		}
		// Selection (and region-external pixels already skipped by the
		// engine) return to their input bytes; the count below describes
		// what stayed changed under the selection.
		const changed = restoreUnselectedPixels(canvas, before, selection);
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
			command: "recolor",
			profile,
			applied: 0,
			operations: [],
			warnings,
			details: {
				material: options.material,
				...(regionId !== undefined ? { region: regionId } : {}),
				pixelsChanged,
				modifiedPixels: changed,
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
