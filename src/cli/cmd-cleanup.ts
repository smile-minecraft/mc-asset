import {
	CLEANUP_CLASSES,
	type CleanupClass,
	detectCleanup,
	fixCleanup,
} from "../core/cleanup.ts";
import { McAssetError } from "../core/errors.ts";
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

export interface CleanupOptions {
	fix?: string | undefined;
	allowRenderPassChange?: boolean | undefined;
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

function parseFixClasses(raw: string | undefined): CleanupClass[] | undefined {
	if (raw === undefined || raw === "") {
		return undefined;
	}
	const names = raw.split(",").map((part) => part.trim());
	const out: CleanupClass[] = [];
	for (const name of names) {
		if (!(CLEANUP_CLASSES as readonly string[]).includes(name)) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				`Unknown cleanup class: ${name}. Expected one of ${CLEANUP_CLASSES.join(", ")}.`,
				{ class: name },
			);
		}
		const className = name as CleanupClass;
		if (!out.includes(className)) {
			out.push(className);
		}
	}
	return out;
}

/**
 * Detect-and-optionally-fix entry. Without --fix the command still writes
 * the requested artifact with pixels unchanged (detect and report only).
 * Alpha-affecting classes need --allow-render-pass-change; outlier needs
 * no extra authorization. --selection restores unselected pixels verbatim
 * after the fix pass, and modifiedPixels counts what stayed changed.
 */
export async function runCleanup(
	input: string | undefined,
	options: CleanupOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({
		json: globalJson,
		stdoutArtifact: options.stdout === true,
	});
	try {
		const profile = parseProfile(options.profile);
		const inputPath = resolveInputPath(input, options.input, "cleanup");
		const fix = parseFixClasses(options.fix);
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
		const detected: Record<string, number> = {};
		const fixed: Record<string, number> = {};
		for (const name of CLEANUP_CLASSES) {
			detected[name] = 0;
			fixed[name] = 0;
		}
		if (fix === undefined) {
			for (const layer of canvas.layers) {
				const report = detectCleanup(canvas, layer.id);
				for (const name of CLEANUP_CLASSES) {
					detected[name] = (detected[name] as number) + report.detected[name];
				}
			}
		} else {
			for (const layer of canvas.layers) {
				const result = fixCleanup(canvas, layer.id, {
					fix,
					...(options.allowRenderPassChange === true
						? { allowRenderPassChange: true as const }
						: {}),
				});
				for (const name of CLEANUP_CLASSES) {
					detected[name] = (detected[name] as number) + result.detected[name];
					fixed[name] = (fixed[name] as number) + result.fixed[name];
				}
			}
		}
		// Selection gates the write-back: unselected pixels return to their
		// input bytes, and modifiedPixels counts the bytes that stayed
		// changed. detected/fixed stay the whole-layer engine figures.
		const modifiedPixels = restoreUnselectedPixels(canvas, before, selection);
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
			command: "cleanup",
			profile,
			applied: 0,
			operations: [],
			warnings,
			details: {
				detected,
				fixed,
				modifiedPixels,
				...(fix !== undefined ? { fix: [...fix] } : {}),
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
