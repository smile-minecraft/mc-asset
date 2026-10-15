import { basename, join as joinPath } from "node:path";
import { McAssetError } from "../core/errors.ts";
import { isBuiltinMaterialId } from "../core/material.ts";
import { recolorLayer, recolorRolelessCanvas } from "../core/recolor.ts";
import type { PixelCanvas } from "../core/types.ts";
import { encodePng } from "../io/png.ts";
import { parseMcpx } from "../mcpx/index.ts";
import {
	emitCommandFailure,
	ensureMcpxText,
	preflightArtifactTargets,
	readInputText,
	type WarningNote,
	writeArtifactPayloads,
} from "./artifacts.ts";
import { cloneCanvas, loadEditableCanvas } from "./canvas-input.ts";
import {
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { successEnvelope } from "./envelope.ts";
import { parseProfile } from "./profiles.ts";

export interface VariantOptions {
	materials?: string | undefined;
	outputDir?: string | undefined;
	output?: string | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
	profile?: string | undefined;
}

export interface VariantFileEntry {
	material: string;
	png: string;
	mcpx: string;
	pixelsChanged: number;
}

/** Split a comma list, trimming entries and dropping empties. */
function parseMaterialList(raw: string | undefined): string[] {
	if (raw === undefined || raw === "") {
		return [];
	}
	return raw
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");
}

/**
 * Variant fan-out: one editable .mcpx source is recolored once per
 * --materials entry, writing <basename>_<material>.png plus
 * <basename>_<material>.mcpx under the explicit --output-dir. Each
 * material starts from the pristine source text, so reruns stay
 * byte-identical and materials never stack on each other.
 *
 * Guard order keeps failures file-free: argument conflicts and the
 * missing --output-dir refusal happen before any read, unknown
 * materials and non-.mcpx sources fail before any write, and the union
 * file preflight runs before the first byte lands.
 */
export async function runVariant(
	source: string | undefined,
	options: VariantOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({ json: globalJson, stdoutArtifact: false });
	try {
		const profile = parseProfile(options.profile);
		if (source === undefined || source === "") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"variant needs a file path argument.",
			);
		}
		const inputPath = source;
		if (options.output !== undefined && options.output !== "") {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				"variant writes under --output-dir; --output is not accepted here.",
			);
		}
		const materials = parseMaterialList(options.materials);
		if (materials.length === 0) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"variant needs --materials with at least one builtin material id.",
			);
		}
		const seen = new Set<string>();
		for (const id of materials) {
			if (!isBuiltinMaterialId(id)) {
				throw new McAssetError("INVALID_ARGUMENT", "Unknown material id.", {
					id,
				});
			}
			if (seen.has(id)) {
				throw new McAssetError(
					"ARGUMENT_CONFLICT",
					`Duplicate material: ${id}. List each material once.`,
				);
			}
			seen.add(id);
		}
		if (options.outputDir === undefined || options.outputDir === "") {
			throw new McAssetError(
				"OUTPUT_REQUIRED",
				"variant needs --output-dir with an explicit directory.",
			);
		}
		const outputDir = options.outputDir;
		const isMcpx = inputPath.toLowerCase().endsWith(".mcpx");
		const isPng = inputPath.toLowerCase().endsWith(".png");
		if (!isMcpx && !isPng) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"variant reads an editable .mcpx or .png source.",
				{ input: inputPath },
			);
		}
		const stem = basename(inputPath).replace(/\.(mcpx|png)$/i, "");
		if (stem === "") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"variant needs a named source.",
				{ input: inputPath },
			);
		}
		const sourceText = isMcpx
			? await readInputText(inputPath, "canvas input")
			: undefined;
		const pristineCanvas = isPng
			? (await loadEditableCanvas(inputPath)).canvas
			: undefined;
		const warnings: WarningNote[] = [];
		const files: VariantFileEntry[] = [];
		const payloads: Array<{
			targets: Array<{ path: string; force: boolean }>;
			data: Uint8Array | string;
		}> = [];
		for (const material of materials) {
			let canvas: PixelCanvas;
			let pixelsChanged = 0;
			if (isMcpx) {
				canvas = parseMcpx(sourceText as string);
				for (const layer of canvas.layers) {
					pixelsChanged += recolorLayer(
						canvas,
						layer.id,
						material,
					).pixelsChanged;
				}
			} else {
				canvas = cloneCanvas(pristineCanvas as PixelCanvas);
				const report = recolorRolelessCanvas(canvas, material);
				pixelsChanged = report.pixelsChanged;
			}
			const pngPath = joinPath(outputDir, `${stem}_${material}.png`);
			const mcpxPath = joinPath(outputDir, `${stem}_${material}.mcpx`);
			const pngBytes = encodePng(canvas);
			const mcpxText = ensureMcpxText(canvas, (warning) => {
				warnings.push({ code: warning.code, message: warning.message });
			});
			const force = options.force === true;
			payloads.push(
				{ targets: [{ path: pngPath, force }], data: pngBytes },
				{ targets: [{ path: mcpxPath, force }], data: mcpxText },
			);
			files.push({ material, png: pngPath, mcpx: mcpxPath, pixelsChanged });
		}
		await preflightArtifactTargets(
			{
				pngStdout: false,
				pngFiles: files.map((file) => ({
					path: file.png,
					force: options.force === true,
				})),
				mcpxFiles: files.map((file) => ({
					path: file.mcpx,
					force: options.force === true,
				})),
			},
			{ inputPath, mkdir: options.mkdir },
		);
		await writeArtifactPayloads(payloads, options.mkdir);
		const result = {
			command: "variant",
			profile,
			applied: 0,
			operations: [],
			warnings,
			materials,
			outputDir,
			files,
		};
		if (globalJson) {
			emitEnvelope(successEnvelope(result), streams, route);
		} else {
			emitLog(
				`ok variant profile=${profile} applied=0 outputDir=${outputDir} files=${files.length * 2}`,
				streams,
				route,
			);
			for (const warning of warnings) {
				emitLog(`warning [${warning.code}] ${warning.message}`, streams, route);
			}
		}
		return 0;
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}
