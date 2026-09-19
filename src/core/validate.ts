import { McAssetError } from "./errors.ts";
import type { PixelCanvas, Rect, RGBA } from "./types.ts";

export const CANVAS_MIN_EDGE = 1;
export const CANVAS_MAX_EDGE = 4096;
export const MAX_LAYER_COUNT = 64;
export const MAX_REGION_COUNT = 256;
export const BYTES_PER_PIXEL = 4;
export const MASK_BYTES_PER_PIXEL = 1;
export const MEMORY_BUDGET_BYTES = 512 * 1024 * 1024;
export const CANVAS_VERSION = 1;

export function validateDimension(value: number): number {
	if (
		!Number.isInteger(value) ||
		value < CANVAS_MIN_EDGE ||
		value > CANVAS_MAX_EDGE
	) {
		throw new McAssetError(
			"INVALID_DIMENSION",
			`Canvas edge must be an integer in [${CANVAS_MIN_EDGE}, ${CANVAS_MAX_EDGE}].`,
			{ value },
		);
	}
	return value;
}

export function validateCoordinate(value: number, axis: "x" | "y"): number {
	if (!Number.isInteger(value)) {
		throw new McAssetError(
			"INVALID_COORDINATE",
			`Pixel ${axis} must be an integer, without rounding.`,
			{
				axis,
				value,
			},
		);
	}
	return value;
}

export function assertPixelInBounds(
	width: number,
	height: number,
	x: number,
	y: number,
): void {
	if (x < 0 || y < 0 || x >= width || y >= height) {
		throw new McAssetError(
			"OUT_OF_BOUNDS",
			"Pixel coordinate is outside canvas.",
			{
				x,
				y,
				width,
				height,
			},
		);
	}
}

export function validateRect(rect: Rect): Rect {
	validateCoordinate(rect.x, "x");
	validateCoordinate(rect.y, "y");
	if (!Number.isInteger(rect.width) || rect.width < CANVAS_MIN_EDGE) {
		throw new McAssetError(
			"INVALID_DIMENSION",
			"Rect width must be a positive integer.",
			{
				width: rect.width,
			},
		);
	}
	if (!Number.isInteger(rect.height) || rect.height < CANVAS_MIN_EDGE) {
		throw new McAssetError(
			"INVALID_DIMENSION",
			"Rect height must be a positive integer.",
			{
				height: rect.height,
			},
		);
	}
	return rect;
}

export function assertRectInBounds(
	width: number,
	height: number,
	rect: Rect,
): void {
	validateRect(rect);
	if (
		rect.x < 0 ||
		rect.y < 0 ||
		rect.x + rect.width > width ||
		rect.y + rect.height > height
	) {
		throw new McAssetError("OUT_OF_BOUNDS", "Rect is outside canvas.", {
			rect,
			width,
			height,
		});
	}
}

function isChannel(value: number): boolean {
	return Number.isInteger(value) && value >= 0 && value <= 255;
}

export function validateColor(color: RGBA): RGBA {
	if (
		!isChannel(color.r) ||
		!isChannel(color.g) ||
		!isChannel(color.b) ||
		!isChannel(color.a)
	) {
		throw new McAssetError(
			"INVALID_COLOR",
			"Each RGBA channel must be an integer in [0, 255].",
			{
				color,
			},
		);
	}
	return color;
}

export function validateOpacity(value: number): number {
	if (
		typeof value !== "number" ||
		Number.isNaN(value) ||
		value < 0 ||
		value > 1
	) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Layer opacity must be a number in [0, 1].",
			{
				value,
			},
		);
	}
	return value;
}

export function validateMaskValue(value: number): number {
	if (!Number.isInteger(value) || (value !== 0 && value !== 1)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Region mask value must be 0 (outside) or 1 (inside).",
			{
				value,
			},
		);
	}
	return value;
}

export function validateLayerPixelsSize(
	width: number,
	height: number,
	pixels: Uint8Array,
): void {
	if (pixels.length !== width * height * BYTES_PER_PIXEL) {
		throw new McAssetError(
			"INVALID_DIMENSION",
			"Layer pixel buffer size must match canvas dimensions.",
			{
				expected: width * height * BYTES_PER_PIXEL,
				actual: pixels.length,
				width,
				height,
			},
		);
	}
}

export function validateRegionMaskSize(
	width: number,
	height: number,
	mask: Uint8Array,
): void {
	if (mask.length !== width * height * MASK_BYTES_PER_PIXEL) {
		throw new McAssetError(
			"INVALID_MASK_SIZE",
			"Region mask size must match canvas dimensions.",
			{
				expected: width * height,
				actual: mask.length,
				width,
				height,
			},
		);
	}
}

/** Memory estimate in bytes: width x height x (4 x layers + regions). */
export function estimateMemoryBytes(
	width: number,
	height: number,
	layerCount: number,
	regionCount: number,
): number {
	return (
		width *
		height *
		(BYTES_PER_PIXEL * layerCount + MASK_BYTES_PER_PIXEL * regionCount)
	);
}

/**
 * Resource gate. Runs before any buffer is allocated: count limits first,
 * then the 512 MB budget. Over either limit reports RESOURCE_LIMIT_EXCEEDED.
 */
export function checkResourceLimits(
	width: number,
	height: number,
	layerCount: number,
	regionCount: number,
): void {
	if (
		!Number.isInteger(layerCount) ||
		layerCount < 0 ||
		layerCount > MAX_LAYER_COUNT ||
		!Number.isInteger(regionCount) ||
		regionCount < 0 ||
		regionCount > MAX_REGION_COUNT
	) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			"Layer or region count exceeds the resource limit.",
			{
				layerCount,
				regionCount,
				maxLayers: MAX_LAYER_COUNT,
				maxRegions: MAX_REGION_COUNT,
			},
		);
	}
	if (
		estimateMemoryBytes(width, height, layerCount, regionCount) >
		MEMORY_BUDGET_BYTES
	) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			"Estimated memory exceeds the 512 MB budget.",
			{
				width,
				height,
				layerCount,
				regionCount,
				budgetBytes: MEMORY_BUDGET_BYTES,
			},
		);
	}
}

export function assertValidCanvas(canvas: PixelCanvas): void {
	if (canvas.version !== CANVAS_VERSION) {
		throw new McAssetError("INVALID_ARGUMENT", "Unsupported canvas version.", {
			version: canvas.version,
		});
	}
	validateDimension(canvas.width);
	validateDimension(canvas.height);
}
