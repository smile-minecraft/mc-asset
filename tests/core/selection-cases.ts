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
	estimateSelectionScratchBytes,
	evaluateSelectionExpr,
	forEachSelectedPixel,
	isPixelSelected,
	listSelectedPixels,
	resolveSelection,
	type SelectionExpr,
	selectionExpressionDepth,
	selectionUsesConnectedQueue,
} from "../../src/core/selection.ts";
import type { PixelCanvas, RGBA } from "../../src/core/types.ts";
import { MEMORY_BUDGET_BYTES } from "../../src/core/validate.ts";
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
		name: "alpha atom selects pixels with nonzero alpha",
		run: (check) => {
			const { canvas, layerId } = fresh(4, 4);
			setPixel(canvas, layerId, 1, 1, { r: 200, g: 100, b: 50, a: 255 });
			setPixel(canvas, layerId, 2, 2, { r: 17, g: 34, b: 51, a: 0 });
			const explicit = resolveSelection(canvas, "alpha:base");
			check.ok(isPixelSelected(explicit, canvas, 1, 1), "opaque in");
			check.ok(
				!isPixelSelected(explicit, canvas, 2, 2),
				"hidden-RGB transparent out",
			);
			check.ok(!isPixelSelected(explicit, canvas, 0, 0), "empty out");
			// Single-layer canvas may omit the layer id.
			const omitted = resolveSelection(canvas, "alpha");
			check.deepEqual(
				listSelectedPixels(omitted, canvas),
				listSelectedPixels(explicit, canvas),
				"omitted id matches explicit id",
			);
		},
	},
	{
		name: "color atom matches exact RGBA with zero tolerance",
		run: (check) => {
			const { canvas, layerId } = fresh(4, 4);
			setPixel(canvas, layerId, 0, 0, { r: 173, g: 183, b: 192, a: 255 });
			setPixel(canvas, layerId, 1, 0, { r: 173, g: 183, b: 192, a: 254 });
			setPixel(canvas, layerId, 2, 0, { r: 17, g: 34, b: 51, a: 0 });
			const selection = resolveSelection(canvas, "color:base:173,183,192,255");
			check.ok(isPixelSelected(selection, canvas, 0, 0), "exact in");
			check.ok(!isPixelSelected(selection, canvas, 1, 0), "one alpha step out");
			check.ok(!isPixelSelected(selection, canvas, 2, 0), "transparent out");
			const omitted = resolveSelection(canvas, "color:173,183,192,255");
			check.equal(
				countSelectedPixels(omitted, canvas),
				1,
				"omitted id matches on a single layer",
			);
		},
	},
	{
		name: "connected atom follows the raw RGBA component",
		run: (check) => {
			const { canvas, layerId } = fresh(4, 4);
			const teal: RGBA = { r: 10, g: 20, b: 30, a: 255 };
			setPixel(canvas, layerId, 0, 0, { ...teal });
			setPixel(canvas, layerId, 1, 0, { ...teal });
			setPixel(canvas, layerId, 0, 1, { r: 11, g: 20, b: 30, a: 255 });
			const selection = resolveSelection(canvas, "connected:base:0,0");
			check.ok(isPixelSelected(selection, canvas, 0, 0), "seed in");
			check.ok(isPixelSelected(selection, canvas, 1, 0), "4-neighbor in");
			check.ok(
				!isPixelSelected(selection, canvas, 0, 1),
				"one channel off is out",
			);
			check.ok(!isPixelSelected(selection, canvas, 3, 3), "far cell out");
			const omitted = resolveSelection(canvas, "connected:0,0");
			check.deepEqual(
				listSelectedPixels(omitted, canvas),
				listSelectedPixels(selection, canvas),
				"omitted id matches explicit id",
			);
		},
	},
	{
		name: "omitted layer id on a multi-layer canvas is INVALID_ARGUMENT",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			addLayer(canvas, { id: "a" });
			addLayer(canvas, { id: "b" });
			throwsCode(
				check,
				() => resolveSelection(canvas, "alpha"),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "color:1,2,3,255"),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "connected:0,0"),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "alpha:nope"),
				"LAYER_NOT_FOUND",
			);
		},
	},
	{
		name: "union AST combines two rects without trimming the dispatch",
		run: (check) => {
			const { canvas } = fresh(4, 4);
			const selection = resolveSelection(
				canvas,
				'{"op":"union","operands":["rect:0,0,2,2","rect:2,2,2,2"]}',
			);
			check.equal(countSelectedPixels(selection, canvas), 8, "union count");
			check.ok(isPixelSelected(selection, canvas, 0, 0), "left part in");
			check.ok(isPixelSelected(selection, canvas, 3, 3), "right part in");
			check.ok(!isPixelSelected(selection, canvas, 3, 0), "gap out");
			// A leading space means the value never enters the AST path.
			throwsCode(
				check,
				() =>
					resolveSelection(
						canvas,
						' {"op":"union","operands":["rect:0,0,2,2","rect:2,2,2,2"]}',
					),
				"INVALID_ARGUMENT",
			);
		},
	},
	{
		name: "intersect subtract and invert follow set semantics",
		run: (check) => {
			const { canvas } = fresh(4, 4);
			const intersect = resolveSelection(
				canvas,
				'{"op":"intersect","operands":["rect:0,0,3,3","rect:1,1,3,3"]}',
			);
			check.equal(countSelectedPixels(intersect, canvas), 4, "overlap is 2x2");
			const subtract = resolveSelection(
				canvas,
				'{"op":"subtract","operands":["rect:0,0,3,3","rect:1,1,2,2"]}',
			);
			check.equal(countSelectedPixels(subtract, canvas), 5, "hole removed");
			check.ok(!isPixelSelected(subtract, canvas, 1, 1), "hole out");
			const invert = resolveSelection(
				canvas,
				'{"op":"invert","operands":["rect:0,0,2,2"]}',
			);
			check.equal(countSelectedPixels(invert, canvas), 12, "rest of canvas");
			check.ok(!isPixelSelected(invert, canvas, 0, 0), "covered out");
			check.ok(isPixelSelected(invert, canvas, 3, 3), "far corner in");
		},
	},
	{
		name: "AST shape and arity errors are INVALID_ARGUMENT with a path",
		run: (check) => {
			const { canvas } = fresh(4, 4);
			for (const raw of [
				'{"op":"union","operands":["rect:0,0,2,2"]}',
				'{"op":"subtract","operands":["rect:0,0,2,2","rect:1,1,1,1","rect:2,2,1,1"]}',
				'{"op":"invert","operands":["rect:0,0,2,2","rect:1,1,1,1"]}',
				'{"op":"xor","operands":["rect:0,0,2,2","rect:1,1,1,1"]}',
				'{"op":"union","operands":"rect:0,0,2,2"}',
				'{"op":"union"}',
				'{"operands":[]}',
				'{"op":"union","operands":[],"extra":1}',
			]) {
				try {
					resolveSelection(canvas, raw);
					check.fail(`expected INVALID_ARGUMENT for ${raw}`);
				} catch (error) {
					if (
						error instanceof McAssetError &&
						error.code === "INVALID_ARGUMENT"
					) {
						const details = error.details as { path?: unknown } | undefined;
						check.ok(
							typeof details?.path === "string",
							`expression path for ${raw}`,
						);
						continue;
					}
					check.fail(
						`expected INVALID_ARGUMENT for ${raw} but got ${error instanceof McAssetError ? error.code : String(error)}`,
					);
				}
			}
			// Broken JSON never reaches the AST validator.
			throwsCode(
				check,
				() => resolveSelection(canvas, '{"op":'),
				"INVALID_ARGUMENT",
			);
		},
	},
	{
		name: "AST past depth 32 or 1024 nodes is RESOURCE_LIMIT_EXCEEDED",
		run: (check) => {
			const { canvas } = fresh(4, 4);
			let deep: unknown = "rect:0,0,1,1";
			for (let i = 0; i < 33; i += 1) {
				deep = { op: "invert", operands: [deep] };
			}
			throwsCode(
				check,
				() => resolveSelection(canvas, JSON.stringify(deep)),
				"RESOURCE_LIMIT_EXCEEDED",
			);
			const wide: unknown[] = [];
			for (let i = 0; i < 1025; i += 1) {
				wide.push("rect:0,0,1,1");
			}
			throwsCode(
				check,
				() =>
					resolveSelection(
						canvas,
						JSON.stringify({ op: "union", operands: wide }),
					),
				"RESOURCE_LIMIT_EXCEEDED",
			);
			// The caps are inclusive: depth 32 and 1024 nodes still evaluate.
			let edge: unknown = "rect:0,0,1,1";
			for (let i = 0; i < 32; i += 1) {
				edge = { op: "invert", operands: [edge] };
			}
			const even = resolveSelection(canvas, JSON.stringify(edge));
			check.equal(
				countSelectedPixels(even, canvas),
				1,
				"depth 32 with even inverts is the identity",
			);
		},
	},
	{
		name: "selection scratch estimator bounds live masks by depth",
		run: (check) => {
			check.equal(estimateSelectionScratchBytes(16, 0), 32, "atom holds two");
			check.equal(
				estimateSelectionScratchBytes(16, 1),
				48,
				"one level holds three",
			);
			check.equal(
				selectionExpressionDepth("rect:0,0,1,1"),
				0,
				"atom depth is zero",
			);
			check.equal(
				selectionExpressionDepth({
					op: "union",
					operands: ["rect:0,0,1,1", "rect:1,1,1,1"],
				}),
				1,
				"one nesting level",
			);
		},
	},
	{
		name: "selection evaluation preflights scratch against an injected budget",
		run: (check) => {
			const { canvas } = fresh(4, 4);
			// 4x4 single layer: 64 bytes resident, 32 bytes of atom scratch.
			throwsCode(
				check,
				() =>
					evaluateSelectionExpr(canvas, "rect:0,0,1,1", "selection", {
						budgetBytes: 95,
					}),
				"RESOURCE_LIMIT_EXCEEDED",
			);
			const exact = evaluateSelectionExpr(canvas, "rect:0,0,1,1", "selection", {
				budgetBytes: 96,
			});
			check.equal(exact.count, 1, "exact budget still evaluates");
			// Wide expressions reduce correctly without retaining one mask
			// per operand.
			const wide: SelectionExpr[] = [];
			for (let i = 0; i < 1000; i += 1) {
				wide.push("rect:0,0,1,1");
			}
			const many = evaluateSelectionExpr(
				canvas,
				{ op: "union", operands: wide },
				"selection",
			);
			check.equal(many.count, 1, "1000-operand union reduces correctly");
			throwsCode(
				check,
				() =>
					evaluateSelectionExpr(canvas, "rect:0,0,1,1", "selection", {
						budgetBytes: -1,
					}),
				"INVALID_ARGUMENT",
			);
		},
	},
	{
		name: "selection budget override can only lower the hard cap",
		run: (check) => {
			const { canvas } = fresh(4, 4);
			throwsCode(
				check,
				() =>
					evaluateSelectionExpr(canvas, "rect:0,0,1,1", "selection", {
						budgetBytes: MEMORY_BUDGET_BYTES + 1,
					}),
				"INVALID_ARGUMENT",
			);
			const capped = evaluateSelectionExpr(
				canvas,
				"rect:0,0,1,1",
				"selection",
				{ budgetBytes: MEMORY_BUDGET_BYTES },
			);
			check.equal(capped.count, 1, "the cap itself still evaluates");
		},
	},
	{
		name: "connected search scratch counts its queue and visited mask",
		run: (check) => {
			const { canvas, layerId } = fresh(4, 4);
			setPixel(canvas, layerId, 0, 0, { r: 9, g: 9, b: 9, a: 255 });
			// 4x4 single layer: 64 bytes resident; connected scratch is one
			// out mask plus visited plus a 4-byte-per-cell index queue.
			const need = 64 + 16 * (0 + 2 + 5);
			throwsCode(
				check,
				() =>
					evaluateSelectionExpr(canvas, "connected:base:0,0", "selection", {
						budgetBytes: need - 1,
					}),
				"RESOURCE_LIMIT_EXCEEDED",
			);
			const exact = evaluateSelectionExpr(
				canvas,
				"connected:base:0,0",
				"selection",
				{ budgetBytes: need },
			);
			check.equal(exact.count, 1, "exact budget still evaluates");
			check.ok(
				selectionUsesConnectedQueue("connected:base:0,0"),
				"connected atom detected",
			);
			check.ok(
				!selectionUsesConnectedQueue({
					op: "union",
					operands: ["rect:0,0,1,1", "alpha:base"],
				}),
				"no queue without connected",
			);
		},
	},
	{
		name: "connected seed outside the canvas is OUT_OF_BOUNDS",
		run: (check) => {
			const { canvas } = fresh(4, 4);
			throwsCode(
				check,
				() => resolveSelection(canvas, "connected:base:4,0"),
				"OUT_OF_BOUNDS",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "connected:base:1.5,0"),
				"INVALID_COORDINATE",
			);
			throwsCode(
				check,
				() => resolveSelection(canvas, "color:base:1,2,3,256"),
				"INVALID_ARGUMENT",
			);
		},
	},
	{
		name: "one expression cannot mix two layer ids",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			addLayer(canvas, { id: "a" });
			addLayer(canvas, { id: "b" });
			throwsCode(
				check,
				() =>
					resolveSelection(
						canvas,
						'{"op":"union","operands":["alpha:a","alpha:b"]}',
					),
				"INVALID_ARGUMENT",
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
