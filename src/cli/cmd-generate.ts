import { addLayer, createCanvas, replaceLayerPixels } from "../core/canvas.ts";
import { McAssetError } from "../core/errors.ts";
import { getMaterialPalette, isBuiltinMaterialId } from "../core/material.ts";
import { parsePixelizeSize } from "../core/pixelize.ts";
import {
	generateProcedural,
	parseGeneratePattern,
	parseGenerateSeed,
} from "../core/procedural.ts";
import { assertMcpxPaletteCapacity } from "../core/quantizer.ts";
import type { RGBA } from "../core/types.ts";
import { encodePng } from "../io/png.ts";
import { collectCanvasColors, parseMcpx } from "../mcpx/index.ts";
import {
	assertMinecraftOutputPath,
	emitCommandFailure,
	ensureMcpxText,
	preflightArtifactTargets,
	readInputText,
	resolveArtifactTargets,
	type WarningNote,
	writeArtifactPayloads,
} from "./artifacts.ts";
import {
	emitArtifact,
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { successEnvelope } from "./envelope.ts";
import { parseProfile } from "./profiles.ts";

export interface GenerateOptions {
	size?: string | undefined;
	palette?: string | undefined;
	seed?: string | undefined;
	output?: string | undefined;
	stdout?: boolean | undefined;
	source?: string | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
	profile?: string | undefined;
}

interface ResolvedPalette {
	colors: RGBA[];
	label: string;
}

/**
 * Resolve --palette: an exact builtin material id wins; otherwise the
 * value must be an .mcpx path whose [palette] supplies the colors.
 * Anything else (or an empty palette) is INVALID_ARGUMENT; an unreadable
 * file is FILESYSTEM_ERROR; bad content keeps its MCPX_* code.
 */
async function resolveGeneratePalette(raw: string): Promise<ResolvedPalette> {
	if (isBuiltinMaterialId(raw)) {
		const entries = getMaterialPalette(raw).entries;
		return {
			colors: entries.map((entry) => ({ ...entry.color })),
			label: raw,
		};
	}
	if (!raw.toLowerCase().endsWith(".mcpx")) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`--palette must be a builtin material id or an .mcpx path, got "${raw}".`,
			{ palette: raw },
		);
	}
	const text = await readInputText(raw, "palette file");
	const canvas = parseMcpx(text);
	const colors = (canvas.palette?.entries ?? []).map((entry) => ({
		...entry.color,
	}));
	if (colors.length === 0) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Palette file has no [palette] colors: ${raw}.`,
			{ palette: raw },
		);
	}
	return { colors, label: raw };
}

/**
 * Deterministic pattern synthesis: no input file, three required flags
 * (--size/--palette/--seed), PNG and/or .mcpx outputs. Success emission
 * follows the write-command shape (command/profile/applied/operations/
 * warnings) plus the frozen generate fields.
 */
export async function runGenerate(
	patternArg: string | undefined,
	options: GenerateOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({
		json: globalJson,
		stdoutArtifact: options.stdout === true,
	});
	try {
		const profile = parseProfile(options.profile);
		const pattern = parseGeneratePattern(patternArg);
		const { width, height } = parsePixelizeSize(options.size);
		const seed = parseGenerateSeed(options.seed);
		if (options.palette === undefined || options.palette === "") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"--palette is required (a builtin material id or an .mcpx path).",
				{ palette: options.palette },
			);
		}
		// Union output guard before any palette file IO: missing every
		// channel is OUTPUT_REQUIRED with zero files, mirroring pixelize.
		const targets = resolveArtifactTargets({
			command: "import",
			output: options.output,
			stdout: options.stdout,
			source: options.source,
			force: options.force,
			inPlace: undefined,
			inputPath: undefined,
		});
		if (options.output !== undefined && options.output !== "") {
			assertMinecraftOutputPath(profile, options.output);
		}
		const resolved = await resolveGeneratePalette(options.palette);
		const generated = generateProcedural(pattern, {
			width,
			height,
			seed,
			palette: resolved.colors,
		});
		const canvas = createCanvas(generated.width, generated.height);
		const layer = addLayer(canvas, { id: "base" });
		replaceLayerPixels(canvas, layer.id, generated.pixels);
		const warnings: WarningNote[] = [];
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
		// refusal keeps stdout empty (same TOCTOU note as the V0.1 path).
		await preflightArtifactTargets(targets, { mkdir: options.mkdir });
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
			command: "generate",
			profile,
			applied: 0,
			operations: [],
			warnings,
			pattern,
			seed,
			width: generated.width,
			height: generated.height,
			palette: resolved.label,
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
			const parts = [
				`ok generate profile=${profile} applied=0 pattern=${pattern} seed=${seed} size=${generated.width}x${generated.height} palette=${resolved.label}`,
			];
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
