import {
	addLayer,
	addRegion,
	createCanvas,
	replaceLayerPixels,
	replaceRegionMask,
} from "../../src/core/canvas.ts";
import { McAssetError } from "../../src/core/errors.ts";
import { parseGuiSize, scaleGuiCanvas } from "../../src/core/gui-scaling.ts";
import type { GuiScaling } from "../../src/core/mcmeta.ts";
import type { PixelCanvas, RGBA } from "../../src/core/types.ts";

/** Runner-agnostic assertion surface: bun:test and node:test entries adapt to this. */
export interface GuiCaseCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
}

function throwsCode(
	check: GuiCaseCheck,
	fn: () => unknown,
	code: string,
): void {
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

export interface GuiScalingCase {
	name: string;
	run(check: GuiCaseCheck): void;
}

/** Distinct color per pixel: r tracks x, g tracks y, b tracks x + y. */
function scheme(x: number, y: number): RGBA {
	return { r: x * 16, g: y * 16, b: x + y, a: 255 };
}

function patternCanvas(width: number, height: number): PixelCanvas {
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: "base" });
	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const color = scheme(x, y);
			const offset = (y * width + x) * 4;
			pixels[offset] = color.r;
			pixels[offset + 1] = color.g;
			pixels[offset + 2] = color.b;
			pixels[offset + 3] = color.a;
		}
	}
	replaceLayerPixels(canvas, layer.id, pixels);
	return canvas;
}

function at(
	canvas: PixelCanvas,
	layerId: string,
	x: number,
	y: number,
): number[] {
	const layer = canvas.layers.find((entry) => entry.id === layerId);
	if (layer === undefined) {
		throw new Error(`missing layer ${layerId}`);
	}
	const offset = (y * canvas.width + x) * 4;
	return [
		layer.pixels[offset] as number,
		layer.pixels[offset + 1] as number,
		layer.pixels[offset + 2] as number,
		layer.pixels[offset + 3] as number,
	];
}

function rgbaOf(x: number, y: number): number[] {
	const color = scheme(x, y);
	return [color.r, color.g, color.b, color.a];
}

function snapshot(canvas: PixelCanvas): Uint8Array[] {
	return canvas.layers.map((layer) => layer.pixels.slice());
}

const NINE_6 = {
	left: 2,
	top: 2,
	right: 2,
	bottom: 2,
} as const;

function nineScaling(stretchInner: boolean): GuiScaling {
	return {
		kind: "nine_slice",
		width: 6,
		height: 6,
		border: { ...NINE_6 },
		stretchInner,
	};
}

export const GUI_SCALING_CASES: GuiScalingCase[] = [
	{
		name: "stretch upscales with nearest mapping",
		run: (check) => {
			const out = scaleGuiCanvas(
				patternCanvas(4, 4),
				{ kind: "stretch" },
				8,
				8,
			);
			check.equal(out.width, 8, "width");
			check.equal(out.height, 8, "height");
			check.deepEqual(at(out, "base", 0, 0), rgbaOf(0, 0), "origin");
			check.deepEqual(at(out, "base", 1, 0), rgbaOf(0, 0), "doubled");
			check.deepEqual(at(out, "base", 2, 0), rgbaOf(1, 0), "step");
			check.deepEqual(at(out, "base", 7, 7), rgbaOf(3, 3), "far corner");
			check.deepEqual(at(out, "base", 5, 3), rgbaOf(2, 1), "interior");
		},
	},
	{
		name: "stretch downscales with nearest mapping",
		run: (check) => {
			const out = scaleGuiCanvas(
				patternCanvas(4, 4),
				{ kind: "stretch" },
				2,
				2,
			);
			for (let y = 0; y < 2; y += 1) {
				for (let x = 0; x < 2; x += 1) {
					check.deepEqual(
						at(out, "base", x, y),
						rgbaOf(x * 2, y * 2),
						`pixel ${x},${y}`,
					);
				}
			}
		},
	},
	{
		name: "tile repeats from the top-left and crops overflow",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			const layer = addLayer(canvas, { id: "base" });
			replaceLayerPixels(
				canvas,
				layer.id,
				new Uint8Array([
					10, 0, 0, 255, 0, 20, 0, 255, 0, 0, 30, 255, 40, 40, 40, 255,
				]),
			);
			const out = scaleGuiCanvas(
				canvas,
				{ kind: "tile", width: 2, height: 2 },
				5,
				4,
			);
			check.equal(out.width, 5, "width");
			check.equal(out.height, 4, "height");
			const want = (x: number, y: number): number[] =>
				at(canvas, "base", x % 2, y % 2);
			for (let y = 0; y < 4; y += 1) {
				for (let x = 0; x < 5; x += 1) {
					check.deepEqual(at(out, "base", x, y), want(x, y), `${x},${y}`);
				}
			}
		},
	},
	{
		name: "tile maps through the declared design size first",
		run: (check) => {
			const out = scaleGuiCanvas(
				patternCanvas(2, 2),
				{ kind: "tile", width: 4, height: 4 },
				6,
				6,
			);
			// Design base is nearest 2x2 -> 4x4, then tiled 4x4 -> 6x6.
			// base(bx,by) = src(floor(bx/2), floor(by/2)).
			check.deepEqual(at(out, "base", 0, 0), rgbaOf(0, 0), "origin");
			check.deepEqual(at(out, "base", 2, 0), rgbaOf(1, 0), "design pixel");
			check.deepEqual(at(out, "base", 4, 0), rgbaOf(0, 0), "tile wrap");
			check.deepEqual(at(out, "base", 5, 5), rgbaOf(0, 0), "wrapped design");
			check.deepEqual(at(out, "base", 3, 1), rgbaOf(1, 0), "interior");
		},
	},
	{
		name: "nine_slice tiles inner slices when stretch_inner is false",
		run: (check) => {
			const out = scaleGuiCanvas(
				patternCanvas(6, 6),
				nineScaling(false),
				10,
				10,
			);
			check.deepEqual(at(out, "base", 0, 0), rgbaOf(0, 0), "top-left corner");
			check.deepEqual(at(out, "base", 9, 0), rgbaOf(5, 0), "top-right corner");
			check.deepEqual(at(out, "base", 0, 9), rgbaOf(0, 5), "bottom-left");
			check.deepEqual(at(out, "base", 9, 9), rgbaOf(5, 5), "bottom-right");
			check.deepEqual(at(out, "base", 2, 0), rgbaOf(2, 0), "top edge start");
			check.deepEqual(at(out, "base", 3, 0), rgbaOf(3, 0), "top edge next");
			check.deepEqual(at(out, "base", 4, 0), rgbaOf(2, 0), "top edge wraps");
			check.deepEqual(at(out, "base", 2, 2), rgbaOf(2, 2), "center start");
			check.deepEqual(at(out, "base", 0, 2), rgbaOf(0, 2), "left edge start");
			check.deepEqual(at(out, "base", 9, 5), rgbaOf(5, 3), "right edge wraps");
		},
	},
	{
		name: "nine_slice tiling golden pixels lock the wrap",
		run: (check) => {
			const out = scaleGuiCanvas(
				patternCanvas(6, 6),
				nineScaling(false),
				10,
				10,
			);
			check.deepEqual(at(out, "base", 4, 0), [32, 0, 2, 255], "top wraps");
			check.deepEqual(at(out, "base", 0, 4), [0, 32, 2, 255], "left wraps");
			check.deepEqual(at(out, "base", 7, 7), [48, 48, 6, 255], "center wraps");
			check.deepEqual(at(out, "base", 7, 8), [48, 64, 7, 255], "bottom band");
		},
	},
	{
		name: "nine_slice stretches inner slices when stretch_inner is true",
		run: (check) => {
			const out = scaleGuiCanvas(
				patternCanvas(6, 6),
				nineScaling(true),
				10,
				10,
			);
			// Corners stay 1:1 in both modes.
			check.deepEqual(at(out, "base", 0, 0), rgbaOf(0, 0), "corner");
			check.deepEqual(at(out, "base", 9, 9), rgbaOf(5, 5), "corner");
			// Inner width 6 from source width 2: floor(dx*2/6).
			check.deepEqual(at(out, "base", 2, 0), rgbaOf(2, 0), "edge start");
			check.deepEqual(at(out, "base", 3, 0), rgbaOf(2, 0), "edge stretched");
			check.deepEqual(at(out, "base", 5, 0), rgbaOf(3, 0), "edge far half");
			check.deepEqual(at(out, "base", 5, 5), rgbaOf(3, 3), "center stretched");
		},
	},
	{
		name: "stretch_inner false tiles where true would stretch",
		run: (check) => {
			const tiled = scaleGuiCanvas(
				patternCanvas(6, 6),
				nineScaling(false),
				10,
				10,
			);
			const stretched = scaleGuiCanvas(
				patternCanvas(6, 6),
				nineScaling(true),
				10,
				10,
			);
			check.deepEqual(
				at(tiled, "base", 3, 0),
				[48, 0, 3, 255],
				"tiled edge advances",
			);
			check.deepEqual(
				at(stretched, "base", 3, 0),
				[32, 0, 2, 255],
				"stretched edge holds",
			);
		},
	},
	{
		name: "border overflow clamps to half the target",
		run: (check) => {
			const out = scaleGuiCanvas(patternCanvas(6, 6), nineScaling(false), 3, 3);
			// Clamped borders are 1px; every source anchor uses the clamped
			// values, so the right column starts at W - 1 and the inner
			// band is x in [1, 5).
			check.deepEqual(at(out, "base", 0, 0), rgbaOf(0, 0), "clamped corner");
			check.deepEqual(at(out, "base", 2, 0), rgbaOf(5, 0), "right outer edge");
			check.deepEqual(at(out, "base", 0, 2), rgbaOf(0, 5), "bottom outer edge");
			check.deepEqual(at(out, "base", 2, 2), rgbaOf(5, 5), "far outer edge");
			check.deepEqual(at(out, "base", 1, 1), rgbaOf(1, 1), "tiled middle");
			check.deepEqual(at(out, "base", 1, 0), rgbaOf(1, 0), "top band");
			check.deepEqual(at(out, "base", 0, 1), rgbaOf(0, 1), "left band");
			check.deepEqual(at(out, "base", 2, 1), rgbaOf(5, 1), "right band");
			check.deepEqual(at(out, "base", 1, 2), rgbaOf(1, 5), "bottom band");
		},
	},
	{
		name: "single-column target drops the corners",
		run: (check) => {
			const out = scaleGuiCanvas(
				patternCanvas(4, 4),
				{
					kind: "nine_slice",
					width: 4,
					height: 4,
					border: { left: 1, top: 1, right: 1, bottom: 1 },
					stretchInner: false,
				},
				1,
				2,
			);
			check.equal(out.width, 1, "width");
			check.equal(out.height, 2, "height");
			// Horizontal clamp wipes the side borders (l' = r' = 0), so the
			// edge bands start at the clamped x origin.
			check.deepEqual(at(out, "base", 0, 0), rgbaOf(0, 0), "top band tile");
			check.deepEqual(at(out, "base", 0, 1), rgbaOf(0, 3), "bottom band tile");
		},
	},
	{
		name: "transparent edges copy verbatim including hidden rgb",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			const layer = addLayer(canvas, { id: "base" });
			const pixels = new Uint8Array(4 * 4 * 4);
			for (let i = 0; i < pixels.length; i += 4) {
				pixels[i] = 7;
				pixels[i + 1] = 8;
				pixels[i + 2] = 9;
				pixels[i + 3] = 255;
			}
			const hidden: RGBA = { r: 99, g: 88, b: 77, a: 0 };
			const put = (x: number, y: number): void => {
				const offset = (y * 4 + x) * 4;
				pixels[offset] = hidden.r;
				pixels[offset + 1] = hidden.g;
				pixels[offset + 2] = hidden.b;
				pixels[offset + 3] = hidden.a;
			};
			put(0, 0);
			put(3, 3);
			replaceLayerPixels(canvas, layer.id, pixels);
			const out = scaleGuiCanvas(canvas, { kind: "stretch" }, 8, 8);
			check.deepEqual(
				at(out, "base", 0, 0),
				[99, 88, 77, 0],
				"hidden rgb survives stretch",
			);
			const tiled = scaleGuiCanvas(
				canvas,
				{ kind: "tile", width: 4, height: 4 },
				6,
				6,
			);
			check.deepEqual(
				at(tiled, "base", 4, 4),
				[99, 88, 77, 0],
				"hidden rgb survives tile wrap",
			);
		},
	},
	{
		name: "same size returns an identical copy",
		run: (check) => {
			const canvas = patternCanvas(4, 4);
			const before = snapshot(canvas);
			const out = scaleGuiCanvas(canvas, nineScaling(false), 4, 4);
			check.equal(out.width, 4, "width");
			check.equal(out.height, 4, "height");
			for (let y = 0; y < 4; y += 1) {
				for (let x = 0; x < 4; x += 1) {
					check.deepEqual(at(out, "base", x, y), rgbaOf(x, y), `${x},${y}`);
				}
			}
			const after = snapshot(canvas);
			check.deepEqual(
				[...(after[0] as Uint8Array)],
				[...(before[0] as Uint8Array)],
				"input untouched",
			);
			check.ok(
				out.layers[0]?.pixels !== canvas.layers[0]?.pixels,
				"fresh buffers",
			);
		},
	},
	{
		name: "nine_slice maps through the declared design size first",
		run: (check) => {
			const out = scaleGuiCanvas(
				patternCanvas(4, 4),
				{
					kind: "nine_slice",
					width: 8,
					height: 8,
					border: { left: 2, top: 2, right: 2, bottom: 2 },
					stretchInner: false,
				},
				12,
				12,
			);
			// Design base is nearest 4x4 -> 8x8; corners then copy 1:1.
			check.deepEqual(at(out, "base", 0, 0), rgbaOf(0, 0), "corner");
			check.deepEqual(at(out, "base", 2, 0), rgbaOf(1, 0), "mapped edge");
			check.deepEqual(at(out, "base", 11, 11), rgbaOf(3, 3), "far corner");
		},
	},
	{
		name: "layers and masks share the nine_slice layout",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			const first = addLayer(canvas, { id: "first" });
			const second = addLayer(canvas, { id: "second" });
			replaceLayerPixels(
				canvas,
				first.id,
				new Uint8Array([
					1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255,
				]),
			);
			replaceLayerPixels(
				canvas,
				second.id,
				new Uint8Array([
					9, 0, 0, 255, 8, 0, 0, 255, 7, 0, 0, 255, 6, 0, 0, 255,
				]),
			);
			const region = addRegion(canvas, { id: "zone" });
			replaceRegionMask(canvas, region.id, new Uint8Array([1, 0, 0, 1]));
			const out = scaleGuiCanvas(
				canvas,
				{ kind: "tile", width: 2, height: 2 },
				3,
				3,
			);
			check.equal(out.layers.length, 2, "layers kept");
			check.equal(out.regions.length, 1, "regions kept");
			check.equal(out.layers[0]?.id, "first", "layer order");
			check.equal(out.regions[0]?.id, "zone", "region id");
			check.deepEqual(at(out, "first", 2, 2), [1, 0, 0, 255], "first wraps");
			check.deepEqual(at(out, "second", 2, 2), [9, 0, 0, 255], "second wraps");
			const mask = out.regions[0]?.mask ?? new Uint8Array();
			const maskAt = (x: number, y: number): number =>
				mask[y * out.width + x] as number;
			check.equal(maskAt(0, 0), 1, "mask origin");
			check.equal(maskAt(1, 0), 0, "mask next");
			check.equal(maskAt(2, 2), 1, "mask wraps with the layout");
		},
	},
	{
		name: "scaling never mutates the input canvas",
		run: (check) => {
			const canvas = patternCanvas(6, 6);
			const before = snapshot(canvas);
			scaleGuiCanvas(canvas, nineScaling(true), 10, 10);
			scaleGuiCanvas(canvas, { kind: "tile", width: 6, height: 6 }, 9, 9);
			scaleGuiCanvas(canvas, { kind: "stretch" }, 3, 3);
			check.equal(canvas.width, 6, "width kept");
			check.equal(canvas.height, 6, "height kept");
			const after = snapshot(canvas);
			check.deepEqual(
				[...(after[0] as Uint8Array)],
				[...(before[0] as Uint8Array)],
				"pixels kept",
			);
		},
	},
	{
		name: "parseGuiSize accepts N and WxH",
		run: (check) => {
			check.deepEqual(parseGuiSize("16"), { width: 16, height: 16 }, "square");
			check.deepEqual(parseGuiSize("8x4"), { width: 8, height: 4 }, "rect");
			check.deepEqual(parseGuiSize("1"), { width: 1, height: 1 }, "tiny");
		},
	},
	{
		name: "parseGuiSize rejects missing and non-positive sizes",
		run: (check) => {
			for (const raw of [
				"",
				"0",
				"0x4",
				"4x0",
				"-3",
				"ax4",
				"4xb",
				"1x2x3",
				"4x",
				"x4",
			]) {
				throwsCode(check, () => parseGuiSize(raw), "INVALID_ARGUMENT");
			}
			throwsCode(check, () => parseGuiSize(undefined), "INVALID_ARGUMENT");
			throwsCode(check, () => parseGuiSize("5000"), "INVALID_DIMENSION");
			throwsCode(check, () => parseGuiSize("4x5000"), "INVALID_DIMENSION");
		},
	},
];
