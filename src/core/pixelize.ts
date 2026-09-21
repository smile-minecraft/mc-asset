import { replaceLayerPixels } from "./canvas.ts";
import { type CleanupClass, fixCleanup } from "./cleanup.ts";
import { McAssetError } from "./errors.ts";
import { quantizePixels } from "./quantizer.ts";
import { crop, resize } from "./transform.ts";
import type { PixelCanvas } from "./types.ts";
import { checkResourceLimits, validateDimension } from "./validate.ts";

/**
 * Pixelize pipeline: the frozen eleven stages in fixed order
 * (Decode -> Crop -> Background -> Subject -> Resize -> Edge -> Quantize
 * -> Cluster -> Cleanup -> Preset -> Output). Decode and Output are owned
 * by the caller (io/decode.ts and the PNG/.mcpx encoders); the eight
 * middle stages run here, and flags can never reorder them.
 *
 * The five shape stages follow the frozen capability matrix:
 * - Crop: cut every layer and region mask to the union alpha>0 bounding
 *   box (full-frame or fully transparent input stays as is).
 * - Background: when the outer ring carries one opaque color at 90 percent
 *   coverage or more, clear its four-connected region (alpha to 0, RGB
 *   kept verbatim).
 * - Subject: integer-shift every layer and mask so the remaining alpha>0
 *   box sits centered (no resampling).
 * - Edge: harden semi-transparent alpha against the preset threshold
 *   (below clears, at or above turns opaque; RGB never touched).
 * - Cluster: merge alpha>0 RGB colors whose Chebyshev distance fits the
 *   preset threshold, most frequent first with RGB-ascending tie-breaks;
 *   transparent pixels and alpha bytes are never touched.
 * - Quantize: integer median-cut at the preset color budget.
 * - Cleanup: fix the preset cleanup classes only (outlier-only, so
 *   no render-pass authorization is needed).
 * - Preset: record the named parameter set.
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

/** Per-stage execution outcome traced in the report. */
export type PixelizeStageStatus =
	| "applied"
	| "not-needed"
	| "disabled"
	| "unsupported";

/** One stage of the frozen order with its outcome and optional reason. */
export interface PixelizeStageState {
	stage: PixelizeStage;
	status: PixelizeStageStatus;
	reason?: string;
}

export type PixelizePresetName =
	| "item"
	| "block"
	| "generic"
	| "gui"
	| "particle";

export interface PixelizePresetParams {
	/** Quantize color budget for the preset. */
	colors: number;
	/** Crop to the union alpha>0 bounding box. */
	crop: boolean;
	/** Clear a solid connected outer-ring backdrop. */
	background: boolean;
	/** Integer-shift the remaining subject to the canvas center. */
	subject: boolean;
	/** Edge hardening threshold (0 means the stage stays off). */
	edge: number;
	/** Cluster merge threshold (0 means the stage stays off). */
	cluster: number;
	/** Cleanup classes fixed by the pipeline. */
	cleanupClasses: readonly CleanupClass[];
	/** Human-readable direction; presets stay printable, never hidden. */
	description: string;
}

/**
 * Frozen preset parameter matrix. Only item runs the five shape stages
 * (crop, background, subject, edge 128, cluster 8); every other preset
 * leaves them off so its output bytes stay exactly as before.
 */
export const PIXELIZE_PRESETS: Record<
	PixelizePresetName,
	PixelizePresetParams
> = {
	item: {
		colors: 16,
		crop: true,
		background: true,
		subject: true,
		edge: 128,
		cluster: 8,
		cleanupClasses: ["outlier"],
		description:
			"item: tight 16-color budget with crop, background, subject, edge 128, cluster 8, outlier cleanup",
	},
	block: {
		colors: 12,
		crop: false,
		background: false,
		subject: false,
		edge: 0,
		cluster: 0,
		cleanupClasses: ["outlier"],
		description:
			"block: small 12-color budget, outlier cleanup, shape and merge stages off for seam safety",
	},
	generic: {
		colors: 32,
		crop: false,
		background: false,
		subject: false,
		edge: 0,
		cluster: 0,
		cleanupClasses: [],
		description:
			"generic: 32-color budget, detect-only cleanup, shape and merge stages off",
	},
	gui: {
		colors: 16,
		crop: false,
		background: false,
		subject: false,
		edge: 0,
		cluster: 0,
		cleanupClasses: ["outlier"],
		description:
			"gui: tight 16-color budget for hard edges and flat colors, outlier cleanup, shape and merge stages off, no nine-slice metadata",
	},
	particle: {
		colors: 24,
		crop: false,
		background: false,
		subject: false,
		edge: 0,
		cluster: 0,
		cleanupClasses: ["outlier"],
		description:
			"particle: mid 24-color budget for alpha precision and small-scale readability, outlier cleanup, shape and merge stages off, no fixed size",
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
		`(${preset.description})`
	);
}

export interface PixelizeOptions {
	size: string | undefined;
	preset: string | undefined;
}

export interface PixelizeReport {
	canvas: PixelCanvas;
	/** The eleven stages in execution order with per-stage outcomes. */
	stages: PixelizeStageState[];
	preset: PixelizePresetName;
	width: number;
	height: number;
	colors: number;
	colorCount: number;
	nonStandardResolution: boolean;
}

interface ContentBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Union alpha>0 bounding box across every layer; undefined when empty. */
function contentBox(canvas: PixelCanvas): ContentBox | undefined {
	let minX = canvas.width;
	let minY = canvas.height;
	let maxX = -1;
	let maxY = -1;
	for (const layer of canvas.layers) {
		const pixels = layer.pixels;
		for (let y = 0; y < canvas.height; y += 1) {
			const row = y * canvas.width;
			for (let x = 0; x < canvas.width; x += 1) {
				if ((pixels[(row + x) * 4 + 3] as number) > 0) {
					if (x < minX) {
						minX = x;
					}
					if (y < minY) {
						minY = y;
					}
					if (x > maxX) {
						maxX = x;
					}
					if (y > maxY) {
						maxY = y;
					}
				}
			}
		}
	}
	if (maxX < 0) {
		return undefined;
	}
	return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function packRgba(r: number, g: number, b: number, a: number): number {
	return ((r * 256 + g) * 256 + b) * 256 + a;
}

function packRgb(r: number, g: number, b: number): number {
	return (r * 256 + g) * 256 + b;
}

/**
 * Shift every layer and region mask by integer (dx, dy) with no
 * resampling. Only transparent pixels can fall outside the canvas (every
 * opaque pixel sits inside the translated content box, which fits by
 * construction), so leaving pixels are clipped and vacated cells become
 * transparent black; retained pixels keep their RGBA verbatim.
 */
function shiftContent(canvas: PixelCanvas, dx: number, dy: number): void {
	const width = canvas.width;
	const height = canvas.height;
	for (const layer of canvas.layers) {
		const next = new Uint8Array(width * height * 4);
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const sx = x - dx;
				const sy = y - dy;
				if (sx < 0 || sy < 0 || sx >= width || sy >= height) {
					continue;
				}
				const from = (sy * width + sx) * 4;
				const to = (y * width + x) * 4;
				next[to] = layer.pixels[from] as number;
				next[to + 1] = layer.pixels[from + 1] as number;
				next[to + 2] = layer.pixels[from + 2] as number;
				next[to + 3] = layer.pixels[from + 3] as number;
			}
		}
		layer.pixels = next;
	}
	for (const region of canvas.regions) {
		const next = new Uint8Array(width * height);
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const sx = x - dx;
				const sy = y - dy;
				if (sx < 0 || sy < 0 || sx >= width || sy >= height) {
					continue;
				}
				next[y * width + x] = region.mask[sy * width + sx] as number;
			}
		}
		region.mask = next;
	}
}

/** Crop to the union alpha>0 box; layers and masks share the cut. */
function applyCrop(canvas: PixelCanvas): PixelizeStageState {
	const box = contentBox(canvas);
	if (box === undefined) {
		return {
			stage: "crop",
			status: "not-needed",
			reason: "no opaque pixels to crop",
		};
	}
	if (
		box.x === 0 &&
		box.y === 0 &&
		box.width === canvas.width &&
		box.height === canvas.height
	) {
		return {
			stage: "crop",
			status: "not-needed",
			reason: "content fills the full frame",
		};
	}
	crop(canvas, box);
	return {
		stage: "crop",
		status: "applied",
		reason: `cropped to ${box.width}x${box.height} at ${box.x},${box.y}`,
	};
}

/**
 * Clear a solid connected outer-ring backdrop. The candidate is the ring
 * majority (count first, packed RGBA ascending on ties); it only applies
 * when fully opaque with at least 90 percent ring coverage
 * (count * 100 >= ring * 90). Clearing sets alpha to 0 and keeps RGB, and
 * only four-connected candidate pixels reachable from the ring change.
 */
function applyBackground(canvas: PixelCanvas): PixelizeStageState {
	const width = canvas.width;
	const height = canvas.height;
	const ring = new Set<number>();
	for (let x = 0; x < width; x += 1) {
		ring.add(x);
		ring.add((height - 1) * width + x);
	}
	for (let y = 0; y < height; y += 1) {
		ring.add(y * width);
		ring.add(y * width + (width - 1));
	}
	let cleared = 0;
	let candidateText = "";
	let idleReason = "outer ring has no opaque majority at 90 percent coverage";
	for (const layer of canvas.layers) {
		const pixels = layer.pixels;
		const counts = new Map<number, number>();
		for (const index of ring) {
			const offset = index * 4;
			const key = packRgba(
				pixels[offset] as number,
				pixels[offset + 1] as number,
				pixels[offset + 2] as number,
				pixels[offset + 3] as number,
			);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		let candidate = -1;
		let candidateCount = 0;
		for (const [key, count] of counts) {
			if (
				count > candidateCount ||
				(count === candidateCount && key < candidate)
			) {
				candidate = key;
				candidateCount = count;
			}
		}
		if (candidate < 0) {
			continue;
		}
		const alpha = candidate % 256;
		if (alpha !== 255) {
			idleReason = "outer-ring majority is not opaque";
			continue;
		}
		if (candidateCount * 100 < ring.size * 90) {
			continue;
		}
		const cr = Math.floor(candidate / 16777216);
		const cg = Math.floor((candidate - cr * 16777216) / 65536);
		const cb = Math.floor((candidate - cr * 16777216 - cg * 65536) / 256);
		candidateText = `${cr},${cg},${cb},255`;
		const stack: number[] = [];
		for (const index of ring) {
			const offset = index * 4;
			if (
				packRgba(
					pixels[offset] as number,
					pixels[offset + 1] as number,
					pixels[offset + 2] as number,
					pixels[offset + 3] as number,
				) === candidate
			) {
				stack.push(index);
			}
		}
		while (stack.length > 0) {
			const index = stack.pop() as number;
			const offset = index * 4;
			if (
				packRgba(
					pixels[offset] as number,
					pixels[offset + 1] as number,
					pixels[offset + 2] as number,
					pixels[offset + 3] as number,
				) !== candidate
			) {
				continue;
			}
			pixels[offset + 3] = 0;
			cleared += 1;
			const x = index % width;
			const y = Math.floor(index / width);
			if (x > 0) {
				stack.push(index - 1);
			}
			if (x < width - 1) {
				stack.push(index + 1);
			}
			if (y > 0) {
				stack.push(index - width);
			}
			if (y < height - 1) {
				stack.push(index + width);
			}
		}
	}
	if (cleared === 0) {
		return { stage: "background", status: "not-needed", reason: idleReason };
	}
	return {
		stage: "background",
		status: "applied",
		reason: `cleared ${cleared} backdrop pixels (${candidateText})`,
	};
}

/** Center the alpha>0 box with an integer shift (no resampling). */
function applySubject(canvas: PixelCanvas): PixelizeStageState {
	const box = contentBox(canvas);
	if (box === undefined) {
		return {
			stage: "subject",
			status: "not-needed",
			reason: "no opaque content to center",
		};
	}
	const dx = Math.floor((canvas.width - box.width) / 2) - box.x;
	const dy = Math.floor((canvas.height - box.height) / 2) - box.y;
	if (dx === 0 && dy === 0) {
		return {
			stage: "subject",
			status: "not-needed",
			reason: "subject already centered",
		};
	}
	shiftContent(canvas, dx, dy);
	return {
		stage: "subject",
		status: "applied",
		reason: `shifted subject by ${dx},${dy}`,
	};
}

/**
 * Harden semi-transparent alpha: below the threshold clears to 0, at or
 * above turns opaque. Fully transparent and opaque pixels never change,
 * and RGB (including hidden RGB) is never touched.
 */
function applyEdge(canvas: PixelCanvas, threshold: number): PixelizeStageState {
	let hardened = 0;
	for (const layer of canvas.layers) {
		const pixels = layer.pixels;
		for (let i = 3; i < pixels.length; i += 4) {
			const alpha = pixels[i] as number;
			if (alpha > 0 && alpha < 255) {
				const next = alpha < threshold ? 0 : 255;
				if (next !== alpha) {
					pixels[i] = next;
					hardened += 1;
				}
			}
		}
	}
	if (hardened === 0) {
		return {
			stage: "edge",
			status: "not-needed",
			reason: "no semi-transparent pixels changed",
		};
	}
	return {
		stage: "edge",
		status: "applied",
		reason: `hardened ${hardened} edge pixels at threshold ${threshold}`,
	};
}

function chebyshev(
	ar: number,
	ag: number,
	ab: number,
	br: number,
	bg: number,
	bb: number,
): number {
	const dr = ar > br ? ar - br : br - ar;
	const dg = ag > bg ? ag - bg : bg - ag;
	const db = ab > bb ? ab - bb : bb - ab;
	let max = dr;
	if (dg > max) {
		max = dg;
	}
	if (db > max) {
		max = db;
	}
	return max;
}

/**
 * Merge alpha>0 RGB colors within the threshold. Colors sort by coverage
 * (high first, packed RGB ascending on ties) and each one joins the
 * nearest earlier representative (Chebyshev distance, earliest on ties)
 * or founds a new one. Transparent pixels keep every byte; alpha bytes
 * never change.
 */
function applyCluster(
	canvas: PixelCanvas,
	threshold: number,
): PixelizeStageState {
	let changed = 0;
	let representatives = 0;
	for (const layer of canvas.layers) {
		const pixels = layer.pixels;
		const counts = new Map<number, number>();
		for (let i = 0; i < pixels.length; i += 4) {
			if ((pixels[i + 3] as number) > 0) {
				const key = packRgb(
					pixels[i] as number,
					pixels[i + 1] as number,
					pixels[i + 2] as number,
				);
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
		}
		const ordered = [...counts.entries()].sort((a, b) => {
			if (b[1] !== a[1]) {
				return b[1] - a[1];
			}
			return a[0] - b[0];
		});
		const reps: number[] = [];
		const target = new Map<number, number>();
		for (const [key] of ordered) {
			const r = Math.floor(key / 65536);
			const g = Math.floor((key - r * 65536) / 256);
			const b = key - r * 65536 - g * 256;
			let best = -1;
			let bestDistance = threshold + 1;
			for (let i = 0; i < reps.length; i += 1) {
				const rep = reps[i] as number;
				const rr = Math.floor(rep / 65536);
				const rg = Math.floor((rep - rr * 65536) / 256);
				const rb = rep - rr * 65536 - rg * 256;
				const distance = chebyshev(r, g, b, rr, rg, rb);
				if (distance <= threshold && distance < bestDistance) {
					best = rep;
					bestDistance = distance;
				}
			}
			if (best < 0) {
				reps.push(key);
				target.set(key, key);
			} else {
				target.set(key, best);
			}
		}
		representatives += reps.length;
		for (let i = 0; i < pixels.length; i += 4) {
			if ((pixels[i + 3] as number) > 0) {
				const key = packRgb(
					pixels[i] as number,
					pixels[i + 1] as number,
					pixels[i + 2] as number,
				);
				const next = target.get(key) as number;
				const nr = Math.floor(next / 65536);
				const ng = Math.floor((next - nr * 65536) / 256);
				const nb = next - nr * 65536 - ng * 256;
				if (
					nr !== (pixels[i] as number) ||
					ng !== (pixels[i + 1] as number) ||
					nb !== (pixels[i + 2] as number)
				) {
					pixels[i] = nr;
					pixels[i + 1] = ng;
					pixels[i + 2] = nb;
					changed += 1;
				}
			}
		}
	}
	if (changed === 0) {
		return {
			stage: "cluster",
			status: "not-needed",
			reason: "no colors merged",
		};
	}
	return {
		stage: "cluster",
		status: "applied",
		reason: `merged colors into ${representatives} representatives at threshold ${threshold}`,
	};
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
	const byStage = new Map<PixelizeStage, PixelizeStageState>();
	byStage.set("decode", {
		stage: "decode",
		status: "applied",
		reason: "decoded by the caller",
	});
	byStage.set(
		"crop",
		preset.crop
			? applyCrop(canvas)
			: {
					stage: "crop",
					status: "disabled",
					reason: `preset ${presetName} leaves crop off`,
				},
	);
	byStage.set(
		"background",
		preset.background
			? applyBackground(canvas)
			: {
					stage: "background",
					status: "disabled",
					reason: `preset ${presetName} leaves background off`,
				},
	);
	byStage.set(
		"subject",
		preset.subject
			? applySubject(canvas)
			: {
					stage: "subject",
					status: "disabled",
					reason: `preset ${presetName} leaves subject off`,
				},
	);
	resize(canvas, width, height, "nearest");
	byStage.set("resize", {
		stage: "resize",
		status: "applied",
		reason: `nearest resize to ${width}x${height}`,
	});
	byStage.set(
		"edge",
		preset.edge > 0
			? applyEdge(canvas, preset.edge)
			: {
					stage: "edge",
					status: "disabled",
					reason: `preset ${presetName} sets edge threshold 0`,
				},
	);
	let colorCount = 0;
	for (const layer of canvas.layers) {
		const quantized = quantizePixels(layer.pixels, preset.colors);
		replaceLayerPixels(canvas, layer.id, quantized.pixels);
		if (quantized.colorCount > colorCount) {
			colorCount = quantized.colorCount;
		}
	}
	byStage.set("quantize", {
		stage: "quantize",
		status: "applied",
		reason: `median-cut at ${preset.colors} colors, ${colorCount} kept`,
	});
	byStage.set(
		"cluster",
		preset.cluster > 0
			? applyCluster(canvas, preset.cluster)
			: {
					stage: "cluster",
					status: "disabled",
					reason: `preset ${presetName} sets cluster threshold 0`,
				},
	);
	for (const layer of canvas.layers) {
		fixCleanup(canvas, layer.id, { fix: [...preset.cleanupClasses] });
	}
	const cleanupList = preset.cleanupClasses.join(",");
	byStage.set("cleanup", {
		stage: "cleanup",
		status: "applied",
		reason:
			cleanupList === "" ? "no cleanup classes" : `cleanup ${cleanupList}`,
	});
	byStage.set("preset", {
		stage: "preset",
		status: "applied",
		reason: `recorded preset ${presetName}`,
	});
	byStage.set("output", {
		stage: "output",
		status: "applied",
		reason: "encoded by the caller",
	});
	const stages = PIXELIZE_STAGES.map(
		(stage) => byStage.get(stage) as PixelizeStageState,
	);
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
