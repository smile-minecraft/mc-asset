import { basename, join as joinPath } from "node:path";
import { McAssetError } from "../core/errors.ts";
import { isBuiltinMaterialId } from "../core/material.ts";
import {
	recolorCanvasByFamily,
	recolorLayer,
	recolorRolelessCanvas,
} from "../core/recolor.ts";
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
import {
	cloneCanvas,
	loadEditableCanvas,
	resolveCommandSelection,
	restoreUnselectedPixels,
	snapshotLayerBytes,
} from "./canvas-input.ts";
import {
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { resolveStyleFamilyRamps } from "./cmd-recolor.ts";
import { successEnvelope } from "./envelope.ts";
import { parseProfile } from "./profiles.ts";

export interface VariantOptions {
	materials?: string | undefined;
	families?: string | undefined;
	style?: string | undefined;
	selection?: string | undefined;
	region?: string | undefined;
	nameTemplate?: string | undefined;
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
function parseNameList(raw: string | undefined): string[] {
	if (raw === undefined || raw === "") {
		return [];
	}
	return raw
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");
}

/**
 * Expand a variant name template. `{stem}` and `{name}` are the only
 * placeholders; omitting the template keeps the `{stem}_{name}` default.
 */
export function expandVariantName(
	template: string | undefined,
	stem: string,
	name: string,
): string {
	const source =
		template === undefined || template === "" ? "{stem}_{name}" : template;
	return source.split("{stem}").join(stem).split("{name}").join(name);
}

/**
 * Variant fan-out: one editable .mcpx or flat PNG source is recolored once
 * per --materials and --families entry, writing <name>.png plus <name>.mcpx
 * under the explicit --output-dir, where <name> is the template expansion
 * (`{stem}_{name}` by default). Each entry starts from the pristine source,
 * so reruns stay byte-identical and entries never stack on each other.
 *
 * Guard order keeps failures file-free: argument conflicts and the
 * missing --output-dir refusal happen before any read, unknown materials,
 * families, and expanded-name collisions fail before any write, and the
 * union file preflight runs before the first byte lands.
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
		const materials = parseNameList(options.materials);
		const families = parseNameList(options.families);
		if (materials.length === 0 && families.length === 0) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"variant needs at least one material or family via --materials or --families.",
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
		const regionId =
			options.region === undefined || options.region === ""
				? undefined
				: options.region;
		const entries: Array<{ name: string; family: boolean }> = [
			...materials.map((name) => ({ name, family: false })),
			...families.map((name) => ({ name, family: true })),
		];
		const baseNames = new Set<string>();
		for (const entry of entries) {
			const base = expandVariantName(options.nameTemplate, stem, entry.name);
			if (base === "") {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					"variant needs a non-empty output name.",
					{ nameTemplate: options.nameTemplate },
				);
			}
			if (baseNames.has(base)) {
				throw new McAssetError(
					"ARGUMENT_CONFLICT",
					`Duplicate variant name: ${base}. List each material and family once.`,
				);
			}
			baseNames.add(base);
		}
		const ramps = await resolveStyleFamilyRamps(options.style, families);
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
		for (const entry of entries) {
			const canvas = isMcpx
				? parseMcpx(sourceText as string)
				: cloneCanvas(pristineCanvas as PixelCanvas);
			const selection = resolveCommandSelection(
				canvas,
				options.selection,
				false,
			);
			const before = snapshotLayerBytes(canvas);
			if (entry.family) {
				const ramp = ramps.get(entry.name);
				recolorCanvasByFamily(canvas, entry.name, {
					...(regionId !== undefined ? { regionId } : {}),
					...(ramp !== undefined ? { ramp } : {}),
				});
			} else if (isMcpx) {
				for (const layer of canvas.layers) {
					recolorLayer(canvas, layer.id, entry.name, {
						...(regionId !== undefined ? { regionId } : {}),
					});
				}
			} else {
				recolorRolelessCanvas(canvas, entry.name, {
					...(regionId !== undefined ? { regionId } : {}),
				});
			}
			const pixelsChanged = restoreUnselectedPixels(canvas, before, selection);
			const base = expandVariantName(options.nameTemplate, stem, entry.name);
			const pngPath = joinPath(outputDir, `${base}.png`);
			const mcpxPath = joinPath(outputDir, `${base}.mcpx`);
			const pngBytes = encodePng(canvas);
			const mcpxText = ensureMcpxText(canvas, (warning) => {
				warnings.push({ code: warning.code, message: warning.message });
			});
			const force = options.force === true;
			payloads.push(
				{ targets: [{ path: pngPath, force }], data: pngBytes },
				{ targets: [{ path: mcpxPath, force }], data: mcpxText },
			);
			files.push({
				material: entry.name,
				png: pngPath,
				mcpx: mcpxPath,
				pixelsChanged,
			});
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
			families,
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
