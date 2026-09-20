import { replaceLayerPixels } from "./canvas.ts";
import { type CleanupClass, fixCleanup } from "./cleanup.ts";
import { McAssetError } from "./errors.ts";
import { quantizePixels } from "./quantizer.ts";
import { resize } from "./transform.ts";
import type { PixelCanvas } from "./types.ts";
import { checkResourceLimits, validateDimension } from "./validate.ts";

/**
 * Pixelize pipeline: the frozen eleven stages in fixed order
 * (Decode -> Crop -> Background -> Subject -> Resize -> Edge -> Quantize
 * -> Cluster -> Cleanup -> Preset -> Output). Decode and Output are owned
 * by the caller (io/decode.ts and the PNG/.mcpx encoders); the eight
 * middle stages run here, and flags can never reorder them.
 *
 * Stages without spec-defined algorithms use the simplest deterministic
 * starter rule, marked pending art-direction review:
 * - Crop: keep the full frame (no-op).
 * - Background: keep alpha verbatim (no-op; never flattens onto a color).
 * - Subject: keep the subject where it is (no-op).
 * - Edge: emphasis amount 0 (no-op).
 * - Cluster: merge threshold 0 (no-op).
 * - Quantize: integer median-cut at the preset color budget (real).
 * - Cleanup: fix the preset cleanup classes only (real; outlier-only, so
 *   no render-pass authorization is needed).
 * - Preset: record the named parameter set (no hidden heuristics).
 *
 * All pixel arithmetic stays integer; no randomness, no transcendental
 * functions. Same input plus same options always yields the same bytes.
 */

/** Frozen stage order. Callers must trace, never reorder. */
export const PIXELIZE_STAGES = [
	"decode",
	"crop",
	"background",
	"subject",
	"resize",
	"edge",
	"quantize",
	"cluster",
	"cleanup",
	"preset",
	"output",
] as const;

export type PixelizeStage = (typeof PIXELIZE_STAGES)[number];

export type PixelizePresetName =
	| "item"
	| "block"
	| "generic"
	| "gui"
	| "particle";

export interface PixelizePresetParams {
	/** Quantize color budget for the preset. */
	colors: number;
	/** Edge emphasis amount. Starter: 0 (no-op, pending review). */
	edge: number;
	/** Cluster merge threshold. Starter: 0 (no-op, pending review). */
	cluster: number;
	/** Cleanup classes fixed by the pipeline. Starter: outlier only. */
	cleanupClasses: readonly CleanupClass[];
	/** Human-readable direction; presets stay printable, never hidden. */
	description: string;
}

/**
 * Starter parameter sets (pending art-direction review, not spec-derived).
 * item favors silhouette readability with a tight budget; block keeps a
 * small budget toward tileable textures; generic applies no
 * Minecraft-specific heuristic beyond the shared pipeline; gui keeps a
 * tight budget toward exact dimensions, hard edges, and flat colors without
 * generating any nine-slice metadata; particle keeps a mid budget toward
 * alpha precision and small-scale readability without pinning a size.
 */
export const PIXELIZE_PRESETS: Record<
	PixelizePresetName,
	PixelizePresetParams
> = {
	item: {
		colors: 16,
		edge: 0,
		cluster: 0,
		cleanupClasses: ["outlier"],
		description: "item: tight 16-color budget, outlier cleanup, no heuristics",
	},
	block: {
		colors: 12,
		edge: 0,
		cluster: 0,
		cleanupClasses: ["outlier"],
		description: "block: small 12-color budget, outlier cleanup, no heuristics",
	},
	generic: {
		colors: 32,
		edge: 0,
		cluster: 0,
		cleanupClasses: [],
		description: "generic: 32-color budget, detect-only cleanup",
	},
	gui: {
		colors: 16,
		edge: 0,
		cluster: 0,
		cleanupClasses: ["outlier"],
		description:
			"gui: tight 16-color budget for hard edges and flat colors, outlier cleanup, no nine-slice metadata",
	},
	particle: {
		colors: 24,
		edge: 0,
		cluster: 0,
		cleanupClasses: ["outlier"],
		description:
			"particle: mid 24-color budget for alpha precision and small-scale readability, outlier cleanup, no fixed size",
	},
};

/** Square sizes that need no resolution warning. */
const STANDARD_SIZES = [16, 32, 64, 128] as const;

export interface PixelizeSize {
	width: number;
	height: number;
}

function parseWhole(value: string, what: string): number {
	if (!/^[0-9]+$/.test(value)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`--size ${what} must be a positive integer, got "${value}".`,
			{ size: value },
		);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`--size ${what} must be a positive integer, got "${value}".`,
			{ size: value },
		);
	}
	return parsed;
}

/**
 * Parse `--size`: `16` means 16x16; `WxH` is a custom rectangle.
 * Non-integers are INVALID_ARGUMENT; out-of-range edges are
 * INVALID_DIMENSION (never silently clipped).
 */
export function parsePixelizeSize(raw: string | undefined): PixelizeSize {
	if (raw === undefined || raw === "") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"--size is required (16, 32, 64, 128, or WxH).",
			{ size: raw },
		);
	}
	const parts = raw.split("x");
	let width: number;
	let height: number;
	if (parts.length === 1) {
		const edge = parseWhole(parts[0] as string, "edge");
		width = edge;
		height = edge;
	} else if (parts.length === 2) {
		width = parseWhole(parts[0] as string, "width");
		height = parseWhole(parts[1] as string, "height");
	} else {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`--size must be N or WxH, got "${raw}".`,
			{ size: raw },
		);
	}
	validateDimension(width);
	validateDimension(height);
	return { width, height };
}

/** Square 16/32/64/128 need no warning; anything else warns (never errors). */
export function isStandardPixelizeSize(width: number, height: number): boolean {
	if (width !== height) {
		return false;
	}
	return (STANDARD_SIZES as readonly number[]).includes(width);
}

function isPresetName(value: string): value is PixelizePresetName {
	return (
		value === "item" ||
		value === "block" ||
		value === "generic" ||
		value === "gui" ||
		value === "particle"
	);
}

/** Omitted preset defaults to generic; unknown names are INVALID_ARGUMENT. */
export function parsePixelizePreset(
	raw: string | undefined,
): PixelizePresetName {
	if (raw === undefined || raw === "") {
		return "generic";
	}
	if (!isPresetName(raw)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Unknown preset "${raw}". Pixelize presets: item, block, generic, gui, particle.`,
			{ preset: raw },
		);
	}
	return raw;
}

/** Printable preset summary for reports and review. */
export function describePixelizePreset(name: PixelizePresetName): string {
	const preset = PIXELIZE_PRESETS[name];
	if (preset === undefined) {
		throw new McAssetError("INVALID_ARGUMENT", `Unknown preset "${name}".`, {
			preset: name,
		});
	}
	return (
		`preset=${name} colors=${preset.colors} edge=${preset.edge} ` +
		`cluster=${preset.cluster} cleanup=${preset.cleanupClasses.join(",")} ` +
		`pending-review (${preset.description})`
	);
}

export interface PixelizeOptions {
	size: string | undefined;
	preset: string | undefined;
}

export interface PixelizeReport {
	canvas: PixelCanvas;
	/** The eleven stages in execution order (always the frozen order). */
	stages: PixelizeStage[];
	preset: PixelizePresetName;
	width: number;
	height: number;
	colors: number;
	colorCount: number;
	nonStandardResolution: boolean;
}

/**
 * Run the middle eight stages over a decoded canvas. The canvas is mutated
 * in place, matching the transform/quantize engine convention. Decode and
 * Output stay with the caller so the stage order is explicit in code.
 */
export function runPixelize(
	canvas: PixelCanvas,
	options: PixelizeOptions,
): PixelizeReport {
	const { width, height } = parsePixelizeSize(options.size);
	const presetName = parsePixelizePreset(options.preset);
	const preset = PIXELIZE_PRESETS[presetName];
	checkResourceLimits(
		width,
		height,
		canvas.layers.length,
		canvas.regions.length,
	);
	const stages: PixelizeStage[] = [...PIXELIZE_STAGES];
	// Crop / Background / Subject: starter no-ops (full frame, verbatim
	// alpha, subject in place). The stages are traced, not skipped, so the
	// order stays observable.
	resize(canvas, width, height, "nearest");
	// Edge / Cluster: starter no-ops (amount and threshold are 0).
	let colorCount = 0;
	for (const layer of canvas.layers) {
		const quantized = quantizePixels(layer.pixels, preset.colors);
		replaceLayerPixels(canvas, layer.id, quantized.pixels);
		if (quantized.colorCount > colorCount) {
			colorCount = quantized.colorCount;
		}
	}
	for (const layer of canvas.layers) {
		fixCleanup(canvas, layer.id, { fix: [...preset.cleanupClasses] });
	}
	return {
		canvas,
		stages,
		preset: presetName,
		width,
		height,
		colors: preset.colors,
		colorCount,
		nonStandardResolution: !isStandardPixelizeSize(width, height),
	};
}
