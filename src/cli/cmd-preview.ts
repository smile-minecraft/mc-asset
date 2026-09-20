import { basename } from "node:path";
import { addLayer, createCanvas, replaceLayerPixels } from "../core/canvas.ts";
import { McAssetError } from "../core/errors.ts";
import {
	deriveNineSliceRegions,
	extractGuiScaling,
	type NineSliceFinding,
	nineSliceGeometryError,
	paintNineSliceGuides,
	parseMcmetaText,
} from "../core/mcmeta.ts";
import { resize } from "../core/transform.ts";
import type { RGBA } from "../core/types.ts";
import { validateDimension } from "../core/validate.ts";
import { encodePng, flattenCanvas } from "../io/png.ts";
import { colorKeyOf } from "../mcpx/index.ts";
import {
	assertMinecraftOutputPath,
	emitCommandFailure,
	preflightArtifactTargets,
	readInputText,
	resolveArtifactTargets,
	resolveInputPath,
	type WarningNote,
	writeArtifactPayloads,
} from "./artifacts.ts";
import { buildAsciiDoc, toHex } from "./ascii-doc.ts";
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

export interface PreviewOptions {
	ascii?: boolean | undefined;
	paletteMap?: boolean | undefined;
	scale?: string | undefined;
	nineSlice?: boolean | undefined;
	mcmeta?: string | undefined;
	output?: string | undefined;
	stdout?: boolean | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
	input?: string | undefined;
	profile?: string | undefined;
}

/** Report modes take no file flags; the scale mode owns the PNG channel. */
function rejectReportFileFlags(options: PreviewOptions): void {
	if (
		(options.output !== undefined && options.output !== "") ||
		options.stdout === true ||
		options.force === true ||
		options.mkdir === true ||
		(options.input !== undefined && options.input !== "")
	) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"preview reports take no file flags; --scale writes the PNG.",
		);
	}
}

function parseScaleFactor(raw: string): number {
	const value = Number(raw);
	if (!Number.isInteger(value)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`--scale must be an integer, got "${raw}".`,
			{ scale: raw },
		);
	}
	if (value < 1) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`--scale must be a positive integer, got "${raw}".`,
			{ scale: raw },
		);
	}
	return value;
}

/**
 * Read-only previews with exactly one mode: --ascii prints a
 * .grid-compatible document, --palette-map reports the frozen JSON shape,
 * --scale writes an integer nearest-neighbor PNG, and --nine-slice reports
 * the mcmeta nine-slice geometry (plus a 1:1 border-guide PNG when an
 * output channel is given). Nothing here writes back to the input;
 * --in-place and --source stay undeclared on purpose.
 */
export async function runPreview(
	input: string | undefined,
	options: PreviewOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const ascii = options.ascii === true;
	const paletteMap = options.paletteMap === true;
	const scaled = options.scale !== undefined;
	const nineSlice = options.nineSlice === true;
	const modeCount =
		(ascii ? 1 : 0) +
		(paletteMap ? 1 : 0) +
		(scaled ? 1 : 0) +
		(nineSlice ? 1 : 0);
	if (modeCount === 0) {
		const route = routeStreams({ json: globalJson, stdoutArtifact: false });
		return emitCommandFailure(
			streams,
			route,
			globalJson,
			new McAssetError(
				"INVALID_ARGUMENT",
				"preview needs exactly one of --ascii, --palette-map, --scale N, or --nine-slice.",
			),
		);
	}
	if (modeCount > 1) {
		const route = routeStreams({ json: globalJson, stdoutArtifact: false });
		return emitCommandFailure(
			streams,
			route,
			globalJson,
			new McAssetError(
				"ARGUMENT_CONFLICT",
				"preview takes exactly one of --ascii, --palette-map, --scale N, or --nine-slice.",
			),
		);
	}
	if (ascii || paletteMap) {
		return runPreviewReport(
			input,
			options,
			globalJson,
			streams,
			ascii ? "ascii" : "palette-map",
		);
	}
	if (nineSlice) {
		return runPreviewNineSlice(input, options, globalJson, streams);
	}
	return runPreviewScale(input, options, globalJson, streams);
}

async function runPreviewReport(
	input: string | undefined,
	options: PreviewOptions,
	globalJson: boolean,
	streams: OutputStreams,
	mode: "ascii" | "palette-map",
): Promise<number> {
	// The ASCII document owns stdout as its only payload, so human logs
	// move to stderr; the JSON envelope keeps stdout in --json mode.
	const route = routeStreams({
		json: globalJson,
		stdoutArtifact: mode === "ascii" && !globalJson,
	});
	try {
		const profile = parseProfile(options.profile);
		rejectReportFileFlags(options);
		const inputPath = resolveInputPath(input, undefined, "preview");
		const loaded = await loadEditableCanvas(inputPath);
		const warnings: WarningNote[] = loaded.warnings;
		const canvas = loaded.canvas;
		const pixels = flattenCanvas(canvas);
		if (mode === "ascii") {
			const existing = (canvas.palette?.entries ?? []).map((entry) => ({
				id: entry.id,
				color: { ...entry.color },
			}));
			const doc = buildAsciiDoc(existing, pixels, canvas.width, canvas.height);
			if (globalJson) {
				emitEnvelope(
					successEnvelope({
						command: "preview",
						mode: "ascii",
						profile,
						width: canvas.width,
						height: canvas.height,
						ascii: doc.lines,
						palette: doc.palette,
					}),
					streams,
					route,
				);
			} else {
				emitArtifact(
					new TextEncoder().encode(`${doc.lines.join("\n")}\n`),
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
		const indexFor = new Map<string, number>();
		const colors: Array<{ index: number; color: string; count: number }> = [];
		const rows: number[][] = [];
		for (let y = 0; y < canvas.height; y += 1) {
			const row: number[] = [];
			for (let x = 0; x < canvas.width; x += 1) {
				const offset = (y * canvas.width + x) * 4;
				const color: RGBA = {
					r: pixels[offset] as number,
					g: pixels[offset + 1] as number,
					b: pixels[offset + 2] as number,
					a: pixels[offset + 3] as number,
				};
				const key = colorKeyOf(color);
				let index = indexFor.get(key);
				if (index === undefined) {
					index = colors.length;
					indexFor.set(key, index);
					colors.push({ index, color: toHex(color), count: 0 });
				}
				(colors[index] as { count: number }).count += 1;
				row.push(index);
			}
			rows.push(row);
		}
		const result = {
			command: "preview",
			mode: "palette-map",
			profile,
			width: canvas.width,
			height: canvas.height,
			colors,
			rows,
		};
		if (globalJson) {
			emitEnvelope(successEnvelope(result), streams, route);
		} else {
			emitLog(
				`ok preview profile=${profile} mode=palette-map colors=${colors.length} size=${canvas.width}x${canvas.height}`,
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

/**
 * Nine-slice preview: the sprite PNG plus an explicit --mcmeta report the
 * frozen nine-slice shape (scaling type, border, stretchInner, nine
 * regions, findings). Without --output/--stdout the command is a read-only
 * report with zero files; with a channel it writes a 1:1 preview PNG that
 * keeps every sprite pixel and paints the four 1px border guides.
 *
 * Findings never change the exit code: border overflow is an error finding
 * and stretch_inner only warns, but preview stays out of the exit-3
 * validate family. The input is never modified.
 */
async function runPreviewNineSlice(
	input: string | undefined,
	options: PreviewOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({
		json: globalJson,
		stdoutArtifact: options.stdout === true,
	});
	try {
		const profile = parseProfile(options.profile);
		const mcmetaPath = options.mcmeta;
		if (mcmetaPath === undefined || mcmetaPath === "") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"--nine-slice needs --mcmeta <path>; sibling files are never derived.",
			);
		}
		const hasOutputTarget =
			(options.output !== undefined && options.output !== "") ||
			options.stdout === true;
		if (!hasOutputTarget) {
			rejectReportFileFlags(options);
		}
		const targets = hasOutputTarget
			? resolveArtifactTargets({
					command: "import",
					output: options.output,
					stdout: options.stdout,
					source: undefined,
					force: options.force,
					inPlace: undefined,
					inputPath: undefined,
				})
			: undefined;
		if (options.output !== undefined && options.output !== "") {
			assertMinecraftOutputPath(profile, options.output);
		}
		const inputPath = resolveInputPath(input, options.input, "preview");
		const loaded = await loadEditableCanvas(inputPath);
		const warnings: WarningNote[] = loaded.warnings;
		const canvas = loaded.canvas;
		const pixels = flattenCanvas(canvas);
		const scaling = extractGuiScaling(
			parseMcmetaText(await readInputText(mcmetaPath, "mcmeta"), mcmetaPath),
		);
		const findings: NineSliceFinding[] = [];
		const result: Record<string, unknown> = {
			command: "preview",
			mode: "nine-slice",
			profile,
			width: canvas.width,
			height: canvas.height,
			mcmeta: basename(mcmetaPath),
			scaling: { type: scaling.kind === "none" ? "none" : scaling.kind },
			findings,
		};
		let guides = false;
		if (scaling.kind === "nine_slice") {
			result.nineSlice = {
				border: { ...scaling.border },
				stretchInner: scaling.stretchInner,
			};
			if (scaling.stretchInner) {
				findings.push({
					level: "warning",
					code: "STRETCH_INNER_IGNORED",
					message:
						"stretch_inner is parsed and reported but never applied in this version.",
				});
			}
			const overflow = nineSliceGeometryError(
				canvas.width,
				canvas.height,
				scaling.border,
			);
			if (overflow !== undefined) {
				findings.push({
					level: "error",
					code: "NINE_SLICE_BORDER_OVERFLOW",
					message: overflow,
				});
			} else {
				result.regions = deriveNineSliceRegions(
					canvas.width,
					canvas.height,
					scaling.border,
				);
				guides = true;
			}
		} else if (scaling.kind === "none") {
			findings.push({
				level: "warning",
				code: "NO_NINE_SLICE_SCALING",
				message:
					"mcmeta carries no scaling section; reporting sprite bounds only.",
			});
		} else {
			findings.push({
				level: "warning",
				code: "NON_NINE_SLICE_SCALING",
				message: `mcmeta scaling is ${scaling.kind}; nine-slice regions need a nine_slice scaling.`,
			});
		}
		let pngBytes: Uint8Array | undefined;
		if (targets !== undefined) {
			const outPixels = pixels.slice();
			if (guides && scaling.kind === "nine_slice") {
				paintNineSliceGuides(outPixels, canvas.width, canvas.height, {
					...scaling.border,
				});
			}
			const outCanvas = createCanvas(canvas.width, canvas.height);
			const outLayer = addLayer(outCanvas, { id: "base" });
			replaceLayerPixels(outCanvas, outLayer.id, outPixels);
			pngBytes = encodePng(outCanvas);
			// File-target preflight runs before any stdout artifact byte, so a
			// refusal keeps stdout empty (same TOCTOU note as the tile path).
			await preflightArtifactTargets(targets, {
				inputPath,
				inPlace: undefined,
				mkdir: options.mkdir,
			});
			if (targets.pngStdout && pngBytes !== undefined) {
				emitArtifact(pngBytes, streams, route);
			}
			await writeArtifactPayloads(
				targets.pngFiles.length > 0 && pngBytes !== undefined
					? [{ targets: targets.pngFiles, data: pngBytes }]
					: [],
				options.mkdir,
			);
			if (targets.pngFiles[0] !== undefined) {
				result.output = targets.pngFiles[0].path;
			}
			if (targets.pngStdout) {
				result.stdout = true as const;
			}
		}
		if (globalJson) {
			emitEnvelope(successEnvelope(result), streams, route);
		} else {
			const scalingType = (result.scaling as { type: string }).type;
			const parts = [
				`ok preview profile=${profile} mode=nine-slice size=${canvas.width}x${canvas.height} scaling=${scalingType}`,
			];
			if (typeof result.output === "string") {
				parts.push(`output=${result.output}`);
			}
			if (result.stdout === true) {
				parts.push("stdout=true");
			}
			emitLog(parts.join(" "), streams, route);
			for (const finding of findings) {
				emitLog(
					`finding [${finding.level}] [${finding.code}] ${finding.message}`,
					streams,
					route,
				);
			}
			for (const warning of warnings) {
				emitLog(`warning [${warning.code}] ${warning.message}`, streams, route);
			}
		}
		return 0;
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}

async function runPreviewScale(
	input: string | undefined,
	options: PreviewOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({
		json: globalJson,
		stdoutArtifact: options.stdout === true,
	});
	try {
		const profile = parseProfile(options.profile);
		const factor = parseScaleFactor(options.scale as string);
		// Union output guard before any pixel work: a missing channel is
		// OUTPUT_REQUIRED with zero files, mirroring tile --preview.
		const targets = resolveArtifactTargets({
			command: "import",
			output: options.output,
			stdout: options.stdout,
			source: undefined,
			force: options.force,
			inPlace: undefined,
			inputPath: undefined,
		});
		if (options.output !== undefined && options.output !== "") {
			assertMinecraftOutputPath(profile, options.output);
		}
		const inputPath = resolveInputPath(input, options.input, "preview");
		const loaded = await loadEditableCanvas(inputPath);
		const warnings: WarningNote[] = loaded.warnings;
		const canvas = loaded.canvas;
		const outWidth = canvas.width * factor;
		const outHeight = canvas.height * factor;
		validateDimension(outWidth);
		validateDimension(outHeight);
		resize(canvas, outWidth, outHeight, "nearest");
		const pngBytes = encodePng(canvas);
		// File-target preflight runs before any stdout artifact byte, so a
		// refusal keeps stdout empty (same TOCTOU note as the tile path).
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
			command: "preview",
			mode: "scale",
			profile,
			width: outWidth,
			height: outHeight,
			scale: factor,
			...(targets.pngFiles[0] !== undefined
				? { output: targets.pngFiles[0].path }
				: {}),
			...(targets.pngStdout ? { stdout: true as const } : {}),
		};
		if (globalJson) {
			emitEnvelope(successEnvelope(result), streams, route);
		} else {
			const parts = [
				`ok preview profile=${profile} mode=scale size=${outWidth}x${outHeight} scale=${factor}`,
			];
			if (typeof result.output === "string") {
				parts.push(`output=${result.output}`);
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
