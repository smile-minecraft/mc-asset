import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../src/core/canvas.ts";
import { McAssetError } from "../../src/core/errors.ts";
import {
	createFrameSet,
	describeFrameSet,
	frameFileName,
	packFrameSet,
	parseAnimationLayout,
	parseFrameOrder,
	parseFrameSize,
	parseGridColumns,
	reorderFrames,
	resizeFrameSet,
	sheetDimensions,
	unpackSheetToFrameSet,
} from "../../src/core/frameset.ts";
import type { PixelCanvas, RGBA } from "../../src/core/types.ts";
import type { CaseCheck, ModelCase } from "./model-cases.ts";

/** Solid-color single-layer canvas for layout geometry cases. */
function solidCanvas(width: number, height: number, color: RGBA): PixelCanvas {
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: "base" });
	const pixels = new Uint8Array(width * height * 4);
	for (let i = 0; i < pixels.length; i += 4) {
		pixels[i] = color.r;
		pixels[i + 1] = color.g;
		pixels[i + 2] = color.b;
		pixels[i + 3] = color.a;
	}
	replaceLayerPixels(canvas, layer.id, pixels);
	return canvas;
}

function layerBytes(canvas: PixelCanvas): Uint8Array {
	const layer = canvas.layers[0];
	if (layer === undefined) {
		throw new Error("case canvas needs one layer");
	}
	return layer.pixels;
}

function pixelOf(
	pixels: Uint8Array,
	width: number,
	x: number,
	y: number,
): [number, number, number, number] {
	const offset = (y * width + x) * 4;
	return [
		pixels[offset] as number,
		pixels[offset + 1] as number,
		pixels[offset + 2] as number,
		pixels[offset + 3] as number,
	];
}

const RED: RGBA = { r: 255, g: 0, b: 0, a: 255 };
const GREEN: RGBA = { r: 0, g: 255, b: 0, a: 255 };
const BLUE: RGBA = { r: 0, g: 0, b: 255, a: 255 };
const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 255 };
const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 255 };

function expectDetails(
	check: CaseCheck,
	fn: () => unknown,
	code: string,
	pick: (details: Record<string, unknown>) => unknown,
	want: unknown,
): void {
	try {
		fn();
	} catch (error) {
		check.ok(error instanceof McAssetError, "expected McAssetError");
		check.equal((error as McAssetError).code, code, "wrong error code");
		check.deepEqual(
			pick((error as McAssetError).details as Record<string, unknown>),
			want,
			"wrong error details",
		);
		return;
	}
	check.fail(`expected McAssetError(${code}) but nothing was thrown`);
}

export const FRAMESET_CASES: ModelCase[] = [
	{
		name: "vertical pack stacks frames top to bottom at 1:1",
		run(check) {
			const frameSet = createFrameSet([
				solidCanvas(2, 2, RED),
				solidCanvas(2, 2, GREEN),
				solidCanvas(2, 2, BLUE),
			]);
			const sheet = packFrameSet(frameSet, "vertical");
			check.equal(sheet.width, 2, "vertical width");
			check.equal(sheet.height, 6, "vertical height");
			check.deepEqual(
				pixelOf(sheet.pixels, 2, 0, 0),
				[255, 0, 0, 255],
				"frame 0 top",
			);
			check.deepEqual(
				pixelOf(sheet.pixels, 2, 1, 3),
				[0, 255, 0, 255],
				"frame 1 middle",
			);
			check.deepEqual(
				pixelOf(sheet.pixels, 2, 0, 5),
				[0, 0, 255, 255],
				"frame 2 bottom",
			);
		},
	},
	{
		name: "horizontal pack places frames left to right at 1:1",
		run(check) {
			const frameSet = createFrameSet([
				solidCanvas(2, 2, RED),
				solidCanvas(2, 2, GREEN),
			]);
			const sheet = packFrameSet(frameSet, "horizontal");
			check.equal(sheet.width, 4, "horizontal width");
			check.equal(sheet.height, 2, "horizontal height");
			check.deepEqual(
				pixelOf(sheet.pixels, 4, 0, 0),
				[255, 0, 0, 255],
				"frame 0 left",
			);
			check.deepEqual(
				pixelOf(sheet.pixels, 4, 3, 1),
				[0, 255, 0, 255],
				"frame 1 right",
			);
		},
	},
	{
		name: "grid pack fills row-major and leaves transparent empties",
		run(check) {
			const frameSet = createFrameSet([
				solidCanvas(2, 2, RED),
				solidCanvas(2, 2, GREEN),
				solidCanvas(2, 2, BLUE),
				solidCanvas(2, 2, WHITE),
				solidCanvas(2, 2, BLACK),
			]);
			const sheet = packFrameSet(frameSet, "grid", 2);
			check.equal(sheet.width, 4, "grid width");
			check.equal(sheet.height, 6, "grid height");
			check.deepEqual(
				pixelOf(sheet.pixels, 4, 0, 0),
				[255, 0, 0, 255],
				"cell 0",
			);
			check.deepEqual(
				pixelOf(sheet.pixels, 4, 2, 0),
				[0, 255, 0, 255],
				"cell 1",
			);
			check.deepEqual(pixelOf(sheet.pixels, 4, 0, 4), [0, 0, 0, 255], "cell 4");
			check.deepEqual(
				pixelOf(sheet.pixels, 4, 2, 4),
				[0, 0, 0, 0],
				"empty cell transparent",
			);
			check.deepEqual(
				pixelOf(sheet.pixels, 4, 3, 5),
				[0, 0, 0, 0],
				"empty cell corner",
			);
		},
	},
	{
		name: "grid pack without columns is rejected",
		run(check) {
			const frameSet = createFrameSet([solidCanvas(2, 2, RED)]);
			check.throwsCode(
				() => packFrameSet(frameSet, "grid"),
				"INVALID_ARGUMENT",
				"grid needs columns",
			);
		},
	},
	{
		name: "pack then unpack returns identical frame pixels",
		run(check) {
			for (const layout of ["vertical", "horizontal", "grid"] as const) {
				const frames = [
					solidCanvas(3, 2, RED),
					solidCanvas(3, 2, GREEN),
					solidCanvas(3, 2, BLUE),
				];
				const frameSet = createFrameSet(frames);
				const sheet = packFrameSet(frameSet, layout, 2);
				const back = unpackSheetToFrameSet(
					sheet.pixels,
					sheet.width,
					sheet.height,
					layout,
					3,
					2,
					2,
				);
				check.equal(
					back.frames.length,
					layout === "grid" ? 4 : 3,
					`${layout} count`,
				);
				for (let i = 0; i < 3; i += 1) {
					const left = frames[i];
					const right = back.frames[i];
					if (left === undefined || right === undefined) {
						check.fail(`missing ${layout} frame ${i}`);
					}
					check.deepEqual(
						[...layerBytes(right)],
						[...layerBytes(left)],
						`${layout} frame ${i} pixels`,
					);
				}
				const trimmed =
					back.frames.length === 3
						? back
						: createFrameSet(back.frames.slice(0, 3));
				const repacked = packFrameSet(trimmed, layout, 2);
				check.deepEqual(
					[...repacked.pixels],
					[...sheet.pixels],
					`${layout} repack identical`,
				);
			}
		},
	},
	{
		name: "unpack rejects indivisible vertical sheets",
		run(check) {
			const pixels = new Uint8Array(4 * 5 * 4);
			expectDetails(
				check,
				() => unpackSheetToFrameSet(pixels, 4, 5, "vertical", 4, 2),
				"INVALID_ANIMATION_FRAME",
				(details) => details["layout"],
				"vertical",
			);
		},
	},
	{
		name: "unpack rejects indivisible horizontal sheets",
		run(check) {
			const pixels = new Uint8Array(5 * 4 * 4);
			expectDetails(
				check,
				() => unpackSheetToFrameSet(pixels, 5, 4, "horizontal", 2, 4),
				"INVALID_ANIMATION_FRAME",
				(details) => details["layout"],
				"horizontal",
			);
		},
	},
	{
		name: "unpack rejects grid sheets whose width is not divisible by columns",
		run(check) {
			const pixels = new Uint8Array(5 * 4 * 4);
			expectDetails(
				check,
				() => unpackSheetToFrameSet(pixels, 5, 4, "grid", 2, 2, 2),
				"INVALID_ANIMATION_FRAME",
				(details) => details["layout"],
				"grid",
			);
		},
	},
	{
		name: "unpack rejects mismatched cell widths with dimensions in details",
		run(check) {
			const pixels = new Uint8Array(6 * 2 * 4);
			expectDetails(
				check,
				() => unpackSheetToFrameSet(pixels, 6, 2, "grid", 2, 2, 2),
				"INVALID_ANIMATION_FRAME",
				(details) => ({
					frameWidth: details["frameWidth"],
					sheetWidth: details["sheetWidth"],
				}),
				{ frameWidth: 2, sheetWidth: 6 },
			);
		},
	},
	{
		name: "sheet dimensions follow the frozen formulas",
		run(check) {
			check.deepEqual(
				sheetDimensions(3, 2, 2, "vertical"),
				{ width: 2, height: 6 },
				"vertical",
			);
			check.deepEqual(
				sheetDimensions(3, 2, 2, "horizontal"),
				{ width: 6, height: 2 },
				"horizontal",
			);
			check.deepEqual(
				sheetDimensions(5, 2, 2, "grid", 2),
				{ width: 4, height: 6 },
				"grid",
			);
			check.deepEqual(
				sheetDimensions(4, 2, 2, "grid", 2),
				{ width: 4, height: 4 },
				"grid full",
			);
		},
	},
	{
		name: "oversized sheets are INVALID_DIMENSION before any allocation",
		run(check) {
			const frameSet = createFrameSet([solidCanvas(2, 2, RED)]);
			const first = frameSet.frames[0];
			if (first === undefined) {
				check.fail("case needs one frame");
			}
			const big = {
				...frameSet,
				frames: new Array(3000).fill(first) as PixelCanvas[],
			};
			check.throwsCode(
				() => packFrameSet(big, "vertical"),
				"INVALID_DIMENSION",
				"height over limit",
			);
		},
	},
	{
		name: "mismatched frame sizes are rejected with the frame index",
		run(check) {
			expectDetails(
				check,
				() =>
					createFrameSet([solidCanvas(2, 2, RED), solidCanvas(3, 2, GREEN)]),
				"INVALID_ANIMATION_FRAME",
				(details) => details["index"],
				1,
			);
		},
	},
	{
		name: "empty frame sets are rejected",
		run(check) {
			check.throwsCode(
				() => createFrameSet([]),
				"INVALID_ANIMATION_FRAME",
				"count >= 1",
			);
		},
	},
	{
		name: "reorder permutes frames without touching pixels",
		run(check) {
			const frames = [
				solidCanvas(2, 2, RED),
				solidCanvas(2, 2, GREEN),
				solidCanvas(2, 2, BLUE),
			];
			const reordered = reorderFrames(frames, [2, 0, 1]);
			const head = (canvas: PixelCanvas): number[] => [
				...layerBytes(canvas).slice(0, 4),
			];
			const get = (list: PixelCanvas[], i: number): PixelCanvas => {
				const canvas = list[i];
				if (canvas === undefined) {
					throw new Error(`missing frame ${i}`);
				}
				return canvas;
			};
			check.deepEqual(
				head(get(reordered, 0)),
				head(get(frames, 2)),
				"new 0 is old 2",
			);
			check.deepEqual(
				head(get(reordered, 1)),
				head(get(frames, 0)),
				"new 1 is old 0",
			);
			check.deepEqual(
				head(get(reordered, 2)),
				head(get(frames, 1)),
				"new 2 is old 1",
			);
		},
	},
	{
		name: "reorder rejects non-permutations",
		run(check) {
			const frames = [solidCanvas(2, 2, RED), solidCanvas(2, 2, GREEN)];
			check.throwsCode(
				() => reorderFrames(frames, [0]),
				"INVALID_ARGUMENT",
				"short order",
			);
			check.throwsCode(
				() => reorderFrames(frames, [0, 0]),
				"INVALID_ARGUMENT",
				"duplicate order",
			);
			check.throwsCode(
				() => reorderFrames(frames, [0, 5]),
				"INVALID_ARGUMENT",
				"out of range order",
			);
			check.throwsCode(
				() => reorderFrames(frames, [1, 0, 2]),
				"INVALID_ARGUMENT",
				"long order",
			);
		},
	},
	{
		name: "resize nearest introduces no new colors",
		run(check) {
			const canvas = createCanvas(2, 2);
			const layer = addLayer(canvas, { id: "base" });
			replaceLayerPixels(
				canvas,
				layer.id,
				new Uint8Array([
					255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
				]),
			);
			const frameSet = createFrameSet([canvas]);
			resizeFrameSet(frameSet, 4, 4, "nearest");
			check.equal(frameSet.frameWidth, 4, "width updated");
			check.equal(frameSet.frameHeight, 4, "height updated");
			const first = frameSet.frames[0];
			if (first === undefined) {
				check.fail("resized frame missing");
			}
			const pixels = layerBytes(first);
			const seen = new Set<string>();
			for (let i = 0; i < pixels.length; i += 4) {
				seen.add(
					`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]},${pixels[i + 3]}`,
				);
			}
			check.equal(seen.size, 4, "no new colors");
		},
	},
	{
		name: "resize pixel-aware succeeds and keeps frame dimensions in sync",
		run(check) {
			const frameSet = createFrameSet([solidCanvas(4, 4, RED)]);
			resizeFrameSet(frameSet, 2, 2, "pixel-aware");
			check.equal(frameSet.frameWidth, 2, "width updated");
			check.equal(frameSet.frameHeight, 2, "height updated");
			const first = frameSet.frames[0];
			if (first === undefined) {
				check.fail("resized frame missing");
				return;
			}
			check.deepEqual(
				pixelOf(layerBytes(first), 2, 0, 0),
				[255, 0, 0, 255],
				"solid color survives the majority vote",
			);
		},
	},
	{
		name: "resize pixel-aware is stable across identical frames",
		run(check) {
			const frameSet = createFrameSet([
				solidCanvas(4, 4, RED),
				solidCanvas(4, 4, RED),
			]);
			resizeFrameSet(frameSet, 2, 2, "pixel-aware");
			const first = frameSet.frames[0];
			const second = frameSet.frames[1];
			if (first === undefined || second === undefined) {
				check.fail("resized frames missing");
				return;
			}
			const a = layerBytes(first);
			const b = layerBytes(second);
			check.equal(a.length, b.length, "same length");
			let same = a.length === b.length;
			for (let i = 0; i < a.length && same; i += 1) {
				if (a[i] !== b[i]) {
					same = false;
				}
			}
			check.ok(same, "identical inputs give identical outputs");
		},
	},
	{
		name: "frame file names pad to the count width",
		run(check) {
			check.equal(frameFileName(0, 3), "frame_0.mcpx", "single digit");
			check.equal(frameFileName(2, 3), "frame_2.mcpx", "single digit end");
			check.equal(frameFileName(0, 12), "frame_00.mcpx", "padded start");
			check.equal(frameFileName(11, 12), "frame_11.mcpx", "padded end");
		},
	},
	{
		name: "frame sizes parse like pixelize with dimension guards",
		run(check) {
			check.deepEqual(
				parseFrameSize("16"),
				{ width: 16, height: 16 },
				"square shorthand",
			);
			check.deepEqual(parseFrameSize("4x5"), { width: 4, height: 5 }, "rect");
			check.throwsCode(
				() => parseFrameSize("4.5"),
				"INVALID_ARGUMENT",
				"non-integer",
			);
			check.throwsCode(
				() => parseFrameSize("0"),
				"INVALID_DIMENSION",
				"zero edge",
			);
			check.throwsCode(
				() => parseFrameSize(undefined),
				"INVALID_ARGUMENT",
				"missing size",
			);
		},
	},
	{
		name: "layout and columns parse with grid enforcement",
		run(check) {
			check.equal(parseAnimationLayout("vertical"), "vertical", "vertical");
			check.throwsCode(
				() => parseAnimationLayout(undefined),
				"INVALID_ARGUMENT",
				"missing layout",
			);
			check.throwsCode(
				() => parseAnimationLayout("diagonal"),
				"INVALID_ARGUMENT",
				"unknown layout",
			);
			check.equal(parseGridColumns("grid", "3"), 3, "grid columns");
			check.throwsCode(
				() => parseGridColumns("grid", undefined),
				"INVALID_ARGUMENT",
				"grid needs columns",
			);
			check.equal(
				parseGridColumns("vertical", undefined),
				undefined,
				"non-grid ignores columns",
			);
		},
	},
	{
		name: "order strings parse to validated permutations",
		run(check) {
			check.deepEqual(parseFrameOrder("2,0,1", 3), [2, 0, 1], "valid order");
			check.throwsCode(
				() => parseFrameOrder(undefined, 3),
				"INVALID_ARGUMENT",
				"missing order",
			);
			check.throwsCode(
				() => parseFrameOrder("0,0,1", 3),
				"INVALID_ARGUMENT",
				"duplicate order",
			);
			check.throwsCode(
				() => parseFrameOrder("0,3", 3),
				"INVALID_ARGUMENT",
				"out of range",
			);
		},
	},
	{
		name: "geometry reports are deterministic and carry the frame census",
		run(check) {
			const frameSet = createFrameSet([
				solidCanvas(2, 2, RED),
				solidCanvas(2, 2, GREEN),
			]);
			const first = describeFrameSet(frameSet);
			const second = describeFrameSet(frameSet);
			check.deepEqual(first, second, "deterministic");
			check.equal(first.verdict, "pass", "verdict");
			check.equal(first.frameCount, 2, "count");
			check.deepEqual(first.findings, [], "no findings");
		},
	},
];
