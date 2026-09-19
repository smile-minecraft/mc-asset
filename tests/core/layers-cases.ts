import {
	addLayer,
	addRegion,
	createCanvas,
	getLayer,
	getPixel,
	getRegion,
	setPixel,
	setRegionValue,
} from "../../src/core/canvas.ts";
import { McAssetError } from "../../src/core/errors.ts";
import {
	clearLayer,
	duplicateLayer,
	fillLayer,
	mergeLayer,
	moveLayer,
	removeLayer,
	removeRegion,
	renameLayer,
	renameRegion,
	reorderLayer,
	reorderRegion,
} from "../../src/core/layers.ts";
import type { PixelCanvas, RGBA } from "../../src/core/types.ts";
import type { CaseCheck } from "./model-cases.ts";

export interface LayersCase {
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

const RED: RGBA = { r: 255, g: 0, b: 0, a: 255 };
const BLUE: RGBA = { r: 0, g: 0, b: 255, a: 255 };
const CLEAR: RGBA = { r: 0, g: 0, b: 0, a: 0 };

function layerIds(canvas: PixelCanvas): string[] {
	return canvas.layers.map((layer) => layer.id);
}

function regionIds(canvas: PixelCanvas): string[] {
	return canvas.regions.map((region) => region.id);
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

export const LAYERS_CASES: LayersCase[] = [
	{
		name: "removeLayer drops the layer and keeps bottom-to-top order",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			addLayer(canvas, { id: "a" });
			addLayer(canvas, { id: "b" });
			addLayer(canvas, { id: "c" });
			setPixel(canvas, "c", 3, 3, RED);
			removeLayer(canvas, "b");
			check.deepEqual(layerIds(canvas), ["a", "c"], "b removed, order kept");
			check.deepEqual(
				getPixel(canvas, "c", 3, 3),
				RED,
				"surviving layer pixels intact",
			);
		},
	},
	{
		name: "removeLayer unknown id is LAYER_NOT_FOUND",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			addLayer(canvas, { id: "a" });
			throwsCode(check, () => removeLayer(canvas, "ghost"), "LAYER_NOT_FOUND");
			check.deepEqual(layerIds(canvas), ["a"], "nothing removed");
		},
	},
	{
		name: "removeLayer refuses the last layer",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			addLayer(canvas, { id: "only" });
			throwsCode(check, () => removeLayer(canvas, "only"), "INVALID_ARGUMENT");
			check.deepEqual(layerIds(canvas), ["only"], "last layer kept");
		},
	},
	{
		name: "renameLayer sets the layer name",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			addLayer(canvas, { id: "a", name: "old" });
			addLayer(canvas, { id: "b" });
			renameLayer(canvas, "a", "base");
			check.equal(getLayer(canvas, "a").name, "base", "name updated");
			check.equal(
				getLayer(canvas, "b").name,
				undefined,
				"other layer untouched",
			);
		},
	},
	{
		name: "renameLayer rejects unknown id and empty name",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			addLayer(canvas, { id: "a", name: "kept" });
			throwsCode(
				check,
				() => renameLayer(canvas, "ghost", "x"),
				"LAYER_NOT_FOUND",
			);
			throwsCode(check, () => renameLayer(canvas, "a", ""), "INVALID_ARGUMENT");
			check.equal(getLayer(canvas, "a").name, "kept", "bad rename kept old");
		},
	},
	{
		name: "reorderLayer moves a layer to the top",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			addLayer(canvas, { id: "a" });
			addLayer(canvas, { id: "b" });
			addLayer(canvas, { id: "c" });
			reorderLayer(canvas, "a", 2);
			check.deepEqual(layerIds(canvas), ["b", "c", "a"], "a is now top");
		},
	},
	{
		name: "reorderLayer moves a layer to the bottom",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			addLayer(canvas, { id: "a" });
			addLayer(canvas, { id: "b" });
			addLayer(canvas, { id: "c" });
			reorderLayer(canvas, "c", 0);
			check.deepEqual(layerIds(canvas), ["c", "a", "b"], "c is now bottom");
		},
	},
	{
		name: "reorderLayer to the same index is a no-op",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			addLayer(canvas, { id: "a" });
			addLayer(canvas, { id: "b" });
			reorderLayer(canvas, "a", 0);
			check.deepEqual(layerIds(canvas), ["a", "b"], "order unchanged");
		},
	},
	{
		name: "reorderLayer rejects unknown id and bad index",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			addLayer(canvas, { id: "a" });
			addLayer(canvas, { id: "b" });
			addLayer(canvas, { id: "c" });
			throwsCode(
				check,
				() => reorderLayer(canvas, "ghost", 0),
				"LAYER_NOT_FOUND",
			);
			throwsCode(check, () => reorderLayer(canvas, "a", -1), "OUT_OF_BOUNDS");
			throwsCode(check, () => reorderLayer(canvas, "a", 3), "OUT_OF_BOUNDS");
			throwsCode(
				check,
				() => reorderLayer(canvas, "a", 1.5),
				"INVALID_ARGUMENT",
			);
			check.deepEqual(
				layerIds(canvas),
				["a", "b", "c"],
				"failed reorders change nothing",
			);
		},
	},
	{
		name: "removeRegion drops the region, last region may go",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			addRegion(canvas, { id: "r1" });
			addRegion(canvas, { id: "r2" });
			setRegionValue(canvas, "r2", 1, 1, 1);
			removeRegion(canvas, "r1");
			check.deepEqual(regionIds(canvas), ["r2"], "r1 removed");
			check.equal(
				getRegion(canvas, "r2").mask[1 * 4 + 1],
				1,
				"surviving mask intact",
			);
			removeRegion(canvas, "r2");
			check.deepEqual(regionIds(canvas), [], "regions may reach zero");
		},
	},
	{
		name: "removeRegion unknown id is REGION_NOT_FOUND",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			addRegion(canvas, { id: "r1" });
			throwsCode(
				check,
				() => removeRegion(canvas, "ghost"),
				"REGION_NOT_FOUND",
			);
			check.deepEqual(regionIds(canvas), ["r1"], "nothing removed");
		},
	},
	{
		name: "renameRegion sets the region name",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			addRegion(canvas, { id: "blade" });
			renameRegion(canvas, "blade", "edge");
			check.equal(getRegion(canvas, "blade").name, "edge", "name updated");
			throwsCode(
				check,
				() => renameRegion(canvas, "ghost", "x"),
				"REGION_NOT_FOUND",
			);
			throwsCode(
				check,
				() => renameRegion(canvas, "blade", ""),
				"INVALID_ARGUMENT",
			);
			check.equal(
				getRegion(canvas, "blade").name,
				"edge",
				"bad rename kept old",
			);
		},
	},
	{
		name: "reorderRegion changes region order",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			addRegion(canvas, { id: "r1" });
			addRegion(canvas, { id: "r2" });
			addRegion(canvas, { id: "r3" });
			reorderRegion(canvas, "r1", 2);
			check.deepEqual(regionIds(canvas), ["r2", "r3", "r1"], "r1 moved to end");
			throwsCode(
				check,
				() => reorderRegion(canvas, "ghost", 0),
				"REGION_NOT_FOUND",
			);
			throwsCode(check, () => reorderRegion(canvas, "r2", 3), "OUT_OF_BOUNDS");
			check.deepEqual(
				regionIds(canvas),
				["r2", "r3", "r1"],
				"failed reorder changes nothing",
			);
		},
	},
	{
		name: "regions may overlap without interference",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			addRegion(canvas, { id: "r1" });
			addRegion(canvas, { id: "r2" });
			setRegionValue(canvas, "r1", 2, 2, 1);
			setRegionValue(canvas, "r2", 2, 2, 1);
			check.equal(
				getRegion(canvas, "r1").mask[2 * 4 + 2],
				1,
				"r1 keeps the shared cell",
			);
			check.equal(
				getRegion(canvas, "r2").mask[2 * 4 + 2],
				1,
				"r2 keeps the shared cell",
			);
		},
	},
	{
		name: "duplicateLayer copies pixels into an independent buffer",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			addLayer(canvas, { id: "src" });
			setPixel(canvas, "src", 0, 0, RED);
			const copy = duplicateLayer(canvas, "src");
			check.ok(copy.id !== "src", "new id assigned");
			check.ok(
				copy.pixels !== getLayer(canvas, "src").pixels,
				"no shared buffer",
			);
			check.deepEqual(
				[...copy.pixels],
				[...getLayer(canvas, "src").pixels],
				"pixels equal at copy time",
			);
			setPixel(canvas, copy.id, 0, 0, BLUE);
			check.deepEqual(
				getPixel(canvas, "src", 0, 0),
				RED,
				"editing the copy leaves the source alone",
			);
			setPixel(canvas, "src", 1, 1, RED);
			check.deepEqual(
				getPixel(canvas, copy.id, 1, 1),
				CLEAR,
				"editing the source leaves the copy alone",
			);
		},
	},
	{
		name: "duplicateLayer deep-copies metadata and keeps layer flags",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			addLayer(canvas, {
				id: "src",
				name: "Base",
				opacity: 0.5,
				visible: false,
				metadata: { tag: "v1" },
			});
			const copy = duplicateLayer(canvas, "src");
			check.equal(copy.name, "Base", "name inherited");
			check.equal(copy.opacity, 0.5, "opacity inherited");
			check.equal(copy.visible, false, "visibility inherited");
			check.deepEqual(copy.metadata, { tag: "v1" }, "metadata copied");
			const named = duplicateLayer(canvas, "src", { name: "Copy" });
			check.equal(named.name, "Copy", "explicit name wins");
			(copy.metadata as Record<string, unknown>).tag = "evil";
			check.equal(
				getLayer(canvas, "src").metadata?.tag,
				"v1",
				"source metadata unaffected",
			);
		},
	},
	{
		name: "duplicateLayer sits directly above the source",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			addLayer(canvas, { id: "a" });
			addLayer(canvas, { id: "b" });
			const copyB = duplicateLayer(canvas, "b");
			check.deepEqual(
				layerIds(canvas),
				["a", "b", copyB.id],
				"copy of top lands on top",
			);
			const copyA = duplicateLayer(canvas, "a");
			check.deepEqual(
				layerIds(canvas),
				["a", copyA.id, "b", copyB.id],
				"copy of bottom lands just above it",
			);
		},
	},
	{
		name: "duplicateLayer honors explicit id and rejects collisions",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			addLayer(canvas, { id: "src" });
			const copy = duplicateLayer(canvas, "src", { id: "copy" });
			check.equal(copy.id, "copy", "explicit id used");
			throwsCode(
				check,
				() => duplicateLayer(canvas, "src", { id: "copy" }),
				"DUPLICATE_LAYER_ID",
			);
			check.equal(canvas.layers.length, 2, "failed copy adds nothing");
		},
	},
	{
		name: "duplicateLayer auto id never collides",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			addLayer(canvas, { id: "src" });
			const first = duplicateLayer(canvas, "src");
			const second = duplicateLayer(canvas, "src");
			check.ok(
				first.id !== "src" && second.id !== "src" && first.id !== second.id,
				`distinct auto ids (${first.id}, ${second.id})`,
			);
		},
	},
	{
		name: "duplicateLayer at 64 layers fails before allocation",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			for (let i = 0; i < 64; i += 1) {
				addLayer(canvas, { id: `layer-${i}` });
			}
			throwsCode(
				check,
				() => duplicateLayer(canvas, "layer-0"),
				"RESOURCE_LIMIT_EXCEEDED",
			);
			check.equal(canvas.layers.length, 64, "no layer appended on failure");
		},
	},
	{
		name: "mergeLayer composites top-over-bottom and removes the source",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			addLayer(canvas, { id: "bottom" });
			addLayer(canvas, { id: "top" });
			fillLayer(canvas, "bottom", "#FF0000");
			fillLayer(canvas, "top", "#0000FF");
			mergeLayer(canvas, "top", "bottom");
			check.deepEqual(layerIds(canvas), ["bottom"], "source removed");
			check.deepEqual(
				getPixel(canvas, "bottom", 0, 0),
				{ r: 0, g: 0, b: 255, a: 255 },
				"opaque top wins",
			);
			throwsCode(check, () => getLayer(canvas, "top"), "LAYER_NOT_FOUND");
		},
	},
	{
		name: "mergeLayer order golden: half green over opaque red",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			addLayer(canvas, { id: "bottom" });
			addLayer(canvas, { id: "top" });
			fillLayer(canvas, "bottom", "#FF0000");
			fillLayer(canvas, "top", "#00FF0080");
			mergeLayer(canvas, "top", "bottom");
			check.deepEqual(
				getPixel(canvas, "bottom", 0, 0),
				{ r: 127, g: 128, b: 0, a: 255 },
				"src-over golden at (0,0)",
			);
			check.deepEqual(
				getPixel(canvas, "bottom", 1, 1),
				{ r: 127, g: 128, b: 0, a: 255 },
				"src-over golden at (1,1)",
			);
		},
	},
	{
		name: "mergeLayer with source below target still composites top-over-bottom",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			addLayer(canvas, { id: "bottom" });
			addLayer(canvas, { id: "top" });
			fillLayer(canvas, "bottom", "#0000FF80");
			fillLayer(canvas, "top", "#FF000080");
			mergeLayer(canvas, "bottom", "top");
			check.deepEqual(layerIds(canvas), ["top"], "lower source removed");
			check.deepEqual(
				getPixel(canvas, "top", 0, 0),
				{ r: 170, g: 0, b: 85, a: 192 },
				"semi-over-semi golden",
			);
		},
	},
	{
		name: "mergeLayer keeps hidden RGB when both pixels are transparent",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			addLayer(canvas, { id: "bottom" });
			addLayer(canvas, { id: "top" });
			setPixel(canvas, "top", 0, 0, { r: 9, g: 9, b: 9, a: 0 });
			mergeLayer(canvas, "top", "bottom");
			check.deepEqual(
				getPixel(canvas, "bottom", 0, 0),
				{ r: 9, g: 9, b: 9, a: 0 },
				"topmost hidden RGB kept verbatim",
			);
		},
	},
	{
		name: "mergeLayer with itself is INVALID_ARGUMENT",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			addLayer(canvas, { id: "a" });
			addLayer(canvas, { id: "b" });
			setPixel(canvas, "a", 0, 0, RED);
			throwsCode(check, () => mergeLayer(canvas, "a", "a"), "INVALID_ARGUMENT");
			check.deepEqual(layerIds(canvas), ["a", "b"], "no layer removed");
			check.deepEqual(getPixel(canvas, "a", 0, 0), RED, "no pixels composited");
		},
	},
	{
		name: "mergeLayer unknown ids are LAYER_NOT_FOUND",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			addLayer(canvas, { id: "a" });
			throwsCode(
				check,
				() => mergeLayer(canvas, "ghost", "a"),
				"LAYER_NOT_FOUND",
			);
			throwsCode(
				check,
				() => mergeLayer(canvas, "a", "ghost"),
				"LAYER_NOT_FOUND",
			);
			check.deepEqual(layerIds(canvas), ["a"], "nothing merged");
		},
	},
	{
		name: "clearLayer resets every pixel to transparent black",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			addLayer(canvas, { id: "a" });
			addLayer(canvas, { id: "b" });
			setPixel(canvas, "a", 0, 0, RED);
			setPixel(canvas, "a", 1, 1, { r: 9, g: 9, b: 9, a: 0 });
			setPixel(canvas, "b", 0, 0, BLUE);
			clearLayer(canvas, "a");
			check.ok(
				buffersEqual(snapshot(canvas, "a"), new Uint8Array(2 * 2 * 4)),
				"whole layer zeroed",
			);
			check.deepEqual(
				getPixel(canvas, "b", 0, 0),
				BLUE,
				"other layer untouched",
			);
		},
	},
	{
		name: "fillLayer transparent clears the layer",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			addLayer(canvas, { id: "a" });
			setPixel(canvas, "a", 0, 0, RED);
			fillLayer(canvas, "a", "transparent");
			check.ok(
				buffersEqual(snapshot(canvas, "a"), new Uint8Array(2 * 2 * 4)),
				"transparent fill zeroes the layer",
			);
		},
	},
	{
		name: "fillLayer #RRGGBB fills opaque",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			addLayer(canvas, { id: "a" });
			fillLayer(canvas, "a", "#FF0000");
			check.deepEqual(getPixel(canvas, "a", 0, 0), RED, "(0,0)");
			check.deepEqual(getPixel(canvas, "a", 1, 1), RED, "(1,1)");
			fillLayer(canvas, "a", "#ff0000");
			check.deepEqual(
				getPixel(canvas, "a", 0, 0),
				RED,
				"lowercase hex accepted",
			);
		},
	},
	{
		name: "fillLayer #RRGGBBAA keeps alpha",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			addLayer(canvas, { id: "a" });
			fillLayer(canvas, "a", "#00FF0080");
			check.deepEqual(
				getPixel(canvas, "a", 1, 0),
				{ r: 0, g: 255, b: 0, a: 128 },
				"alpha channel kept",
			);
		},
	},
	{
		name: "fillLayer rejects bad color strings without writes",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			addLayer(canvas, { id: "a" });
			const before = snapshot(canvas, "a");
			const bad = [
				"red",
				"",
				"#FFF",
				"#12345",
				"#GGGGGG",
				" #FF0000",
				"#FF00000",
			];
			for (const text of bad) {
				throwsCode(check, () => fillLayer(canvas, "a", text), "INVALID_COLOR");
			}
			throwsCode(
				check,
				() => fillLayer(canvas, "a", 123 as unknown as string),
				"INVALID_COLOR",
			);
			throwsCode(
				check,
				() => fillLayer(canvas, "ghost", "#FF0000"),
				"LAYER_NOT_FOUND",
			);
			check.ok(
				buffersEqual(before, snapshot(canvas, "a")),
				"failed fills change nothing",
			);
		},
	},
	{
		name: "moveLayer shifts content and vacates with transparent",
		run: (check) => {
			const canvas = createCanvas(3, 3);
			addLayer(canvas, { id: "a" });
			setPixel(canvas, "a", 0, 1, RED);
			moveLayer(canvas, "a", 1, 0);
			check.deepEqual(
				getPixel(canvas, "a", 1, 1),
				RED,
				"content arrives at (1,1)",
			);
			check.deepEqual(
				getPixel(canvas, "a", 0, 1),
				CLEAR,
				"vacated cell is transparent black",
			);
			check.deepEqual(getPixel(canvas, "a", 2, 2), CLEAR, "far cell untouched");
		},
	},
	{
		name: "moveLayer zero shift is a no-op",
		run: (check) => {
			const canvas = createCanvas(3, 3);
			addLayer(canvas, { id: "a" });
			setPixel(canvas, "a", 1, 1, RED);
			const before = snapshot(canvas, "a");
			moveLayer(canvas, "a", 0, 0);
			check.ok(buffersEqual(before, snapshot(canvas, "a")), "bytes identical");
		},
	},
	{
		name: "moveLayer rejects content leaving the canvas without partial writes",
		run: (check) => {
			const canvas = createCanvas(3, 3);
			addLayer(canvas, { id: "a" });
			setPixel(canvas, "a", 2, 1, RED);
			setPixel(canvas, "a", 0, 0, BLUE);
			const before = snapshot(canvas, "a");
			throwsCode(check, () => moveLayer(canvas, "a", 1, 0), "OUT_OF_BOUNDS");
			throwsCode(check, () => moveLayer(canvas, "a", 0, -1), "OUT_OF_BOUNDS");
			check.ok(
				buffersEqual(before, snapshot(canvas, "a")),
				"failed move writes nothing",
			);
		},
	},
	{
		name: "moveLayer rejects hidden RGB leaving the canvas without partial writes",
		run: (check) => {
			const canvas = createCanvas(3, 3);
			addLayer(canvas, { id: "a" });
			setPixel(canvas, "a", 2, 2, { r: 9, g: 9, b: 9, a: 0 });
			const before = snapshot(canvas, "a");
			throwsCode(check, () => moveLayer(canvas, "a", 1, 0), "OUT_OF_BOUNDS");
			throwsCode(check, () => moveLayer(canvas, "a", 0, 1), "OUT_OF_BOUNDS");
			check.ok(
				buffersEqual(before, snapshot(canvas, "a")),
				"failed move writes nothing",
			);
		},
	},
	{
		name: "moveLayer carries hidden RGB verbatim within bounds",
		run: (check) => {
			const canvas = createCanvas(3, 3);
			addLayer(canvas, { id: "a" });
			setPixel(canvas, "a", 1, 1, { r: 9, g: 9, b: 9, a: 0 });
			moveLayer(canvas, "a", 1, 0);
			check.deepEqual(
				getPixel(canvas, "a", 2, 1),
				{ r: 9, g: 9, b: 9, a: 0 },
				"hidden RGB arrives verbatim",
			);
			check.deepEqual(
				getPixel(canvas, "a", 1, 1),
				CLEAR,
				"vacated cell is transparent black",
			);
		},
	},
	{
		name: "moveLayer lets empty margins leave freely",
		run: (check) => {
			const canvas = createCanvas(3, 3);
			addLayer(canvas, { id: "empty" });
			moveLayer(canvas, "empty", 2, 2);
			check.ok(
				buffersEqual(snapshot(canvas, "empty"), new Uint8Array(3 * 3 * 4)),
				"empty layer shifts without error",
			);
			addLayer(canvas, { id: "center" });
			setPixel(canvas, "center", 1, 1, RED);
			moveLayer(canvas, "center", 1, 1);
			check.deepEqual(
				getPixel(canvas, "center", 2, 2),
				RED,
				"center content lands at (2,2)",
			);
		},
	},
	{
		name: "moveLayer rejects non-integer shifts and unknown ids",
		run: (check) => {
			const canvas = createCanvas(3, 3);
			addLayer(canvas, { id: "a" });
			throwsCode(
				check,
				() => moveLayer(canvas, "a", 0.5, 0),
				"INVALID_COORDINATE",
			);
			throwsCode(
				check,
				() => moveLayer(canvas, "a", 0, 1.5),
				"INVALID_COORDINATE",
			);
			throwsCode(
				check,
				() => moveLayer(canvas, "ghost", 1, 0),
				"LAYER_NOT_FOUND",
			);
		},
	},
	{
		name: "same layer script twice is byte-identical",
		run: (check) => {
			const build = (): PixelCanvas => {
				const canvas = createCanvas(4, 4);
				addLayer(canvas, { id: "base" });
				fillLayer(canvas, "base", "#11223344");
				const copy = duplicateLayer(canvas, "base");
				clearLayer(canvas, copy.id);
				setPixel(canvas, copy.id, 1, 1, BLUE);
				moveLayer(canvas, copy.id, 1, 1);
				fillLayer(canvas, "base", "#FF0000");
				mergeLayer(canvas, copy.id, "base");
				clearLayer(canvas, "base");
				fillLayer(canvas, "base", "#00FF00");
				renameLayer(canvas, "base", "final");
				reorderLayer(canvas, "base", 0);
				return canvas;
			};
			const first = build();
			const second = build();
			check.ok(
				buffersEqual(snapshot(first, "base"), snapshot(second, "base")),
				"two runs produce identical bytes",
			);
		},
	},
];
