import { getLayer, getPixel, setPixel } from "./canvas.ts";
import { McAssetError } from "./errors.ts";
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
 * Deterministic ellipse over a rect. Pixel centers sit at rect cells; with
 * local offsets `dx = 2*lx+1-w` and `dy = 2*ly+1-h`, a cell is inside when
 * `dx*dx*h*h + dy*dy*w*w <= w*w*h*h`, all integer. `fill` writes every
 * inside cell; `outline` writes the 1px inner edge (inside cells with a
 * 4-neighbor outside the inside set). Traversal is row-major. Error order
 * after layer lookup: coordinates (rect x/y), then dimensions
 * (width/height integer-validity and the minimum of 2 share one
 * INVALID_DIMENSION check), then mode, then bounds (the rect must sit
 * fully in-bounds, never clipped), then color, so no partial pixels
 * precede any failure.
 */
export function drawEllipse(
	canvas: PixelCanvas,
	layerId: string,
	rect: Rect,
	color: RGBA,
	mode: "fill" | "outline",
): void {
	getLayer(canvas, layerId);
	validateCoordinate(rect.x, "x");
	validateCoordinate(rect.y, "y");
	if (
		!Number.isInteger(rect.width) ||
		!Number.isInteger(rect.height) ||
		rect.width < 2 ||
		rect.height < 2
	) {
		throw new McAssetError(
			"INVALID_DIMENSION",
			"Ellipse rect width and height must be integers of at least 2, without rounding.",
			{ width: rect.width, height: rect.height },
		);
	}
	if (mode !== "fill" && mode !== "outline") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			'Ellipse mode must be "fill" or "outline".',
			{ mode },
		);
	}
	if (
		rect.x < 0 ||
		rect.y < 0 ||
		rect.x + rect.width > canvas.width ||
		rect.y + rect.height > canvas.height
	) {
		throw new McAssetError(
			"OUT_OF_BOUNDS",
			"Ellipse rect is outside canvas; ellipses are never clipped.",
			{ rect, width: canvas.width, height: canvas.height },
		);
	}
	validateColor(color);
	const w = rect.width;
	const h = rect.height;
	const w2 = w * w;
	const h2 = h * h;
	const rhs = w2 * h2;
	const inside = new Uint8Array(w * h);
	for (let ly = 0; ly < h; ly += 1) {
		const dy = 2 * ly + 1 - h;
		for (let lx = 0; lx < w; lx += 1) {
			const dx = 2 * lx + 1 - w;
			if (dx * dx * h2 + dy * dy * w2 <= rhs) {
				inside[ly * w + lx] = 1;
			}
		}
	}
	for (let ly = 0; ly < h; ly += 1) {
		for (let lx = 0; lx < w; lx += 1) {
			if (inside[ly * w + lx] !== 1) {
				continue;
			}
			if (mode === "outline") {
				const west = lx > 0 ? inside[ly * w + lx - 1] : 0;
				const east = lx + 1 < w ? inside[ly * w + lx + 1] : 0;
				const north = ly > 0 ? inside[(ly - 1) * w + lx] : 0;
				const south = ly + 1 < h ? inside[(ly + 1) * w + lx] : 0;
				if (west === 1 && east === 1 && north === 1 && south === 1) {
					continue;
				}
			}
			setPixel(canvas, layerId, rect.x + lx, rect.y + ly, color);
		}
	}
}

export interface PolygonPoint {
	x: number;
	y: number;
}

/** polygonFill inputs longer than this refuse before any allocation. */
export const POLYGON_MAX_POINTS = 4096;

/** Integer floor/ceil of num/den with den > 0; exact, no floats. */
function floorDiv(num: number, den: number): number {
	const rest = num % den;
	const quot = (num - rest) / den;
	return rest < 0 ? quot - 1 : quot;
}

function ceilDiv(num: number, den: number): number {
	const rest = num % den;
	const quot = (num - rest) / den;
	return rest > 0 ? quot + 1 : quot;
}

function onSegment(
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number,
): boolean {
	if ((py - ay) * (bx - ax) - (px - ax) * (by - ay) !== 0) {
		return false;
	}
	const minX = ax < bx ? ax : bx;
	const maxX = ax > bx ? ax : bx;
	const minY = ay < by ? ay : by;
	const maxY = ay > by ? ay : by;
	return px >= minX && px <= maxX && py >= minY && py <= maxY;
}

function segmentsTouch(
	ax: number,
	ay: number,
	bx: number,
	by: number,
	cx: number,
	cy: number,
	dx: number,
	dy: number,
): boolean {
	const o1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
	const o2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
	const o3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
	const o4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
	if (o1 === 0 && onSegment(cx, cy, ax, ay, bx, by)) {
		return true;
	}
	if (o2 === 0 && onSegment(dx, dy, ax, ay, bx, by)) {
		return true;
	}
	if (o3 === 0 && onSegment(ax, ay, cx, cy, dx, dy)) {
		return true;
	}
	if (o4 === 0 && onSegment(bx, by, cx, cy, dx, dy)) {
		return true;
	}
	return o1 > 0 !== o2 > 0 && o3 > 0 !== o4 > 0;
}

/**
 * Exact integer even-odd polygon fill over one scanline row. Boundary
 * pixels count as inside; interior uses the +x ray with the integer
 * crossing test `((ax-px)*dy + (py-ay)*dx) * dy > 0` over straddling
 * edges, so no float division ever appears. Traversal is row-major over
 * the point bounds.
 *
 * Shape rules, in order: more than 4096 points refuses up front; every
 * point is validated (integer, then in-bounds) before any shape rule;
 * adjacent duplicates (including the closing repeat) are INVALID_ARGUMENT;
 * fewer than 3 distinct points or a fully collinear ring is
 * INVALID_ARGUMENT; any nonadjacent edge touch or crossing is
 * SELF_INTERSECTING_POLYGON. Holes are unsupported: nested rings read as
 * self-touching input and refuse.
 */
export function fillPolygon(
	canvas: PixelCanvas,
	layerId: string,
	points: ReadonlyArray<PolygonPoint>,
	color: RGBA,
): void {
	getLayer(canvas, layerId);
	if (points.length > POLYGON_MAX_POINTS) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			`Polygon needs at most ${POLYGON_MAX_POINTS} points; split the shape instead.`,
			{ count: points.length, limit: POLYGON_MAX_POINTS },
		);
	}
	for (let i = 0; i < points.length; i += 1) {
		const point = points[i] as PolygonPoint;
		validateCoordinate(point.x, "x");
		validateCoordinate(point.y, "y");
		assertPixelInBounds(canvas.width, canvas.height, point.x, point.y);
	}
	const n = points.length;
	for (let i = 0; i < n; i += 1) {
		const a = points[i] as PolygonPoint;
		const b = points[(i + 1) % n] as PolygonPoint;
		if (a.x === b.x && a.y === b.y) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"Polygon points must not repeat an adjacent vertex, including the closing repeat of the first point.",
				{ index: i },
			);
		}
	}
	const seen = new Set<string>();
	for (const point of points) {
		seen.add(`${point.x},${point.y}`);
	}
	if (seen.size < 3) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Polygon needs at least 3 distinct points.",
			{ distinct: seen.size },
		);
	}
	const origin = points[0] as PolygonPoint;
	const second = points[1] as PolygonPoint;
	const baseX = second.x - origin.x;
	const baseY = second.y - origin.y;
	let collinear = true;
	for (let i = 2; i < n; i += 1) {
		const point = points[i] as PolygonPoint;
		if ((point.x - origin.x) * baseY - (point.y - origin.y) * baseX !== 0) {
			collinear = false;
			break;
		}
	}
	if (collinear) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Polygon points must not be fully collinear; holes are unsupported.",
			{},
		);
	}
	for (let i = 0; i < n; i += 1) {
		const a = points[i] as PolygonPoint;
		const b = points[(i + 1) % n] as PolygonPoint;
		for (let j = i + 1; j < n; j += 1) {
			if (j === i + 1 || (i === 0 && j === n - 1)) {
				continue;
			}
			const c = points[j] as PolygonPoint;
			const d = points[(j + 1) % n] as PolygonPoint;
			if (segmentsTouch(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y)) {
				throw new McAssetError(
					"SELF_INTERSECTING_POLYGON",
					"Polygon edges must not touch or cross except at shared vertices; holes are unsupported, split the shape instead.",
					{ edgeA: i, edgeB: j },
				);
			}
		}
	}
	validateColor(color);
	let minX = (points[0] as PolygonPoint).x;
	let maxX = minX;
	let minY = (points[0] as PolygonPoint).y;
	let maxY = minY;
	for (let i = 1; i < n; i += 1) {
		const point = points[i] as PolygonPoint;
		if (point.x < minX) {
			minX = point.x;
		}
		if (point.x > maxX) {
			maxX = point.x;
		}
		if (point.y < minY) {
			minY = point.y;
		}
		if (point.y > maxY) {
			maxY = point.y;
		}
	}
	// Scanline raster: each row collects its straddling-edge crossings as
	// exact fractions plus its boundary runs, then paints merged runs.
	// This replaces per-pixel edge rescanning (bounding-box area times
	// vertex count) with one edge pass per row plus a sort of that row's
	// crossings. Crossings pair up exactly as the ray-casting parity they
	// replace: for non-boundary pixels the crossings strictly right of x
	// are odd inside a paired span and even outside it, while span
	// endpoints and integer intersections land in the boundary runs, so
	// the painted set is identical and writes stay row-major.
	const crossings: Array<{ num: number; den: number }> = [];
	const runs: Array<{ lo: number; hi: number }> = [];
	for (let py = minY; py <= maxY; py += 1) {
		crossings.length = 0;
		runs.length = 0;
		for (let i = 0; i < n; i += 1) {
			const a = points[i] as PolygonPoint;
			const b = points[(i + 1) % n] as PolygonPoint;
			if (py < (a.y < b.y ? a.y : b.y) || py > (a.y > b.y ? a.y : b.y)) {
				continue;
			}
			if (a.y === b.y) {
				runs.push({
					lo: a.x < b.x ? a.x : b.x,
					hi: a.x > b.x ? a.x : b.x,
				});
				continue;
			}
			// Intersection abscissa as an exact fraction with den > 0:
			// x = (ax*dy + (py-ay)*dx) / dy.
			const dy = b.y - a.y;
			let num = a.x * dy + (py - a.y) * (b.x - a.x);
			let den = dy;
			if (den < 0) {
				num = 0 - num;
				den = 0 - den;
			}
			if (num % den === 0) {
				const at = num / den;
				runs.push({ lo: at, hi: at });
			}
			if (a.y > py !== b.y > py) {
				crossings.push({ num, den });
			}
		}
		crossings.sort(
			(left, right) => left.num * right.den - right.num * left.den,
		);
		for (let k = 0; k + 1 < crossings.length; k += 2) {
			const first = crossings[k] as { num: number; den: number };
			const second = crossings[k + 1] as { num: number; den: number };
			const lo = ceilDiv(first.num, first.den);
			const hi = floorDiv(second.num, second.den);
			if (lo <= hi) {
				runs.push({ lo, hi });
			}
		}
		if (runs.length === 0) {
			continue;
		}
		runs.sort((left, right) => left.lo - right.lo);
		let curLo = (runs[0] as { lo: number; hi: number }).lo;
		let curHi = (runs[0] as { lo: number; hi: number }).hi;
		for (let r = 1; r < runs.length; r += 1) {
			const run = runs[r] as { lo: number; hi: number };
			if (run.lo <= curHi + 1) {
				if (run.hi > curHi) {
					curHi = run.hi;
				}
			} else {
				for (let px = curLo; px <= curHi; px += 1) {
					setPixel(canvas, layerId, px, py, color);
				}
				curLo = run.lo;
				curHi = run.hi;
			}
		}
		for (let px = curLo; px <= curHi; px += 1) {
			setPixel(canvas, layerId, px, py, color);
		}
	}
}

/**
 * Outside 1px 4-neighbor outline of a source mask, clipped to the canvas.
 * The mask cells themselves are never members; edge cells simply have
 * fewer in-canvas neighbors. Shared by the batch entry and the inspect
 * write-scope replay so both agree on the footprint.
 */
export function strokeOutlineCells(
	source: Uint8Array,
	width: number,
	height: number,
): Uint8Array {
	const out = new Uint8Array(width * height);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const index = y * width + x;
			if (source[index] === 1) {
				continue;
			}
			if (
				(x > 0 && source[index - 1] === 1) ||
				(x + 1 < width && source[index + 1] === 1) ||
				(y > 0 && source[index - width] === 1) ||
				(y + 1 < height && source[index + width] === 1)
			) {
				out[index] = 1;
			}
		}
	}
	return out;
}

/**
 * Paint a precomputed stroke outline. The source mask is read-only here;
 * only outline cells are written, row-major, after color validation, so a
 * bad color never leaves partial pixels.
 */
export function strokeMask(
	canvas: PixelCanvas,
	layerId: string,
	source: Uint8Array,
	color: RGBA,
): void {
	getLayer(canvas, layerId);
	validateColor(color);
	const outline = strokeOutlineCells(source, canvas.width, canvas.height);
	for (let y = 0; y < canvas.height; y += 1) {
		for (let x = 0; x < canvas.width; x += 1) {
			if (outline[y * canvas.width + x] === 1) {
				setPixel(canvas, layerId, x, y, color);
			}
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
