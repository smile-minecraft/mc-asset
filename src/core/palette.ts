import { createAuthoringPalette } from "./canvas.ts";
import { McAssetError } from "./errors.ts";
import type { AuthoringPalette, RGBA } from "./types.ts";

/**
 * Palette engine: extract / apply / map / inspect over raw RGBA buffers.
 * Pure and deterministic: same bytes and palette always give the same
 * result on every runtime. No transcendental functions, no randomness,
 * no timestamps. Hidden RGB under `A = 0` is data: extract keeps it
 * distinct, apply/map match on all four channels, inspect counts it.
 */

export interface PaletteRoleSummary {
	role: string;
	count: number;
}

export interface PaletteDominantColor {
	r: number;
	g: number;
	b: number;
	a: number;
	count: number;
}

export interface PaletteInspectReport {
	/** Total pixels scanned. */
	pixelCount: number;
	/** Distinct RGBA colors in the pixels (hidden RGB counts). */
	colorCount: number;
	/** Distinct alpha values in the pixels. */
	alphaLevels: number;
	/** Pixels with `A = 0`. */
	transparentPixels: number;
	/** Pixels with `0 < A < 255`. */
	partialAlphaPixels: number;
	/** Pixels with `A = 255`. */
	opaquePixels: number;
	/** Palette entry count (0 when no palette is given). */
	paletteSize: number;
	/** Pixels whose exact RGBA is absent from the palette. */
	unmappedPixels: number;
	/** Entry counts per role, role name ascending. */
	roles: PaletteRoleSummary[];
	/** Top colors by count, full order (count desc, rgba asc). */
	dominantColors: PaletteDominantColor[];
}

/** dominantColors is capped here; colorCount keeps the full total. */
export const INSPECT_DOMINANT_LIMIT = 8;

function assertPixelBuffer(pixels: Uint8Array): void {
	if (!(pixels instanceof Uint8Array) || pixels.length % 4 !== 0) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Pixel buffer length must be a multiple of 4 (RGBA).",
			{ length: (pixels as Uint8Array | undefined)?.length },
		);
	}
}

function assertMappablePalette(palette: AuthoringPalette): void {
	if (
		palette === undefined ||
		palette === null ||
		!Array.isArray((palette as AuthoringPalette).entries) ||
		(palette as AuthoringPalette).entries.length === 0
	) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Palette must hold at least one entry to map pixels.",
			{},
		);
	}
}

function colorKey(r: number, g: number, b: number, a: number): number {
	return r * 16777216 + g * 65536 + b * 256 + a;
}

function squaredDistance(a: RGBA, b: RGBA): number {
	const dr = a.r - b.r;
	const dg = a.g - b.g;
	const db = a.b - b.b;
	const da = a.a - b.a;
	return dr * dr + dg * dg + db * db + da * da;
}

/**
 * Collect distinct colors in first-appearance order with tallies.
 * Insertion order of the Map is first-appearance order by construction.
 */
function tallyPixels(pixels: Uint8Array): { color: RGBA; count: number }[] {
	const byKey = new Map<number, { color: RGBA; count: number }>();
	for (let i = 0; i < pixels.length; i += 4) {
		const color: RGBA = {
			r: pixels[i] as number,
			g: pixels[i + 1] as number,
			b: pixels[i + 2] as number,
			a: pixels[i + 3] as number,
		};
		const key = colorKey(color.r, color.g, color.b, color.a);
		const known = byKey.get(key);
		if (known !== undefined) {
			known.count += 1;
		} else {
			byKey.set(key, { color, count: 1 });
		}
	}
	return [...byKey.values()];
}

/**
 * Extract the distinct RGBA colors as an authoring palette. Entries keep
 * first-appearance order with stable ids `color-<n>` and no roles; roles
 * are assigned by later stages (material/recolor), not inferred here.
 */
export function extractPalette(pixels: Uint8Array): AuthoringPalette {
	assertPixelBuffer(pixels);
	const tallied = tallyPixels(pixels);
	return createAuthoringPalette(
		tallied.map((entry, index) => ({
			id: `color-${index}`,
			color: entry.color,
		})),
	);
}

/**
 * Map every pixel to its nearest palette entry index (input pixel order).
 * Distance is the integer sum of squared RGBA channel differences; exact
 * ties take the lowest palette index.
 */
export function mapPixelsToPalette(
	pixels: Uint8Array,
	palette: AuthoringPalette,
): Uint16Array {
	assertPixelBuffer(pixels);
	assertMappablePalette(palette);
	const entries = palette.entries;
	const total = pixels.length / 4;
	const indices = new Uint16Array(total);
	for (let i = 0; i < total; i += 1) {
		const base = i * 4;
		const color: RGBA = {
			r: pixels[base] as number,
			g: pixels[base + 1] as number,
			b: pixels[base + 2] as number,
			a: pixels[base + 3] as number,
		};
		let best = 0;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (let j = 0; j < entries.length; j += 1) {
			const distance = squaredDistance(
				color,
				(entries[j] as { color: RGBA }).color,
			);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = j;
			}
		}
		indices[i] = best;
	}
	return indices;
}

/**
 * Rewrite every pixel to its nearest palette color. Returns a fresh
 * buffer; the input is never mutated. Mapping to a palette is an explicit
 * operation, so transparent pixels take part like any other color.
 */
export function applyPalette(
	pixels: Uint8Array,
	palette: AuthoringPalette,
): Uint8Array {
	const indices = mapPixelsToPalette(pixels, palette);
	const out = new Uint8Array(pixels.length);
	for (let i = 0; i < indices.length; i += 1) {
		const pick = (palette.entries[indices[i] as number] as { color: RGBA })
			.color;
		out[i * 4] = pick.r;
		out[i * 4 + 1] = pick.g;
		out[i * 4 + 2] = pick.b;
		out[i * 4 + 3] = pick.a;
	}
	return out;
}

/**
 * Describe the pixels, optionally against a palette. Shape is fixed and
 * timestamp-free so reports can be golden-tested and reused by analyze.
 */
export function inspectPalette(
	pixels: Uint8Array,
	palette?: AuthoringPalette,
): PaletteInspectReport {
	assertPixelBuffer(pixels);
	const tallied = tallyPixels(pixels);
	const pixelCount = pixels.length / 4;
	const alphas = new Set<number>();
	let transparentPixels = 0;
	let partialAlphaPixels = 0;
	for (const entry of tallied) {
		alphas.add(entry.color.a);
		if (entry.color.a === 0) {
			transparentPixels += entry.count;
		} else if (entry.color.a !== 255) {
			partialAlphaPixels += entry.count;
		}
	}
	const entries = palette?.entries ?? [];
	const paletteKeys = new Set<number>();
	for (const entry of entries) {
		paletteKeys.add(
			colorKey(entry.color.r, entry.color.g, entry.color.b, entry.color.a),
		);
	}
	let unmappedPixels = 0;
	for (const entry of tallied) {
		const key = colorKey(
			entry.color.r,
			entry.color.g,
			entry.color.b,
			entry.color.a,
		);
		if (!paletteKeys.has(key)) {
			unmappedPixels += entry.count;
		}
	}
	const roleCounts = new Map<string, number>();
	for (const entry of entries) {
		if (entry.role !== undefined) {
			roleCounts.set(entry.role, (roleCounts.get(entry.role) ?? 0) + 1);
		}
	}
	const roles: PaletteRoleSummary[] = [...roleCounts]
		.sort((left, right) =>
			left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
		)
		.map(([role, count]) => ({ role, count }));
	const dominantColors: PaletteDominantColor[] = tallied
		.map((entry) => ({ ...entry.color, count: entry.count }))
		.sort((left, right) => {
			if (right.count !== left.count) {
				return right.count - left.count;
			}
			if (left.r !== right.r) {
				return left.r - right.r;
			}
			if (left.g !== right.g) {
				return left.g - right.g;
			}
			if (left.b !== right.b) {
				return left.b - right.b;
			}
			return left.a - right.a;
		})
		.slice(0, INSPECT_DOMINANT_LIMIT);
	return {
		pixelCount,
		colorCount: tallied.length,
		alphaLevels: alphas.size,
		transparentPixels,
		partialAlphaPixels,
		opaquePixels: pixelCount - transparentPixels - partialAlphaPixels,
		paletteSize: entries.length,
		unmappedPixels,
		roles,
		dominantColors,
	};
}
