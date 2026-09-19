import { addLayer, createCanvas, setPixel } from "../../src/core/canvas.ts";
import {
	ALPHA_AFFECTING_CLASSES,
	CLEANUP_CLASSES,
	type CleanupClass,
	type CleanupPixel,
	detectAA,
	detectCleanup,
	detectCluster,
	detectFringe,
	detectHole,
	detectIsolated,
	detectNoise,
	detectOutlier,
	fixCleanup,
} from "../../src/core/cleanup.ts";
import { McAssetError } from "../../src/core/errors.ts";
import type { PixelCanvas, RGBA } from "../../src/core/types.ts";
import type { CaseCheck } from "./model-cases.ts";

export interface CleanupCase {
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
const PART_RED: RGBA = { r: 255, g: 0, b: 0, a: 128 };
const PART_BLUE: RGBA = { r: 0, g: 0, b: 255, a: 128 };
const OUTLIER_RED: RGBA = { r: 200, g: 30, b: 30, a: 255 };

const PALETTE: RGBA[] = [INK, WALL];

function fresh(
	width: number,
	height: number,
	id = "base",
): { canvas: PixelCanvas; layerId: string } {
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id });
	return { canvas, layerId: layer.id };
}

function fill(
	canvas: PixelCanvas,
	layerId: string,
	width: number,
	height: number,
	color: RGBA,
): void {
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			setPixel(canvas, layerId, x, y, { ...color });
		}
	}
}

function snapshot(canvas: PixelCanvas, layerId: string): Uint8Array {
	const layer = canvas.layers.find((entry) => entry.id === layerId);
	if (layer === undefined) {
		throw new Error(`missing layer ${layerId}`);
	}
	return layer.pixels.slice();
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

function alphaAt(
	canvas: PixelCanvas,
	layerId: string,
	width: number,
	x: number,
	y: number,
): number | undefined {
	const layer = canvas.layers.find((entry) => entry.id === layerId);
	return layer?.pixels[(y * width + x) * 4 + 3];
}

function rgbaAt(
	canvas: PixelCanvas,
	layerId: string,
	width: number,
	x: number,
	y: number,
): number[] | undefined {
	const layer = canvas.layers.find((entry) => entry.id === layerId);
	if (layer === undefined) {
		return undefined;
	}
	const offset = (y * width + x) * 4;
	return [
		layer.pixels[offset],
		layer.pixels[offset + 1],
		layer.pixels[offset + 2],
		layer.pixels[offset + 3],
	];
}

function countDiff(a: Uint8Array, b: Uint8Array): number {
	let pixels = 0;
	for (let i = 0; i < a.length; i += 4) {
		if (
			a[i] !== b[i] ||
			a[i + 1] !== b[i + 1] ||
			a[i + 2] !== b[i + 2] ||
			a[i + 3] !== b[i + 3]
		) {
			pixels += 1;
		}
	}
	return pixels;
}

function keys(pixels: CleanupPixel[]): string[] {
	return pixels.map((pixel) => `${pixel.x},${pixel.y}`);
}

/** Combined 8x8 golden: one defect of every class, positions disjoint. */
function combined(): { canvas: PixelCanvas; layerId: string } {
	const { canvas, layerId } = fresh(8, 8);
	for (let y = 5; y < 8; y += 1) {
		for (let x = 0; x < 8; x += 1) {
			setPixel(canvas, layerId, x, y, { ...WALL });
		}
	}
	setPixel(canvas, layerId, 1, 1, { ...INK });
	setPixel(canvas, layerId, 4, 1, { ...INK });
	setPixel(canvas, layerId, 5, 1, { ...INK });
	setPixel(canvas, layerId, 4, 2, { ...INK });
	setPixel(canvas, layerId, 5, 2, { ...INK });
	setPixel(canvas, layerId, 3, 6, { ...INK });
	setPixel(canvas, layerId, 1, 5, { ...OUTLIER_RED });
	setPixel(canvas, layerId, 1, 6, { ...CLEAR });
	setPixel(canvas, layerId, 6, 6, { ...PART_RED });
	setPixel(canvas, layerId, 6, 4, { ...PART_BLUE });
	return { canvas, layerId };
}

export const CLEANUP_CASES: CleanupCase[] = [
	{
		name: "class identifiers are frozen for flags and JSON",
		run: (check) => {
			check.deepEqual(
				[...CLEANUP_CLASSES],
				["isolated", "noise", "cluster", "fringe", "outlier", "hole", "aa"],
				"seven classes in fixed order",
			);
			check.deepEqual(
				[...ALPHA_AFFECTING_CLASSES].sort(),
				["aa", "cluster", "fringe", "hole", "isolated", "noise"],
				"everything except outlier needs render-pass authorization",
			);
		},
	},
	{
		name: "isolated golden: lone opaque pixel is flagged",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			setPixel(canvas, layerId, 2, 2, { ...INK });
			check.deepEqual(
				keys(detectIsolated(canvas, layerId)),
				["2,2"],
				"lone pixel",
			);
		},
	},
	{
		name: "isolated negative: pixel with an opaque neighbor is kept",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			setPixel(canvas, layerId, 2, 2, { ...INK });
			setPixel(canvas, layerId, 2, 3, { ...INK });
			check.deepEqual(
				keys(detectIsolated(canvas, layerId)),
				[],
				"paired pixels",
			);
		},
	},
	{
		name: "isolated fix clears the pixel with authorization",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			setPixel(canvas, layerId, 2, 2, { ...INK });
			const result = fixCleanup(canvas, layerId, {
				fix: ["isolated"],
				allowRenderPassChange: true,
			});
			check.equal(result.fixed.isolated, 1, "one pixel fixed");
			check.equal(result.modifiedPixels, 1, "one pixel changed");
			const layer = canvas.layers.find((entry) => entry.id === layerId);
			check.deepEqual(
				[layer?.pixels[(2 * 5 + 2) * 4], layer?.pixels[(2 * 5 + 2) * 4 + 3]],
				[0, 0],
				"cleared to transparent",
			);
		},
	},
	{
		name: "noise golden: single spike in a uniform field is flagged",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			fill(canvas, layerId, 5, 5, INK);
			setPixel(canvas, layerId, 2, 2, { ...WALL });
			check.deepEqual(keys(detectNoise(canvas, layerId)), ["2,2"], "spike");
		},
	},
	{
		name: "noise negative: uniform field and border spikes are kept",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			fill(canvas, layerId, 5, 5, INK);
			check.deepEqual(keys(detectNoise(canvas, layerId)), [], "uniform field");
			setPixel(canvas, layerId, 0, 0, { ...WALL });
			check.deepEqual(
				keys(detectNoise(canvas, layerId)),
				[],
				"border pixel needs a full neighborhood",
			);
		},
	},
	{
		name: "noise fix copies the surrounding color with authorization",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			fill(canvas, layerId, 5, 5, INK);
			setPixel(canvas, layerId, 2, 2, { ...WALL });
			const result = fixCleanup(canvas, layerId, {
				fix: ["noise"],
				allowRenderPassChange: true,
			});
			check.equal(result.fixed.noise, 1, "one pixel fixed");
			const layer = canvas.layers.find((entry) => entry.id === layerId);
			check.deepEqual(
				[
					layer?.pixels[(2 * 5 + 2) * 4],
					layer?.pixels[(2 * 5 + 2) * 4 + 1],
					layer?.pixels[(2 * 5 + 2) * 4 + 2],
					layer?.pixels[(2 * 5 + 2) * 4 + 3],
				],
				[255, 0, 0, 255],
				"spike takes the field color",
			);
		},
	},
	{
		name: "cluster golden: 2x2 speckle on transparency is flagged",
		run: (check) => {
			const { canvas, layerId } = fresh(6, 6);
			setPixel(canvas, layerId, 2, 2, { ...INK });
			setPixel(canvas, layerId, 3, 2, { ...INK });
			setPixel(canvas, layerId, 2, 3, { ...INK });
			setPixel(canvas, layerId, 3, 3, { ...INK });
			check.deepEqual(
				keys(detectCluster(canvas, layerId)),
				["2,2", "3,2", "2,3", "3,3"],
				"row-major order",
			);
		},
	},
	{
		name: "cluster negative: large fill and lone pixels are kept",
		run: (check) => {
			const { canvas, layerId } = fresh(6, 6);
			fill(canvas, layerId, 6, 6, INK);
			check.deepEqual(keys(detectCluster(canvas, layerId)), [], "large fill");
			const single = fresh(6, 6);
			setPixel(single.canvas, single.layerId, 1, 1, { ...INK });
			check.deepEqual(
				keys(detectCluster(single.canvas, single.layerId)),
				[],
				"single pixel is not a cluster",
			);
		},
	},
	{
		name: "cluster fix clears the speckle with authorization",
		run: (check) => {
			const { canvas, layerId } = fresh(6, 6);
			setPixel(canvas, layerId, 2, 2, { ...INK });
			setPixel(canvas, layerId, 3, 2, { ...INK });
			const result = fixCleanup(canvas, layerId, {
				fix: ["cluster"],
				allowRenderPassChange: true,
			});
			check.equal(result.fixed.cluster, 2, "two pixels fixed");
			check.equal(result.modifiedPixels, 2, "two pixels changed");
		},
	},
	{
		name: "fringe golden: partial pixel inside solid fill is flagged",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			fill(canvas, layerId, 5, 5, INK);
			setPixel(canvas, layerId, 2, 2, { ...PART_RED });
			check.deepEqual(keys(detectFringe(canvas, layerId)), ["2,2"], "fringe");
		},
	},
	{
		name: "fringe negative: boundary partial is aa, not fringe",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			fill(canvas, layerId, 5, 5, INK);
			setPixel(canvas, layerId, 0, 2, { ...PART_RED });
			setPixel(canvas, layerId, 0, 1, { ...CLEAR });
			setPixel(canvas, layerId, 0, 3, { ...CLEAR });
			check.deepEqual(
				keys(detectFringe(canvas, layerId)),
				[],
				"partial touching transparency is not fringe",
			);
			check.deepEqual(
				keys(detectAA(canvas, layerId)).includes("0,2"),
				true,
				"it is aa instead",
			);
		},
	},
	{
		name: "fringe fix snaps alpha to opaque, keeps RGB",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			fill(canvas, layerId, 5, 5, INK);
			setPixel(canvas, layerId, 2, 2, { ...PART_RED });
			const result = fixCleanup(canvas, layerId, {
				fix: ["fringe"],
				allowRenderPassChange: true,
			});
			check.equal(result.fixed.fringe, 1, "one pixel fixed");
			const layer = canvas.layers.find((entry) => entry.id === layerId);
			check.deepEqual(
				[
					layer?.pixels[(2 * 5 + 2) * 4],
					layer?.pixels[(2 * 5 + 2) * 4 + 1],
					layer?.pixels[(2 * 5 + 2) * 4 + 2],
					layer?.pixels[(2 * 5 + 2) * 4 + 3],
				],
				[255, 0, 0, 255],
				"alpha snapped, RGB kept",
			);
		},
	},
	{
		name: "outlier golden: color outside the palette is flagged",
		run: (check) => {
			const { canvas, layerId } = fresh(4, 4);
			fill(canvas, layerId, 4, 4, WALL);
			setPixel(canvas, layerId, 1, 1, { ...OUTLIER_RED });
			check.deepEqual(
				keys(detectOutlier(canvas, layerId, { palette: PALETTE })),
				["1,1"],
				"off-palette pixel",
			);
		},
	},
	{
		name: "outlier negative: palette members and hidden RGB are kept",
		run: (check) => {
			const { canvas, layerId } = fresh(4, 4);
			fill(canvas, layerId, 4, 4, WALL);
			setPixel(canvas, layerId, 1, 1, { ...INK });
			setPixel(canvas, layerId, 2, 2, { r: 9, g: 9, b: 9, a: 0 });
			check.deepEqual(
				keys(detectOutlier(canvas, layerId, { palette: PALETTE })),
				[],
				"palette color and transparent hidden RGB are not outliers",
			);
		},
	},
	{
		name: "outlier fix needs no authorization and keeps alpha",
		run: (check) => {
			const { canvas, layerId } = fresh(4, 4);
			fill(canvas, layerId, 4, 4, WALL);
			setPixel(canvas, layerId, 1, 1, { ...OUTLIER_RED });
			const before = snapshot(canvas, layerId);
			const result = fixCleanup(canvas, layerId, {
				fix: ["outlier"],
				palette: PALETTE,
			});
			check.equal(result.detected.outlier, 1, "one detected");
			check.equal(result.fixed.outlier, 1, "one fixed without auth flag");
			check.equal(result.modifiedPixels, 1, "one pixel changed");
			const layer = canvas.layers.find((entry) => entry.id === layerId);
			check.deepEqual(
				[
					layer?.pixels[(1 * 4 + 1) * 4],
					layer?.pixels[(1 * 4 + 1) * 4 + 1],
					layer?.pixels[(1 * 4 + 1) * 4 + 2],
					layer?.pixels[(1 * 4 + 1) * 4 + 3],
				],
				[255, 0, 0, 255],
				"nearest palette color wins, alpha untouched",
			);
			check.equal(
				countDiff(before, snapshot(canvas, layerId)),
				result.modifiedPixels,
				"stat matches the actual diff",
			);
		},
	},
	{
		name: "outlier fix keeps partial alpha intact",
		run: (check) => {
			const { canvas, layerId } = fresh(4, 4);
			fill(canvas, layerId, 4, 4, WALL);
			setPixel(canvas, layerId, 1, 1, { r: 200, g: 30, b: 30, a: 128 });
			fixCleanup(canvas, layerId, { fix: ["outlier"], palette: PALETTE });
			const layer = canvas.layers.find((entry) => entry.id === layerId);
			check.equal(
				layer?.pixels[(1 * 4 + 1) * 4 + 3],
				128,
				"alpha channel is never touched by outlier fix",
			);
		},
	},
	{
		name: "outlier without a palette detects nothing and changes nothing",
		run: (check) => {
			const { canvas, layerId } = fresh(4, 4);
			fill(canvas, layerId, 4, 4, WALL);
			setPixel(canvas, layerId, 1, 1, { ...OUTLIER_RED });
			const before = snapshot(canvas, layerId);
			check.deepEqual(
				keys(detectOutlier(canvas, layerId)),
				[],
				"no reference set means no outliers",
			);
			const result = fixCleanup(canvas, layerId, { fix: ["outlier"] });
			check.equal(result.fixed.outlier, 0, "nothing fixed");
			check.ok(
				buffersEqual(before, snapshot(canvas, layerId)),
				"zero bytes changed",
			);
		},
	},
	{
		name: "outlier falls back to the canvas palette",
		run: (check) => {
			const canvas = createCanvas(4, 4, {
				palette: {
					entries: [
						{ id: "ink", color: { ...INK } },
						{ id: "wall", color: { ...WALL } },
					],
				},
			});
			const layer = addLayer(canvas, { id: "base" });
			fill(canvas, layer.id, 4, 4, WALL);
			setPixel(canvas, layer.id, 1, 1, { ...OUTLIER_RED });
			check.deepEqual(
				keys(detectOutlier(canvas, layer.id)),
				["1,1"],
				"canvas palette is the fallback reference",
			);
		},
	},
	{
		name: "hole golden: enclosed transparent pixel is flagged",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			fill(canvas, layerId, 5, 5, INK);
			setPixel(canvas, layerId, 2, 2, { ...CLEAR });
			check.deepEqual(keys(detectHole(canvas, layerId)), ["2,2"], "hole");
		},
	},
	{
		name: "hole negative: border and open transparency are kept",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			fill(canvas, layerId, 5, 5, INK);
			setPixel(canvas, layerId, 0, 0, { ...CLEAR });
			setPixel(canvas, layerId, 2, 2, { ...CLEAR });
			setPixel(canvas, layerId, 2, 3, { ...CLEAR });
			check.deepEqual(
				keys(detectHole(canvas, layerId)),
				[],
				"border pixel and 2px opening are not tiny holes",
			);
		},
	},
	{
		name: "hole fix fills from the opaque neighbors",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			fill(canvas, layerId, 5, 5, INK);
			setPixel(canvas, layerId, 2, 2, { ...CLEAR });
			const result = fixCleanup(canvas, layerId, {
				fix: ["hole"],
				allowRenderPassChange: true,
			});
			check.equal(result.fixed.hole, 1, "one pixel fixed");
			const layer = canvas.layers.find((entry) => entry.id === layerId);
			check.deepEqual(
				[
					layer?.pixels[(2 * 5 + 2) * 4],
					layer?.pixels[(2 * 5 + 2) * 4 + 1],
					layer?.pixels[(2 * 5 + 2) * 4 + 2],
					layer?.pixels[(2 * 5 + 2) * 4 + 3],
				],
				[255, 0, 0, 255],
				"hole takes the neighbor color",
			);
		},
	},
	{
		name: "aa golden: partial pixel between opaque and clear is flagged",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			for (let y = 0; y < 5; y += 1) {
				for (let x = 0; x < 2; x += 1) {
					setPixel(canvas, layerId, x, y, { ...INK });
				}
				setPixel(canvas, layerId, 2, y, { ...PART_RED });
			}
			check.deepEqual(
				keys(detectAA(canvas, layerId)).includes("2,2"),
				true,
				"staircase pixel",
			);
		},
	},
	{
		name: "aa negative: interior partial is fringe, open partial is kept",
		run: (check) => {
			const { canvas, layerId } = fresh(5, 5);
			fill(canvas, layerId, 5, 5, INK);
			setPixel(canvas, layerId, 2, 2, { ...PART_RED });
			setPixel(canvas, layerId, 4, 4, { ...PART_RED });
			setPixel(canvas, layerId, 4, 3, { ...CLEAR });
			setPixel(canvas, layerId, 3, 4, { ...CLEAR });
			setPixel(canvas, layerId, 4, 4 - 1, { ...CLEAR });
			check.deepEqual(
				keys(detectAA(canvas, layerId)).includes("2,2"),
				false,
				"surrounded partial is fringe, not aa",
			);
		},
	},
	{
		name: "aa fix snaps to the majority side, ties favor opaque",
		run: (check) => {
			const opaque = fresh(5, 5);
			for (let y = 0; y < 5; y += 1) {
				for (let x = 0; x < 2; x += 1) {
					setPixel(opaque.canvas, opaque.layerId, x, y, { ...INK });
				}
				setPixel(opaque.canvas, opaque.layerId, 2, y, { ...PART_RED });
			}
			fixCleanup(opaque.canvas, opaque.layerId, {
				fix: ["aa"],
				allowRenderPassChange: true,
			});
			const top = opaque.canvas.layers.find(
				(entry) => entry.id === opaque.layerId,
			);
			check.equal(
				top?.pixels[(2 * 5 + 2) * 4 + 3],
				255,
				"1-opaque vs 1-transparent tie goes opaque",
			);
			const clear = fresh(5, 5);
			setPixel(clear.canvas, clear.layerId, 1, 2, { ...INK });
			setPixel(clear.canvas, clear.layerId, 2, 2, { ...PART_BLUE });
			fixCleanup(clear.canvas, clear.layerId, {
				fix: ["aa"],
				allowRenderPassChange: true,
			});
			const bottom = clear.canvas.layers.find(
				(entry) => entry.id === clear.layerId,
			);
			check.deepEqual(
				[
					bottom?.pixels[(2 * 5 + 2) * 4],
					bottom?.pixels[(2 * 5 + 2) * 4 + 1],
					bottom?.pixels[(2 * 5 + 2) * 4 + 2],
					bottom?.pixels[(2 * 5 + 2) * 4 + 3],
				],
				[0, 0, 255, 0],
				"transparent side keeps RGB, only alpha drops",
			);
		},
	},
	{
		name: "aa fix at x=0 does not fold back to the previous row's last pixel",
		run: (check) => {
			// 2x3, row-major. The partial at (0,1) has one in-bounds opaque
			// neighbor (up) and two in-bounds clear neighbors (right, down), so
			// the correct fix drops alpha. An unguarded left read would hit
			// (1,0), the previous row's last pixel, and flip the result opaque.
			const { canvas, layerId } = fresh(2, 3);
			setPixel(canvas, layerId, 0, 0, { ...INK });
			setPixel(canvas, layerId, 1, 0, { ...INK });
			setPixel(canvas, layerId, 0, 1, { ...PART_RED });
			setPixel(canvas, layerId, 1, 1, { ...CLEAR });
			setPixel(canvas, layerId, 0, 2, { ...CLEAR });
			setPixel(canvas, layerId, 1, 2, { ...CLEAR });
			check.deepEqual(
				keys(detectAA(canvas, layerId)),
				["0,1"],
				"boundary partial is aa",
			);
			const result = fixCleanup(canvas, layerId, {
				fix: ["aa"],
				allowRenderPassChange: true,
			});
			check.equal(result.fixed.aa, 1, "one pixel fixed");
			check.deepEqual(
				rgbaAt(canvas, layerId, 2, 0, 1),
				[255, 0, 0, 0],
				"clear side wins, RGB kept, alpha dropped",
			);
			check.deepEqual(
				rgbaAt(canvas, layerId, 2, 1, 0),
				[255, 0, 0, 255],
				"the wrap target (1,0) is untouched",
			);
		},
	},
	{
		name: "aa fix at x=width-1 does not fold back to the next row's first pixel",
		run: (check) => {
			// 2x3. The partial at (1,1) has one in-bounds opaque neighbor (left)
			// and two clear neighbors (up, down): alpha must drop. An unguarded
			// right read would hit (0,2), the next row's first pixel, and snap
			// alpha to opaque.
			const { canvas, layerId } = fresh(2, 3);
			setPixel(canvas, layerId, 0, 1, { ...INK });
			setPixel(canvas, layerId, 1, 1, { ...PART_RED });
			setPixel(canvas, layerId, 1, 0, { ...CLEAR });
			setPixel(canvas, layerId, 1, 2, { ...CLEAR });
			setPixel(canvas, layerId, 0, 2, { ...INK });
			check.deepEqual(
				keys(detectAA(canvas, layerId)),
				["1,1"],
				"boundary partial is aa",
			);
			const result = fixCleanup(canvas, layerId, {
				fix: ["aa"],
				allowRenderPassChange: true,
			});
			check.equal(result.fixed.aa, 1, "one pixel fixed");
			check.deepEqual(
				rgbaAt(canvas, layerId, 2, 1, 1),
				[255, 0, 0, 0],
				"clear side wins, RGB kept, alpha dropped",
			);
			check.deepEqual(
				rgbaAt(canvas, layerId, 2, 0, 2),
				[255, 0, 0, 255],
				"the wrap target (0,2) is untouched",
			);
		},
	},
	{
		name: "aa fix at y edges uses only in-bounds neighbors",
		run: (check) => {
			// Single row: the partial counts left opaque and right clear only.
			// The out-of-bounds top/bottom neighbors must contribute nothing.
			const row = fresh(3, 1);
			setPixel(row.canvas, row.layerId, 0, 0, { ...INK });
			setPixel(row.canvas, row.layerId, 1, 0, { ...PART_RED });
			setPixel(row.canvas, row.layerId, 2, 0, { ...CLEAR });
			check.deepEqual(
				keys(detectAA(row.canvas, row.layerId)),
				["1,0"],
				"edge partial is aa",
			);
			fixCleanup(row.canvas, row.layerId, {
				fix: ["aa"],
				allowRenderPassChange: true,
			});
			check.equal(
				alphaAt(row.canvas, row.layerId, 3, 1, 0),
				255,
				"1 opaque vs 1 clear tie goes opaque",
			);
			// Bottom row of a taller canvas: same tally, no read past the buffer.
			const bottom = fresh(3, 2);
			setPixel(bottom.canvas, bottom.layerId, 0, 1, { ...INK });
			setPixel(bottom.canvas, bottom.layerId, 1, 1, { ...PART_RED });
			setPixel(bottom.canvas, bottom.layerId, 2, 1, { ...CLEAR });
			setPixel(bottom.canvas, bottom.layerId, 1, 0, { ...CLEAR });
			check.deepEqual(
				keys(detectAA(bottom.canvas, bottom.layerId)),
				["1,1"],
				"height-1 partial is aa",
			);
			fixCleanup(bottom.canvas, bottom.layerId, {
				fix: ["aa"],
				allowRenderPassChange: true,
			});
			check.equal(
				alphaAt(bottom.canvas, bottom.layerId, 3, 1, 1),
				0,
				"2 clear vs 1 opaque drops alpha",
			);
		},
	},
	{
		name: "detect-only leaves every byte untouched",
		run: (check) => {
			const { canvas, layerId } = combined();
			const before = snapshot(canvas, layerId);
			detectCleanup(canvas, layerId, { palette: PALETTE });
			check.ok(
				buffersEqual(before, snapshot(canvas, layerId)),
				"detect writes nothing",
			);
			const result = fixCleanup(canvas, layerId, { fix: [], palette: PALETTE });
			check.ok(
				buffersEqual(before, snapshot(canvas, layerId)),
				"empty fix writes nothing",
			);
			check.equal(result.modifiedPixels, 0, "no modifications reported");
			for (const name of CLEANUP_CLASSES) {
				check.equal(result.fixed[name], 0, `fixed.${name} is zero`);
			}
		},
	},
	{
		name: "alpha classes without authorization are rejected with zero writes",
		run: (check) => {
			for (const name of ALPHA_AFFECTING_CLASSES) {
				const { canvas, layerId } = combined();
				const before = snapshot(canvas, layerId);
				throwsCode(
					check,
					() => fixCleanup(canvas, layerId, { fix: [name], palette: PALETTE }),
					"INVALID_ARGUMENT",
				);
				check.ok(
					buffersEqual(before, snapshot(canvas, layerId)),
					`${name} writes nothing when rejected`,
				);
			}
		},
	},
	{
		name: "mixed outlier plus alpha class is rejected atomically",
		run: (check) => {
			const { canvas, layerId } = combined();
			const before = snapshot(canvas, layerId);
			throwsCode(
				check,
				() =>
					fixCleanup(canvas, layerId, {
						fix: ["outlier", "isolated"],
						palette: PALETTE,
					}),
				"INVALID_ARGUMENT",
			);
			check.ok(
				buffersEqual(before, snapshot(canvas, layerId)),
				"even the authorized outlier is not applied",
			);
		},
	},
	{
		name: "unknown class is INVALID_ARGUMENT with the bad name in details",
		run: (check) => {
			const { canvas, layerId } = fresh(4, 4);
			const before = snapshot(canvas, layerId);
			try {
				fixCleanup(canvas, layerId, {
					fix: ["sparkle"] as unknown as CleanupClass[],
				});
			} catch (error) {
				if (
					error instanceof McAssetError &&
					error.code === "INVALID_ARGUMENT"
				) {
					const details = error.details as { class?: unknown };
					check.equal(details.class, "sparkle", "details carry the bad name");
					check.ok(
						buffersEqual(before, snapshot(canvas, layerId)),
						"zero writes on bad class",
					);
					return;
				}
				check.fail(`wrong error: ${String(error)}`);
			}
			check.fail("expected INVALID_ARGUMENT for an unknown class");
		},
	},
	{
		name: "combined golden: stats match the actual diff",
		run: (check) => {
			const { canvas, layerId } = combined();
			const before = snapshot(canvas, layerId);
			const result = fixCleanup(canvas, layerId, {
				fix: [...CLEANUP_CLASSES],
				allowRenderPassChange: true,
				palette: PALETTE,
			});
			check.deepEqual(
				{ ...result.detected },
				{
					isolated: 1,
					noise: 1,
					cluster: 4,
					fringe: 1,
					outlier: 1,
					hole: 1,
					aa: 1,
				},
				"per-class detection counts",
			);
			check.deepEqual(
				{ ...result.fixed },
				{
					isolated: 1,
					noise: 1,
					cluster: 4,
					fringe: 1,
					outlier: 1,
					hole: 1,
					aa: 1,
				},
				"per-class fix counts",
			);
			check.equal(result.modifiedPixels, 10, "ten distinct pixels changed");
			check.equal(
				countDiff(before, snapshot(canvas, layerId)),
				result.modifiedPixels,
				"stat matches the actual diff",
			);
			check.deepEqual(
				keys(
					detectCleanup(canvas, layerId, { palette: PALETTE }).positions
						.isolated,
				),
				[],
				"second pass finds nothing left",
			);
		},
	},
	{
		name: "same input twice gives identical bytes and stats",
		run: (check) => {
			const first = combined();
			const second = combined();
			const left = fixCleanup(first.canvas, first.layerId, {
				fix: [...CLEANUP_CLASSES],
				allowRenderPassChange: true,
				palette: PALETTE,
			});
			const right = fixCleanup(second.canvas, second.layerId, {
				fix: [...CLEANUP_CLASSES],
				allowRenderPassChange: true,
				palette: PALETTE,
			});
			check.deepEqual(left, right, "stats are identical");
			check.ok(
				buffersEqual(
					snapshot(first.canvas, first.layerId),
					snapshot(second.canvas, second.layerId),
				),
				"bytes are identical",
			);
		},
	},
];
