import {
	addLayer,
	addRegion,
	createCanvas,
	getLayer,
	getPixel,
	getRegionValue,
	setPixel,
	setRegionValue,
} from "../../src/core/canvas.ts";
import { McAssetError } from "../../src/core/errors.ts";
import {
	crop,
	flipHorizontal,
	flipVertical,
	pad,
	resize,
	rotate90,
	rotate180,
	rotate270,
	translate,
} from "../../src/core/transform.ts";
import type { PixelCanvas, Rect, RGBA } from "../../src/core/types.ts";
import type { CaseCheck } from "./model-cases.ts";

export interface TransformCase {
	name: string;
	run(check: CaseCheck): void;
}

function throwsCode(check: CaseCheck, fn: () => unknown, code: string): void {
	try {
		fn();
	} catch (error) {
		if (error instanceof McAssetError && error.code === code) {
			return;
		}
		check.fail(
			`expected McAssetError(${code}) but got ${error instanceof McAssetError ? error.code : String(error)}`,
		);
	}
	check.fail(`expected McAssetError(${code}) but nothing was thrown`);
}

const CLEAR: RGBA = { r: 0, g: 0, b: 0, a: 0 };

function fresh(
	width: number,
	height: number,
	layerIds = ["base"],
): { canvas: PixelCanvas; layerIds: string[] } {
	const canvas = createCanvas(width, height);
	for (const id of layerIds) {
		addLayer(canvas, { id });
	}
	return { canvas, layerIds: [...layerIds] };
}

/** Deterministic value pattern: r encodes the cell index, alpha stays opaque. */
function paintIndexPattern(canvas: PixelCanvas, layerId: string): void {
	for (let y = 0; y < canvas.height; y += 1) {
		for (let x = 0; x < canvas.width; x += 1) {
			setPixel(canvas, layerId, x, y, {
				r: y * canvas.width + x,
				g: 0,
				b: 0,
				a: 255,
			});
		}
	}
}

function seedPixels(count: number, seed: number): RGBA[] {
	// Integer-only LCG: deterministic seed, no randomness source.
	let state = seed >>> 0;
	const out: RGBA[] = [];
	for (let i = 0; i < count; i += 1) {
		state = (state * 1664525 + 1013904223) >>> 0;
		const r = (state >>> 24) & 0xff;
		state = (state * 1664525 + 1013904223) >>> 0;
		const g = (state >>> 24) & 0xff;
		state = (state * 1664525 + 1013904223) >>> 0;
		const b = (state >>> 24) & 0xff;
		state = (state * 1664525 + 1013904223) >>> 0;
		const a = (state >>> 24) & 0xff;
		out.push({ r, g, b, a });
	}
	return out;
}

function paintSeeded(canvas: PixelCanvas, layerId: string, seed: number): void {
	const colors = seedPixels(canvas.width * canvas.height, seed);
	for (let y = 0; y < canvas.height; y += 1) {
		for (let x = 0; x < canvas.width; x += 1) {
			setPixel(canvas, layerId, x, y, colors[y * canvas.width + x] as RGBA);
		}
	}
}

function snapshot(canvas: PixelCanvas, layerId: string): Uint8Array {
	return getLayer(canvas, layerId).pixels.slice();
}

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
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

function redChannel(
	canvas: PixelCanvas,
	layerId: string,
	width: number,
	height: number,
): number[] {
	const out: number[] = [];
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			out.push(getPixel(canvas, layerId, x, y).r);
		}
	}
	return out;
}

export const TRANSFORM_CASES: TransformCase[] = [
	{
		name: "flipHorizontal golden mirrors each row",
		run: (check) => {
			const { canvas, layerIds } = fresh(3, 2);
			paintIndexPattern(canvas, layerIds[0] as string);
			flipHorizontal(canvas);
			check.deepEqual(
				redChannel(canvas, layerIds[0] as string, 3, 2),
				[2, 1, 0, 5, 4, 3],
				"rows read right-to-left",
			);
		},
	},
	{
		name: "flipHorizontal twice returns byte-identical",
		run: (check) => {
			const { canvas, layerIds } = fresh(5, 4, ["a", "b"]);
			paintSeeded(canvas, layerIds[0] as string, 0x11);
			paintSeeded(canvas, layerIds[1] as string, 0x22);
			const beforeA = snapshot(canvas, layerIds[0] as string);
			const beforeB = snapshot(canvas, layerIds[1] as string);
			flipHorizontal(canvas);
			flipHorizontal(canvas);
			check.ok(
				buffersEqual(beforeA, snapshot(canvas, layerIds[0] as string)),
				"layer a involution",
			);
			check.ok(
				buffersEqual(beforeB, snapshot(canvas, layerIds[1] as string)),
				"layer b involution",
			);
		},
	},
	{
		name: "flipVertical golden mirrors each column",
		run: (check) => {
			const { canvas, layerIds } = fresh(3, 2);
			paintIndexPattern(canvas, layerIds[0] as string);
			flipVertical(canvas);
			check.deepEqual(
				redChannel(canvas, layerIds[0] as string, 3, 2),
				[3, 4, 5, 0, 1, 2],
				"rows read bottom-to-top",
			);
		},
	},
	{
		name: "flipVertical twice returns byte-identical",
		run: (check) => {
			const { canvas, layerIds } = fresh(5, 4);
			paintSeeded(canvas, layerIds[0] as string, 0x33);
			const before = snapshot(canvas, layerIds[0] as string);
			flipVertical(canvas);
			flipVertical(canvas);
			check.ok(
				buffersEqual(before, snapshot(canvas, layerIds[0] as string)),
				"involution",
			);
		},
	},
	{
		name: "flip keeps canvas dimensions",
		run: (check) => {
			const { canvas } = fresh(5, 3);
			flipHorizontal(canvas);
			check.equal(canvas.width, 5, "width kept");
			check.equal(canvas.height, 3, "height kept");
			flipVertical(canvas);
			check.equal(canvas.width, 5, "width kept");
			check.equal(canvas.height, 3, "height kept");
		},
	},
	{
		name: "rotate90 golden pins clockwise direction and swaps dimensions",
		run: (check) => {
			const { canvas, layerIds } = fresh(3, 2);
			paintIndexPattern(canvas, layerIds[0] as string);
			rotate90(canvas);
			check.equal(canvas.width, 2, "width becomes old height");
			check.equal(canvas.height, 3, "height becomes old width");
			check.deepEqual(
				redChannel(canvas, layerIds[0] as string, 2, 3),
				[3, 0, 4, 1, 5, 2],
				"clockwise mapping",
			);
		},
	},
	{
		name: "rotate90 four times is byte-identical",
		run: (check) => {
			const { canvas, layerIds } = fresh(5, 3, ["a", "b"]);
			paintSeeded(canvas, layerIds[0] as string, 0x44);
			paintSeeded(canvas, layerIds[1] as string, 0x55);
			const beforeA = snapshot(canvas, layerIds[0] as string);
			const savedB = snapshot(canvas, layerIds[1] as string);
			rotate90(canvas);
			rotate90(canvas);
			rotate90(canvas);
			rotate90(canvas);
			check.equal(canvas.width, 5, "width restored");
			check.equal(canvas.height, 3, "height restored");
			check.ok(
				buffersEqual(beforeA, snapshot(canvas, layerIds[0] as string)),
				"layer a byte-identical",
			);
			check.ok(
				buffersEqual(savedB, snapshot(canvas, layerIds[1] as string)),
				"layer b byte-identical",
			);
		},
	},
	{
		name: "rotate90 then rotate270 restores the original",
		run: (check) => {
			const { canvas, layerIds } = fresh(4, 3);
			paintSeeded(canvas, layerIds[0] as string, 0x66);
			const before = snapshot(canvas, layerIds[0] as string);
			rotate90(canvas);
			check.equal(canvas.width, 3, "swapped after rotate90");
			rotate270(canvas);
			check.equal(canvas.width, 4, "width restored");
			check.equal(canvas.height, 3, "height restored");
			check.ok(
				buffersEqual(before, snapshot(canvas, layerIds[0] as string)),
				"mutual inverse",
			);
		},
	},
	{
		name: "rotate90 twice equals rotate180",
		run: (check) => {
			const first = fresh(4, 3);
			const second = fresh(4, 3);
			paintSeeded(first.canvas, first.layerIds[0] as string, 0x77);
			paintSeeded(second.canvas, second.layerIds[0] as string, 0x77);
			rotate90(first.canvas);
			rotate90(first.canvas);
			rotate180(second.canvas);
			check.ok(
				buffersEqual(
					snapshot(first.canvas, first.layerIds[0] as string),
					snapshot(second.canvas, second.layerIds[0] as string),
				),
				"two quarter turns equal a half turn",
			);
		},
	},
	{
		name: "rotate180 twice returns byte-identical with dimensions kept",
		run: (check) => {
			const { canvas, layerIds } = fresh(4, 3);
			paintSeeded(canvas, layerIds[0] as string, 0x88);
			const before = snapshot(canvas, layerIds[0] as string);
			rotate180(canvas);
			check.equal(canvas.width, 4, "width kept");
			check.equal(canvas.height, 3, "height kept");
			rotate180(canvas);
			check.ok(
				buffersEqual(before, snapshot(canvas, layerIds[0] as string)),
				"self-inverse",
			);
		},
	},
	{
		name: "rotate270 golden pins counter-clockwise direction",
		run: (check) => {
			const { canvas, layerIds } = fresh(3, 2);
			paintIndexPattern(canvas, layerIds[0] as string);
			rotate270(canvas);
			check.equal(canvas.width, 2, "width becomes old height");
			check.equal(canvas.height, 3, "height becomes old width");
			check.deepEqual(
				redChannel(canvas, layerIds[0] as string, 2, 3),
				[2, 5, 1, 4, 0, 3],
				"counter-clockwise mapping",
			);
		},
	},
	{
		name: "crop keeps retained pixels verbatim and shrinks the canvas",
		run: (check) => {
			const { canvas, layerIds } = fresh(4, 4);
			paintSeeded(canvas, layerIds[0] as string, 0x99);
			setPixel(canvas, layerIds[0] as string, 2, 1, {
				r: 9,
				g: 9,
				b: 9,
				a: 0,
			});
			const rect: Rect = { x: 1, y: 1, width: 2, height: 2 };
			const expectedTopLeft = getPixel(canvas, layerIds[0] as string, 1, 1);
			crop(canvas, rect);
			check.equal(canvas.width, 2, "cropped width");
			check.equal(canvas.height, 2, "cropped height");
			check.deepEqual(
				getPixel(canvas, layerIds[0] as string, 0, 0),
				expectedTopLeft,
				"origin moved without recolor",
			);
			check.deepEqual(
				getPixel(canvas, layerIds[0] as string, 1, 0),
				{ r: 9, g: 9, b: 9, a: 0 },
				"hidden RGB under A=0 preserved",
			);
		},
	},
	{
		name: "crop outside the canvas is OUT_OF_BOUNDS without writes",
		run: (check) => {
			const { canvas, layerIds } = fresh(4, 4);
			paintSeeded(canvas, layerIds[0] as string, 0xaa);
			const before = snapshot(canvas, layerIds[0] as string);
			throwsCode(
				check,
				() => crop(canvas, { x: 3, y: 3, width: 2, height: 2 }),
				"OUT_OF_BOUNDS",
			);
			throwsCode(
				check,
				() => crop(canvas, { x: -1, y: 0, width: 2, height: 2 }),
				"OUT_OF_BOUNDS",
			);
			check.equal(canvas.width, 4, "width untouched");
			check.ok(
				buffersEqual(before, snapshot(canvas, layerIds[0] as string)),
				"no partial crop",
			);
		},
	},
	{
		name: "crop rejects float origin and empty size",
		run: (check) => {
			const { canvas } = fresh(4, 4);
			throwsCode(
				check,
				() => crop(canvas, { x: 0.5, y: 0, width: 2, height: 2 }),
				"INVALID_COORDINATE",
			);
			throwsCode(
				check,
				() => crop(canvas, { x: 0, y: 0, width: 0, height: 2 }),
				"INVALID_DIMENSION",
			);
		},
	},
	{
		name: "crop to the full canvas is the identity",
		run: (check) => {
			const { canvas, layerIds } = fresh(3, 3);
			paintSeeded(canvas, layerIds[0] as string, 0xbb);
			const before = snapshot(canvas, layerIds[0] as string);
			crop(canvas, { x: 0, y: 0, width: 3, height: 3 });
			check.ok(
				buffersEqual(before, snapshot(canvas, layerIds[0] as string)),
				"full-canvas crop changes nothing",
			);
		},
	},
	{
		name: "pad adds transparent border by default",
		run: (check) => {
			const { canvas, layerIds } = fresh(2, 2);
			paintIndexPattern(canvas, layerIds[0] as string);
			pad(canvas, { left: 1, top: 1, right: 1, bottom: 1 });
			check.equal(canvas.width, 4, "padded width");
			check.equal(canvas.height, 4, "padded height");
			check.deepEqual(
				getPixel(canvas, layerIds[0] as string, 0, 0),
				CLEAR,
				"new corner is transparent black",
			);
			check.deepEqual(
				getPixel(canvas, layerIds[0] as string, 3, 3),
				CLEAR,
				"far corner is transparent black",
			);
			check.deepEqual(
				redChannel(canvas, layerIds[0] as string, 4, 4),
				[0, 0, 0, 0, 0, 0, 1, 0, 0, 2, 3, 0, 0, 0, 0, 0],
				"original block kept at the offset",
			);
		},
	},
	{
		name: "pad accepts a custom fill color without touching old pixels",
		run: (check) => {
			const { canvas, layerIds } = fresh(1, 1);
			const ink: RGBA = { r: 200, g: 100, b: 50, a: 255 };
			setPixel(canvas, layerIds[0] as string, 0, 0, ink);
			const fill: RGBA = { r: 1, g: 2, b: 3, a: 255 };
			pad(canvas, { left: 2, top: 0, right: 0, bottom: 0, color: fill });
			check.equal(canvas.width, 3, "padded width");
			check.deepEqual(
				getPixel(canvas, layerIds[0] as string, 0, 0),
				fill,
				"new cell uses the fill color",
			);
			check.deepEqual(
				getPixel(canvas, layerIds[0] as string, 2, 0),
				ink,
				"original pixel kept verbatim",
			);
		},
	},
	{
		name: "pad rejects float and negative amounts",
		run: (check) => {
			const { canvas } = fresh(2, 2);
			throwsCode(
				check,
				() => pad(canvas, { left: 0.5, top: 0, right: 0, bottom: 0 }),
				"INVALID_COORDINATE",
			);
			throwsCode(
				check,
				() => pad(canvas, { left: -1, top: 0, right: 0, bottom: 0 }),
				"INVALID_ARGUMENT",
			);
			check.equal(canvas.width, 2, "width untouched after rejection");
		},
	},
	{
		name: "translate shifts content, keeps values, fills vacated with transparent",
		run: (check) => {
			const { canvas, layerIds } = fresh(3, 1);
			const left: RGBA = { r: 10, g: 20, b: 30, a: 255 };
			const mid: RGBA = { r: 40, g: 50, b: 60, a: 255 };
			setPixel(canvas, layerIds[0] as string, 0, 0, left);
			setPixel(canvas, layerIds[0] as string, 1, 0, mid);
			translate(canvas, 1, 0);
			check.deepEqual(
				getPixel(canvas, layerIds[0] as string, 0, 0),
				CLEAR,
				"vacated cell is transparent black",
			);
			check.deepEqual(
				getPixel(canvas, layerIds[0] as string, 1, 0),
				left,
				"kept pixel verbatim",
			);
			check.deepEqual(
				getPixel(canvas, layerIds[0] as string, 2, 0),
				mid,
				"kept pixel verbatim",
			);
		},
	},
	{
		name: "translate that would move content out is OUT_OF_BOUNDS without writes",
		run: (check) => {
			const { canvas, layerIds } = fresh(2, 1);
			setPixel(canvas, layerIds[0] as string, 0, 0, {
				r: 1,
				g: 2,
				b: 3,
				a: 255,
			});
			setPixel(canvas, layerIds[0] as string, 1, 0, {
				r: 4,
				g: 5,
				b: 6,
				a: 255,
			});
			const before = snapshot(canvas, layerIds[0] as string);
			throwsCode(check, () => translate(canvas, 1, 0), "OUT_OF_BOUNDS");
			throwsCode(check, () => translate(canvas, 0, 1), "OUT_OF_BOUNDS");
			check.ok(
				buffersEqual(before, snapshot(canvas, layerIds[0] as string)),
				"failed translate leaves no partial pixels",
			);
		},
	},
	{
		name: "translate by zero is the identity",
		run: (check) => {
			const { canvas, layerIds } = fresh(3, 2);
			paintSeeded(canvas, layerIds[0] as string, 0xcc);
			const before = snapshot(canvas, layerIds[0] as string);
			translate(canvas, 0, 0);
			check.ok(
				buffersEqual(before, snapshot(canvas, layerIds[0] as string)),
				"zero shift changes nothing",
			);
		},
	},
	{
		name: "translate rejects float displacement",
		run: (check) => {
			const { canvas } = fresh(3, 3);
			throwsCode(check, () => translate(canvas, 0.5, 0), "INVALID_COORDINATE");
			throwsCode(check, () => translate(canvas, 0, 1.5), "INVALID_COORDINATE");
		},
	},
	{
		name: "resize nearest downsamples without creating new colors",
		run: (check) => {
			const { canvas, layerIds } = fresh(4, 4);
			paintIndexPattern(canvas, layerIds[0] as string);
			resize(canvas, 2, 2);
			check.equal(canvas.width, 2, "target width");
			check.equal(canvas.height, 2, "target height");
			check.deepEqual(
				redChannel(canvas, layerIds[0] as string, 2, 2),
				[0, 2, 8, 10],
				"top-left source of each 2x2 block",
			);
		},
	},
	{
		name: "resize nearest upscales by pixel replication",
		run: (check) => {
			const { canvas, layerIds } = fresh(2, 2);
			paintIndexPattern(canvas, layerIds[0] as string);
			resize(canvas, 4, 4, "nearest");
			check.deepEqual(
				redChannel(canvas, layerIds[0] as string, 4, 4),
				[0, 0, 1, 1, 0, 0, 1, 1, 2, 2, 3, 3, 2, 2, 3, 3],
				"each source pixel becomes a 2x2 block",
			);
		},
	},
	{
		name: "resize nearest keeps the color set on seeded input",
		run: (check) => {
			const { canvas, layerIds } = fresh(6, 5);
			paintSeeded(canvas, layerIds[0] as string, 0xdd);
			const seen = new Set<string>();
			for (let y = 0; y < 5; y += 1) {
				for (let x = 0; x < 6; x += 1) {
					const p = getPixel(canvas, layerIds[0] as string, x, y);
					seen.add(`${p.r},${p.g},${p.b},${p.a}`);
				}
			}
			resize(canvas, 3, 2);
			for (let y = 0; y < 2; y += 1) {
				for (let x = 0; x < 3; x += 1) {
					const p = getPixel(canvas, layerIds[0] as string, x, y);
					check.ok(
						seen.has(`${p.r},${p.g},${p.b},${p.a}`),
						`resized pixel (${x},${y}) reuses a source color`,
					);
				}
			}
		},
	},
	{
		name: "resize box averages even blocks with integer division",
		run: (check) => {
			const { canvas, layerIds } = fresh(4, 4);
			paintIndexPattern(canvas, layerIds[0] as string);
			resize(canvas, 2, 2, "box");
			check.deepEqual(
				redChannel(canvas, layerIds[0] as string, 2, 2),
				[2, 4, 10, 12],
				"floor of each 2x2 block mean",
			);
		},
	},
	{
		name: "resize box distributes remainder columns in fixed order",
		run: (check) => {
			const { canvas, layerIds } = fresh(5, 1);
			paintIndexPattern(canvas, layerIds[0] as string);
			resize(canvas, 2, 1, "box");
			check.deepEqual(
				redChannel(canvas, layerIds[0] as string, 2, 1),
				[1, 3],
				"first cell averages 3 sources, second averages 2",
			);
		},
	},
	{
		name: "resize pixel-aware downsamples 4x4 to 2x2 by cell majority",
		run: (check) => {
			const { canvas, layerIds } = fresh(4, 4);
			const layer = layerIds[0] as string;
			const RED: RGBA = { r: 255, g: 0, b: 0, a: 255 };
			const GREEN: RGBA = { r: 0, g: 255, b: 0, a: 255 };
			const BLUE: RGBA = { r: 0, g: 0, b: 255, a: 255 };
			const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 255 };
			// Top-left cell: 3 red + 1 blue -> red wins.
			setPixel(canvas, layer, 0, 0, RED);
			setPixel(canvas, layer, 1, 0, RED);
			setPixel(canvas, layer, 0, 1, RED);
			setPixel(canvas, layer, 1, 1, BLUE);
			// Top-right cell: 3 green + 1 white -> green wins.
			setPixel(canvas, layer, 2, 0, GREEN);
			setPixel(canvas, layer, 3, 0, GREEN);
			setPixel(canvas, layer, 2, 1, GREEN);
			setPixel(canvas, layer, 3, 1, WHITE);
			// Bottom-left cell: unanimous blue.
			for (let y = 2; y < 4; y += 1) {
				for (let x = 0; x < 2; x += 1) {
					setPixel(canvas, layer, x, y, BLUE);
				}
			}
			// Bottom-right cell: 3 white + 1 red -> white wins.
			setPixel(canvas, layer, 2, 2, WHITE);
			setPixel(canvas, layer, 3, 2, WHITE);
			setPixel(canvas, layer, 2, 3, WHITE);
			setPixel(canvas, layer, 3, 3, RED);
			resize(canvas, 2, 2, "pixel-aware");
			check.equal(canvas.width, 2, "target width");
			check.equal(canvas.height, 2, "target height");
			check.deepEqual(getPixel(canvas, layer, 0, 0), RED, "cell (0,0)");
			check.deepEqual(getPixel(canvas, layer, 1, 0), GREEN, "cell (1,0)");
			check.deepEqual(getPixel(canvas, layer, 0, 1), BLUE, "cell (0,1)");
			check.deepEqual(getPixel(canvas, layer, 1, 1), WHITE, "cell (1,1)");
		},
	},
	{
		name: "resize pixel-aware breaks count ties by earliest scan order",
		run: (check) => {
			const { canvas, layerIds } = fresh(2, 2);
			const layer = layerIds[0] as string;
			const RED: RGBA = { r: 255, g: 0, b: 0, a: 255 };
			const GREEN: RGBA = { r: 0, g: 255, b: 0, a: 255 };
			const BLUE: RGBA = { r: 0, g: 0, b: 255, a: 255 };
			const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 255 };
			setPixel(canvas, layer, 0, 0, RED);
			setPixel(canvas, layer, 1, 0, GREEN);
			setPixel(canvas, layer, 0, 1, BLUE);
			setPixel(canvas, layer, 1, 1, WHITE);
			resize(canvas, 1, 1, "pixel-aware");
			check.deepEqual(
				getPixel(canvas, layer, 0, 0),
				RED,
				"four-way tie keeps the row-major earliest pixel",
			);
		},
	},
	{
		name: "resize pixel-aware prefers higher alpha on count ties",
		run: (check) => {
			const { canvas, layerIds } = fresh(2, 2);
			const layer = layerIds[0] as string;
			const DIM: RGBA = { r: 10, g: 0, b: 0, a: 200 };
			const BRIGHT: RGBA = { r: 20, g: 0, b: 0, a: 255 };
			setPixel(canvas, layer, 0, 0, DIM);
			setPixel(canvas, layer, 1, 0, DIM);
			setPixel(canvas, layer, 0, 1, BRIGHT);
			setPixel(canvas, layer, 1, 1, BRIGHT);
			resize(canvas, 1, 1, "pixel-aware");
			check.deepEqual(
				getPixel(canvas, layer, 0, 0),
				BRIGHT,
				"2-vs-2 tie resolves toward higher alpha",
			);
		},
	},
	{
		name: "resize pixel-aware maps 3x3 to 2x2 with fixed remainder cells",
		run: (check) => {
			const { canvas, layerIds } = fresh(3, 3);
			paintIndexPattern(canvas, layerIds[0] as string);
			resize(canvas, 2, 2, "pixel-aware");
			check.deepEqual(
				redChannel(canvas, layerIds[0] as string, 2, 2),
				[0, 2, 6, 8],
				"first cell covers two sources per axis, last cell is 1x1",
			);
		},
	},
	{
		name: "resize pixel-aware upscale matches nearest bit-for-bit",
		run: (check) => {
			const first = fresh(2, 2);
			const second = fresh(2, 2);
			paintIndexPattern(first.canvas, first.layerIds[0] as string);
			paintIndexPattern(second.canvas, second.layerIds[0] as string);
			resize(first.canvas, 4, 4, "pixel-aware");
			resize(second.canvas, 4, 4, "nearest");
			check.ok(
				buffersEqual(
					snapshot(first.canvas, first.layerIds[0] as string),
					snapshot(second.canvas, second.layerIds[0] as string),
				),
				"upscale is nearest-identical",
			);
			check.deepEqual(
				redChannel(first.canvas, first.layerIds[0] as string, 4, 4),
				[0, 0, 1, 1, 0, 0, 1, 1, 2, 2, 3, 3, 2, 2, 3, 3],
				"each source pixel becomes a 2x2 block",
			);
		},
	},
	{
		name: "resize pixel-aware same size is the identity across layers and masks",
		run: (check) => {
			const { canvas, layerIds } = fresh(3, 2, ["a", "b"]);
			paintSeeded(canvas, layerIds[0] as string, 0x11);
			paintSeeded(canvas, layerIds[1] as string, 0x22);
			const region = addRegion(canvas, { id: "sel" });
			setRegionValue(canvas, region.id, 0, 0, 1);
			setRegionValue(canvas, region.id, 2, 1, 1);
			const beforeA = snapshot(canvas, layerIds[0] as string);
			const beforeB = snapshot(canvas, layerIds[1] as string);
			resize(canvas, 3, 2, "pixel-aware");
			check.equal(canvas.width, 3, "width kept");
			check.equal(canvas.height, 2, "height kept");
			check.ok(
				buffersEqual(beforeA, snapshot(canvas, layerIds[0] as string)),
				"layer a byte-identical",
			);
			check.ok(
				buffersEqual(beforeB, snapshot(canvas, layerIds[1] as string)),
				"layer b byte-identical",
			);
			check.equal(getRegionValue(canvas, region.id, 0, 0), 1, "mask kept");
			check.equal(getRegionValue(canvas, region.id, 2, 1), 1, "mask kept");
		},
	},
	{
		name: "resize pixel-aware mixes axes on 4x2 to 2x4",
		run: (check) => {
			const { canvas, layerIds } = fresh(4, 2);
			paintIndexPattern(canvas, layerIds[0] as string);
			resize(canvas, 2, 4, "pixel-aware");
			check.equal(canvas.width, 2, "target width");
			check.equal(canvas.height, 4, "target height");
			check.deepEqual(
				redChannel(canvas, layerIds[0] as string, 2, 4),
				[0, 2, 0, 2, 4, 6, 4, 6],
				"x shrinks by majority, y grows by nearest",
			);
		},
	},
	{
		name: "resize pixel-aware never introduces new colors",
		run: (check) => {
			const { canvas, layerIds } = fresh(6, 5);
			paintSeeded(canvas, layerIds[0] as string, 0xdd);
			const seen = new Set<string>();
			for (let y = 0; y < 5; y += 1) {
				for (let x = 0; x < 6; x += 1) {
					const p = getPixel(canvas, layerIds[0] as string, x, y);
					seen.add(`${p.r},${p.g},${p.b},${p.a}`);
				}
			}
			resize(canvas, 3, 2, "pixel-aware");
			for (let y = 0; y < 2; y += 1) {
				for (let x = 0; x < 3; x += 1) {
					const p = getPixel(canvas, layerIds[0] as string, x, y);
					check.ok(
						seen.has(`${p.r},${p.g},${p.b},${p.a}`),
						`resized pixel (${x},${y}) reuses a source color`,
					);
				}
			}
		},
	},
	{
		name: "resize pixel-aware keeps hidden RGB under alpha 0 verbatim",
		run: (check) => {
			const { canvas, layerIds } = fresh(2, 2);
			const layer = layerIds[0] as string;
			const HIDDEN: RGBA = { r: 9, g: 8, b: 7, a: 0 };
			const OTHER: RGBA = { r: 1, g: 2, b: 3, a: 0 };
			setPixel(canvas, layer, 0, 0, HIDDEN);
			setPixel(canvas, layer, 1, 0, HIDDEN);
			setPixel(canvas, layer, 0, 1, HIDDEN);
			setPixel(canvas, layer, 1, 1, OTHER);
			resize(canvas, 1, 1, "pixel-aware");
			check.deepEqual(
				getPixel(canvas, layer, 0, 0),
				HIDDEN,
				"majority hidden color copied with its RGB intact",
			);
		},
	},
	{
		name: "resize pixel-aware minority detail is covered by the cell majority",
		run: (check) => {
			const { canvas, layerIds } = fresh(4, 4);
			const layer = layerIds[0] as string;
			const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 255 };
			const RED: RGBA = { r: 255, g: 0, b: 0, a: 255 };
			for (let y = 0; y < 4; y += 1) {
				for (let x = 0; x < 4; x += 1) {
					setPixel(canvas, layer, x, y, WHITE);
				}
			}
			setPixel(canvas, layer, 1, 1, RED);
			resize(canvas, 2, 2, "pixel-aware");
			check.deepEqual(
				redChannel(canvas, layerIds[0] as string, 2, 2),
				[255, 255, 255, 255],
				"single-pixel detail inside a 2x2 cell does not survive",
			);
		},
	},
	{
		name: "resize pixel-aware remaps region masks with nearest",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			addLayer(canvas, { id: "base" });
			const region = addRegion(canvas, { id: "sel" });
			setRegionValue(canvas, region.id, 1, 1, 1);
			setRegionValue(canvas, region.id, 2, 2, 1);
			resize(canvas, 2, 2, "pixel-aware");
			check.equal(
				getRegionValue(canvas, region.id, 0, 0),
				0,
				"off-grid kept 0",
			);
			check.equal(
				getRegionValue(canvas, region.id, 1, 0),
				0,
				"off-grid kept 0",
			);
			check.equal(
				getRegionValue(canvas, region.id, 0, 1),
				0,
				"off-grid kept 0",
			);
			check.equal(
				getRegionValue(canvas, region.id, 1, 1),
				1,
				"nearest-sampled mask cell",
			);
		},
	},
	{
		name: "resize rejects unknown mode without writes",
		run: (check) => {
			const { canvas, layerIds } = fresh(4, 4);
			paintSeeded(canvas, layerIds[0] as string, 0xff);
			const before = snapshot(canvas, layerIds[0] as string);
			throwsCode(
				check,
				() => resize(canvas, 2, 2, "bilinear" as "nearest"),
				"INVALID_ARGUMENT",
			);
			check.ok(
				buffersEqual(before, snapshot(canvas, layerIds[0] as string)),
				"unknown mode writes nothing",
			);
		},
	},
	{
		name: "resize target below 1 is INVALID_DIMENSION",
		run: (check) => {
			const { canvas } = fresh(4, 4);
			throwsCode(check, () => resize(canvas, 0, 2), "INVALID_DIMENSION");
			throwsCode(check, () => resize(canvas, 2, -1), "INVALID_DIMENSION");
			throwsCode(check, () => resize(canvas, 2.5, 2), "INVALID_DIMENSION");
			check.equal(canvas.width, 4, "width untouched");
		},
	},
	{
		name: "region masks follow flip and rotate",
		run: (check) => {
			const canvas = createCanvas(3, 2);
			addLayer(canvas, { id: "base" });
			const region = addRegion(canvas, { id: "sel" });
			setRegionValue(canvas, region.id, 0, 0, 1);
			setRegionValue(canvas, region.id, 2, 1, 1);
			flipHorizontal(canvas);
			check.equal(getRegionValue(canvas, region.id, 2, 0), 1, "mask mirrored");
			check.equal(getRegionValue(canvas, region.id, 0, 1), 1, "mask mirrored");
			check.equal(
				getRegionValue(canvas, region.id, 0, 0),
				0,
				"old cell cleared",
			);
			rotate90(canvas);
			check.equal(canvas.width, 2, "mask canvas swapped");
			check.equal(getRegionValue(canvas, region.id, 1, 2), 1, "mask rotated");
			check.equal(getRegionValue(canvas, region.id, 0, 0), 1, "mask rotated");
		},
	},
	{
		name: "region masks follow crop, pad, translate, and resize",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			addLayer(canvas, { id: "base" });
			const region = addRegion(canvas, { id: "sel" });
			setRegionValue(canvas, region.id, 1, 1, 1);
			crop(canvas, { x: 1, y: 1, width: 2, height: 2 });
			check.equal(getRegionValue(canvas, region.id, 0, 0), 1, "mask cropped");
			pad(canvas, { left: 1, top: 0, right: 0, bottom: 0 });
			check.equal(canvas.width, 3, "mask canvas padded");
			check.equal(getRegionValue(canvas, region.id, 1, 0), 1, "mask shifted");
			check.equal(getRegionValue(canvas, region.id, 0, 0), 0, "pad fills 0");
			translate(canvas, 1, 0);
			check.equal(
				getRegionValue(canvas, region.id, 2, 0),
				1,
				"mask translated",
			);
			resize(canvas, 6, 4);
			check.equal(canvas.width, 6, "mask canvas resized");
			check.equal(
				getRegionValue(canvas, region.id, 4, 0),
				1,
				"mask nearest-mapped",
			);
		},
	},
];
