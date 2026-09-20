import { Buffer } from "node:buffer";
import { readFile, stat } from "node:fs/promises";
import { basename, join as joinPath } from "node:path";
import type { z } from "zod";
import { analyzeCanvas } from "../analyze/metrics.ts";
import {
	applyBatchText,
	assertMinecraftOutputPath,
	defaultLayerFor,
	ensureMcpxText,
	readInputText,
	type WarningNote,
} from "../cli/artifacts.ts";
import { loadEditableCanvas, loadRasterCanvas } from "../cli/canvas-input.ts";
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
import { McAssetError } from "../core/errors.ts";
import { isBuiltinMaterialId } from "../core/material.ts";
import {
	checkAnimationFrameIndices,
	deriveAnimationGeometry,
	extractAnimationSection,
	extractTextureSection,
	mipmapCutoutMeanWarning,
	parseMcmetaText,
} from "../core/mcmeta.ts";
import { describePixelizePreset, runPixelize } from "../core/pixelize.ts";
import { assertMcpxPaletteCapacity } from "../core/quantizer.ts";
import { recolorLayer } from "../core/recolor.ts";
import { decodePng, encodePng } from "../io/png.ts";
import { collectCanvasColors, parseMcpx } from "../mcpx/index.ts";
import type { ValidateFinding, ValidateReport } from "../validate/checks.ts";
import { validateCanvas } from "../validate/checks.ts";
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

function stripCodePrefix(message: string): string {
	return message.replace(/^\[[A-Z0-9_]+\] /, "");
}

function errorResult(error: unknown): McpTextResult {
	if (error instanceof McAssetError) {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						code: error.code,
						message: stripCodePrefix(error.message),
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
		if (
			animation.hasExplicitFrames &&
			animation.frames.length !== geometry.frameCount
		) {
			findings.push({
				code: "ANIMATION_FRAME_COUNT_MISMATCH",
				level: "error",
				message: `mcmeta declares ${animation.frames.length} frame(s) but the sheet holds ${geometry.frameCount}.`,
			});
		}
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
