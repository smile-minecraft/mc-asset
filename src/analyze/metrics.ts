import type { PixelCanvas } from "../core/types.ts";
import { assertValidCanvas } from "../core/validate.ts";
import { flattenCanvas, type PngWarning } from "../io/png.ts";
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
	 * Normalization notes from decodePng (gAMA / iCCP). Passed in so the
	 * engine stays pure: it never touches the file or the decoder itself.
	 */
	sourceWarnings?: PngWarning[] | undefined;
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

export interface AnalyzeReport {
	dimensions: { width: number; height: number };
	totalPixels: number;
	colorCount: number;
	alpha: AnalyzeAlphaSection;
	dominantColors: AnalyzeDominantColor[];
	profile: { id: string; predictedDescription: string };
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
	const counts = new Map<number, number>();
	for (let i = 0; i < total; i += 1) {
		const base = i * 4;
		const r = flat[base] as number;
		const g = flat[base + 1] as number;
		const b = flat[base + 2] as number;
		const a = flat[base + 3] as number;
		alphas[i] = a;
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
		warnings,
	};
}
