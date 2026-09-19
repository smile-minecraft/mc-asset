import type { PixelCanvas } from "../core/types.ts";
import { assertValidCanvas } from "../core/validate.ts";
import { flattenCanvas } from "../io/png.ts";
import {
	checkBlockResolutionWarnings,
	classifyPredictedClassification,
	collectPartialAlphaWarnings,
	summarizeAlphaFromValues,
} from "../profiles/classify.ts";
import { describeAssetProfilePredicted } from "../profiles/profiles.ts";
import { pendingSourceWarnings } from "../profiles/versions.ts";

/**
 * Analyze metrics engine. Pure and read-only: the canvas is only read
 * (through a flattened copy), never written. No I/O, no timestamps,
 * no randomness; float output is fixed-decimal strings (§100.3).
 */

/** Dominant-color list is truncated here; colorCount keeps the full total. */
export const MAX_DOMINANT_COLORS = 8;

/** Fixed decimals for every float in the report (§100.3). */
export const RATIO_DECIMALS = 4;

export interface AnalyzeOptions {
	profile?: string | undefined;
	packFormat?: number | undefined;
	/**
	 * Normalization notes from the decoder (gAMA / iCCP on the PNG path).
	 * Passed in so the engine stays pure: it never touches the file or
	 * the decoder itself. The multi-format intake forwards its own
	 * warnings here with the same shape.
	 */
	sourceWarnings?: Array<{ code: string; message: string }> | undefined;
}

export interface AnalyzeDominantColor {
	hex: string;
	r: number;
	g: number;
	b: number;
	a: number;
	count: number;
	/** Fixed-decimal share of total pixels, e.g. "0.5000". */
	ratio: string;
}

export interface AnalyzeAlphaSection {
	predictedClassification: "solid" | "cutout" | "translucent";
	opaquePixels: number;
	transparentPixels: number;
	partialAlphaPixels: number;
	partialAlphaValues: number[];
	opaqueRatio: string;
	transparentRatio: string;
	partialAlphaRatio: string;
	predictedNote: string;
}

export interface AnalyzeWarning {
	code: string;
	level: "warning";
	message: string;
}

export interface AnalyzePaletteRoleCount {
	role: string;
	count: number;
}

/**
 * Palette shape of the flattened pixels. Roles count authoring-palette
 * entries by role name ascending (same order as palette inspect); raster
 * intakes carry no palette, so roles is empty there. Alpha splits follow
 * the frozen boundary: A = 0 is fully transparent, 0 < A < 255 partial.
 */
export interface AnalyzePaletteCharacteristics {
	colorCount: number;
	alphaLevels: number;
	roles: AnalyzePaletteRoleCount[];
	transparentPixels: number;
	partialAlphaPixels: number;
}

/**
 * Pixel-art shape of the flattened pixels. isolatedPixels reuses the
 * cleanup isolated detector semantics (opaque pixel whose existing
 * 4-neighbors are all fully transparent); tileFriendly is the starter
 * wrap rule (left/right and top/bottom edges strictly byte-equal),
 * pending review and golden-locked.
 */
export interface AnalyzePixelArtCharacteristics {
	resolution: { width: number; height: number };
	/** Gcd-reduced "w:h" string, e.g. 64x32 reads "2:1". */
	aspect: string;
	isolatedPixels: number;
	semiTransparentPixels: number;
	/** Distinct RGBA colors in the pixels (raster has no authoring palette). */
	paletteSize: number;
	tileFriendly: boolean;
}

/**
 * Starter suggestions only, never execution results. Every value comes
 * from a fixed deterministic rule: no models, no services, integers only.
 */
export interface AnalyzeRecommended {
	quantize: { colors: number };
	cleanup: { classes: string[] };
	resize: { mode: "nearest" };
}

export interface AnalyzeReport {
	dimensions: { width: number; height: number };
	totalPixels: number;
	colorCount: number;
	alpha: AnalyzeAlphaSection;
	dominantColors: AnalyzeDominantColor[];
	profile: { id: string; predictedDescription: string };
	paletteCharacteristics: AnalyzePaletteCharacteristics;
	pixelArtCharacteristics: AnalyzePixelArtCharacteristics;
	recommended: AnalyzeRecommended;
	warnings: AnalyzeWarning[];
}

function byteToHex(value: number): string {
	return value.toString(16).padStart(2, "0").toUpperCase();
}

function rgbaHex(r: number, g: number, b: number, a: number): string {
	return `#${byteToHex(r)}${byteToHex(g)}${byteToHex(b)}${byteToHex(a)}`;
}

/** Deterministic fixed-decimal ratio in [0, 1]; total is always >= 1. */
function fixedRatio(count: number, total: number): string {
	return (count / total).toFixed(RATIO_DECIMALS);
}

function colorKey(r: number, g: number, b: number, a: number): number {
	return r * 16777216 + g * 65536 + b * 256 + a;
}

/** Integer gcd for the aspect reduction; inputs are always >= 1. */
function gcd(a: number, b: number): number {
	let x = a;
	let y = b;
	while (y !== 0) {
		const rest = x % y;
		x = y;
		y = rest;
	}
	return x;
}

/**
 * Opaque pixel whose existing 4-neighbors are all fully transparent.
 * Same boundary rule as the cleanup isolated detector: edge pixels only
 * consult the neighbors they have, and partial-alpha centers never count.
 */
function countIsolatedPixels(
	flat: Uint8Array,
	width: number,
	height: number,
): number {
	let count = 0;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const offset = (y * width + x) * 4;
			if (flat[offset + 3] !== 255) {
				continue;
			}
			if (x > 0 && flat[offset - 4 + 3] !== 0) {
				continue;
			}
			if (x + 1 < width && flat[offset + 4 + 3] !== 0) {
				continue;
			}
			if (y > 0 && flat[offset - width * 4 + 3] !== 0) {
				continue;
			}
			if (y + 1 < height && flat[offset + width * 4 + 3] !== 0) {
				continue;
			}
			count += 1;
		}
	}
	return count;
}

function samePixel(flat: Uint8Array, a: number, b: number): boolean {
	return (
		flat[a] === flat[b] &&
		flat[a + 1] === flat[b + 1] &&
		flat[a + 2] === flat[b + 2] &&
		flat[a + 3] === flat[b + 3]
	);
}

/**
 * Starter tile rule, pending review: left/right and top/bottom wrap edges
 * must match strictly byte-equal. A 1-wide (or 1-tall) axis compares each
 * edge pixel with itself, so degenerate strips tolerate that axis.
 */
function isTileFriendly(
	flat: Uint8Array,
	width: number,
	height: number,
): boolean {
	for (let y = 0; y < height; y += 1) {
		if (!samePixel(flat, y * width * 4, (y * width + width - 1) * 4)) {
			return false;
		}
	}
	for (let x = 0; x < width; x += 1) {
		if (!samePixel(flat, x * 4, ((height - 1) * width + x) * 4)) {
			return false;
		}
	}
	return true;
}

/**
 * Smallest power of two holding every distinct color, clamped to the
 * quantize engine range [1, 4096]. Integer loop only, no powers or roots.
 */
function recommendedQuantizeColors(colorCount: number): number {
	let colors = 1;
	while (colors < colorCount) {
		colors *= 2;
	}
	return colors > 4096 ? 4096 : colors;
}

/**
 * Walk the flattened composite once: distinct RGBA count, alpha histogram
 * input, and per-color tallies. The canvas itself is never written.
 */
export function analyzeCanvas(
	canvas: PixelCanvas,
	options: AnalyzeOptions,
): AnalyzeReport {
	assertValidCanvas(canvas);
	const profileId = options.profile ?? "generic";
	const flat = flattenCanvas(canvas);
	const total = canvas.width * canvas.height;
	const alphas = new Uint8Array(total);
	const alphaLevels = new Set<number>();
	const counts = new Map<number, number>();
	for (let i = 0; i < total; i += 1) {
		const base = i * 4;
		const r = flat[base] as number;
		const g = flat[base + 1] as number;
		const b = flat[base + 2] as number;
		const a = flat[base + 3] as number;
		alphas[i] = a;
		alphaLevels.add(a);
		const key = colorKey(r, g, b, a);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const histogram = summarizeAlphaFromValues(alphas);
	const predictedClassification = classifyPredictedClassification(histogram);
	const entries: AnalyzeDominantColor[] = [];
	for (const [key, count] of counts) {
		const r = Math.floor(key / 16777216);
		const g = Math.floor((key - r * 16777216) / 65536);
		const b = Math.floor((key - r * 16777216 - g * 65536) / 256);
		const a = key - r * 16777216 - g * 65536 - b * 256;
		entries.push({
			hex: rgbaHex(r, g, b, a),
			r,
			g,
			b,
			a,
			count,
			ratio: fixedRatio(count, total),
		});
	}
	// Full order (§100.3): count descending, hex ascending for ties.
	entries.sort((left, right) => {
		if (right.count !== left.count) {
			return right.count - left.count;
		}
		if (left.hex < right.hex) {
			return -1;
		}
		if (left.hex > right.hex) {
			return 1;
		}
		return 0;
	});
	const warnings: AnalyzeWarning[] = [];
	const source = options.sourceWarnings ?? [];
	for (const note of source) {
		warnings.push({
			code: note.code,
			level: "warning",
			message: note.message,
		});
	}
	for (const warning of collectPartialAlphaWarnings(histogram)) {
		warnings.push({ ...warning });
	}
	if (profileId === "minecraft:block") {
		for (const warning of checkBlockResolutionWarnings(
			canvas.width,
			canvas.height,
		)) {
			warnings.push({ ...warning });
		}
	}
	for (const warning of pendingSourceWarnings()) {
		warnings.push({ ...warning });
	}
	const roleCounts = new Map<string, number>();
	for (const entry of canvas.palette?.entries ?? []) {
		if (entry.role !== undefined) {
			roleCounts.set(entry.role, (roleCounts.get(entry.role) ?? 0) + 1);
		}
	}
	const roles: AnalyzePaletteRoleCount[] = [...roleCounts]
		.sort((left, right) =>
			left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
		)
		.map(([role, count]) => ({ role, count }));
	const divisor = gcd(canvas.width, canvas.height);
	return {
		dimensions: { width: canvas.width, height: canvas.height },
		totalPixels: total,
		colorCount: counts.size,
		alpha: {
			predictedClassification,
			opaquePixels: histogram.opaquePixels,
			transparentPixels: histogram.transparentPixels,
			partialAlphaPixels: histogram.partialAlphaPixels,
			partialAlphaValues: [...histogram.partialAlphaValues],
			opaqueRatio: fixedRatio(histogram.opaquePixels, total),
			transparentRatio: fixedRatio(histogram.transparentPixels, total),
			partialAlphaRatio: fixedRatio(histogram.partialAlphaPixels, total),
			predictedNote:
				"predicted classification from PNG bytes only; not the final in-game render result.",
		},
		dominantColors: entries.slice(0, MAX_DOMINANT_COLORS),
		profile: {
			id: profileId,
			predictedDescription: describeAssetProfilePredicted(
				profileId,
				options.packFormat,
			),
		},
		paletteCharacteristics: {
			colorCount: counts.size,
			alphaLevels: alphaLevels.size,
			roles,
			transparentPixels: histogram.transparentPixels,
			partialAlphaPixels: histogram.partialAlphaPixels,
		},
		pixelArtCharacteristics: {
			resolution: { width: canvas.width, height: canvas.height },
			aspect: `${canvas.width / divisor}:${canvas.height / divisor}`,
			isolatedPixels: countIsolatedPixels(flat, canvas.width, canvas.height),
			semiTransparentPixels: histogram.partialAlphaPixels,
			paletteSize: counts.size,
			tileFriendly: isTileFriendly(flat, canvas.width, canvas.height),
		},
		recommended: {
			quantize: { colors: recommendedQuantizeColors(counts.size) },
			cleanup: { classes: [] },
			resize: { mode: "nearest" },
		},
		warnings,
	};
}
