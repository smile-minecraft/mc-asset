export type {
	AtlasCoverage,
	AtlasCoverageDiagnosis,
	AtlasLayerInput,
	AtlasLayersParseResult,
	AtlasParseOptions,
	AtlasPolicy,
	AtlasSkip,
	AtlasSkipKind,
	AtlasSpriteEntry,
	AtlasSpriteRules,
} from "./atlas.ts";
export {
	atlasCoverageDetail,
	atlasNameOf,
	atlasSpriteCoverageFor,
	parseAtlasLayers,
	requiredAtlasForModel,
	spriteIdForTextureValue,
} from "./atlas.ts";
export type {
	ValidateFinding,
	ValidateFindingLevel,
	ValidateOptions,
	ValidateReport,
	ValidateReportOptions,
	ValidateVerdict,
} from "./checks.ts";
export {
	PALETTE_SIZE_WARN_THRESHOLD,
	validateCanvas,
	validateReport,
} from "./checks.ts";
export type {
	PackCoverage,
	PackCoverageSkip,
	PackFinding,
	PackReport,
	PackScanOptions,
} from "./pack.ts";
export { scanPack } from "./pack.ts";
export type {
	ResolutionKind,
	ResolutionResult,
	ResolutionSource,
	ResolutionStatus,
	ResourceContext,
} from "./resource-context.ts";
export {
	createResourceContext,
	findCaseVariant,
	resolveModelReference,
	resolveTextureReference,
} from "./resource-context.ts";
