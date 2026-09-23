export type {
	AddLayerOptions,
	AddRegionOptions,
	CreateCanvasOptions,
} from "./canvas.ts";
export {
	addLayer,
	addRegion,
	createAuthoringPalette,
	createCanvas,
	getLayer,
	getPixel,
	getRegion,
	getRegionValue,
	replaceLayerPixels,
	replaceRegionMask,
	setPixel,
	setRegionValue,
} from "./canvas.ts";
export type {
	CleanupClass,
	CleanupCounts,
	CleanupDetection,
	CleanupOptions,
	CleanupPixel,
	CleanupPositions,
	CleanupResult,
	FixCleanupOptions,
} from "./cleanup.ts";
export {
	CLEANUP_CLASSES,
	detectCleanup,
	fixCleanup,
	isCleanupClass,
} from "./cleanup.ts";
export type { ErrorCode, ExitCode, FixedErrorCode } from "./errors.ts";
export {
	ERROR_EXIT_CODE,
	exitCodeForError,
	isErrorCode,
	McAssetError,
	resolveExitCode,
} from "./errors.ts";
export type {
	AnimationLayout,
	FrameSet,
	FrameSetMetadata,
	GeometryReport,
	PackedSheet,
} from "./frameset.ts";
export {
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
	sheetDimensions,
	unpackSheetToFrameSet,
} from "./frameset.ts";
export type { DuplicateLayerOptions } from "./layers.ts";
export {
	clearLayer,
	duplicateLayer,
	fillLayer,
	mergeLayer,
	moveLayer,
	parseFillColor,
	removeLayer,
	removeRegion,
	renameLayer,
	renameRegion,
	reorderLayer,
	reorderRegion,
} from "./layers.ts";
export type {
	BuiltinMaterialId,
	MaterialCharacteristics,
	MaterialDefinition,
} from "./material.ts";
export {
	findPaletteEntryByRole,
	getMaterial,
	getMaterialPalette,
	isBuiltinMaterialId,
	listMaterialIds,
} from "./material.ts";
export type {
	McmetaAnimationFrame,
	McmetaAnimationGeometry,
	McmetaAnimationInfo,
	McmetaAnimationLayout,
	McmetaMipmapWarning,
	McmetaTextureInfo,
} from "./mcmeta.ts";
export {
	checkAnimationFrameIndices,
	deriveAnimationGeometry,
	extractAnimationSection,
	extractTextureSection,
	mipmapCutoutMeanWarning,
} from "./mcmeta.ts";
export type {
	PaletteDominantColor,
	PaletteInspectReport,
	PaletteRoleSummary,
} from "./palette.ts";
export {
	applyPalette,
	extractPalette,
	inspectPalette,
	mapPixelsToPalette,
} from "./palette.ts";
export type {
	PixelizeOptions,
	PixelizePresetName,
	PixelizePresetParams,
	PixelizeReport,
	PixelizeSize,
	PixelizeStage,
} from "./pixelize.ts";
export {
	describePixelizePreset,
	isStandardPixelizeSize,
	PIXELIZE_PRESETS,
	PIXELIZE_STAGES,
	parsePixelizePreset,
	parsePixelizeSize,
	runPixelize,
} from "./pixelize.ts";
export type {
	GeneratePatternName,
	GenerateProceduralOptions,
	GenerateProceduralResult,
} from "./procedural.ts";
export {
	createXorshift32,
	GENERATE_PATTERNS,
	GENERATE_SEED_MAX,
	GENERATE_SEED_MIN,
	generateProcedural,
	orderPaletteColors,
	parseGeneratePattern,
	parseGenerateSeed,
} from "./procedural.ts";
export type { QuantizeResult } from "./quantizer.ts";
export {
	assertMcpxPaletteCapacity,
	quantizePixels,
	validateColorsOption,
} from "./quantizer.ts";
export type {
	RecolorBand,
	RecolorOptions,
	RecolorReport,
} from "./recolor.ts";
export {
	bandForLuminance,
	luminanceOf,
	mapRoleToBand,
	recolorColor,
	recolorLayer,
} from "./recolor.ts";
export type {
	EvaluatedSelection,
	ResolvedSelection,
	SelectedPoint,
	SelectionAst,
	SelectionEvaluateOptions,
	SelectionExpr,
	SelectionKind,
} from "./selection.ts";
export {
	countSelectedPixels,
	estimateSelectionScratchBytes,
	evaluateSelectionExpr,
	forEachSelectedPixel,
	isPixelSelected,
	listSelectedPixels,
	parseSelectionExprValue,
	resolveSelection,
	SELECTION_CONNECTED_EXTRA_EQUIVALENTS,
	selectionExpressionDepth,
	selectionUsesConnectedQueue,
} from "./selection.ts";
export type {
	TileAxis,
	TilePreview,
	TileRepetitionReport,
	TileSeamReport,
	TileSeamScore,
} from "./tile.ts";
export {
	applyBrightnessMatch,
	applyEdgeMatch,
	applyTileCorrections,
	buildTilePreview,
	formatTileScore,
	parsePreviewSize,
	parseTileAxis,
	repetitionScore,
	seamMetrics,
	TILE_PAIR_MAX_DISTANCE,
} from "./tile.ts";
export type { PadOptions, ResizeMode } from "./transform.ts";
export {
	crop,
	flipHorizontal,
	flipVertical,
	pad,
	resize,
	rotate90,
	rotate180,
	rotate270,
	translate,
} from "./transform.ts";
export type {
	AuthoringPalette,
	AuthoringPaletteEntry,
	BlendMode,
	CanvasMetadata,
	PaletteRole,
	PixelCanvas,
	PixelLayer,
	PixelRegion,
	Rect,
	RGBA,
} from "./types.ts";
export {
	assertPixelInBounds,
	assertRectInBounds,
	assertValidCanvas,
	BYTES_PER_PIXEL,
	CANVAS_MAX_EDGE,
	CANVAS_MIN_EDGE,
	CANVAS_VERSION,
	checkResourceLimits,
	estimateMemoryBytes,
	MASK_BYTES_PER_PIXEL,
	MAX_LAYER_COUNT,
	MAX_REGION_COUNT,
	MEMORY_BUDGET_BYTES,
	validateColor,
	validateCoordinate,
	validateDimension,
	validateLayerPixelsSize,
	validateMaskValue,
	validateOpacity,
	validateRect,
	validateRegionMaskSize,
} from "./validate.ts";
