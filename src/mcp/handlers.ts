import { Buffer } from "node:buffer";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join as joinPath } from "node:path";
import type { z } from "zod";
import { analyzeCanvas } from "../analyze/metrics.ts";
import {
	applyBatchText,
	assertMinecraftOutputPath,
	defaultLayerFor,
	ensureMcpxText,
	readInputFile,
	readInputText,
	type WarningNote,
} from "../cli/artifacts.ts";
import { buildAsciiDoc, toHex } from "../cli/ascii-doc.ts";
import {
	loadEditableCanvas,
	loadRasterCanvas,
	resolveCommandSelection,
	restoreUnselectedPixels,
	snapshotLayerBytes,
} from "../cli/canvas-input.ts";
import { atomicWriteFile } from "../cli/filesystem.ts";
import { parseGridFile } from "../cli/grid.ts";
import { parseOperationsJson } from "../cli/operations-json.ts";
import { parseProfile } from "../cli/profiles.ts";
import type { ValidateMcmetaSection } from "../cli/validate.ts";
import {
	formatVersionTarget,
	resolveVersionTarget,
	versionReportShape,
} from "../cli/version-options.ts";
import { applyOperations, type BatchReport } from "../core/batch.ts";
import { addLayer, createCanvas, replaceLayerPixels } from "../core/canvas.ts";
import {
	CLEANUP_CLASSES,
	type CleanupClass,
	detectCleanup,
	fixCleanup,
} from "../core/cleanup.ts";
import { McAssetError } from "../core/errors.ts";
import {
	createFrameSet,
	describeFrameSet,
	frameFileName,
	packFrameSet,
	parseAnimationLayout,
	parseFrameOrder,
	parseFrameSize,
	parseGridColumns,
	reorderFrames,
	resizeFrameSet,
	unpackSheetToFrameSet,
} from "../core/frameset.ts";
import {
	getMaterial,
	getMaterialPalette,
	isBuiltinMaterialId,
	listMaterialIds,
} from "../core/material.ts";
import {
	checkAnimationFrameIndices,
	deriveAnimationGeometry,
	deriveNineSliceRegions,
	extractAnimationSection,
	extractGuiScaling,
	extractTextureSection,
	mipmapCutoutMeanWarning,
	type NineSliceFinding,
	nineSliceGeometryError,
	paintNineSliceGuides,
	parseMcmetaText,
} from "../core/mcmeta.ts";
import { extractPalette, inspectPalette } from "../core/palette.ts";
import {
	describePixelizePreset,
	parsePixelizeSize,
	runPixelize,
} from "../core/pixelize.ts";
import {
	generateProcedural,
	parseGeneratePattern,
	parseGenerateSeed,
} from "../core/procedural.ts";
import {
	assertMcpxPaletteCapacity,
	quantizePixels,
	validateColorsOption,
} from "../core/quantizer.ts";
import { recolorLayer } from "../core/recolor.ts";
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
import {
	crop,
	flipHorizontal,
	flipVertical,
	pad,
	type ResizeMode,
	resize,
	rotate90,
	rotate180,
	rotate270,
	translate,
} from "../core/transform.ts";
import type { PixelCanvas, Rect, RGBA } from "../core/types.ts";
import { validateDimension } from "../core/validate.ts";
import { decodePng, encodePng, flattenCanvas } from "../io/png.ts";
import { collectCanvasColors, colorKeyOf, parseMcpx } from "../mcpx/index.ts";
import type { ValidateFinding, ValidateReport } from "../validate/checks.ts";
import { validateCanvas } from "../validate/checks.ts";
import { scanPack } from "../validate/pack.ts";
import type { TOOL_INPUT_SCHEMAS } from "./schema.ts";

/**
 * MCP tool handlers: thin composition over the existing Core and CLI
 * helpers. No image logic is reimplemented here; every tool delegates to
 * the same functions the CLI commands use, then packs the outcome into a
 * deterministic JSON text block (fixed key order, no timestamps).
 *
 * Output rule: an artifact is written to disk only when its explicit path
 * is provided; otherwise it is embedded in the result (PNG as base64,
 * `.mcpx` as text). Missing parents are FILESYSTEM_ERROR without
 * auto-creation, and existing files are OUTPUT_EXISTS without overwrite.
 */

export interface McpTextResult {
	[k: string]: unknown;
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean | undefined;
}

export type AnalyzeAssetInput = z.infer<
	z.ZodObject<typeof TOOL_INPUT_SCHEMAS.analyze_asset>
>;
export type PixelizeAssetInput = z.infer<
	z.ZodObject<typeof TOOL_INPUT_SCHEMAS.pixelize_asset>
>;
export type RenderPixelAssetInput = z.infer<
	z.ZodObject<typeof TOOL_INPUT_SCHEMAS.render_pixel_asset>
>;
export type ApplyAssetOperationsInput = z.infer<
	z.ZodObject<typeof TOOL_INPUT_SCHEMAS.apply_asset_operations>
>;
export type RecolorAssetInput = z.infer<
	z.ZodObject<typeof TOOL_INPUT_SCHEMAS.recolor_asset>
>;
export type CreateVariantsInput = z.infer<
	z.ZodObject<typeof TOOL_INPUT_SCHEMAS.create_variants>
>;
export type ValidateAssetInput = z.infer<
	z.ZodObject<typeof TOOL_INPUT_SCHEMAS.validate_asset>
>;
export type ImportAssetInput = z.infer<
	z.ZodObject<typeof TOOL_INPUT_SCHEMAS.import_asset>
>;
export type BuildAssetInput = z.infer<
	z.ZodObject<typeof TOOL_INPUT_SCHEMAS.build_asset>
>;
export type TransformAssetInput = z.infer<
	z.ZodObject<typeof TOOL_INPUT_SCHEMAS.transform_asset>
>;
export type QuantizeAssetInput = z.infer<
	z.ZodObject<typeof TOOL_INPUT_SCHEMAS.quantize_asset>
>;
export type CleanupAssetInput = z.infer<
	z.ZodObject<typeof TOOL_INPUT_SCHEMAS.cleanup_asset>
>;
export type PaletteAssetInput = z.infer<
	z.ZodObject<typeof TOOL_INPUT_SCHEMAS.palette_asset>
>;
export type MaterialAssetInput = z.infer<
	z.ZodObject<typeof TOOL_INPUT_SCHEMAS.material_asset>
>;
export type TileAssetInput = z.infer<
	z.ZodObject<typeof TOOL_INPUT_SCHEMAS.tile_asset>
>;
export type GenerateAssetInput = z.infer<
	z.ZodObject<typeof TOOL_INPUT_SCHEMAS.generate_asset>
>;
export type PreviewAssetInput = z.infer<
	z.ZodObject<typeof TOOL_INPUT_SCHEMAS.preview_asset>
>;
export type AnimateAssetInput = z.infer<
	z.ZodObject<typeof TOOL_INPUT_SCHEMAS.animate_asset>
>;
export type ValidatePackAssetInput = z.infer<
	z.ZodObject<typeof TOOL_INPUT_SCHEMAS.validate_pack_asset>
>;

function stripCodePrefix(message: string): string {
	return message.replace(/^\[[A-Z0-9_]+\] /, "");
}

/**
 * MCP has no --force/--mkdir flags, so the CLI hint sentences attached to
 * OUTPUT_EXISTS and FILESYSTEM_ERROR are unactionable here and get dropped.
 * Codes, shapes, and the remaining wording stay identical; the neutral
 * remainder matches the assertOutputDirectory style below.
 */
function toMcpMessage(code: string, message: string): string {
	if (code === "OUTPUT_EXISTS") {
		return message.replace(" Pass --force to overwrite.", "");
	}
	if (code === "FILESYSTEM_ERROR") {
		return message.replace(" Pass --mkdir to create it.", "");
	}
	return message;
}

function errorResult(error: unknown): McpTextResult {
	if (error instanceof McAssetError) {
		const message = toMcpMessage(error.code, stripCodePrefix(error.message));
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						code: error.code,
						message,
						...(error.details === undefined ? {} : { details: error.details }),
					}),
				},
			],
			isError: true,
		};
	}
	const message = error instanceof Error ? error.message : String(error);
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({ code: "INTERNAL_ERROR", message }),
			},
		],
		isError: true,
	};
}

function textResult(value: Record<string, unknown>): McpTextResult {
	return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function pngBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

/**
 * Guarded single-file write: no auto-creation of parents and no
 * overwrite, matching the CLI default without --mkdir/--force.
 */
async function writeMcpArtifact(
	path: string,
	data: Uint8Array | string,
): Promise<void> {
	await atomicWriteFile(path, data, {});
}

async function assertOutputDirectory(outputDir: string): Promise<void> {
	let dirStat: Awaited<ReturnType<typeof stat>> | undefined;
	try {
		dirStat = await stat(outputDir);
	} catch {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Output directory is missing: ${outputDir}.`,
			{ path: outputDir },
		);
	}
	if (!dirStat.isDirectory()) {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Output directory is not a directory: ${outputDir}.`,
			{ path: outputDir },
		);
	}
}

function requireMcpxSource(command: string, sourcePath: string): void {
	if (!sourcePath.toLowerCase().endsWith(".mcpx")) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`${command} reads an editable .mcpx source.`,
			{ input: sourcePath },
		);
	}
}

/** Read-only report over a raster input; never writes. */
export async function handleAnalyzeAsset(
	args: AnalyzeAssetInput,
): Promise<McpTextResult> {
	try {
		const profile = parseProfile(args.profile);
		const target = resolveVersionTarget({
			...(args.minecraftVersion === undefined
				? {}
				: { minecraftVersion: args.minecraftVersion }),
			...(args.resourcePackVersion === undefined
				? {}
				: { resourcePackVersion: args.resourcePackVersion }),
		});
		const loaded = await loadRasterCanvas(args.path);
		const report = analyzeCanvas(loaded.canvas, {
			profile,
			packFormat: target.packFormat,
			sourceWarnings: loaded.warnings,
		});
		return textResult({
			...report,
			version: versionReportShape(target),
			target: formatVersionTarget(target),
		});
	} catch (error) {
		return errorResult(error);
	}
}

/** Deterministic pixelize pipeline; artifacts embed unless paths are explicit. */
export async function handlePixelizeAsset(
	args: PixelizeAssetInput,
): Promise<McpTextResult> {
	try {
		const profile = parseProfile(args.profile);
		if (args.outputPngPath !== undefined) {
			assertMinecraftOutputPath(profile, args.outputPngPath);
		}
		const loaded = await loadRasterCanvas(args.inputPath);
		const warnings: WarningNote[] = [...loaded.warnings];
		const report = runPixelize(loaded.canvas, {
			size: args.size,
			preset: args.preset,
		});
		if (report.nonStandardResolution) {
			warnings.push({
				code: "NON_STANDARD_RESOLUTION",
				message: `non-standard resolution ${report.width}x${report.height}; recommendation only, the texture remains loadable.`,
			});
		}
		assertMcpxPaletteCapacity(collectCanvasColors(report.canvas).length);
		const pngBytes = encodePng(report.canvas);
		const mcpxText = ensureMcpxText(report.canvas, (warning) => {
			warnings.push({ code: warning.code, message: warning.message });
		});
		if (args.outputPngPath !== undefined) {
			await writeMcpArtifact(args.outputPngPath, pngBytes);
		}
		if (args.outputMcpxPath !== undefined) {
			await writeMcpArtifact(args.outputMcpxPath, mcpxText);
		}
		return textResult({
			profile,
			preset: report.preset,
			presetDetail: describePixelizePreset(report.preset),
			width: report.width,
			height: report.height,
			colors: report.colors,
			colorCount: report.colorCount,
			stages: report.stages,
			warnings,
			...(args.outputPngPath !== undefined
				? { output: args.outputPngPath }
				: { pngBase64: pngBase64(pngBytes) }),
			...(args.outputMcpxPath !== undefined
				? { source: args.outputMcpxPath }
				: { mcpxText }),
		});
	} catch (error) {
		return errorResult(error);
	}
}

/** ASCII Grid render with an optional batch applied after parsing. */
export async function handleRenderPixelAsset(
	args: RenderPixelAssetInput,
): Promise<McpTextResult> {
	try {
		const profile = parseProfile(args.profile);
		const hasPath = args.gridPath !== undefined && args.gridPath !== "";
		const hasText = args.gridText !== undefined && args.gridText !== "";
		if (hasPath && hasText) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				"Pass exactly one of gridPath and gridText, not both.",
			);
		}
		if (!hasPath && !hasText) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"One of gridPath and gridText is required.",
			);
		}
		if (args.outputPngPath !== undefined) {
			assertMinecraftOutputPath(profile, args.outputPngPath);
		}
		const gridInput =
			hasPath && args.gridPath !== undefined
				? await readInputText(args.gridPath, "grid file")
				: (args.gridText as string);
		const canvas = parseGridFile(gridInput);
		const warnings: WarningNote[] = [];
		let applied = 0;
		let operations: BatchReport["operations"] = [];
		if (args.operations !== undefined && args.operations !== "") {
			const batch = applyBatchText(
				canvas,
				args.operations,
				defaultLayerFor(canvas),
			);
			applied = batch.applied;
			operations = batch.operations;
		}
		assertMcpxPaletteCapacity(collectCanvasColors(canvas).length);
		const pngBytes = encodePng(canvas);
		const mcpxText = ensureMcpxText(canvas, (warning) => {
			warnings.push({ code: warning.code, message: warning.message });
		});
		if (args.outputPngPath !== undefined) {
			await writeMcpArtifact(args.outputPngPath, pngBytes);
		}
		if (args.outputMcpxPath !== undefined) {
			await writeMcpArtifact(args.outputMcpxPath, mcpxText);
		}
		return textResult({
			profile,
			applied,
			operations,
			warnings,
			width: canvas.width,
			height: canvas.height,
			...(args.outputPngPath !== undefined
				? { output: args.outputPngPath }
				: { pngBase64: pngBase64(pngBytes) }),
			...(args.outputMcpxPath !== undefined
				? { source: args.outputMcpxPath }
				: { mcpxText }),
		});
	} catch (error) {
		return errorResult(error);
	}
}

/**
 * Single-call batch edit over an `.mcpx` source. Atomic by default: the
 * first failure rolls the canvas back and the whole call fails with the
 * original error code plus the batch position in details.
 */
export async function handleApplyAssetOperations(
	args: ApplyAssetOperationsInput,
): Promise<McpTextResult> {
	try {
		requireMcpxSource("apply_asset_operations", args.sourcePath);
		const canvas = parseMcpx(
			await readInputText(args.sourcePath, "mcpx source"),
		);
		const typed = parseOperationsJson(
			JSON.stringify({ operations: args.operations }),
			defaultLayerFor(canvas),
		);
		const report = applyOperations(canvas, typed, {
			atomic: args.atomic ?? true,
		});
		assertMcpxPaletteCapacity(collectCanvasColors(canvas).length);
		const pngBytes = encodePng(canvas);
		const mcpxText = ensureMcpxText(canvas, () => undefined);
		if (args.outputPngPath !== undefined) {
			await writeMcpArtifact(args.outputPngPath, pngBytes);
		}
		if (args.outputMcpxPath !== undefined) {
			await writeMcpArtifact(args.outputMcpxPath, mcpxText);
		}
		return textResult({
			applied: report.applied,
			failed: report.failed,
			operations: report.operations,
			warnings: [],
			...(args.outputPngPath !== undefined
				? { output: args.outputPngPath }
				: { pngBase64: pngBase64(pngBytes) }),
			...(args.outputMcpxPath !== undefined
				? { source: args.outputMcpxPath }
				: { mcpxText }),
		});
	} catch (error) {
		return errorResult(error);
	}
}

/** Material recolor over every layer, optionally limited to one region. */
export async function handleRecolorAsset(
	args: RecolorAssetInput,
): Promise<McpTextResult> {
	try {
		const profile = parseProfile(args.profile);
		if (args.material === undefined || args.material === "") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"recolor needs material with a builtin material id.",
			);
		}
		if (!isBuiltinMaterialId(args.material)) {
			throw new McAssetError("INVALID_ARGUMENT", "Unknown material id.", {
				id: args.material,
			});
		}
		const regionId =
			args.region === undefined || args.region === "" ? undefined : args.region;
		requireMcpxSource("recolor_asset", args.sourcePath);
		if (args.outputPngPath !== undefined) {
			assertMinecraftOutputPath(profile, args.outputPngPath);
		}
		const loaded = await loadEditableCanvas(args.sourcePath);
		const canvas = loaded.canvas;
		const warnings: WarningNote[] = [...loaded.warnings];
		let pixelsChanged = 0;
		for (const layer of canvas.layers) {
			pixelsChanged += recolorLayer(canvas, layer.id, args.material, {
				...(regionId !== undefined ? { regionId } : {}),
			}).pixelsChanged;
		}
		assertMcpxPaletteCapacity(collectCanvasColors(canvas).length);
		const pngBytes = encodePng(canvas);
		const mcpxText = ensureMcpxText(canvas, (warning) => {
			warnings.push({ code: warning.code, message: warning.message });
		});
		if (args.outputPngPath !== undefined) {
			await writeMcpArtifact(args.outputPngPath, pngBytes);
		}
		if (args.outputMcpxPath !== undefined) {
			await writeMcpArtifact(args.outputMcpxPath, mcpxText);
		}
		return textResult({
			profile,
			material: args.material,
			...(regionId !== undefined ? { region: regionId } : {}),
			pixelsChanged,
			warnings,
			...(args.outputPngPath !== undefined
				? { output: args.outputPngPath }
				: { pngBase64: pngBase64(pngBytes) }),
			...(args.outputMcpxPath !== undefined
				? { source: args.outputMcpxPath }
				: { mcpxText }),
		});
	} catch (error) {
		return errorResult(error);
	}
}

/**
 * Variant fan-out: each material starts from the pristine source text, so
 * reruns stay byte-identical. Files land as <stem>_<material>.png plus
 * `.mcpx` under the explicit output directory.
 */
export async function handleCreateVariants(
	args: CreateVariantsInput,
): Promise<McpTextResult> {
	try {
		const profile = parseProfile(args.profile);
		if (args.materials.length === 0) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"create_variants needs at least one builtin material id.",
			);
		}
		const seen = new Set<string>();
		for (const id of args.materials) {
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
		requireMcpxSource("create_variants", args.sourcePath);
		await assertOutputDirectory(args.outputDir);
		const stem = basename(args.sourcePath).replace(/\.mcpx$/i, "");
		if (stem === "") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"create_variants needs a named .mcpx source.",
				{ input: args.sourcePath },
			);
		}
		const sourceText = await readInputText(args.sourcePath, "canvas input");
		const warnings: WarningNote[] = [];
		const files: Array<{
			material: string;
			png: string;
			mcpx: string;
			pixelsChanged: number;
		}> = [];
		for (const material of args.materials) {
			const canvas = parseMcpx(sourceText);
			let pixelsChanged = 0;
			for (const layer of canvas.layers) {
				pixelsChanged += recolorLayer(canvas, layer.id, material).pixelsChanged;
			}
			const pngPath = joinPath(args.outputDir, `${stem}_${material}.png`);
			const mcpxPath = joinPath(args.outputDir, `${stem}_${material}.mcpx`);
			const pngBytes = encodePng(canvas);
			const mcpxText = ensureMcpxText(canvas, (warning) => {
				warnings.push({ code: warning.code, message: warning.message });
			});
			await writeMcpArtifact(pngPath, pngBytes);
			await writeMcpArtifact(mcpxPath, mcpxText);
			files.push({ material, png: pngPath, mcpx: mcpxPath, pixelsChanged });
		}
		return textResult({
			profile,
			materials: [...args.materials],
			outputDir: args.outputDir,
			files,
			warnings,
		});
	} catch (error) {
		return errorResult(error);
	}
}

/**
 * Explicit `--mcmeta`-style wiring for the read-only verdict: the mcmeta
 * path is used verbatim and neither input is written. A `fail` verdict is
 * a normal result carrying findings, never an error.
 */
async function readMcmetaSection(
	mcmetaPath: string,
	report: ValidateReport,
): Promise<{ mcmeta: ValidateMcmetaSection; findings: ValidateFinding[] }> {
	let text: string;
	try {
		text = new TextDecoder("utf-8").decode(await readFile(mcmetaPath));
	} catch {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Cannot read mcmeta: ${mcmetaPath}.`,
			{ path: mcmetaPath },
		);
	}
	const document = parseMcmetaText(text, mcmetaPath);
	const texture = extractTextureSection(document);
	const animation = extractAnimationSection(document);
	const section: ValidateMcmetaSection = {
		path: basename(mcmetaPath),
		texture: {
			present: texture.present,
			...(texture.mipmapStrategy !== undefined
				? { mipmapStrategy: texture.mipmapStrategy }
				: {}),
			...(texture.alphaCutoffBias !== undefined
				? { alphaCutoffBias: texture.alphaCutoffBias }
				: {}),
		},
		animation: { present: animation.present },
		mipmap: {
			predictedClassification: report.alpha.predictedClassification,
			...(texture.mipmapStrategy !== undefined
				? { strategy: texture.mipmapStrategy }
				: {}),
			...(texture.alphaCutoffBias !== undefined
				? { bias: texture.alphaCutoffBias }
				: {}),
		},
	};
	const findings: ValidateFinding[] = [];
	const mipmapWarning = mipmapCutoutMeanWarning(
		report.alpha.predictedClassification,
		texture,
	);
	if (mipmapWarning !== undefined) {
		findings.push({ ...mipmapWarning });
	}
	if (animation.present) {
		const geometry = deriveAnimationGeometry(
			report.dimensions.width,
			report.dimensions.height,
			animation,
		);
		checkAnimationFrameIndices(animation, geometry.frameCount);
		section.animation = {
			present: true,
			...(animation.frametime !== undefined
				? { frametime: animation.frametime }
				: {}),
			...(animation.interpolate !== undefined
				? { interpolate: animation.interpolate }
				: {}),
			...(animation.width !== undefined ? { width: animation.width } : {}),
			...(animation.height !== undefined ? { height: animation.height } : {}),
			frameCount: geometry.frameCount,
			frameWidth: geometry.frameWidth,
			frameHeight: geometry.frameHeight,
			layout: geometry.layout,
			frameIndices: animation.frames.map((frame) => frame.index),
		};
		// Playback-sequence length is independent of the physical frame count:
		// repeated or partial indices are legal; only out-of-range indices
		// fail via checkAnimationFrameIndices above.
	}
	return { mcmeta: section, findings };
}

/** Read-only verdict with findings; never writes. */
export async function handleValidateAsset(
	args: ValidateAssetInput,
): Promise<McpTextResult> {
	try {
		const profile = parseProfile(args.profile);
		const target = resolveVersionTarget({
			...(args.minecraftVersion === undefined
				? {}
				: { minecraftVersion: args.minecraftVersion }),
			...(args.resourcePackVersion === undefined
				? {}
				: { resourcePackVersion: args.resourcePackVersion }),
		});
		let input: Uint8Array;
		try {
			input = new Uint8Array(await readFile(args.path));
		} catch {
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Cannot read input: ${args.path}.`,
			);
		}
		const decoded = decodePng(input);
		const base = validateCanvas(decoded.canvas, {
			profile,
			packFormat: target.packFormat,
			sourceWarnings: decoded.warnings,
			filename: args.path,
		});
		let report: ValidateReport = base;
		let mcmeta: ValidateMcmetaSection | undefined;
		if (args.mcmetaPath !== undefined && args.mcmetaPath !== "") {
			const wired = await readMcmetaSection(args.mcmetaPath, base);
			mcmeta = wired.mcmeta;
			const findings = [...base.findings, ...wired.findings];
			const verdict = findings.some((finding) => finding.level === "error")
				? "fail"
				: base.verdict;
			report = { ...base, findings, verdict };
		}
		return textResult({
			...report,
			version: versionReportShape(target),
			target: formatVersionTarget(target),
			...(mcmeta !== undefined ? { mcmeta } : {}),
		});
	} catch (error) {
		return errorResult(error);
	}
}

/**
 * Raster entry: decode the image, run the optional inline batch, then
 * write or embed the PNG bytes and the `.mcpx` source. Mirrors the
 * cmd-import.ts middle (decode, batch, encode, serialize) without the
 * CLI target/streaming machinery.
 */
export async function handleImportAsset(
	args: ImportAssetInput,
): Promise<McpTextResult> {
	try {
		const profile = parseProfile(args.profile);
		if (args.outputPngPath !== undefined) {
			assertMinecraftOutputPath(profile, args.outputPngPath);
		}
		const loaded = await loadRasterCanvas(args.inputPath);
		const canvas = loaded.canvas;
		const warnings: WarningNote[] = [...loaded.warnings];
		let applied = 0;
		let operations: BatchReport["operations"] = [];
		if (args.operations !== undefined && args.operations !== "") {
			const batch = applyBatchText(
				canvas,
				args.operations,
				defaultLayerFor(canvas),
			);
			applied = batch.applied;
			operations = batch.operations;
		}
		assertMcpxPaletteCapacity(collectCanvasColors(canvas).length);
		const pngBytes = encodePng(canvas);
		const mcpxText = ensureMcpxText(canvas, (warning) => {
			warnings.push({ code: warning.code, message: warning.message });
		});
		if (args.outputPngPath !== undefined) {
			await writeMcpArtifact(args.outputPngPath, pngBytes);
		}
		if (args.outputMcpxPath !== undefined) {
			await writeMcpArtifact(args.outputMcpxPath, mcpxText);
		}
		return textResult({
			profile,
			applied,
			operations,
			warnings,
			...(args.outputPngPath !== undefined
				? { output: args.outputPngPath }
				: { pngBase64: pngBase64(pngBytes) }),
			...(args.outputMcpxPath !== undefined
				? { source: args.outputMcpxPath }
				: { mcpxText }),
		});
	} catch (error) {
		return errorResult(error);
	}
}

/**
 * Editable-source entry: parse the `.mcpx` source, run the optional
 * inline batch, then write or embed the PNG bytes and the re-serialized
 * source. Mirrors the cmd-build.ts middle without stdin/file-flag support.
 */
export async function handleBuildAsset(
	args: BuildAssetInput,
): Promise<McpTextResult> {
	try {
		const profile = parseProfile(args.profile);
		requireMcpxSource("build_asset", args.sourcePath);
		if (args.outputPngPath !== undefined) {
			assertMinecraftOutputPath(profile, args.outputPngPath);
		}
		const loaded = await loadEditableCanvas(args.sourcePath);
		const canvas = loaded.canvas;
		const warnings: WarningNote[] = [...loaded.warnings];
		let applied = 0;
		let operations: BatchReport["operations"] = [];
		if (args.operations !== undefined && args.operations !== "") {
			const batch = applyBatchText(
				canvas,
				args.operations,
				defaultLayerFor(canvas),
			);
			applied = batch.applied;
			operations = batch.operations;
		}
		assertMcpxPaletteCapacity(collectCanvasColors(canvas).length);
		const pngBytes = encodePng(canvas);
		const mcpxText = ensureMcpxText(canvas, (warning) => {
			warnings.push({ code: warning.code, message: warning.message });
		});
		if (args.outputPngPath !== undefined) {
			await writeMcpArtifact(args.outputPngPath, pngBytes);
		}
		if (args.outputMcpxPath !== undefined) {
			await writeMcpArtifact(args.outputMcpxPath, mcpxText);
		}
		return textResult({
			profile,
			applied,
			operations,
			warnings,
			...(args.outputPngPath !== undefined
				? { output: args.outputPngPath }
				: { pngBase64: pngBase64(pngBytes) }),
			...(args.outputMcpxPath !== undefined
				? { source: args.outputMcpxPath }
				: { mcpxText }),
		});
	} catch (error) {
		return errorResult(error);
	}
}

function parseMcpDecimalInteger(text: string, what: string): number {
	if (!/^-?\d+$/.test(text)) {
		throw new McAssetError(
			"INVALID_COORDINATE",
			`${what} must be an integer, without rounding.`,
			{ value: text },
		);
	}
	return Number.parseInt(text, 10);
}

function splitMcpParts(raw: string, count: number, what: string): string[] {
	const parts = raw.split(",");
	if (parts.length !== count) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`${what} needs ${count} comma-separated integers.`,
			{ value: raw },
		);
	}
	return parts;
}

function parseMcpCropRect(raw: string): Rect {
	const parts = splitMcpParts(raw, 4, "crop");
	const rect: Rect = {
		x: parseMcpDecimalInteger(parts[0] as string, "Crop x"),
		y: parseMcpDecimalInteger(parts[1] as string, "Crop y"),
		width: parseMcpDecimalInteger(parts[2] as string, "Crop width"),
		height: parseMcpDecimalInteger(parts[3] as string, "Crop height"),
	};
	if (rect.width < 1 || rect.height < 1) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Crop width and height must be at least 1.",
			{ value: raw },
		);
	}
	return rect;
}

function parseMcpPadAmounts(raw: string): {
	left: number;
	top: number;
	right: number;
	bottom: number;
} {
	const parts = splitMcpParts(raw, 4, "pad");
	return {
		left: parseMcpDecimalInteger(parts[0] as string, "Pad left"),
		top: parseMcpDecimalInteger(parts[1] as string, "Pad top"),
		right: parseMcpDecimalInteger(parts[2] as string, "Pad right"),
		bottom: parseMcpDecimalInteger(parts[3] as string, "Pad bottom"),
	};
}

function parseMcpPadColor(raw: string): RGBA {
	if (raw === "transparent") {
		return { r: 0, g: 0, b: 0, a: 0 };
	}
	const match = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(raw);
	if (match === null || match[1] === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"padColor must be transparent, #RRGGBB, or #RRGGBBAA.",
			{ value: raw },
		);
	}
	const digits = match[1];
	const byte = (index: number): number =>
		Number.parseInt(digits.slice(index, index + 2), 16);
	return {
		r: byte(0),
		g: byte(2),
		b: byte(4),
		a: digits.length === 8 ? byte(6) : 255,
	};
}

function parseMcpResizeSize(raw: string): { width: number; height: number } {
	const match = /^(\d+)x(\d+)$/i.exec(raw.trim());
	if (match === null || match[1] === undefined || match[2] === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"resize must look like WxH with positive integers.",
			{ value: raw },
		);
	}
	return {
		width: Number.parseInt(match[1], 10),
		height: Number.parseInt(match[2], 10),
	};
}

function parseMcpResizeMode(raw: string | undefined): ResizeMode | undefined {
	if (raw === undefined || raw === "") {
		return undefined;
	}
	if (raw !== "nearest" && raw !== "box") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"resizeMode must be nearest or box.",
			{ value: raw },
		);
	}
	return raw;
}

function parseMcpTranslate(raw: string): { dx: number; dy: number } {
	const parts = splitMcpParts(raw, 2, "translate");
	return {
		dx: parseMcpDecimalInteger(parts[0] as string, "Translate dx"),
		dy: parseMcpDecimalInteger(parts[1] as string, "Translate dy"),
	};
}

/**
 * Single-geometry entry over a raster or `.mcpx` input: exactly one of
 * flip/rotate/crop/pad/resize/translate runs per call. Mirrors the
 * cmd-transform.ts validation order (selection conflict, exactly-one
 * count, resizeMode/padColor dependencies) and the same Core calls.
 */
export async function handleTransformAsset(
	args: TransformAssetInput,
): Promise<McpTextResult> {
	try {
		const profile = parseProfile(args.profile);
		if (args.outputPngPath !== undefined) {
			assertMinecraftOutputPath(profile, args.outputPngPath);
		}
		const hasSelection = args.selection !== undefined && args.selection !== "";
		const geometries = [
			args.flip,
			args.rotate,
			args.crop,
			args.pad,
			args.resize,
			args.translate,
		].filter((flag) => flag !== undefined && flag !== "");
		if (hasSelection && geometries.length > 0) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				"selection cannot be combined with geometry operations.",
			);
		}
		if (geometries.length === 0) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"transform_asset needs exactly one geometry field: flip, rotate, crop, pad, resize, or translate.",
			);
		}
		if (geometries.length > 1) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				"transform_asset takes exactly one geometry operation per invocation; run them in separate calls.",
			);
		}
		if (
			args.resizeMode !== undefined &&
			(args.resize === undefined || args.resize === "")
		) {
			throw new McAssetError("INVALID_ARGUMENT", "resizeMode needs resize.");
		}
		if (
			args.padColor !== undefined &&
			args.padColor !== "" &&
			(args.pad === undefined || args.pad === "")
		) {
			throw new McAssetError("INVALID_ARGUMENT", "padColor needs pad.");
		}
		const loaded = await loadEditableCanvas(args.inputPath);
		const canvas = loaded.canvas;
		const warnings: WarningNote[] = [...loaded.warnings];
		resolveCommandSelection(canvas, args.selection, true);
		let detail = "";
		if (args.flip !== undefined) {
			if (args.flip === "h") {
				flipHorizontal(canvas);
			} else {
				flipVertical(canvas);
			}
			detail = `flip:${args.flip}`;
		} else if (args.rotate !== undefined) {
			if (args.rotate === 90) {
				rotate90(canvas);
			} else if (args.rotate === 180) {
				rotate180(canvas);
			} else {
				rotate270(canvas);
			}
			detail = `rotate:${args.rotate}`;
		} else if (args.crop !== undefined && args.crop !== "") {
			crop(canvas, parseMcpCropRect(args.crop));
			detail = `crop:${args.crop}`;
		} else if (args.pad !== undefined && args.pad !== "") {
			const amounts = parseMcpPadAmounts(args.pad);
			if (args.padColor !== undefined && args.padColor !== "") {
				pad(canvas, { ...amounts, color: parseMcpPadColor(args.padColor) });
			} else {
				pad(canvas, amounts);
			}
			detail = `pad:${args.pad}`;
		} else if (args.resize !== undefined && args.resize !== "") {
			const size = parseMcpResizeSize(args.resize);
			resize(
				canvas,
				size.width,
				size.height,
				parseMcpResizeMode(args.resizeMode),
			);
			detail = `resize:${args.resize}`;
		} else {
			const delta = parseMcpTranslate(args.translate as string);
			translate(canvas, delta.dx, delta.dy);
			detail = `translate:${args.translate}`;
		}
		assertMcpxPaletteCapacity(collectCanvasColors(canvas).length);
		const pngBytes = encodePng(canvas);
		const mcpxText = ensureMcpxText(canvas, (warning) => {
			warnings.push({ code: warning.code, message: warning.message });
		});
		if (args.outputPngPath !== undefined) {
			await writeMcpArtifact(args.outputPngPath, pngBytes);
		}
		if (args.outputMcpxPath !== undefined) {
			await writeMcpArtifact(args.outputMcpxPath, mcpxText);
		}
		return textResult({
			profile,
			applied: 0,
			operations: [],
			warnings,
			geometry: detail,
			width: canvas.width,
			height: canvas.height,
			...(args.outputPngPath !== undefined
				? { output: args.outputPngPath }
				: { pngBase64: pngBase64(pngBytes) }),
			...(args.outputMcpxPath !== undefined
				? { source: args.outputMcpxPath }
				: { mcpxText }),
		});
	} catch (error) {
		return errorResult(error);
	}
}

/**
 * Color-budget entry over a raster or `.mcpx` input: each layer is
 * quantized to at most `colors` with the frozen integer median-cut, and
 * the selection restores unselected pixels verbatim. Mirrors the
 * cmd-quantize.ts middle.
 */
export async function handleQuantizeAsset(
	args: QuantizeAssetInput,
): Promise<McpTextResult> {
	try {
		const profile = parseProfile(args.profile);
		if (args.outputPngPath !== undefined) {
			assertMinecraftOutputPath(profile, args.outputPngPath);
		}
		const colors = validateColorsOption(args.colors);
		const loaded = await loadEditableCanvas(args.inputPath);
		const canvas = loaded.canvas;
		const warnings: WarningNote[] = [...loaded.warnings];
		const selection = resolveCommandSelection(canvas, args.selection, false);
		const before = snapshotLayerBytes(canvas);
		let colorCount = 0;
		for (const layer of canvas.layers) {
			const result = quantizePixels(layer.pixels, colors);
			replaceLayerPixels(canvas, layer.id, result.pixels);
			if (result.colorCount > colorCount) {
				colorCount = result.colorCount;
			}
		}
		const modifiedPixels = restoreUnselectedPixels(canvas, before, selection);
		assertMcpxPaletteCapacity(collectCanvasColors(canvas).length);
		const pngBytes = encodePng(canvas);
		const mcpxText = ensureMcpxText(canvas, (warning) => {
			warnings.push({ code: warning.code, message: warning.message });
		});
		if (args.outputPngPath !== undefined) {
			await writeMcpArtifact(args.outputPngPath, pngBytes);
		}
		if (args.outputMcpxPath !== undefined) {
			await writeMcpArtifact(args.outputMcpxPath, mcpxText);
		}
		return textResult({
			profile,
			applied: 0,
			operations: [],
			warnings,
			colors,
			colorCount,
			modifiedPixels,
			...(selection.kind !== "all" ? { selection: args.selection } : {}),
			...(args.outputPngPath !== undefined
				? { output: args.outputPngPath }
				: { pngBase64: pngBase64(pngBytes) }),
			...(args.outputMcpxPath !== undefined
				? { source: args.outputMcpxPath }
				: { mcpxText }),
		});
	} catch (error) {
		return errorResult(error);
	}
}

function parseMcpFixClasses(
	raw: string | undefined,
): CleanupClass[] | undefined {
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
 * Detect-and-optionally-fix entry over a raster or `.mcpx` input.
 * Without `fix` the call still returns the artifacts with pixels
 * unchanged (detect and report only). Alpha-affecting classes need
 * allowRenderPassChange; the engine rejects the whole call otherwise.
 * Mirrors the cmd-cleanup.ts middle.
 */
export async function handleCleanupAsset(
	args: CleanupAssetInput,
): Promise<McpTextResult> {
	try {
		const profile = parseProfile(args.profile);
		if (args.outputPngPath !== undefined) {
			assertMinecraftOutputPath(profile, args.outputPngPath);
		}
		const fix = parseMcpFixClasses(args.fix);
		const loaded = await loadEditableCanvas(args.inputPath);
		const canvas = loaded.canvas;
		const warnings: WarningNote[] = [...loaded.warnings];
		const selection = resolveCommandSelection(canvas, args.selection, false);
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
					...(args.allowRenderPassChange === true
						? { allowRenderPassChange: true as const }
						: {}),
				});
				for (const name of CLEANUP_CLASSES) {
					detected[name] = (detected[name] as number) + result.detected[name];
					fixed[name] = (fixed[name] as number) + result.fixed[name];
				}
			}
		}
		const modifiedPixels = restoreUnselectedPixels(canvas, before, selection);
		assertMcpxPaletteCapacity(collectCanvasColors(canvas).length);
		const pngBytes = encodePng(canvas);
		const mcpxText = ensureMcpxText(canvas, (warning) => {
			warnings.push({ code: warning.code, message: warning.message });
		});
		if (args.outputPngPath !== undefined) {
			await writeMcpArtifact(args.outputPngPath, pngBytes);
		}
		if (args.outputMcpxPath !== undefined) {
			await writeMcpArtifact(args.outputMcpxPath, mcpxText);
		}
		return textResult({
			profile,
			applied: 0,
			operations: [],
			warnings,
			detected,
			fixed,
			modifiedPixels,
			...(fix !== undefined ? { fix: [...fix] } : {}),
			...(selection.kind !== "all" ? { selection: args.selection } : {}),
			...(args.outputPngPath !== undefined
				? { output: args.outputPngPath }
				: { pngBase64: pngBase64(pngBytes) }),
			...(args.outputMcpxPath !== undefined
				? { source: args.outputMcpxPath }
				: { mcpxText }),
		});
	} catch (error) {
		return errorResult(error);
	}
}

/**
 * Read-only palette reports over a raster or `.mcpx` input: extract
 * returns the distinct colors as an authoring palette, inspect returns
 * the frozen characteristic shape. Never writes.
 */
export async function handlePaletteAsset(
	args: PaletteAssetInput,
): Promise<McpTextResult> {
	try {
		if (args.mode !== "extract" && args.mode !== "inspect") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"palette_asset mode must be extract or inspect.",
				{ mode: args.mode },
			);
		}
		const profile = parseProfile(undefined);
		const loaded = await loadEditableCanvas(args.inputPath);
		const pixels = flattenCanvas(loaded.canvas);
		if (args.mode === "extract") {
			const palette = extractPalette(pixels);
			return textResult({
				mode: "extract",
				profile,
				colorCount: palette.entries.length,
				entries: palette.entries.map((entry) => ({
					id: entry.id,
					color: toHex(entry.color),
					...(entry.role !== undefined ? { role: entry.role } : {}),
				})),
			});
		}
		const report = inspectPalette(pixels, loaded.canvas.palette);
		return textResult({ mode: "inspect", profile, ...report });
	} catch (error) {
		return errorResult(error);
	}
}

/**
 * Read-only material queries: list names the frozen builtins in registry
 * order, show prints one definition. Unknown ids are INVALID_ARGUMENT
 * via the material registry. Never writes.
 */
export async function handleMaterialAsset(
	args: MaterialAssetInput,
): Promise<McpTextResult> {
	try {
		const profile = parseProfile(undefined);
		if (args.mode === "list") {
			if (args.name !== undefined && args.name !== "") {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					"material_asset list takes no name.",
					{ name: args.name },
				);
			}
			return textResult({
				mode: "list",
				profile,
				materials: listMaterialIds(),
			});
		}
		if (args.mode === "show") {
			if (args.name === undefined || args.name === "") {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					"material_asset show needs a material name.",
				);
			}
			const definition = getMaterial(args.name);
			return textResult({
				mode: "show",
				profile,
				id: definition.id,
				characteristics: definition.characteristics,
				palette: definition.palette.entries.map((entry) => ({
					id: entry.id,
					color: toHex(entry.color),
					...(entry.role !== undefined ? { role: entry.role } : {}),
				})),
			});
		}
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"material_asset mode must be list or show.",
			{ mode: args.mode },
		);
	} catch (error) {
		return errorResult(error);
	}
}

function tileSeamJson(report: TileSeamReport): Record<string, unknown> {
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

function tileRepeatJson(report: TileRepetitionReport): Record<string, unknown> {
	return {
		score: formatTileScore(report.score),
		periodX: report.periodX,
		periodY: report.periodY,
	};
}

/**
 * Tile report and synthesis over a raster or `.mcpx` input: the seam and
 * repeat sections always describe the loaded input, and a corrected
 * section describes the written pixels when correction flags are given.
 * The PNG artifact (corrected pixels, or the NxN preview grid when
 * preview is set) is written to the explicit path or embedded; unlike
 * the CLI `--preview` flag, a preview without an output path embeds
 * instead of failing with OUTPUT_REQUIRED.
 */
export async function handleTileAsset(
	args: TileAssetInput,
): Promise<McpTextResult> {
	try {
		const profile = parseProfile(args.profile);
		if (args.outputPngPath !== undefined) {
			assertMinecraftOutputPath(profile, args.outputPngPath);
		}
		let previewTimes: 2 | 4 | 8 | undefined;
		if (args.preview !== undefined) {
			previewTimes = parsePreviewSize(args.preview);
		}
		let edge: TileAxis | undefined;
		if (args.edgeMatch !== undefined) {
			edge = parseTileAxis(args.edgeMatch, "--edge-match");
		}
		let brightness: TileAxis | undefined;
		if (args.brightnessMatch !== undefined) {
			brightness = parseTileAxis(args.brightnessMatch, "--brightness-match");
		}
		const loaded = await loadEditableCanvas(args.inputPath);
		const warnings: WarningNote[] = [...loaded.warnings];
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
						seam: tileSeamJson(seamMetrics(correctedPixels, width, height)),
						repeat: tileRepeatJson(
							repetitionScore(correctedPixels, width, height),
						),
					}
				: undefined;
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
		if (args.outputPngPath !== undefined) {
			await writeMcpArtifact(args.outputPngPath, pngBytes);
		}
		return textResult({
			profile,
			width,
			height,
			...(previewTimes !== undefined ? { preview: args.preview } : {}),
			seam: tileSeamJson(seam),
			repeat: tileRepeatJson(repeat),
			corrections,
			...(corrected !== undefined ? { corrected } : {}),
			warnings,
			...(args.outputPngPath !== undefined
				? { output: args.outputPngPath }
				: { pngBase64: pngBase64(pngBytes) }),
		});
	} catch (error) {
		return errorResult(error);
	}
}

async function resolveMcpGeneratePalette(
	raw: string,
): Promise<{ colors: RGBA[]; label: string }> {
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
			`palette must be a builtin material id or an .mcpx path, got "${raw}".`,
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
 * Deterministic pattern synthesis: no input file, pattern/size/palette/
 * seed drive the frozen procedural engine, and the PNG plus `.mcpx`
 * artifacts are written to the explicit paths or embedded. Mirrors the
 * cmd-generate.ts middle; the CLI OUTPUT_REQUIRED gate becomes
 * write-or-embed here.
 */
export async function handleGenerateAsset(
	args: GenerateAssetInput,
): Promise<McpTextResult> {
	try {
		const profile = parseProfile(args.profile);
		const pattern = parseGeneratePattern(args.pattern);
		const { width, height } = parsePixelizeSize(args.size);
		const seed = parseGenerateSeed(String(args.seed));
		if (args.outputPngPath !== undefined) {
			assertMinecraftOutputPath(profile, args.outputPngPath);
		}
		const resolved = await resolveMcpGeneratePalette(args.palette);
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
		assertMcpxPaletteCapacity(collectCanvasColors(canvas).length);
		const pngBytes = encodePng(canvas);
		const mcpxText = ensureMcpxText(canvas, (warning) => {
			warnings.push({ code: warning.code, message: warning.message });
		});
		if (args.outputPngPath !== undefined) {
			await writeMcpArtifact(args.outputPngPath, pngBytes);
		}
		if (args.outputMcpxPath !== undefined) {
			await writeMcpArtifact(args.outputMcpxPath, mcpxText);
		}
		return textResult({
			profile,
			applied: 0,
			operations: [],
			warnings,
			pattern,
			seed,
			width: generated.width,
			height: generated.height,
			palette: resolved.label,
			...(args.outputPngPath !== undefined
				? { output: args.outputPngPath }
				: { pngBase64: pngBase64(pngBytes) }),
			...(args.outputMcpxPath !== undefined
				? { source: args.outputMcpxPath }
				: { mcpxText }),
		});
	} catch (error) {
		return errorResult(error);
	}
}

/**
 * Image previews over a raster or `.mcpx` input: ascii and palette-map
 * are read-only reports, scale and nine-slice produce PNGs that are
 * written to the explicit path or embedded (the CLI OUTPUT_REQUIRED
 * gate becomes write-or-embed here). Nine-slice needs the explicit
 * mcmeta path; sibling files are never derived.
 */
export async function handlePreviewAsset(
	args: PreviewAssetInput,
): Promise<McpTextResult> {
	try {
		const profile = parseProfile(args.profile);
		if (args.mode === "ascii" || args.mode === "palette-map") {
			const loaded = await loadEditableCanvas(args.inputPath);
			const warnings: WarningNote[] = [...loaded.warnings];
			const canvas = loaded.canvas;
			const pixels = flattenCanvas(canvas);
			if (args.mode === "ascii") {
				const existing = (canvas.palette?.entries ?? []).map((entry) => ({
					id: entry.id,
					color: { ...entry.color },
				}));
				const doc = buildAsciiDoc(
					existing,
					pixels,
					canvas.width,
					canvas.height,
				);
				return textResult({
					mode: "ascii",
					profile,
					width: canvas.width,
					height: canvas.height,
					ascii: doc.lines,
					palette: doc.palette,
					warnings,
				});
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
			return textResult({
				mode: "palette-map",
				profile,
				width: canvas.width,
				height: canvas.height,
				colors,
				rows,
				warnings,
			});
		}
		if (args.mode === "scale") {
			if (args.scale === undefined) {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					"preview_asset scale mode needs scale.",
				);
			}
			if (!Number.isInteger(args.scale) || args.scale < 1) {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					`scale must be a positive integer, got "${args.scale}".`,
					{ scale: args.scale },
				);
			}
			if (args.outputPngPath !== undefined) {
				assertMinecraftOutputPath(profile, args.outputPngPath);
			}
			const loaded = await loadEditableCanvas(args.inputPath);
			const warnings: WarningNote[] = [...loaded.warnings];
			const canvas = loaded.canvas;
			const outWidth = canvas.width * args.scale;
			const outHeight = canvas.height * args.scale;
			validateDimension(outWidth);
			validateDimension(outHeight);
			resize(canvas, outWidth, outHeight, "nearest");
			const pngBytes = encodePng(canvas);
			if (args.outputPngPath !== undefined) {
				await writeMcpArtifact(args.outputPngPath, pngBytes);
			}
			return textResult({
				mode: "scale",
				profile,
				width: outWidth,
				height: outHeight,
				scale: args.scale,
				warnings,
				...(args.outputPngPath !== undefined
					? { output: args.outputPngPath }
					: { pngBase64: pngBase64(pngBytes) }),
			});
		}
		if (args.mode === "nine-slice") {
			const mcmetaPath = args.mcmetaPath;
			if (mcmetaPath === undefined || mcmetaPath === "") {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					"preview_asset nine-slice mode needs mcmetaPath; sibling files are never derived.",
				);
			}
			if (args.outputPngPath !== undefined) {
				assertMinecraftOutputPath(profile, args.outputPngPath);
			}
			const loaded = await loadEditableCanvas(args.inputPath);
			const warnings: WarningNote[] = [...loaded.warnings];
			const canvas = loaded.canvas;
			const pixels = flattenCanvas(canvas);
			const scaling = extractGuiScaling(
				parseMcmetaText(await readInputText(mcmetaPath, "mcmeta"), mcmetaPath),
			);
			const findings: NineSliceFinding[] = [];
			const result: Record<string, unknown> = {
				mode: "nine-slice",
				profile,
				width: canvas.width,
				height: canvas.height,
				mcmeta: basename(mcmetaPath),
				scaling: { type: scaling.kind },
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
			const outPixels = pixels.slice();
			if (guides && scaling.kind === "nine_slice") {
				paintNineSliceGuides(outPixels, canvas.width, canvas.height, {
					...scaling.border,
				});
			}
			const outCanvas = createCanvas(canvas.width, canvas.height);
			const outLayer = addLayer(outCanvas, { id: "base" });
			replaceLayerPixels(outCanvas, outLayer.id, outPixels);
			const pngBytes = encodePng(outCanvas);
			if (args.outputPngPath !== undefined) {
				await writeMcpArtifact(args.outputPngPath, pngBytes);
			}
			return textResult({
				...result,
				warnings,
				...(args.outputPngPath !== undefined
					? { output: args.outputPngPath }
					: { pngBase64: pngBase64(pngBytes) }),
			});
		}
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"preview_asset mode must be ascii, palette-map, scale, or nine-slice.",
			{ mode: args.mode },
		);
	} catch (error) {
		return errorResult(error);
	}
}

function compareMcpFrameBytes(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
}

async function loadMcpFramesDir(framesDir: string): Promise<{
	frames: PixelCanvas[];
	texts: string[];
	names: string[];
	warnings: WarningNote[];
}> {
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
		.sort(compareMcpFrameBytes);
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
	createFrameSet(frames);
	return { frames, texts, names, warnings };
}

/**
 * Frame-set family over frames directories and sprite sheets, mirroring
 * the cmd-animate.ts middles: pack writes a sheet PNG (write or embed),
 * unpack/reorder/resize write frames under the explicit output
 * directory, validate and preview return read-only reports. The CLI
 * OUTPUT_REQUIRED gates become write-or-embed (pack) or
 * INVALID_ARGUMENT for a missing outputDir (unpack/reorder/resize).
 */
export async function handleAnimateAsset(
	args: AnimateAssetInput,
): Promise<McpTextResult> {
	try {
		const profile = parseProfile(args.profile);
		if (args.mode === "pack") {
			const layout = parseAnimationLayout(args.layout);
			const columns = parseGridColumns(
				layout,
				args.columns === undefined ? undefined : String(args.columns),
			);
			if (args.framesDir === undefined || args.framesDir === "") {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					"animate_asset pack needs framesDir with an explicit directory.",
				);
			}
			if (args.outputPngPath !== undefined) {
				assertMinecraftOutputPath(profile, args.outputPngPath);
			}
			const loaded = await loadMcpFramesDir(args.framesDir);
			const frameSet = createFrameSet(loaded.frames);
			const sheet = packFrameSet(frameSet, layout, columns);
			const canvas = createCanvas(sheet.width, sheet.height);
			const layer = addLayer(canvas, { id: "base" });
			replaceLayerPixels(canvas, layer.id, sheet.pixels);
			const pngBytes = encodePng(canvas);
			if (args.outputPngPath !== undefined) {
				await writeMcpArtifact(args.outputPngPath, pngBytes);
			}
			return textResult({
				mode: "pack",
				profile,
				frameCount: frameSet.frames.length,
				frameWidth: frameSet.frameWidth,
				frameHeight: frameSet.frameHeight,
				layout,
				...(columns !== undefined ? { columns } : {}),
				width: sheet.width,
				height: sheet.height,
				warnings: loaded.warnings,
				...(args.outputPngPath !== undefined
					? { output: args.outputPngPath }
					: { pngBase64: pngBase64(pngBytes) }),
			});
		}
		if (args.mode === "unpack") {
			const layout = parseAnimationLayout(args.layout);
			const columns = parseGridColumns(
				layout,
				args.columns === undefined ? undefined : String(args.columns),
			);
			const size = parseFrameSize(args.frameSize);
			if (args.sheetPath === undefined || args.sheetPath === "") {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					"animate_asset unpack needs sheetPath with a sprite sheet.",
				);
			}
			if (args.outputDir === undefined || args.outputDir === "") {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					"animate_asset unpack needs outputDir with an explicit directory.",
				);
			}
			await assertOutputDirectory(args.outputDir);
			const bytes = await readInputFile(args.sheetPath, "sheet input");
			const decoded = decodePng(bytes);
			const sheetLayer = decoded.canvas.layers[0];
			if (sheetLayer === undefined) {
				throw new McAssetError("INTERNAL_ERROR", "Decoded sheet has no layer.");
			}
			if (args.mcmetaPath !== undefined && args.mcmetaPath !== "") {
				const animation = extractAnimationSection(
					parseMcmetaText(
						await readInputText(args.mcmetaPath, "mcmeta"),
						args.mcmetaPath,
					),
				);
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
							`mcmeta frame size ${geometry.frameWidth}x${geometry.frameHeight} does not match frameSize ${size.width}x${size.height}.`,
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
			const files: string[] = [];
			for (let index = 0; index < frameSet.frames.length; index += 1) {
				const frame = frameSet.frames[index] as PixelCanvas;
				const name = frameFileName(index, frameSet.frames.length);
				const text = ensureMcpxText(frame, () => {});
				await writeMcpArtifact(joinPath(args.outputDir, name), text);
				files.push(name);
			}
			return textResult({
				mode: "unpack",
				profile,
				frameCount: frameSet.frames.length,
				frameWidth: frameSet.frameWidth,
				frameHeight: frameSet.frameHeight,
				layout,
				...(columns !== undefined ? { columns } : {}),
				outputDir: args.outputDir,
				files,
				warnings: [],
			});
		}
		if (args.mode === "reorder") {
			if (args.framesDir === undefined || args.framesDir === "") {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					"animate_asset reorder needs framesDir with an explicit directory.",
				);
			}
			if (args.outputDir === undefined || args.outputDir === "") {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					"animate_asset reorder needs outputDir with an explicit directory.",
				);
			}
			await assertOutputDirectory(args.outputDir);
			const loaded = await loadMcpFramesDir(args.framesDir);
			const order = parseFrameOrder(args.order, loaded.frames.length);
			const reordered = reorderFrames(loaded.texts, order);
			const files: string[] = [];
			for (let index = 0; index < reordered.length; index += 1) {
				const name = frameFileName(index, reordered.length);
				await writeMcpArtifact(
					joinPath(args.outputDir, name),
					reordered[index] as string,
				);
				files.push(name);
			}
			return textResult({
				mode: "reorder",
				profile,
				frameCount: reordered.length,
				order,
				outputDir: args.outputDir,
				files,
				warnings: loaded.warnings,
			});
		}
		if (args.mode === "resize") {
			const size = parseFrameSize(args.frameSize);
			const resizeMode = args.resizeMode ?? "nearest";
			if (args.framesDir === undefined || args.framesDir === "") {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					"animate_asset resize needs framesDir with an explicit directory.",
				);
			}
			if (args.outputDir === undefined || args.outputDir === "") {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					"animate_asset resize needs outputDir with an explicit directory.",
				);
			}
			await assertOutputDirectory(args.outputDir);
			const loaded = await loadMcpFramesDir(args.framesDir);
			const frameSet = createFrameSet(loaded.frames);
			resizeFrameSet(frameSet, size.width, size.height, resizeMode);
			const files: string[] = [];
			for (let index = 0; index < frameSet.frames.length; index += 1) {
				const frame = frameSet.frames[index] as PixelCanvas;
				const name = frameFileName(index, frameSet.frames.length);
				const text = ensureMcpxText(frame, () => {});
				await writeMcpArtifact(joinPath(args.outputDir, name), text);
				files.push(name);
			}
			return textResult({
				mode: "resize",
				profile,
				frameCount: frameSet.frames.length,
				frameWidth: size.width,
				frameHeight: size.height,
				resizeMode,
				outputDir: args.outputDir,
				files,
				warnings: loaded.warnings,
			});
		}
		if (args.mode === "validate") {
			if (args.framesDir === undefined || args.framesDir === "") {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					"animate_asset validate needs framesDir with an explicit directory.",
				);
			}
			const loaded = await loadMcpFramesDir(args.framesDir);
			const frameSet = createFrameSet(loaded.frames);
			const report = describeFrameSet(frameSet);
			if (args.mcmetaPath !== undefined && args.mcmetaPath !== "") {
				const animation = extractAnimationSection(
					parseMcmetaText(
						await readInputText(args.mcmetaPath, "mcmeta"),
						args.mcmetaPath,
					),
				);
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
			return textResult({ ...report, profile, warnings: loaded.warnings });
		}
		if (args.mode === "preview") {
			const layout = parseAnimationLayout(args.layout);
			const columns = parseGridColumns(
				layout,
				args.columns === undefined ? undefined : String(args.columns),
			);
			if (args.framesDir === undefined || args.framesDir === "") {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					"animate_asset preview needs framesDir with an explicit directory.",
				);
			}
			const loaded = await loadMcpFramesDir(args.framesDir);
			const frameSet = createFrameSet(loaded.frames);
			const sheet = packFrameSet(frameSet, layout, columns);
			return textResult({
				mode: "preview",
				profile,
				layout,
				...(columns !== undefined ? { columns } : {}),
				frameCount: frameSet.frames.length,
				frameWidth: frameSet.frameWidth,
				frameHeight: frameSet.frameHeight,
				sheetWidth: sheet.width,
				sheetHeight: sheet.height,
				frames: frameSet.frames.map((_, index) => ({ index })),
				warnings: loaded.warnings,
			});
		}
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"animate_asset mode must be pack, unpack, reorder, resize, validate, or preview.",
			{ mode: args.mode },
		);
	} catch (error) {
		return errorResult(error);
	}
}

/**
 * Read-only pack verdict: scans the pack root with the pure engine and
 * returns the report plus the version echo. A `fail` verdict is a normal
 * result carrying findings (like validate_asset), never an error; the
 * CLI exit-3 mapping stays on the CLI side. Never writes.
 */
export async function handleValidatePackAsset(
	args: ValidatePackAssetInput,
): Promise<McpTextResult> {
	try {
		const target = resolveVersionTarget({
			...(args.minecraftVersion === undefined
				? {}
				: { minecraftVersion: args.minecraftVersion }),
			...(args.resourcePackVersion === undefined
				? {}
				: { resourcePackVersion: args.resourcePackVersion }),
		});
		try {
			const root = await stat(args.packPath);
			if (!root.isDirectory()) {
				throw new McAssetError(
					"FILESYSTEM_ERROR",
					`Pack root is not a directory: ${args.packPath}.`,
				);
			}
			await readdir(args.packPath);
		} catch (error) {
			if (error instanceof McAssetError) {
				throw error;
			}
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Cannot read pack root: ${args.packPath}.`,
			);
		}
		const targetSummary = formatVersionTarget(target);
		const report = await scanPack(args.packPath, {
			packFormat: target.packFormat,
			target: targetSummary,
		});
		return textResult({ ...report, version: versionReportShape(target) });
	} catch (error) {
		return errorResult(error);
	}
}
