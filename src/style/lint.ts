import type { StyleMetrics } from "../analyze/style-metrics.ts";
import { measureStyleMetrics } from "../analyze/style-metrics.ts";
import type { PixelCanvas } from "../core/types.ts";
import type {
	ResolvedStyle,
	StyleCategoryId,
	StyleDitherRules,
	StyleHighlightRules,
	StyleLightRules,
	StyleLimitRules,
	StyleOutlineRules,
} from "./types.ts";
import { CATEGORY_IDS } from "./types.ts";

/**
 * Style check: measurement plus judgment against one resolved style.
 * The findings, their levels, and the report shape are the frozen spec
 * section 9; measurement itself lives in `src/analyze/style-metrics.ts`
 * and never reads a style.
 *
 * Every finding is a warning except `STYLE_COLOR_BUDGET`, the only check
 * that may turn a report into `fail`. The three `STYLE_FAMILY_*` codes of
 * section 9.1 belong to the multi-asset family audit, not to this report.
 */

/** Finding codes this report can produce (spec section 9.1). */
export const STYLE_FINDING_CODES = [
	"STYLE_LIGHT_DIRECTION",
	"STYLE_OUTLINE_DARKNESS",
	"STYLE_OUTLINE_HUE",
	"STYLE_LEVELS_TOO_FEW",
	"STYLE_LEVELS_TOO_MANY",
	"STYLE_DYNAMIC_RANGE",
	"STYLE_HIGHLIGHT_COUNT",
	"STYLE_HIGHLIGHT_ISOLATED",
	"STYLE_DITHER",
	"STYLE_COLOR_BUDGET",
	"STYLE_MARGIN_TOUCH",
	"STYLE_AXIS_ANGLE",
] as const;

export type StyleFindingCode = (typeof STYLE_FINDING_CODES)[number];

export type StyleFindingLevel = "error" | "warning";

/** One finding: code, level, the compared numbers, and how to fix it. */
export interface StyleFinding {
	code: StyleFindingCode;
	level: StyleFindingLevel;
	measured: number;
	threshold: number;
	message: string;
	suggestion: string;
}

/** A metric that had nothing to compare, with the reason it was dropped. */
export interface StyleSkipped {
	reason: string;
	detail: string;
}

export type StyleLintVerdict = "pass" | "warnings" | "fail";

/** The frozen report shape of spec section 9.2. */
export interface StyleLintReport {
	mode: "lint";
	path: string;
	style: string;
	category: string | null;
	metrics: StyleMetrics;
	findings: StyleFinding[];
	skipped: StyleSkipped[];
	verdict: StyleLintVerdict;
}

export interface StyleLintInput {
	readonly canvas: PixelCanvas;
	/** Reported as `path`; the input file is never rewritten. */
	readonly path: string;
	readonly style: ResolvedStyle;
	/** Category id, or null when the caller did not classify the asset. */
	readonly category?: string | null | undefined;
	readonly firstFrameOnly?: boolean | undefined;
}

/** The five rule sections a check compares against, after category merge. */
export interface StyleThresholds {
	readonly outline: StyleOutlineRules;
	readonly light: StyleLightRules;
	readonly limits: StyleLimitRules;
	readonly highlight: StyleHighlightRules;
	readonly dither: StyleDitherRules;
}

/**
 * Effective thresholds for one asset: the category override wins over the
 * style-wide section, which wins over the builtin preset already folded
 * into the resolved style. Without a category every category-scoped rule
 * is simply not run, which the report shows through its category field.
 */
export function resolveStyleThresholds(
	style: ResolvedStyle,
	category?: string | null,
): StyleThresholds {
	const override =
		category === undefined || category === null
			? undefined
			: style.categoryOverrides[category];
	return {
		outline: { ...style.outline, ...(override?.outline ?? {}) },
		light: { ...style.light, ...(override?.light ?? {}) },
		limits: { ...style.limits, ...(override?.limits ?? {}) },
		highlight: { ...style.highlight, ...(override?.highlight ?? {}) },
		dither: { ...style.dither, ...(override?.dither ?? {}) },
	};
}

/** Category ids a caller may pass, in registry order. */
export function isStyleCategoryId(value: string): value is StyleCategoryId {
	return (CATEGORY_IDS as readonly string[]).includes(value);
}

/**
 * Measure one canvas and compare it against one style: light direction,
 * outline darkness and hue, level count, dynamic range, highlight count and
 * buffer, dither policy, color budget, margin, and main axis. A metric with
 * nothing to compare produces no finding and a `skipped` entry instead.
 */
export function lintStyle(input: StyleLintInput): StyleLintReport {
	const firstFrameOnly = input.firstFrameOnly === true;
	const metrics = measureStyleMetrics(input.canvas, { firstFrameOnly });
	const category = input.category ?? null;
	const limits = resolveStyleThresholds(input.style, input.category);
	const findings: StyleFinding[] = [];
	const skipped: StyleSkipped[] = [];
	if (firstFrameOnly) {
		skipped.push({
			reason: "animation-first-frame-only",
			detail:
				"an animation strip is measured on its first frame; highlight and level rules judge that frame only.",
		});
	}
	if (metrics.opaquePixels === 0) {
		skipped.push({
			reason: "no-opaque-pixels",
			detail: "every metric needs at least one fully opaque pixel to compare.",
		});
		return {
			mode: "lint",
			path: input.path,
			style: input.style.id,
			category,
			metrics,
			findings,
			skipped,
			verdict: "pass",
		};
	}

	if (metrics.tlBrPermille === null) {
		skipped.push({
			reason: "no-light-quadrants",
			detail:
				"tlBrPermille needs opaque pixels in both the top-left and bottom-right quadrant.",
		});
	} else if (metrics.tlBrPermille < limits.light.minTlBrPermille) {
		findings.push(
			warning(
				"STYLE_LIGHT_DIRECTION",
				metrics.tlBrPermille,
				limits.light.minTlBrPermille,
				`tlBrPermille ${metrics.tlBrPermille} is below ${limits.light.minTlBrPermille}`,
				"move the highlight to the top-left edge and repaint the shaded side",
			),
		);
	}

	if (metrics.outlineGapPermille === null) {
		skipped.push({
			reason: "no-outline-comparison",
			detail:
				"outlineGapPermille needs both inside-outline pixels and interior pixels.",
		});
	} else if (metrics.outlineGapPermille < limits.outline.darknessGapPermille) {
		findings.push(
			warning(
				"STYLE_OUTLINE_DARKNESS",
				metrics.outlineGapPermille,
				limits.outline.darknessGapPermille,
				`outlineGapPermille ${metrics.outlineGapPermille} is below ${limits.outline.darknessGapPermille}`,
				"make the outline darker than the body, or lift the darkest body level",
			),
		);
	}

	if (limits.outline.mode === "uniform") {
		skipped.push({
			reason: "uniform-outline",
			detail:
				"a uniform outline color is intentionally a different hue, so the hue offset is measured but not judged.",
		});
	} else if (metrics.outlineHueBin === null || metrics.bodyHueBin === null) {
		skipped.push({
			reason: "no-effective-hue",
			detail:
				"the outline and the body both need a saturation of at least 38 to compare hues.",
		});
	} else if (
		(metrics.outlineHueOffsetDegrees ?? 0) > limits.outline.maxHueOffsetDegrees
	) {
		findings.push(
			warning(
				"STYLE_OUTLINE_HUE",
				metrics.outlineHueOffsetDegrees ?? 0,
				limits.outline.maxHueOffsetDegrees,
				`outlineHueOffsetDegrees ${metrics.outlineHueOffsetDegrees ?? 0} is above ${limits.outline.maxHueOffsetDegrees}`,
				"use a same-hue dark outline color instead of a foreign hue",
			),
		);
	}

	if (metrics.levels < limits.limits.minLevels) {
		findings.push(
			warning(
				"STYLE_LEVELS_TOO_FEW",
				metrics.levels,
				limits.limits.minLevels,
				`levels ${metrics.levels} is below ${limits.limits.minLevels}`,
				"add one mid lightness step instead of extra noise pixels",
			),
		);
	}
	if (metrics.levels > limits.limits.maxLevels) {
		findings.push(
			warning(
				"STYLE_LEVELS_TOO_MANY",
				metrics.levels,
				limits.limits.maxLevels,
				`levels ${metrics.levels} is above ${limits.limits.maxLevels}`,
				"merge neighbouring lightness steps",
			),
		);
	}

	if (metrics.dynamicRangePermille < limits.limits.dynamicRangeMinPermille) {
		findings.push(
			warning(
				"STYLE_DYNAMIC_RANGE",
				metrics.dynamicRangePermille,
				limits.limits.dynamicRangeMinPermille,
				`dynamicRangePermille ${metrics.dynamicRangePermille} is below ${limits.limits.dynamicRangeMinPermille}`,
				"widen the lightness span between the darkest and the brightest step",
			),
		);
	}

	const highlight = highlightFinding(metrics, limits.highlight);
	if (highlight !== undefined) {
		findings.push(highlight);
	}

	if (metrics.bufferRatioPermille === null) {
		skipped.push({
			reason: "no-highlight-buffer",
			detail: "the buffer ratio needs at least one brightest-level pixel.",
		});
	} else if (
		metrics.bufferRatioPermille < limits.highlight.bufferMinRatioPermille
	) {
		findings.push(
			warning(
				"STYLE_HIGHLIGHT_ISOLATED",
				metrics.bufferRatioPermille,
				limits.highlight.bufferMinRatioPermille,
				`bufferRatioPermille ${metrics.bufferRatioPermille} is below ${limits.highlight.bufferMinRatioPermille}`,
				"add a transition color beside the brightest pixels",
			),
		);
	}

	if (limits.dither.mode === "forbid") {
		if (metrics.ditherPermille > 0) {
			findings.push(
				warning(
					"STYLE_DITHER",
					metrics.ditherPermille,
					0,
					`ditherPermille ${metrics.ditherPermille} is above 0`,
					"replace the checker noise with flat color blocks",
				),
			);
		}
	} else if (
		limits.dither.mode === "discourage" &&
		metrics.ditherPermille > limits.dither.maxRatioPermille
	) {
		findings.push(
			warning(
				"STYLE_DITHER",
				metrics.ditherPermille,
				limits.dither.maxRatioPermille,
				`ditherPermille ${metrics.ditherPermille} is above ${limits.dither.maxRatioPermille}`,
				"replace the checker noise with flat color blocks",
			),
		);
	}

	if (metrics.colors > limits.limits.maxColors) {
		findings.push({
			code: "STYLE_COLOR_BUDGET",
			level: "error",
			measured: metrics.colors,
			threshold: limits.limits.maxColors,
			message: `colors ${metrics.colors} is above ${limits.limits.maxColors}`,
			suggestion: "merge colors until the asset stays inside the budget",
		});
	}

	if (limits.limits.requireMargin && metrics.minMargin === 0) {
		findings.push(
			warning(
				"STYLE_MARGIN_TOUCH",
				metrics.minMargin,
				1,
				`minMargin ${metrics.minMargin} is below 1`,
				"shrink the drawing so a transparent ring stays around it",
			),
		);
	}

	if (category === null) {
		skipped.push({
			reason: "no-category",
			detail:
				"the main-axis rule needs the item category; without one only the style-wide rules ran.",
		});
	} else if (
		limits.limits.axisCheckCategories.includes(category) &&
		(metrics.axis === "horizontal" || metrics.axis === "vertical")
	) {
		findings.push(
			warning(
				"STYLE_AXIS_ANGLE",
				0,
				45,
				`axis ${metrics.axis} keeps the main axis at 0 degrees, below 45`,
				"rotate the sprite so its main axis runs at 45 or 135 degrees",
			),
		);
	}

	return {
		mode: "lint",
		path: input.path,
		style: input.style.id,
		category,
		metrics,
		findings,
		skipped,
		verdict: verdictOf(findings),
	};
}

/**
 * The highlight rule covers four bounds; the first one the asset breaks is
 * the one reported, so measured and threshold always describe the same pair.
 */
function highlightFinding(
	metrics: StyleMetrics,
	highlight: StyleHighlightRules,
): StyleFinding | undefined {
	const pixels = metrics.highlightPixels;
	const ratio = metrics.highlightRatioPermille;
	if (pixels !== null && pixels < highlight.minPixels) {
		return warning(
			"STYLE_HIGHLIGHT_COUNT",
			pixels,
			highlight.minPixels,
			`highlightPixels ${pixels} is below ${highlight.minPixels}`,
			"add brightest-level pixels where the surface faces the light",
		);
	}
	if (pixels !== null && pixels > highlight.maxPixels) {
		return warning(
			"STYLE_HIGHLIGHT_COUNT",
			pixels,
			highlight.maxPixels,
			`highlightPixels ${pixels} is above ${highlight.maxPixels}`,
			"reduce the brightest-level pixels to the highlight budget",
		);
	}
	if (ratio !== null && ratio < highlight.minRatioPermille) {
		return warning(
			"STYLE_HIGHLIGHT_COUNT",
			ratio,
			highlight.minRatioPermille,
			`highlightRatioPermille ${ratio} is below ${highlight.minRatioPermille}`,
			"add brightest-level pixels until the share clears the floor",
		);
	}
	if (ratio !== null && ratio > highlight.maxRatioPermille) {
		return warning(
			"STYLE_HIGHLIGHT_COUNT",
			ratio,
			highlight.maxRatioPermille,
			`highlightRatioPermille ${ratio} is above ${highlight.maxRatioPermille}`,
			"shrink the brightest-level area until the share clears the ceiling",
		);
	}
	return undefined;
}

function warning(
	code: StyleFindingCode,
	measured: number,
	threshold: number,
	message: string,
	suggestion: string,
): StyleFinding {
	return { code, level: "warning", measured, threshold, message, suggestion };
}

/** `fail` needs an error-level finding; warnings alone stay `warnings`. */
function verdictOf(findings: readonly StyleFinding[]): StyleLintVerdict {
	if (findings.length === 0) {
		return "pass";
	}
	return findings.some((entry) => entry.level === "error")
		? "fail"
		: "warnings";
}
