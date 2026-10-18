import { readdir } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { addLayer, createCanvas, replaceLayerPixels } from "../core/canvas.ts";
import { McAssetError } from "../core/errors.ts";
import {
	createFrameSet,
	describeFrameSet,
	frameFileName,
	frameOutputFileName,
	type PackedSheet,
	packFrameSet,
	parseAnimationLayout,
	parseFrameOrder,
	parseFrameOutputFormat,
	parseFrameSize,
	parseGridColumns,
	reorderFrames,
	resizeFrameSet,
	unpackSheetToFrameSet,
} from "../core/frameset.ts";
import {
	checkAnimationFrameIndices,
	deriveAnimationGeometry,
	extractAnimationSection,
	parseMcmetaText,
} from "../core/mcmeta.ts";
import {
	generateAnimationMcmeta,
	type TimelinePreset,
} from "../core/mcmeta-generate.ts";
import {
	generateSweepFrames,
	parseSweepAngleDegrees,
	parseSweepColor,
	parseSweepFrameCount,
	parseSweepWidthPixels,
	type SweepAngleDegrees,
} from "../core/sweep.ts";
import type { ResizeMode } from "../core/transform.ts";
import type { PixelCanvas } from "../core/types.ts";
import { decodePng, encodePng } from "../io/png.ts";
import { parseMcpx } from "../mcpx/index.ts";
import { resolveStyle } from "../style/load.ts";
import {
	assertMinecraftOutputPath,
	emitCommandFailure,
	ensureMcpxText,
	type FileTarget,
	preflightArtifactTargets,
	type ResolvedArtifacts,
	readInputFile,
	readInputText,
	type WarningNote,
	writeArtifactPayloads,
} from "./artifacts.ts";
import { buildAsciiDoc } from "./ascii-doc.ts";
import {
	emitArtifact,
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
	type StreamRoute,
} from "./channels.ts";
import { successEnvelope } from "./envelope.ts";
import { planMcmetaOutput, writeMcmetaOutput } from "./mcmeta-request.ts";
import { parseProfile } from "./profiles.ts";
import type { PlannedTarget } from "./safe-output.ts";

export type AnimateMode =
	| "pack"
	| "unpack"
	| "reorder"
	| "resize"
	| "validate"
	| "preview"
	| "sweep";

export interface AnimateOptions {
	framesDir?: string | undefined;
	outputDir?: string | undefined;
	output?: string | undefined;
	stdout?: boolean | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
	layout?: string | undefined;
	columns?: string | undefined;
	frameSize?: string | undefined;
	order?: string | undefined;
	resizeMode?: string | undefined;
	ascii?: boolean | undefined;
	profile?: string | undefined;
	mcmeta?: string | undefined;
	/** sweep: band width in pixels. */
	width?: string | undefined;
	/** sweep: band angle in degrees. */
	angle?: string | undefined;
	/** sweep: band colour as #RRGGBB. */
	color?: string | undefined;
	/** sweep: how many frames to emit. */
	frames?: string | undefined;
	/** sweep: ticks per frame of the generated document. */
	frametime?: string | undefined;
	/** sweep: ticks the first frame rests for. */
	holdTicks?: string | undefined;
	/** sweep: preset id or .style.json path holding the animation defaults. */
	style?: string | undefined;
	/** sweep: explicit .mcmeta output path. */
	outputMcmeta?: string | undefined;
	/** unpack: per-frame output format, mcpx by default. */
	format?: string | undefined;
}

/** Byte-lexicographic order per section 100.3 (UTF-8 bytes, not UTF-16 units). */
function byteCompare(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
}

interface LoadedFrames {
	frames: PixelCanvas[];
	texts: string[];
	names: string[];
	warnings: WarningNote[];
}

/**
 * Read a frames directory: direct .mcpx children only, sorted by filename
 * bytes. Non-.mcpx entries are ignored with a NON_MCPX_IGNORED warning;
 * an empty set is INVALID_ANIMATION_FRAME and mismatched geometry throws
 * with the frame index in details.
 */
async function loadFramesDir(framesDir: string): Promise<LoadedFrames> {
	let entries: Array<{ name: string; isFile: boolean }>;
	try {
		const raw = await readdir(framesDir, { withFileTypes: true });
		entries = raw.map((entry) => ({
			name: entry.name,
			isFile: entry.isFile(),
		}));
	} catch {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Cannot read frames directory: ${framesDir}.`,
			{ path: framesDir },
		);
	}
	const warnings: WarningNote[] = [];
	for (const entry of entries) {
		if (!entry.isFile || !entry.name.toLowerCase().endsWith(".mcpx")) {
			warnings.push({
				code: "NON_MCPX_IGNORED",
				message: `Ignoring non-frame entry: ${entry.name}.`,
			});
		}
	}
	const names = entries
		.filter(
			(entry) => entry.isFile && entry.name.toLowerCase().endsWith(".mcpx"),
		)
		.map((entry) => entry.name)
		.sort(byteCompare);
	if (names.length === 0) {
		throw new McAssetError(
			"INVALID_ANIMATION_FRAME",
			`Frames directory holds no .mcpx frames: ${framesDir}.`,
			{ path: framesDir, count: 0 },
		);
	}
	const frames: PixelCanvas[] = [];
	const texts: string[] = [];
	for (const name of names) {
		const text = await readInputText(joinPath(framesDir, name), "frame input");
		frames.push(parseMcpx(text));
		texts.push(text);
	}
	// Geometry gate before any output decision: mismatches exit 2 here.
	createFrameSet(frames);
	return { frames, texts, names, warnings };
}

/**
 * Modes that only report take no file flags; the writer owns the file
 * channel. `preview` is the one reporting mode that may write: `--output`
 * takes its sheet image, with `--force` and `--mkdir` as the companions.
 */
function rejectFileFlags(options: AnimateOptions, mode: AnimateMode): void {
	const outputGiven = options.output !== undefined && options.output !== "";
	const writable = mode === "preview" && outputGiven;
	const flags: [string, boolean, boolean][] = [
		["--output", outputGiven, false],
		["--stdout", options.stdout === true, false],
		["--force", options.force === true, true],
		["--mkdir", options.mkdir === true, true],
		["--output-dir", (options.outputDir ?? "") !== "", false],
	];
	for (const [flag, given, followsOutput] of flags) {
		if (!given) continue;
		if (writable && (flag === "--output" || followsOutput)) continue;
		throw new McAssetError(
			"INVALID_ARGUMENT",
			mode === "preview"
				? `animate ${mode} accepts only --output with --force or --mkdir; ${flag} needs an output.`
				: `animate ${mode} is read-only and takes no file flags.`,
		);
	}
}

function parseResizeMode(raw: string | undefined): ResizeMode {
	if (raw === undefined || raw === "") {
		return "nearest";
	}
	if (raw !== "nearest" && raw !== "box" && raw !== "pixel-aware") {
		throw new McAssetError("INVALID_ARGUMENT", "Unknown resize mode.", {
			mode: raw,
		});
	}
	return raw;
}

function emitHumanWarnings(
	warnings: WarningNote[],
	streams: OutputStreams,
	route: StreamRoute,
): void {
	for (const warning of warnings) {
		emitLog(`warning [${warning.code}] ${warning.message}`, streams, route);
	}
}

/**
 * Read-only mcmeta intake shared by unpack (geometry guard) and validate
 * (frame correspondence). The path is used verbatim — a sibling file is
 * never derived — and nothing here writes. Syntax and structural problems
 * surface as INVALID_MCMETA with the field location in details.path.
 */
async function readAnimationMcmeta(mcmetaPath: string) {
	const text = await readInputText(mcmetaPath, "mcmeta");
	return extractAnimationSection(parseMcmetaText(text, mcmetaPath));
}

async function runPack(
	options: AnimateOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({
		json: globalJson,
		stdoutArtifact: options.stdout === true && !globalJson,
	});
	try {
		const profile = parseProfile(options.profile);
		const layout = parseAnimationLayout(options.layout);
		const columns = parseGridColumns(layout, options.columns);
		if (options.framesDir === undefined || options.framesDir === "") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"animate pack needs --frames-dir with an explicit directory.",
			);
		}
		if (
			(options.output === undefined || options.output === "") &&
			options.stdout !== true
		) {
			throw new McAssetError(
				"OUTPUT_REQUIRED",
				"animate pack needs --output or --stdout.",
			);
		}
		if (options.output !== undefined && options.output !== "") {
			assertMinecraftOutputPath(profile, options.output);
		}
		const loaded = await loadFramesDir(options.framesDir);
		const frameSet = createFrameSet(loaded.frames);
		const sheet = packFrameSet(frameSet, layout, columns);
		const canvas = createCanvas(sheet.width, sheet.height);
		const layer = addLayer(canvas, { id: "base" });
		replaceLayerPixels(canvas, layer.id, sheet.pixels);
		const pngBytes = encodePng(canvas);
		const force = options.force === true;
		const resolved: ResolvedArtifacts = {
			pngStdout: options.stdout === true,
			pngFiles:
				options.output !== undefined && options.output !== ""
					? [{ path: options.output, force }]
					: [],
			mcpxFiles: [],
		};
		await preflightArtifactTargets(resolved, { mkdir: options.mkdir });
		if (resolved.pngStdout) {
			emitArtifact(pngBytes, streams, route);
		}
		await writeArtifactPayloads(
			resolved.pngFiles.length > 0
				? [{ targets: resolved.pngFiles, data: pngBytes }]
				: [],
			options.mkdir,
		);
		const result = {
			command: "animate",
			mode: "pack",
			profile,
			frameCount: frameSet.frames.length,
			frameWidth: frameSet.frameWidth,
			frameHeight: frameSet.frameHeight,
			layout,
			...(columns !== undefined ? { columns } : {}),
			width: sheet.width,
			height: sheet.height,
			...(resolved.pngFiles[0] !== undefined
				? { output: resolved.pngFiles[0].path }
				: {}),
			...(resolved.pngStdout ? { stdout: true as const } : {}),
			warnings: loaded.warnings,
		};
		if (globalJson) {
			emitEnvelope(successEnvelope(result), streams, route);
		} else {
			const parts = [
				`ok animate mode=pack profile=${profile} frames=${frameSet.frames.length} layout=${layout} size=${sheet.width}x${sheet.height}`,
			];
			if (typeof result.output === "string") {
				parts.push(`output=${result.output}`);
			}
			if (result.stdout === true) {
				parts.push("stdout=true");
			}
			emitLog(parts.join(" "), streams, route);
			emitHumanWarnings(loaded.warnings, streams, route);
		}
		return 0;
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}

interface DirPayload {
	targets: FileTarget[];
	data: Uint8Array | string;
	file: string;
	/** PNG payloads are preflighted on the PNG channel; the rest on the source channel. */
	kind?: "png" | "mcpx";
}

async function writeDirPayloads(
	payloads: DirPayload[],
	options: AnimateOptions,
): Promise<{ files: string[] }> {
	const force = options.force === true;
	const withForce = payloads.map((payload) => ({
		targets: payload.targets.map((target) => ({ ...target, force })),
		data: payload.data,
		kind: payload.kind ?? "mcpx",
	}));
	const pngTargets: FileTarget[] = [];
	const sourceTargets: FileTarget[] = [];
	for (const payload of withForce) {
		const bucket = payload.kind === "png" ? pngTargets : sourceTargets;
		bucket.push(...payload.targets);
	}
	await preflightArtifactTargets(
		{
			pngStdout: false,
			pngFiles: pngTargets,
			mcpxFiles: sourceTargets,
		},
		{ mkdir: options.mkdir },
	);
	await writeArtifactPayloads(withForce, options.mkdir);
	return { files: payloads.map((payload) => payload.file) };
}

/** One single-layer frame as PNG bytes, 1:1 and never resampled. */
function framePngBytes(frame: PixelCanvas): Uint8Array {
	const source = frame.layers[0];
	if (source === undefined) {
		throw new McAssetError("INTERNAL_ERROR", "Frame has no layer to encode.");
	}
	const canvas = createCanvas(frame.width, frame.height);
	const layer = addLayer(canvas, { id: "base" });
	replaceLayerPixels(canvas, layer.id, source.pixels);
	return encodePng(canvas);
}

/** One sheet buffer as PNG bytes, 1:1 and never resampled. */
function sheetPngBytes(
	pixels: Uint8Array,
	width: number,
	height: number,
): Uint8Array {
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: "base" });
	replaceLayerPixels(canvas, layer.id, pixels);
	return encodePng(canvas);
}

function requireOutputDir(options: AnimateOptions, mode: AnimateMode): string {
	if (options.output !== undefined && options.output !== "") {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			`animate ${mode} writes under --output-dir; --output is not accepted here.`,
		);
	}
	if (options.outputDir === undefined || options.outputDir === "") {
		throw new McAssetError(
			"OUTPUT_REQUIRED",
			`animate ${mode} needs --output-dir with an explicit directory.`,
		);
	}
	return options.outputDir;
}

async function runUnpack(
	sheet: string | undefined,
	options: AnimateOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({ json: globalJson, stdoutArtifact: false });
	try {
		const profile = parseProfile(options.profile);
		const layout = parseAnimationLayout(options.layout);
		const columns = parseGridColumns(layout, options.columns);
		const size = parseFrameSize(options.frameSize);
		const format = parseFrameOutputFormat(options.format);
		if (sheet === undefined || sheet === "") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"animate unpack needs a sheet PNG path argument.",
			);
		}
		const outputDir = requireOutputDir(options, "unpack");
		const bytes = await readInputFile(sheet, "sheet input");
		const decoded = decodePng(bytes);
		const sheetLayer = decoded.canvas.layers[0];
		if (sheetLayer === undefined) {
			throw new McAssetError("INTERNAL_ERROR", "Decoded sheet has no layer.");
		}
		if (options.mcmeta !== undefined && options.mcmeta !== "") {
			const animation = await readAnimationMcmeta(options.mcmeta);
			if (animation.present) {
				const geometry = deriveAnimationGeometry(
					decoded.canvas.width,
					decoded.canvas.height,
					animation,
				);
				if (
					geometry.frameWidth !== size.width ||
					geometry.frameHeight !== size.height
				) {
					throw new McAssetError(
						"INVALID_ANIMATION_FRAME",
						`mcmeta frame size ${geometry.frameWidth}x${geometry.frameHeight} does not match --frame-size ${size.width}x${size.height}.`,
						{
							layout,
							sheetWidth: decoded.canvas.width,
							sheetHeight: decoded.canvas.height,
							frameWidth: size.width,
							frameHeight: size.height,
							expected: {
								width: geometry.frameWidth,
								height: geometry.frameHeight,
							},
							actual: { width: size.width, height: size.height },
						},
					);
				}
				checkAnimationFrameIndices(animation, geometry.frameCount);
				// Playback-sequence length is independent of the physical
				// frame count: unpack keeps the geometry and index-range
				// checks above, but repeated or partial indices are legal.
			}
		}
		const frameSet = unpackSheetToFrameSet(
			sheetLayer.pixels,
			decoded.canvas.width,
			decoded.canvas.height,
			layout,
			size.width,
			size.height,
			columns,
		);
		const payloads: DirPayload[] = frameSet.frames.map((frame, index) => {
			const name = frameOutputFileName(index, frameSet.frames.length, format);
			const path = joinPath(outputDir, name);
			if (format === "png") {
				return {
					targets: [{ path, force: false }],
					data: framePngBytes(frame),
					file: name,
					kind: "png",
				};
			}
			const text = ensureMcpxText(frame, () => {});
			return { targets: [{ path, force: false }], data: text, file: name };
		});
		const { files } = await writeDirPayloads(payloads, options);
		const result = {
			command: "animate",
			mode: "unpack",
			profile,
			frameCount: frameSet.frames.length,
			frameWidth: frameSet.frameWidth,
			frameHeight: frameSet.frameHeight,
			layout,
			...(columns !== undefined ? { columns } : {}),
			format,
			outputDir,
			files,
			warnings: [],
		};
		if (globalJson) {
			emitEnvelope(successEnvelope(result), streams, route);
		} else {
			emitLog(
				`ok animate mode=unpack profile=${profile} frames=${frameSet.frames.length} layout=${layout} format=${format} outputDir=${outputDir}`,
				streams,
				route,
			);
		}
		return 0;
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}

async function runReorder(
	options: AnimateOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({ json: globalJson, stdoutArtifact: false });
	try {
		const profile = parseProfile(options.profile);
		if (options.framesDir === undefined || options.framesDir === "") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"animate reorder needs --frames-dir with an explicit directory.",
			);
		}
		const outputDir = requireOutputDir(options, "reorder");
		const loaded = await loadFramesDir(options.framesDir);
		const order = parseFrameOrder(options.order, loaded.frames.length);
		const reordered = reorderFrames(loaded.texts, order);
		const payloads: DirPayload[] = reordered.map((text, index) => {
			const name = frameFileName(index, reordered.length);
			return {
				targets: [{ path: joinPath(outputDir, name), force: false }],
				data: text,
				file: name,
			};
		});
		const { files } = await writeDirPayloads(payloads, options);
		const result = {
			command: "animate",
			mode: "reorder",
			profile,
			frameCount: reordered.length,
			order,
			outputDir,
			files,
			warnings: loaded.warnings,
		};
		if (globalJson) {
			emitEnvelope(successEnvelope(result), streams, route);
		} else {
			emitLog(
				`ok animate mode=reorder profile=${profile} frames=${reordered.length} order=${order.join(",")} outputDir=${outputDir}`,
				streams,
				route,
			);
			emitHumanWarnings(loaded.warnings, streams, route);
		}
		return 0;
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}

async function runResize(
	options: AnimateOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({ json: globalJson, stdoutArtifact: false });
	try {
		const profile = parseProfile(options.profile);
		const size = parseFrameSize(options.frameSize);
		const mode = parseResizeMode(options.resizeMode);
		if (options.framesDir === undefined || options.framesDir === "") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"animate resize needs --frames-dir with an explicit directory.",
			);
		}
		const outputDir = requireOutputDir(options, "resize");
		const loaded = await loadFramesDir(options.framesDir);
		const frameSet = createFrameSet(loaded.frames);
		// The engine applies pixel-aware per frame before any byte is written.
		resizeFrameSet(frameSet, size.width, size.height, mode);
		const payloads: DirPayload[] = frameSet.frames.map((frame, index) => {
			const name = frameFileName(index, frameSet.frames.length);
			const text = ensureMcpxText(frame, () => {});
			return {
				targets: [{ path: joinPath(outputDir, name), force: false }],
				data: text,
				file: name,
			};
		});
		const { files } = await writeDirPayloads(payloads, options);
		const result = {
			command: "animate",
			mode: "resize",
			profile,
			frameCount: frameSet.frames.length,
			frameWidth: size.width,
			frameHeight: size.height,
			resizeMode: mode,
			outputDir,
			files,
			warnings: loaded.warnings,
		};
		if (globalJson) {
			emitEnvelope(successEnvelope(result), streams, route);
		} else {
			emitLog(
				`ok animate mode=resize profile=${profile} frames=${frameSet.frames.length} size=${size.width}x${size.height} mode=${mode} outputDir=${outputDir}`,
				streams,
				route,
			);
			emitHumanWarnings(loaded.warnings, streams, route);
		}
		return 0;
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}

async function runValidate(
	options: AnimateOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({ json: globalJson, stdoutArtifact: false });
	try {
		const profile = parseProfile(options.profile);
		rejectFileFlags(options, "validate");
		if (options.framesDir === undefined || options.framesDir === "") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"animate validate needs --frames-dir with an explicit directory.",
			);
		}
		const loaded = await loadFramesDir(options.framesDir);
		const frameSet = createFrameSet(loaded.frames);
		const report = describeFrameSet(frameSet);
		if (options.mcmeta !== undefined && options.mcmeta !== "") {
			const animation = await readAnimationMcmeta(options.mcmeta);
			if (animation.present) {
				const expectedWidth = animation.width ?? frameSet.frameWidth;
				const expectedHeight = animation.height ?? frameSet.frameHeight;
				if (
					expectedWidth !== frameSet.frameWidth ||
					expectedHeight !== frameSet.frameHeight
				) {
					throw new McAssetError(
						"INVALID_ANIMATION_FRAME",
						`mcmeta frame size ${expectedWidth}x${expectedHeight} does not match frames ${frameSet.frameWidth}x${frameSet.frameHeight}.`,
						{
							expected: { width: expectedWidth, height: expectedHeight },
							actual: {
								width: frameSet.frameWidth,
								height: frameSet.frameHeight,
							},
						},
					);
				}
				checkAnimationFrameIndices(animation, frameSet.frames.length);
				// Playback-sequence length is independent of the physical
				// frame count: repeated or partial indices are legal; only
				// out-of-range indices fail via the check above.
			}
		}
		if (report.verdict === "fail") {
			throw new McAssetError(
				"VALIDATION_FAILED",
				`animate validate failed: ${report.frameCount} frames.`,
			);
		}
		const result = { ...report, profile, warnings: loaded.warnings };
		if (globalJson) {
			emitEnvelope(successEnvelope(result), streams, route);
		} else {
			emitLog(
				`verdict: ${report.verdict}\nframes: ${report.frameCount}\ndimensions: ${report.frameWidth}x${report.frameHeight}`,
				streams,
				route,
			);
			emitHumanWarnings(loaded.warnings, streams, route);
		}
		return 0;
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}

async function runPreview(
	options: AnimateOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const ascii = options.ascii === true;
	const route = routeStreams({
		json: globalJson,
		stdoutArtifact: ascii && !globalJson,
	});
	try {
		const profile = parseProfile(options.profile);
		rejectFileFlags(options, "preview");
		const layout = parseAnimationLayout(options.layout);
		const columns = parseGridColumns(layout, options.columns);
		if (options.framesDir === undefined || options.framesDir === "") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"animate preview needs --frames-dir with an explicit directory.",
			);
		}
		const loaded = await loadFramesDir(options.framesDir);
		const frameSet = createFrameSet(loaded.frames);
		const sheet = packFrameSet(frameSet, layout, columns);
		const frameList = frameSet.frames.map((_, index) => ({ index }));
		const outputPath =
			options.output === undefined || options.output === ""
				? undefined
				: options.output;
		if (outputPath !== undefined) {
			assertMinecraftOutputPath(profile, outputPath);
		}
		if (ascii) {
			const doc = buildAsciiDoc([], sheet.pixels, sheet.width, sheet.height);
			if (globalJson) {
				emitEnvelope(
					successEnvelope({
						command: "animate",
						mode: "preview",
						profile,
						layout,
						...(columns !== undefined ? { columns } : {}),
						frameCount: frameSet.frames.length,
						frameWidth: frameSet.frameWidth,
						frameHeight: frameSet.frameHeight,
						sheetWidth: sheet.width,
						sheetHeight: sheet.height,
						ascii: doc.lines,
						palette: doc.palette,
						warnings: loaded.warnings,
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
				emitHumanWarnings(loaded.warnings, streams, route);
			}
			return 0;
		}
		const written =
			outputPath === undefined
				? undefined
				: await writeSheetImage(sheet, outputPath, options);
		const result = {
			command: "animate",
			mode: "preview",
			profile,
			layout,
			...(columns !== undefined ? { columns } : {}),
			frameCount: frameSet.frames.length,
			frameWidth: frameSet.frameWidth,
			frameHeight: frameSet.frameHeight,
			sheetWidth: sheet.width,
			sheetHeight: sheet.height,
			frames: frameList,
			...(written !== undefined ? { output: written } : {}),
			warnings: loaded.warnings,
		};
		if (globalJson) {
			emitEnvelope(successEnvelope(result), streams, route);
		} else {
			emitLog(
				`ok animate mode=preview profile=${profile} frames=${frameSet.frames.length} layout=${layout} sheet=${sheet.width}x${sheet.height}`,
				streams,
				route,
			);
			emitHumanWarnings(loaded.warnings, streams, route);
		}
		return 0;
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}

/**
 * Write the packed sheet as a PNG through the shared target guards. Used by
 * `animate preview --output`; the sheet layout is exactly the one the report
 * describes, so the image never resamples or reorders anything.
 */
async function writeSheetImage(
	sheet: PackedSheet,
	outputPath: string,
	options: AnimateOptions,
): Promise<string> {
	const pngBytes = sheetPngBytes(sheet.pixels, sheet.width, sheet.height);
	const resolved: ResolvedArtifacts = {
		pngStdout: false,
		pngFiles: [{ path: outputPath, force: options.force === true }],
		mcpxFiles: [],
	};
	await preflightArtifactTargets(resolved, { mkdir: options.mkdir });
	await writeArtifactPayloads(
		[{ targets: resolved.pngFiles, data: pngBytes }],
		options.mkdir,
	);
	return outputPath;
}

/** The effective sweep parameters after style defaults and flag overrides. */
interface SweepOptions {
	readonly preset: TimelinePreset;
	readonly frametime: number;
	readonly holdTicks: number;
	readonly frames: number;
	readonly angle: SweepAngleDegrees;
	readonly width: number;
	readonly color: string;
	readonly interpolate: boolean;
}

/**
 * Resolve the band defaults: a builtin style id or a `.style.json` path
 * (default `vanilla`), then every flag overrides one field of the resolved
 * animation rules. The core engine only ever receives integers.
 */
async function resolveSweepOptions(
	options: AnimateOptions,
): Promise<SweepOptions> {
	const style = await resolveStyle(
		options.style === undefined || options.style === ""
			? "vanilla"
			: options.style,
	);
	const rules = style.animation;
	return {
		preset: rules.timelinePreset,
		frametime:
			options.frametime === undefined || options.frametime === ""
				? rules.frametime
				: Number(options.frametime),
		holdTicks:
			options.holdTicks === undefined || options.holdTicks === ""
				? rules.holdTicks
				: Number(options.holdTicks),
		frames:
			options.frames === undefined || options.frames === ""
				? rules.sweepFrames
				: parseSweepFrameCount(options.frames),
		angle:
			options.angle === undefined || options.angle === ""
				? rules.sweepAngleDegrees
				: parseSweepAngleDegrees(options.angle),
		width:
			options.width === undefined || options.width === ""
				? rules.sweepWidthPixels
				: parseSweepWidthPixels(options.width),
		color:
			options.color === undefined || options.color === ""
				? rules.sweepColor
				: options.color,
		interpolate: rules.interpolate,
	};
}

/**
 * `animate sweep`: one still image in, a vertical sheet of sweep frames plus
 * an optional companion document out. The band parameters come from the
 * style's animation rules unless a flag overrides one; the document follows
 * the same style's timeline preset and hold ticks.
 */
async function runSweep(
	source: string | undefined,
	options: AnimateOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({
		json: globalJson,
		stdoutArtifact: options.stdout === true && !globalJson,
	});
	try {
		const profile = parseProfile(options.profile);
		if (source === undefined || source === "") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"animate sweep needs a source image path argument.",
			);
		}
		if (
			(options.output === undefined || options.output === "") &&
			options.stdout !== true
		) {
			throw new McAssetError(
				"OUTPUT_REQUIRED",
				"animate sweep needs --output or --stdout.",
			);
		}
		const resolved = await resolveSweepOptions(options);
		const color = parseSweepColor(resolved.color);
		const bytes = await readInputFile(source, "sweep input");
		const decoded = decodePng(bytes);
		const sweep = generateSweepFrames({
			canvas: decoded.canvas,
			angleDegrees: resolved.angle,
			widthPixels: resolved.width,
			color,
			frames: resolved.frames,
		});
		const sheet = packFrameSet(sweep.frameSet, "vertical");
		const pngBytes = sheetPngBytes(sheet.pixels, sheet.width, sheet.height);
		const document = generateAnimationMcmeta({
			sheetWidth: sheet.width,
			sheetHeight: sheet.height,
			frameSize: `${sweep.frameSet.frameWidth}`,
			frametime: resolved.frametime,
			preset: resolved.preset,
			holdTicks: resolved.holdTicks,
			interpolate: resolved.interpolate,
		}).text;
		if (options.output !== undefined && options.output !== "") {
			assertMinecraftOutputPath(profile, options.output);
		}
		const pngTargets: FileTarget[] =
			options.output === undefined || options.output === ""
				? []
				: [{ path: options.output, force: options.force === true }];
		const artifacts: ResolvedArtifacts = {
			pngStdout: options.stdout === true,
			pngFiles: pngTargets,
			mcpxFiles: [],
		};
		const mcmetaPlan: readonly PlannedTarget[] =
			options.outputMcmeta === undefined || options.outputMcmeta === ""
				? []
				: await planMcmetaOutput({
						output: options.outputMcmeta,
						inputPath: source,
						force: options.force === true,
						mkdir: options.mkdir === true,
					});
		await preflightArtifactTargets(artifacts, {
			mkdir: options.mkdir,
			inputPath: source,
		});
		if (artifacts.pngStdout) {
			emitArtifact(pngBytes, streams, route);
		}
		await writeArtifactPayloads(
			pngTargets.length > 0 ? [{ targets: pngTargets, data: pngBytes }] : [],
			options.mkdir,
		);
		if (mcmetaPlan.length > 0) {
			await writeMcmetaOutput(mcmetaPlan, document, options.mkdir === true);
		}
		const result = {
			command: "animate",
			mode: "sweep",
			profile,
			frameCount: sweep.frameSet.frames.length,
			frameWidth: sweep.frameSet.frameWidth,
			frameHeight: sweep.frameSet.frameHeight,
			layout: "vertical",
			angle: resolved.angle,
			width: resolved.width,
			color: resolved.color,
			sheetWidth: sheet.width,
			sheetHeight: sheet.height,
			...(pngTargets[0] !== undefined ? { output: pngTargets[0].path } : {}),
			...(options.stdout === true ? { stdout: true as const } : {}),
			...(mcmetaPlan[0] !== undefined
				? { outputMcmeta: mcmetaPlan[0].path }
				: {}),
			warnings: [],
		};
		if (globalJson) {
			emitEnvelope(successEnvelope(result), streams, route);
		} else {
			const parts = [
				`ok animate mode=sweep profile=${profile} frames=${result.frameCount} angle=${resolved.angle} width=${resolved.width} sheet=${sheet.width}x${sheet.height}`,
			];
			if (pngTargets[0] !== undefined)
				parts.push(`output=${pngTargets[0].path}`);
			if (options.stdout === true) parts.push("stdout=true");
			if (mcmetaPlan[0] !== undefined) {
				parts.push(`outputMcmeta=${mcmetaPlan[0].path}`);
			}
			emitLog(parts.join(" "), streams, route);
		}
		return 0;
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}

/**
 * FrameSet command family: pack / sweep / unpack / reorder / resize write
 * files under the §98 guards, validate stays read-only and preview writes
 * only when asked for an image. `unpack` and `validate` take an explicit
 * `--mcmeta` for the read-only frame geometry correspondence; no mode
 * derives a sibling file and no mode writes JSON.
 */
export async function runAnimate(
	mode: AnimateMode,
	positional: string | undefined,
	options: AnimateOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	switch (mode) {
		case "pack":
			return runPack(options, globalJson, streams);
		case "unpack":
			return runUnpack(positional, options, globalJson, streams);
		case "reorder":
			return runReorder(options, globalJson, streams);
		case "resize":
			return runResize(options, globalJson, streams);
		case "validate":
			return runValidate(options, globalJson, streams);
		case "preview":
			return runPreview(options, globalJson, streams);
		case "sweep":
			return runSweep(positional, options, globalJson, streams);
	}
}
