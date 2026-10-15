import { McAssetError } from "./errors.ts";
import { mapPixelsToPalette } from "./palette.ts";
import {
	type QuantizeResult,
	quantizePixels,
	validateColorsOption,
} from "./quantizer.ts";
import type { RGBA } from "./types.ts";

/**
 * Fixed-palette and reserved-color quantization.
 *
 * - Explicit-palette mapping is the shared palette.ts mapping: the integer
 *   sum of squared RGBA channel differences, with exact ties taking the
 *   earlier palette entry. Transparent pixels take part like any other
 *   color; hidden RGB is data and is never cleared.
 * - Reserved (keep) colors stay byte-identical (all four channels). In
 *   palette mode every reserved color must be an exact palette entry,
 *   whether or not the buffer contains it; otherwise INVALID_ARGUMENT.
 * - In colors mode only the deduplicated reserved colors actually present in
 *   the buffer consume the budget. Absent ones cost nothing, so the caller
 *   may pass every reserved color of the layer.
 * - The caller passes only the pixels in scope; canvas and selection stay
 *   outside this module.
 * - Palette results keep the complete declared palette order, including
 *   unused entries, and indices address that palette. Colors results use the
 *   deduplicated union of the active reserved colors and the median-cut
 *   representatives; colorCount is the union's length.
 * - Palette capacity is 4096 entries; an empty palette or anything above the
 *   cap is INVALID_ARGUMENT. colors+palette together is ARGUMENT_CONFLICT;
 *   neither is INVALID_ARGUMENT.
 */

export const QUANTIZE_PALETTE_MAX_COLORS = 4096;

export interface QuantizePaletteRequest {
	colors?: number | undefined;
	palette?: readonly RGBA[] | undefined;
	keepColors?: readonly RGBA[] | undefined;
}

export type ResolvedQuantizeRequest =
	| { kind: "colors"; colors: number; keepColors: RGBA[] }
	| { kind: "palette"; palette: RGBA[]; keepColors: RGBA[] };

function copyColor(color: RGBA): RGBA {
	return { r: color.r, g: color.g, b: color.b, a: color.a };
}

function colorKey(r: number, g: number, b: number, a: number): number {
	return r * 16777216 + g * 65536 + b * 256 + a;
}

function keyOf(color: RGBA): number {
	return colorKey(color.r, color.g, color.b, color.a);
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

function assertValidRGBA(color: unknown): asserts color is RGBA {
	const candidate = color as Partial<RGBA> | undefined;
	const channels: Array<number | undefined> = [
		candidate?.r,
		candidate?.g,
		candidate?.b,
		candidate?.a,
	];
	for (const channel of channels) {
		if (
			!Number.isInteger(channel) ||
			(channel as number) < 0 ||
			(channel as number) > 255
		) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"Each RGBA channel must be an integer in [0, 255].",
				{ color },
			);
		}
	}
}

function assertPaletteEntries(palette: readonly RGBA[]): void {
	if (palette.length === 0 || palette.length > QUANTIZE_PALETTE_MAX_COLORS) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Palette must hold 1 to ${QUANTIZE_PALETTE_MAX_COLORS} colors.`,
			{ colorCount: palette.length },
		);
	}
	for (const entry of palette) {
		assertValidRGBA(entry);
	}
}

/**
 * Palette mode accepts a reserved color only as an exact palette entry. The
 * check covers the whole reserved list, not just the colors that appear in
 * the buffer, so a bad entry fails the same way on every layer.
 */
function assertKeepsInPalette(
	keeps: readonly RGBA[],
	palette: readonly RGBA[],
): void {
	const paletteKeys = new Set<number>(palette.map(keyOf));
	for (const keep of keeps) {
		if (!paletteKeys.has(keyOf(keep))) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"Reserved color must sit inside the explicit palette.",
				{ color: keep },
			);
		}
	}
}

function readPixel(pixels: Uint8Array, index: number): RGBA {
	const base = index * 4;
	return {
		r: pixels[base] as number,
		g: pixels[base + 1] as number,
		b: pixels[base + 2] as number,
		a: pixels[base + 3] as number,
	};
}

function writePixel(pixels: Uint8Array, index: number, color: RGBA): void {
	const base = index * 4;
	pixels[base] = color.r;
	pixels[base + 1] = color.g;
	pixels[base + 2] = color.b;
	pixels[base + 3] = color.a;
}

/**
 * Parse one CLI `--keep-color r,g,b,a` value into an RGBA color.
 * Four comma-separated finite integers in [0, 255]; anything else is
 * INVALID_ARGUMENT.
 */
export function parseKeepColorOption(value: string): RGBA {
	if (typeof value !== "string") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"--keep-color must look like r,g,b,a with channels in [0, 255].",
			{ value },
		);
	}
	const parts = value.split(",");
	if (parts.length !== 4) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"--keep-color must look like r,g,b,a with channels in [0, 255].",
			{ value },
		);
	}
	const channels: number[] = [];
	for (const part of parts) {
		const text = part.trim();
		if (!/^[+-]?\d+$/.test(text)) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"--keep-color channels must be integers in [0, 255].",
				{ value },
			);
		}
		const channel = Number.parseInt(text, 10);
		if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"--keep-color channels must be integers in [0, 255].",
				{ value },
			);
		}
		channels.push(channel);
	}
	return {
		r: channels[0] as number,
		g: channels[1] as number,
		b: channels[2] as number,
		a: channels[3] as number,
	};
}

/**
 * Deduplicate reserved colors, keeping first-appearance order.
 * Entries are copied so caller-side mutation never leaks back.
 */
export function normalizeKeepColors(colors: readonly RGBA[]): RGBA[] {
	const seen = new Set<number>();
	const out: RGBA[] = [];
	for (const color of colors) {
		assertValidRGBA(color);
		const key = keyOf(color);
		if (!seen.has(key)) {
			seen.add(key);
			out.push(copyColor(color));
		}
	}
	return out;
}

/**
 * Validate the colors/palette source and normalize the request. Conflict and
 * missing-source rules come first, then the reserved colors, then the palette
 * capacity and membership, then the colors budget.
 */
export function resolveQuantizeRequest(
	request: QuantizePaletteRequest,
): ResolvedQuantizeRequest {
	const hasColors = request.colors !== undefined;
	const hasPalette = request.palette !== undefined;
	if (hasColors && hasPalette) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			"colors and palette cannot be combined; pass one.",
			{},
		);
	}
	if (!hasColors && !hasPalette) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Quantize needs colors or palette; pass one.",
			{},
		);
	}
	const keepColors = normalizeKeepColors(request.keepColors ?? []);
	if (request.palette !== undefined) {
		assertPaletteEntries(request.palette);
		assertKeepsInPalette(keepColors, request.palette);
		return {
			kind: "palette",
			palette: request.palette.map(copyColor),
			keepColors,
		};
	}
	return {
		kind: "colors",
		colors: validateColorsOption(request.colors),
		keepColors,
	};
}

/**
 * Map every pixel to its nearest explicit palette entry.
 * The declared palette order is retained verbatim (including unused
 * entries); indices address that palette and colorCount counts it fully.
 * Every reserved color must be an exact palette entry.
 */
export function quantizePixelsWithPalette(
	pixels: Uint8Array,
	palette: readonly RGBA[],
	keepColors?: readonly RGBA[] | undefined,
): QuantizeResult {
	assertPixelBuffer(pixels);
	assertPaletteEntries(palette);
	assertKeepsInPalette(normalizeKeepColors(keepColors ?? []), palette);
	const indices = mapPixelsToPalette(pixels, {
		entries: palette.map((color, index) => ({
			id: `color-${index}`,
			color: copyColor(color),
		})),
	});
	const out = new Uint8Array(pixels.length);
	for (let i = 0; i < indices.length; i += 1) {
		writePixel(out, i, palette[indices[i] as number] as RGBA);
	}
	return {
		palette: palette.map(copyColor),
		pixels: out,
		indices,
		colorCount: palette.length,
	};
}

/**
 * Quantize with reserved colors subtracted from the colors budget. Only the
 * deduplicated reserved colors present in the buffer consume the budget, so
 * an absent one costs nothing. Kept pixels stay byte-identical. The remaining
 * pixels are median-cut with the leftover budget; when nothing is left over,
 * or nothing falls outside the reserved set, every pixel maps to the active
 * reserved colors instead. The palette is the deduplicated union of the
 * active reserved colors (input order) and the median-cut representatives.
 */
export function quantizePixelsWithReservedColors(
	pixels: Uint8Array,
	colors: number,
	keepColors: readonly RGBA[],
): QuantizeResult {
	assertPixelBuffer(pixels);
	const limit = validateColorsOption(colors);
	const deduped = normalizeKeepColors(keepColors);
	const total = pixels.length / 4;
	const present = new Set<number>();
	for (let i = 0; i < total; i += 1) {
		present.add(keyOf(readPixel(pixels, i)));
	}
	const active = deduped.filter((keep) => present.has(keyOf(keep)));
	if (active.length > limit) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Reserved colors exceed the colors budget.",
			{ colors: limit, reserved: active.length },
		);
	}
	if (active.length === 0) {
		return quantizePixels(pixels, limit);
	}
	const activeKeys = new Set<number>(active.map(keyOf));
	let nonKeptCount = 0;
	for (let i = 0; i < total; i += 1) {
		if (!activeKeys.has(keyOf(readPixel(pixels, i)))) {
			nonKeptCount += 1;
		}
	}
	const remaining = limit - active.length;
	if (nonKeptCount === 0 || remaining === 0) {
		return quantizePixelsWithPalette(pixels, active);
	}
	const nonKept = new Uint8Array(nonKeptCount * 4);
	let cursor = 0;
	for (let i = 0; i < total; i += 1) {
		const current = readPixel(pixels, i);
		if (!activeKeys.has(keyOf(current))) {
			writePixel(nonKept, cursor, current);
			cursor += 1;
		}
	}
	const sub = quantizePixels(nonKept, remaining);
	const union: RGBA[] = active.map(copyColor);
	const unionKeys = new Set<number>(active.map(keyOf));
	for (const representative of sub.palette) {
		const key = keyOf(representative);
		if (!unionKeys.has(key)) {
			unionKeys.add(key);
			union.push(copyColor(representative));
		}
	}
	const unionIndex = new Map<number, number>();
	for (let i = 0; i < union.length; i += 1) {
		unionIndex.set(keyOf(union[i] as RGBA), i);
	}
	const out = new Uint8Array(pixels.length);
	const indices = new Uint16Array(total);
	let subPosition = 0;
	for (let i = 0; i < total; i += 1) {
		const current = readPixel(pixels, i);
		if (activeKeys.has(keyOf(current))) {
			writePixel(out, i, current);
			indices[i] = unionIndex.get(keyOf(current)) as number;
		} else {
			const subAt = sub.indices[subPosition] as number;
			const representative = sub.palette[subAt] as RGBA;
			writePixel(out, i, representative);
			indices[i] = unionIndex.get(keyOf(representative)) as number;
			subPosition += 1;
		}
	}
	return { palette: union, pixels: out, indices, colorCount: union.length };
}
