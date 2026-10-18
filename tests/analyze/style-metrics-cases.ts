import assert from "node:assert/strict";
import { analyzeCanvas } from "../../src/analyze/metrics.ts";
import {
	emptyStyleMetrics,
	measureStyleMetrics,
	type StyleMetrics,
} from "../../src/analyze/style-metrics.ts";
import type { PixelCanvas } from "../../src/core/types.ts";
import {
	animationStripCanvas,
	blankCanvas,
	checkerCanvas,
	gemCanvas,
	ingotCanvas,
	paintedCanvas,
	pixelsOf,
	rgba,
	singlePixelCanvas,
	solidCanvas,
	swordCanvas,
} from "./style-fixtures.ts";
import { referenceStyleMetrics } from "./style-metrics-reference.ts";

/**
 * Style measurement cases. Every expected number comes from the reference
 * implementation in `style-metrics-reference.ts`, which transcribes the spec
 * formulas independently of the module under test; the cases also pin the
 * values a reader can check by hand (counts, permilles, moments).
 */

interface MetricCase {
	name: string;
	run(): void | Promise<void>;
}

function measure(canvas: PixelCanvas, firstFrameOnly = false): StyleMetrics {
	return measureStyleMetrics(canvas, { firstFrameOnly });
}

function referenceOf(canvas: PixelCanvas, firstFrameOnly = false): unknown {
	return referenceStyleMetrics(
		pixelsOf(canvas),
		canvas.width,
		canvas.height,
		firstFrameOnly,
	);
}

/** Frozen metric field set of the spec section 8.10. */
const METRIC_KEYS = [
	"axis",
	"axisMoments",
	"bodyHueBin",
	"bufferRatioPermille",
	"colors",
	"coveragePermille",
	"ditherPermille",
	"dynamicRangePermille",
	"firstFrameOnly",
	"highlightPixels",
	"highlightRatioPermille",
	"levels",
	"minMargin",
	"opaquePixels",
	"outlineGapPermille",
	"outlineHueBin",
	"outlineHueOffsetDegrees",
	"outlinePixels",
	"tlBrPermille",
];

export const STYLE_METRIC_CASES: MetricCase[] = [
	{
		name: "a blade lit from the top left measures the frozen metrics",
		async run() {
			const canvas = swordCanvas({ highlightCorner: "top-left" });
			const metrics = measure(canvas);
			assert.deepEqual(metrics, referenceOf(canvas));
			assert.equal(metrics.opaquePixels, 144, "a 12x12 opaque square");
			assert.equal(metrics.levels, 7);
			assert.equal(metrics.coveragePermille, 562, "144 * 1000 / 256");
			assert.equal(metrics.minMargin, 2);
			assert.equal(metrics.dynamicRangePermille, 906);
			// Measured on this fixture: the quadrant averages come out at 245
			// and 433 with the four band colors drawn below.
			assert.equal(metrics.tlBrPermille, 245);
			assert.equal(metrics.outlineGapPermille, 433);
			assert.equal(metrics.highlightPixels, 2);
			assert.equal(metrics.highlightRatioPermille, 13);
			assert.equal(metrics.bufferRatioPermille, 500);
			assert.equal(
				metrics.outlineHueOffsetDegrees,
				null,
				"a neutral sprite has no hue bin",
			);
			assert.deepEqual(metrics.axisMoments, {
				varX: 247104,
				varY: 247104,
				cov: 0,
			});
			assert.equal(metrics.axis, "horizontal", "a symmetric square");
			assert.equal(metrics.ditherPermille, 0);
			assert.equal(metrics.firstFrameOnly, false);
		},
	},
	{
		name: "a blade lit from the bottom right flips the light direction",
		async run() {
			const canvas = swordCanvas({ highlightCorner: "bottom-right" });
			const metrics = measure(canvas);
			assert.deepEqual(metrics, referenceOf(canvas));
			assert.ok(
				(metrics.tlBrPermille ?? 0) < 0,
				`top-left minus bottom-right is negative: ${metrics.tlBrPermille}`,
			);
			assert.equal(metrics.highlightPixels, 2);
		},
	},
	{
		name: "a fully transparent image has nothing to compare",
		async run() {
			const canvas = blankCanvas(16, 16);
			const metrics = measure(canvas);
			assert.deepEqual(metrics, referenceOf(canvas));
			assert.notDeepEqual(
				metrics,
				measure(paintedCanvas(16, 16, () => rgba("#4C74B4"))),
				"a transparent canvas is not measured like an opaque one",
			);
			assert.equal(metrics.opaquePixels, 0);
			assert.equal(metrics.levels, 0);
			assert.equal(metrics.tlBrPermille, null);
			assert.equal(metrics.outlineGapPermille, null);
			assert.equal(metrics.highlightPixels, null);
			assert.equal(metrics.bufferRatioPermille, null);
			assert.equal(metrics.axis, null);
			assert.equal(metrics.axisMoments, null);
		},
	},
	{
		name: "a fully opaque sheet reports full coverage and a zero margin",
		async run() {
			const canvas = solidCanvas("#4C74B4", 32, 32);
			const metrics = measure(canvas);
			assert.deepEqual(metrics, referenceOf(canvas));
			assert.equal(metrics.opaquePixels, 1024);
			assert.equal(metrics.coveragePermille, 1000);
			assert.equal(metrics.minMargin, 0);
			assert.equal(metrics.levels, 1);
			assert.equal(metrics.dynamicRangePermille, 0);
			assert.equal(
				metrics.outlineGapPermille,
				0,
				"one tone inside and out, so the gap is zero",
			);
		},
	},
	{
		name: "a single-color sprite shares one hue bin across its outline and body",
		async run() {
			const canvas = solidCanvas("#4C74B4", 8, 8);
			const metrics = measure(canvas);
			assert.deepEqual(metrics, referenceOf(canvas));
			assert.equal(metrics.colors, 1);
			assert.equal(metrics.outlineGapPermille, 0);
			assert.equal(metrics.bodyHueBin, 21);
			assert.equal(metrics.outlineHueBin, 21);
			assert.equal(metrics.outlineHueOffsetDegrees, 0);
		},
	},
	{
		name: "a one pixel image measures one pixel and the neutral moments",
		async run() {
			const canvas = singlePixelCanvas();
			const metrics = measure(canvas);
			assert.deepEqual(metrics, referenceOf(canvas));
			assert.equal(metrics.opaquePixels, 1);
			assert.equal(metrics.coveragePermille, 1000);
			assert.equal(metrics.levels, 1);
			assert.equal(metrics.tlBrPermille, null, "no bottom-right quadrant");
			assert.equal(metrics.axis, "horizontal");
			assert.deepEqual(metrics.axisMoments, { varX: 0, varY: 0, cov: 0 });
		},
	},
	{
		name: "a checkerboard reports every window as dithering",
		async run() {
			const canvas = checkerCanvas();
			const metrics = measure(canvas);
			assert.deepEqual(metrics, referenceOf(canvas));
			assert.equal(metrics.ditherPermille, 878, "225 windows * 1000 / 256");
		},
	},
	{
		name: "a gem with a same-hue outline keeps both hue bins nearby",
		async run() {
			const canvas = gemCanvas("#0A1A36");
			const metrics = measure(canvas);
			assert.deepEqual(metrics, referenceOf(canvas));
			assert.ok(metrics.bodyHueBin !== null, "body hue bin");
			assert.ok(metrics.outlineHueBin !== null, "outline hue bin");
			assert.ok(
				(metrics.outlineHueOffsetDegrees ?? 999) <= 30,
				`same-hue outline stays nearby: ${metrics.outlineHueOffsetDegrees}`,
			);
			assert.ok((metrics.outlineGapPermille ?? 0) > 0, "darker outline ring");
		},
	},
	{
		name: "a gem with a black outline separates the hue bins",
		async run() {
			const canvas = gemCanvas("#000000");
			const metrics = measure(canvas);
			assert.deepEqual(metrics, referenceOf(canvas));
			assert.equal(metrics.outlineHueBin, null, "a neutral outline has no hue");
			assert.equal(
				metrics.outlineHueOffsetDegrees,
				null,
				"no outline hue means no offset to compare",
			);
		},
	},
	{
		name: "an ingot bar reports one level count per drawn step",
		async run() {
			const five = ingotCanvas(5);
			const nine = ingotCanvas(9);
			assert.equal(measure(five).levels, 5);
			assert.equal(measure(nine).levels, 9);
			assert.deepEqual(measure(five), referenceOf(five));
			assert.deepEqual(measure(nine), referenceOf(nine));
		},
	},
	{
		name: "an animation strip is measured as the first frame only",
		async run() {
			const frame = swordCanvas();
			const strip = animationStripCanvas(frame, 3);
			assert.equal(strip.height, 48);
			assert.deepEqual(
				measure(strip, true),
				referenceOf(frame, true),
				"the flag names the measured frame",
			);
			assert.equal(
				measure(strip).firstFrameOnly,
				false,
				"the flag comes from the caller, not the canvas",
			);
		},
	},
	{
		name: "the neutral metric block carries every frozen field",
		async run() {
			assert.deepEqual(
				Object.keys(emptyStyleMetrics()).sort(),
				[...METRIC_KEYS].sort(),
			);
			assert.notDeepEqual(
				measure(swordCanvas()),
				emptyStyleMetrics(),
				"a measured sprite never stays at the neutral block",
			);
			assert.equal(emptyStyleMetrics().firstFrameOnly, false);
			assert.equal(
				emptyStyleMetrics({ firstFrameOnly: true }).firstFrameOnly,
				true,
			);
		},
	},
	{
		name: "analyze reports the style metrics block beside the unchanged fields",
		async run() {
			const canvas = swordCanvas();
			const report = analyzeCanvas(canvas, { profile: "generic" });
			const metrics = report.styleMetrics as StyleMetrics;
			assert.ok(metrics !== undefined, "styleMetrics present");
			assert.deepEqual(Object.keys(metrics).sort(), [...METRIC_KEYS].sort());
			assert.deepEqual(metrics, referenceOf(canvas));
			assert.deepEqual(report.dimensions, { width: 16, height: 16 });
			assert.equal(report.totalPixels, 256);
			assert.deepEqual(Object.keys(report.alpha).sort(), [
				"opaquePixels",
				"opaqueRatio",
				"partialAlphaPixels",
				"partialAlphaRatio",
				"partialAlphaValues",
				"predictedClassification",
				"predictedNote",
				"transparentPixels",
				"transparentRatio",
			]);
		},
	},
	{
		name: "analyze marks a first frame only strip when the caller says so",
		async run() {
			const frame = swordCanvas();
			const strip = animationStripCanvas(frame, 2);
			const report = analyzeCanvas(strip, {
				profile: "generic",
				styleFirstFrameOnly: true,
			});
			assert.equal(report.styleMetrics?.firstFrameOnly, true);
			assert.deepEqual(
				report.styleMetrics,
				referenceOf(frame, true),
				"the strip and its first frame measure the same",
			);
		},
	},
];
