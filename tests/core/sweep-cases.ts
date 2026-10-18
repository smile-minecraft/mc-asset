import assert from "node:assert/strict";
import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../src/core/canvas.ts";
import { McAssetError } from "../../src/core/errors.ts";
import type { FrameSet } from "../../src/core/frameset.ts";
import {
	generateSweepFrames,
	parseSweepAngleDegrees,
	parseSweepColor,
	parseSweepFrameCount,
	parseSweepWidthPixels,
} from "../../src/core/sweep.ts";
import type { PixelCanvas, RGBA } from "../../src/core/types.ts";
import { flattenCanvas } from "../../src/io/png.ts";

/**
 * Sweep band geometry: one original 16x16 gem drawn here from scratch, ten
 * frames, and the band coordinates recomputed here from the frozen rule
 * (135 -> b = x - y, 45 -> b = x + y, 90 -> b = x, 180 -> b = y; a diagonal
 * step of 2 and a straight step of 1; kStart = smallest opaque b - width;
 * frame 0 untouched; only opaque pixels repainted). The expected cell set is
 * derived in this file rather than copied from the implementation.
 */

const OUTLINE: RGBA = { r: 32, g: 34, b: 58, a: 255 };
const DARK: RGBA = { r: 58, g: 76, b: 128, a: 255 };
const BASE: RGBA = { r: 92, g: 124, b: 196, a: 255 };
const LIGHT: RGBA = { r: 138, g: 176, b: 232, a: 255 };
const HIGHLIGHT: RGBA = { r: 198, g: 222, b: 250, a: 255 };
const BAND: RGBA = { r: 255, g: 255, b: 255, a: 255 };

const GEM_COLORS: Record<string, RGBA> = {
	".": { r: 0, g: 0, b: 0, a: 0 },
	o: OUTLINE,
	d: DARK,
	b: BASE,
	l: LIGHT,
	h: HIGHLIGHT,
};

const GEM_ART: readonly string[] = [
	"................",
	"......dddd......",
	"....ddlllldd....",
	"...dllhhhhhhd...",
	"..dlhbbbbbbhld..",
	"..olbbbbbblllo..",
	".odlbbbbbbblbdo.",
	".odlbbbbbbblbdo.",
	".oobbbbbbbbbboo.",
	"..oobbbbbbbboo..",
	"...oobbbbbboo...",
	"....oobbbboo....",
	".....oobboo.....",
	"......oooo......",
	"................",
	"................",
];

function canvasFromArt(
	art: readonly string[],
	colors: Record<string, RGBA>,
): PixelCanvas {
	const height = art.length;
	const width = (art[0] ?? "").length;
	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		const row = art[y] as string;
		assert.equal(row.length, width, `art row ${y} must be ${width} cells`);
		for (let x = 0; x < width; x += 1) {
			const color = colors[row.charAt(x)];
			assert.ok(color !== undefined, `art row ${y} cell ${x} is known`);
			const offset = (y * width + x) * 4;
			pixels[offset] = color.r;
			pixels[offset + 1] = color.g;
			pixels[offset + 2] = color.b;
			pixels[offset + 3] = color.a;
		}
	}
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: "base" });
	replaceLayerPixels(canvas, layer.id, pixels);
	return canvas;
}

/** The original 16x16 gem used by every geometry case. */
function gemCanvas(): PixelCanvas {
	return canvasFromArt(GEM_ART, GEM_COLORS);
}

/** A filled rectangle with a one-cell transparent margin, for odd shapes. */
function slabCanvas(width: number, height: number): PixelCanvas {
	const pixels = new Uint8Array(width * height * 4);
	for (let y = 1; y < height - 1; y += 1) {
		for (let x = 1; x < width - 1; x += 1) {
			const offset = (y * width + x) * 4;
			pixels[offset] = OUTLINE.r;
			pixels[offset + 1] = OUTLINE.g;
			pixels[offset + 2] = OUTLINE.b;
			pixels[offset + 3] = OUTLINE.a;
		}
	}
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: "base" });
	replaceLayerPixels(canvas, layer.id, pixels);
	return canvas;
}

/** A canvas whose every cell is fully transparent, hidden RGB included. */
function clearCanvas(width: number, height: number): PixelCanvas {
	const pixels = new Uint8Array(width * height * 4);
	for (let offset = 0; offset < pixels.length; offset += 4) {
		pixels[offset] = 19;
		pixels[offset + 1] = 23;
		pixels[offset + 2] = 31;
		pixels[offset + 3] = 0;
	}
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: "base" });
	replaceLayerPixels(canvas, layer.id, pixels);
	return canvas;
}

function frameBytes(frameSet: FrameSet, index: number): Uint8Array {
	const frame = frameSet.frames[index];
	assert.ok(frame !== undefined, `frame ${index} exists`);
	const layer = frame.layers[0];
	assert.ok(layer !== undefined, `frame ${index} carries one layer`);
	return flattenCanvas(frame);
}

function cellKey(x: number, y: number): string {
	return `${x},${y}`;
}

function isOpaque(pixels: Uint8Array, x: number, y: number, width: number) {
	return pixels[(y * width + x) * 4 + 3] === 255;
}

function bandCoordinate(
	angle: 45 | 90 | 135 | 180,
	x: number,
	y: number,
): number {
	if (angle === 135) return x - y;
	if (angle === 45) return x + y;
	if (angle === 90) return x;
	return y;
}

function bandStep(angle: 45 | 90 | 135 | 180): number {
	return angle === 135 || angle === 45 ? 2 : 1;
}

function firstBandCoordinate(
	angle: 45 | 90 | 135 | 180,
	base: Uint8Array,
	width: number,
	height: number,
	bandWidth: number,
): number {
	let smallest = Number.MAX_SAFE_INTEGER;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			if (!isOpaque(base, x, y, width)) continue;
			const value = bandCoordinate(angle, x, y);
			if (value < smallest) smallest = value;
		}
	}
	assert.ok(smallest !== Number.MAX_SAFE_INTEGER, "an opaque pixel exists");
	return smallest - bandWidth;
}

/** Cells whose bytes differ from the source, as sorted "x,y" keys. */
function changedCells(
	frameSet: FrameSet,
	index: number,
	base: Uint8Array,
	width: number,
	height: number,
): string[] {
	const frame = frameBytes(frameSet, index);
	const changed: string[] = [];
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const offset = (y * width + x) * 4;
			let differs = false;
			for (let channel = 0; channel < 4; channel += 1) {
				if (frame[offset + channel] !== base[offset + channel]) {
					differs = true;
				}
			}
			if (differs) changed.push(cellKey(x, y));
		}
	}
	return changed.sort();
}

/** Opaque source cells inside the band window of one frame, from the rule. */
function expectedCells(
	angle: 45 | 90 | 135 | 180,
	bandWidth: number,
	frameCount: number,
	kStart: number,
	base: Uint8Array,
	width: number,
	height: number,
	frameIndex: number,
): string[] {
	const expected: string[] = [];
	if (frameIndex < 1 || frameIndex >= frameCount) return expected;
	const low = kStart + (frameIndex - 1) * bandStep(angle);
	const high = low + bandWidth - 1;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			if (!isOpaque(base, x, y, width)) continue;
			const value = bandCoordinate(angle, x, y);
			if (value >= low && value <= high) expected.push(cellKey(x, y));
		}
	}
	return expected.sort();
}

/**
 * The invariant every angle shares: frame 0 is the source, the alpha plane
 * never moves, and every repainted cell carries the band colour.
 */
function assertMaskStable(
	frameSet: FrameSet,
	base: Uint8Array,
	width: number,
	height: number,
): void {
	assert.deepEqual(
		frameBytes(frameSet, 0),
		base,
		"frame 0 is the source image byte for byte",
	);
	for (let index = 0; index < frameSet.frames.length; index += 1) {
		const frame = frameBytes(frameSet, index);
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const offset = (y * width + x) * 4;
				assert.equal(
					frame[offset + 3],
					base[offset + 3],
					`alpha stays put at ${x},${y} in frame ${index}`,
				);
				if (base[offset + 3] === 0) {
					assert.equal(
						frame[offset],
						base[offset],
						`hidden red under alpha 0 stays at ${x},${y}`,
					);
					assert.equal(
						frame[offset + 1],
						base[offset + 1],
						`hidden green under alpha 0 stays at ${x},${y}`,
					);
					assert.equal(
						frame[offset + 2],
						base[offset + 2],
						`hidden blue under alpha 0 stays at ${x},${y}`,
					);
				}
			}
		}
	}
}

function assertBandedCellsAreOpaque(
	frameSet: FrameSet,
	base: Uint8Array,
	width: number,
	height: number,
): void {
	for (let index = 0; index < frameSet.frames.length; index += 1) {
		const frame = frameBytes(frameSet, index);
		for (const key of changedCells(frameSet, index, base, width, height)) {
			const [x, y] = key.split(",").map(Number) as [number, number];
			assert.ok(
				isOpaque(base, x, y, width),
				`frame ${index} repaints only opaque cells, ${key} is opaque`,
			);
			const offset = (y * width + x) * 4;
			assert.deepEqual(
				[
					frame[offset],
					frame[offset + 1],
					frame[offset + 2],
					frame[offset + 3],
				],
				[BAND.r, BAND.g, BAND.b, BAND.a],
				`frame ${index} writes the band colour at ${key}`,
			);
		}
	}
}

function rejectsCode(code: string, run: () => unknown): void {
	assert.throws(run, (error: unknown) => {
		assert.ok(error instanceof McAssetError, "expected McAssetError");
		assert.equal(error.code, code);
		return true;
	});
}

export const SWEEP_CASES: { name: string; run(): void }[] = [
	{
		name: "sweep 135 degrees repaints exactly the opaque cells of each band window",
		run() {
			const source = gemCanvas();
			const base = flattenCanvas(source);
			const result = generateSweepFrames({
				canvas: source,
				angleDegrees: 135,
				widthPixels: 1,
				color: BAND,
				frames: 10,
			});
			assert.equal(result.frameSet.frames.length, 10, "ten frames");
			assert.equal(result.frameSet.frameWidth, 16, "frame width");
			assert.equal(result.frameSet.frameHeight, 16, "frame height");
			const kStart = firstBandCoordinate(135, base, 16, 16, 1);
			assert.equal(result.kStart, kStart, "kStart is the smallest b - width");
			assertMaskStable(result.frameSet, base, 16, 16);
			assertBandedCellsAreOpaque(result.frameSet, base, 16, 16);
			let painted = 0;
			for (let index = 0; index < 10; index += 1) {
				assert.deepEqual(
					changedCells(result.frameSet, index, base, 16, 16),
					expectedCells(135, 1, 10, kStart, base, 16, 16, index),
					`frame ${index} matches the frozen window`,
				);
				painted += changedCells(result.frameSet, index, base, 16, 16).length;
			}
			assert.ok(painted > 0, "the band paints something");
		},
	},
	{
		name: "sweep 45 degrees walks the band along b = x + y",
		run() {
			const source = gemCanvas();
			const base = flattenCanvas(source);
			const result = generateSweepFrames({
				canvas: source,
				angleDegrees: 45,
				widthPixels: 2,
				color: BAND,
				frames: 10,
			});
			const kStart = firstBandCoordinate(45, base, 16, 16, 2);
			assert.equal(result.kStart, kStart, "kStart for the 45 degree band");
			assertMaskStable(result.frameSet, base, 16, 16);
			assertBandedCellsAreOpaque(result.frameSet, base, 16, 16);
			for (let index = 0; index < 10; index += 1) {
				assert.deepEqual(
					changedCells(result.frameSet, index, base, 16, 16),
					expectedCells(45, 2, 10, kStart, base, 16, 16, index),
					`frame ${index} matches the 45 degree window`,
				);
			}
		},
	},
	{
		name: "sweep 90 degrees walks the band from left to right",
		run() {
			const source = gemCanvas();
			const base = flattenCanvas(source);
			const result = generateSweepFrames({
				canvas: source,
				angleDegrees: 90,
				widthPixels: 1,
				color: BAND,
				frames: 8,
			});
			const kStart = firstBandCoordinate(90, base, 16, 16, 1);
			assert.equal(result.kStart, kStart, "kStart is the smallest column - 1");
			assertMaskStable(result.frameSet, base, 16, 16);
			assertBandedCellsAreOpaque(result.frameSet, base, 16, 16);
			for (let index = 0; index < 8; index += 1) {
				assert.deepEqual(
					changedCells(result.frameSet, index, base, 16, 16),
					expectedCells(90, 1, 8, kStart, base, 16, 16, index),
					`frame ${index} matches the column window`,
				);
			}
		},
	},
	{
		name: "sweep 180 degrees walks the band from top to bottom",
		run() {
			const source = gemCanvas();
			const base = flattenCanvas(source);
			const result = generateSweepFrames({
				canvas: source,
				angleDegrees: 180,
				widthPixels: 1,
				color: BAND,
				frames: 8,
			});
			const kStart = firstBandCoordinate(180, base, 16, 16, 1);
			assert.equal(result.kStart, kStart, "kStart is the smallest row - 1");
			assertMaskStable(result.frameSet, base, 16, 16);
			assertBandedCellsAreOpaque(result.frameSet, base, 16, 16);
			for (let index = 0; index < 8; index += 1) {
				assert.deepEqual(
					changedCells(result.frameSet, index, base, 16, 16),
					expectedCells(180, 1, 8, kStart, base, 16, 16, index),
					`frame ${index} matches the row window`,
				);
			}
		},
	},
	{
		name: "sweep band wider than the object still repaints only opaque cells",
		run() {
			const source = gemCanvas();
			const base = flattenCanvas(source);
			const result = generateSweepFrames({
				canvas: source,
				angleDegrees: 135,
				widthPixels: 4,
				color: BAND,
				frames: 6,
			});
			const kStart = firstBandCoordinate(135, base, 16, 16, 4);
			assert.equal(result.kStart, kStart, "kStart subtracts the full width");
			assertMaskStable(result.frameSet, base, 16, 16);
			assertBandedCellsAreOpaque(result.frameSet, base, 16, 16);
			let painted = 0;
			for (let index = 0; index < 6; index += 1) {
				const cells = changedCells(result.frameSet, index, base, 16, 16);
				assert.deepEqual(
					cells,
					expectedCells(135, 4, 6, kStart, base, 16, 16, index),
					`frame ${index} matches the four-cell window`,
				);
				painted += cells.length;
			}
			assert.ok(painted > 0, "a four-cell band paints something");
		},
	},
	{
		name: "sweep of one frame emits the untouched source",
		run() {
			const source = gemCanvas();
			const base = flattenCanvas(source);
			const result = generateSweepFrames({
				canvas: source,
				angleDegrees: 135,
				widthPixels: 1,
				color: BAND,
				frames: 1,
			});
			assert.equal(result.frameSet.frames.length, 1, "one frame");
			assert.deepEqual(
				frameBytes(result.frameSet, 0),
				base,
				"the only frame is the source",
			);
		},
	},
	{
		name: "sweep of a fully transparent source repeats it in every frame",
		run() {
			const source = clearCanvas(16, 16);
			const base = flattenCanvas(source);
			const result = generateSweepFrames({
				canvas: source,
				angleDegrees: 135,
				widthPixels: 1,
				color: BAND,
				frames: 10,
			});
			assert.equal(result.opaquePixelCount, 0, "no opaque pixel");
			assert.equal(result.kStart, null, "no band origin");
			assert.equal(result.frameSet.frames.length, 10, "ten frames");
			for (let index = 0; index < 10; index += 1) {
				assert.deepEqual(
					frameBytes(result.frameSet, index),
					base,
					`frame ${index} keeps every hidden byte`,
				);
			}
		},
	},
	{
		name: "sweep keeps a non-square source at its own size",
		run() {
			const source = slabCanvas(12, 18);
			const base = flattenCanvas(source);
			const result = generateSweepFrames({
				canvas: source,
				angleDegrees: 135,
				widthPixels: 1,
				color: BAND,
				frames: 10,
			});
			assert.equal(result.frameSet.frameWidth, 12, "width stays 12");
			assert.equal(result.frameSet.frameHeight, 18, "height stays 18");
			const kStart = firstBandCoordinate(135, base, 12, 18, 1);
			assert.equal(result.kStart, kStart, "kStart over the 12x18 slab");
			assertMaskStable(result.frameSet, base, 12, 18);
			assertBandedCellsAreOpaque(result.frameSet, base, 12, 18);
			for (let index = 0; index < 10; index += 1) {
				assert.deepEqual(
					changedCells(result.frameSet, index, base, 12, 18),
					expectedCells(135, 1, 10, kStart, base, 12, 18, index),
					`frame ${index} matches the window on a 12x18 source`,
				);
			}
		},
	},
	{
		name: "sweep leaves a translucent cell byte-identical in every frame",
		run() {
			const source = gemCanvas();
			const layer = source.layers[0];
			assert.ok(layer !== undefined, "the gem has one layer");
			// Cell 8,4 sits inside the gem body and becomes half transparent.
			layer.pixels[(4 * 16 + 8) * 4 + 3] = 128;
			const base = flattenCanvas(source);
			const result = generateSweepFrames({
				canvas: source,
				angleDegrees: 135,
				widthPixels: 1,
				color: BAND,
				frames: 10,
			});
			const kStart = firstBandCoordinate(135, base, 16, 16, 1);
			for (let index = 0; index < 10; index += 1) {
				const frame = frameBytes(result.frameSet, index);
				const offset = (4 * 16 + 8) * 4;
				assert.equal(frame[offset + 3], 128, `alpha stays at cell 8,4`);
				assert.ok(
					changedCells(result.frameSet, index, base, 16, 16).indexOf("8,4") ===
						-1,
					`frame ${index} never repaints the translucent cell`,
				);
			}
			assert.deepEqual(
				changedCells(result.frameSet, 1, base, 16, 16),
				expectedCells(135, 1, 10, kStart, base, 16, 16, 1),
				"the translucent cell is skipped by the band window",
			);
		},
	},
	{
		name: "sweep supports only 45, 90, 135, and 180 degrees",
		run() {
			assert.equal(parseSweepAngleDegrees("45"), 45, "45 parses");
			assert.equal(parseSweepAngleDegrees("90"), 90, "90 parses");
			assert.equal(parseSweepAngleDegrees("135"), 135, "135 parses");
			assert.equal(parseSweepAngleDegrees("180"), 180, "180 parses");
			rejectsCode("INVALID_ARGUMENT", () => parseSweepAngleDegrees("30"));
			rejectsCode("INVALID_ARGUMENT", () => parseSweepAngleDegrees("0"));
			rejectsCode("INVALID_ARGUMENT", () => parseSweepAngleDegrees("225"));
			rejectsCode("INVALID_ARGUMENT", () => parseSweepAngleDegrees("-45"));
			rejectsCode("INVALID_ARGUMENT", () => parseSweepAngleDegrees("1.5"));
			rejectsCode("INVALID_ARGUMENT", () => parseSweepAngleDegrees(""));
			const source = gemCanvas();
			const result = generateSweepFrames({
				canvas: source,
				angleDegrees: 90,
				widthPixels: 1,
				color: BAND,
				frames: 8,
			});
			const base = flattenCanvas(source);
			assert.ok(
				result.frameSet.frames.some(
					(_, i) => changedCells(result.frameSet, i, base, 16, 16).length > 0,
				),
				"the supported 90 degree band paints cells",
			);
		},
	},
	{
		name: "sweep refuses a band width outside 1..8 and a frame count below 1",
		run() {
			assert.equal(parseSweepWidthPixels("1"), 1, "1 parses");
			assert.equal(parseSweepWidthPixels("8"), 8, "8 parses");
			assert.equal(parseSweepFrameCount("10"), 10, "10 parses");
			rejectsCode("INVALID_ARGUMENT", () => parseSweepWidthPixels("0"));
			rejectsCode("INVALID_ARGUMENT", () => parseSweepWidthPixels("9"));
			rejectsCode("INVALID_ARGUMENT", () => parseSweepWidthPixels("-2"));
			rejectsCode("INVALID_ARGUMENT", () => parseSweepWidthPixels("two"));
			rejectsCode("INVALID_ARGUMENT", () => parseSweepFrameCount("0"));
			rejectsCode("INVALID_ARGUMENT", () => parseSweepFrameCount("65"));
			const source = gemCanvas();
			rejectsCode("INVALID_ARGUMENT", () =>
				generateSweepFrames({
					canvas: source,
					angleDegrees: 135,
					widthPixels: 2,
					color: BAND,
					frames: 0,
				}),
			);
			const base = flattenCanvas(source);
			const result = generateSweepFrames({
				canvas: source,
				angleDegrees: 135,
				widthPixels: 2,
				color: BAND,
				frames: 10,
			});
			assert.ok(
				result.frameSet.frames.some(
					(_, i) => changedCells(result.frameSet, i, base, 16, 16).length > 0,
				),
				"a two-cell band paints cells",
			);
		},
	},
	{
		name: "sweep band colour is an opaque hex colour",
		run() {
			assert.deepEqual(
				parseSweepColor("#FFFFFF"),
				{ r: 255, g: 255, b: 255, a: 255 },
				"#RRGGBB parses as opaque",
			);
			assert.deepEqual(
				parseSweepColor("#0a141e"),
				{ r: 10, g: 20, b: 30, a: 255 },
				"lower-case digits parse",
			);
			rejectsCode("INVALID_COLOR", () => parseSweepColor("#FFF"));
			rejectsCode("INVALID_COLOR", () => parseSweepColor("white"));
			rejectsCode("INVALID_ARGUMENT", () => parseSweepColor("#FFFFFF80"));
			rejectsCode("INVALID_ARGUMENT", () => parseSweepColor("transparent"));
			const source = slabCanvas(16, 16);
			const base = flattenCanvas(source);
			const result = generateSweepFrames({
				canvas: source,
				angleDegrees: 135,
				widthPixels: 1,
				color: { r: 250, g: 240, b: 200, a: 255 },
				frames: 10,
			});
			const paintedIndex = result.frameSet.frames.findIndex(
				(_, i) => changedCells(result.frameSet, i, base, 16, 16).length > 0,
			);
			const frame = frameBytes(result.frameSet, paintedIndex);
			const cells = changedCells(result.frameSet, paintedIndex, base, 16, 16);
			assert.ok(cells.length > 0, "the custom colour band paints cells");
			const [x, y] = (cells[0] as string).split(",").map(Number) as [
				number,
				number,
			];
			const offset = (y * 16 + x) * 4;
			assert.deepEqual(
				[
					frame[offset],
					frame[offset + 1],
					frame[offset + 2],
					frame[offset + 3],
				],
				[250, 240, 200, 255],
				"the custom colour is written verbatim",
			);
		},
	},
];
