import { getLayer, getPixel, setPixel } from "./canvas.ts";
import type { PixelCanvas, Rect, RGBA } from "./types.ts";
import {
	assertPixelInBounds,
	assertRectInBounds,
	validateColor,
	validateCoordinate,
} from "./validate.ts";

const CLEAR: RGBA = { r: 0, g: 0, b: 0, a: 0 };

function sameColor(a: RGBA, b: RGBA): boolean {
	return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

/** Reset one pixel to transparent black. Validation flows through setPixel. */
export function clearPixel(
	canvas: PixelCanvas,
	layerId: string,
	x: number,
	y: number,
): void {
	setPixel(canvas, layerId, x, y, { ...CLEAR });
}

/**
 * Integer-only Bresenham line. Both endpoints are bounds-checked before the
 * first pixel is written, so a failure leaves no partial pixels behind and
 * there is no silent clipping: any out-of-bounds endpoint is OUT_OF_BOUNDS.
 */
export function drawLine(
	canvas: PixelCanvas,
	layerId: string,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	color: RGBA,
): void {
	getLayer(canvas, layerId);
	validateCoordinate(x0, "x");
	validateCoordinate(y0, "y");
	validateCoordinate(x1, "x");
	validateCoordinate(y1, "y");
	assertPixelInBounds(canvas.width, canvas.height, x0, y0);
	assertPixelInBounds(canvas.width, canvas.height, x1, y1);
	validateColor(color);
	const dx = x1 >= x0 ? x1 - x0 : x0 - x1;
	let dy = y1 >= y0 ? y1 - y0 : y0 - y1;
	dy = 0 - dy;
	const stepX = x0 < x1 ? 1 : -1;
	const stepY = y0 < y1 ? 1 : -1;
	let err = dx + dy;
	let cx = x0;
	let cy = y0;
	for (;;) {
		setPixel(canvas, layerId, cx, cy, color);
		if (cx === x1 && cy === y1) {
			break;
		}
		const e2 = 2 * err;
		if (e2 >= dy) {
			err += dy;
			cx += stepX;
		}
		if (e2 <= dx) {
			err += dx;
			cy += stepY;
		}
	}
}

/**
 * 1px border ring in row/column order: top edge left to right, bottom edge
 * left to right, then left edge top to bottom, right edge top to bottom.
 * Corners are painted twice with the same color; the order is fixed.
 */
export function drawRect(
	canvas: PixelCanvas,
	layerId: string,
	rect: Rect,
	color: RGBA,
): void {
	getLayer(canvas, layerId);
	assertRectInBounds(canvas.width, canvas.height, rect);
	validateColor(color);
	const right = rect.x + rect.width - 1;
	const bottom = rect.y + rect.height - 1;
	for (let ix = rect.x; ix <= right; ix += 1) {
		setPixel(canvas, layerId, ix, rect.y, color);
		setPixel(canvas, layerId, ix, bottom, color);
	}
	for (let iy = rect.y; iy <= bottom; iy += 1) {
		setPixel(canvas, layerId, rect.x, iy, color);
		setPixel(canvas, layerId, right, iy, color);
	}
}

/** Solid fill, row-major: rows top to bottom, pixels left to right. */
export function fillRect(
	canvas: PixelCanvas,
	layerId: string,
	rect: Rect,
	color: RGBA,
): void {
	getLayer(canvas, layerId);
	assertRectInBounds(canvas.width, canvas.height, rect);
	validateColor(color);
	const right = rect.x + rect.width - 1;
	const bottom = rect.y + rect.height - 1;
	for (let iy = rect.y; iy <= bottom; iy += 1) {
		for (let ix = rect.x; ix <= right; ix += 1) {
			setPixel(canvas, layerId, ix, iy, color);
		}
	}
}

/**
 * 4-connected flood fill over the seed pixel's verbatim RGBA color.
 *
 * Locked traversal order: depth-first over an explicit stack (no recursion,
 * so large areas cannot overflow the call stack). Neighbors are pushed in
 * the fixed order East (+1, 0), West (-1, 0), South (0, +1), North (0, -1),
 * hence popped North first; each cell is marked visited at push time so it
 * enters the stack exactly once. The final bitmap does not depend on the
 * order, and this comment plus the determinism goldens lock the sequence.
 */
export function floodFill(
	canvas: PixelCanvas,
	layerId: string,
	x: number,
	y: number,
	color: RGBA,
): void {
	const layer = getLayer(canvas, layerId);
	validateCoordinate(x, "x");
	validateCoordinate(y, "y");
	assertPixelInBounds(canvas.width, canvas.height, x, y);
	validateColor(color);
	const width = canvas.width;
	const height = canvas.height;
	const target = getPixel(canvas, layerId, x, y);
	if (sameColor(target, color)) {
		return;
	}
	const visited = new Uint8Array(width * height);
	const stack: number[] = [x, y];
	visited[y * width + x] = 1;
	while (stack.length > 0) {
		const cy = stack.pop() as number;
		const cx = stack.pop() as number;
		setPixel(canvas, layerId, cx, cy, color);
		// Fixed neighbor order: E, W, S, N.
		const neighbors: Array<[number, number]> = [
			[cx + 1, cy],
			[cx - 1, cy],
			[cx, cy + 1],
			[cx, cy - 1],
		];
		for (const [nx, ny] of neighbors) {
			if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
				continue;
			}
			const index = ny * width + nx;
			if (visited[index] === 1) {
				continue;
			}
			const offset = index * 4;
			if (
				layer.pixels[offset] !== target.r ||
				layer.pixels[offset + 1] !== target.g ||
				layer.pixels[offset + 2] !== target.b ||
				layer.pixels[offset + 3] !== target.a
			) {
				continue;
			}
			visited[index] = 1;
			stack.push(nx, ny);
		}
	}
}
