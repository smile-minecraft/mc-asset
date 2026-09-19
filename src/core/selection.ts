import { getRegion } from "./canvas.ts";
import { McAssetError } from "./errors.ts";
import type { PixelCanvas, Rect } from "./types.ts";
import {
	assertPixelInBounds,
	assertValidCanvas,
	validateCoordinate,
} from "./validate.ts";

export type SelectionKind = "all" | "rect" | "region";

/**
 * A resolved, single-call scope for pixel-writing operations. The object is
 * transient: it is resolved once before the first pixel write, shared by every
 * write of that call, and never stored on the canvas or serialized.
 */
export interface ResolvedSelection {
	readonly kind: SelectionKind;
	/** Present only when kind is "rect". A detached copy, safe to read. */
	readonly rect?: Rect;
	/** Present only when kind is "region". The mask is read live, never written. */
	readonly regionId?: string;
}

export interface SelectedPoint {
	x: number;
	y: number;
}

const RECT_PREFIX = "rect:";
const REGION_PREFIX = "region:";
const DECIMAL_INTEGER = /^[+-]?\d+$/;

function parseDecimalInteger(text: string): number {
	if (!DECIMAL_INTEGER.test(text)) {
		throw new McAssetError(
			"INVALID_COORDINATE",
			"Selection rect components must be decimal integers, without rounding.",
			{ value: text },
		);
	}
	return Number(text);
}

/**
 * Selection rects carry their own error mapping, fixed by the selection
 * freeze: non-integer components are INVALID_COORDINATE, width/height below 1
 * are INVALID_ARGUMENT, and anything outside the canvas is OUT_OF_BOUNDS with
 * no silent clipping. This deliberately differs from the generic rect
 * validator, whose dimension code does not apply on this path.
 */
function parseRect(canvas: PixelCanvas, body: string): Rect {
	const parts = body.split(",");
	if (parts.length !== 4) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Selection rect needs exactly x,y,width,height.",
			{ value: body },
		);
	}
	const numbers = parts.map((part) => {
		// A missing component is a malformed string, not a mistyped number.
		if (part.trim().length === 0) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"Selection rect components must not be empty.",
				{ value: body },
			);
		}
		return parseDecimalInteger(part.trim());
	});
	const rect: Rect = {
		x: numbers[0] as number,
		y: numbers[1] as number,
		width: numbers[2] as number,
		height: numbers[3] as number,
	};
	if (rect.width < 1 || rect.height < 1) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Selection rect width and height must be at least 1.",
			{ width: rect.width, height: rect.height },
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
			"Selection rect is outside canvas.",
			{
				rect,
				width: canvas.width,
				height: canvas.height,
			},
		);
	}
	return rect;
}

function parseRegion(canvas: PixelCanvas, body: string): string {
	// Region ids are opaque: the id is matched verbatim, without trimming.
	if (body.length === 0) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Selection region needs a non-empty id.",
			{ value: body },
		);
	}
	if (canvas.regions.length === 0) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Selection region needs a source that carries regions.",
			{ id: body },
		);
	}
	// Throws REGION_NOT_FOUND when the id does not exist; the mask is only read.
	getRegion(canvas, body);
	return body;
}

/**
 * Resolve a raw `--selection` value against a canvas. `undefined` (flag
 * omitted) selects the whole canvas. The returned scope is a plain transient
 * value: resolving never writes pixels, never touches a region mask, and never
 * changes canvas dimensions.
 */
export function resolveSelection(
	canvas: PixelCanvas,
	raw: string | undefined,
): ResolvedSelection {
	assertValidCanvas(canvas);
	if (raw === undefined) {
		return { kind: "all" };
	}
	const text = raw.trim();
	if (text.startsWith(RECT_PREFIX)) {
		return {
			kind: "rect",
			rect: parseRect(canvas, text.slice(RECT_PREFIX.length)),
		};
	}
	if (text.startsWith(REGION_PREFIX)) {
		return {
			kind: "region",
			regionId: parseRegion(canvas, text.slice(REGION_PREFIX.length)),
		};
	}
	throw new McAssetError(
		"INVALID_ARGUMENT",
		"Selection must be rect:<x>,<y>,<width>,<height> or region:<id>.",
		{ value: raw },
	);
}

function rectOf(selection: ResolvedSelection): Rect {
	const rect = selection.rect;
	if (selection.kind !== "rect" || rect === undefined) {
		throw new McAssetError(
			"INTERNAL_ERROR",
			"Rect selection is missing its rect.",
		);
	}
	return rect;
}

function maskOf(canvas: PixelCanvas, selection: ResolvedSelection): Uint8Array {
	if (selection.kind !== "region" || selection.regionId === undefined) {
		throw new McAssetError(
			"INTERNAL_ERROR",
			"Region selection is missing its region id.",
		);
	}
	return getRegion(canvas, selection.regionId).mask;
}

/**
 * Membership test for one pixel. Coordinates keep the strict engine errors:
 * non-integers are INVALID_COORDINATE and out-of-bounds pixels are
 * OUT_OF_BOUNDS, so a selection can never silently clip a write path.
 */
export function isPixelSelected(
	selection: ResolvedSelection,
	canvas: PixelCanvas,
	x: number,
	y: number,
): boolean {
	assertValidCanvas(canvas);
	validateCoordinate(x, "x");
	validateCoordinate(y, "y");
	assertPixelInBounds(canvas.width, canvas.height, x, y);
	if (selection.kind === "all") {
		return true;
	}
	if (selection.kind === "rect") {
		const rect = rectOf(selection);
		return (
			x >= rect.x &&
			x < rect.x + rect.width &&
			y >= rect.y &&
			y < rect.y + rect.height
		);
	}
	return maskOf(canvas, selection)[y * canvas.width + x] === 1;
}

/** Enumerate the selected pixels in row-major order (top row first). */
export function listSelectedPixels(
	selection: ResolvedSelection,
	canvas: PixelCanvas,
): SelectedPoint[] {
	assertValidCanvas(canvas);
	const points: SelectedPoint[] = [];
	if (selection.kind === "all") {
		for (let y = 0; y < canvas.height; y += 1) {
			for (let x = 0; x < canvas.width; x += 1) {
				points.push({ x, y });
			}
		}
		return points;
	}
	if (selection.kind === "rect") {
		const rect = rectOf(selection);
		for (let y = rect.y; y < rect.y + rect.height; y += 1) {
			for (let x = rect.x; x < rect.x + rect.width; x += 1) {
				points.push({ x, y });
			}
		}
		return points;
	}
	const mask = maskOf(canvas, selection);
	for (let y = 0; y < canvas.height; y += 1) {
		for (let x = 0; x < canvas.width; x += 1) {
			if (mask[y * canvas.width + x] === 1) {
				points.push({ x, y });
			}
		}
	}
	return points;
}

/**
 * Visit each selected pixel in row-major order without allocating a list.
 * The callback performs the actual write; selection membership only gates it.
 */
export function forEachSelectedPixel(
	selection: ResolvedSelection,
	canvas: PixelCanvas,
	visit: (x: number, y: number) => void,
): void {
	assertValidCanvas(canvas);
	if (selection.kind === "all") {
		for (let y = 0; y < canvas.height; y += 1) {
			for (let x = 0; x < canvas.width; x += 1) {
				visit(x, y);
			}
		}
		return;
	}
	if (selection.kind === "rect") {
		const rect = rectOf(selection);
		for (let y = rect.y; y < rect.y + rect.height; y += 1) {
			for (let x = rect.x; x < rect.x + rect.width; x += 1) {
				visit(x, y);
			}
		}
		return;
	}
	const mask = maskOf(canvas, selection);
	for (let y = 0; y < canvas.height; y += 1) {
		for (let x = 0; x < canvas.width; x += 1) {
			if (mask[y * canvas.width + x] === 1) {
				visit(x, y);
			}
		}
	}
}

/** Count the selected pixels with integer arithmetic only. */
export function countSelectedPixels(
	selection: ResolvedSelection,
	canvas: PixelCanvas,
): number {
	assertValidCanvas(canvas);
	if (selection.kind === "all") {
		return canvas.width * canvas.height;
	}
	if (selection.kind === "rect") {
		const rect = rectOf(selection);
		return rect.width * rect.height;
	}
	const mask = maskOf(canvas, selection);
	let count = 0;
	for (let i = 0; i < mask.length; i += 1) {
		if (mask[i] === 1) {
			count += 1;
		}
	}
	return count;
}
