import { cloneJsonValue, type JsonObject } from "./json.ts";
import { PRESET_PALETTES } from "./palette.ts";
import {
	DEFAULT_ANIMATION,
	DEFAULT_DITHER,
	DEFAULT_HIGHLIGHT,
	DEFAULT_LIGHT,
	DEFAULT_LIMITS,
	DEFAULT_OUTLINE,
	type FamilyRamp,
	STYLE_FORMAT_VERSION,
	STYLE_PRESET_IDS,
	type StyleCategoryOverride,
	type StyleDitherRules,
	type StyleHighlightRules,
	type StyleLightRules,
	type StyleLimitRules,
	type StyleOutlineRules,
	type StylePresetId,
	type StyleSummary,
} from "./types.ts";

/**
 * The four builtin presets: display data, the rule sections that differ
 * from the schema defaults, and the palette table each one ships. Sections
 * a preset does not mention keep their defaults, so a preset that agrees
 * with them only lists what differs from the shared baseline.
 */

export interface StylePresetDefinition {
	readonly id: StylePresetId;
	readonly name: string;
	readonly description: string;
	readonly outline: Partial<StyleOutlineRules>;
	readonly light: Partial<StyleLightRules>;
	readonly limits: Partial<StyleLimitRules>;
	readonly highlight: Partial<StyleHighlightRules>;
	readonly dither: Partial<StyleDitherRules>;
	readonly categoryOverrides: Readonly<Record<string, StyleCategoryOverride>>;
	readonly palettes: Readonly<Record<string, FamilyRamp>>;
}

/** Measured category thresholds shared by the vanilla and soft presets. */
const MEASURED_CATEGORY_OVERRIDES: Record<string, StyleCategoryOverride> = {
	sword: {
		limits: { minLevels: 10, maxLevels: 14, dynamicRangeMinPermille: 750 },
		light: { minTlBrPermille: 60 },
	},
	pickaxe: {
		limits: { minLevels: 8, maxLevels: 12, dynamicRangeMinPermille: 700 },
		light: { minTlBrPermille: 50 },
	},
	axe: {
		limits: { minLevels: 9, maxLevels: 12, dynamicRangeMinPermille: 700 },
		light: { minTlBrPermille: 120 },
	},
	shovel: {
		limits: { minLevels: 8, maxLevels: 11, dynamicRangeMinPermille: 650 },
		light: { minTlBrPermille: -200 },
	},
	hoe: {
		limits: { minLevels: 8, maxLevels: 11, dynamicRangeMinPermille: 650 },
		light: { minTlBrPermille: 100 },
	},
	rod_staff: {
		limits: { minLevels: 8, maxLevels: 12, dynamicRangeMinPermille: 550 },
		light: { minTlBrPermille: 20 },
	},
	ingot: {
		limits: { minLevels: 7, maxLevels: 10, dynamicRangeMinPermille: 650 },
		light: { minTlBrPermille: 60 },
	},
	gem_crystal: {
		limits: { minLevels: 8, maxLevels: 12, dynamicRangeMinPermille: 750 },
		light: { minTlBrPermille: 70 },
	},
	round_fruit: {
		limits: { minLevels: 8, maxLevels: 12, dynamicRangeMinPermille: 550 },
		light: { minTlBrPermille: 150 },
	},
	bread: {
		limits: { minLevels: 7, maxLevels: 10, dynamicRangeMinPermille: 450 },
		light: { minTlBrPermille: 10 },
	},
	bottle: {
		limits: { minLevels: 7, maxLevels: 11, dynamicRangeMinPermille: 550 },
		light: { minTlBrPermille: -50 },
	},
	book: {
		limits: { minLevels: 8, maxLevels: 12, dynamicRangeMinPermille: 500 },
		light: { minTlBrPermille: -50 },
	},
	scroll_paper: {
		limits: { minLevels: 8, maxLevels: 11, dynamicRangeMinPermille: 500 },
		light: { minTlBrPermille: 0 },
	},
	talisman: {
		limits: { minLevels: 10, maxLevels: 16, dynamicRangeMinPermille: 600 },
		light: { minTlBrPermille: -100 },
	},
};

export const STYLE_PRESETS: Record<StylePresetId, StylePresetDefinition> = {
	vanilla: {
		id: "vanilla",
		name: "原版風",
		description: "貼近原版的色階與外框規則，基準風格。",
		outline: { ...DEFAULT_OUTLINE },
		light: { ...DEFAULT_LIGHT },
		limits: { ...DEFAULT_LIMITS },
		highlight: { ...DEFAULT_HIGHLIGHT },
		dither: { ...DEFAULT_DITHER },
		categoryOverrides: MEASURED_CATEGORY_OVERRIDES,
		palettes: PRESET_PALETTES.vanilla,
	},
	soft: {
		id: "soft",
		name: "柔光",
		description: "受光面省去硬邊、外框對比弱化的低對比語言。",
		outline: {
			...DEFAULT_OUTLINE,
			mode: "selective",
			luminanceDropPermille: 60,
			saturationRatioPermille: 880,
			maxHueOffsetDegrees: 25,
			darknessGapPermille: 40,
		},
		light: { ...DEFAULT_LIGHT, minTlBrPermille: 50 },
		limits: {
			...DEFAULT_LIMITS,
			maxColors: 16,
			minLevels: 8,
			maxLevels: 12,
			dynamicRangeMinPermille: 400,
		},
		highlight: { ...DEFAULT_HIGHLIGHT },
		dither: { ...DEFAULT_DITHER },
		categoryOverrides: {
			...MEASURED_CATEGORY_OVERRIDES,
			bottle: {
				limits: { minLevels: 7, maxLevels: 11, dynamicRangeMinPermille: 550 },
				light: { minTlBrPermille: 0 },
			},
			book: {
				limits: { minLevels: 8, maxLevels: 14, dynamicRangeMinPermille: 500 },
				light: { minTlBrPermille: -50 },
			},
			gem_crystal: {
				limits: {
					minLevels: 8,
					maxLevels: 12,
					dynamicRangeMinPermille: 750,
					requireMargin: true,
				},
				light: { minTlBrPermille: 70 },
			},
		},
		palettes: PRESET_PALETTES.soft,
	},
	"fairy-flat": {
		id: "fairy-flat",
		name: "童話平塗",
		description: "統一冷紫外框、平塗大色塊的高飽和語言。",
		outline: {
			...DEFAULT_OUTLINE,
			mode: "uniform",
			color: "#3B3160",
			maxHueOffsetDegrees: 180,
			snapFamilies: false,
		},
		light: { ...DEFAULT_LIGHT },
		limits: {
			...DEFAULT_LIMITS,
			maxColors: 12,
			minLevels: 8,
			maxLevels: 12,
			dynamicRangeMinPermille: 600,
			requireMargin: true,
			axisCheckCategories: [],
		},
		highlight: { ...DEFAULT_HIGHLIGHT },
		dither: { mode: "discourage", maxRatioPermille: 50 },
		categoryOverrides: {
			generic: {
				limits: {
					minLevels: 8,
					maxLevels: 12,
					dynamicRangeMinPermille: 600,
				},
			},
			rod_staff: { outline: { mode: "tinted" } },
			bottle: { light: { minTlBrPermille: 0 } },
		},
		palettes: PRESET_PALETTES["fairy-flat"],
	},
	"dark-frame": {
		id: "dark-frame",
		name: "暗黑重框",
		description: "更深外框、更寬明度範圍的高對比語言。",
		outline: {
			...DEFAULT_OUTLINE,
			luminanceDropPermille: 170,
			saturationRatioPermille: 900,
			maxHueOffsetDegrees: 15,
			darknessGapPermille: 120,
		},
		light: { ...DEFAULT_LIGHT },
		limits: {
			...DEFAULT_LIMITS,
			maxColors: 22,
			minLevels: 8,
			maxLevels: 16,
			dynamicRangeMinPermille: 700,
		},
		highlight: {
			...DEFAULT_HIGHLIGHT,
			maxPixels: 8,
			maxRatioPermille: 100,
		},
		dither: { ...DEFAULT_DITHER },
		categoryOverrides: {
			sword: {
				limits: { maxColors: 24, dynamicRangeMinPermille: 800 },
			},
			ingot: { limits: { maxColors: 24 } },
			gem_crystal: { highlight: { maxPixels: 10, maxRatioPermille: 120 } },
			round_fruit: { limits: { dynamicRangeMinPermille: 550 } },
		},
		palettes: PRESET_PALETTES["dark-frame"],
	},
};

/** Whether a value names one of the four builtin preset ids. */
export function isPresetId(value: string): value is StylePresetId {
	return (STYLE_PRESET_IDS as readonly string[]).includes(value);
}

/**
 * One preset as a full style document: every section carries its resolved
 * defaults, so the resolver can merge it into a chain like any file. Both
 * the direct preset lookup and an `extends: "<preset id>"` read the same
 * document, which keeps the two paths identical.
 */
export function presetDocument(id: StylePresetId): JsonObject {
	const preset = STYLE_PRESETS[id];
	const palettes: Record<string, FamilyRamp> = {};
	for (const [family, ramp] of Object.entries(preset.palettes)) {
		palettes[family] = { ...ramp };
	}
	return {
		formatVersion: STYLE_FORMAT_VERSION,
		id,
		name: preset.name,
		description: preset.description,
		palettes,
		outline: { ...DEFAULT_OUTLINE, ...preset.outline },
		light: { ...DEFAULT_LIGHT, ...preset.light },
		limits: {
			...DEFAULT_LIMITS,
			...preset.limits,
			axisCheckCategories: [
				...(preset.limits.axisCheckCategories ??
					DEFAULT_LIMITS.axisCheckCategories),
			],
		},
		highlight: { ...DEFAULT_HIGHLIGHT, ...preset.highlight },
		dither: { ...DEFAULT_DITHER, ...preset.dither },
		animation: { ...DEFAULT_ANIMATION },
		categoryOverrides: cloneJsonValue(preset.categoryOverrides),
	};
}

/** The four builtin presets in registry order, as list/show report them. */
export function listStylePresets(): StyleSummary[] {
	return STYLE_PRESET_IDS.map((id) => ({
		id,
		name: STYLE_PRESETS[id].name,
		description: STYLE_PRESETS[id].description,
	}));
}
