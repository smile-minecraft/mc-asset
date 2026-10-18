import { flattenCanvas } from "../io/png.ts";
import { addLayer, createCanvas, replaceLayerPixels } from "./canvas.ts";
import { McAssetError } from "./errors.ts";
import { createFrameSet, type FrameSet } from "./frameset.ts";
import { parseFillColor } from "./layers.ts";
import type { PixelCanvas, RGBA } from "./types.ts";

/**
 * Sweep band frames: a highlight band walks across one still image and the
 * result is a vertical stack of frames. Everything here is integer-only and
 * reads no file, so Bun and Node build the same bytes.
 *
 * The band geometry is fixed: the band coordinate of a cell is x - y at 135
 * degrees, x + y at 45, x at 90, and y at 180; a diagonal band advances two
 * coordinate units per frame and a straight one advances one; the first band
 * coordinate is the smallest opaque coordinate minus the band width; frame 0
 * is the untouched source and frame i paints from
 * kStart + (i-1)*step through kStart + (i-1)*step + width - 1. Only fully opaque
 * cells are repainted, so the alpha plane and every hidden colour under
 * alpha 0 survive unchanged and the silhouette never moves.
 */

export type SweepAngleDegrees = 45 | 90 | 135 | 180;

/** The four supported angles in ascending order. */
export const SWEEP_ANGLES: readonly SweepAngleDegrees[] = [45, 90, 135, 180];

export const SWEEP_MIN_WIDTH_PIXELS = 1;
export const SWEEP_MAX_WIDTH_PIXELS = 8;
export const SWEEP_MIN_FRAMES = 1;
export const SWEEP_MAX_FRAMES = 64;

export interface SweepBandInput {
	/** The still image to sweep; only its opaque cells are ever repainted. */
	readonly canvas: PixelCanvas;
	readonly angleDegrees: SweepAngleDegrees;
	readonly widthPixels: number;
	/** The band colour; always written fully opaque. */
	readonly color: RGBA;
	readonly frames: number;
}

export interface SweepFramesResult {
	readonly frameSet: FrameSet;
	/** First painted band coordinate, or null when the source has no opaque cell. */
	readonly kStart: number | null;
	readonly opaquePixelCount: number;
}

function invalidArgument(message: string, details?: unknown): McAssetError {
	return new McAssetError("INVALID_ARGUMENT", message, details);
}

function parseBoundedInt(
	raw: string,
	flag: string,
	lowest: number,
	highest: number,
): number {
	if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) {
		throw invalidArgument(`${flag} must be an integer, got "${raw}".`, {
			[flag.replace(/^--/, "")]: raw,
		});
	}
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed < lowest || parsed > highest) {
		throw invalidArgument(
			`${flag} must be an integer from ${lowest} to ${highest}, got "${raw}".`,
			{ [flag.replace(/^--/, "")]: raw, min: lowest, max: highest },
		);
	}
	return parsed;
}

/** Parse `--angle`: only 45, 90, 135, and 180 are supported. */
export function parseSweepAngleDegrees(raw: string): SweepAngleDegrees {
	if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) {
		throw invalidArgument(
			`--angle must be 45, 90, 135, or 180, got "${raw}".`,
			{ angle: raw, supported: [...SWEEP_ANGLES] },
		);
	}
	const parsed = Number(raw);
	if (!(SWEEP_ANGLES as ReadonlyArray<number>).includes(parsed)) {
		throw invalidArgument(
			`--angle must be 45, 90, 135, or 180, got "${raw}".`,
			{ angle: raw, supported: [...SWEEP_ANGLES] },
		);
	}
	return parsed as SweepAngleDegrees;
}

/** Parse `--width`: the band width in pixels, 1 to 8. */
export function parseSweepWidthPixels(raw: string): number {
	return parseBoundedInt(
		raw,
		"--width",
		SWEEP_MIN_WIDTH_PIXELS,
		SWEEP_MAX_WIDTH_PIXELS,
	);
}

/** Parse `--frames`: how many frames the sweep emits, 1 to 64. */
export function parseSweepFrameCount(raw: string): number {
	return parseBoundedInt(raw, "--frames", SWEEP_MIN_FRAMES, SWEEP_MAX_FRAMES);
}

/** Parse `--color`: one opaque `#RRGGBB` band colour. */
export function parseSweepColor(raw: string): RGBA {
	const color = parseFillColor(raw);
	if (color.a !== 255) {
		throw invalidArgument("The band colour must be fully opaque.", {
			color: raw,
		});
	}
	return color;
}

function assertSweepInput(input: SweepBandInput): void {
	if (!(SWEEP_ANGLES as ReadonlyArray<number>).includes(input.angleDegrees)) {
		throw invalidArgument(
			`The band angle must be 45, 90, 135, or 180, got ${String(input.angleDegrees)}.`,
			{ angle: input.angleDegrees, supported: [...SWEEP_ANGLES] },
		);
	}
	if (
		!Number.isInteger(input.widthPixels) ||
		input.widthPixels < SWEEP_MIN_WIDTH_PIXELS ||
		input.widthPixels > SWEEP_MAX_WIDTH_PIXELS
	) {
		throw invalidArgument(
			`The band width must be an integer from ${SWEEP_MIN_WIDTH_PIXELS} to ${SWEEP_MAX_WIDTH_PIXELS}, got ${String(input.widthPixels)}.`,
			{
				width: input.widthPixels,
				min: SWEEP_MIN_WIDTH_PIXELS,
				max: SWEEP_MAX_WIDTH_PIXELS,
			},
		);
	}
	if (
		!Number.isInteger(input.frames) ||
		input.frames < SWEEP_MIN_FRAMES ||
		input.frames > SWEEP_MAX_FRAMES
	) {
		throw invalidArgument(
			`The frame count must be an integer from ${SWEEP_MIN_FRAMES} to ${SWEEP_MAX_FRAMES}, got ${String(input.frames)}.`,
			{
				frames: input.frames,
				min: SWEEP_MIN_FRAMES,
				max: SWEEP_MAX_FRAMES,
			},
		);
	}
}

/**
 * Build the sweep frames from one still image. The skeleton already returns
 * the frame geometry and the opaque-cell census; painting the band windows
 * is the next step, so every frame currently repeats the source unchanged.
 */
export function generateSweepFrames(input: SweepBandInput): SweepFramesResult {
	assertSweepInput(input);
	const width = input.canvas.width;
	const height = input.canvas.height;
	const source = flattenCanvas(input.canvas);
	let opaquePixelCount = 0;
	for (let offset = 3; offset < source.length; offset += 4) {
		if (source[offset] === 255) {
			opaquePixelCount += 1;
		}
	}
	const angle = input.angleDegrees;
	const bandWidth = input.widthPixels;
	const frames: PixelCanvas[] = [];
	let kStart: number | null = null;
	// smallest opaque band coordinate
	if (opaquePixelCount > 0) {
		let smallest = Number.MAX_SAFE_INTEGER;
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const offset = (y * width + x) * 4;
				if (source[offset + 3] !== 255) continue;
				let coord = 0;
				if (angle === 135) coord = x - y;
				else if (angle === 45) coord = x + y;
				else if (angle === 90) coord = x;
				else coord = y;
				if (coord < smallest) smallest = coord;
			}
		}
		kStart = smallest - bandWidth;
	}
	const step = angle === 135 || angle === 45 ? 2 : 1;
	const color = input.color;
	for (let index = 0; index < input.frames; index += 1) {
		const pixels = Uint8Array.from(source);
		if (index > 0 && kStart !== null) {
			const low = kStart + (index - 1) * step;
			const high = low + bandWidth - 1;
			for (let y = 0; y < height; y += 1) {
				for (let x = 0; x < width; x += 1) {
					const offset = (y * width + x) * 4;
					if (source[offset + 3] !== 255) continue;
					let coord = 0;
					if (angle === 135) coord = x - y;
					else if (angle === 45) coord = x + y;
					else if (angle === 90) coord = x;
					else coord = y;
					if (coord >= low && coord <= high) {
						pixels[offset] = color.r;
						pixels[offset + 1] = color.g;
						pixels[offset + 2] = color.b;
						pixels[offset + 3] = color.a;
					}
				}
			}
		}
		const canvas = createCanvas(width, height);
		const layer = addLayer(canvas, { id: "base" });
		replaceLayerPixels(canvas, layer.id, pixels);
		frames.push(canvas);
	}
	return {
		frameSet: createFrameSet(frames),
		kStart,
		opaquePixelCount,
	};
}
