import type { PixelCanvas, RGBA } from "../core/types.ts";
import { flattenCanvas } from "../io/png.ts";
import { hsl255, truncatedDiv } from "../style/color.ts";

/**
 * Style measurement: the frozen integer metrics of the spec section 8.
 * Every value is an integer count, a permille, or null when there is
 * nothing to compare. This module measures only; it never reads a style,
 * never compares against a threshold, and never produces findings.
 */

/** Second-moment triple behind the main-axis classification (section 8.7). */
export interface StyleAxisMoments {
	varX: number;
	varY: number;
	cov: number;
}

/** Main-axis classification; there is no fifth "undetermined" value. */
export type StyleAxis = "horizontal" | "vertical" | "45" | "135";

/**
 * The frozen report fields (section 8.10). `analyze_asset` and the lint
 * report share this object so one measurement feeds both surfaces.
 */
export interface StyleMetrics {
	opaquePixels: number;
	colors: number;
	levels: number;
	dynamicRangePermille: number;
	tlBrPermille: number | null;
	coveragePermille: number;
	minMargin: number;
	outlinePixels: number;
	outlineGapPermille: number | null;
	outlineHueOffsetDegrees: number | null;
	bodyHueBin: number | null;
	outlineHueBin: number | null;
	highlightPixels: number | null;
	highlightRatioPermille: number | null;
	bufferRatioPermille: number | null;
	ditherPermille: number;
	axis: StyleAxis | null;
	axisMoments: StyleAxisMoments | null;
	firstFrameOnly: boolean;
}

export interface StyleMetricsOptions {
	/**
	 * True when the canvas is one frame of a taller animation strip, so the
	 * report can say it only measured the first frame.
	 */
	readonly firstFrameOnly?: boolean | undefined;
}

/** Every field at its neutral value: counts zero, permilles zero, nulls null. */
export function emptyStyleMetrics(
	options: StyleMetricsOptions = {},
): StyleMetrics {
	return {
		opaquePixels: 0,
		colors: 0,
		levels: 0,
		dynamicRangePermille: 0,
		tlBrPermille: null,
		coveragePermille: 0,
		minMargin: 0,
		outlinePixels: 0,
		outlineGapPermille: null,
		outlineHueOffsetDegrees: null,
		bodyHueBin: null,
		outlineHueBin: null,
		highlightPixels: null,
		highlightRatioPermille: null,
		bufferRatioPermille: null,
		ditherPermille: 0,
		axis: null,
		axisMoments: null,
		firstFrameOnly: options.firstFrameOnly === true,
	};
}

/** Hue-bin width in degrees (section 8.3): 36 bins cover 0..359. */
const HUE_BIN_COUNT = 36;
const DEGREES_PER_BIN = 360 / HUE_BIN_COUNT;

/** §8.3: below this saturation a pixel counts as neutral and has no hue. */
const MIN_SATURATION = 38;

/** §8.6: one lightness level of buffer below the brightest step, permille. */
const BUFFER_WINDOW = 100;

/**
 * §8.9: the lightness gap a dither window may span, measured on the §8.2
 * `L255` scale (0..255) where 38 is about 0.15 of the range.
 */
const DITHER_LIGHTNESS_GAP = 38;

/**
 * Measure one canvas with the section 8 formulas: relative luminance
 * permille, integer HSL, the 36-bin hue histogram, the inside-outline
 * cells, level count, dynamic range, TL-BR light direction, highlight and
 * buffer ratios, dither windows, margins, and the main-axis moments.
 *
 * `firstFrameOnly` measures the leading square frame of an animation strip:
 * a strip stacks equal square frames, so the first `width x width` block is
 * the first frame and nothing below it enters the numbers.
 */
export function measureStyleMetrics(
	canvas: PixelCanvas,
	options: StyleMetricsOptions = {},
): StyleMetrics {
	const firstFrameOnly = options.firstFrameOnly === true;
	const width = canvas.width;
	const height = firstFrameOnly
		? Math.min(canvas.height, width)
		: canvas.height;
	const flat = flattenCanvas(canvas);
	const pixels = width * height;
	const alphaAt = (x: number, y: number): number =>
		x < 0 || y < 0 || x >= width || y >= height
			? 0
			: (flat[(y * width + x) * 4 + 3] as number);
	const colorAt = (x: number, y: number): RGBA => {
		const offset = (y * width + x) * 4;
		return {
			r: flat[offset] as number,
			g: flat[offset + 1] as number,
			b: flat[offset + 2] as number,
			a: flat[offset + 3] as number,
		};
	};

	const opaque: number[] = [];
	const luminance: number[] = [];
	const levels = new Set<number>();
	const colors = new Set<string>();
	let minLightness = 1000;
	let maxLightness = 0;
	let minLeft = width;
	let minRight = width;
	let minTop = height;
	let minBottom = height;
	let sumX = 0;
	let sumY = 0;
	let sumXX = 0;
	let sumYY = 0;
	let sumXY = 0;
	let topLeftSum = 0;
	let topLeftCount = 0;
	let bottomRightSum = 0;
	let bottomRightCount = 0;
	const halfWidth = truncatedDiv(width, 2);
	const halfHeight = truncatedDiv(height, 2);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			if (alphaAt(x, y) !== 255) {
				continue;
			}
			const color = colorAt(x, y);
			const value = luminancePermille(color.r, color.g, color.b);
			opaque.push(y * width + x);
			luminance.push(value);
			levels.add(value);
			colors.add(`${color.r},${color.g},${color.b},${color.a}`);
			if (value < minLightness) {
				minLightness = value;
			}
			if (value > maxLightness) {
				maxLightness = value;
			}
			if (x < minLeft) {
				minLeft = x;
			}
			if (width - 1 - x < minRight) {
				minRight = width - 1 - x;
			}
			if (y < minTop) {
				minTop = y;
			}
			if (height - 1 - y < minBottom) {
				minBottom = height - 1 - y;
			}
			sumX += x;
			sumY += y;
			sumXX += x * x;
			sumYY += y * y;
			sumXY += x * y;
			if (x < halfWidth && y < halfHeight) {
				topLeftSum += value;
				topLeftCount += 1;
			}
			if (x >= halfWidth && y >= halfHeight) {
				bottomRightSum += value;
				bottomRightCount += 1;
			}
		}
	}

	const count = opaque.length;
	const empty: StyleMetrics = {
		...emptyStyleMetrics({ firstFrameOnly }),
		coveragePermille: pixels === 0 ? 0 : permille(0, pixels),
	};
	if (count === 0) {
		return empty;
	}

	// Inside-outline cells: opaque with at least one transparent or
	// out-of-frame 4-neighbour (section 8.4).
	const outlineBins = new Array<number>(HUE_BIN_COUNT).fill(0) as number[];
	const bodyBins = new Array<number>(HUE_BIN_COUNT).fill(0) as number[];
	let outlineCount = 0;
	let outlineSum = 0;
	let bodySum = 0;
	for (const [position, index] of opaque.entries()) {
		const x = index % width;
		const y = truncatedDiv(index, width);
		const isOutline =
			alphaAt(x - 1, y) !== 255 ||
			alphaAt(x + 1, y) !== 255 ||
			alphaAt(x, y - 1) !== 255 ||
			alphaAt(x, y + 1) !== 255;
		const bin = hueBin(colorAt(x, y));
		if (isOutline) {
			outlineCount += 1;
			outlineSum += luminance[position] as number;
			if (bin !== null) {
				outlineBins[bin] = (outlineBins[bin] ?? 0) + 1;
			}
		} else {
			bodySum += luminance[position] as number;
			if (bin !== null) {
				bodyBins[bin] = (bodyBins[bin] ?? 0) + 1;
			}
		}
	}

	const moments: StyleAxisMoments = {
		varX: count * sumXX - sumX * sumX,
		varY: count * sumYY - sumY * sumY,
		cov: count * sumXY - sumX * sumY,
	};

	let highlightPixels = 0;
	let bufferedHighlights = 0;
	for (const [position, index] of opaque.entries()) {
		if ((luminance[position] as number) !== maxLightness) {
			continue;
		}
		highlightPixels += 1;
		const x = index % width;
		const y = truncatedDiv(index, width);
		const neighbours = [
			[x - 1, y],
			[x + 1, y],
			[x, y - 1],
			[x, y + 1],
		] as const;
		for (const [nx, ny] of neighbours) {
			if (alphaAt(nx, ny) !== 255) {
				continue;
			}
			const value = luminancePermille(
				flat[(ny * width + nx) * 4] as number,
				flat[(ny * width + nx) * 4 + 1] as number,
				flat[(ny * width + nx) * 4 + 2] as number,
			);
			if (value >= maxLightness - BUFFER_WINDOW && value < maxLightness) {
				bufferedHighlights += 1;
				break;
			}
		}
	}

	let ditherWindows = 0;
	for (let y = 0; y + 1 < height; y += 1) {
		for (let x = 0; x + 1 < width; x += 1) {
			if (
				alphaAt(x, y) !== 255 ||
				alphaAt(x + 1, y) !== 255 ||
				alphaAt(x, y + 1) !== 255 ||
				alphaAt(x + 1, y + 1) !== 255
			) {
				continue;
			}
			const topLeft = colorAt(x, y);
			const topRight = colorAt(x + 1, y);
			const bottomLeft = colorAt(x, y + 1);
			const bottomRight = colorAt(x + 1, y + 1);
			if (
				sameColor(topLeft, bottomRight) &&
				sameColor(topRight, bottomLeft) &&
				!sameColor(topLeft, topRight) &&
				Math.abs(hsl255(topLeft).lightness - hsl255(topRight).lightness) <=
					DITHER_LIGHTNESS_GAP
			) {
				ditherWindows += 1;
			}
		}
	}

	const bodyHueBin = modeBin(bodyBins);
	const outlineHueBin = modeBin(outlineBins);
	return {
		opaquePixels: count,
		colors: colors.size,
		levels: levels.size,
		dynamicRangePermille: maxLightness - minLightness,
		tlBrPermille:
			topLeftCount === 0 || bottomRightCount === 0
				? null
				: truncatedDiv(topLeftSum, topLeftCount) -
					truncatedDiv(bottomRightSum, bottomRightCount),
		coveragePermille: permille(count, pixels),
		minMargin: Math.min(minLeft, minRight, minTop, minBottom),
		outlinePixels: outlineCount,
		outlineGapPermille:
			outlineCount === 0 || outlineCount === count
				? null
				: truncatedDiv(bodySum, count - outlineCount) -
					truncatedDiv(outlineSum, outlineCount),
		outlineHueOffsetDegrees:
			bodyHueBin === null || outlineHueBin === null
				? null
				: hueOffsetDegrees(outlineHueBin, bodyHueBin),
		bodyHueBin,
		outlineHueBin,
		highlightPixels,
		highlightRatioPermille: permille(highlightPixels, count),
		bufferRatioPermille: permille(bufferedHighlights, highlightPixels),
		ditherPermille: permille(ditherWindows, count),
		axis: classifyAxis(moments),
		axisMoments: moments,
		firstFrameOnly,
	};
}

/** §8.1 relative luminance permille; BT.709 weights on a 255 denominator. */
function luminancePermille(r: number, g: number, b: number): number {
	return truncatedDiv(2126 * r + 7152 * g + 722 * b, 2550);
}

/** Count over total in permille; a zero total never divides. */
function permille(count: number, total: number): number {
	return total === 0 ? 0 : truncatedDiv(count * 1000, total);
}

/** §8.2 hue in degrees, or null when the pixel has no hue to bin. */
function hueBin(color: RGBA): number | null {
	const { saturation, delta } = hsl255(color);
	if (delta === 0 || saturation < MIN_SATURATION) {
		return null;
	}
	const max = Math.max(color.r, color.g, color.b);
	const raw =
		max === color.r
			? truncatedDiv(60 * (color.g - color.b), delta)
			: max === color.g
				? 120 + truncatedDiv(60 * (color.b - color.r), delta)
				: 240 + truncatedDiv(60 * (color.r - color.g), delta);
	const degrees = ((raw % 360) + 360) % 360;
	return truncatedDiv(degrees, DEGREES_PER_BIN);
}

/** §8.3 mode of the hue histogram; a tie keeps the smaller bin. */
function modeBin(bins: readonly number[]): number | null {
	let best = -1;
	let bestCount = 0;
	for (const [bin, count] of bins.entries()) {
		if (count > bestCount) {
			best = bin;
			bestCount = count;
		}
	}
	return best < 0 || bestCount === 0 ? null : best;
}

/** §8.3 box-center hue distance in degrees, 0..180. */
function hueOffsetDegrees(left: number, right: number): number {
	const gap = Math.abs(left * DEGREES_PER_BIN - right * DEGREES_PER_BIN);
	return Math.min(gap, 360 - gap);
}

/** §8.7 classification from the second moments, in the frozen order. */
function classifyAxis(moments: StyleAxisMoments): StyleAxis {
	if (2 * Math.abs(moments.cov) <= Math.abs(moments.varX - moments.varY)) {
		return moments.varX >= moments.varY ? "horizontal" : "vertical";
	}
	return moments.cov >= 0 ? "135" : "45";
}

function sameColor(left: RGBA, right: RGBA): boolean {
	return (
		left.r === right.r &&
		left.g === right.g &&
		left.b === right.b &&
		left.a === right.a
	);
}
