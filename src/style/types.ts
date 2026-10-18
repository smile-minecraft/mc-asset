/**
 * Style file data model: the frozen vocabulary of a `.style.json` document
 * (field names, enums, thresholds, defaults) plus the resolved shape that
 * `style list` and `style show` report. Reading, merging, and the palette
 * library live in the sibling modules.
 */

/** Format version this toolchain writes and accepts. */
export const STYLE_FORMAT_VERSION = 1;

/** Suffix that marks a document as a style source. */
export const STYLE_FILE_SUFFIX = ".style.json";

/** Builtin preset ids in registry order; a style file may not reuse them. */
export const STYLE_PRESET_IDS = [
	"vanilla",
	"soft",
	"fairy-flat",
	"dark-frame",
] as const;
export type StylePresetId = (typeof STYLE_PRESET_IDS)[number];

/** The six ramp roles of one family, in frozen ramp order. */
export const FAMILY_ROLES = [
	"outline",
	"shadow",
	"dark",
	"base",
	"light",
	"highlight",
] as const;
export type FamilyRole = (typeof FAMILY_ROLES)[number];

/** The twelve builtin families, in the frozen export order. */
export const BUILTIN_FAMILY_ORDER = [
	"iron",
	"gold",
	"diamond",
	"netherite",
	"copper",
	"wood",
	"stone",
	"emerald",
	"amethyst",
	"redstone",
	"lapis",
	"quartz",
] as const;
export type BuiltinFamilyId = (typeof BUILTIN_FAMILY_ORDER)[number];

/** Category ids a `categoryOverrides` entry may name, in frozen order. */
export const CATEGORY_IDS = [
	"generic",
	"sword",
	"pickaxe",
	"axe",
	"shovel",
	"hoe",
	"rod_staff",
	"ingot",
	"gem_crystal",
	"round_fruit",
	"bread",
	"bottle",
	"book",
	"scroll_paper",
	"talisman",
] as const;
export type StyleCategoryId = (typeof CATEGORY_IDS)[number];

/** Style id: `[a-z][a-z0-9_-]{0,63}`. */
export const STYLE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/** Family id: `[a-z][a-z0-9_-]{0,31}`. */
export const FAMILY_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** Color form `#RRGGBB`; alpha is always `FF`. */
export const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/** Longest `extends` chain, entry source included. */
export const STYLE_CHAIN_LIMIT = 8;

/** One family ramp: all six roles present after resolution. */
export type FamilyRamp = {
	readonly [role in FamilyRole]: string;
};

export type StyleOutlineMode =
	| "tinted"
	| "selective"
	| "uniform"
	| "black"
	| "strip";
export type StyleOutlinePosition = "inside" | "outside";

export interface StyleOutlineRules {
	readonly mode: StyleOutlineMode;
	readonly position: StyleOutlinePosition;
	readonly color: string | null;
	readonly luminanceDropPermille: number;
	readonly saturationRatioPermille: number;
	readonly maxHueOffsetDegrees: number;
	readonly darknessGapPermille: number;
	readonly snapFamilies: boolean;
}

export interface StyleLightRules {
	readonly direction: "top-left";
	readonly minTlBrPermille: number;
}

export interface StyleLimitRules {
	readonly maxColors: number;
	readonly minLevels: number;
	readonly maxLevels: number;
	readonly dynamicRangeMinPermille: number;
	readonly requireMargin: boolean;
	readonly axisCheckCategories: readonly string[];
}

export interface StyleHighlightRules {
	readonly minPixels: number;
	readonly maxPixels: number;
	readonly minRatioPermille: number;
	readonly maxRatioPermille: number;
	readonly bufferMinRatioPermille: number;
}

export type StyleDitherMode = "allow" | "discourage" | "forbid";

export interface StyleDitherRules {
	readonly mode: StyleDitherMode;
	readonly maxRatioPermille: number;
}

export type StyleTimelinePreset = "hold-and-sweep" | "ping-pong" | "pulse";
export type StyleSweepAngle = 45 | 90 | 135 | 180;

export interface StyleAnimationRules {
	readonly timelinePreset: StyleTimelinePreset;
	readonly frametime: number;
	readonly holdTicks: number;
	readonly sweepFrames: number;
	readonly sweepAngleDegrees: StyleSweepAngle;
	readonly sweepWidthPixels: number;
	readonly sweepColor: string;
	readonly interpolate: boolean;
}

/** Per-category override: the five overrideable rule sections. */
export interface StyleCategoryOverride {
	readonly outline?: Partial<StyleOutlineRules>;
	readonly light?: Partial<StyleLightRules>;
	readonly limits?: Partial<StyleLimitRules>;
	readonly highlight?: Partial<StyleHighlightRules>;
	readonly dither?: Partial<StyleDitherRules>;
}

/**
 * A style after inheritance, merging, and completion. `extendsChain` lists
 * the sources from the requested one down to the base, innermost last.
 */
export interface ResolvedStyle {
	formatVersion: number;
	id: string;
	name: string;
	description: string;
	palettes: Record<string, FamilyRamp>;
	outline: StyleOutlineRules;
	light: StyleLightRules;
	limits: StyleLimitRules;
	highlight: StyleHighlightRules;
	dither: StyleDitherRules;
	animation: StyleAnimationRules;
	categoryOverrides: Record<string, StyleCategoryOverride>;
	extendsChain: string[];
}

/** One entry of a preset or style listing. */
export interface StyleSummary {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	/** Absolute path when the summary came from a style file. */
	readonly path?: string | undefined;
}

/** What `style create` writes; `overrides` merges into the document. */
export interface StyleCreateInput {
	id: string;
	name?: string | undefined;
	extends?: string | undefined;
	overrides?: Record<string, unknown> | undefined;
}

/** One rejected style source, reported by the listing modes. */
export interface StyleLoadFailure {
	readonly path: string;
	readonly code: string;
	readonly message: string;
}

export const DEFAULT_OUTLINE: StyleOutlineRules = {
	mode: "tinted",
	position: "inside",
	color: null,
	luminanceDropPermille: 120,
	saturationRatioPermille: 1000,
	maxHueOffsetDegrees: 5,
	darknessGapPermille: 50,
	snapFamilies: true,
};

export const DEFAULT_LIGHT: StyleLightRules = {
	direction: "top-left",
	minTlBrPermille: 30,
};

export const DEFAULT_LIMITS: StyleLimitRules = {
	maxColors: 13,
	minLevels: 6,
	maxLevels: 16,
	dynamicRangeMinPermille: 450,
	requireMargin: false,
	axisCheckCategories: ["sword", "pickaxe", "axe", "hoe", "rod_staff"],
};

export const DEFAULT_HIGHLIGHT: StyleHighlightRules = {
	minPixels: 1,
	maxPixels: 6,
	minRatioPermille: 10,
	maxRatioPermille: 80,
	bufferMinRatioPermille: 400,
};

export const DEFAULT_DITHER: StyleDitherRules = {
	mode: "allow",
	maxRatioPermille: 150,
};

export const DEFAULT_ANIMATION: StyleAnimationRules = {
	timelinePreset: "hold-and-sweep",
	frametime: 1,
	holdTicks: 100,
	sweepFrames: 10,
	sweepAngleDegrees: 135,
	sweepWidthPixels: 1,
	sweepColor: "#FFFFFF",
	interpolate: false,
};
