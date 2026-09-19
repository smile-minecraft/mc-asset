import {
	addLayer,
	createCanvas,
	getLayer,
	getPixel,
	setPixel,
} from "../../src/core/canvas.ts";
import { McAssetError } from "../../src/core/errors.ts";
import {
	clearPixel,
	drawLine,
	drawRect,
	fillRect,
	floodFill,
} from "../../src/core/ops.ts";
import type { PixelCanvas, Rect, RGBA } from "../../src/core/types.ts";
import type { CaseCheck } from "./model-cases.ts";

export interface OpsCase {
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
const INK: RGBA = { r: 255, g: 0, b: 0, a: 255 };
const WALL: RGBA = { r: 0, g: 0, b: 255, a: 255 };
const FILL: RGBA = { r: 0, g: 255, b: 0, a: 255 };

function fresh(
	width: number,
	height: number,
	id = "base",
): { canvas: PixelCanvas; layerId: string } {
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id });
	return { canvas, layerId: layer.id };
}

function sameColor(a: RGBA, b: RGBA): boolean {
	return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

function paintedPoints(
	canvas: PixelCanvas,
	layerId: string,
	width: number,
	height: number,
	color: RGBA,
): string[] {
	const out: string[] = [];
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			if (sameColor(getPixel(canvas, layerId, x, y), color)) {
				out.push(`${x},${y}`);
			}
		}
	}
	return out;
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

/** Shared script for determinism: one pass over every primitive. */
function paintScript(canvas: PixelCanvas, layerId: string): void {
	drawLine(canvas, layerId, 0, 0, 7, 7, INK);
	drawRect(canvas, layerId, { x: 1, y: 1, width: 6, height: 6 }, WALL);
	fillRect(canvas, layerId, { x: 3, y: 0, width: 2, height: 2 }, FILL);
	floodFill(canvas, layerId, 0, 7, FILL);
	clearPixel(canvas, layerId, 7, 0);
}

export const OPS_CASES: OpsCase[] = [
	{
		name: "clearPixel resets to transparent black, neighbors untouched",
		run: (check) => {
			const { canvas, layerId } = fresh(4, 4);
			setPixel(canvas, layerId, 1, 1, INK);
			setPixel(canvas, layerId, 2, 1, INK);
			clearPixel(canvas, layerId, 1, 1);
			check.deepEqual(
				getPixel(canvas, layerId, 1, 1),
				CLEAR,
				"cleared pixel is transparent black",
			);
			check.deepEqual(
				getPixel(canvas, layerId, 2, 1),
				INK,
				"neighbor keeps its color",
			);
			// Raw bytes: hidden RGB under A = 0 is zeroed by clear, not garbage.
			const raw = getLayer(canvas, layerId).pixels;
			check.deepEqual(
				[raw[0], raw[1], raw[2], raw[3]],
				[0, 0, 0, 0],
				"raw bytes at (0,0) untouched",
			);
		},
	},
	{
		name: "clearPixel out of bounds is OUT_OF_BOUNDS",
		run: (check) => {
			const { canvas, layerId } = fresh(4, 4);
			throwsCode(
				check,
				() => clearPixel(canvas, layerId, 4, 0),
				"OUT_OF_BOUNDS",
			);
			throwsCode(
				check,
				() => clearPixel(canvas, layerId, 0, -1),
				"OUT_OF_BOUNDS",
			);
		},
	},
	{
		name: "clearPixel float coordinate is INVALID_COORDINATE",
		run: (check) => {
			const { canvas, layerId } = fresh(4, 4);
			throwsCode(
				check,
				() => clearPixel(canvas, layerId, 1.5, 1),
				"INVALID_COORDINATE",
			);
			throwsCode(
				check,
				() => clearPixel(canvas, layerId, 1, 2.5),
				"INVALID_COORDINATE",
			);
		},
	},
	{
		name: "drawLine horizontal golden",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			drawLine(canvas, layerId, 0, 2, 4, 2, INK);
			check.deepEqual(
				paintedPoints(canvas, layerId, 5, 5, INK),
				["0,2", "1,2", "2,2", "3,2", "4,2"],
				"full row 2",
			);
		},
	},
	{
		name: "drawLine vertical golden",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			drawLine(canvas, layerId, 2, 0, 2, 4, INK);
			check.deepEqual(
				paintedPoints(canvas, layerId, 5, 5, INK),
				["2,0", "2,1", "2,2", "2,3", "2,4"],
				"full column 2",
			);
		},
	},
	{
		name: "drawLine diagonal golden",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			drawLine(canvas, layerId, 0, 0, 4, 4, INK);
			check.deepEqual(
				paintedPoints(canvas, layerId, 5, 5, INK),
				["0,0", "1,1", "2,2", "3,3", "4,4"],
				"main diagonal",
			);
		},
	},
	{
		name: "drawLine anti-diagonal golden",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			drawLine(canvas, layerId, 0, 4, 4, 0, INK);
			check.deepEqual(
				paintedPoints(canvas, layerId, 5, 5, INK),
				// Scan order is row-major (top row first), not draw order.
				["4,0", "3,1", "2,2", "1,3", "0,4"],
				"anti diagonal",
			);
		},
	},
	{
		name: "drawLine shallow slope golden locks Bresenham",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 3);
			drawLine(canvas, layerId, 0, 0, 4, 2, INK);
			check.deepEqual(
				paintedPoints(canvas, layerId, 5, 3, INK),
				["0,0", "1,1", "2,1", "3,2", "4,2"],
				"shallow slope steps",
			);
		},
	},
	{
		name: "drawLine single point draws one pixel",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			drawLine(canvas, layerId, 2, 2, 2, 2, INK);
			check.deepEqual(
				paintedPoints(canvas, layerId, 5, 5, INK),
				["2,2"],
				"exactly one pixel",
			);
		},
	},
	{
		name: "drawLine reversed endpoints paint the same bitmap",
		run: (check) => {
			const forward = fresh(6, 4);
			const backward = fresh(6, 4);
			drawLine(forward.canvas, forward.layerId, 0, 0, 5, 3, INK);
			drawLine(backward.canvas, backward.layerId, 5, 3, 0, 0, INK);
			check.ok(
				buffersEqual(
					snapshot(forward.canvas, forward.layerId),
					snapshot(backward.canvas, backward.layerId),
				),
				"direction must not change the bitmap",
			);
		},
	},
	{
		name: "drawLine out-of-bounds endpoint fails without partial writes",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			const before = snapshot(canvas, layerId);
			throwsCode(
				check,
				() => drawLine(canvas, layerId, 0, 0, 5, 0, INK),
				"OUT_OF_BOUNDS",
			);
			throwsCode(
				check,
				() => drawLine(canvas, layerId, -1, 0, 4, 4, INK),
				"OUT_OF_BOUNDS",
			);
			check.ok(
				buffersEqual(before, snapshot(canvas, layerId)),
				"failed line leaves no partial pixels",
			);
		},
	},
	{
		name: "drawLine float coordinate is INVALID_COORDINATE",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			throwsCode(
				check,
				() => drawLine(canvas, layerId, 0.5, 0, 4, 4, INK),
				"INVALID_COORDINATE",
			);
			throwsCode(
				check,
				() => drawLine(canvas, layerId, 0, 0, 4, 4.2, INK),
				"INVALID_COORDINATE",
			);
		},
	},
	{
		name: "drawLine invalid color fails without writes",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			const before = snapshot(canvas, layerId);
			throwsCode(
				check,
				() =>
					drawLine(canvas, layerId, 0, 0, 4, 4, { r: 300, g: 0, b: 0, a: 255 }),
				"INVALID_COLOR",
			);
			check.ok(
				buffersEqual(before, snapshot(canvas, layerId)),
				"bad color leaves no pixels",
			);
		},
	},
	{
		name: "drawRect border golden, interior untouched",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			const rect: Rect = { x: 1, y: 1, width: 3, height: 3 };
			drawRect(canvas, layerId, rect, WALL);
			check.deepEqual(
				paintedPoints(canvas, layerId, 5, 5, WALL),
				["1,1", "2,1", "3,1", "1,2", "3,2", "1,3", "2,3", "3,3"],
				"1px border ring",
			);
			check.deepEqual(
				getPixel(canvas, layerId, 2, 2),
				CLEAR,
				"interior stays clear",
			);
		},
	},
	{
		name: "drawRect 1x1 paints a single pixel",
		run: (check) => {
			const { canvas, layerId } = fresh(3, 3);
			drawRect(canvas, layerId, { x: 1, y: 1, width: 1, height: 1 }, WALL);
			check.deepEqual(
				paintedPoints(canvas, layerId, 3, 3, WALL),
				["1,1"],
				"degenerate rect is one pixel",
			);
		},
	},
	{
		name: "drawRect partially outside fails without partial writes",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			const before = snapshot(canvas, layerId);
			throwsCode(
				check,
				() =>
					drawRect(canvas, layerId, { x: 3, y: 3, width: 3, height: 3 }, WALL),
				"OUT_OF_BOUNDS",
			);
			throwsCode(
				check,
				() =>
					drawRect(canvas, layerId, { x: -1, y: 0, width: 2, height: 2 }, WALL),
				"OUT_OF_BOUNDS",
			);
			check.ok(
				buffersEqual(before, snapshot(canvas, layerId)),
				"failed rect leaves no partial pixels",
			);
		},
	},
	{
		name: "drawRect float origin is INVALID_COORDINATE",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			throwsCode(
				check,
				() =>
					drawRect(
						canvas,
						layerId,
						{ x: 1.5, y: 1, width: 2, height: 2 },
						WALL,
					),
				"INVALID_COORDINATE",
			);
		},
	},
	{
		name: "fillRect golden fills the whole block",
		run: (check) => {
			const { canvas, layerId } = fresh(4, 4);
			fillRect(canvas, layerId, { x: 1, y: 1, width: 2, height: 2 }, FILL);
			check.deepEqual(
				paintedPoints(canvas, layerId, 4, 4, FILL),
				["1,1", "2,1", "1,2", "2,2"],
				"2x2 block",
			);
			check.deepEqual(
				getPixel(canvas, layerId, 0, 0),
				CLEAR,
				"outside stays clear",
			);
			check.deepEqual(
				getPixel(canvas, layerId, 3, 3),
				CLEAR,
				"far corner stays clear",
			);
		},
	},
	{
		name: "fillRect 1x1 paints a single pixel",
		run: (check) => {
			const { canvas, layerId } = fresh(3, 3);
			fillRect(canvas, layerId, { x: 0, y: 0, width: 1, height: 1 }, FILL);
			check.deepEqual(
				paintedPoints(canvas, layerId, 3, 3, FILL),
				["0,0"],
				"exactly one pixel",
			);
		},
	},
	{
		name: "fillRect outside fails without partial writes",
		run: (check) => {
			const { canvas, layerId } = fresh(4, 4);
			const before = snapshot(canvas, layerId);
			throwsCode(
				check,
				() =>
					fillRect(canvas, layerId, { x: 2, y: 2, width: 3, height: 3 }, FILL),
				"OUT_OF_BOUNDS",
			);
			check.ok(
				buffersEqual(before, snapshot(canvas, layerId)),
				"failed fill leaves no partial pixels",
			);
		},
	},
	{
		name: "floodFill open area fills everything",
		run: (check) => {
			const { canvas, layerId } = fresh(3, 3);
			floodFill(canvas, layerId, 1, 1, FILL);
			check.equal(
				paintedPoints(canvas, layerId, 3, 3, FILL).length,
				9,
				"all 9 pixels filled",
			);
		},
	},
	{
		name: "floodFill stays inside a drawn border",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			drawRect(canvas, layerId, { x: 0, y: 0, width: 5, height: 5 }, WALL);
			floodFill(canvas, layerId, 2, 2, FILL);
			check.deepEqual(
				paintedPoints(canvas, layerId, 5, 5, FILL),
				["1,1", "2,1", "3,1", "1,2", "2,2", "3,2", "1,3", "2,3", "3,3"],
				"interior 3x3 only",
			);
			check.deepEqual(
				paintedPoints(canvas, layerId, 5, 5, WALL).length,
				16,
				"16 border pixels untouched",
			);
		},
	},
	{
		name: "floodFill stops at an obstacle line",
		run: (check) => {
			const { canvas, layerId } = fresh(7, 5);
			drawLine(canvas, layerId, 3, 0, 3, 4, WALL);
			floodFill(canvas, layerId, 0, 2, FILL);
			const filled = paintedPoints(canvas, layerId, 7, 5, FILL);
			check.equal(filled.length, 15, "left half 3x5 filled");
			for (const point of filled) {
				const x = Number(point.split(",")[0]);
				check.ok(x < 3, `filled ${point} stays left of the wall`);
			}
			check.deepEqual(
				getPixel(canvas, layerId, 5, 2),
				CLEAR,
				"right side stays clear",
			);
		},
	},
	{
		name: "floodFill matches hidden RGB verbatim under A=0",
		run: (check) => {
			const { canvas, layerId } = fresh(3, 3);
			setPixel(canvas, layerId, 1, 1, { r: 9, g: 9, b: 9, a: 0 });
			floodFill(canvas, layerId, 0, 0, FILL);
			check.deepEqual(
				getPixel(canvas, layerId, 1, 1),
				{ r: 9, g: 9, b: 9, a: 0 },
				"different hidden RGB is a barrier",
			);
			check.equal(
				paintedPoints(canvas, layerId, 3, 3, FILL).length,
				8,
				"other 8 pixels filled",
			);
		},
	},
	{
		name: "floodFill with identical color is a no-op",
		run: (check) => {
			const { canvas, layerId } = fresh(3, 3);
			fillRect(canvas, layerId, { x: 0, y: 0, width: 3, height: 3 }, FILL);
			const before = snapshot(canvas, layerId);
			floodFill(canvas, layerId, 1, 1, { ...FILL });
			check.ok(
				buffersEqual(before, snapshot(canvas, layerId)),
				"same-color fill changes nothing",
			);
		},
	},
	{
		name: "floodFill out-of-bounds seed is OUT_OF_BOUNDS",
		run: (check) => {
			const { canvas, layerId } = fresh(3, 3);
			throwsCode(
				check,
				() => floodFill(canvas, layerId, 3, 0, FILL),
				"OUT_OF_BOUNDS",
			);
			throwsCode(
				check,
				() => floodFill(canvas, layerId, 0, -1, FILL),
				"OUT_OF_BOUNDS",
			);
		},
	},
	{
		name: "floodFill float seed is INVALID_COORDINATE",
		run: (check) => {
			const { canvas, layerId } = fresh(3, 3);
			throwsCode(
				check,
				() => floodFill(canvas, layerId, 1.5, 1, FILL),
				"INVALID_COORDINATE",
			);
		},
	},
	{
		name: "same script twice is byte-identical",
		run: (check) => {
			const first = fresh(8, 8);
			const second = fresh(8, 8);
			paintScript(first.canvas, first.layerId);
			paintScript(second.canvas, second.layerId);
			check.ok(
				buffersEqual(
					snapshot(first.canvas, first.layerId),
					snapshot(second.canvas, second.layerId),
				),
				"two runs produce identical bytes",
			);
		},
	},
	{
		name: "large fillRect plus floodFill complete with spot checks",
		run: (check) => {
			const { canvas, layerId } = fresh(256, 256);
			fillRect(canvas, layerId, { x: 0, y: 0, width: 256, height: 256 }, FILL);
			check.deepEqual(getPixel(canvas, layerId, 0, 0), FILL, "top-left corner");
			check.deepEqual(
				getPixel(canvas, layerId, 255, 255),
				FILL,
				"bottom-right corner",
			);
			check.deepEqual(getPixel(canvas, layerId, 128, 128), FILL, "center");
			floodFill(canvas, layerId, 0, 0, INK);
			check.deepEqual(
				getPixel(canvas, layerId, 255, 255),
				INK,
				"flood reaches far corner",
			);
			check.equal(
				paintedPoints(canvas, layerId, 256, 256, INK).length,
				256 * 256,
				"whole layer refilled without stack overflow",
			);
		},
	},
	{
		name: "large bordered floodFill fills the interior exactly",
		run: (check) => {
			const { canvas, layerId } = fresh(128, 128);
			drawRect(canvas, layerId, { x: 0, y: 0, width: 128, height: 128 }, WALL);
			floodFill(canvas, layerId, 64, 64, FILL);
			check.equal(
				paintedPoints(canvas, layerId, 128, 128, FILL).length,
				126 * 126,
				"interior 126x126 filled",
			);
			check.deepEqual(
				getPixel(canvas, layerId, 0, 0),
				WALL,
				"border corner untouched",
			);
		},
	},
];
