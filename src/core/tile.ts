import { McAssetError } from "./errors.ts";
import { luminanceOf } from "./recolor.ts";
import type { RGBA } from "./types.ts";

/**
 * Tile engine: seam metrics, repetition scoring, edge/brightness matching,
 * and NxN repeat-preview synthesis over raw RGBA buffers.
 *
 * Pure and deterministic: integer pixel math only, row-major traversal,
 * fixed tie-breaks, no randomness, no transcendental functions, no
 * timestamps. Scores serialize to fixed six-decimal strings.
 */

/** Largest possible single-pair distance: 4 channels times 255 squared. */
export const TILE_PAIR_MAX_DISTANCE = 260100;

export type TileAxis = "horizontal" | "vertical" | "both";

export interface TileSeamScore {
	raw: number;
	pairs: number;
	score: number;
}

export interface TileSeamReport {
	horizontal: TileSeamScore;
	vertical: TileSeamScore;
	corner: TileSeamScore;
}

export interface TileRepetitionReport {
	score: number;
	periodX: number | null;
	periodY: number | null;
}

export interface TilePreview {
	pixels: Uint8Array;
	width: number;
	height: number;
}

function assertPixelBuffer(
	pixels: Uint8Array,
	width: number,
	height: number,
): void {
	if (
		!Number.isInteger(width) ||
		!Number.isInteger(height) ||
		width < 1 ||
		height < 1
	) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Tile width and height must be positive integers.",
			{ width, height },
		);
	}
	if (!(pixels instanceof Uint8Array) || pixels.length !== width * height * 4) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Pixel buffer length must equal width times height times 4 (RGBA).",
			{ length: (pixels as Uint8Array | undefined)?.length, width, height },
		);
	}
}

function offsetOf(width: number, x: number, y: number): number {
	return (y * width + x) * 4;
}

function squaredChannelDistance(
	pixels: Uint8Array,
	first: number,
	second: number,
): number {
	const dr = (pixels[first] as number) - (pixels[second] as number);
	const dg = (pixels[first + 1] as number) - (pixels[second + 1] as number);
	const db = (pixels[first + 2] as number) - (pixels[second + 2] as number);
	const da = (pixels[first + 3] as number) - (pixels[second + 3] as number);
	return dr * dr + dg * dg + db * db + da * da;
}

function seamScore(raw: number, pairs: number): TileSeamScore {
	return { raw, pairs, score: raw / (pairs * TILE_PAIR_MAX_DISTANCE) };
}

/**
 * Wrap seam metrics: vertical pairs the left and right edges, horizontal
 * pairs the top and bottom edges, corner pairs the two diagonal wraps.
 * A degenerate axis (length 1) compares each pixel with itself (distance
 * 0); corner always reports two diagonal pairs.
 */
export function seamMetrics(
	pixels: Uint8Array,
	width: number,
	height: number,
): TileSeamReport {
	assertPixelBuffer(pixels, width, height);
	let verticalRaw = 0;
	for (let y = 0; y < height; y += 1) {
		verticalRaw += squaredChannelDistance(
			pixels,
			offsetOf(width, width - 1, y),
			offsetOf(width, 0, y),
		);
	}
	let horizontalRaw = 0;
	for (let x = 0; x < width; x += 1) {
		horizontalRaw += squaredChannelDistance(
			pixels,
			offsetOf(width, x, height - 1),
			offsetOf(width, x, 0),
		);
	}
	const cornerRaw =
		squaredChannelDistance(
			pixels,
			offsetOf(width, 0, 0),
			offsetOf(width, width - 1, height - 1),
		) +
		squaredChannelDistance(
			pixels,
			offsetOf(width, width - 1, 0),
			offsetOf(width, 0, height - 1),
		);
	return {
		horizontal: seamScore(horizontalRaw, width),
		vertical: seamScore(verticalRaw, height),
		corner: seamScore(cornerRaw, 2),
	};
}

function axisSimilarity(
	pixels: Uint8Array,
	width: number,
	height: number,
	length: number,
	shiftedOffset: (x: number, y: number, shift: number) => number,
): { similarity: number; period: number } | null {
	if (length <= 1) {
		return null;
	}
	const count = width * height;
	let bestShift = 1;
	let bestTotal = Number.POSITIVE_INFINITY;
	for (let shift = 1; shift < length; shift += 1) {
		let total = 0;
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				total += squaredChannelDistance(
					pixels,
					offsetOf(width, x, y),
					shiftedOffset(x, y, shift),
				);
			}
		}
		if (total < bestTotal) {
			bestTotal = total;
			bestShift = shift;
		}
	}
	return {
		similarity: 1 - (bestTotal as number) / (count * TILE_PAIR_MAX_DISTANCE),
		period: bestShift,
	};
}

/**
 * Repetition scoring: each axis independently finds the wrap shift with
 * the smallest total self-distance (ties keep the smallest shift); the
 * overall score is the strongest axis similarity, or 0 with null periods
 * when neither axis has a candidate. Lower means less repetition.
 */
export function repetitionScore(
	pixels: Uint8Array,
	width: number,
	height: number,
): TileRepetitionReport {
	assertPixelBuffer(pixels, width, height);
	const alongX = axisSimilarity(pixels, width, height, width, (x, y, shift) =>
		offsetOf(width, (x + shift) % width, y),
	);
	const alongY = axisSimilarity(pixels, width, height, height, (x, y, shift) =>
		offsetOf(width, x, (y + shift) % height),
	);
	const candidates = [alongX, alongY].filter(
		(entry): entry is { similarity: number; period: number } => entry !== null,
	);
	if (candidates.length === 0) {
		return { score: 0, periodX: null, periodY: null };
	}
	let best = candidates[0] as { similarity: number; period: number };
	for (const candidate of candidates) {
		if (candidate.similarity > best.similarity) {
			best = candidate;
		}
	}
	return {
		score: best.similarity,
		periodX: alongX === null ? null : alongX.period,
		periodY: alongY === null ? null : alongY.period,
	};
}

/** Fixed six-decimal serialization for seam and repetition scores. */
export function formatTileScore(score: number): string {
	const scaled = Math.min(1000000, Math.max(0, Math.round(score * 1000000)));
	const whole = Math.floor(scaled / 1000000);
	const fraction = scaled - whole * 1000000;
	return `${whole}.${String(fraction).padStart(6, "0")}`;
}

function floorAverage(first: number, second: number): number {
	return Math.floor(((first as number) + (second as number)) / 2);
}

function clampChannel(value: number): number {
	if (value < 0) {
		return 0;
	}
	if (value > 255) {
		return 255;
	}
	return value;
}

/**
 * Edge matching: set both boundary lines of the selected seam to the
 * per-channel floor average, so the two lines become byte-equal and that
 * axis seam distance drops to zero. `both` runs vertical first, then
 * horizontal, in a fixed order.
 */
export function applyEdgeMatch(
	pixels: Uint8Array,
	width: number,
	height: number,
	axis: TileAxis,
): Uint8Array {
	assertPixelBuffer(pixels, width, height);
	const out = new Uint8Array(pixels.length);
	out.set(pixels);
	if (axis === "vertical" || axis === "both") {
		for (let y = 0; y < height; y += 1) {
			const left = offsetOf(width, 0, y);
			const right = offsetOf(width, width - 1, y);
			for (let channel = 0; channel < 4; channel += 1) {
				const average = floorAverage(
					out[left + channel] as number,
					out[right + channel] as number,
				);
				out[left + channel] = average;
				out[right + channel] = average;
			}
		}
	}
	if (axis === "horizontal" || axis === "both") {
		for (let x = 0; x < width; x += 1) {
			const top = offsetOf(width, x, 0);
			const bottom = offsetOf(width, x, height - 1);
			for (let channel = 0; channel < 4; channel += 1) {
				const average = floorAverage(
					out[top + channel] as number,
					out[bottom + channel] as number,
				);
				out[top + channel] = average;
				out[bottom + channel] = average;
			}
		}
	}
	return out;
}

function lineLuminanceAverage(pixels: Uint8Array, offsets: number[]): number {
	let total = 0;
	for (const offset of offsets) {
		const color: RGBA = {
			r: pixels[offset] as number,
			g: pixels[offset + 1] as number,
			b: pixels[offset + 2] as number,
			a: pixels[offset + 3] as number,
		};
		total += luminanceOf(color);
	}
	return Math.floor(total / offsets.length);
}

function liftLineRgb(
	pixels: Uint8Array,
	offsets: number[],
	amount: number,
): void {
	for (const offset of offsets) {
		pixels[offset] = clampChannel((pixels[offset] as number) + amount);
		pixels[offset + 1] = clampChannel((pixels[offset + 1] as number) + amount);
		pixels[offset + 2] = clampChannel((pixels[offset + 2] as number) + amount);
	}
}

/**
 * Brightness matching: align the average integer luminance of the two
 * boundary lines by lifting the dimmer line's RGB (clamped, alpha kept).
 * This aligns the average brightness step only; it does not promise a
 * lower seam score. `both` runs vertical first, then horizontal.
 */
export function applyBrightnessMatch(
	pixels: Uint8Array,
	width: number,
	height: number,
	axis: TileAxis,
): Uint8Array {
	assertPixelBuffer(pixels, width, height);
	const out = new Uint8Array(pixels.length);
	out.set(pixels);
	if (axis === "vertical" || axis === "both") {
		const left: number[] = [];
		const right: number[] = [];
		for (let y = 0; y < height; y += 1) {
			left.push(offsetOf(width, 0, y));
			right.push(offsetOf(width, width - 1, y));
		}
		const delta =
			lineLuminanceAverage(out, left) - lineLuminanceAverage(out, right);
		if (delta > 0) {
			liftLineRgb(out, right, delta);
		} else if (delta < 0) {
			liftLineRgb(out, left, -delta);
		}
	}
	if (axis === "horizontal" || axis === "both") {
		const top: number[] = [];
		const bottom: number[] = [];
		for (let x = 0; x < width; x += 1) {
			top.push(offsetOf(width, x, 0));
			bottom.push(offsetOf(width, x, height - 1));
		}
		const delta =
			lineLuminanceAverage(out, top) - lineLuminanceAverage(out, bottom);
		if (delta > 0) {
			liftLineRgb(out, bottom, delta);
		} else if (delta < 0) {
			liftLineRgb(out, top, -delta);
		}
	}
	return out;
}

/**
 * Apply the explicit corrections in the frozen order (edge first, then
 * brightness) and record the applied steps. Without corrections the
 * pixels come back verbatim.
 */
export function applyTileCorrections(
	pixels: Uint8Array,
	width: number,
	height: number,
	edge: TileAxis | undefined,
	brightness: TileAxis | undefined,
): { pixels: Uint8Array; corrections: string[] } {
	assertPixelBuffer(pixels, width, height);
	let current: Uint8Array = new Uint8Array(pixels.length);
	current.set(pixels);
	const corrections: string[] = [];
	if (edge !== undefined) {
		current = applyEdgeMatch(current, width, height, edge);
		corrections.push(`edge-match:${edge}`);
	}
	if (brightness !== undefined) {
		current = applyBrightnessMatch(current, width, height, brightness);
		corrections.push(`brightness-match:${brightness}`);
	}
	return { pixels: current, corrections };
}

/** NxN repeat preview: tile the single cell 1:1 with no scaling. */
export function buildTilePreview(
	pixels: Uint8Array,
	width: number,
	height: number,
	times: number,
): TilePreview {
	assertPixelBuffer(pixels, width, height);
	if (!Number.isInteger(times) || times < 1) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Preview repeat must be a positive integer.",
			{ value: times },
		);
	}
	const outWidth = width * times;
	const outHeight = height * times;
	const out = new Uint8Array(outWidth * outHeight * 4);
	for (let y = 0; y < outHeight; y += 1) {
		for (let x = 0; x < outWidth; x += 1) {
			const from = offsetOf(width, x % width, y % height);
			const to = offsetOf(outWidth, x, y);
			out[to] = pixels[from] as number;
			out[to + 1] = pixels[from + 1] as number;
			out[to + 2] = pixels[from + 2] as number;
			out[to + 3] = pixels[from + 3] as number;
		}
	}
	return { pixels: out, width: outWidth, height: outHeight };
}

/** Frozen preview sizes: only 2x2, 4x4, and 8x8 repeat. */
export function parsePreviewSize(raw: string): 2 | 4 | 8 {
	if (raw === "2x2") {
		return 2;
	}
	if (raw === "4x4") {
		return 4;
	}
	if (raw === "8x8") {
		return 8;
	}
	throw new McAssetError(
		"INVALID_ARGUMENT",
		"--preview must be one of 2x2, 4x4, 8x8.",
		{ value: raw },
	);
}

/** Frozen correction axes: horizontal, vertical, or both. */
export function parseTileAxis(raw: string, flag: string): TileAxis {
	if (raw === "horizontal" || raw === "vertical" || raw === "both") {
		return raw;
	}
	throw new McAssetError(
		"INVALID_ARGUMENT",
		`${flag} must be one of horizontal, vertical, both.`,
		{ value: raw },
	);
}
