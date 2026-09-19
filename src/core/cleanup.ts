import { getLayer } from "./canvas.ts";
import { McAssetError } from "./errors.ts";
import type { PixelCanvas, RGBA } from "./types.ts";

/**
 * Cleanup engine: seven defect classes over one layer.
 *
 * Detectors never write. Fixes only write the requested classes, and any
 * class that can move a pixel between fully transparent, partially
 * transparent, and opaque needs explicit render-pass authorization first;
 * without it the call fails before touching a single byte. All arithmetic
 * is integer-only and every traversal is row-major, so the same input
 * always yields the same bytes and the same report.
 */

/** Class identifiers, shared with flags and JSON reports. Fixed order. */
export const CLEANUP_CLASSES = [
	"isolated",
	"noise",
	"cluster",
	"fringe",
	"outlier",
	"hole",
	"aa",
] as const;

export type CleanupClass = (typeof CLEANUP_CLASSES)[number];

/** Every class except outlier can change alpha, hence the render pass. */
export const ALPHA_AFFECTING_CLASSES: readonly CleanupClass[] = [
	"isolated",
	"noise",
	"cluster",
	"fringe",
	"hole",
	"aa",
];

export interface CleanupPixel {
	x: number;
	y: number;
}

export type CleanupCounts = Record<CleanupClass, number>;

export type CleanupPositions = Record<CleanupClass, CleanupPixel[]>;

export interface CleanupOptions {
	/**
	 * Reference colors for outlier detection. Falls back to the canvas
	 * palette when omitted. With no reference set there is nothing to be
	 * an outlier of, so outlier detection is empty.
	 */
	palette?: readonly RGBA[];
}

export interface FixCleanupOptions extends CleanupOptions {
	/** Classes to fix. Unknown names are INVALID_ARGUMENT. Empty means report only. */
	fix: readonly CleanupClass[];
	/**
	 * Explicit authorization for classes that can change alpha semantics
	 * (everything except outlier). Missing authorization rejects the whole
	 * call with zero bytes written, including already-authorized classes.
	 */
	allowRenderPassChange?: boolean;
}

export interface CleanupDetection {
	detected: CleanupCounts;
	positions: CleanupPositions;
}

export interface CleanupResult {
	detected: CleanupCounts;
	fixed: CleanupCounts;
	/** Pixels whose final RGBA differs from the input snapshot. */
	modifiedPixels: number;
}

const CLEAR: RGBA = { r: 0, g: 0, b: 0, a: 0 };

export function isCleanupClass(value: unknown): value is CleanupClass {
	return (
		typeof value === "string" &&
		(CLEANUP_CLASSES as readonly string[]).includes(value)
	);
}

function zeroCounts(): CleanupCounts {
	return {
		isolated: 0,
		noise: 0,
		cluster: 0,
		fringe: 0,
		outlier: 0,
		hole: 0,
		aa: 0,
	};
}

function isOpaque(a: number): boolean {
	return a === 255;
}

function isTransparent(a: number): boolean {
	return a === 0;
}

function isPartial(a: number): boolean {
	return a > 0 && a < 255;
}

function sameColor(pixels: Uint8Array, a: number, b: number): boolean {
	return (
		pixels[a] === pixels[b] &&
		pixels[a + 1] === pixels[b + 1] &&
		pixels[a + 2] === pixels[b + 2] &&
		pixels[a + 3] === pixels[b + 3]
	);
}

function sortPositions(positions: CleanupPixel[]): CleanupPixel[] {
	positions.sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
	return positions;
}

function resolvePalette(canvas: PixelCanvas, options?: CleanupOptions): RGBA[] {
	if (options?.palette !== undefined) {
		return options.palette.map((color) => ({ ...color }));
	}
	if (canvas.palette !== undefined) {
		return canvas.palette.entries.map((entry) => ({ ...entry.color }));
	}
	return [];
}

/** Opaque pixel whose existing 4-neighbors are all fully transparent. */
function findIsolated(
	pixels: Uint8Array,
	width: number,
	height: number,
): CleanupPixel[] {
	const out: CleanupPixel[] = [];
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const offset = (y * width + x) * 4;
			if (!isOpaque(pixels[offset + 3])) {
				continue;
			}
			let lonely = true;
			if (x > 0 && !isTransparent(pixels[offset - 4 + 3])) {
				lonely = false;
			}
			if (x + 1 < width && !isTransparent(pixels[offset + 4 + 3])) {
				lonely = false;
			}
			if (y > 0 && !isTransparent(pixels[offset - width * 4 + 3])) {
				lonely = false;
			}
			if (y + 1 < height && !isTransparent(pixels[offset + width * 4 + 3])) {
				lonely = false;
			}
			if (lonely) {
				out.push({ x, y });
			}
		}
	}
	return out;
}

/**
 * Interior opaque pixel over a uniform opaque 8-neighborhood of a
 * different verbatim color. Border pixels have no full neighborhood,
 * so they are never noise.
 */
function findNoise(
	pixels: Uint8Array,
	width: number,
	height: number,
): CleanupPixel[] {
	const out: CleanupPixel[] = [];
	for (let y = 1; y + 1 < height; y += 1) {
		for (let x = 1; x + 1 < width; x += 1) {
			const center = (y * width + x) * 4;
			if (!isOpaque(pixels[center + 3])) {
				continue;
			}
			const first = ((y - 1) * width + (x - 1)) * 4;
			if (!isOpaque(pixels[first + 3]) || sameColor(pixels, center, first)) {
				continue;
			}
			let uniform = true;
			for (let dy = -1; dy <= 1 && uniform; dy += 1) {
				for (let dx = -1; dx <= 1; dx += 1) {
					if (dx === 0 && dy === 0) {
						continue;
					}
					const neighbor = ((y + dy) * width + (x + dx)) * 4;
					if (!sameColor(pixels, first, neighbor)) {
						uniform = false;
						break;
					}
				}
			}
			if (uniform) {
				out.push({ x, y });
			}
		}
	}
	return out;
}

/**
 * Tiny 4-connected foreground (alpha != 0) speckle of 2-4 pixels whose
 * in-bounds border is all background. Single pixels belong to isolated,
 * large fills are content; both are kept.
 */
function findCluster(
	pixels: Uint8Array,
	width: number,
	height: number,
): CleanupPixel[] {
	const visited = new Uint8Array(width * height);
	const out: CleanupPixel[] = [];
	for (let seed = 0; seed < width * height; seed += 1) {
		if (visited[seed] === 1 || pixels[seed * 4 + 3] === 0) {
			continue;
		}
		const component: number[] = [];
		const stack: number[] = [seed];
		visited[seed] = 1;
		while (stack.length > 0) {
			const current = stack.pop() as number;
			component.push(current);
			const cx = current % width;
			const cy = (current - cx) / width;
			const neighbors: number[] = [];
			if (cx > 0) {
				neighbors.push(current - 1);
			}
			if (cx + 1 < width) {
				neighbors.push(current + 1);
			}
			if (cy > 0) {
				neighbors.push(current - width);
			}
			if (cy + 1 < height) {
				neighbors.push(current + width);
			}
			for (const next of neighbors) {
				if (visited[next] === 1 || pixels[next * 4 + 3] === 0) {
					continue;
				}
				visited[next] = 1;
				stack.push(next);
			}
		}
		if (component.length < 2 || component.length > 4) {
			continue;
		}
		const member = new Set(component);
		let enclosed = true;
		for (const cell of component) {
			const cx = cell % width;
			const cy = (cell - cx) / width;
			const border: number[] = [];
			if (cx > 0) {
				border.push(cell - 1);
			}
			if (cx + 1 < width) {
				border.push(cell + 1);
			}
			if (cy > 0) {
				border.push(cell - width);
			}
			if (cy + 1 < height) {
				border.push(cell + width);
			}
			for (const next of border) {
				if (!member.has(next) && pixels[next * 4 + 3] !== 0) {
					enclosed = false;
					break;
				}
			}
			if (!enclosed) {
				break;
			}
		}
		if (enclosed) {
			for (const cell of component) {
				const cx = cell % width;
				out.push({ x: cx, y: (cell - cx) / width });
			}
		}
	}
	return sortPositions(out);
}

/**
 * Partial pixel whose existing 4-neighbors are all opaque: a
 * semi-transparent speck stuck inside solid fill. Partials touching
 * transparency are aa instead, so the two classes never overlap.
 */
function findFringe(
	pixels: Uint8Array,
	width: number,
	height: number,
): CleanupPixel[] {
	const out: CleanupPixel[] = [];
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const offset = (y * width + x) * 4;
			if (!isPartial(pixels[offset + 3])) {
				continue;
			}
			let count = 0;
			let opaque = 0;
			if (x > 0) {
				count += 1;
				if (isOpaque(pixels[offset - 4 + 3])) {
					opaque += 1;
				}
			}
			if (x + 1 < width) {
				count += 1;
				if (isOpaque(pixels[offset + 4 + 3])) {
					opaque += 1;
				}
			}
			if (y > 0) {
				count += 1;
				if (isOpaque(pixels[offset - width * 4 + 3])) {
					opaque += 1;
				}
			}
			if (y + 1 < height) {
				count += 1;
				if (isOpaque(pixels[offset + width * 4 + 3])) {
					opaque += 1;
				}
			}
			if (count > 0 && opaque === count) {
				out.push({ x, y });
			}
		}
	}
	return out;
}

/**
 * Visible pixel whose RGB matches no palette entry. Alpha is ignored
 * for detection and never changed by the fix. Transparent pixels keep
 * their hidden RGB untouched.
 */
function findOutlier(
	pixels: Uint8Array,
	width: number,
	height: number,
	palette: readonly RGBA[],
): CleanupPixel[] {
	const out: CleanupPixel[] = [];
	if (palette.length === 0) {
		return out;
	}
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const offset = (y * width + x) * 4;
			if (pixels[offset + 3] === 0) {
				continue;
			}
			const r = pixels[offset];
			const g = pixels[offset + 1];
			const b = pixels[offset + 2];
			let known = false;
			for (const entry of palette) {
				if (entry.r === r && entry.g === g && entry.b === b) {
					known = true;
					break;
				}
			}
			if (!known) {
				out.push({ x, y });
			}
		}
	}
	return out;
}

/**
 * Fully transparent pixel with all four neighbors in bounds and opaque:
 * a 1px pinhole. Border and multi-pixel openings are kept.
 */
function findHole(
	pixels: Uint8Array,
	width: number,
	height: number,
): CleanupPixel[] {
	const out: CleanupPixel[] = [];
	for (let y = 1; y + 1 < height; y += 1) {
		for (let x = 1; x + 1 < width; x += 1) {
			const offset = (y * width + x) * 4;
			if (!isTransparent(pixels[offset + 3])) {
				continue;
			}
			if (
				isOpaque(pixels[offset - 4 + 3]) &&
				isOpaque(pixels[offset + 4 + 3]) &&
				isOpaque(pixels[offset - width * 4 + 3]) &&
				isOpaque(pixels[offset + width * 4 + 3])
			) {
				out.push({ x, y });
			}
		}
	}
	return out;
}

/**
 * Opaque vs fully-transparent 4-neighbor tally for one pixel, skipping
 * every neighbor that is out of bounds. Callers must use this same tally
 * for detection and for the aa fix; the horizontal guards are load-bearing
 * because a raw index step at x = 0 or x = width - 1 stays inside the
 * buffer and would fold back onto the previous/next row instead of
 * failing loudly.
 */
function aaNeighborVotes(
	pixels: Uint8Array,
	width: number,
	height: number,
	x: number,
	y: number,
): { opaque: number; clear: number } {
	const offset = (y * width + x) * 4;
	let opaque = 0;
	let clear = 0;
	if (x > 0) {
		const alpha = pixels[offset - 4 + 3] as number;
		if (isOpaque(alpha)) {
			opaque += 1;
		} else if (isTransparent(alpha)) {
			clear += 1;
		}
	}
	if (x + 1 < width) {
		const alpha = pixels[offset + 4 + 3] as number;
		if (isOpaque(alpha)) {
			opaque += 1;
		} else if (isTransparent(alpha)) {
			clear += 1;
		}
	}
	if (y > 0) {
		const alpha = pixels[offset - width * 4 + 3] as number;
		if (isOpaque(alpha)) {
			opaque += 1;
		} else if (isTransparent(alpha)) {
			clear += 1;
		}
	}
	if (y + 1 < height) {
		const alpha = pixels[offset + width * 4 + 3] as number;
		if (isOpaque(alpha)) {
			opaque += 1;
		} else if (isTransparent(alpha)) {
			clear += 1;
		}
	}
	return { opaque, clear };
}

/**
 * Partial pixel with at least one opaque and one fully transparent
 * 4-neighbor: an unwanted blend step on a hard edge.
 */
function findAA(
	pixels: Uint8Array,
	width: number,
	height: number,
): CleanupPixel[] {
	const out: CleanupPixel[] = [];
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const offset = (y * width + x) * 4;
			if (!isPartial(pixels[offset + 3])) {
				continue;
			}
			const { opaque, clear } = aaNeighborVotes(pixels, width, height, x, y);
			if (opaque > 0 && clear > 0) {
				out.push({ x, y });
			}
		}
	}
	return out;
}

/** Squared RGB distance: integer-only, no roots needed for comparison. */
function nearestPaletteIndex(
	palette: readonly RGBA[],
	r: number,
	g: number,
	b: number,
): number {
	let best = 0;
	let bestDistance = 0;
	for (let i = 0; i < palette.length; i += 1) {
		const entry = palette[i] as RGBA;
		const dr = r - entry.r;
		const dg = g - entry.g;
		const db = b - entry.b;
		const distance = dr * dr + dg * dg + db * db;
		if (i === 0 || distance < bestDistance) {
			best = i;
			bestDistance = distance;
		}
	}
	return best;
}

/** Replacement color derived from the input snapshot, never from live edits. */
function replacementFor(
	name: CleanupClass,
	before: Uint8Array,
	width: number,
	height: number,
	palette: readonly RGBA[],
	x: number,
	y: number,
): RGBA {
	const offset = (y * width + x) * 4;
	switch (name) {
		case "isolated":
		case "cluster":
		case "noise": {
			if (name === "noise") {
				const north = offset - width * 4;
				return {
					r: before[north] as number,
					g: before[north + 1] as number,
					b: before[north + 2] as number,
					a: before[north + 3] as number,
				};
			}
			return { ...CLEAR };
		}
		case "fringe": {
			return {
				r: before[offset] as number,
				g: before[offset + 1] as number,
				b: before[offset + 2] as number,
				a: 255,
			};
		}
		case "outlier": {
			const index = nearestPaletteIndex(
				palette,
				before[offset] as number,
				before[offset + 1] as number,
				before[offset + 2] as number,
			);
			const entry = palette[index] as RGBA;
			return {
				r: entry.r,
				g: entry.g,
				b: entry.b,
				a: before[offset + 3] as number,
			};
		}
		case "hole": {
			const r =
				(((before[offset - 4] as number) +
					(before[offset + 4] as number) +
					(before[offset - width * 4] as number) +
					(before[offset + width * 4] as number)) /
					4) |
				0;
			const g =
				(((before[offset - 4 + 1] as number) +
					(before[offset + 4 + 1] as number) +
					(before[offset - width * 4 + 1] as number) +
					(before[offset + width * 4 + 1] as number)) /
					4) |
				0;
			const b =
				(((before[offset - 4 + 2] as number) +
					(before[offset + 4 + 2] as number) +
					(before[offset - width * 4 + 2] as number) +
					(before[offset + width * 4 + 2] as number)) /
					4) |
				0;
			return { r, g, b, a: 255 };
		}
		case "aa": {
			const { opaque, clear } = aaNeighborVotes(before, width, height, x, y);
			if (opaque >= clear) {
				return {
					r: before[offset] as number,
					g: before[offset + 1] as number,
					b: before[offset + 2] as number,
					a: 255,
				};
			}
			return {
				r: before[offset] as number,
				g: before[offset + 1] as number,
				b: before[offset + 2] as number,
				a: 0,
			};
		}
	}
}

function detectOnBuffer(
	before: Uint8Array,
	width: number,
	height: number,
	palette: readonly RGBA[],
): CleanupPositions {
	return {
		isolated: findIsolated(before, width, height),
		noise: findNoise(before, width, height),
		cluster: findCluster(before, width, height),
		fringe: findFringe(before, width, height),
		outlier: findOutlier(before, width, height, palette),
		hole: findHole(before, width, height),
		aa: findAA(before, width, height),
	};
}

function countsOf(positions: CleanupPositions): CleanupCounts {
	const counts = zeroCounts();
	for (const name of CLEANUP_CLASSES) {
		counts[name] = positions[name].length;
	}
	return counts;
}

export function detectIsolated(
	canvas: PixelCanvas,
	layerId: string,
): CleanupPixel[] {
	const layer = getLayer(canvas, layerId);
	return findIsolated(layer.pixels, canvas.width, canvas.height);
}

export function detectNoise(
	canvas: PixelCanvas,
	layerId: string,
): CleanupPixel[] {
	const layer = getLayer(canvas, layerId);
	return findNoise(layer.pixels, canvas.width, canvas.height);
}

export function detectCluster(
	canvas: PixelCanvas,
	layerId: string,
): CleanupPixel[] {
	const layer = getLayer(canvas, layerId);
	return findCluster(layer.pixels, canvas.width, canvas.height);
}

export function detectFringe(
	canvas: PixelCanvas,
	layerId: string,
): CleanupPixel[] {
	const layer = getLayer(canvas, layerId);
	return findFringe(layer.pixels, canvas.width, canvas.height);
}

export function detectOutlier(
	canvas: PixelCanvas,
	layerId: string,
	options?: CleanupOptions,
): CleanupPixel[] {
	const layer = getLayer(canvas, layerId);
	return findOutlier(
		layer.pixels,
		canvas.width,
		canvas.height,
		resolvePalette(canvas, options),
	);
}

export function detectHole(
	canvas: PixelCanvas,
	layerId: string,
): CleanupPixel[] {
	const layer = getLayer(canvas, layerId);
	return findHole(layer.pixels, canvas.width, canvas.height);
}

export function detectAA(canvas: PixelCanvas, layerId: string): CleanupPixel[] {
	const layer = getLayer(canvas, layerId);
	return findAA(layer.pixels, canvas.width, canvas.height);
}

/** Read-only pass over every class. Never writes. */
export function detectCleanup(
	canvas: PixelCanvas,
	layerId: string,
	options?: CleanupOptions,
): CleanupDetection {
	const layer = getLayer(canvas, layerId);
	const positions = detectOnBuffer(
		layer.pixels,
		canvas.width,
		canvas.height,
		resolvePalette(canvas, options),
	);
	return { detected: countsOf(positions), positions };
}

/**
 * Fix the requested classes. Unknown names and missing render-pass
 * authorization both fail with INVALID_ARGUMENT before any byte is
 * written. Fixes are derived from the input snapshot in fixed class
 * order, so overlapping classes resolve deterministically.
 */
export function fixCleanup(
	canvas: PixelCanvas,
	layerId: string,
	options: FixCleanupOptions,
): CleanupResult {
	const layer = getLayer(canvas, layerId);
	const requested: CleanupClass[] = [];
	for (const name of options.fix) {
		if (!isCleanupClass(name)) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				`Unknown cleanup class: ${String(name)}.`,
				{ class: String(name) },
			);
		}
		if (!requested.includes(name)) {
			requested.push(name);
		}
	}
	const ordered = CLEANUP_CLASSES.filter((name) => requested.includes(name));
	const unauthorized = ordered.filter((name) =>
		(ALPHA_AFFECTING_CLASSES as readonly string[]).includes(name),
	);
	if (unauthorized.length > 0 && options.allowRenderPassChange !== true) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Cleanup classes that can change the render pass need explicit authorization.",
			{ classes: [...unauthorized] },
		);
	}
	const width = canvas.width;
	const height = canvas.height;
	const palette = resolvePalette(canvas, options);
	const before = layer.pixels.slice();
	const positions = detectOnBuffer(before, width, height, palette);
	const fixed = zeroCounts();
	for (const name of ordered) {
		for (const pixel of positions[name]) {
			const next = replacementFor(
				name,
				before,
				width,
				height,
				palette,
				pixel.x,
				pixel.y,
			);
			const offset = (pixel.y * width + pixel.x) * 4;
			if (
				next.r !== before[offset] ||
				next.g !== before[offset + 1] ||
				next.b !== before[offset + 2] ||
				next.a !== before[offset + 3]
			) {
				fixed[name] += 1;
			}
			layer.pixels[offset] = next.r;
			layer.pixels[offset + 1] = next.g;
			layer.pixels[offset + 2] = next.b;
			layer.pixels[offset + 3] = next.a;
		}
	}
	let modifiedPixels = 0;
	for (let i = 0; i < before.length; i += 4) {
		if (
			layer.pixels[i] !== before[i] ||
			layer.pixels[i + 1] !== before[i + 1] ||
			layer.pixels[i + 2] !== before[i + 2] ||
			layer.pixels[i + 3] !== before[i + 3]
		) {
			modifiedPixels += 1;
		}
	}
	return { detected: countsOf(positions), fixed, modifiedPixels };
}
