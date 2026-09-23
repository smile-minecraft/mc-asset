import { applyOperations, type BatchOperation } from "../core/batch.ts";
import { addLayer, createCanvas, replaceLayerPixels } from "../core/canvas.ts";
import { McAssetError } from "../core/errors.ts";
import {
	evaluateSelectionExpr,
	parseSelectionExprValue,
	type SelectionExpr,
} from "../core/selection.ts";
import type { PixelCanvas, Rect } from "../core/types.ts";
import { assertValidCanvas } from "../core/validate.ts";
import { encodePng, flattenCanvas } from "../io/png.ts";

/**
 * Structure/view inspection plus apply feedback and diff summaries.
 * Pure and read-only: canvases are only read (through copies), never
 * written. No I/O, no timestamps, no randomness, integer arithmetic only.
 *
 * Guides (coordinate grids, transparency checkers) never enter this
 * module: view and feedback images are the composited artwork pixels,
 * cropped and nearest-scaled, with no overlay paint of any kind.
 */

/** View and feedback outputs refuse any edge beyond this many pixels. */
export const INSPECT_MAX_EDGE = 1024;

/** Layer colorUsage lists at most this many entries, frequency ordered. */
export const INSPECT_TOP_COLORS = 16;

/** Fixed color format reported by every view metadata object. */
export const INSPECT_COLOR_FORMAT = "RGBA8";

export interface InspectTopColor {
	rgba: string;
	count: number;
}

export interface InspectColorUsage {
	uniqueColors: number;
	transparentPixels: number;
	topColors: InspectTopColor[];
	truncated: boolean;
}

export interface InspectLayerEntry {
	id: string;
	name: string;
	index: number;
	bounds: Rect | null;
	area: number;
	visible: boolean;
	opacity: number;
	blendMode: string;
	colorUsage: InspectColorUsage;
}

export interface InspectRegionEntry {
	id: string;
	name: string;
	index: number;
	bounds: Rect | null;
	area: number;
}

export interface InspectOverlaps {
	layerBounds: Array<{ layerIds: [string, string]; bounds: Rect }>;
	regionPixels: Array<{ regionIds: [string, string]; pixelCount: number }>;
}

export interface InspectStructureReport {
	mode: "structure";
	width: number;
	height: number;
	layers: InspectLayerEntry[];
	regions: InspectRegionEntry[];
	overlaps: InspectOverlaps;
}

export interface InspectViewMetadata {
	mode: "view";
	sourceDimensions: { width: number; height: number };
	crop: Rect;
	scale: number;
	outputDimensions: { width: number; height: number };
	colorFormat: "RGBA8";
}

export interface InspectView {
	pngBytes: Uint8Array;
	metadata: InspectViewMetadata;
}

export interface PixelDifference {
	changedPixels: number;
	bounds: Rect | null;
}

export interface StructuralDifference {
	added: string[];
	removed: string[];
	modified: string[];
}

export interface DiffSummary {
	raw: PixelDifference;
	composited: PixelDifference;
	structural: StructuralDifference;
	outsideSelectionUnchanged: boolean;
}

export interface FeedbackRequest {
	image?: "none" | "full" | "changed";
	scale?: number;
	crop?: unknown;
	diff?: "none" | "summary";
}

export interface FeedbackImageResult {
	image: "none" | "full" | "changed";
	imageIncluded: boolean;
	noVisibleChange?: true;
	diff?: DiffSummary;
}

export interface FeedbackResult {
	feedback: FeedbackImageResult;
	pngBytes?: Uint8Array;
}

function byteToHex(value: number): string {
	return value.toString(16).padStart(2, "0").toUpperCase();
}

function rgbaHex(r: number, g: number, b: number, a: number): string {
	return `#${byteToHex(r)}${byteToHex(g)}${byteToHex(b)}${byteToHex(a)}`;
}

function compareStrings(left: string, right: string): number {
	if (left < right) {
		return -1;
	}
	if (left > right) {
		return 1;
	}
	return 0;
}

function tightBounds(
	width: number,
	height: number,
	inside: (x: number, y: number) => boolean,
	count: number,
): Rect | null {
	if (count === 0) {
		return null;
	}
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			if (!inside(x, y)) {
				continue;
			}
			if (x < minX) {
				minX = x;
			}
			if (x > maxX) {
				maxX = x;
			}
			if (y < minY) {
				minY = y;
			}
			if (y > maxY) {
				maxY = y;
			}
		}
	}
	return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Frozen structure report: layers carry bounds, area, visibility, and raw
 * RGBA color usage (hidden RGB under alpha zero counts); regions carry
 * identity, bounds, and area only, never color or visibility. Overlaps
 * compare layer bounding boxes (not actual alpha coincidence) and real
 * region-mask intersections.
 */
export function inspectStructure(canvas: PixelCanvas): InspectStructureReport {
	assertValidCanvas(canvas);
	const layers: InspectLayerEntry[] = canvas.layers.map((layer, index) => {
		const pixels = layer.pixels;
		const counts = new Map<number, number>();
		let area = 0;
		let transparentPixels = 0;
		for (let i = 0; i < pixels.length; i += 4) {
			const r = pixels[i] as number;
			const g = pixels[i + 1] as number;
			const b = pixels[i + 2] as number;
			const a = pixels[i + 3] as number;
			if (a !== 0) {
				area += 1;
			} else {
				transparentPixels += 1;
			}
			const key = r * 16777216 + g * 65536 + b * 256 + a;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		const ranked = [...counts].map(([key, count]) => {
			const r = (key - (key % 16777216)) / 16777216;
			const rest = key - r * 16777216;
			const g = (rest - (rest % 65536)) / 65536;
			const rest2 = rest - g * 65536;
			const b = (rest2 - (rest2 % 256)) / 256;
			const a = rest2 - b * 256;
			return { rgba: rgbaHex(r, g, b, a), count };
		});
		ranked.sort((left, right) => {
			if (right.count !== left.count) {
				return right.count - left.count;
			}
			return compareStrings(left.rgba, right.rgba);
		});
		const width = canvas.width;
		const height = canvas.height;
		return {
			id: layer.id,
			name: layer.name ?? layer.id,
			index,
			bounds: tightBounds(
				width,
				height,
				(x, y) => {
					return pixels[(y * width + x) * 4 + 3] !== 0;
				},
				area,
			),
			area,
			visible: layer.visible,
			opacity: layer.opacity,
			blendMode: layer.blendMode,
			colorUsage: {
				uniqueColors: counts.size,
				transparentPixels,
				topColors: ranked.slice(0, INSPECT_TOP_COLORS),
				truncated: counts.size > INSPECT_TOP_COLORS,
			},
		};
	});
	const regions: InspectRegionEntry[] = canvas.regions.map((region, index) => {
		let area = 0;
		for (let i = 0; i < region.mask.length; i += 1) {
			if (region.mask[i] === 1) {
				area += 1;
			}
		}
		const width = canvas.width;
		return {
			id: region.id,
			name: region.name ?? region.id,
			index,
			bounds: tightBounds(
				width,
				canvas.height,
				(x, y) => {
					return region.mask[y * width + x] === 1;
				},
				area,
			),
			area,
		};
	});
	const layerBounds: InspectOverlaps["layerBounds"] = [];
	for (let i = 0; i < layers.length; i += 1) {
		for (let j = i + 1; j < layers.length; j += 1) {
			const a = (layers[i] as InspectLayerEntry).bounds;
			const b = (layers[j] as InspectLayerEntry).bounds;
			if (a === null || b === null) {
				continue;
			}
			const hit = rectIntersection(a, b);
			if (hit !== null) {
				layerBounds.push({
					layerIds: [
						(layers[i] as InspectLayerEntry).id,
						(layers[j] as InspectLayerEntry).id,
					],
					bounds: hit,
				});
			}
		}
	}
	const regionPixels: InspectOverlaps["regionPixels"] = [];
	for (let i = 0; i < canvas.regions.length; i += 1) {
		for (let j = i + 1; j < canvas.regions.length; j += 1) {
			const a = canvas.regions[i] as { id: string; mask: Uint8Array };
			const b = canvas.regions[j] as { id: string; mask: Uint8Array };
			let pixelCount = 0;
			for (let k = 0; k < a.mask.length; k += 1) {
				if (a.mask[k] === 1 && b.mask[k] === 1) {
					pixelCount += 1;
				}
			}
			if (pixelCount > 0) {
				regionPixels.push({ regionIds: [a.id, b.id], pixelCount });
			}
		}
	}
	return {
		mode: "structure",
		width: canvas.width,
		height: canvas.height,
		layers,
		regions,
		overlaps: { layerBounds, regionPixels },
	};
}

function rectIntersection(a: Rect, b: Rect): Rect | null {
	const x = a.x > b.x ? a.x : b.x;
	const y = a.y > b.y ? a.y : b.y;
	const farX = a.x + a.width < b.x + b.width ? a.x + a.width : b.x + b.width;
	const farY =
		a.y + a.height < b.y + b.height ? a.y + a.height : b.y + b.height;
	if (farX <= x || farY <= y) {
		return null;
	}
	return { x, y, width: farX - x, height: farY - y };
}

function parseJsonOffset(error: unknown): number | undefined {
	const message = error instanceof Error ? error.message : String(error);
	const match = /position (\d+)/.exec(message);
	if (match === null || match[1] === undefined) {
		return undefined;
	}
	return Number(match[1]);
}

/**
 * Normalize a crop-style SelectionExpr input: an atom string, a JSON AST
 * string (exact leading `{`, no trim, same dispatch as --selection), or a
 * parsed JSON object. Anything else is INVALID_ARGUMENT.
 */
export function normalizeSelectionInput(
	value: unknown,
	basePath: string,
): SelectionExpr | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value === "string") {
		if (value.length === 0) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"Selection expression must be a non-empty atom string or an expression object.",
				{ path: basePath },
			);
		}
		if (value[0] === "{") {
			let parsed: unknown;
			try {
				parsed = JSON.parse(value);
			} catch (error) {
				const details: Record<string, unknown> = { selection: value };
				const offset = parseJsonOffset(error);
				if (offset !== undefined) {
					details.offset = offset;
				}
				throw new McAssetError(
					"INVALID_ARGUMENT",
					"Selection JSON is not parseable; pass an atom string or a JSON expression object.",
					details,
				);
			}
			return parseSelectionExprValue(parsed, basePath);
		}
		return value;
	}
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return parseSelectionExprValue(value, basePath);
	}
	throw new McAssetError(
		"INVALID_ARGUMENT",
		"Selection expression must be an atom string or an expression object with op and operands.",
		{ path: basePath },
	);
}

/** Explicit scales are integers in [1, 16] with nearest sampling. */
export function normalizeViewScale(value: unknown): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Scale must be an integer in [1, 16] with nearest sampling, without rounding.",
			{ scale: value },
		);
	}
	if (value < 1 || value > 16) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Scale must be an integer in [1, 16]; larger views need a crop first.",
			{ scale: value },
		);
	}
	return value;
}

/**
 * Frozen auto-scale rule over the pre-scale long edge: 128-512 stays 1,
 * below 128 takes the smallest integer multiple reaching 128 (capped at
 * 16), above 512 never downsamples silently and stays 1.
 */
export function resolveFeedbackScale(
	cropWidth: number,
	cropHeight: number,
	explicit: number | undefined,
): number {
	if (explicit !== undefined) {
		return normalizeViewScale(explicit) as number;
	}
	const long = cropWidth > cropHeight ? cropWidth : cropHeight;
	if (long >= 128) {
		return 1;
	}
	let scale = 1;
	while (scale < 16 && long * scale < 128) {
		scale += 1;
	}
	return scale;
}

/**
 * Crop composited pixels and nearest-scale them into a PNG. The only
 * pixels in the output are replicated artwork pixels: no grid, no
 * checker, no overlay of any kind. Outputs beyond the 1024px edge refuse
 * with RESOURCE_LIMIT_EXCEEDED and a crop hint instead of downsampling.
 */
export function renderFlatRegion(
	flat: Uint8Array,
	sourceWidth: number,
	rect: Rect,
	scale: number,
): { pngBytes: Uint8Array; width: number; height: number } {
	const width = rect.width * scale;
	const height = rect.height * scale;
	if (width > INSPECT_MAX_EDGE || height > INSPECT_MAX_EDGE) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			`View output ${width}x${height} exceeds the ${INSPECT_MAX_EDGE}px edge limit; pass a smaller crop to stay within it.`,
			{ width, height, limit: INSPECT_MAX_EDGE },
		);
	}
	const out = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		const sourceY = rect.y + (y - (y % scale)) / scale;
		for (let x = 0; x < width; x += 1) {
			const sourceX = rect.x + (x - (x % scale)) / scale;
			const from = (sourceY * sourceWidth + sourceX) * 4;
			const to = (y * width + x) * 4;
			out[to] = flat[from] as number;
			out[to + 1] = flat[from + 1] as number;
			out[to + 2] = flat[from + 2] as number;
			out[to + 3] = flat[from + 3] as number;
		}
	}
	const view = createCanvas(width, height);
	const layer = addLayer(view, { id: "base" });
	replaceLayerPixels(view, layer.id, out);
	return { pngBytes: encodePng(view), width, height };
}

export interface InspectViewOptions {
	crop?: unknown;
	scale?: number;
	/**
	 * Feedback-only switch: an omitted scale follows the frozen long-edge
	 * auto rule instead of the view default of 1. Inspect views never set
	 * this; only the feedback assembly opts in.
	 */
	autoScale?: boolean;
}

/**
 * Resolve a view crop against a canvas: absent means the full canvas, a
 * present expression resolves through the selection engine, and an empty
 * match refuses with EMPTY_SELECTION.
 */
function resolveViewCrop(canvas: PixelCanvas, crop: unknown): Rect {
	const expr = normalizeSelectionInput(crop, "crop");
	if (expr === undefined) {
		return { x: 0, y: 0, width: canvas.width, height: canvas.height };
	}
	const resolved = evaluateSelectionExpr(canvas, expr, "crop");
	if (resolved.count === 0) {
		throw new McAssetError(
			"EMPTY_SELECTION",
			"View crop matched no pixels; narrow the crop expression or drop it.",
			{ crop },
		);
	}
	return resolved.bounds as Rect;
}

/**
 * Read-only composited view: the default scale is 1 and only an explicit
 * 1-16 integer scales with nearest sampling. Feedback rendering opts
 * into the frozen long-edge auto rule through autoScale. Never writes
 * the source.
 */
export function renderInspectView(
	canvas: PixelCanvas,
	options: InspectViewOptions,
): InspectView {
	assertValidCanvas(canvas);
	const cropRect = resolveViewCrop(canvas, options.crop);
	let scale: number;
	if (options.scale === undefined) {
		scale =
			options.autoScale === true
				? resolveFeedbackScale(cropRect.width, cropRect.height, undefined)
				: 1;
	} else {
		scale = normalizeViewScale(options.scale) as number;
	}
	const rendered = renderFlatRegion(
		flattenCanvas(canvas),
		canvas.width,
		cropRect,
		scale,
	);
	return {
		pngBytes: rendered.pngBytes,
		metadata: {
			mode: "view",
			sourceDimensions: { width: canvas.width, height: canvas.height },
			crop: { ...cropRect },
			scale,
			outputDimensions: { width: rendered.width, height: rendered.height },
			colorFormat: INSPECT_COLOR_FORMAT,
		},
	};
}

/** Detached deep copy of the pixel and mask buffers for before/after diffing. */
export function snapshotCanvas(canvas: PixelCanvas): PixelCanvas {
	assertValidCanvas(canvas);
	return {
		version: canvas.version,
		width: canvas.width,
		height: canvas.height,
		layers: canvas.layers.map((layer) => ({
			id: layer.id,
			...(layer.name === undefined ? {} : { name: layer.name }),
			pixels: layer.pixels.slice(),
			visible: layer.visible,
			opacity: layer.opacity,
			blendMode: layer.blendMode,
			...(layer.metadata === undefined
				? {}
				: { metadata: { ...layer.metadata } }),
		})),
		regions: canvas.regions.map((region) => ({
			id: region.id,
			...(region.name === undefined ? {} : { name: region.name }),
			mask: region.mask.slice(),
			...(region.metadata === undefined
				? {}
				: { metadata: { ...region.metadata } }),
		})),
		...(canvas.palette === undefined
			? {}
			: {
					palette: {
						entries: canvas.palette.entries.map((entry) => ({
							id: entry.id,
							color: { ...entry.color },
							...(entry.role === undefined ? {} : { role: entry.role }),
							...(entry.metadata === undefined
								? {}
								: { metadata: { ...entry.metadata } }),
						})),
					},
				}),
		metadata: { ...canvas.metadata },
	};
}

function differenceOf(
	width: number,
	height: number,
	same: (x: number, y: number) => boolean,
	total: number,
): PixelDifference {
	if (total === 0) {
		return { changedPixels: 0, bounds: null };
	}
	return {
		changedPixels: total,
		bounds: tightBounds(width, height, (x, y) => !same(x, y), total),
	};
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}

function fullMask(width: number, height: number): Uint8Array {
	return new Uint8Array(width * height).fill(1);
}

function orIntoMask(target: Uint8Array, part: Uint8Array): void {
	for (let i = 0; i < target.length; i += 1) {
		if (part[i] === 1) {
			target[i] = 1;
		}
	}
}

function clippedRectMask(
	width: number,
	height: number,
	rect: Rect,
): Uint8Array {
	const mask = new Uint8Array(width * height);
	const fromX = rect.x > 0 ? rect.x : 0;
	const fromY = rect.y > 0 ? rect.y : 0;
	const toX = rect.x + rect.width < width ? rect.x + rect.width : width;
	const toY = rect.y + rect.height < height ? rect.y + rect.height : height;
	for (let y = fromY; y < toY; y += 1) {
		for (let x = fromX; x < toX; x += 1) {
			mask[y * width + x] = 1;
		}
	}
	return mask;
}

function unionInto(
	scopes: Map<string, Uint8Array>,
	layerId: string,
	part: Uint8Array,
): void {
	const existing = scopes.get(layerId);
	if (existing === undefined) {
		scopes.set(layerId, part.slice());
		return;
	}
	orIntoMask(existing, part);
}

interface WriteScopes {
	/** Per-layer write masks over the after canvas. */
	scopes: Map<string, Uint8Array>;
	/** True once any operation declares a selection read or write scope. */
	hasDeclaredScopes: boolean;
}

/**
 * Per-layer write scopes captured at each operation's execution point. A
 * scratch replay of the before canvas advances through the real batch
 * entry in order, so every selection evaluates against the exact state
 * its operation saw: content-dependent atoms (alpha, color, connected,
 * region) resolve pre-write masks even when the write itself moves those
 * contents. Pixel ops contribute their selection mask (or the whole layer
 * when unscoped, which makes that layer's outside vacuously empty);
 * stampRect contributes its transformed destination footprint clipped by
 * its write selection while its source stays read-only; whole-layer
 * writers (fill, clear, move, merge target) contribute the whole layer.
 * Region and layer membership ops write no pixels. Replay reuses the
 * real batch entry, so its states match execution by determinism. A failed
 * entry contributes no scope and the replay stays at its pre-write state,
 * exactly as non-atomic partial execution does, so operations after a
 * failure still see the state they saw at execution time. Duplicate
 * operation ids mirror the batch: the second occurrence fails without
 * writing, so it contributes no scope and advances no state.
 */
function computeWriteScopes(
	before: PixelCanvas,
	operations: BatchOperation[],
): WriteScopes {
	const replay = snapshotCanvas(before);
	const scopes = new Map<string, Uint8Array>();
	let hasDeclaredScopes = false;
	const width = replay.width;
	const height = replay.height;
	const seenIds = new Set<string>();
	for (const op of operations) {
		const rawId =
			typeof op === "object" && op !== null
				? (op as unknown as Record<string, unknown>).id
				: undefined;
		if (typeof rawId === "string") {
			if (seenIds.has(rawId)) {
				continue;
			}
			seenIds.add(rawId);
		}
		// Failed entries contribute no scope: snapshot the masks (deep, as
		// union mutates buffers in place) so a later failure rolls back to
		// the pre-entry state. The single-entry replay already rolls its own
		// pixels back on failure, matching validated ops that write nothing
		// before throwing.
		const scopesSnapshot = new Map<string, Uint8Array>();
		for (const [layerId, mask] of scopes) {
			scopesSnapshot.set(layerId, mask.slice());
		}
		const declaredSnapshot: boolean = hasDeclaredScopes;
		try {
			switch (op.type) {
				case "setPixel":
				case "clearPixel":
				case "drawLine":
				case "drawRect":
				case "fillRect":
				case "floodFill": {
					if (op.selection === undefined) {
						unionInto(scopes, op.layerId, fullMask(width, height));
						break;
					}
					hasDeclaredScopes = true;
					unionInto(
						scopes,
						op.layerId,
						evaluateSelectionExpr(replay, op.selection, "selection").mask,
					);
					break;
				}
				case "stampRect": {
					hasDeclaredScopes = true;
					const read = evaluateSelectionExpr(replay, op.source, "source");
					if (read.count > 0) {
						const bounds = read.bounds as Rect;
						const rotate = op.transform?.rotate ?? 0;
						let outWidth = bounds.width;
						let outHeight = bounds.height;
						if (rotate === 90 || rotate === 270) {
							outWidth = bounds.height;
							outHeight = bounds.width;
						}
						const origin =
							op.to !== undefined
								? { x: op.to.x, y: op.to.y }
								: {
										x: bounds.x + (op.offset as { dx: number }).dx,
										y: bounds.y + (op.offset as { dy: number }).dy,
									};
						const footprint = clippedRectMask(width, height, {
							x: origin.x,
							y: origin.y,
							width: outWidth,
							height: outHeight,
						});
						if (op.selection !== undefined) {
							const clip = evaluateSelectionExpr(
								replay,
								op.selection,
								"selection",
							).mask;
							for (let i = 0; i < footprint.length; i += 1) {
								if (clip[i] !== 1) {
									footprint[i] = 0;
								}
							}
						}
						unionInto(scopes, op.layerId, footprint);
					}
					break;
				}
				case "fillLayer":
				case "clearLayer":
				case "moveLayer": {
					unionInto(scopes, op.layerId, fullMask(width, height));
					break;
				}
				case "mergeLayer": {
					unionInto(scopes, op.targetId, fullMask(width, height));
					break;
				}
				case "regionFromSelection": {
					hasDeclaredScopes = true;
					break;
				}
				default: {
					break;
				}
			}
			// Advance the replay through the real entry so the next scope sees
			// the post-write state, exactly as execution did.
			applyOperations(replay, [op], { atomic: true });
		} catch {
			scopes.clear();
			for (const [layerId, mask] of scopesSnapshot) {
				scopes.set(layerId, mask);
			}
			hasDeclaredScopes = declaredSnapshot;
		}
	}
	return { scopes, hasDeclaredScopes };
}

/**
 * Three-way diff of a before snapshot against the after canvas. Raw
 * compares shared-layer RGBA bytes (hidden RGB included); composited
 * compares the flattened visible pixels; structural tracks layer, region,
 * palette, and metadata membership. The self check compares raw RGBA
 * outside the declared write scopes; with no declarations it is true.
 */
export function diffCanvases(
	before: PixelCanvas,
	after: PixelCanvas,
	operations: BatchOperation[],
): DiffSummary {
	assertValidCanvas(before);
	assertValidCanvas(after);
	if (before.width !== after.width || before.height !== after.height) {
		throw new McAssetError(
			"INTERNAL_ERROR",
			"Diff inputs must share canvas dimensions.",
			{ before: { width: before.width, height: before.height } },
		);
	}
	const width = after.width;
	const height = after.height;
	const afterById = new Map(after.layers.map((layer) => [layer.id, layer]));
	let rawChanged = 0;
	const rawSame = (x: number, y: number): boolean => {
		for (const layer of before.layers) {
			const peer = afterById.get(layer.id);
			if (peer === undefined) {
				continue;
			}
			const offset = (y * width + x) * 4;
			if (
				layer.pixels[offset] !== peer.pixels[offset] ||
				layer.pixels[offset + 1] !== peer.pixels[offset + 1] ||
				layer.pixels[offset + 2] !== peer.pixels[offset + 2] ||
				layer.pixels[offset + 3] !== peer.pixels[offset + 3]
			) {
				return false;
			}
		}
		return true;
	};
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			if (!rawSame(x, y)) {
				rawChanged += 1;
			}
		}
	}
	const beforeFlat = flattenCanvas(before);
	const afterFlat = flattenCanvas(after);
	let compositedChanged = 0;
	for (let i = 0; i < beforeFlat.length; i += 4) {
		if (
			beforeFlat[i] !== afterFlat[i] ||
			beforeFlat[i + 1] !== afterFlat[i + 1] ||
			beforeFlat[i + 2] !== afterFlat[i + 2] ||
			beforeFlat[i + 3] !== afterFlat[i + 3]
		) {
			compositedChanged += 1;
		}
	}
	const compositedSame = (x: number, y: number): boolean => {
		const offset = (y * width + x) * 4;
		return (
			beforeFlat[offset] === afterFlat[offset] &&
			beforeFlat[offset + 1] === afterFlat[offset + 1] &&
			beforeFlat[offset + 2] === afterFlat[offset + 2] &&
			beforeFlat[offset + 3] === afterFlat[offset + 3]
		);
	};
	const structural = diffStructural(before, after);
	const { scopes, hasDeclaredScopes } = computeWriteScopes(before, operations);
	let outsideSelectionUnchanged = true;
	if (hasDeclaredScopes) {
		for (const layer of before.layers) {
			const peer = afterById.get(layer.id);
			if (peer === undefined) {
				continue;
			}
			const mask = scopes.get(layer.id);
			for (let p = 0; p < width * height; p += 1) {
				if (mask !== undefined && mask[p] === 1) {
					continue;
				}
				const offset = p * 4;
				if (
					layer.pixels[offset] !== peer.pixels[offset] ||
					layer.pixels[offset + 1] !== peer.pixels[offset + 1] ||
					layer.pixels[offset + 2] !== peer.pixels[offset + 2] ||
					layer.pixels[offset + 3] !== peer.pixels[offset + 3]
				) {
					outsideSelectionUnchanged = false;
					break;
				}
			}
			if (!outsideSelectionUnchanged) {
				break;
			}
		}
	}
	return {
		raw: differenceOf(width, height, rawSame, rawChanged),
		composited: differenceOf(width, height, compositedSame, compositedChanged),
		structural,
		outsideSelectionUnchanged,
	};
}

function diffStructural(
	before: PixelCanvas,
	after: PixelCanvas,
): StructuralDifference {
	const added: string[] = [];
	const removed: string[] = [];
	const modified: string[] = [];
	const afterLayers = new Map(after.layers.map((layer) => [layer.id, layer]));
	const beforeLayerIds = new Set(before.layers.map((layer) => layer.id));
	for (const layer of before.layers) {
		const peer = afterLayers.get(layer.id);
		if (peer === undefined) {
			removed.push(`/layers/${layer.id}`);
			continue;
		}
		// Pixel bytes are the raw diff's job; membership here tracks
		// identity and rendering state only.
		if (
			(layer.name ?? null) !== (peer.name ?? null) ||
			layer.visible !== peer.visible ||
			layer.opacity !== peer.opacity ||
			layer.blendMode !== peer.blendMode ||
			JSON.stringify(layer.metadata ?? null) !==
				JSON.stringify(peer.metadata ?? null)
		) {
			modified.push(`/layers/${layer.id}`);
		}
	}
	for (const layer of after.layers) {
		if (!beforeLayerIds.has(layer.id)) {
			added.push(`/layers/${layer.id}`);
		}
	}
	const afterRegions = new Map(
		after.regions.map((region) => [region.id, region]),
	);
	const beforeRegionIds = new Set(before.regions.map((region) => region.id));
	for (const region of before.regions) {
		const peer = afterRegions.get(region.id);
		if (peer === undefined) {
			removed.push(`/regions/${region.id}`);
			continue;
		}
		if (
			(region.name ?? null) !== (peer.name ?? null) ||
			!sameBytes(region.mask, peer.mask) ||
			JSON.stringify(region.metadata ?? null) !==
				JSON.stringify(peer.metadata ?? null)
		) {
			modified.push(`/regions/${region.id}`);
		}
	}
	for (const region of after.regions) {
		if (!beforeRegionIds.has(region.id)) {
			added.push(`/regions/${region.id}`);
		}
	}
	const beforePalette = before.palette?.entries;
	const afterPalette = after.palette?.entries;
	if (beforePalette === undefined && afterPalette !== undefined) {
		added.push("/palette");
	} else if (beforePalette !== undefined && afterPalette === undefined) {
		removed.push("/palette");
	} else if (
		beforePalette !== undefined &&
		afterPalette !== undefined &&
		JSON.stringify(beforePalette) !== JSON.stringify(afterPalette)
	) {
		modified.push("/palette");
	}
	if (JSON.stringify(before.metadata) !== JSON.stringify(after.metadata)) {
		modified.push("/metadata");
	}
	added.sort(compareStrings);
	removed.sort(compareStrings);
	modified.sort(compareStrings);
	return { added, removed, modified };
}

/**
 * Validate a raw feedback input into the frozen request shape. Unknown
 * keys, unknown image/diff names, and out-of-range scales are
 * INVALID_ARGUMENT; the crop stays opaque here and validates on use.
 */
export function normalizeFeedbackRequest(
	value: unknown,
): FeedbackRequest | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Feedback must be an object with optional image, scale, crop, and diff.",
			{ feedback: value },
		);
	}
	const raw = value as Record<string, unknown>;
	for (const key of Object.keys(raw)) {
		if (
			key !== "image" &&
			key !== "scale" &&
			key !== "crop" &&
			key !== "diff"
		) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				`Unknown feedback key: ${key}.`,
				{ key },
			);
		}
	}
	const request: FeedbackRequest = {};
	if (raw.image !== undefined) {
		if (
			raw.image !== "none" &&
			raw.image !== "full" &&
			raw.image !== "changed"
		) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				'Feedback image must be "none", "full", or "changed".',
				{ image: raw.image },
			);
		}
		request.image = raw.image;
	}
	if (raw.diff !== undefined) {
		if (raw.diff !== "none" && raw.diff !== "summary") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				'Feedback diff must be "none" or "summary".',
				{ diff: raw.diff },
			);
		}
		request.diff = raw.diff;
	}
	if (raw.scale !== undefined) {
		const scale = normalizeViewScale(raw.scale);
		if (scale !== undefined) {
			request.scale = scale;
		}
	}
	if (raw.crop !== undefined) {
		request.crop = raw.crop;
	}
	return request;
}

/**
 * Frozen feedback assembly over a before snapshot and the after canvas.
 * `none` returns flags only; `full` renders the crop (or whole canvas);
 * `changed` ignores the crop and renders the composited change bounds, or
 * reports noVisibleChange when nothing visible moved. A crop with `none`
 * is INVALID_ARGUMENT. The summary computes only on `summary`.
 */
export function buildFeedback(
	before: PixelCanvas,
	after: PixelCanvas,
	operations: BatchOperation[],
	request: FeedbackRequest,
): FeedbackResult {
	const image = request.image ?? "none";
	const diffMode = request.diff ?? "none";
	if (request.crop !== undefined && image === "none") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Feedback crop needs image full or changed; drop the crop or pick an image mode.",
			{ image },
		);
	}
	let summary: DiffSummary | undefined;
	if (diffMode === "summary" || image === "changed") {
		summary = diffCanvases(before, after, operations);
	}
	let pngBytes: Uint8Array | undefined;
	let imageIncluded = false;
	let noVisibleChange: true | undefined;
	if (image === "full") {
		const view = renderInspectView(after, {
			...(request.crop === undefined ? {} : { crop: request.crop }),
			...(request.scale === undefined ? {} : { scale: request.scale }),
			autoScale: true,
		});
		pngBytes = view.pngBytes;
		imageIncluded = true;
	} else if (image === "changed") {
		const composited = (summary as DiffSummary).composited;
		if (composited.changedPixels === 0) {
			imageIncluded = false;
			noVisibleChange = true;
		} else {
			const bounds = composited.bounds as Rect;
			const scale = resolveFeedbackScale(
				bounds.width,
				bounds.height,
				request.scale,
			);
			const rendered = renderFlatRegion(
				flattenCanvas(after),
				after.width,
				bounds,
				scale,
			);
			pngBytes = rendered.pngBytes;
			imageIncluded = true;
		}
	}
	return {
		feedback: {
			image,
			imageIncluded,
			...(noVisibleChange === undefined ? {} : { noVisibleChange }),
			...(summary !== undefined && diffMode === "summary"
				? { diff: summary }
				: {}),
		},
		...(pngBytes === undefined ? {} : { pngBytes }),
	};
}
