import { McAssetError } from "../core/errors.ts";
import { isBuiltinMaterialId } from "../core/material.ts";
import {
	type FamilyRecolorOptions,
	type FamilyRole,
	recolorCanvasByFamily,
	recolorLayer,
	recolorRolelessCanvas,
} from "../core/recolor.ts";
import { encodePng } from "../io/png.ts";
import { resolveStyle } from "../style/load.ts";
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
	family?: string | undefined;
	style?: string | undefined;
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

/** One resolved family ramp in the shape the core family path consumes. */
export type ResolvedFamilyRampOption = NonNullable<
	FamilyRecolorOptions["ramp"]
>;

/**
 * Resolve a style source (builtin id or `.style.json` path, defaulting to
 * vanilla) and read one ramp per requested family. A family missing from
 * the resolved palettes is STYLE_FAMILY_NOT_FOUND. The core family path
 * receives the ramp, never the style source.
 */
export async function resolveStyleFamilyRamps(
	style: string | undefined,
	families: readonly string[],
): Promise<Map<string, ResolvedFamilyRampOption>> {
	const resolved = await resolveStyle(
		style === undefined || style === "" ? "vanilla" : style,
	);
	const ramps = new Map<string, ResolvedFamilyRampOption>();
	for (const family of families) {
		const ramp: Record<FamilyRole, string> | undefined =
			resolved.palettes[family];
		if (ramp === undefined) {
			throw new McAssetError(
				"STYLE_FAMILY_NOT_FOUND",
				`Family ${family} is not defined in the resolved style.`,
				{ family, style: resolved.id },
			);
		}
		ramps.set(family, ramp);
	}
	return ramps;
}

/**
 * Recolor entry: the source is an editable .mcpx format or a flat PNG.
 * Exactly one target is required: a builtin material id (the three-band
 * material path, byte-identical to the historical output) or a palette
 * family (the six-band family path). An optional --region limits the
 * write to that region's mask (region-external pixels stay byte-identical).
 * --selection scopes the write-back the same way; combining both
 * intersects them. The region mask itself is never rewritten.
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
		const material =
			options.material === undefined || options.material === ""
				? undefined
				: options.material;
		const family =
			options.family === undefined || options.family === ""
				? undefined
				: options.family;
		if (material === undefined && family === undefined) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"recolor needs either --material or --family.",
			);
		}
		if (material !== undefined && family !== undefined) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				"recolor takes either --material or --family, not both.",
				{ material, family },
			);
		}
		if (material !== undefined && !isBuiltinMaterialId(material)) {
			throw new McAssetError("INVALID_ARGUMENT", "Unknown material id.", {
				id: material,
			});
		}
		const regionId =
			options.region === undefined || options.region === ""
				? undefined
				: options.region;
		const isMcpx = inputPath.toLowerCase().endsWith(".mcpx");
		const isPng = inputPath.toLowerCase().endsWith(".png");
		if (!isMcpx && !isPng) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"recolor reads an editable .mcpx or .png source.",
				{ input: inputPath },
			);
		}
		const inPlaceKind = options.inPlace === true && isMcpx ? "build" : "import";
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
		let pixelsChanged = 0;
		if (material !== undefined) {
			if (isMcpx) {
				for (const layer of canvas.layers) {
					const report = recolorLayer(canvas, layer.id, material, {
						...(regionId !== undefined ? { regionId } : {}),
					});
					pixelsChanged += report.pixelsChanged;
				}
			} else {
				const report = recolorRolelessCanvas(canvas, material, {
					...(regionId !== undefined ? { regionId } : {}),
				});
				pixelsChanged = report.pixelsChanged;
			}
		} else if (family !== undefined) {
			const ramps = await resolveStyleFamilyRamps(options.style, [family]);
			const ramp = ramps.get(family);
			pixelsChanged = recolorCanvasByFamily(canvas, family, {
				...(regionId !== undefined ? { regionId } : {}),
				...(ramp !== undefined ? { ramp } : {}),
			}).pixelsChanged;
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
			command: "recolor",
			profile,
			applied: 0,
			operations: [],
			warnings,
			details: {
				...(material !== undefined ? { material } : {}),
				...(family !== undefined ? { family } : {}),
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
