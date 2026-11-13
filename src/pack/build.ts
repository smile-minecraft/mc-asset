/**
 * Resource-pack build planning and execution.
 *
 * Implements the three-stage build pipeline:
 * Stage 1: Parse and plan in memory.
 * Stage 2: Classify planned outputs against lockfile and disk state into four judgements.
 * Stage 3: Safe-output preflight, atomic file writes, and atomic lockfile update.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { atomicWriteFile } from "../cli/filesystem.ts";
import { parseGridFile } from "../cli/grid.ts";
import { parseOperationsJson } from "../cli/operations-json.ts";
import {
	type OutputTarget,
	planOutputTargets,
	writePlannedTargets,
} from "../cli/safe-output.ts";
import { applyOperations } from "../core/batch.ts";
import { addLayer, createCanvas, replaceLayerPixels } from "../core/canvas.ts";
import { McAssetError } from "../core/errors.ts";
import { packFrameSet } from "../core/frameset.ts";
import { getMaterialPalette, isBuiltinMaterialId } from "../core/material.ts";
import {
	generateAnimationMcmeta,
	type TimelinePreset,
} from "../core/mcmeta-generate.ts";
import {
	applyOutline,
	type OutlineMode,
	type OutlineOptions,
	type OutlinePosition,
} from "../core/outline.ts";
import {
	type GeneratePatternName,
	generateProcedural,
} from "../core/procedural.ts";
import {
	type FamilyRecolorOptions,
	recolorCanvasByFamily,
} from "../core/recolor.ts";
import type { SelectionExpr } from "../core/selection.ts";
import {
	generateSweepFrames,
	parseSweepColor,
	type SweepAngleDegrees,
} from "../core/sweep.ts";
import type { PaletteRole, PixelCanvas, RGBA } from "../core/types.ts";
import { decodePng, encodePng } from "../io/png.ts";
import { parseMcpx } from "../mcpx/index.ts";
import type { ModelRules } from "../model/versions.ts";
import { resolveModelRules } from "../model/versions.ts";
import {
	comparePackFormats,
	normalizePackFormat,
} from "../profiles/versions.ts";
import { resolveStyle } from "../style/load.ts";
import type { ResolvedStyle } from "../style/types.ts";
import { parseResourceLocation } from "../validate/resource-location.ts";
import {
	buildBlockItemDefinitionText,
	buildBlockItemModelText,
	buildBlockModelText,
	buildBlockstateText,
	parseBlockModelStep,
	parseBlockstateStep,
} from "./block.ts";
import {
	canonicalDocumentText,
	isJsonObject,
	isPathInsideDirectory,
	isRelativeProjectPath,
} from "./document.ts";
import {
	collectJsonOutputsForStep,
	isJsonOnlyTarget,
	type JsonOutputKind,
	resolveStepItemName,
} from "./item-plan.ts";
import {
	buildItemDefinitionDocument,
	buildItemDefinitionDocumentV2,
	buildParentModel,
	collectItemDefinitionModelRefs,
} from "./item-templates.ts";
import { parsePackProjectText } from "./load.ts";
import {
	getToolVersion,
	type LockDocument,
	type LockEntry,
	parseLockText,
	serializeLockText,
} from "./lock.ts";
import {
	expandRecipeTargets,
	parseRecipeText,
	type RecipeDocument,
	type RecipeSource,
	type RecipeStep,
	type RecipeTarget,
} from "./recipe.ts";
import { compareCodeUnits } from "./skeleton.ts";
import type { PackProjectDocument } from "./types.ts";

export type BuildOutputJudgement =
	| "new"
	| "own-clean"
	| "own-modified"
	| "foreign";

export interface BuildOutputPlan {
	readonly path: string;
	readonly judgement: BuildOutputJudgement;
	readonly targetId: string;
	readonly recipeId: string;
}

export interface McmetaPlanInternal {
	readonly path: string;
	readonly judgement: BuildOutputJudgement;
	readonly needsRewrite: boolean;
	computedOutputHash?: string | undefined;
}

export interface TextureOutputPlanInternal {
	readonly path: string;
	readonly judgement: BuildOutputJudgement;
	readonly needsRewrite: boolean;
	computedOutputHash?: string | undefined;
}

export interface ModelOutputPlan {
	readonly path: string;
	readonly judgement: BuildOutputJudgement;
	readonly kind: JsonOutputKind;
	readonly stepIndex: number;
	readonly needsRewrite: boolean;
	computedOutputHash?: string | undefined;
	computedText?: string | undefined;
}

export interface TargetPlanInternal {
	readonly targetId: string;
	readonly recipeId: string;
	readonly recipeFormatVersion: number;
	readonly target: RecipeTarget;
	readonly sourceDecl?: RecipeSource | undefined;
	readonly sourceFilePath?: string | undefined;
	readonly sourceBytes?: Uint8Array | undefined;
	readonly sourceText?: string | undefined;
	readonly recipeFilePath: string;
	readonly styleName: string;
	readonly resolvedStyle: ResolvedStyle;
	readonly category?: string | undefined;
	readonly inputHash: string;
	/** The texture half of the product line; absent for a JSON-only target. */
	readonly texturePlan?: TextureOutputPlanInternal | undefined;
	readonly mcmetaPlan?: McmetaPlanInternal | undefined;
	readonly modelPlans?: readonly ModelOutputPlan[] | undefined;
}

export interface PackBuildPlan {
	readonly recipeId: string;
	readonly outputs: readonly BuildOutputPlan[];
	readonly dryRun: boolean;
	readonly projectDir?: string;
	readonly project?: PackProjectDocument;
	readonly targetPlans?: readonly TargetPlanInternal[];
	readonly lock?: LockDocument | undefined;
}

function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

interface OutputJudgement {
	readonly judgement: BuildOutputJudgement;
	readonly needsRewrite: boolean;
}

/**
 * The four-way judgement every output family shares: a lock entry plus the
 * same bytes on disk is own-clean (rewrite only when the target input hash
 * changed), a hand-edited file is own-modified, a file nobody planned is
 * foreign, and a missing file is new.
 */
function classifyOutput(
	fullPath: string,
	lockEntry: LockEntry | undefined,
	inputHash: string,
): OutputJudgement {
	const existsOnDisk = existsSync(fullPath);
	if (lockEntry !== undefined) {
		if (!existsOnDisk) {
			return { judgement: "new", needsRewrite: true };
		}
		const diskHash = sha256Hex(readFileSync(fullPath));
		if (diskHash !== lockEntry.outputHash) {
			return { judgement: "own-modified", needsRewrite: false };
		}
		return {
			judgement: "own-clean",
			needsRewrite: inputHash !== lockEntry.inputHash,
		};
	}
	if (existsOnDisk) {
		return { judgement: "foreign", needsRewrite: false };
	}
	return { judgement: "new", needsRewrite: true };
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => sortKeys(entry));
	}
	if (isJsonObject(value)) {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort(compareCodeUnits)) {
			sorted[key] = sortKeys(value[key]);
		}
		return sorted;
	}
	return value;
}

function canonicalCompactJson(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function parseSize(raw: string): { width: number; height: number } {
	const parts = raw.split("x");
	if (parts.length === 1) {
		const n = parseInt(parts[0], 10);
		return { width: n, height: n };
	}
	return {
		width: parseInt(parts[0], 10),
		height: parseInt(parts[1], 10),
	};
}

function resolveGeneratePalette(paletteRef: string, recipeDir: string): RGBA[] {
	if (isBuiltinMaterialId(paletteRef)) {
		const entries = getMaterialPalette(paletteRef).entries;
		return entries.map((entry) => ({ ...entry.color }));
	}
	if (paletteRef.toLowerCase().endsWith(".mcpx")) {
		const mcpxPath = resolve(recipeDir, paletteRef);
		const text = readFileSync(mcpxPath, "utf8");
		const canvas = parseMcpx(text);
		const colors = (canvas.palette?.entries ?? []).map((entry) => ({
			...entry.color,
		}));
		if (colors.length === 0) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				`Palette file has no [palette] colors: ${paletteRef}`,
				{ palette: paletteRef },
			);
		}
		return colors;
	}
	throw new McAssetError(
		"INVALID_ARGUMENT",
		`palette must be a builtin material id or an .mcpx path, got "${paletteRef}".`,
		{ palette: paletteRef },
	);
}

/**
 * Normalize a resolved style for styleHash: only properties that determine
 * pixels survive. The extends chain carries absolute caller paths, which must
 * not enter the hash: moving a project must not force a full rewrite. This is
 * the only place the chain is redacted; diagnostics elsewhere keep it intact.
 */
function normalizedStyleForHash(style: ResolvedStyle): unknown {
	return {
		palettes: style.palettes,
		outline: style.outline,
		animation: style.animation,
		limits: style.limits,
		highlight: style.highlight,
		dither: style.dither,
		light: style.light,
		formatVersion: style.formatVersion,
	};
}

function validateJsonNamespaceOverride(
	item: string,
	projectNamespace: string,
	step: RecipeStep,
	targetId: string,
	kind: string,
): void {
	if (projectNamespace === "minecraft" && step.override !== true) {
		throw new McAssetError(
			"RECIPE_INVALID",
			`${kind} in the minecraft namespace requires override: true for item '${item}'.`,
			{ targetId, item },
		);
	}
}

/**
 * Every model a built item definition points at must resolve inside the same
 * recipe run: either a model this plan writes, a model file already on disk
 * under the pack output, or the vanilla minecraft tree. A dangling pointer
 * fails here with PACK_BROKEN_REFERENCE before any byte is written, so the
 * plan never stages a definition its own pack cannot satisfy.
 */
function assertItemModelRefsResolvable(
	refs: readonly string[],
	plannedModelPaths: ReadonlySet<string>,
	projectDir: string,
	project: PackProjectDocument,
	targetId: string,
): void {
	for (const ref of refs) {
		const parsed = parseResourceLocation(ref);
		const leaf = parsed.path.endsWith(".json")
			? parsed.path
			: `${parsed.path}.json`;
		const relPath = `${project.outputDir}/assets/${parsed.namespace}/models/${leaf}`;
		if (plannedModelPaths.has(relPath)) {
			continue;
		}
		if (existsSync(join(projectDir, relPath))) {
			continue;
		}
		if (parsed.namespace === "minecraft") {
			continue;
		}
		throw new McAssetError(
			"PACK_BROKEN_REFERENCE",
			`Item definition for target '${targetId}' references unknown model '${ref}'.`,
			{ targetId, model: ref },
		);
	}
}

/**
 * A planned texture output is written as `join(projectDir, outputRelPath)`, so
 * the final path must stay below the project's output directory. The declared
 * fragment is already checked when the recipe expands; this check also covers
 * the default path computed from the target id, which never passes through
 * that expansion rule.
 */
function assertOutputInsideOutputDir(
	outputRelPath: string,
	target: RecipeTarget,
	outputDir: string,
): void {
	if (isPathInsideDirectory(outputRelPath, outputDir)) {
		return;
	}
	if (target.output !== undefined) {
		throw new McAssetError(
			"RECIPE_INVALID",
			`Output path escapes output directory: ${target.output}`,
			{ output: target.output },
		);
	}
	throw new McAssetError(
		"RECIPE_INVALID",
		`Default output path escapes output directory for target '${target.id}'.`,
		{ targetId: target.id },
	);
}

/**
 * Plan a resource pack build without writing any files.
 *
 * Reads project document, recipe(s), sources, and lockfile; expands targets;
 * classifies planned outputs into four judgements; and checks resource limits.
 */
export async function planPackBuild(
	projectPath: string,
	options: { recipe?: string | undefined; dryRun?: boolean | undefined } = {},
): Promise<PackBuildPlan> {
	let resolvedDocPath = resolve(projectPath);
	if (existsSync(resolvedDocPath) && statSync(resolvedDocPath).isDirectory()) {
		resolvedDocPath = join(resolvedDocPath, "mc-asset.pack.json");
	}

	let projectText: string;
	try {
		projectText = readFileSync(resolvedDocPath, "utf8");
	} catch {
		throw new McAssetError(
			"PACK_PROJECT_NOT_FOUND",
			`Cannot read the project document: ${resolvedDocPath}`,
			{ path: resolvedDocPath },
		);
	}

	const project = parsePackProjectText(projectText, resolvedDocPath);
	const projectDir = dirname(resolvedDocPath);
	const format = normalizePackFormat(project.resourcePackVersion);
	const modelRules = resolveModelRules(format);

	let recipeFiles: string[] = [];
	if (options.recipe !== undefined && options.recipe !== "") {
		const resolvedRecipe = isAbsolute(options.recipe)
			? options.recipe
			: resolve(projectDir, options.recipe);
		if (!existsSync(resolvedRecipe)) {
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Recipe file not found: ${options.recipe}`,
				{ path: options.recipe },
			);
		}
		recipeFiles = [resolvedRecipe];
	} else {
		const recipeDir = join(projectDir, project.recipeDir);
		if (existsSync(recipeDir)) {
			const entries = readdirSync(recipeDir)
				.filter((f) => f.endsWith(".recipe.json"))
				.sort(compareCodeUnits);
			recipeFiles = entries.map((f) => join(recipeDir, f));
		}
	}

	const recipes: Array<{
		file: string;
		recipe: RecipeDocument;
		expanded: readonly RecipeTarget[];
	}> = [];

	const seenOutputsAcrossRecipes = new Set<string>();
	const registerOutput = (relPath: string): void => {
		if (seenOutputsAcrossRecipes.has(relPath)) {
			throw new McAssetError(
				"RECIPE_OUTPUT_CONFLICT",
				`Duplicate output path across recipes: ${relPath}`,
				{ conflicts: [relPath] },
			);
		}
		seenOutputsAcrossRecipes.add(relPath);
	};

	let totalOutputCount = 0;
	for (const file of recipeFiles) {
		const text = readFileSync(file, "utf8");
		const recipe = parseRecipeText(text);
		const expanded = expandRecipeTargets(
			recipe,
			project.namespace,
			project.outputDir,
		);
		for (const target of expanded) {
			if (!isJsonOnlyTarget(target)) {
				const texturePath = target.output
					? `${project.outputDir}/${target.output}`
					: `${project.outputDir}/assets/${project.namespace}/textures/item/${target.id}.png`;
				totalOutputCount += 1;
				registerOutput(texturePath);
			}
			for (const [stepIndex, step] of target.steps.entries()) {
				if (step.type === "sweep" && typeof step.mcmetaOutput === "string") {
					totalOutputCount += 1;
					registerOutput(`${project.outputDir}/${step.mcmetaOutput}`);
				}
				for (const output of collectJsonOutputsForStep(
					step,
					target.id,
					project.namespace,
					stepIndex,
				)) {
					totalOutputCount += 1;
					registerOutput(`${project.outputDir}/${output.path}`);
				}
			}
		}
		recipes.push({ file, recipe, expanded });
	}

	if (totalOutputCount > 4096) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			`Planned outputs (${totalOutputCount}) exceed budget of 4096.`,
			{ count: totalOutputCount, limit: 4096 },
		);
	}

	const lockPath = join(projectDir, "mc-asset.lock.json");
	let lock: LockDocument | undefined;
	if (existsSync(lockPath)) {
		const lockText = readFileSync(lockPath, "utf8");
		lock = parseLockText(lockText);
	}

	function checkSourceFileBudget(filePath: string): void {
		let size: number;
		try {
			size = statSync(filePath).size;
		} catch {
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Cannot stat source file: ${filePath}`,
				{ path: filePath },
			);
		}
		if (size > 268435456) {
			throw new McAssetError(
				"RESOURCE_LIMIT_EXCEEDED",
				`Total source file bytes exceed 256 MiB limit: ${size}.`,
				{ limit: 268435456, actual: size },
			);
		}
	}

	interface SourceCacheEntry {
		bytes: Uint8Array;
		text: string;
		sha256: string;
		pixels: number;
	}

	const sourceCache = new Map<string, SourceCacheEntry>();

	function getSourceData(
		filePath: string,
		kind: "grid" | "mcpx" | "png" | "vanilla",
	): SourceCacheEntry {
		const cached = sourceCache.get(filePath);
		if (cached) return cached;
		const bytes = readFileSync(filePath);
		const text = bytes.toString("utf8");
		const sha256 = sha256Hex(bytes);
		let pixels = 0;
		if (kind === "png" || kind === "vanilla") {
			if (bytes.length >= 24) {
				const view = new DataView(
					bytes.buffer,
					bytes.byteOffset,
					bytes.byteLength,
				);
				const width = view.getUint32(16, false);
				const height = view.getUint32(20, false);
				pixels = width * height;
			}
		} else if (kind === "grid") {
			const c = parseGridTextForBuild(text);
			pixels = c.width * c.height;
		} else if (kind === "mcpx") {
			const c = parseMcpx(text);
			pixels = c.width * c.height;
		}
		const data = { bytes, text, sha256, pixels };
		sourceCache.set(filePath, data);
		return data;
	}

	const outputs: BuildOutputPlan[] = [];
	const targetPlans: TargetPlanInternal[] = [];
	let totalGeneratePixels = 0;

	for (const { file: recipeFile, recipe, expanded } of recipes) {
		const styleRef = recipe.style ?? project.style ?? "vanilla";
		const resolvedStyle = await resolveStyle(styleRef, {
			baseDir: recipe.style !== undefined ? dirname(recipeFile) : projectDir,
		});
		const styleHash = sha256Hex(
			canonicalCompactJson(normalizedStyleForHash(resolvedStyle)),
		);

		for (const target of expanded) {
			const sourcesList: Array<{ ref: string; sha256: string }> = [];
			let sourceDecl: RecipeSource | undefined;
			let sourceFilePath: string | undefined;
			let sourceBytes: Uint8Array | undefined;
			let sourceText: string | undefined;

			if (target.source !== undefined) {
				sourceDecl = recipe.sources?.[target.source];
				if (!sourceDecl) {
					throw new McAssetError(
						"RECIPE_INVALID",
						`Target '${target.id}' references unknown source '${target.source}'.`,
						{ targetId: target.id, source: target.source },
					);
				}
				if (
					sourceDecl.kind === "grid" ||
					sourceDecl.kind === "mcpx" ||
					sourceDecl.kind === "png"
				) {
					if (!sourceDecl.path) {
						throw new McAssetError(
							"RECIPE_INVALID",
							`Source '${target.source}' is missing path.`,
							{ source: target.source },
						);
					}
					sourceFilePath = resolve(dirname(recipeFile), sourceDecl.path);
					if (!existsSync(sourceFilePath)) {
						throw new McAssetError(
							"RECIPE_SOURCE_MISSING",
							`Source file not found: ${sourceDecl.path}`,
							{ path: sourceDecl.path },
						);
					}
					checkSourceFileBudget(sourceFilePath);
					const data = getSourceData(sourceFilePath, sourceDecl.kind);
					sourceBytes = data.bytes;
					sourceText = data.text;
					sourcesList.push({
						ref: canonicalCompactJson(sourceDecl),
						sha256: data.sha256,
					});
				} else if (sourceDecl.kind === "generate") {
					if (
						!sourceDecl.palette ||
						sourceDecl.seed === undefined ||
						!sourceDecl.pattern ||
						!sourceDecl.size
					) {
						throw new McAssetError(
							"RECIPE_INVALID",
							`generate source requires pattern, size, palette, and seed.`,
							{ source: target.source },
						);
					}
					const genDims = parseSize(sourceDecl.size);
					totalGeneratePixels += genDims.width * genDims.height;
					const palettePath = sourceDecl.palette.toLowerCase().endsWith(".mcpx")
						? resolve(dirname(recipeFile), sourceDecl.palette)
						: undefined;
					let paletteSha: string | undefined;
					if (palettePath) {
						if (!existsSync(palettePath)) {
							throw new McAssetError(
								"FILESYSTEM_ERROR",
								`Palette file not found: ${sourceDecl.palette}`,
								{ path: sourceDecl.palette },
							);
						}
						checkSourceFileBudget(palettePath);
						const pData = getSourceData(palettePath, "mcpx");
						paletteSha = pData.sha256;
					}
					// validate palette resolving
					resolveGeneratePalette(sourceDecl.palette, dirname(recipeFile));
					const ref = canonicalCompactJson(sourceDecl);
					sourcesList.push({
						ref,
						sha256: paletteSha ?? sha256Hex(ref),
					});
				} else if (sourceDecl.kind === "vanilla") {
					if (!project.vanillaSource) {
						throw new McAssetError(
							"RECIPE_SOURCE_MISSING",
							`vanilla source used without vanillaSource configured in project: ${sourceDecl.path}`,
							{ path: sourceDecl.path },
						);
					}
					if (
						!sourceDecl.path ||
						!isRelativeProjectPath(sourceDecl.path) ||
						sourceDecl.path.startsWith("..")
					) {
						throw new McAssetError(
							"RECIPE_SOURCE_MISSING",
							`Invalid vanilla source path: ${sourceDecl.path}`,
							{ path: sourceDecl.path },
						);
					}
					sourceFilePath = resolve(
						projectDir,
						project.vanillaSource.path,
						sourceDecl.path,
					);
					if (!existsSync(sourceFilePath)) {
						throw new McAssetError(
							"RECIPE_SOURCE_MISSING",
							`Vanilla source file not found: ${sourceDecl.path}`,
							{ path: sourceDecl.path },
						);
					}
					checkSourceFileBudget(sourceFilePath);
					const data = getSourceData(sourceFilePath, "vanilla");
					sourceBytes = data.bytes;
					sourceText = data.text;
					sourcesList.push({
						ref: canonicalCompactJson(sourceDecl),
						sha256: data.sha256,
					});
				}
			}

			const normalizedInput = {
				toolVersion: getToolVersion(),
				styleHash,
				sources: sourcesList.sort((a, b) => compareCodeUnits(a.ref, b.ref)),
				steps: target.steps,
			};
			const inputHash = sha256Hex(canonicalCompactJson(normalizedInput));

			// A target without a source has no image pipeline: its steps are JSON
			// steps only, and it plans no texture half at all.
			let texturePlan: TextureOutputPlanInternal | undefined;
			if (!isJsonOnlyTarget(target)) {
				const outputRelPath = target.output
					? `${project.outputDir}/${target.output}`
					: `${project.outputDir}/assets/${project.namespace}/textures/item/${target.id}.png`;
				assertOutputInsideOutputDir(outputRelPath, target, project.outputDir);

				const classified = classifyOutput(
					join(projectDir, outputRelPath),
					lock?.outputs?.[outputRelPath],
					inputHash,
				);
				outputs.push({
					path: outputRelPath,
					judgement: classified.judgement,
					targetId: target.id,
					recipeId: recipe.id,
				});
				texturePlan = { path: outputRelPath, ...classified };
			}

			// Check for sweep step with mcmetaOutput
			let mcmetaPlan: McmetaPlanInternal | undefined;
			const sweepStep = target.steps.find(
				(s) => s.type === "sweep" && typeof s.mcmetaOutput === "string",
			);
			if (sweepStep) {
				const mcmetaRelRaw = sweepStep.mcmetaOutput as string;
				if (!mcmetaRelRaw.endsWith(".mcmeta")) {
					throw new McAssetError(
						"RECIPE_INVALID",
						`mcmetaOutput must end with .mcmeta: ${mcmetaRelRaw}`,
						{ output: mcmetaRelRaw },
					);
				}
				const mcmetaRelPath = `${project.outputDir}/${mcmetaRelRaw}`;
				if (
					!isPathInsideDirectory(mcmetaRelPath, project.outputDir) ||
					mcmetaRelRaw.startsWith("..")
				) {
					throw new McAssetError(
						"RECIPE_INVALID",
						`mcmetaOutput escapes output directory: ${mcmetaRelRaw}`,
						{ output: mcmetaRelRaw },
					);
				}
				const classified = classifyOutput(
					join(projectDir, mcmetaRelPath),
					lock?.outputs?.[mcmetaRelPath],
					inputHash,
				);
				outputs.push({
					path: mcmetaRelPath,
					judgement: classified.judgement,
					targetId: target.id,
					recipeId: recipe.id,
				});
				mcmetaPlan = { path: mcmetaRelPath, ...classified };
			}

			const modelPlans: ModelOutputPlan[] = [];
			for (const [stepIndex, step] of target.steps.entries()) {
				if (step.type === "itemDefinition" || step.type === "blockModel") {
					if (comparePackFormats(format, "46.0") < 0) {
						throw new McAssetError(
							"RECIPE_VERSION_UNSUPPORTED",
							step.type === "blockModel"
								? `blockModel requires pack format 46.0 or higher because it writes an items definition; target format is ${format}.`
								: `itemDefinition requires pack format 46.0 or higher; target format is ${format}.`,
							{
								targetId: target.id,
								actualFormat: format,
								stepType: step.type,
							},
						);
					}
				}
				for (const output of collectJsonOutputsForStep(
					step,
					target.id,
					project.namespace,
					stepIndex,
				)) {
					validateJsonNamespaceOverride(
						output.name,
						project.namespace,
						step,
						target.id,
						`${step.type} step`,
					);

					const jsonRelPath = `${project.outputDir}/${output.path}`;
					const classified = classifyOutput(
						join(projectDir, jsonRelPath),
						lock?.outputs?.[jsonRelPath],
						inputHash,
					);
					outputs.push({
						path: jsonRelPath,
						judgement: classified.judgement,
						targetId: target.id,
						recipeId: recipe.id,
					});
					modelPlans.push({
						path: jsonRelPath,
						judgement: classified.judgement,
						kind: output.kind,
						stepIndex,
						needsRewrite: classified.needsRewrite,
					});
				}
			}

			// Render every planned document here, before any write: version
			// gates and reference checks must hold for own-clean outputs and
			// dry runs too, not only for files about to be rewritten.
			for (const mp of modelPlans) {
				try {
					mp.computedText = buildJsonOutputText(
						target.id,
						recipe.formatVersion,
						target.steps,
						mp,
						project.namespace,
						modelRules,
						format,
					);
				} catch (error) {
					if (error instanceof McAssetError) {
						const details = isJsonObject(error.details) ? error.details : {};
						throw new McAssetError(error.code, error.message, {
							...details,
							targetId: target.id,
							stepIndex: mp.stepIndex,
						});
					}
					throw error;
				}
			}

			targetPlans.push({
				targetId: target.id,
				recipeId: recipe.id,
				recipeFormatVersion: recipe.formatVersion,
				target,
				sourceDecl,
				sourceFilePath,
				sourceBytes,
				sourceText,
				recipeFilePath: recipeFile,
				styleName: styleRef,
				resolvedStyle,
				category:
					typeof target.category === "string" ? target.category : undefined,
				inputHash,
				texturePlan,
				mcmetaPlan,
				modelPlans,
			});
		}
	}

	let totalSourceBytes = 0;
	let totalDecodedPixels = totalGeneratePixels;
	for (const data of sourceCache.values()) {
		totalSourceBytes += data.bytes.length;
		totalDecodedPixels += data.pixels;
	}

	if (totalSourceBytes > 268435456) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			`Total source file bytes exceed 256 MiB limit: ${totalSourceBytes}.`,
			{ limit: 268435456, actual: totalSourceBytes },
		);
	}

	if (totalDecodedPixels > 16777216) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			`Total decoded source pixels exceed 16777216 limit: ${totalDecodedPixels}.`,
			{ limit: 16777216, actual: totalDecodedPixels },
		);
	}

	const plannedModelPaths = new Set<string>();
	for (const tp of targetPlans) {
		for (const mp of tp.modelPlans ?? []) {
			if (
				mp.kind === "model" ||
				mp.kind === "blockModel" ||
				mp.kind === "blockItemModel"
			) {
				plannedModelPaths.add(mp.path);
			}
		}
	}
	for (const tp of targetPlans) {
		for (const step of tp.target.steps) {
			if (step.type !== "itemDefinition") {
				continue;
			}
			const definition = isJsonObject(step.definition)
				? (step.definition as Record<string, unknown>)
				: undefined;
			let refs: string[];
			if (tp.recipeFormatVersion >= 2) {
				const item = resolveStepItemName(step, tp.targetId);
				const model = typeof step.model === "string" ? step.model : undefined;
				const defaultModel = model ?? `${project.namespace}:item/${item}`;
				refs = [
					...buildItemDefinitionDocumentV2(definition, defaultModel, {
						packFormat: format,
						targetId: tp.targetId,
					}).refs,
				];
			} else {
				refs = collectItemDefinitionModelRefs(definition);
				if (typeof step.model === "string" && refs.length === 0) {
					refs.push(step.model);
				}
			}
			assertItemModelRefsResolvable(
				refs,
				plannedModelPaths,
				projectDir,
				project,
				tp.targetId,
			);
		}
	}

	const recipeId = recipes.length === 1 ? recipes[0].recipe.id : "";

	return {
		recipeId,
		outputs,
		dryRun: options.dryRun === true,
		projectDir,
		project,
		targetPlans,
		lock,
	};
}

function parseGridTextForBuild(text: string): PixelCanvas {
	const lines = text.split("\n");
	let inGrid = false;
	const filtered: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === "[grid]" || trimmed === "[grid tokens]") {
			inGrid = true;
			filtered.push(line);
			continue;
		}
		if (inGrid && trimmed.startsWith(";")) {
			continue;
		}
		filtered.push(line);
	}
	return parseGridFile(filtered.join("\n"));
}

/**
 * Render one JSON document from the step that planned it. The plan records
 * the step index and document kind, so two steps that write different
 * document families never infer the source from a path.
 *
 * Planning renders every planned document, own-clean and dry-run targets
 * included: version gates and model-reference checks must hold for the
 * whole recipe even when nothing is going to be rewritten.
 */
function buildJsonOutputText(
	targetId: string,
	recipeFormatVersion: number,
	steps: readonly RecipeStep[],
	mp: ModelOutputPlan,
	projectNamespace: string,
	rules: ModelRules,
	packFormat: string,
): string {
	const step = steps[mp.stepIndex];
	if (step === undefined) {
		throw new McAssetError(
			"INTERNAL_ERROR",
			`No step at index ${mp.stepIndex} for planned output '${mp.path}'.`,
			{ targetId },
		);
	}
	if (mp.kind === "model" && step.type === "model") {
		const item = resolveStepItemName(step, targetId);
		if (step.modelSpec !== undefined) {
			if (!isJsonObject(step.modelSpec)) {
				throw new McAssetError(
					"RECIPE_INVALID",
					`model step modelSpec must be an object for item '${item}'.`,
					{
						targetId,
						stepIndex: mp.stepIndex,
						item,
					},
				);
			}
			return canonicalDocumentText(step.modelSpec);
		}
		const parent = typeof step.parent === "string" ? step.parent : "generated";
		const texture =
			typeof step.texture === "string"
				? step.texture
				: `${projectNamespace}:item/${item}`;
		return canonicalDocumentText(
			buildParentModel({
				parent,
				texture,
				item,
				namespace: projectNamespace,
			}),
		);
	}
	if (mp.kind === "itemDefinition" && step.type === "itemDefinition") {
		const item = resolveStepItemName(step, targetId);
		const model = typeof step.model === "string" ? step.model : undefined;
		const definition = isJsonObject(step.definition)
			? (step.definition as Record<string, unknown>)
			: undefined;
		const defaultModel = model ?? `${projectNamespace}:item/${item}`;
		if (recipeFormatVersion >= 2) {
			return canonicalDocumentText(
				buildItemDefinitionDocumentV2(definition, defaultModel, {
					packFormat,
					targetId,
				}).document,
			);
		}
		return canonicalDocumentText(
			buildItemDefinitionDocument(definition, defaultModel),
		);
	}
	if (step.type === "blockModel") {
		const spec = parseBlockModelStep(step, targetId);
		if (mp.kind === "blockModel") {
			return buildBlockModelText(spec, rules, targetId);
		}
		if (mp.kind === "blockItemModel") {
			return buildBlockItemModelText(spec, projectNamespace);
		}
		if (mp.kind === "itemDefinition") {
			return buildBlockItemDefinitionText(spec, projectNamespace);
		}
	}
	if (mp.kind === "blockstate" && step.type === "blockstate") {
		return buildBlockstateText(
			parseBlockstateStep(step, targetId),
			rules,
			targetId,
		);
	}
	throw new McAssetError(
		"INTERNAL_ERROR",
		`No matching step for planned output '${mp.path}'.`,
		{
			targetId,
		},
	);
}

/**
 * Execute a build plan.
 *
 * Verifies no conflicts, runs safe-output preflights, renders outputs,
 * writes changed files atomically, and commits the lockfile.
 */
export async function executePackBuild(plan: PackBuildPlan): Promise<{
	completed: readonly string[];
	failedTarget?: string | undefined;
}> {
	if (plan.dryRun) {
		return { completed: [] };
	}

	const conflicts = plan.outputs
		.filter((o) => o.judgement === "own-modified" || o.judgement === "foreign")
		.map((o) => ({ path: o.path, reason: o.judgement }))
		.sort((a, b) => compareCodeUnits(a.path, b.path));

	if (conflicts.length > 0) {
		throw new McAssetError(
			"PACK_BUILD_CONFLICT",
			`pack build found ${conflicts.length} conflicting output${conflicts.length === 1 ? "" : "s"}.`,
			{ conflicts, recipeId: plan.recipeId },
		);
	}

	const projectDir = plan.projectDir ?? process.cwd();
	const targetPlans = (plan.targetPlans ?? []) as TargetPlanInternal[];
	const targetsToExecute = targetPlans.filter(
		(tp) =>
			tp.texturePlan?.needsRewrite ||
			tp.mcmetaPlan?.needsRewrite ||
			(tp.modelPlans ?? []).some((mp) => mp.needsRewrite),
	);

	if (targetsToExecute.length === 0) {
		return { completed: [] };
	}

	// 1. Safe-output preflight across all outputs to write
	const outputTargets: OutputTarget[] = [];
	for (const tp of targetsToExecute) {
		const texturePlan = tp.texturePlan;
		if (texturePlan?.needsRewrite) {
			outputTargets.push({
				path: resolve(projectDir, texturePlan.path),
				extension: ".png",
				allowOverwrite: true,
			});
		}
		if (tp.mcmetaPlan?.needsRewrite) {
			outputTargets.push({
				path: resolve(projectDir, tp.mcmetaPlan.path),
				extension: ".mcmeta",
				allowOverwrite: true,
			});
		}
		for (const mp of tp.modelPlans ?? []) {
			if (mp.needsRewrite) {
				outputTargets.push({
					path: resolve(projectDir, mp.path),
					extension: ".json",
					allowOverwrite: true,
				});
			}
		}
	}

	const inputFiles = [
		...new Set(
			targetsToExecute
				.map((tp) => tp.sourceFilePath)
				.filter((p): p is string => p !== undefined),
		),
	];

	const plannedTargets = await planOutputTargets(outputTargets, {
		inputs: inputFiles,
		mkdir: true,
	});

	// 2. Execute steps in memory
	const payloads = new Map<string, Uint8Array>();
	const completedPaths: string[] = [];

	for (const tp of targetsToExecute) {
		const texture = tp.texturePlan;
		if (texture !== undefined) {
			let canvas: PixelCanvas;
			const sourceDecl = tp.sourceDecl;

			if (sourceDecl) {
				if (sourceDecl.kind === "grid") {
					canvas = parseGridTextForBuild(tp.sourceText ?? "");
				} else if (sourceDecl.kind === "mcpx") {
					canvas = parseMcpx(tp.sourceText ?? "");
				} else if (sourceDecl.kind === "png" || sourceDecl.kind === "vanilla") {
					canvas = decodePng(tp.sourceBytes ?? new Uint8Array()).canvas;
				} else if (sourceDecl.kind === "generate") {
					const dims = parseSize(sourceDecl.size ?? "16x16");
					const colors = resolveGeneratePalette(
						sourceDecl.palette ?? "",
						dirname(tp.recipeFilePath),
					);
					const gen = generateProcedural(
						sourceDecl.pattern as GeneratePatternName,
						{
							width: dims.width,
							height: dims.height,
							seed: sourceDecl.seed ?? 0,
							palette: colors,
						},
					);
					canvas = createCanvas(gen.width, gen.height);
					const layer = addLayer(canvas, { id: "base" });
					replaceLayerPixels(canvas, layer.id, gen.pixels);
				} else {
					throw new McAssetError(
						"RECIPE_INVALID",
						`Unknown source kind for ${tp.targetId}`,
					);
				}
			} else {
				canvas = createCanvas(16, 16);
			}

			for (let stepIndex = 0; stepIndex < tp.target.steps.length; stepIndex++) {
				const step = tp.target.steps[stepIndex];
				try {
					if (step.type === "recolor") {
						const family = step.family as string;
						const familyRamp = tp.resolvedStyle.palettes[family];
						if (familyRamp === undefined) {
							throw new McAssetError(
								"STYLE_FAMILY_NOT_FOUND",
								`Family ${family} is not defined in the resolved style.`,
								{ family },
							);
						}
						const recolorOpts: FamilyRecolorOptions = {
							ramp: familyRamp,
						};
						if (step.selection !== undefined) {
							recolorOpts.selection = step.selection as SelectionExpr;
						}
						if (step.preserveRegions !== undefined) {
							recolorOpts.preserveRegions = step.preserveRegions as string[];
						}
						if (step.preserveRoles !== undefined) {
							recolorOpts.preserveRoles = step.preserveRoles as PaletteRole[];
						}
						recolorCanvasByFamily(canvas, family, recolorOpts);
					} else if (step.type === "outline") {
						const layerId =
							(step.layerId as string | undefined) ??
							canvas.layers[0]?.id ??
							"base";
						const styleOutline = tp.resolvedStyle.outline;
						const outlineOpts: OutlineOptions = {
							mode: (step.mode as OutlineMode | undefined) ?? styleOutline.mode,
							position:
								(step.position as OutlinePosition | undefined) ??
								styleOutline.position,
							luminanceDropPermille:
								(step.luminanceDropPermille as number | undefined) ??
								styleOutline.luminanceDropPermille,
							saturationRatioPermille:
								(step.saturationRatioPermille as number | undefined) ??
								styleOutline.saturationRatioPermille,
							maxHueOffsetDegrees:
								(step.maxHueOffsetDegrees as number | undefined) ??
								styleOutline.maxHueOffsetDegrees,
							snapFamilies:
								(step.snapFamilies as boolean | undefined) ??
								styleOutline.snapFamilies,
						};
						let color: RGBA | undefined;
						if (typeof step.color === "string") {
							color = parseSweepColor(step.color);
						} else if (
							step.color &&
							typeof step.color === "object" &&
							"r" in step.color
						) {
							color = step.color as RGBA;
						} else if (styleOutline.color) {
							color = parseSweepColor(styleOutline.color);
						}
						if (color !== undefined) {
							outlineOpts.color = color;
						}
						if (step.family !== undefined) {
							outlineOpts.family = step.family as string;
						}
						applyOutline(canvas, layerId, outlineOpts);
					} else if (step.type === "sweep") {
						const angle =
							(step.angle as SweepAngleDegrees | undefined) ??
							tp.resolvedStyle.animation?.sweepAngleDegrees ??
							135;
						const width =
							(step.width as number | undefined) ??
							tp.resolvedStyle.animation?.sweepWidthPixels ??
							1;
						let color: RGBA;
						if (typeof step.color === "string") {
							color = parseSweepColor(step.color);
						} else if (tp.resolvedStyle.animation?.sweepColor) {
							color = parseSweepColor(tp.resolvedStyle.animation.sweepColor);
						} else {
							color = parseSweepColor("#FFFFFF");
						}
						const frames =
							(step.frames as number | undefined) ??
							tp.resolvedStyle.animation?.sweepFrames ??
							16;

						const initialWidth = canvas.width;
						const initialHeight = canvas.height;

						const sweepResult = generateSweepFrames({
							canvas,
							angleDegrees: angle,
							widthPixels: width,
							color,
							frames,
						});

						const packed = packFrameSet(sweepResult.frameSet, "vertical");
						const sheetCanvas = createCanvas(packed.width, packed.height);
						const sheetLayer = addLayer(sheetCanvas, { id: "base" });
						replaceLayerPixels(sheetCanvas, sheetLayer.id, packed.pixels);
						canvas = sheetCanvas;

						if (tp.mcmetaPlan) {
							const holdTicks =
								(step.holdTicks as number | undefined) ??
								tp.resolvedStyle.animation?.holdTicks ??
								100;
							const frametime =
								(step.frametime as number | undefined) ??
								tp.resolvedStyle.animation?.frametime ??
								1;
							const preset = (tp.resolvedStyle.animation?.timelinePreset ??
								"hold-and-sweep") as TimelinePreset;
							const mcmetaResult = generateAnimationMcmeta({
								sheetWidth: packed.width,
								sheetHeight: packed.height,
								frameSize: `${initialWidth}x${initialHeight}`,
								frametime,
								preset,
								holdTicks,
								interpolate:
									(step.interpolate as boolean | undefined) ??
									tp.resolvedStyle.animation?.interpolate,
							});
							const mcmetaBytes = new TextEncoder().encode(mcmetaResult.text);
							tp.mcmetaPlan.computedOutputHash = sha256Hex(mcmetaBytes);
							if (tp.mcmetaPlan.needsRewrite) {
								payloads.set(
									resolve(projectDir, tp.mcmetaPlan.path),
									mcmetaBytes,
								);
								completedPaths.push(tp.mcmetaPlan.path);
							}
						}
					} else if (step.type === "operations") {
						const rawOps = Array.isArray(step.operations)
							? step.operations
							: [];
						const typedOps = parseOperationsJson(
							JSON.stringify(rawOps),
							canvas.layers.length === 1 ? canvas.layers[0]?.id : undefined,
						);
						applyOperations(canvas, typedOps);
					} else if (
						step.type === "model" ||
						step.type === "itemDefinition" ||
						step.type === "blockModel" ||
						step.type === "blockstate"
					) {
						// JSON outputs are validated and rendered after the pixel steps.
					} else {
						throw new McAssetError(
							"RECIPE_INVALID",
							`Unknown step type: ${step.type}`,
						);
					}
				} catch (err) {
					if (err instanceof McAssetError) {
						const details = isJsonObject(err.details) ? err.details : {};
						throw new McAssetError(err.code, err.message, {
							...details,
							targetId: tp.targetId,
							stepIndex,
						});
					}
					throw err;
				}
			}

			if (texture.needsRewrite) {
				const pngBytes = encodePng(canvas);
				texture.computedOutputHash = sha256Hex(pngBytes);
				payloads.set(resolve(projectDir, texture.path), pngBytes);
				completedPaths.push(texture.path);
			}
		}

		for (const mp of tp.modelPlans ?? []) {
			if (!mp.needsRewrite) {
				continue;
			}
			const text = mp.computedText;
			if (text === undefined) {
				throw new McAssetError(
					"INTERNAL_ERROR",
					`Planned output '${mp.path}' has no rendered text.`,
					{ targetId: tp.targetId, stepIndex: mp.stepIndex },
				);
			}
			const bytes = new TextEncoder().encode(text);
			mp.computedOutputHash = sha256Hex(bytes);
			payloads.set(resolve(projectDir, mp.path), bytes);
			completedPaths.push(mp.path);
		}
	}

	// 3. Write planned targets to disk
	await writePlannedTargets(plannedTargets, payloads, { mkdir: true });

	// 4. Update and write lockfile atomically
	const updatedOutputs: Record<string, LockEntry> = plan.lock
		? { ...plan.lock.outputs }
		: {};

	for (const tp of targetsToExecute) {
		const texture = tp.texturePlan;
		if (texture?.needsRewrite && texture.computedOutputHash !== undefined) {
			updatedOutputs[texture.path] = {
				targetId: tp.targetId,
				recipeId: tp.recipeId,
				kind: "texture",
				...(tp.category !== undefined ? { category: tp.category } : {}),
				inputHash: tp.inputHash,
				outputHash: texture.computedOutputHash,
			};
		}
		for (const mp of tp.modelPlans ?? []) {
			if (mp.needsRewrite && mp.computedOutputHash !== undefined) {
				updatedOutputs[mp.path] = {
					targetId: tp.targetId,
					recipeId: tp.recipeId,
					kind: mp.kind,
					inputHash: tp.inputHash,
					outputHash: mp.computedOutputHash,
				};
			}
		}
		if (
			tp.mcmetaPlan?.needsRewrite &&
			tp.mcmetaPlan.computedOutputHash !== undefined
		) {
			updatedOutputs[tp.mcmetaPlan.path] = {
				targetId: tp.targetId,
				recipeId: tp.recipeId,
				kind: "mcmeta",
				inputHash: tp.inputHash,
				outputHash: tp.mcmetaPlan.computedOutputHash,
			};
		}
	}

	const sortedOutputs: Record<string, LockEntry> = {};
	for (const key of Object.keys(updatedOutputs).sort(compareCodeUnits)) {
		sortedOutputs[key] = updatedOutputs[key];
	}

	const lockDoc: LockDocument = {
		formatVersion: 1,
		tool: { name: "mc-asset", version: getToolVersion() },
		project: {
			namespace: plan.project?.namespace ?? "",
			style: plan.project?.style ?? "vanilla",
		},
		outputs: sortedOutputs,
	};

	const lockText = serializeLockText(lockDoc);
	await atomicWriteFile(join(projectDir, "mc-asset.lock.json"), lockText, {
		force: true,
		mkdir: true,
	});

	return { completed: completedPaths };
}
