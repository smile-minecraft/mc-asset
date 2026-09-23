import { getLayer, getRegion } from "./canvas.ts";
import { McAssetError } from "./errors.ts";
import type { PixelCanvas, PixelLayer, RGBA } from "./types.ts";
import {
	assertValidCanvas,
	checkResourceLimits,
	validateCoordinate,
	validateLayerPixelsSize,
} from "./validate.ts";

export interface DuplicateLayerOptions {
	id?: string;
	name?: string;
}

function layerIndex(canvas: PixelCanvas, id: string): number {
	const layer = getLayer(canvas, id);
	return canvas.layers.indexOf(layer);
}

function regionIndex(canvas: PixelCanvas, id: string): number {
	const region = getRegion(canvas, id);
	return canvas.regions.indexOf(region);
}

function assertNonEmptyName(kind: string, name: string): void {
	if (typeof name !== "string" || name.length === 0) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`${kind} name must be a non-empty string.`,
			{ name },
		);
	}
}

function assertValidPosition(length: number, toIndex: number): void {
	if (!Number.isInteger(toIndex)) {
		throw new McAssetError("INVALID_ARGUMENT", "Position must be an integer.", {
			toIndex,
		});
	}
	if (toIndex < 0 || toIndex >= length) {
		throw new McAssetError("OUT_OF_BOUNDS", "Position is outside the stack.", {
			toIndex,
			length,
		});
	}
}

/** Drop a layer. The canvas always keeps at least one layer. */
export function removeLayer(canvas: PixelCanvas, id: string): void {
	assertValidCanvas(canvas);
	const index = layerIndex(canvas, id);
	if (canvas.layers.length <= 1) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"The last layer cannot be removed.",
			{ id },
		);
	}
	canvas.layers.splice(index, 1);
}

/** Rename a layer. The id is unchanged. */
export function renameLayer(
	canvas: PixelCanvas,
	id: string,
	name: string,
): void {
	assertValidCanvas(canvas);
	const layer = getLayer(canvas, id);
	assertNonEmptyName("Layer", name);
	layer.name = name;
}

/**
 * Move a layer to an absolute stack position. Index 0 is the bottom;
 * higher indices composite on top (bottom-to-top order).
 */
export function reorderLayer(
	canvas: PixelCanvas,
	id: string,
	toIndex: number,
): void {
	assertValidCanvas(canvas);
	const from = layerIndex(canvas, id);
	assertValidPosition(canvas.layers.length, toIndex);
	if (from === toIndex) {
		return;
	}
	const removed = canvas.layers.splice(from, 1);
	const layer = removed[0] as PixelLayer;
	canvas.layers.splice(toIndex, 0, layer);
}

/** Drop a region. Regions may reach zero and may overlap each other. */
export function removeRegion(canvas: PixelCanvas, id: string): void {
	assertValidCanvas(canvas);
	const index = regionIndex(canvas, id);
	canvas.regions.splice(index, 1);
}

/** Rename a region. The id and the mask are unchanged. */
export function renameRegion(
	canvas: PixelCanvas,
	id: string,
	name: string,
): void {
	assertValidCanvas(canvas);
	const region = getRegion(canvas, id);
	assertNonEmptyName("Region", name);
	region.name = name;
}

/** Move a region to an absolute position in the regions array. */
export function reorderRegion(
	canvas: PixelCanvas,
	id: string,
	toIndex: number,
): void {
	assertValidCanvas(canvas);
	const from = regionIndex(canvas, id);
	assertValidPosition(canvas.regions.length, toIndex);
	if (from === toIndex) {
		return;
	}
	const removed = canvas.regions.splice(from, 1);
	const region = removed[0] as (typeof canvas.regions)[number];
	canvas.regions.splice(toIndex, 0, region);
}

function nextCopyId(canvas: PixelCanvas, sourceId: string): string {
	const base = `${sourceId}-copy`;
	const taken = (candidate: string): boolean =>
		canvas.layers.some((layer) => layer.id === candidate);
	if (!taken(base)) {
		return base;
	}
	let counter = 1;
	while (taken(`${base}-${counter}`)) {
		counter += 1;
	}
	return `${base}-${counter}`;
}

/**
 * Deep-copy a layer under a fresh id. Pixels and metadata are copied by
 * value, so neither side observes later edits to the other. The copy lands
 * directly above the source in bottom-to-top order.
 */
export function duplicateLayer(
	canvas: PixelCanvas,
	sourceId: string,
	options?: DuplicateLayerOptions,
): PixelLayer {
	assertValidCanvas(canvas);
	const source = getLayer(canvas, sourceId);
	const id = options?.id ?? nextCopyId(canvas, sourceId);
	if (canvas.layers.some((layer) => layer.id === id)) {
		throw new McAssetError("DUPLICATE_LAYER_ID", "Layer id already exists.", {
			id,
		});
	}
	if (options?.name !== undefined) {
		assertNonEmptyName("Layer", options.name);
	}
	// Budget gate runs before the pixel buffer is copied.
	checkResourceLimits(
		canvas.width,
		canvas.height,
		canvas.layers.length + 1,
		canvas.regions.length,
	);
	validateLayerPixelsSize(canvas.width, canvas.height, source.pixels);
	const name = options?.name ?? source.name;
	const copy: PixelLayer = {
		id,
		pixels: source.pixels.slice(),
		visible: source.visible,
		opacity: source.opacity,
		blendMode: source.blendMode,
		...(name !== undefined ? { name } : {}),
		...(source.metadata !== undefined
			? { metadata: { ...source.metadata } }
			: {}),
	};
	canvas.layers.splice(canvas.layers.indexOf(source) + 1, 0, copy);
	return copy;
}

/**
 * Composite one pixel of straight-alpha src-over. Same arithmetic as the
 * PNG flatten path: integer channels, half-up rounding, deterministic
 * across runtimes. A transparent source over a transparent destination
 * keeps the upper (source) hidden RGB verbatim. Exported so stampRect
 * reuses the exact arithmetic instead of duplicating it.
 */
export function compositePixel(
	src: Uint8Array,
	srcOffset: number,
	dst: Uint8Array,
	dstOffset: number,
	out: Uint8Array,
	outOffset: number,
): void {
	const srcAlpha = src[srcOffset + 3] as number;
	const dstAlpha = dst[dstOffset + 3] as number;
	if (srcAlpha <= 0) {
		if (dstAlpha === 0) {
			out[outOffset] = src[srcOffset] as number;
			out[outOffset + 1] = src[srcOffset + 1] as number;
			out[outOffset + 2] = src[srcOffset + 2] as number;
			out[outOffset + 3] = 0;
		} else {
			out[outOffset] = dst[dstOffset] as number;
			out[outOffset + 1] = dst[dstOffset + 1] as number;
			out[outOffset + 2] = dst[dstOffset + 2] as number;
			out[outOffset + 3] = dstAlpha;
		}
		return;
	}
	const inverse = 255 - srcAlpha;
	const outAlpha = srcAlpha + Math.round((dstAlpha * inverse) / 255);
	const coverage = (dstAlpha * inverse) / 255;
	out[outOffset] = Math.round(
		((src[srcOffset] as number) * srcAlpha +
			(dst[dstOffset] as number) * coverage) /
			outAlpha,
	);
	out[outOffset + 1] = Math.round(
		((src[srcOffset + 1] as number) * srcAlpha +
			(dst[dstOffset + 1] as number) * coverage) /
			outAlpha,
	);
	out[outOffset + 2] = Math.round(
		((src[srcOffset + 2] as number) * srcAlpha +
			(dst[dstOffset + 2] as number) * coverage) /
			outAlpha,
	);
	out[outOffset + 3] = outAlpha;
}

/**
 * Composite the source layer onto the target layer with normal blend in
 * bottom-to-top order (the higher layer is the src), store the result in
 * the target, then remove the source. Merging a layer with itself is
 * rejected. Layer flags (visible, opacity) are rendering state and do not
 * change the pixel math: raw buffers are composited.
 */
export function mergeLayer(
	canvas: PixelCanvas,
	sourceId: string,
	targetId: string,
): void {
	assertValidCanvas(canvas);
	const source = getLayer(canvas, sourceId);
	const target = getLayer(canvas, targetId);
	if (sourceId === targetId) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"A layer cannot be merged with itself.",
			{ id: sourceId },
		);
	}
	validateLayerPixelsSize(canvas.width, canvas.height, source.pixels);
	validateLayerPixelsSize(canvas.width, canvas.height, target.pixels);
	const upper =
		canvas.layers.indexOf(source) > canvas.layers.indexOf(target)
			? source
			: target;
	const lower = upper === source ? target : source;
	const out = new Uint8Array(canvas.width * canvas.height * 4);
	for (let i = 0; i < out.length; i += 4) {
		compositePixel(upper.pixels, i, lower.pixels, i, out, i);
	}
	target.pixels = out;
	canvas.layers.splice(canvas.layers.indexOf(source), 1);
}

/** Reset every pixel of a layer to transparent black. */
export function clearLayer(canvas: PixelCanvas, id: string): void {
	assertValidCanvas(canvas);
	const layer = getLayer(canvas, id);
	validateLayerPixelsSize(canvas.width, canvas.height, layer.pixels);
	layer.pixels.fill(0);
}

function hexByte(pair: string): number {
	return Number.parseInt(pair, 16);
}

/**
 * Fill-color grammar shared with the batch and mcpx paths: the literal
 * `transparent` (#00000000), #RRGGBB (opaque), or #RRGGBBAA. Hex digits
 * accept either case.
 */
export function parseFillColor(value: string): RGBA {
	if (value === "transparent") {
		return { r: 0, g: 0, b: 0, a: 0 };
	}
	if (typeof value !== "string") {
		throw new McAssetError(
			"INVALID_COLOR",
			"Fill color must be transparent, #RRGGBB, or #RRGGBBAA.",
			{ value },
		);
	}
	const match = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(value);
	const digits = match?.[1];
	if (digits === undefined) {
		throw new McAssetError(
			"INVALID_COLOR",
			"Fill color must be transparent, #RRGGBB, or #RRGGBBAA.",
			{ value },
		);
	}
	return {
		r: hexByte(digits.slice(0, 2)),
		g: hexByte(digits.slice(2, 4)),
		b: hexByte(digits.slice(4, 6)),
		a: digits.length === 8 ? hexByte(digits.slice(6, 8)) : 255,
	};
}

/** Fill a whole layer with one color. Other layers are untouched. */
export function fillLayer(
	canvas: PixelCanvas,
	id: string,
	color: string,
): void {
	assertValidCanvas(canvas);
	const layer = getLayer(canvas, id);
	const rgba = parseFillColor(color);
	validateLayerPixelsSize(canvas.width, canvas.height, layer.pixels);
	for (let i = 0; i < layer.pixels.length; i += 4) {
		layer.pixels[i] = rgba.r;
		layer.pixels[i + 1] = rgba.g;
		layer.pixels[i + 2] = rgba.b;
		layer.pixels[i + 3] = rgba.a;
	}
}

/**
 * Shift layer contents by integer (dx, dy). Any cell that is not fully zero
 * counts as data: hidden RGB under alpha 0 is preserved, so only all-zero
 * cells may leave the canvas. A non-zero cell leaving is OUT_OF_BOUNDS
 * with no partial writes. Vacated cells become transparent black; shifted
 * pixels move verbatim.
 */
export function moveLayer(
	canvas: PixelCanvas,
	id: string,
	dx: number,
	dy: number,
): void {
	assertValidCanvas(canvas);
	const layer = getLayer(canvas, id);
	validateCoordinate(dx, "x");
	validateCoordinate(dy, "y");
	validateLayerPixelsSize(canvas.width, canvas.height, layer.pixels);
	if (dx === 0 && dy === 0) {
		return;
	}
	const width = canvas.width;
	const height = canvas.height;
	const pixels = layer.pixels;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const offset = (y * width + x) * 4;
			const isEmpty =
				pixels[offset] === 0 &&
				pixels[offset + 1] === 0 &&
				pixels[offset + 2] === 0 &&
				pixels[offset + 3] === 0;
			if (!isEmpty) {
				const nextX = x + dx;
				const nextY = y + dy;
				if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) {
					throw new McAssetError(
						"OUT_OF_BOUNDS",
						"Layer content would move outside the canvas.",
						{ id, dx, dy, x, y, width, height },
					);
				}
			}
		}
	}
	const next = new Uint8Array(pixels.length);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const from = (y * width + x) * 4;
			const to = ((y + dy) * width + (x + dx)) * 4;
			next[to] = pixels[from] as number;
			next[to + 1] = pixels[from + 1] as number;
			next[to + 2] = pixels[from + 2] as number;
			next[to + 3] = pixels[from + 3] as number;
		}
	}
	layer.pixels = next;
}
