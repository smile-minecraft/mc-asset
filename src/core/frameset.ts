import { flattenCanvas } from "../io/png.ts";
import { McAssetError } from "./errors.ts";
import { type ResizeMode, resize } from "./transform.ts";
import type { PixelCanvas } from "./types.ts";
import {
	assertValidCanvas,
	checkResourceLimits,
	estimateMemoryBytes,
	validateDimension,
} from "./validate.ts";

/**
 * FrameSet model and Animation Engine (pack / unpack / reorder / resize /
 * geometry validate / preview report). A FrameSet lives in memory; on disk
 * it is a frames directory with one .mcpx per frame. Sheets are plain RGBA
 * buffers so the CLI layer owns PNG encode / decode.
 */

export type AnimationLayout = "vertical" | "horizontal" | "grid";

export type FrameSetMetadata = Record<string, unknown>;

export interface FrameSet {
	frames: PixelCanvas[];
	frameWidth: number;
	frameHeight: number;
	metadata?: FrameSetMetadata | undefined;
}

export interface PackedSheet {
	width: number;
	height: number;
	pixels: Uint8Array;
}

export interface GeometryReport {
	command: "animate";
	mode: "validate";
	frameCount: number;
	frameWidth: number;
	frameHeight: number;
	verdict: "pass" | "fail";
	findings: Array<{
		level: "error" | "warning";
		code: string;
		message: string;
	}>;
}

const LAYOUTS: ReadonlyArray<AnimationLayout> = [
	"vertical",
	"horizontal",
	"grid",
];

/** Parse --layout: required on pack / unpack / preview, no default. */
export function parseAnimationLayout(raw: string | undefined): AnimationLayout {
	if (raw === undefined || raw === "") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"--layout is required (vertical, horizontal, or grid).",
			{ layout: raw },
		);
	}
	if (!(LAYOUTS as ReadonlyArray<string>).includes(raw)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Unknown layout "${raw}". Layouts: vertical, horizontal, grid.`,
			{ layout: raw },
		);
	}
	return raw as AnimationLayout;
}

function parsePositiveInt(raw: string, flag: string, what: string): number {
	if (!/^[0-9]+$/.test(raw)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`${flag} ${what} must be a positive integer, got "${raw}".`,
			{ [what]: raw },
		);
	}
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`${flag} ${what} must be a positive integer, got "${raw}".`,
			{ [what]: raw },
		);
	}
	return parsed;
}

/** Parse --columns: required with grid, a positive integer. */
export function parseGridColumns(
	layout: AnimationLayout,
	raw: string | undefined,
): number | undefined {
	if (layout !== "grid") {
		return undefined;
	}
	if (raw === undefined || raw === "") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"--columns is required with --layout grid.",
			{ layout },
		);
	}
	const columns = parsePositiveInt(raw, "--columns", "columns");
	if (columns < 1) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`--columns must be a positive integer, got "${raw}".`,
			{ columns: raw },
		);
	}
	return columns;
}

/**
 * Parse --frame-size: `N` means NxN, `WxH` a rectangle. Non-integers are
 * INVALID_ARGUMENT; out-of-range edges are INVALID_DIMENSION.
 */
export function parseFrameSize(raw: string | undefined): {
	width: number;
	height: number;
} {
	if (raw === undefined || raw === "") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"--frame-size is required (N or WxH).",
			{ frameSize: raw },
		);
	}
	const parts = raw.split("x");
	let width: number;
	let height: number;
	if (parts.length === 1) {
		const edge = parsePositiveInt(parts[0] as string, "--frame-size", "edge");
		width = edge;
		height = edge;
	} else if (parts.length === 2) {
		width = parsePositiveInt(parts[0] as string, "--frame-size", "width");
		height = parsePositiveInt(parts[1] as string, "--frame-size", "height");
	} else {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`--frame-size must be N or WxH, got "${raw}".`,
			{ frameSize: raw },
		);
	}
	validateDimension(width);
	validateDimension(height);
	return { width, height };
}

function assertPermutation(order: number[], count: number): void {
	if (order.length !== count) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`--order must list all ${count} frames exactly once, got ${order.length} entries.`,
			{ order, expected: count, actual: order.length },
		);
	}
	const seen = new Set<number>();
	for (let position = 0; position < order.length; position += 1) {
		const value = order[position] as number;
		if (!Number.isInteger(value) || value < 0 || value >= count) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				`--order entry ${position} is out of range [0, ${count}): ${value}.`,
				{ order, position, value },
			);
		}
		if (seen.has(value)) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				`--order repeats frame ${value}; it must be a permutation of [0, ${count}).`,
				{ order, position, value },
			);
		}
		seen.add(value);
	}
}

/**
 * Parse --order: a comma list of 0-based indices that must permute
 * [0, count). Length mismatch, repeats, and out-of-range entries are all
 * INVALID_ARGUMENT with the offending position in details.
 */
export function parseFrameOrder(
	raw: string | undefined,
	count: number,
): number[] {
	if (raw === undefined || raw === "") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"--order is required (a comma list permuting [0, count)).",
			{ order: raw },
		);
	}
	const parts = raw.split(",");
	const order: number[] = parts.map((part, position) => {
		const trimmed = part.trim();
		if (!/^[0-9]+$/.test(trimmed)) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				`--order entry ${position} must be a non-negative integer, got "${part}".`,
				{ order: raw, position, value: part },
			);
		}
		return Number(trimmed);
	});
	assertPermutation(order, count);
	return order;
}

/** Output frame name: frame_<n>.mcpx padded to the width of (count - 1). */
export function frameFileName(index: number, count: number): string {
	const width = String(Math.max(0, count - 1)).length;
	return `frame_${String(index).padStart(width, "0")}.mcpx`;
}

/**
 * Validate the memory model: count >= 1, every frame a valid canvas of the
 * shared frameWidth x frameHeight. Mismatches are INVALID_ANIMATION_FRAME
 * with the frame index plus expected / actual dimensions.
 */
export function createFrameSet(
	frames: PixelCanvas[],
	metadata?: FrameSetMetadata,
): FrameSet {
	if (frames.length === 0) {
		throw new McAssetError(
			"INVALID_ANIMATION_FRAME",
			"FrameSet needs at least one frame.",
			{ count: 0 },
		);
	}
	const first = frames[0] as PixelCanvas;
	assertValidCanvas(first);
	const frameWidth = first.width;
	const frameHeight = first.height;
	for (let index = 0; index < frames.length; index += 1) {
		const frame = frames[index] as PixelCanvas;
		assertValidCanvas(frame);
		if (frame.width !== frameWidth || frame.height !== frameHeight) {
			throw new McAssetError(
				"INVALID_ANIMATION_FRAME",
				`Frame ${index} is ${frame.width}x${frame.height}; every frame must be ${frameWidth}x${frameHeight}.`,
				{
					index,
					frameIndex: index,
					expected: { width: frameWidth, height: frameHeight },
					actual: { width: frame.width, height: frame.height },
				},
			);
		}
	}
	return {
		frames: [...frames],
		frameWidth,
		frameHeight,
		...(metadata !== undefined ? { metadata: { ...metadata } } : {}),
	};
}

/** Frozen sheet size formulas: no scaling, no auto layout. */
export function sheetDimensions(
	count: number,
	frameWidth: number,
	frameHeight: number,
	layout: AnimationLayout,
	columns?: number,
): { width: number; height: number } {
	if (layout === "vertical") {
		return { width: frameWidth, height: frameHeight * count };
	}
	if (layout === "horizontal") {
		return { width: frameWidth * count, height: frameHeight };
	}
	if (columns === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"--columns is required with --layout grid.",
			{ layout },
		);
	}
	const rows = Math.ceil(count / columns);
	return { width: frameWidth * columns, height: frameHeight * rows };
}

/** Cell origin of frame index under the layout; row-major for grid. */
function cellOrigin(
	index: number,
	frameWidth: number,
	frameHeight: number,
	layout: AnimationLayout,
	columns: number,
): { x: number; y: number } {
	if (layout === "vertical") {
		return { x: 0, y: index * frameHeight };
	}
	if (layout === "horizontal") {
		return { x: index * frameWidth, y: 0 };
	}
	return {
		x: (index % columns) * frameWidth,
		y: Math.floor(index / columns) * frameHeight,
	};
}

function assertSheetFits(width: number, height: number): void {
	validateDimension(width);
	validateDimension(height);
	checkResourceLimits(width, height, 1, 0);
}

function flattenedFrame(frame: PixelCanvas): Uint8Array {
	return flattenCanvas(frame);
}

/**
 * Pack a FrameSet into a sprite sheet buffer at 1:1 (never scaled).
 * Multi-layer frames flatten first; grid empties stay transparent black.
 */
export function packFrameSet(
	frameSet: FrameSet,
	layout: AnimationLayout,
	columns?: number,
): PackedSheet {
	const count = frameSet.frames.length;
	const { width, height } = sheetDimensions(
		count,
		frameSet.frameWidth,
		frameSet.frameHeight,
		layout,
		columns,
	);
	assertSheetFits(width, height);
	const gridColumns = layout === "grid" ? (columns as number) : 1;
	const pixels = new Uint8Array(width * height * 4);
	for (let index = 0; index < count; index += 1) {
		const frame = frameSet.frames[index] as PixelCanvas;
		const flat = flattenedFrame(frame);
		const origin = cellOrigin(
			index,
			frameSet.frameWidth,
			frameSet.frameHeight,
			layout,
			gridColumns,
		);
		for (let y = 0; y < frameSet.frameHeight; y += 1) {
			for (let x = 0; x < frameSet.frameWidth; x += 1) {
				const from = (y * frameSet.frameWidth + x) * 4;
				const to = ((origin.y + y) * width + origin.x + x) * 4;
				pixels[to] = flat[from] as number;
				pixels[to + 1] = flat[from + 1] as number;
				pixels[to + 2] = flat[from + 2] as number;
				pixels[to + 3] = flat[from + 3] as number;
			}
		}
	}
	return { width, height, pixels };
}

function animationFrameError(
	message: string,
	details: Record<string, unknown>,
): McAssetError {
	return new McAssetError("INVALID_ANIMATION_FRAME", message, details);
}

/**
 * Unpack a sheet buffer into single-layer frames. Every divisibility rule
 * is checked before any frame is allocated; violations carry the layout
 * plus sheet and frame dimensions in details.
 */
export function unpackSheetToFrameSet(
	pixels: Uint8Array,
	sheetWidth: number,
	sheetHeight: number,
	layout: AnimationLayout,
	frameWidth: number,
	frameHeight: number,
	columns?: number,
): FrameSet {
	validateDimension(frameWidth);
	validateDimension(frameHeight);
	if (pixels.length !== sheetWidth * sheetHeight * 4) {
		throw animationFrameError(
			"Sheet pixel buffer size must match its dimensions.",
			{
				layout,
				sheetWidth,
				sheetHeight,
				frameWidth,
				frameHeight,
				expected: sheetWidth * sheetHeight * 4,
				actual: pixels.length,
			},
		);
	}
	let count: number;
	let gridColumns = 1;
	if (layout === "vertical") {
		if (sheetWidth !== frameWidth || sheetHeight % frameHeight !== 0) {
			throw animationFrameError(
				`Vertical sheet ${sheetWidth}x${sheetHeight} cannot hold ${frameWidth}x${frameHeight} frames.`,
				{ layout, sheetWidth, sheetHeight, frameWidth, frameHeight },
			);
		}
		count = sheetHeight / frameHeight;
	} else if (layout === "horizontal") {
		if (sheetHeight !== frameHeight || sheetWidth % frameWidth !== 0) {
			throw animationFrameError(
				`Horizontal sheet ${sheetWidth}x${sheetHeight} cannot hold ${frameWidth}x${frameHeight} frames.`,
				{ layout, sheetWidth, sheetHeight, frameWidth, frameHeight },
			);
		}
		count = sheetWidth / frameWidth;
	} else {
		if (columns === undefined) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"--columns is required with --layout grid.",
				{ layout },
			);
		}
		if (sheetWidth % columns !== 0) {
			throw animationFrameError(
				`Grid sheet width ${sheetWidth} is not divisible by ${columns} columns.`,
				{
					layout,
					sheetWidth,
					sheetHeight,
					frameWidth,
					frameHeight,
					columns,
				},
			);
		}
		const cellWidth = sheetWidth / columns;
		if (cellWidth !== frameWidth) {
			throw animationFrameError(
				`Grid cell width ${cellWidth} does not match frame width ${frameWidth}.`,
				{
					layout,
					sheetWidth,
					sheetHeight,
					frameWidth,
					frameHeight,
					columns,
					cellWidth,
				},
			);
		}
		if (sheetHeight % frameHeight !== 0) {
			throw animationFrameError(
				`Grid sheet height ${sheetHeight} is not divisible by frame height ${frameHeight}.`,
				{
					layout,
					sheetWidth,
					sheetHeight,
					frameWidth,
					frameHeight,
					columns,
				},
			);
		}
		gridColumns = columns;
		count = (sheetWidth / frameWidth) * (sheetHeight / frameHeight);
	}
	if (count < 1) {
		throw animationFrameError("Sheet holds no frames.", {
			layout,
			sheetWidth,
			sheetHeight,
			frameWidth,
			frameHeight,
		});
	}
	if (
		estimateMemoryBytes(frameWidth, frameHeight, count, 0) >
		512 * 1024 * 1024
	) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			"Estimated frame memory exceeds the 512 MB budget.",
			{ frameWidth, frameHeight, count },
		);
	}
	const frames: PixelCanvas[] = [];
	for (let index = 0; index < count; index += 1) {
		const origin = cellOrigin(
			index,
			frameWidth,
			frameHeight,
			layout,
			gridColumns,
		);
		const cell = new Uint8Array(frameWidth * frameHeight * 4);
		for (let y = 0; y < frameHeight; y += 1) {
			for (let x = 0; x < frameWidth; x += 1) {
				const from = ((origin.y + y) * sheetWidth + origin.x + x) * 4;
				const to = (y * frameWidth + x) * 4;
				cell[to] = pixels[from] as number;
				cell[to + 1] = pixels[from + 1] as number;
				cell[to + 2] = pixels[from + 2] as number;
				cell[to + 3] = pixels[from + 3] as number;
			}
		}
		frames.push({
			version: 1,
			width: frameWidth,
			height: frameHeight,
			layers: [
				{
					id: "base",
					pixels: cell,
					visible: true,
					opacity: 1,
					blendMode: "normal",
				},
			],
			regions: [],
			metadata: {},
		});
	}
	return createFrameSet(frames);
}

/**
 * Rebuild the frame order from an explicit permutation: the new sequence at
 * position i is the old entry order[i]. Entries are never touched, so
 * callers moving raw .mcpx text keep every byte verbatim.
 */
export function reorderFrames<T>(items: T[], order: number[]): T[] {
	assertPermutation(order, items.length);
	return order.map((source) => items[source] as T);
}

/**
 * The only entry that changes frame dimensions: every frame is resized
 * with the shared transform integer kernels (nearest default, box or
 * pixel-aware optional). Unknown modes are INVALID_ARGUMENT and the
 * FrameSet is left untouched.
 */
export function resizeFrameSet(
	frameSet: FrameSet,
	width: number,
	height: number,
	mode?: ResizeMode,
): void {
	if (
		mode !== undefined &&
		mode !== "nearest" &&
		mode !== "box" &&
		mode !== "pixel-aware"
	) {
		throw new McAssetError("INVALID_ARGUMENT", "Unknown resize mode.", {
			mode,
		});
	}
	validateDimension(width);
	validateDimension(height);
	for (const frame of frameSet.frames) {
		checkResourceLimits(
			width,
			height,
			frame.layers.length,
			frame.regions.length,
		);
	}
	for (const frame of frameSet.frames) {
		resize(frame, width, height, mode ?? "nearest");
	}
	frameSet.frameWidth = width;
	frameSet.frameHeight = height;
}

/** Deterministic geometry census: structural faults throw before this returns. */
export function describeFrameSet(frameSet: FrameSet): GeometryReport {
	return {
		command: "animate",
		mode: "validate",
		frameCount: frameSet.frames.length,
		frameWidth: frameSet.frameWidth,
		frameHeight: frameSet.frameHeight,
		verdict: "pass",
		findings: [],
	};
}
