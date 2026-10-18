/**
 * Frozen expectations for the style presets, transcribed from the pack
 * authoring spec tables (§2.9 preset parameters, §2.9.1 through §2.9.4
 * category overrides, §3.2 and §3.3 palette ramps).
 *
 * These tables are deliberately written out by hand instead of importing
 * the constants under `src/style`: a test that reads the same table the
 * implementation ships compares a value with itself and proves nothing, so
 * every expectation here is an independent copy of the spec row.
 */

/** Preset ids in registry order (§2.9). */
export const EXPECTED_PRESET_IDS = [
	"vanilla",
	"soft",
	"fairy-flat",
	"dark-frame",
];

/** Preset display names (§2.9). */
export const EXPECTED_PRESET_NAMES: Record<string, string> = {
	vanilla: "原版風",
	soft: "柔光",
	"fairy-flat": "童話平塗",
	"dark-frame": "暗黑重框",
};

/** The six ramp roles every resolved family carries, in ramp order (§3.1). */
export const EXPECTED_RAMP_ROLES = [
	"outline",
	"shadow",
	"dark",
	"base",
	"light",
	"highlight",
];

export interface ExpectedRamp {
	outline: string;
	shadow: string;
	dark: string;
	base: string;
	light: string;
	highlight: string;
}

export type ExpectedPalette = Record<string, ExpectedRamp>;

/** Measured vanilla ramps (§3.2). */
const VANILLA_RAMPS: ExpectedPalette = {
	iron: {
		outline: "#181818",
		shadow: "#444444",
		dark: "#6B6B6B",
		base: "#969696",
		light: "#BEBEBE",
		highlight: "#FFFFFF",
	},
	gold: {
		outline: "#3F2E0E",
		shadow: "#825D16",
		dark: "#DC9613",
		base: "#FAD64A",
		light: "#FDFF76",
		highlight: "#FFFFFF",
	},
	diamond: {
		outline: "#082520",
		shadow: "#0E3F36",
		dark: "#1E8A77",
		base: "#2BC7AC",
		light: "#33EBCB",
		highlight: "#A4FDF0",
	},
	netherite: {
		outline: "#231012",
		shadow: "#322727",
		dark: "#473E3F",
		base: "#5D565D",
		light: "#766A76",
		highlight: "#95867E",
	},
	copper: {
		outline: "#421C11",
		shadow: "#5F2C1C",
		dark: "#9C4E31",
		base: "#C15A36",
		light: "#E77C56",
		highlight: "#FC9982",
	},
	wood: {
		outline: "#20180A",
		shadow: "#372910",
		dark: "#594319",
		base: "#755821",
		light: "#866526",
		highlight: "#896727",
	},
	stone: {
		outline: "#212121",
		shadow: "#494949",
		dark: "#5A5A5A",
		base: "#787777",
		light: "#95918D",
		highlight: "#B3B1AF",
	},
	emerald: {
		outline: "#002D00",
		shadow: "#005300",
		dark: "#007B18",
		base: "#00AA2C",
		light: "#41F384",
		highlight: "#DBFFEB",
	},
	amethyst: {
		outline: "#54398A",
		shadow: "#6F4FAB",
		dark: "#8D6ACC",
		base: "#B38EF3",
		light: "#CFA0F3",
		highlight: "#FECBE6",
	},
	redstone: {
		outline: "#2D0000",
		shadow: "#410500",
		dark: "#5C0700",
		base: "#720000",
		light: "#AA0F01",
		highlight: "#FF0000",
	},
	lapis: {
		outline: "#052463",
		shadow: "#12408B",
		dark: "#1C53A8",
		base: "#345EC3",
		light: "#5A82E2",
		highlight: "#7497EA",
	},
	quartz: {
		outline: "#6F5D5A",
		shadow: "#897B73",
		dark: "#B3A091",
		base: "#D4CABA",
		light: "#E5DFD6",
		highlight: "#F7F5F2",
	},
};

/** Derived low-contrast ramps (§3.3 soft). */
const SOFT_RAMPS: ExpectedPalette = {
	iron: {
		outline: "#373737",
		shadow: "#5A5A5A",
		dark: "#7A7A7A",
		base: "#9B9B9B",
		light: "#BBBBBB",
		highlight: "#EFEFEF",
	},
	gold: {
		outline: "#77530F",
		shadow: "#B67B0C",
		dark: "#FFA908",
		base: "#FFDA4B",
		light: "#FDFF72",
		highlight: "#EFEFEF",
	},
	diamond: {
		outline: "#0C6354",
		shadow: "#0F7764",
		dark: "#16B89B",
		base: "#24E6C4",
		light: "#2DFFDA",
		highlight: "#96FFF0",
	},
	netherite: {
		outline: "#532025",
		shadow: "#523E3E",
		dark: "#605355",
		base: "#706770",
		light: "#857785",
		highlight: "#9E8E86",
	},
	copper: {
		outline: "#782B14",
		shadow: "#8F381D",
		dark: "#C2552C",
		base: "#DA5F33",
		light: "#F87A4E",
		highlight: "#FF9379",
	},
	wood: {
		outline: "#573E13",
		shadow: "#6D4D16",
		dark: "#8A631A",
		base: "#A2741E",
		light: "#B17F21",
		highlight: "#B28022",
	},
	stone: {
		outline: "#3E3E3E",
		shadow: "#5E5E5E",
		dark: "#6C6C6C",
		base: "#838383",
		light: "#9B9793",
		highlight: "#B3B1AF",
	},
	emerald: {
		outline: "#026D02",
		shadow: "#018A01",
		dark: "#01AA22",
		base: "#00D036",
		light: "#3DFF87",
		highlight: "#C3FFDE",
	},
	amethyst: {
		outline: "#6039AD",
		shadow: "#7853BD",
		dark: "#8F66D8",
		base: "#AD7DFE",
		light: "#CC8EFC",
		highlight: "#FFB6DC",
	},
	redstone: {
		outline: "#6D0202",
		shadow: "#7C0B01",
		dark: "#920C00",
		base: "#A40000",
		light: "#D01201",
		highlight: "#FF1616",
	},
	lapis: {
		outline: "#00349C",
		shadow: "#064DC0",
		dark: "#0E5DD6",
		base: "#3163DD",
		light: "#5282F2",
		highlight: "#6692F8",
	},
	quartz: {
		outline: "#836B67",
		shadow: "#95867D",
		dark: "#B9A391",
		base: "#D3C5B1",
		light: "#E0D7CA",
		highlight: "#EDE8E1",
	},
};

/** Derived flat-shaded ramps with one shared outline color (§3.3). */
const FAIRY_FLAT_RAMPS: ExpectedPalette = {
	iron: {
		outline: "#3B3160",
		shadow: "#444444",
		dark: "#6B6B6B",
		base: "#969696",
		light: "#BEBEBE",
		highlight: "#FFFFFF",
	},
	gold: {
		outline: "#3B3160",
		shadow: "#895F0F",
		dark: "#E99A06",
		base: "#FFD845",
		light: "#FDFF76",
		highlight: "#FFFFFF",
	},
	diamond: {
		outline: "#3B3160",
		shadow: "#0C4237",
		dark: "#18907B",
		base: "#21D1B2",
		light: "#27F7D3",
		highlight: "#A2FFF1",
	},
	netherite: {
		outline: "#3B3160",
		shadow: "#322727",
		dark: "#473E3F",
		base: "#5D565D",
		light: "#766A76",
		highlight: "#95867E",
	},
	copper: {
		outline: "#3B3160",
		shadow: "#632A18",
		dark: "#A24C2B",
		base: "#CA562D",
		light: "#F0784D",
		highlight: "#FF987F",
	},
	wood: {
		outline: "#3B3160",
		shadow: "#39290E",
		dark: "#5D4415",
		base: "#7A591C",
		light: "#8C6620",
		highlight: "#8F6821",
	},
	stone: {
		outline: "#3B3160",
		shadow: "#494949",
		dark: "#5A5A5A",
		base: "#777777",
		light: "#95918D",
		highlight: "#B2B1B0",
	},
	emerald: {
		outline: "#3B3160",
		shadow: "#015201",
		dark: "#017A19",
		base: "#00AA2C",
		light: "#35FF82",
		highlight: "#DBFFEB",
	},
	amethyst: {
		outline: "#3B3160",
		shadow: "#6E4AB0",
		dark: "#8C64D2",
		base: "#B288F9",
		light: "#CF9BF8",
		highlight: "#FFCAE6",
	},
	redstone: {
		outline: "#3B3160",
		shadow: "#400601",
		dark: "#5C0700",
		base: "#720000",
		light: "#AA0F01",
		highlight: "#FE0101",
	},
	lapis: {
		outline: "#3B3160",
		shadow: "#0B3F93",
		dark: "#1351B1",
		base: "#2B5BCC",
		light: "#527FEA",
		highlight: "#6C94F2",
	},
	quartz: {
		outline: "#3B3160",
		shadow: "#8A7B72",
		dark: "#B4A090",
		base: "#D5CAB9",
		light: "#E6DFD6",
		highlight: "#F7F5F2",
	},
};

/** Derived high-contrast ramps (§3.3 dark-frame). */
const DARK_FRAME_RAMPS: ExpectedPalette = {
	iron: {
		outline: "#131313",
		shadow: "#383838",
		dark: "#585858",
		base: "#7C7C7C",
		light: "#9D9D9D",
		highlight: "#D3D3D3",
	},
	gold: {
		outline: "#30240E",
		shadow: "#674B17",
		dark: "#AC7819",
		base: "#ECC220",
		light: "#F1F442",
		highlight: "#D3D3D3",
	},
	diamond: {
		outline: "#081C19",
		shadow: "#0E302A",
		dark: "#1E6C5E",
		base: "#2B9D89",
		light: "#20CCAE",
		highlight: "#67F2DE",
	},
	netherite: {
		outline: "#1A0E10",
		shadow: "#272121",
		dark: "#393434",
		base: "#4B474B",
		light: "#5F595F",
		highlight: "#7A6F69",
	},
	copper: {
		outline: "#341911",
		shadow: "#4A261A",
		dark: "#7B432E",
		base: "#994E33",
		light: "#D65D31",
		highlight: "#F06B4C",
	},
	wood: {
		outline: "#18130A",
		shadow: "#2B2110",
		dark: "#463618",
		base: "#5C4720",
		light: "#6A5124",
		highlight: "#6D5425",
	},
	stone: {
		outline: "#1B1B1B",
		shadow: "#3C3C3C",
		dark: "#4A4A4A",
		base: "#626262",
		light: "#7B7875",
		highlight: "#949290",
	},
	emerald: {
		outline: "#032203",
		shadow: "#044004",
		dark: "#065E18",
		base: "#088428",
		light: "#1BE367",
		highlight: "#90F8BF",
	},
	amethyst: {
		outline: "#47336D",
		shadow: "#5D4688",
		dark: "#7149B7",
		base: "#8E5CE4",
		light: "#AE6AE3",
		highlight: "#F587C1",
	},
	redstone: {
		outline: "#220303",
		shadow: "#310704",
		dark: "#480A04",
		base: "#590505",
		light: "#841309",
		highlight: "#C70C0C",
	},
	lapis: {
		outline: "#09204D",
		shadow: "#15366C",
		dark: "#1E4684",
		base: "#32519B",
		light: "#3664D0",
		highlight: "#4974D9",
	},
	quartz: {
		outline: "#5A4F4D",
		shadow: "#6F6661",
		dark: "#998473",
		base: "#B7A993",
		light: "#C5BAAA",
		highlight: "#D6CEC2",
	},
};

/** Twelve families per preset, in the frozen export order (§3.1). */
export const EXPECTED_PALETTES: Record<string, ExpectedPalette> = {
	vanilla: VANILLA_RAMPS,
	soft: SOFT_RAMPS,
	"fairy-flat": FAIRY_FLAT_RAMPS,
	"dark-frame": DARK_FRAME_RAMPS,
};

export const EXPECTED_FAMILY_ORDER = [
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
];

export interface ExpectedRules {
	outline: {
		mode: string;
		position: string;
		color: string | null;
		luminanceDropPermille: number;
		saturationRatioPermille: number;
		maxHueOffsetDegrees: number;
		darknessGapPermille: number;
		snapFamilies: boolean;
	};
	light: { direction: string; minTlBrPermille: number };
	limits: {
		maxColors: number;
		minLevels: number;
		maxLevels: number;
		dynamicRangeMinPermille: number;
		requireMargin: boolean;
		axisCheckCategories: string[];
	};
	highlight: {
		minPixels: number;
		maxPixels: number;
		minRatioPermille: number;
		maxRatioPermille: number;
		bufferMinRatioPermille: number;
	};
	dither: { mode: string; maxRatioPermille: number };
	animation: {
		timelinePreset: string;
		frametime: number;
		holdTicks: number;
		sweepFrames: number;
		sweepAngleDegrees: number;
		sweepWidthPixels: number;
		sweepColor: string;
		interpolate: boolean;
	};
}

/**
 * Resolved rule values per preset (§2.9). The three parameters the spec
 * marks inapplicable for the uniform-outline preset keep their documented
 * defaults, since `mode: uniform` never reads them.
 */
export const EXPECTED_RULES: Record<string, ExpectedRules> = {
	vanilla: {
		outline: {
			mode: "tinted",
			position: "inside",
			color: null,
			luminanceDropPermille: 120,
			saturationRatioPermille: 1000,
			maxHueOffsetDegrees: 5,
			darknessGapPermille: 50,
			snapFamilies: true,
		},
		light: { direction: "top-left", minTlBrPermille: 30 },
		limits: {
			maxColors: 13,
			minLevels: 6,
			maxLevels: 16,
			dynamicRangeMinPermille: 450,
			requireMargin: false,
			axisCheckCategories: ["sword", "pickaxe", "axe", "hoe", "rod_staff"],
		},
		highlight: {
			minPixels: 1,
			maxPixels: 6,
			minRatioPermille: 10,
			maxRatioPermille: 80,
			bufferMinRatioPermille: 400,
		},
		dither: { mode: "allow", maxRatioPermille: 150 },
		animation: {
			timelinePreset: "hold-and-sweep",
			frametime: 1,
			holdTicks: 100,
			sweepFrames: 10,
			sweepAngleDegrees: 135,
			sweepWidthPixels: 1,
			sweepColor: "#FFFFFF",
			interpolate: false,
		},
	},
	soft: {
		outline: {
			mode: "selective",
			position: "inside",
			color: null,
			luminanceDropPermille: 60,
			saturationRatioPermille: 880,
			maxHueOffsetDegrees: 25,
			darknessGapPermille: 40,
			snapFamilies: true,
		},
		light: { direction: "top-left", minTlBrPermille: 50 },
		limits: {
			maxColors: 16,
			minLevels: 8,
			maxLevels: 12,
			dynamicRangeMinPermille: 400,
			requireMargin: false,
			axisCheckCategories: ["sword", "pickaxe", "axe", "hoe", "rod_staff"],
		},
		highlight: {
			minPixels: 1,
			maxPixels: 6,
			minRatioPermille: 10,
			maxRatioPermille: 80,
			bufferMinRatioPermille: 400,
		},
		dither: { mode: "allow", maxRatioPermille: 150 },
		animation: {
			timelinePreset: "hold-and-sweep",
			frametime: 1,
			holdTicks: 100,
			sweepFrames: 10,
			sweepAngleDegrees: 135,
			sweepWidthPixels: 1,
			sweepColor: "#FFFFFF",
			interpolate: false,
		},
	},
	"fairy-flat": {
		outline: {
			mode: "uniform",
			position: "inside",
			color: "#3B3160",
			luminanceDropPermille: 120,
			saturationRatioPermille: 1000,
			maxHueOffsetDegrees: 180,
			darknessGapPermille: 50,
			snapFamilies: false,
		},
		light: { direction: "top-left", minTlBrPermille: 30 },
		limits: {
			maxColors: 12,
			minLevels: 8,
			maxLevels: 12,
			dynamicRangeMinPermille: 600,
			requireMargin: true,
			axisCheckCategories: [],
		},
		highlight: {
			minPixels: 1,
			maxPixels: 6,
			minRatioPermille: 10,
			maxRatioPermille: 80,
			bufferMinRatioPermille: 400,
		},
		dither: { mode: "discourage", maxRatioPermille: 50 },
		animation: {
			timelinePreset: "hold-and-sweep",
			frametime: 1,
			holdTicks: 100,
			sweepFrames: 10,
			sweepAngleDegrees: 135,
			sweepWidthPixels: 1,
			sweepColor: "#FFFFFF",
			interpolate: false,
		},
	},
	"dark-frame": {
		outline: {
			mode: "tinted",
			position: "inside",
			color: null,
			luminanceDropPermille: 170,
			saturationRatioPermille: 900,
			maxHueOffsetDegrees: 15,
			darknessGapPermille: 120,
			snapFamilies: true,
		},
		light: { direction: "top-left", minTlBrPermille: 30 },
		limits: {
			maxColors: 22,
			minLevels: 8,
			maxLevels: 16,
			dynamicRangeMinPermille: 700,
			requireMargin: false,
			axisCheckCategories: ["sword", "pickaxe", "axe", "hoe", "rod_staff"],
		},
		highlight: {
			minPixels: 1,
			maxPixels: 8,
			minRatioPermille: 10,
			maxRatioPermille: 100,
			bufferMinRatioPermille: 400,
		},
		dither: { mode: "allow", maxRatioPermille: 150 },
		animation: {
			timelinePreset: "hold-and-sweep",
			frametime: 1,
			holdTicks: 100,
			sweepFrames: 10,
			sweepAngleDegrees: 135,
			sweepWidthPixels: 1,
			sweepColor: "#FFFFFF",
			interpolate: false,
		},
	},
};

export type ExpectedCategoryOverride = {
	outline?: Record<string, unknown>;
	light?: Record<string, unknown>;
	limits?: Record<string, unknown>;
	highlight?: Record<string, unknown>;
};

/** Measured per-category thresholds shared by vanilla and soft (§2.9.1). */
const MEASURED_CATEGORIES: Record<string, ExpectedCategoryOverride> = {
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

/** Per-category overrides per preset (§2.9.1 through §2.9.4). */
export const EXPECTED_CATEGORY_OVERRIDES: Record<
	string,
	Record<string, ExpectedCategoryOverride>
> = {
	vanilla: MEASURED_CATEGORIES,
	soft: {
		...MEASURED_CATEGORIES,
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
	"fairy-flat": {
		generic: {
			limits: { minLevels: 8, maxLevels: 12, dynamicRangeMinPermille: 600 },
		},
		rod_staff: { outline: { mode: "tinted" } },
		bottle: { light: { minTlBrPermille: 0 } },
	},
	"dark-frame": {
		sword: { limits: { maxColors: 24, dynamicRangeMinPermille: 800 } },
		ingot: { limits: { maxColors: 24 } },
		gem_crystal: { highlight: { maxPixels: 10, maxRatioPermille: 120 } },
		round_fruit: { limits: { dynamicRangeMinPermille: 550 } },
	},
};

/** Family ids in the completion cases (§3.4). */
export const COMPLETION_FAMILIES = {
	missingShadow: "gravel",
	twoLevels: "basalt",
	saturated: "crimson",
} as const;

/**
 * §3.4 rule 2 completion, transcribed from the amended rule: the shadow
 * step keeps the reference role's hue and saturation (dark, or base when the
 * family has no dark) and takes the truncated integer midpoint of the
 * outline and reference lightnesses. Both families are neutral so the
 * remaining steps reduce to their lightness factors alone.
 */
export const EXPECTED_SHADOW_COMPLETION: Record<
	string,
	{ given: Record<string, string>; completed: Record<string, string> }
> = {
	missingShadow: {
		given: { outline: "#404040", dark: "#909090", base: "#707070" },
		completed: {
			outline: "#404040",
			shadow: "#686868",
			dark: "#909090",
			base: "#707070",
			light: "#868686",
			highlight: "#AEAEAE",
		},
	},
	twoLevels: {
		given: { outline: "#303030", base: "#909090" },
		completed: {
			outline: "#303030",
			shadow: "#606060",
			dark: "#737373",
			base: "#909090",
			light: "#ACACAC",
			highlight: "#DFDFDF",
		},
	},
};

/**
 * §3.4 on a saturated family, so the rule 8 conversion to RGB is what these
 * expectations lock down. Source values follow §8.2: outline `#7F0000` is
 * L 63, S 255, H 0, delta 127; base `#FF0000` is L 127, S 255, H 0, delta
 * 255; light `#FF8080` is L 191, S 253, H 0, delta 127. `dark` is missing,
 * so rule 2 takes base as its reference role.
 *
 * ```text
 * rule 2 (shadow)     L' = (63 + 127) / 2 = 95,  S' = 255
 *                     delta' = (255 * (255 - abs(190 - 255))) / 255 = 190
 *                     r = 95 + ((255 - 127) * 190) / 255 = 190
 *                     g = 95 + ((0 - 127) * 190) / 255 = 95 - 94 = 1
 * rule 3 (dark)       L' = (127 * 80) / 100 = 101,  S' = 255
 *                     delta' = (255 * (255 - abs(202 - 255))) / 255 = 202
 *                     r = 101 + (128 * 202) / 255 = 202
 *                     g = 101 + ((-127) * 202) / 255 = 101 - 100 = 1
 * rule 5 (highlight)  L' = (191 * 130) / 100 = 248,  S' = (253 * 600) / 1000 = 151
 *                     delta' = (151 * (255 - abs(496 - 255))) / 255 = 8
 *                     r = 248 + ((255 - 191) * 8) / 127 = 252
 *                     g = 248 + ((128 - 191) * 8) / 127 = 248 - 3 = 245
 * ```
 *
 * The three derivations land on different truncated fractions, so the
 * channels are not a shared gray and the green channel really tests the
 * signed division.
 */
export const EXPECTED_SATURATED_COMPLETION: {
	given: Record<string, string>;
	completed: Record<string, string>;
} = {
	given: { outline: "#7F0000", base: "#FF0000", light: "#FF8080" },
	completed: {
		outline: "#7F0000",
		shadow: "#BE0101",
		dark: "#CA0101",
		base: "#FF0000",
		light: "#FF8080",
		highlight: "#FCF5F5",
	},
};

/** One ramp value by role name; the six keys are checked when authoring. */
function rampColor(ramp: ExpectedRamp, role: string): string {
	return (ramp as unknown as Record<string, string>)[role] as string;
}

/** The canonical `.mcpx` palette of one family (§3.5). */
export function expectedFamilyMcpx(styleId: string, family: string): string {
	const table = EXPECTED_PALETTES[styleId] as ExpectedPalette;
	const ramp = table[family] as ExpectedRamp;
	const symbols = ["A", "B", "C", "D", "E", "F"];
	const rows = EXPECTED_RAMP_ROLES.map(
		(role, index) =>
			`${symbols[index]} = ${rampColor(ramp, role)}FF role=${role}`,
	);
	return [
		"mcpx 1",
		"",
		"[canvas]",
		"width = 6",
		"height = 1",
		"",
		"[metadata]",
		"kind = palette",
		`name = ${styleId}-${family}`,
		"",
		"[palette]",
		". = #00000000",
		...rows,
		"",
		"[layer base]",
		"visible = true",
		"opacity = 1.000",
		"",
		"[grid]",
		symbols.join(""),
		"",
	].join("\n");
}

/** The palette entries `--family all` declares: family-major, role-minor. */
export function expectedAllPaletteEntries(
	styleId: string,
): { id: string; hex: string; role: string }[] {
	const entries: { id: string; hex: string; role: string }[] = [];
	const table = EXPECTED_PALETTES[styleId] as ExpectedPalette;
	for (const family of EXPECTED_FAMILY_ORDER) {
		const ramp = table[family] as ExpectedRamp;
		for (const role of EXPECTED_RAMP_ROLES) {
			entries.push({
				id: `${family}-${role}`,
				hex: rampColor(ramp, role),
				role,
			});
		}
	}
	return entries;
}
