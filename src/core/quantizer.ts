import { McAssetError } from "./errors.ts";
import type { RGBA } from "./types.ts";

/**
 * Integer median-cut quantizer. Pure and deterministic: same input bytes and
 * same `--colors` always produce the same palette and pixels on every
 * runtime. No transcendental functions, no randomness, no timestamps.
 *
 * Frozen rules (docs/v02-design.md "Quantizer"):
 * - Split plane: the widest integer channel range in the bucket. Channel
 *   scan order is r, g, b, a; the first strictly-widest channel wins ties.
 * - Cut point: median by pixel count; an even total takes the smaller side:
 *   target index `(total - 1) >> 1`, split after the bin holding it.
 * - Representative: per-channel integer average with round-half-up
 *   remainder rule (see averageChannel): base `sum // count`, plus one
 *   when `2 * remainder >= count`. All arithmetic stays integer-valued.
 * - Bucket priority and final palette order share one total order:
 *   pixel count descending, then representative r, g, b ascending, then
 *   the smallest pixel index inside the bucket ascending. Bucket member
 *   indices are unique, so the order never depends on sort stability or
 *   object key order.
 * - `--colors` at or above the distinct color count changes zero pixels:
 *   that path short-circuits to a verbatim copy in first-appearance order.
 * - `A = 0` pixels are data: hidden RGB joins the averages, and the
 *   zero-change path keeps hidden bytes verbatim.
 */

/** `--colors` lower bound: one representative color. */
export const QUANTIZE_MIN_COLORS = 1;

/** `--colors` upper bound: aligns with the tokenized .mcpx capacity. */
export const QUANTIZE_MAX_COLORS = 4096;

/** .mcpx target capacity for the quantized palette. */
export const MCPX_MAX_PALETTE_COLORS = 4096;

export interface QuantizeResult {
	/** Representative colors in the frozen bucket-priority order. */
	palette: RGBA[];
	/** Remapped pixels, same length as the input buffer. */
	pixels: Uint8Array;
	/** Per-pixel palette index, in input pixel order. */
	indices: Uint16Array;
	/** Number of representative colors (palette.length). */
	colorCount: number;
}

/**
 * Validate the `--colors` option. Missing, non-integer, or out-of-range
 * values are INVALID_ARGUMENT; 1-4096 passes through.
 */
export function validateColorsOption(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"--colors is required and must be an integer.",
			{ colors: value },
		);
	}
	if (value < QUANTIZE_MIN_COLORS || value > QUANTIZE_MAX_COLORS) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`--colors must be an integer in [${QUANTIZE_MIN_COLORS}, ${QUANTIZE_MAX_COLORS}].`,
			{ colors: value },
		);
	}
	return value;
}

/**
 * Guard for .mcpx targets: a palette above the tokenized capacity cannot be
 * written and reports MCPX_PALETTE_OVERFLOW with the actual count.
 */
export function assertMcpxPaletteCapacity(colorCount: number): void {
	if (!Number.isInteger(colorCount) || colorCount < 0) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Palette color count must be a non-negative integer.",
			{ colorCount },
		);
	}
	if (colorCount > MCPX_MAX_PALETTE_COLORS) {
		throw new McAssetError(
			"MCPX_PALETTE_OVERFLOW",
			"Palette exceeds the .mcpx color capacity.",
			{ colorCount, maxColors: MCPX_MAX_PALETTE_COLORS },
		);
	}
}

function assertPixelBuffer(pixels: Uint8Array): void {
	if (!(pixels instanceof Uint8Array) || pixels.length % 4 !== 0) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Pixel buffer length must be a multiple of 4 (RGBA).",
			{ length: (pixels as Uint8Array | undefined)?.length },
		);
	}
}

/** One distinct RGBA color: its tally and first pixel index. */
interface ColorBin {
	r: number;
	g: number;
	b: number;
	a: number;
	count: number;
	firstIndex: number;
}

interface Bucket {
	bins: ColorBin[];
	pixelCount: number;
	minIndex: number;
}

function colorKey(r: number, g: number, b: number, a: number): number {
	return r * 16777216 + g * 65536 + b * 256 + a;
}

function collectBins(pixels: Uint8Array): ColorBin[] {
	const byKey = new Map<number, ColorBin>();
	const bins: ColorBin[] = [];
	const total = pixels.length / 4;
	for (let i = 0; i < total; i += 1) {
		const base = i * 4;
		const r = pixels[base] as number;
		const g = pixels[base + 1] as number;
		const b = pixels[base + 2] as number;
		const a = pixels[base + 3] as number;
		const key = colorKey(r, g, b, a);
		const known = byKey.get(key);
		if (known !== undefined) {
			known.count += 1;
		} else {
			const bin: ColorBin = { r, g, b, a, count: 1, firstIndex: i };
			byKey.set(key, bin);
			bins.push(bin);
		}
	}
	return bins;
}

/**
 * Integer average with the frozen remainder rule: floor the quotient, then
 * add one when twice the remainder reaches the divisor (round half up).
 * Inputs are non-negative, so Math.floor is exact truncation here.
 */
function averageChannel(sum: number, count: number): number {
	const base = Math.floor(sum / count);
	const remainder = sum - base * count;
	return remainder * 2 >= count ? base + 1 : base;
}

function bucketAverage(bucket: Bucket): RGBA {
	let sumR = 0;
	let sumG = 0;
	let sumB = 0;
	let sumA = 0;
	for (const bin of bucket.bins) {
		sumR += bin.r * bin.count;
		sumG += bin.g * bin.count;
		sumB += bin.b * bin.count;
		sumA += bin.a * bin.count;
	}
	return {
		r: averageChannel(sumR, bucket.pixelCount),
		g: averageChannel(sumG, bucket.pixelCount),
		b: averageChannel(sumB, bucket.pixelCount),
		a: averageChannel(sumA, bucket.pixelCount),
	};
}

function makeBucket(bins: ColorBin[]): Bucket {
	let pixelCount = 0;
	let minIndex = Number.POSITIVE_INFINITY;
	for (const bin of bins) {
		pixelCount += bin.count;
		if (bin.firstIndex < minIndex) {
			minIndex = bin.firstIndex;
		}
	}
	return { bins, pixelCount, minIndex };
}

/**
 * Frozen total order for buckets: pixel count descending, representative
 * r/g/b ascending, smallest member pixel index ascending. Averages are
 * recomputed per comparison from integer sums, so the order is a pure
 * function of bucket contents.
 */
function compareBuckets(left: Bucket, right: Bucket): number {
	if (right.pixelCount !== left.pixelCount) {
		return right.pixelCount - left.pixelCount;
	}
	const leftAvg = bucketAverage(left);
	const rightAvg = bucketAverage(right);
	if (leftAvg.r !== rightAvg.r) {
		return leftAvg.r - rightAvg.r;
	}
	if (leftAvg.g !== rightAvg.g) {
		return leftAvg.g - rightAvg.g;
	}
	if (leftAvg.b !== rightAvg.b) {
		return leftAvg.b - rightAvg.b;
	}
	return left.minIndex - right.minIndex;
}

function channelValue(bin: ColorBin, channel: 0 | 1 | 2 | 3): number {
	if (channel === 0) {
		return bin.r;
	}
	if (channel === 1) {
		return bin.g;
	}
	if (channel === 2) {
		return bin.b;
	}
	return bin.a;
}

function compareColorFull(left: ColorBin, right: ColorBin): number {
	if (left.r !== right.r) {
		return left.r - right.r;
	}
	if (left.g !== right.g) {
		return left.g - right.g;
	}
	if (left.b !== right.b) {
		return left.b - right.b;
	}
	if (left.a !== right.a) {
		return left.a - right.a;
	}
	return left.firstIndex - right.firstIndex;
}

/**
 * Split one bucket on its widest channel at the pixel-count median.
 * Even totals take the smaller side: target `(total - 1) >> 1`.
 */
function splitBucket(bucket: Bucket): { left: Bucket; right: Bucket } {
	let channel: 0 | 1 | 2 | 3 = 0;
	let widest = -1;
	for (const candidate of [0, 1, 2, 3] as const) {
		let lo = 255;
		let hi = 0;
		for (const bin of bucket.bins) {
			const value = channelValue(bin, candidate);
			if (value < lo) {
				lo = value;
			}
			if (value > hi) {
				hi = value;
			}
		}
		if (hi - lo > widest) {
			widest = hi - lo;
			channel = candidate;
		}
	}
	const ordered = [...bucket.bins].sort((left, right) => {
		const byChannel =
			channelValue(left, channel) - channelValue(right, channel);
		return byChannel !== 0 ? byChannel : compareColorFull(left, right);
	});
	const target = (bucket.pixelCount - 1) >> 1;
	let cut = ordered.length - 2;
	let running = 0;
	for (let i = 0; i < ordered.length; i += 1) {
		running += (ordered[i] as ColorBin).count;
		if (running > target) {
			cut = i >= ordered.length - 1 ? ordered.length - 2 : i;
			break;
		}
	}
	const left = makeBucket(ordered.slice(0, cut + 1));
	const right = makeBucket(ordered.slice(cut + 1));
	return { left, right };
}

function squaredDistance(a: RGBA, b: RGBA): number {
	const dr = a.r - b.r;
	const dg = a.g - b.g;
	const db = a.b - b.b;
	const da = a.a - b.a;
	return dr * dr + dg * dg + db * db + da * da;
}

function nearestIndex(color: RGBA, palette: RGBA[]): number {
	let best = 0;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let i = 0; i < palette.length; i += 1) {
		const distance = squaredDistance(color, palette[i] as RGBA);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = i;
		}
	}
	return best;
}

/**
 * Reduce the buffer to at most `colors` representative colors with the
 * frozen integer median-cut. The input buffer is never mutated.
 */
export function quantizePixels(
	pixels: Uint8Array,
	colors: number,
): QuantizeResult {
	const limit = validateColorsOption(colors);
	assertPixelBuffer(pixels);
	const bins = collectBins(pixels);
	const total = pixels.length / 4;
	if (bins.length <= limit) {
		// Zero-change path: every distinct color survives verbatim, in
		// first-appearance order, so output bytes equal the input bytes.
		const palette = bins.map((bin) => ({
			r: bin.r,
			g: bin.g,
			b: bin.b,
			a: bin.a,
		}));
		const ordinal = new Map<number, number>();
		for (let i = 0; i < bins.length; i += 1) {
			const bin = bins[i] as ColorBin;
			ordinal.set(colorKey(bin.r, bin.g, bin.b, bin.a), i);
		}
		const indices = new Uint16Array(total);
		for (let i = 0; i < total; i += 1) {
			const base = i * 4;
			const key = colorKey(
				pixels[base] as number,
				pixels[base + 1] as number,
				pixels[base + 2] as number,
				pixels[base + 3] as number,
			);
			indices[i] = ordinal.get(key) as number;
		}
		return {
			palette,
			pixels: pixels.slice(),
			indices,
			colorCount: palette.length,
		};
	}
	let buckets: Bucket[] = [makeBucket(bins)];
	while (buckets.length < limit) {
		const ordered = [...buckets].sort(compareBuckets);
		const splittable = ordered.findIndex((bucket) => bucket.bins.length > 1);
		if (splittable === -1) {
			break;
		}
		const victim = ordered[splittable] as Bucket;
		const { left, right } = splitBucket(victim);
		ordered.splice(splittable, 1, left, right);
		buckets = ordered;
	}
	buckets.sort(compareBuckets);
	const palette = buckets.map((bucket) => bucketAverage(bucket));
	const representativeOf = new Map<number, number>();
	for (const bin of bins) {
		representativeOf.set(
			colorKey(bin.r, bin.g, bin.b, bin.a),
			nearestIndex(bin, palette),
		);
	}
	const out = new Uint8Array(pixels.length);
	const indices = new Uint16Array(total);
	for (let i = 0; i < total; i += 1) {
		const base = i * 4;
		const key = colorKey(
			pixels[base] as number,
			pixels[base + 1] as number,
			pixels[base + 2] as number,
			pixels[base + 3] as number,
		);
		const at = representativeOf.get(key) as number;
		indices[i] = at;
		const pick = palette[at] as RGBA;
		out[base] = pick.r;
		out[base + 1] = pick.g;
		out[base + 2] = pick.b;
		out[base + 3] = pick.a;
	}
	return { palette, pixels: out, indices, colorCount: palette.length };
}
