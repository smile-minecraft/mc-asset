import {
	addLayer,
	addRegion,
	createCanvas,
	getLayer,
	setPixel,
	setRegionValue,
} from "../../src/core/canvas.ts";
import { McAssetError } from "../../src/core/errors.ts";
import {
	countSelectedPixels,
	forEachSelectedPixel,
	isPixelSelected,
	listSelectedPixels,
	resolveSelection,
} from "../../src/core/selection.ts";
import type { PixelCanvas, RGBA } from "../../src/core/types.ts";
import type { CaseCheck } from "./model-cases.ts";

export interface SelectionCase {
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

const INK: RGBA = { r: 255, g: 0, b: 0, a: 255 };

function fresh(
	width: number,
	height: number,
): { canvas: PixelCanvas; layerId: string } {
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: "base" });
	return { canvas, layerId: layer.id };
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

function sameColor(a: RGBA, b: RGBA): boolean {
	return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

/** Fill every pixel with a distinct opaque color; (w-1,h-1) keeps hidden RGB. */
function seedDistinct(canvas: PixelCanvas, layerId: string): void {
	for (let y = 0; y < canvas.height; y += 1) {
		for (let x = 0; x < canvas.width; x += 1) {
			setPixel(canvas, layerId, x, y, {
				r: (x * 16) % 256,
				g: (y * 16) % 256,
				b: ((x + y) * 8) % 256,
				a: 255,
			});
		}
	}
	setPixel(canvas, layerId, canvas.width - 1, canvas.height - 1, {
		r: 17,
		g: 34,
		b: 51,
		a: 0,
	});
}

export const SELECTION_CASES: SelectionCase[] = [
	{
		name: "omitted selection covers the whole canvas",
		run: (check) => {
			const { canvas } = fresh(4, 3);
			const selection = resolveSelection(canvas, undefined);
			check.equal(selection.kind, "all", "kind is all");
			check.equal(
				countSelectedPixels(selection, canvas),
				12,
				"all 12 pixels selected",
			);
			check.ok(isPixelSelected(selection, canvas, 0, 0), "top-left is inside");
			check.ok(
				isPixelSelected(selection, canvas, 3, 2),
				"bottom-right is inside",
			);
			check.deepEqual(
				listSelectedPixels(selection, canvas),
				[
					{ x: 0, y: 0 },
					{ x: 1, y: 0 },
					{ x: 2, y: 0 },
					{ x: 3, y: 0 },
					{ x: 0, y: 1 },
					{ x: 1, y: 1 },
					{ x: 2, y: 1 },
					{ x: 3, y: 1 },
					{ x: 0, y: 2 },
					{ x: 1, y: 2 },
					{ x: 2, y: 2 },
					{ x: 3, y: 2 },
				],
				"row-major order",
			);
		},
	},
	{
		name: "rect selection parses and enumerates in row-major order",
		run: (check) => {
			const { canvas } = fresh(4, 4);
			const selection = resolveSelection(canvas, "rect:1,1,2,2");
			check.equal(selection.kind, "rect", "kind is rect");
			check.deepEqual(
				selection.rect,
				{ x: 1, y: 1, width: 2, height: 2 },
				"rect kept verbatim",
			);
			check.ok(isPixelSelected(selection, canvas, 1, 1), "top-left in");
			check.ok(isPixelSelected(selection, canvas, 2, 2), "bottom-right in");
			check.ok(!isPixelSelected(selection, canvas, 0, 0), "outside left");
			check.ok(!isPixelSelected(selection, canvas, 3, 2), "outside right");
			check.ok(!isPixelSelected(selection, canvas, 1, 3), "outside below");
			check.deepEqual(
				listSelectedPixels(selection, canvas),
				[
					{ x: 1, y: 1 },
					{ x: 2, y: 1 },
					{ x: 1, y: 2 },
					{ x: 2, y: 2 },
				],
				"row-major order",
			);
			check.equal(
				countSelectedPixels(selection, canvas),
				4,
				"count matches width x height",
			);
			// A rect covering the full canvas selects exactly as much as all.
			const full = resolveSelection(canvas, "rect:0,0,4,4");
			check.equal(
				countSelectedPixels(full, canvas),
				countSelectedPixels(resolveSelection(canvas, undefined), canvas),
				"full-canvas rect equals whole canvas",
			);
		},
	},
	{
		name: "rect selection rejects non-integer components as INVALID_COORDINATE",
		run: (check) => {
			const { canvas } = fresh(4, 4);
			throwsCode(
				check,
				() => resolveSelection(canvas, "rect:1.5,0,2,2"),
				"INVALID_COORDINATE",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "rect:0,2.5,2,2"),
				"INVALID_COORDINATE",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "rect:0,0,2.5,2"),
				"INVALID_COORDINATE",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "rect:0,0,2,0.5"),
				"INVALID_COORDINATE",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "rect:a,0,2,2"),
				"INVALID_COORDINATE",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "rect:0,0,NaN,2"),
				"INVALID_COORDINATE",
			);
		},
	},
	{
		name: "rect selection rejects width or height below 1 as INVALID_ARGUMENT",
		run: (check) => {
			const { canvas } = fresh(4, 4);
			throwsCode(
				check,
				() => resolveSelection(canvas, "rect:0,0,0,2"),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "rect:0,0,2,0"),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "rect:0,0,-2,2"),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "rect:1,1,2,-1"),
				"INVALID_ARGUMENT",
			);
		},
	},
	{
		name: "rect selection outside the canvas is OUT_OF_BOUNDS without clipping",
		run: (check) => {
			const { canvas, layerId } = fresh(4, 4);
			const before = snapshot(canvas, layerId);
			throwsCode(
				check,
				() => resolveSelection(canvas, "rect:3,3,2,2"),
				"OUT_OF_BOUNDS",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "rect:-1,0,2,2"),
				"OUT_OF_BOUNDS",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "rect:0,-1,2,2"),
				"OUT_OF_BOUNDS",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "rect:0,0,5,4"),
				"OUT_OF_BOUNDS",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "rect:4,0,1,1"),
				"OUT_OF_BOUNDS",
			);
			// A rejected selection must not clip-and-apply: nothing was written.
			check.ok(
				buffersEqual(before, snapshot(canvas, layerId)),
				"failed resolve leaves pixels untouched",
			);
			// The edge-touching rect is legal: x + width may equal the edge.
			const edge = resolveSelection(canvas, "rect:2,2,2,2");
			check.equal(countSelectedPixels(edge, canvas), 4, "edge rect fits");
		},
	},
	{
		name: "malformed selection strings are INVALID_ARGUMENT",
		run: (check) => {
			const { canvas } = fresh(4, 4);
			throwsCode(check, () => resolveSelection(canvas, ""), "INVALID_ARGUMENT");
			throwsCode(
				check,
				() => resolveSelection(canvas, "rect:1,2,3"),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "rect:1,2,3,4,5"),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "rect:"),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "rect:1,,3,4"),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "circle:0,0,2"),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "region:"),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "RECT:0,0,2,2"),
				"INVALID_ARGUMENT",
			);
		},
	},
	{
		name: "region selection follows the stored mask, never color",
		run: (check) => {
			const { canvas, layerId } = fresh(4, 4);
			const region = addRegion(canvas, { id: "blade" });
			setRegionValue(canvas, region.id, 1, 1, 1);
			setRegionValue(canvas, region.id, 2, 2, 1);
			// Paint over the masked pixels: membership must not move with color.
			setPixel(canvas, layerId, 1, 1, { r: 200, g: 100, b: 50, a: 255 });
			setPixel(canvas, layerId, 2, 2, { r: 1, g: 2, b: 3, a: 0 });
			const selection = resolveSelection(canvas, "region:blade");
			check.equal(selection.kind, "region", "kind is region");
			check.equal(selection.regionId, "blade", "region id kept");
			check.ok(isPixelSelected(selection, canvas, 1, 1), "(1,1) inside");
			check.ok(isPixelSelected(selection, canvas, 2, 2), "(2,2) inside");
			check.ok(!isPixelSelected(selection, canvas, 0, 0), "(0,0) outside");
			check.ok(!isPixelSelected(selection, canvas, 1, 2), "(1,2) outside");
			check.deepEqual(
				listSelectedPixels(selection, canvas),
				[
					{ x: 1, y: 1 },
					{ x: 2, y: 2 },
				],
				"mask order is row-major",
			);
			check.equal(countSelectedPixels(selection, canvas), 2, "two cells");
			// An empty mask selects nothing but still resolves.
			const empty = addRegion(canvas, { id: "empty" });
			const emptySelection = resolveSelection(canvas, "region:empty");
			check.equal(
				countSelectedPixels(emptySelection, canvas),
				0,
				"empty mask selects nothing",
			);
			check.deepEqual(
				listSelectedPixels(emptySelection, canvas),
				[],
				"empty list",
			);
			void empty;
		},
	},
	{
		name: "region selection without any region source is INVALID_ARGUMENT",
		run: (check) => {
			// A bare canvas has no regions at all (like a PNG/JPEG/WebP source).
			const { canvas } = fresh(4, 4);
			throwsCode(
				check,
				() => resolveSelection(canvas, "region:blade"),
				"INVALID_ARGUMENT",
			);
		},
	},
	{
		name: "region selection with unknown id is REGION_NOT_FOUND",
		run: (check) => {
			const { canvas } = fresh(4, 4);
			addRegion(canvas, { id: "blade" });
			throwsCode(
				check,
				() => resolveSelection(canvas, "region:guard"),
				"REGION_NOT_FOUND",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "region: blade "),
				"REGION_NOT_FOUND",
			);
		},
	},
	{
		name: "writing through the rect filter leaves outside bytes identical",
		run: (check) => {
			const { canvas, layerId } = fresh(4, 4);
			seedDistinct(canvas, layerId);
			const before = snapshot(canvas, layerId);
			const selection = resolveSelection(canvas, "rect:0,0,2,2");
			forEachSelectedPixel(selection, canvas, (x, y) => {
				setPixel(canvas, layerId, x, y, { ...INK });
			});
			const raw = getLayer(canvas, layerId).pixels;
			for (let y = 0; y < 4; y += 1) {
				for (let x = 0; x < 4; x += 1) {
					const index = (y * 4 + x) * 4;
					const inside = x < 2 && y < 2;
					if (inside) {
						check.ok(
							sameColor(
								{
									r: raw[index] as number,
									g: raw[index + 1] as number,
									b: raw[index + 2] as number,
									a: raw[index + 3] as number,
								},
								INK,
							),
							`inside (${x},${y}) painted`,
						);
					} else {
						check.deepEqual(
							[raw[index], raw[index + 1], raw[index + 2], raw[index + 3]],
							[
								before[index],
								before[index + 1],
								before[index + 2],
								before[index + 3],
							],
							`outside (${x},${y}) byte-identical`,
						);
					}
				}
			}
		},
	},
	{
		name: "writing through the region filter preserves outside hidden RGB",
		run: (check) => {
			const { canvas, layerId } = fresh(4, 4);
			seedDistinct(canvas, layerId);
			const region = addRegion(canvas, { id: "blade" });
			setRegionValue(canvas, region.id, 0, 0, 1);
			setRegionValue(canvas, region.id, 1, 0, 1);
			const before = snapshot(canvas, layerId);
			const maskBefore = region.mask.slice();
			const selection = resolveSelection(canvas, "region:blade");
			for (const point of listSelectedPixels(selection, canvas)) {
				setPixel(canvas, layerId, point.x, point.y, { ...INK });
			}
			const raw = getLayer(canvas, layerId).pixels;
			for (let y = 0; y < 4; y += 1) {
				for (let x = 0; x < 4; x += 1) {
					const index = (y * 4 + x) * 4;
					const inside = y === 0 && (x === 0 || x === 1);
					if (!inside) {
						check.deepEqual(
							[raw[index], raw[index + 1], raw[index + 2], raw[index + 3]],
							[
								before[index],
								before[index + 1],
								before[index + 2],
								before[index + 3],
							],
							`outside (${x},${y}) byte-identical`,
						);
					}
				}
			}
			// The hidden-RGB pixel (3,3) is outside: raw bytes kept verbatim.
			const hidden = (3 * 4 + 3) * 4;
			check.deepEqual(
				[raw[hidden], raw[hidden + 1], raw[hidden + 2], raw[hidden + 3]],
				[17, 34, 51, 0],
				"hidden RGB under A=0 untouched",
			);
			// The region mask itself was never modified by selection use.
			check.ok(
				buffersEqual(maskBefore, region.mask),
				"region mask bits unchanged",
			);
		},
	},
	{
		name: "selection never changes canvas dimensions and is not serialized",
		run: (check) => {
			const { canvas, layerId } = fresh(6, 5);
			addRegion(canvas, { id: "blade" });
			const beforeJson = JSON.stringify(canvas);
			const rectSelection = resolveSelection(canvas, "rect:1,1,2,2");
			const regionSelection = resolveSelection(canvas, "region:blade");
			forEachSelectedPixel(rectSelection, canvas, (x, y) => {
				setPixel(canvas, layerId, x, y, { ...INK });
			});
			forEachSelectedPixel(regionSelection, canvas, (_x, _y) => {});
			check.equal(canvas.width, 6, "width unchanged");
			check.equal(canvas.height, 5, "height unchanged");
			check.ok(!("selection" in canvas), "no selection key on canvas");
			const after = JSON.parse(beforeJson) as Record<string, unknown>;
			check.ok(!("selection" in after), "serialized canvas has no selection");
			check.equal(
				JSON.stringify(canvas).includes('"selection"'),
				false,
				"serialized bytes carry no selection",
			);
		},
	},
	{
		name: "same input resolves to the same selection bytes",
		run: (check) => {
			const first = fresh(8, 8);
			const second = fresh(8, 8);
			for (const target of [first, second]) {
				const region = addRegion(target.canvas, { id: "blade" });
				setRegionValue(target.canvas, region.id, 2, 3, 1);
				setRegionValue(target.canvas, region.id, 5, 5, 1);
			}
			const firstRect = resolveSelection(first.canvas, "rect:1,1,3,2");
			const secondRect = resolveSelection(second.canvas, "rect:1,1,3,2");
			check.deepEqual(firstRect, secondRect, "rect selections match");
			check.deepEqual(
				listSelectedPixels(firstRect, first.canvas),
				listSelectedPixels(secondRect, second.canvas),
				"rect listings match",
			);
			const firstRegion = resolveSelection(first.canvas, "region:blade");
			const secondRegion = resolveSelection(second.canvas, "region:blade");
			check.deepEqual(firstRegion, secondRegion, "region selections match");
			for (const target of [first, second]) {
				const selection = resolveSelection(target.canvas, "rect:1,1,3,2");
				forEachSelectedPixel(selection, target.canvas, (x, y) => {
					setPixel(target.canvas, target.layerId, x, y, { ...INK });
				});
			}
			check.ok(
				buffersEqual(
					snapshot(first.canvas, first.layerId),
					snapshot(second.canvas, second.layerId),
				),
				"same script through selection is byte-identical",
			);
		},
	},
	{
		name: "selection membership checks keep strict coordinate errors",
		run: (check) => {
			const { canvas } = fresh(4, 4);
			const selection = resolveSelection(canvas, "rect:0,0,2,2");
			throwsCode(
				check,
				() => isPixelSelected(selection, canvas, 1.5, 1),
				"INVALID_COORDINATE",
			);
			throwsCode(
				check,
				() => isPixelSelected(selection, canvas, 1, 2.5),
				"INVALID_COORDINATE",
			);
			throwsCode(
				check,
				() => isPixelSelected(selection, canvas, 4, 0),
				"OUT_OF_BOUNDS",
			);
			throwsCode(
				check,
				() => isPixelSelected(selection, canvas, 0, -1),
				"OUT_OF_BOUNDS",
			);
		},
	},
];
