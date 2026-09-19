import { McAssetError } from "./errors.ts";
import type { PixelCanvas, Rect, RGBA } from "./types.ts";
import {
	assertRectInBounds,
	assertValidCanvas,
	checkResourceLimits,
	validateColor,
	validateCoordinate,
	validateDimension,
	validateRect,
} from "./validate.ts";

export type ResizeMode = "nearest" | "box" | "pixel-aware";

export interface PadOptions {
	left: number;
	top: number;
	right: number;
	bottom: number;
	color?: RGBA;
}

const CLEAR: RGBA = { r: 0, g: 0, b: 0, a: 0 };

function pixelOffset(width: number, x: number, y: number): number {
	return (y * width + x) * 4;
}

function isClear(pixels: Uint8Array, offset: number): boolean {
	return (
		pixels[offset] === 0 &&
		pixels[offset + 1] === 0 &&
		pixels[offset + 2] === 0 &&
		pixels[offset + 3] === 0
	);
}

/**
 * Remap every layer and region mask through a per-pixel source lookup.
 * The lookup runs against the old dimensions; results are committed only
 * after all buffers are built, so a failure never leaves partial pixels.
 */
function remapCanvas(
	canvas: PixelCanvas,
	newWidth: number,
	newHeight: number,
	sourceOf: (x: number, y: number) => { sx: number; sy: number },
	fillLayers: boolean,
): void {
	const oldWidth = canvas.width;
	const oldHeight = canvas.height;
	const newLayers = canvas.layers.map((layer) => {
		const next = new Uint8Array(newWidth * newHeight * 4);
		if (fillLayers) {
			for (let i = 0; i < next.length; i += 4) {
				next[i] = CLEAR.r;
				next[i + 1] = CLEAR.g;
				next[i + 2] = CLEAR.b;
				next[i + 3] = CLEAR.a;
			}
		}
		for (let y = 0; y < newHeight; y += 1) {
			for (let x = 0; x < newWidth; x += 1) {
				const { sx, sy } = sourceOf(x, y);
				if (sx < 0 || sy < 0 || sx >= oldWidth || sy >= oldHeight) {
					continue;
				}
				const from = pixelOffset(oldWidth, sx, sy);
				const to = pixelOffset(newWidth, x, y);
				next[to] = layer.pixels[from] as number;
				next[to + 1] = layer.pixels[from + 1] as number;
				next[to + 2] = layer.pixels[from + 2] as number;
				next[to + 3] = layer.pixels[from + 3] as number;
			}
		}
		return next;
	});
	const newMasks = canvas.regions.map((region) => {
		const next = new Uint8Array(newWidth * newHeight);
		for (let y = 0; y < newHeight; y += 1) {
			for (let x = 0; x < newWidth; x += 1) {
				const { sx, sy } = sourceOf(x, y);
				if (sx < 0 || sy < 0 || sx >= oldWidth || sy >= oldHeight) {
					continue;
				}
				next[y * newWidth + x] = region.mask[sy * oldWidth + sx] as number;
			}
		}
		return next;
	});
	for (let i = 0; i < canvas.layers.length; i += 1) {
		(canvas.layers[i] as { pixels: Uint8Array }).pixels = newLayers[
			i
		] as Uint8Array;
	}
	for (let i = 0; i < canvas.regions.length; i += 1) {
		(canvas.regions[i] as { mask: Uint8Array }).mask = newMasks[
			i
		] as Uint8Array;
	}
	canvas.width = newWidth;
	canvas.height = newHeight;
}

/** Mirror left-right. Dimensions are unchanged. */
export function flipHorizontal(canvas: PixelCanvas): void {
	assertValidCanvas(canvas);
	const width = canvas.width;
	remapCanvas(
		canvas,
		width,
		canvas.height,
		(x, y) => ({
			sx: width - 1 - x,
			sy: y,
		}),
		false,
	);
}

/** Mirror top-bottom. Dimensions are unchanged. */
export function flipVertical(canvas: PixelCanvas): void {
	assertValidCanvas(canvas);
	const height = canvas.height;
	remapCanvas(
		canvas,
		canvas.width,
		height,
		(x, y) => ({
			sx: x,
			sy: height - 1 - y,
		}),
		false,
	);
}

/** Quarter turn clockwise. Width and height are swapped. */
export function rotate90(canvas: PixelCanvas): void {
	assertValidCanvas(canvas);
	const oldHeight = canvas.height;
	remapCanvas(
		canvas,
		oldHeight,
		canvas.width,
		(x, y) => ({
			sx: y,
			sy: oldHeight - 1 - x,
		}),
		false,
	);
}

/** Half turn. Dimensions are unchanged; the operation is its own inverse. */
export function rotate180(canvas: PixelCanvas): void {
	assertValidCanvas(canvas);
	const width = canvas.width;
	const height = canvas.height;
	remapCanvas(
		canvas,
		width,
		height,
		(x, y) => ({
			sx: width - 1 - x,
			sy: height - 1 - y,
		}),
		false,
	);
}

/** Quarter turn counter-clockwise. Width and height are swapped. */
export function rotate270(canvas: PixelCanvas): void {
	assertValidCanvas(canvas);
	const oldWidth = canvas.width;
	remapCanvas(
		canvas,
		canvas.height,
		oldWidth,
		(x, y) => ({
			sx: oldWidth - 1 - y,
			sy: x,
		}),
		false,
	);
}

/**
 * Keep the rect verbatim and shrink the canvas to it. The rect must lie
 * fully inside the canvas: there is no silent clipping, a rect that sticks
 * out is OUT_OF_BOUNDS and the canvas is left untouched.
 */
export function crop(canvas: PixelCanvas, rect: Rect): void {
	assertValidCanvas(canvas);
	validateRect(rect);
	assertRectInBounds(canvas.width, canvas.height, rect);
	remapCanvas(
		canvas,
		rect.width,
		rect.height,
		(x, y) => ({
			sx: rect.x + x,
			sy: rect.y + y,
		}),
		false,
	);
}

function validatePadAmount(value: number, side: string): number {
	validateCoordinate(value, "x");
	if (value < 0) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Pad amount for ${side} must be zero or positive.`,
			{ side, value },
		);
	}
	return value;
}

/**
 * Grow the canvas by a border on each side. New cells default to transparent
 * black and keep the old pixels verbatim at their shifted position; region
 * masks grow with 0 (outside) in the new cells.
 */
export function pad(canvas: PixelCanvas, options: PadOptions): void {
	assertValidCanvas(canvas);
	const left = validatePadAmount(options.left, "left");
	const top = validatePadAmount(options.top, "top");
	const right = validatePadAmount(options.right, "right");
	const bottom = validatePadAmount(options.bottom, "bottom");
	const color =
		options.color === undefined ? CLEAR : validateColor(options.color);
	const newWidth = canvas.width + left + right;
	const newHeight = canvas.height + top + bottom;
	validateDimension(newWidth);
	validateDimension(newHeight);
	checkResourceLimits(
		newWidth,
		newHeight,
		canvas.layers.length,
		canvas.regions.length,
	);
	const oldWidth = canvas.width;
	const oldHeight = canvas.height;
	const newLayers = canvas.layers.map(() => {
		const next = new Uint8Array(newWidth * newHeight * 4);
		for (let i = 0; i < next.length; i += 4) {
			next[i] = color.r;
			next[i + 1] = color.g;
			next[i + 2] = color.b;
			next[i + 3] = color.a;
		}
		return next;
	});
	for (let li = 0; li < canvas.layers.length; li += 1) {
		const layer = canvas.layers[li] as { pixels: Uint8Array };
		const next = newLayers[li] as Uint8Array;
		for (let y = 0; y < oldHeight; y += 1) {
			for (let x = 0; x < oldWidth; x += 1) {
				const from = pixelOffset(oldWidth, x, y);
				const to = pixelOffset(newWidth, x + left, y + top);
				next[to] = layer.pixels[from] as number;
				next[to + 1] = layer.pixels[from + 1] as number;
				next[to + 2] = layer.pixels[from + 2] as number;
				next[to + 3] = layer.pixels[from + 3] as number;
			}
		}
	}
	const newMasks = canvas.regions.map(
		() => new Uint8Array(newWidth * newHeight),
	);
	for (let ri = 0; ri < canvas.regions.length; ri += 1) {
		const region = canvas.regions[ri] as { mask: Uint8Array };
		const next = newMasks[ri] as Uint8Array;
		for (let y = 0; y < oldHeight; y += 1) {
			for (let x = 0; x < oldWidth; x += 1) {
				next[(y + top) * newWidth + (x + left)] = region.mask[
					y * oldWidth + x
				] as number;
			}
		}
	}
	for (let i = 0; i < canvas.layers.length; i += 1) {
		(canvas.layers[i] as { pixels: Uint8Array }).pixels = newLayers[
			i
		] as Uint8Array;
	}
	for (let i = 0; i < canvas.regions.length; i += 1) {
		(canvas.regions[i] as { mask: Uint8Array }).mask = newMasks[
			i
		] as Uint8Array;
	}
	canvas.width = newWidth;
	canvas.height = newHeight;
}

/**
 * Shift every layer by integer (dx, dy). Content that would leave the canvas
 * is OUT_OF_BOUNDS and nothing is written; vacated cells become transparent
 * black and retained pixels keep their RGBA verbatim with no interpolation.
 */
export function translate(canvas: PixelCanvas, dx: number, dy: number): void {
	assertValidCanvas(canvas);
	validateCoordinate(dx, "x");
	validateCoordinate(dy, "y");
	for (const layer of canvas.layers) {
		for (let y = 0; y < canvas.height; y += 1) {
			for (let x = 0; x < canvas.width; x += 1) {
				const nx = x + dx;
				const ny = y + dy;
				if (nx < 0 || ny < 0 || nx >= canvas.width || ny >= canvas.height) {
					const offset = pixelOffset(canvas.width, x, y);
					if (!isClear(layer.pixels, offset)) {
						throw new McAssetError(
							"OUT_OF_BOUNDS",
							"Translate would move pixel content outside the canvas.",
							{ dx, dy, width: canvas.width, height: canvas.height },
						);
					}
				}
			}
		}
	}
	remapCanvas(
		canvas,
		canvas.width,
		canvas.height,
		(x, y) => ({
			sx: x - dx,
			sy: y - dy,
		}),
		true,
	);
}

function resolveResizeMode(mode: ResizeMode | undefined): ResizeMode {
	if (mode === undefined) {
		return "nearest";
	}
	if (mode !== "nearest" && mode !== "box" && mode !== "pixel-aware") {
		throw new McAssetError("INVALID_ARGUMENT", "Unknown resize mode.", {
			mode,
		});
	}
	return mode;
}

/** Nearest-neighbor sample: every destination pixel reuses one source pixel. */
function nearestSource(
	oldWidth: number,
	oldHeight: number,
	newWidth: number,
	newHeight: number,
	x: number,
	y: number,
): { sx: number; sy: number } {
	const sx = Math.floor((x * oldWidth) / newWidth);
	const sy = Math.floor((y * oldHeight) / newHeight);
	return { sx, sy };
}

function blockEdges(oldSize: number, newSize: number): number[] {
	// Fixed remainder rule: the first (oldSize % newSize) cells each cover one
	// extra source pixel; the rest cover the floored base width.
	const base = Math.floor(oldSize / newSize);
	const extra = oldSize - base * newSize;
	const edges: number[] = [0];
	for (let i = 0; i < newSize; i += 1) {
		edges.push((edges[i] as number) + base + (i < extra ? 1 : 0));
	}
	return edges;
}

/** Box resize: integer block means with floored division, no new blending. */
function resizeBox(
	canvas: PixelCanvas,
	newWidth: number,
	newHeight: number,
): void {
	const oldWidth = canvas.width;
	const oldHeight = canvas.height;
	const xEdges = blockEdges(oldWidth, newWidth);
	const yEdges = blockEdges(oldHeight, newHeight);
	const newLayers = canvas.layers.map((layer) => {
		const next = new Uint8Array(newWidth * newHeight * 4);
		for (let y = 0; y < newHeight; y += 1) {
			for (let x = 0; x < newWidth; x += 1) {
				const x0 = xEdges[x] as number;
				const x1 = xEdges[x + 1] as number;
				const y0 = yEdges[y] as number;
				const y1 = yEdges[y + 1] as number;
				let r = 0;
				let g = 0;
				let b = 0;
				let a = 0;
				for (let sy = y0; sy < y1; sy += 1) {
					for (let sx = x0; sx < x1; sx += 1) {
						const from = pixelOffset(oldWidth, sx, sy);
						r += layer.pixels[from] as number;
						g += layer.pixels[from + 1] as number;
						b += layer.pixels[from + 2] as number;
						a += layer.pixels[from + 3] as number;
					}
				}
				const count = (x1 - x0) * (y1 - y0);
				const to = pixelOffset(newWidth, x, y);
				next[to] = Math.floor(r / count);
				next[to + 1] = Math.floor(g / count);
				next[to + 2] = Math.floor(b / count);
				next[to + 3] = Math.floor(a / count);
			}
		}
		return next;
	});
	const newMasks = canvas.regions.map((region) => {
		// Masks stay binary: nearest-map the block origin instead of averaging.
		const next = new Uint8Array(newWidth * newHeight);
		for (let y = 0; y < newHeight; y += 1) {
			for (let x = 0; x < newWidth; x += 1) {
				const src = nearestSource(
					oldWidth,
					oldHeight,
					newWidth,
					newHeight,
					x,
					y,
				);
				next[y * newWidth + x] = region.mask[
					src.sy * oldWidth + src.sx
				] as number;
			}
		}
		return next;
	});
	for (let i = 0; i < canvas.layers.length; i += 1) {
		(canvas.layers[i] as { pixels: Uint8Array }).pixels = newLayers[
			i
		] as Uint8Array;
	}
	for (let i = 0; i < canvas.regions.length; i += 1) {
		(canvas.regions[i] as { mask: Uint8Array }).mask = newMasks[
			i
		] as Uint8Array;
	}
	canvas.width = newWidth;
	canvas.height = newHeight;
}

/**
 * Resize the canvas. The default is nearest-neighbor with no anti-aliasing.
 * pixel-aware is accepted by name but has no defined algorithm, so it is
 * explicitly refused instead of being silently served as nearest.
 */
export function resize(
	canvas: PixelCanvas,
	width: number,
	height: number,
	mode?: ResizeMode,
): void {
	assertValidCanvas(canvas);
	const resolved = resolveResizeMode(mode);
	if (resolved === "pixel-aware") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"pixel-aware resize is not implemented; use nearest or box.",
			{ mode: resolved },
		);
	}
	validateDimension(width);
	validateDimension(height);
	checkResourceLimits(
		width,
		height,
		canvas.layers.length,
		canvas.regions.length,
	);
	if (resolved === "box") {
		resizeBox(canvas, width, height);
		return;
	}
	const oldWidth = canvas.width;
	const oldHeight = canvas.height;
	remapCanvas(
		canvas,
		width,
		height,
		(x, y) => nearestSource(oldWidth, oldHeight, width, height, x, y),
		false,
	);
}
