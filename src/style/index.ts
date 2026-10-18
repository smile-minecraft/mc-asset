/**
 * Style presets and the palette library: the frozen data model, the four
 * builtin presets with their twelve-family ramps, style file resolution, and
 * the `.mcpx` palette export.
 */

export { buildPaletteMcpx, type PaletteExport } from "./export-palette.ts";
export {
	buildStyleFileText,
	emptyResolvedStyle,
	getBuiltinStyle,
	isStyleSource,
	MAX_STYLE_CHAIN,
	type ResolveStyleOptions,
	resolveStyle,
	type StyleCreateOptions,
} from "./load.ts";
export {
	DARK_FRAME_PALETTE,
	FAIRY_FLAT_PALETTE,
	type FamilyPaletteTable,
	PRESET_PALETTES,
	paletteFamilyOrder,
	SOFT_PALETTE,
	VANILLA_PALETTE,
} from "./palette.ts";
export {
	listStylePresets,
	STYLE_PRESETS,
	type StylePresetDefinition,
} from "./presets.ts";
export {
	BUILTIN_FAMILY_ORDER,
	type BuiltinFamilyId,
	CATEGORY_IDS,
	COLOR_PATTERN,
	DEFAULT_ANIMATION,
	DEFAULT_DITHER,
	DEFAULT_HIGHLIGHT,
	DEFAULT_LIGHT,
	DEFAULT_LIMITS,
	DEFAULT_OUTLINE,
	FAMILY_ID_PATTERN,
	FAMILY_ROLES,
	type FamilyRamp,
	type FamilyRole,
	type ResolvedStyle,
	STYLE_CHAIN_LIMIT,
	STYLE_FILE_SUFFIX,
	STYLE_FORMAT_VERSION,
	STYLE_ID_PATTERN,
	STYLE_PRESET_IDS,
	type StyleAnimationRules,
	type StyleCategoryId,
	type StyleCategoryOverride,
	type StyleCreateInput,
	type StyleDitherMode,
	type StyleDitherRules,
	type StyleHighlightRules,
	type StyleLightRules,
	type StyleLimitRules,
	type StyleLoadFailure,
	type StyleOutlineMode,
	type StyleOutlinePosition,
	type StyleOutlineRules,
	type StylePresetId,
	type StyleSummary,
	type StyleSweepAngle,
	type StyleTimelinePreset,
} from "./types.ts";
