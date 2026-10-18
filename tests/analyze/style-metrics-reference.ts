import type {
	StyleAxis,
	StyleAxisMoments,
} from "../../src/analyze/style-metrics.ts";
import type { RGBA } from "../../src/core/types.ts";

/**
 * Independent reference implementation of the frozen style metrics, used
 * only to compute the expected numbers in the style-metric and lint cases.
 * It follows the spec formulas directly (relative luminance permille,
 * integer HSL, 36 hue bins, inside-outline cells, levels, TL-BR, highlight
 * and buffer ratios, dither windows, margins, axis moments) so a case never
 * compares a module against itself.
 */

const trunc = (value: number): number => Math.trunc(value);

export function luminancePermille(r: number, g: number, b: number): number {
	return trunc((2126 * r + 7152 * g + 722 * b) / 2550);
}

export interface ReferenceHsl {
	l: number;
	s: number;
	h: number;
	delta: number;
}

export function referenceHsl(color: RGBA): ReferenceHsl {
	const max = Math.max(color.r, color.g, color.b);
	const min = Math.min(color.r, color.g, color.b);
	const delta = max - min;
	const l = trunc((max + min) / 2);
	const s =
		delta === 0
			? 0
			: Math.min(255, trunc((delta * 255) / (255 - Math.abs(2 * l - 255))));
	const h =
		delta === 0
			? -1
			: trunc(
					max === color.r
						? (60 * (color.g - color.b)) / delta
						: max === color.g
							? 120 + (60 * (color.b - color.r)) / delta
							: 240 + (60 * (color.r - color.g)) / delta,
				);
	return { l, s, h: h < 0 ? ((h % 360) + 360) % 360 : h, delta };
}

/** Hue bin 0..35 for a hue, or null when the pixel has no effective hue. */
export function hueBin(color: RGBA): number | null {
	const hsl = referenceHsl(color);
	if (hsl.delta === 0 || hsl.s < 38) {
		return null;
	}
	return trunc(hsl.h / 10);
}

/** Box-center hue distance in degrees, 0..180. */
export function hueOffsetDegrees(left: number, right: number): number {
	const a = left * 10 + 5;
	const b = right * 10 + 5;
	const raw = Math.abs(a - b);
	return Math.min(raw, 360 - raw);
}

/** The 36-bin mode of a pixel set; ties take the smaller bin. */
export function hueModeBin(colors: readonly RGBA[]): number | null {
	const bins = new Array<number>(36).fill(0) as number[];
	for (const color of colors) {
		const bin = hueBin(color);
		if (bin !== null) {
			bins[bin] = (bins[bin] ?? 0) + 1;
		}
	}
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

export interface ReferenceMetrics {
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

function axisOf(moments: StyleAxisMoments): StyleAxis {
	if (2 * Math.abs(moments.cov) <= Math.abs(moments.varX - moments.varY)) {
		return moments.varX >= moments.varY ? "horizontal" : "vertical";
	}
	return moments.cov >= 0 ? "135" : "45";
}

/** Every frozen metric of the spec section 8.10 for one frame of pixels. */
export function referenceStyleMetrics(
	pixels: readonly RGBA[],
	width: number,
	height: number,
	firstFrameOnly = false,
): ReferenceMetrics {
	const total = width * height;
	const at = (x: number, y: number): RGBA | null => {
		if (x < 0 || y < 0 || x >= width || y >= height) {
			return null;
		}
		return pixels[y * width + x] ?? null;
	};
	const opaque: { x: number; y: number; color: RGBA; l: number }[] = [];
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const color = at(x, y) as RGBA;
			if (color.a === 255) {
				opaque.push({
					x,
					y,
					color,
					l: luminancePermille(color.r, color.g, color.b),
				});
			}
		}
	}
	const count = opaque.length;
	const distinct = new Set<string>();
	for (const pixel of opaque) {
		distinct.add(
			`${pixel.color.r},${pixel.color.g},${pixel.color.b},${pixel.color.a}`,
		);
	}
	const levels = new Set<number>();
	let minL = 1000;
	let maxL = 0;
	for (const pixel of opaque) {
		levels.add(pixel.l);
		minL = Math.min(minL, pixel.l);
		maxL = Math.max(maxL, pixel.l);
	}
	let tlSum = 0;
	let tlCount = 0;
	let brSum = 0;
	let brCount = 0;
	const halfWidth = trunc(width / 2);
	const halfHeight = trunc(height / 2);
	for (const pixel of opaque) {
		if (pixel.x < halfWidth && pixel.y < halfHeight) {
			tlSum += pixel.l;
			tlCount += 1;
		}
		if (pixel.x >= halfWidth && pixel.y >= halfHeight) {
			brSum += pixel.l;
			brCount += 1;
		}
	}
	let minLeft = width;
	let minRight = width;
	let minTop = height;
	let minBottom = height;
	for (const pixel of opaque) {
		minLeft = Math.min(minLeft, pixel.x);
		minRight = Math.min(minRight, width - 1 - pixel.x);
		minTop = Math.min(minTop, pixel.y);
		minBottom = Math.min(minBottom, height - 1 - pixel.y);
	}
	const minMargin =
		count === 0 ? 0 : Math.min(minLeft, minRight, minTop, minBottom);
	const isOutline = (x: number, y: number): boolean => {
		const center = at(x, y);
		if (center === null || center.a !== 255) {
			return false;
		}
		return (
			at(x - 1, y) === null ||
			at(x + 1, y) === null ||
			at(x, y - 1) === null ||
			at(x, y + 1) === null ||
			(at(x - 1, y) as RGBA | null)?.a !== 255 ||
			(at(x + 1, y) as RGBA | null)?.a !== 255 ||
			(at(x, y - 1) as RGBA | null)?.a !== 255 ||
			(at(x, y + 1) as RGBA | null)?.a !== 255
		);
	};
	const outlinePixels = opaque.filter((pixel) => isOutline(pixel.x, pixel.y));
	const body = opaque.filter((pixel) => !isOutline(pixel.x, pixel.y));
	const mean = (list: typeof opaque): number | null => {
		if (list.length === 0) {
			return null;
		}
		let sum = 0;
		for (const pixel of list) {
			sum += pixel.l;
		}
		return trunc(sum / list.length);
	};
	const outlineMean = mean(outlinePixels);
	const bodyMean = mean(body);
	const outlineHueBin = hueModeBin(outlinePixels.map((pixel) => pixel.color));
	const bodyHueBin = hueModeBin(body.map((pixel) => pixel.color));
	const highlightPixels =
		count === 0 ? null : opaque.filter((pixel) => pixel.l === maxL).length;
	let bufferRatioPermille: number | null = null;
	if (highlightPixels !== null && highlightPixels > 0) {
		let buffered = 0;
		for (const pixel of opaque) {
			if (pixel.l !== maxL) {
				continue;
			}
			const neighbors = [
				at(pixel.x - 1, pixel.y),
				at(pixel.x + 1, pixel.y),
				at(pixel.x, pixel.y - 1),
				at(pixel.x, pixel.y + 1),
			];
			const hasBuffer = neighbors.some((neighbor) => {
				if (neighbor === null || neighbor.a !== 255) {
					return false;
				}
				const value = luminancePermille(neighbor.r, neighbor.g, neighbor.b);
				return value >= maxL - 100 && value < maxL;
			});
			if (hasBuffer) {
				buffered += 1;
			}
		}
		bufferRatioPermille = trunc((buffered * 1000) / highlightPixels);
	}
	let ditherWindows = 0;
	for (let y = 0; y + 1 < height; y += 1) {
		for (let x = 0; x + 1 < width; x += 1) {
			const c00 = at(x, y) as RGBA;
			const c10 = at(x + 1, y) as RGBA;
			const c01 = at(x, y + 1) as RGBA;
			const c11 = at(x + 1, y + 1) as RGBA;
			if (c00.a !== 255 || c10.a !== 255 || c01.a !== 255 || c11.a !== 255) {
				continue;
			}
			const same = (a: RGBA, b: RGBA): boolean =>
				a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
			// Section 8.9 compares L255 lightness (0..255), so 38 is about
			// 0.15 of the range; the permille luminance of section 8.1 would
			// make the same gate mean 0.038.
			const left = referenceHsl(c00).l;
			const right = referenceHsl(c10).l;
			if (
				same(c00, c11) &&
				same(c10, c01) &&
				!same(c00, c10) &&
				Math.abs(left - right) <= 38
			) {
				ditherWindows += 1;
			}
		}
	}
	let sumX = 0;
	let sumY = 0;
	let sumXX = 0;
	let sumYY = 0;
	let sumXY = 0;
	for (const pixel of opaque) {
		sumX += pixel.x;
		sumY += pixel.y;
		sumXX += pixel.x * pixel.x;
		sumYY += pixel.y * pixel.y;
		sumXY += pixel.x * pixel.y;
	}
	const moments: StyleAxisMoments =
		count === 0
			? { varX: 0, varY: 0, cov: 0 }
			: {
					varX: count * sumXX - sumX * sumX,
					varY: count * sumYY - sumY * sumY,
					cov: count * sumXY - sumX * sumY,
				};
	return {
		opaquePixels: count,
		colors: distinct.size,
		levels: levels.size,
		dynamicRangePermille: count === 0 ? 0 : maxL - minL,
		tlBrPermille:
			tlCount === 0 || brCount === 0
				? null
				: trunc(tlSum / tlCount) - trunc(brSum / brCount),
		coveragePermille: total === 0 ? 0 : trunc((count * 1000) / total),
		minMargin,
		outlinePixels: outlinePixels.length,
		outlineGapPermille:
			outlineMean === null || bodyMean === null ? null : bodyMean - outlineMean,
		outlineHueOffsetDegrees:
			outlineHueBin === null || bodyHueBin === null
				? null
				: hueOffsetDegrees(outlineHueBin, bodyHueBin),
		bodyHueBin,
		outlineHueBin,
		highlightPixels,
		highlightRatioPermille:
			highlightPixels === null ? null : trunc((highlightPixels * 1000) / count),
		bufferRatioPermille,
		ditherPermille: count === 0 ? 0 : trunc((ditherWindows * 1000) / count),
		axis: count === 0 ? null : axisOf(moments),
		axisMoments: count === 0 ? null : moments,
		firstFrameOnly,
	};
}
