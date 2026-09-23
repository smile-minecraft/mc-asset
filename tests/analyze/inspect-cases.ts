import {
	buildFeedback,
	type DiffSummary,
	diffCanvases,
	type InspectLayerEntry,
	type InspectRegionEntry,
	inspectStructure,
	normalizeFeedbackRequest,
	normalizeSelectionInput,
	renderInspectView,
	resolveFeedbackScale,
	snapshotCanvas,
} from "../../src/analyze/inspect.ts";
import { applyOperations, type BatchOperation } from "../../src/core/batch.ts";
import {
	addLayer,
	addRegion,
	createCanvas,
	setPixel,
	setRegionValue,
} from "../../src/core/canvas.ts";
import { McAssetError } from "../../src/core/errors.ts";
import type { PixelCanvas, RGBA } from "../../src/core/types.ts";
import { decodePng, flattenCanvas } from "../../src/io/png.ts";

export interface CaseCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
}

export interface InspectCase {
	name: string;
	run(check: CaseCheck): void;
}

function red(): RGBA {
	return { r: 255, g: 0, b: 0, a: 255 };
}

function clear(): RGBA {
	return { r: 0, g: 0, b: 0, a: 0 };
}

function codeOf(fn: () => void): string {
	try {
		fn();
	} catch (error) {
		if (error instanceof McAssetError) {
			return error.code;
		}
		throw error;
	}
	return "NO_THROW";
}

function pngSignature(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	);
}

function fillCanvas(
	width: number,
	height: number,
	color: RGBA,
	layerId = "base",
): PixelCanvas {
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: layerId });
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			setPixel(canvas, layer.id, x, y, color);
		}
	}
	return canvas;
}

export const INSPECT_CASES: InspectCase[] = [
	{
		name: "structure: single opaque pixel reports exact bounds area and color usage",
		run: (check) => {
			const canvas = fillCanvas(4, 4, clear());
			setPixel(canvas, "base", 1, 2, red());
			const report = inspectStructure(canvas);
			check.equal(report.mode, "structure");
			check.equal(report.width, 4);
			check.equal(report.height, 4);
			check.equal(report.layers.length, 1);
			const layer = report.layers[0] as InspectLayerEntry;
			check.equal(layer.id, "base");
			check.equal(layer.name, "base");
			check.equal(layer.index, 0);
			check.deepEqual(layer.bounds, { x: 1, y: 2, width: 1, height: 1 });
			check.equal(layer.area, 1);
			check.equal(layer.visible, true);
			check.equal(layer.opacity, 1);
			check.equal(layer.blendMode, "normal");
			check.deepEqual(layer.colorUsage, {
				uniqueColors: 2,
				transparentPixels: 15,
				topColors: [
					{ rgba: "#00000000", count: 15 },
					{ rgba: "#FF0000FF", count: 1 },
				],
				truncated: false,
			});
			check.deepEqual(report.regions, []);
			check.deepEqual(report.overlaps, { layerBounds: [], regionPixels: [] });
		},
	},
	{
		name: "structure: hidden alpha-zero RGB counts as distinct colors",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			addLayer(canvas, { id: "base" });
			setPixel(canvas, "base", 0, 0, red());
			setPixel(canvas, "base", 1, 0, { r: 10, g: 20, b: 30, a: 0 });
			const report = inspectStructure(canvas);
			const layer = report.layers[0] as InspectLayerEntry;
			check.deepEqual(layer.bounds, { x: 0, y: 0, width: 1, height: 1 });
			check.equal(layer.area, 1);
			const usage = layer.colorUsage as {
				uniqueColors: number;
				transparentPixels: number;
				topColors: Array<{ rgba: string; count: number }>;
				truncated: boolean;
			};
			check.equal(usage.uniqueColors, 3);
			check.equal(usage.transparentPixels, 3);
			check.equal(usage.truncated, false);
			// Count descending, ties broken by RGBA lexicographic order.
			check.deepEqual(usage.topColors, [
				{ rgba: "#00000000", count: 2 },
				{ rgba: "#0A141E00", count: 1 },
				{ rgba: "#FF0000FF", count: 1 },
			]);
		},
	},
	{
		name: "structure: top colors truncate stably at sixteen",
		run: (check) => {
			const canvas = createCanvas(5, 5);
			addLayer(canvas, { id: "base" });
			for (let i = 0; i < 25; i += 1) {
				setPixel(canvas, "base", i % 5, (i - (i % 5)) / 5, {
					r: i,
					g: 0,
					b: 0,
					a: 255,
				});
			}
			const report = inspectStructure(canvas);
			const usage = (report.layers[0] as InspectLayerEntry)
				.colorUsage as unknown as {
				uniqueColors: number;
				transparentPixels: number;
				topColors: Array<{ rgba: string; count: number }>;
				truncated: boolean;
			};
			check.equal(usage.uniqueColors, 25);
			check.equal(usage.transparentPixels, 0);
			check.equal(usage.topColors.length, 16);
			check.equal(usage.truncated, true);
			check.deepEqual(usage.topColors[0], { rgba: "#000000FF", count: 1 });
			check.deepEqual(usage.topColors[15], { rgba: "#0F0000FF", count: 1 });
		},
	},
	{
		name: "structure: regions carry only identity bounds and area",
		run: (check) => {
			const canvas = fillCanvas(4, 4, clear());
			addRegion(canvas, { id: "r1", name: "First" });
			for (let y = 1; y < 3; y += 1) {
				for (let x = 1; x < 3; x += 1) {
					setRegionValue(canvas, "r1", x, y, 1);
				}
			}
			const report = inspectStructure(canvas);
			check.equal(report.regions.length, 1);
			const region = report.regions[0] as InspectRegionEntry;
			check.deepEqual(Object.keys(region).sort(), [
				"area",
				"bounds",
				"id",
				"index",
				"name",
			]);
			check.equal(region.id, "r1");
			check.equal(region.name, "First");
			check.equal(region.index, 0);
			check.deepEqual(region.bounds, { x: 1, y: 1, width: 2, height: 2 });
			check.equal(region.area, 4);
		},
	},
	{
		name: "structure: overlaps separate box hits from pixel hits",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			addLayer(canvas, { id: "a" });
			addLayer(canvas, { id: "b" });
			setPixel(canvas, "a", 0, 0, red());
			setPixel(canvas, "a", 3, 3, red());
			setPixel(canvas, "b", 1, 1, red());
			addRegion(canvas, { id: "r1" });
			addRegion(canvas, { id: "r2" });
			addRegion(canvas, { id: "r3" });
			setRegionValue(canvas, "r1", 0, 0, 1);
			setRegionValue(canvas, "r2", 0, 0, 1);
			setRegionValue(canvas, "r2", 3, 3, 1);
			setRegionValue(canvas, "r3", 2, 2, 1);
			const report = inspectStructure(canvas);
			// Layer A bounds cover the whole canvas, so the boxes overlap
			// even though no alpha pixels touch.
			check.deepEqual(report.overlaps.layerBounds, [
				{ layerIds: ["a", "b"], bounds: { x: 1, y: 1, width: 1, height: 1 } },
			]);
			// Only region pairs with a real mask intersection are listed.
			check.deepEqual(report.overlaps.regionPixels, [
				{ regionIds: ["r1", "r2"], pixelCount: 1 },
			]);
		},
	},
	{
		name: "structure: empty layer and empty region report null bounds with zero area",
		run: (check) => {
			const canvas = fillCanvas(3, 2, clear());
			addRegion(canvas, { id: "empty" });
			const report = inspectStructure(canvas);
			const layer = report.layers[0] as InspectLayerEntry;
			check.equal(layer.bounds, null);
			check.equal(layer.area, 0);
			const usage = layer.colorUsage as {
				uniqueColors: number;
				transparentPixels: number;
				topColors: Array<{ rgba: string; count: number }>;
				truncated: boolean;
			};
			check.equal(usage.uniqueColors, 1);
			check.equal(usage.transparentPixels, 6);
			check.deepEqual(usage.topColors, [{ rgba: "#00000000", count: 6 }]);
			check.equal(usage.truncated, false);
			const region = report.regions[0] as InspectRegionEntry;
			check.equal(region.bounds, null);
			check.equal(region.area, 0);
		},
	},
	{
		name: "view: default scale is 1 even for small canvases",
		run: (check) => {
			const canvas = fillCanvas(16, 16, {
				r: 173,
				g: 183,
				b: 192,
				a: 255,
			});
			const view = renderInspectView(canvas, {});
			check.deepEqual(view.metadata, {
				mode: "view",
				sourceDimensions: { width: 16, height: 16 },
				crop: { x: 0, y: 0, width: 16, height: 16 },
				scale: 1,
				outputDimensions: { width: 16, height: 16 },
				colorFormat: "RGBA8",
			});
			const decoded = decodePng(view.pngBytes).canvas;
			check.equal(decoded.width, 16);
			check.equal(decoded.height, 16);
		},
	},
	{
		name: "view: full render carries six metadata keys with pixel parity",
		run: (check) => {
			const canvas = createCanvas(2, 2);
			addLayer(canvas, { id: "base" });
			setPixel(canvas, "base", 0, 0, red());
			setPixel(canvas, "base", 1, 0, { r: 0, g: 255, b: 0, a: 255 });
			setPixel(canvas, "base", 0, 1, { r: 0, g: 0, b: 255, a: 0 });
			setPixel(canvas, "base", 1, 1, { r: 255, g: 255, b: 255, a: 128 });
			const view = renderInspectView(canvas, {});
			check.deepEqual(view.metadata, {
				mode: "view",
				sourceDimensions: { width: 2, height: 2 },
				crop: { x: 0, y: 0, width: 2, height: 2 },
				scale: 1,
				outputDimensions: { width: 2, height: 2 },
				colorFormat: "RGBA8",
			});
			check.ok(pngSignature(view.pngBytes), "view bytes carry PNG signature");
			const decoded = decodePng(view.pngBytes).canvas;
			check.equal(decoded.width, 2);
			check.equal(decoded.height, 2);
			const flat = flattenCanvas(canvas);
			const back = flattenCanvas(decoded);
			// Default scale 1: decoded pixels equal the composited source.
			for (let y = 0; y < 2; y += 1) {
				for (let x = 0; x < 2; x += 1) {
					for (let c = 0; c < 4; c += 1) {
						check.equal(
							back[(y * 2 + x) * 4 + c],
							flat[(y * 2 + x) * 4 + c],
							`pixel ${x},${y} channel ${c}`,
						);
					}
				}
			}
		},
	},
	{
		name: "view: crop and explicit scale replicate nearest pixels",
		run: (check) => {
			const canvas = fillCanvas(4, 4, clear());
			setPixel(canvas, "base", 1, 1, red());
			const view = renderInspectView(canvas, {
				crop: "rect:0,0,2,2",
				scale: 2,
			});
			check.deepEqual(view.metadata.crop, { x: 0, y: 0, width: 2, height: 2 });
			check.equal(view.metadata.scale, 2);
			check.deepEqual(view.metadata.outputDimensions, { width: 4, height: 4 });
			const decoded = decodePng(view.pngBytes).canvas;
			const back = flattenCanvas(decoded);
			const at = (x: number, y: number): number[] => [
				back[(y * 4 + x) * 4] as number,
				back[(y * 4 + x) * 4 + 1] as number,
				back[(y * 4 + x) * 4 + 2] as number,
				back[(y * 4 + x) * 4 + 3] as number,
			];
			check.deepEqual(at(2, 2), [255, 0, 0, 255]);
			check.deepEqual(at(3, 3), [255, 0, 0, 255]);
			check.deepEqual(at(0, 0), [0, 0, 0, 0]);
			check.deepEqual(at(1, 0), [0, 0, 0, 0]);
		},
	},
	{
		name: "feedback auto-scale resolves from the pre-scale long edge",
		run: (check) => {
			check.equal(resolveFeedbackScale(16, 16, undefined), 8);
			check.equal(resolveFeedbackScale(200, 200, undefined), 1);
			check.equal(resolveFeedbackScale(128, 100, undefined), 1);
			check.equal(resolveFeedbackScale(512, 512, undefined), 1);
			check.equal(resolveFeedbackScale(600, 10, undefined), 1);
			check.equal(resolveFeedbackScale(4, 4, undefined), 16);
			check.equal(resolveFeedbackScale(16, 16, 3), 3);
			// Non-square crops scale from the long edge: 64 -> 2.
			check.equal(resolveFeedbackScale(4, 64, undefined), 2);
			check.equal(resolveFeedbackScale(64, 4, undefined), 2);
		},
	},
	{
		name: "view: empty crop refuses with EMPTY_SELECTION",
		run: (check) => {
			const canvas = fillCanvas(4, 4, red());
			check.equal(
				codeOf(() => {
					renderInspectView(canvas, { crop: "color:base:1,2,3,4" });
				}),
				"EMPTY_SELECTION",
			);
		},
	},
	{
		name: "view: output edge beyond 1024 refuses with a crop hint",
		run: (check) => {
			const wide = fillCanvas(1100, 10, red());
			let message = "";
			try {
				renderInspectView(wide, {});
				check.fail("expected RESOURCE_LIMIT_EXCEEDED");
			} catch (error) {
				if (!(error instanceof McAssetError)) {
					throw error;
				}
				check.equal(error.code, "RESOURCE_LIMIT_EXCEEDED");
				message = error.message;
			}
			check.ok(
				message.toLowerCase().includes("crop"),
				"rejection tells the agent to use a crop",
			);
			const canvas = fillCanvas(100, 100, red());
			check.equal(
				codeOf(() => {
					renderInspectView(canvas, { scale: 16 });
				}),
				"RESOURCE_LIMIT_EXCEEDED",
			);
		},
	},
	{
		name: "view: scale outside 1-16 is INVALID_ARGUMENT",
		run: (check) => {
			const canvas = fillCanvas(4, 4, red());
			for (const scale of [0, 17, 1.5, Number.NaN]) {
				check.equal(
					codeOf(() => {
						renderInspectView(canvas, { scale });
					}),
					"INVALID_ARGUMENT",
				);
			}
		},
	},
	{
		name: "view: decoded pixels equal the cropped source with no guide overlay",
		run: (check) => {
			const canvas = createCanvas(3, 2);
			addLayer(canvas, { id: "base" });
			const colors: RGBA[] = [
				{ r: 10, g: 20, b: 30, a: 255 },
				{ r: 40, g: 50, b: 60, a: 255 },
				{ r: 70, g: 80, b: 90, a: 0 },
				{ r: 100, g: 110, b: 120, a: 255 },
				{ r: 130, g: 140, b: 150, a: 255 },
				{ r: 160, g: 170, b: 180, a: 255 },
			];
			for (let i = 0; i < 6; i += 1) {
				const color = colors[i] as RGBA;
				setPixel(canvas, "base", i % 3, (i - (i % 3)) / 3, color);
			}
			const view = renderInspectView(canvas, { scale: 2 });
			check.deepEqual(view.metadata.outputDimensions, { width: 6, height: 4 });
			const back = flattenCanvas(decodePng(view.pngBytes).canvas);
			const flat = flattenCanvas(canvas);
			for (let y = 0; y < 4; y += 1) {
				for (let x = 0; x < 6; x += 1) {
					const sx = (x - (x % 2)) / 2;
					const sy = (y - (y % 2)) / 2;
					for (let c = 0; c < 4; c += 1) {
						check.equal(
							back[(y * 6 + x) * 4 + c],
							flat[(sy * 3 + sx) * 4 + c],
							`pixel ${x},${y} channel ${c} carries no guide paint`,
						);
					}
				}
			}
		},
	},
	{
		name: "selection input: JSON strings parse and garbage refuses",
		run: (check) => {
			const parsed = normalizeSelectionInput(
				'{"op":"union","operands":["rect:0,0,2,2","rect:1,1,2,2"]}',
				"crop",
			);
			check.deepEqual(parsed, {
				op: "union",
				operands: ["rect:0,0,2,2", "rect:1,1,2,2"],
			});
			check.equal(normalizeSelectionInput(undefined, "crop"), undefined);
			check.equal(
				normalizeSelectionInput("rect:0,0,2,2", "crop"),
				"rect:0,0,2,2",
			);
			check.equal(
				codeOf(() => {
					normalizeSelectionInput(42, "crop");
				}),
				"INVALID_ARGUMENT",
			);
			check.equal(
				codeOf(() => {
					normalizeSelectionInput('{"op":"nope","operands":[]}', "crop");
				}),
				"INVALID_ARGUMENT",
			);
		},
	},
	{
		name: "diff: raw counts hidden RGB drift with tight bounds",
		run: (check) => {
			const before = fillCanvas(3, 3, clear());
			setPixel(before, "base", 1, 1, red());
			const after = snapshotCanvas(before);
			const layer = after.layers[0] as { pixels: Uint8Array };
			// Hidden drift under alpha zero: only the raw channels move.
			layer.pixels[(2 * 3 + 2) * 4] = 5;
			layer.pixels[(2 * 3 + 2) * 4 + 1] = 6;
			layer.pixels[(2 * 3 + 2) * 4 + 2] = 7;
			const summary = diffCanvases(before, after, []);
			check.equal(summary.raw.changedPixels, 1);
			check.deepEqual(summary.raw.bounds, { x: 2, y: 2, width: 1, height: 1 });
			check.equal(summary.outsideSelectionUnchanged, true);
			check.deepEqual(summary.structural, {
				added: [],
				removed: [],
				modified: [],
			});
		},
	},
	{
		name: "diff: hidden layer changes stay out of the composited view",
		run: (check) => {
			const before = createCanvas(2, 2);
			addLayer(before, { id: "bottom" });
			addLayer(before, { id: "top" });
			for (let y = 0; y < 2; y += 1) {
				for (let x = 0; x < 2; x += 1) {
					setPixel(before, "bottom", x, y, { r: 0, g: 0, b: 255, a: 255 });
					setPixel(before, "top", x, y, red());
				}
			}
			const after = snapshotCanvas(before);
			setPixel(after, "bottom", 0, 0, { r: 0, g: 255, b: 0, a: 255 });
			const summary = diffCanvases(before, after, []);
			check.equal(summary.raw.changedPixels, 1);
			check.deepEqual(summary.raw.bounds, { x: 0, y: 0, width: 1, height: 1 });
			check.equal(summary.composited.changedPixels, 0);
			check.equal(summary.composited.bounds, null);
			// Pixel edits alone are not structural changes.
			check.deepEqual(summary.structural, {
				added: [],
				removed: [],
				modified: [],
			});
		},
	},
	{
		name: "diff: structural paths cover add remove and modify",
		run: (check) => {
			const before = fillCanvas(2, 2, red());
			addRegion(before, { id: "gone" });
			setRegionValue(before, "gone", 0, 0, 1);
			const after = snapshotCanvas(before);
			addLayer(after, { id: "extra" });
			const kept = after.layers[0] as { name?: string };
			kept.name = "Renamed";
			after.regions.length = 0;
			after.palette = {
				entries: [{ id: "a", color: { r: 1, g: 2, b: 3, a: 255 } }],
			};
			after.metadata = { note: "v2" };
			const summary = diffCanvases(before, after, []);
			check.deepEqual(summary.structural, {
				added: ["/layers/extra", "/palette"],
				removed: ["/regions/gone"],
				modified: ["/layers/base", "/metadata"],
			});
		},
	},
	{
		name: "diff: outside scope stays true for scoped writes and trips on hidden drift",
		run: (check) => {
			const paint: BatchOperation[] = [
				{
					type: "fillRect",
					layerId: "base",
					rect: { x: 0, y: 0, width: 2, height: 2 },
					color: { r: 255, g: 0, b: 0, a: 255 },
					selection: "rect:0,0,2,2",
				},
			];
			const before = fillCanvas(4, 4, clear());
			const scoped = snapshotCanvas(before);
			applyOperations(scoped, paint, { atomic: true });
			const scopedSummary = diffCanvases(before, scoped, paint);
			check.equal(scopedSummary.outsideSelectionUnchanged, true);
			check.equal(scopedSummary.raw.changedPixels, 4);
			// An unscoped write covers the whole layer, so its outside is
			// an empty domain and the check stays true.
			const unscoped: BatchOperation[] = [
				{
					type: "fillRect",
					layerId: "base",
					rect: { x: 0, y: 0, width: 4, height: 4 },
					color: { r: 255, g: 0, b: 0, a: 255 },
				},
			];
			const full = snapshotCanvas(before);
			applyOperations(full, unscoped, { atomic: true });
			check.equal(
				diffCanvases(before, full, unscoped).outsideSelectionUnchanged,
				true,
			);
			// Drift outside the declared scope trips the check, even when
			// only hidden RGB under alpha zero moves.
			const drifted = snapshotCanvas(scoped);
			setPixel(drifted, "base", 3, 3, { r: 255, g: 0, b: 0, a: 255 });
			check.equal(
				diffCanvases(before, drifted, paint).outsideSelectionUnchanged,
				false,
			);
			const hidden = snapshotCanvas(scoped);
			setPixel(hidden, "base", 3, 3, { r: 9, g: 9, b: 9, a: 0 });
			const hiddenSummary = diffCanvases(before, hidden, paint);
			check.equal(hiddenSummary.outsideSelectionUnchanged, false);
			check.equal(hiddenSummary.raw.changedPixels, 5);
		},
	},
	{
		name: "diff: clearPixel under a pre-existing alpha selection keeps outside true",
		run: (check) => {
			const before = fillCanvas(2, 2, clear());
			setPixel(before, "base", 0, 0, red());
			const ops: BatchOperation[] = [
				{
					type: "clearPixel",
					layerId: "base",
					x: 0,
					y: 0,
					selection: "alpha:base",
				},
			];
			const after = snapshotCanvas(before);
			applyOperations(after, ops, { atomic: true });
			const summary = diffCanvases(before, after, ops);
			check.equal(summary.raw.changedPixels, 1);
			// The cleared pixel belonged to the pre-write alpha mask, even
			// though the after canvas no longer selects it.
			check.equal(summary.outsideSelectionUnchanged, true);
		},
	},
	{
		name: "diff: sequential content-dependent selections use operation-time state",
		run: (check) => {
			const before = fillCanvas(4, 4, clear());
			setPixel(before, "base", 0, 0, red());
			setPixel(before, "base", 1, 1, red());
			const ops: BatchOperation[] = [
				{
					type: "clearPixel",
					layerId: "base",
					x: 0,
					y: 0,
					selection: "alpha:base",
				},
				{
					type: "setPixel",
					layerId: "base",
					x: 1,
					y: 1,
					color: { r: 0, g: 0, b: 255, a: 255 },
					selection: "alpha:base",
				},
			];
			const after = snapshotCanvas(before);
			applyOperations(after, ops, { atomic: true });
			const summary = diffCanvases(before, after, ops);
			check.equal(summary.raw.changedPixels, 2);
			// Each selection is scoped by the canvas its operation saw: the
			// first clear owns (0,0), the recolor owns (1,1).
			check.equal(summary.outsideSelectionUnchanged, true);
		},
	},
	{
		name: "feedback: full keeps long-edge auto-scale",
		run: (check) => {
			const before = fillCanvas(4, 4, clear());
			const after = snapshotCanvas(before);
			setPixel(after, "base", 0, 0, red());
			const ops: BatchOperation[] = [
				{
					type: "setPixel",
					layerId: "base",
					x: 0,
					y: 0,
					color: { r: 255, g: 0, b: 0, a: 255 },
				},
			];
			const result = buildFeedback(before, after, ops, { image: "full" });
			check.equal(result.feedback.imageIncluded, true);
			check.ok(result.pngBytes !== undefined, "full feedback carries bytes");
			// Feedback auto-scale still applies: a 4px edge scales by 16.
			const decoded = decodePng(result.pngBytes as Uint8Array).canvas;
			check.equal(decoded.width, 64);
			check.equal(decoded.height, 64);
		},
	},
	{
		name: "feedback: absent image defaults to none without image bytes",
		run: (check) => {
			const before = fillCanvas(2, 2, red());
			const after = snapshotCanvas(before);
			const result = buildFeedback(before, after, [], {});
			check.deepEqual(result.feedback, {
				image: "none",
				imageIncluded: false,
			});
			check.equal(result.pngBytes, undefined);
		},
	},
	{
		name: "feedback: full returns image bytes with summary on request",
		run: (check) => {
			const before = fillCanvas(4, 4, clear());
			const after = snapshotCanvas(before);
			setPixel(after, "base", 0, 0, red());
			const ops: BatchOperation[] = [
				{
					type: "setPixel",
					layerId: "base",
					x: 0,
					y: 0,
					color: { r: 255, g: 0, b: 0, a: 255 },
				},
			];
			const result = buildFeedback(before, after, ops, {
				image: "full",
				diff: "summary",
			});
			check.equal(result.feedback.image, "full");
			check.equal(result.feedback.imageIncluded, true);
			check.ok(
				result.pngBytes !== undefined && pngSignature(result.pngBytes),
				"full feedback carries PNG bytes",
			);
			const diff = result.feedback.diff as DiffSummary;
			check.ok(diff !== undefined, "summary requested so diff is present");
			check.deepEqual(Object.keys(diff).sort(), [
				"composited",
				"outsideSelectionUnchanged",
				"raw",
				"structural",
			]);
			const plain = buildFeedback(before, after, ops, { image: "full" });
			check.equal(plain.feedback.imageIncluded, true);
			check.ok(plain.pngBytes !== undefined, "bytes present without diff");
			check.equal(
				"diff" in plain.feedback,
				false,
				"no summary means no diff key",
			);
		},
	},
	{
		name: "feedback: changed without visible difference sets the flag and omits bytes",
		run: (check) => {
			const before = fillCanvas(4, 4, red());
			const after = snapshotCanvas(before);
			const renamed = after.layers[0] as { name?: string };
			renamed.name = "Renamed";
			const result = buildFeedback(before, after, [], {
				image: "changed",
				diff: "summary",
			});
			check.deepEqual(result.feedback.image, "changed");
			check.equal(result.feedback.imageIncluded, false);
			check.equal(result.feedback.noVisibleChange, true);
			check.equal(result.pngBytes, undefined);
			const diff = result.feedback.diff as {
				composited: { changedPixels: number; bounds: null };
			};
			check.equal(diff.composited.changedPixels, 0);
			check.equal(diff.composited.bounds, null);
			const quiet = buildFeedback(before, after, [], { image: "changed" });
			check.deepEqual(quiet.feedback, {
				image: "changed",
				imageIncluded: false,
				noVisibleChange: true,
			});
		},
	},
	{
		name: "feedback: changed ignores crop and renders the composited bounds",
		run: (check) => {
			const before = fillCanvas(16, 16, clear());
			const after = snapshotCanvas(before);
			setPixel(after, "base", 5, 5, red());
			const ops: BatchOperation[] = [
				{
					type: "setPixel",
					layerId: "base",
					x: 5,
					y: 5,
					color: { r: 255, g: 0, b: 0, a: 255 },
				},
			];
			const result = buildFeedback(before, after, ops, {
				image: "changed",
				crop: "rect:0,0,2,2",
			});
			check.equal(result.feedback.imageIncluded, true);
			check.ok(result.pngBytes !== undefined, "changed pixels render bytes");
			const decoded = decodePng(result.pngBytes as Uint8Array).canvas;
			// The crop argument is ignored: output covers the 1x1 change
			// bounds auto-scaled from a long edge of 1 to 16.
			check.equal(decoded.width, 16);
			check.equal(decoded.height, 16);
			const back = flattenCanvas(decoded);
			check.deepEqual([back[0], back[1], back[2], back[3]], [255, 0, 0, 255]);
		},
	},
	{
		name: "feedback: crop with none is INVALID_ARGUMENT",
		run: (check) => {
			const before = fillCanvas(2, 2, red());
			const after = snapshotCanvas(before);
			check.equal(
				codeOf(() => {
					buildFeedback(before, after, [], { crop: "rect:0,0,1,1" });
				}),
				"INVALID_ARGUMENT",
			);
			check.equal(
				codeOf(() => {
					buildFeedback(before, after, [], {
						image: "none",
						crop: "rect:0,0,1,1",
					});
				}),
				"INVALID_ARGUMENT",
			);
			check.equal(
				codeOf(() => {
					normalizeFeedbackRequest({ image: "sometimes" });
				}),
				"INVALID_ARGUMENT",
			);
		},
	},
	{
		name: "diff: partial batch scopes tolerate a failed op and keep later ops",
		run: (check) => {
			const before = fillCanvas(4, 4, clear());
			const ops: BatchOperation[] = [
				{
					type: "setPixel",
					layerId: "base",
					x: 0,
					y: 0,
					color: { r: 255, g: 0, b: 0, a: 255 },
				},
				{
					type: "setPixel",
					layerId: "base",
					x: -1,
					y: 0,
					color: { r: 255, g: 0, b: 0, a: 255 },
				},
				{
					type: "setPixel",
					layerId: "base",
					x: 1,
					y: 1,
					color: { r: 255, g: 0, b: 0, a: 255 },
				},
			];
			const after = snapshotCanvas(before);
			const report = applyOperations(after, ops, { atomic: false });
			check.equal(report.applied, 2);
			check.equal(report.failed, 1);
			// The replay must skip the failed middle op yet still see the
			// trailing write, exactly as non-atomic execution does.
			const summary = diffCanvases(before, after, ops);
			check.equal(summary.raw.changedPixels, 2);
			check.deepEqual(summary.raw.bounds, { x: 0, y: 0, width: 2, height: 2 });
			check.equal(summary.composited.changedPixels, 2);
			check.equal(summary.outsideSelectionUnchanged, true);
		},
	},
	{
		name: "feedback: changed and summary tolerate partial batch failures",
		run: (check) => {
			const before = fillCanvas(4, 4, clear());
			const ops: BatchOperation[] = [
				{
					type: "setPixel",
					layerId: "base",
					x: 0,
					y: 0,
					color: { r: 255, g: 0, b: 0, a: 255 },
				},
				{
					type: "setPixel",
					layerId: "base",
					x: -1,
					y: 0,
					color: { r: 255, g: 0, b: 0, a: 255 },
				},
			];
			const after = snapshotCanvas(before);
			const report = applyOperations(after, ops, { atomic: false });
			check.equal(report.applied, 1);
			check.equal(report.failed, 1);
			const changed = buildFeedback(before, after, ops, { image: "changed" });
			check.equal(changed.feedback.image, "changed");
			check.equal(changed.feedback.imageIncluded, true);
			check.ok(
				changed.pngBytes !== undefined,
				"partial change still renders bytes",
			);
			const summarized = buildFeedback(before, after, ops, {
				diff: "summary",
			});
			const diff = summarized.feedback.diff as DiffSummary;
			check.ok(diff !== undefined, "summary requested so diff is present");
			check.equal(diff.raw.changedPixels, 1);
			check.deepEqual(diff.raw.bounds, { x: 0, y: 0, width: 1, height: 1 });
			check.equal(diff.outsideSelectionUnchanged, true);
		},
	},
];
