import { applyOperations, type BatchOperation } from "../../src/core/batch.ts";
import {
	addLayer,
	addRegion,
	createCanvas,
	getLayer,
	setRegionValue,
} from "../../src/core/canvas.ts";
import { McAssetError } from "../../src/core/errors.ts";
import type { PixelCanvas, RGBA } from "../../src/core/types.ts";
import type { CaseCheck } from "./model-cases.ts";

export interface BatchCase {
	name: string;
	run(check: CaseCheck): void;
}

const INK: RGBA = { r: 255, g: 0, b: 0, a: 255 };
const FILL: RGBA = { r: 0, g: 255, b: 0, a: 255 };

function fresh(width = 16, height = 16, id = "base"): PixelCanvas {
	const canvas = createCanvas(width, height);
	addLayer(canvas, { id });
	return canvas;
}

function snapshotAll(canvas: PixelCanvas): Uint8Array[] {
	return canvas.layers.map((layer) => layer.pixels.slice());
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

function expectBuffersEqual(
	check: CaseCheck,
	actual: Uint8Array[],
	expected: Uint8Array[],
	message: string,
): void {
	check.equal(actual.length, expected.length, `${message} (layer count)`);
	for (let i = 0; i < expected.length; i += 1) {
		check.ok(
			buffersEqual(actual[i], expected[i]),
			`${message} (layer ${i} byte-identical)`,
		);
	}
}

function caughtDetails(error: unknown): Record<string, unknown> {
	if (!(error instanceof McAssetError)) {
		throw new Error(`expected McAssetError but got ${String(error)}`);
	}
	const details = error.details;
	if (typeof details !== "object" || details === null) {
		throw new Error("expected McAssetError details to be an object");
	}
	return details as Record<string, unknown>;
}

export const BATCH_CASES: BatchCase[] = [
	{
		name: "section77: two valid ops then x=20 out of bounds rolls everything back",
		run: (check) => {
			const canvas = fresh(16, 16);
			const before = snapshotAll(canvas);
			const ops: BatchOperation[] = [
				{
					id: "op1",
					type: "setPixel",
					layerId: "base",
					x: 1,
					y: 1,
					color: INK,
				},
				{
					id: "op2",
					type: "drawLine",
					layerId: "base",
					x0: 0,
					y0: 0,
					x1: 5,
					y1: 0,
					color: INK,
				},
				{
					id: "op3",
					type: "setPixel",
					layerId: "base",
					x: 20,
					y: 0,
					color: INK,
				},
			];
			let code = "";
			let details: Record<string, unknown> = {};
			try {
				applyOperations(canvas, ops);
				check.fail("expected applyOperations to throw");
			} catch (error) {
				if (!(error instanceof McAssetError)) {
					check.fail(`expected McAssetError but got ${String(error)}`);
				}
				code = (error as McAssetError).code;
				details = caughtDetails(error);
			}
			check.equal(
				code,
				"OUT_OF_BOUNDS",
				"original code, not TRANSACTION_FAILED",
			);
			check.equal(details.operationIndex, 2, "details carry operationIndex");
			check.equal(details.operationId, "op3", "details carry operationId");
			expectBuffersEqual(
				check,
				snapshotAll(canvas),
				before,
				"canvas byte-identical after rollback",
			);
		},
	},
	{
		name: "atomic failure without id still carries operationIndex only",
		run: (check) => {
			const canvas = fresh(16, 16);
			const before = snapshotAll(canvas);
			const ops: BatchOperation[] = [
				{ type: "setPixel", layerId: "base", x: 0, y: 0, color: INK },
				{ type: "setPixel", layerId: "base", x: 20, y: 0, color: INK },
			];
			try {
				applyOperations(canvas, ops);
				check.fail("expected applyOperations to throw");
			} catch (error) {
				if (!(error instanceof McAssetError)) {
					check.fail(`expected McAssetError but got ${String(error)}`);
				}
				const err = error as McAssetError;
				check.equal(err.code, "OUT_OF_BOUNDS", "original code");
				const details = caughtDetails(error);
				check.equal(details.operationIndex, 1, "operationIndex 1");
				check.ok(
					!("operationId" in details),
					"no operationId when the op has no id",
				);
			}
			expectBuffersEqual(
				check,
				snapshotAll(canvas),
				before,
				"rollback without id still restores bytes",
			);
		},
	},
	{
		name: "success reports each operation index/id/status",
		run: (check) => {
			const canvas = fresh(16, 16);
			const ops: BatchOperation[] = [
				{ id: "a", type: "setPixel", layerId: "base", x: 0, y: 0, color: INK },
				{ type: "clearPixel", layerId: "base", x: 0, y: 0 },
				{
					id: "c",
					type: "fillRect",
					layerId: "base",
					rect: { x: 2, y: 2, width: 2, height: 2 },
					color: FILL,
				},
			];
			const report = applyOperations(canvas, ops);
			check.equal(report.applied, 3, "applied count");
			check.equal(report.operations.length, 3, "three per-op entries");
			check.deepEqual(
				report.operations[0],
				{ index: 0, id: "a", status: "applied" },
				"first entry",
			);
			check.deepEqual(
				report.operations[1],
				{ index: 1, status: "applied" },
				"entry without id omits id",
			);
			check.deepEqual(
				report.operations[2],
				{ index: 2, id: "c", status: "applied" },
				"third entry",
			);
		},
	},
	{
		name: "duplicate id in one batch fails with DUPLICATE_OPERATION_ID",
		run: (check) => {
			const canvas = fresh(16, 16);
			const before = snapshotAll(canvas);
			const ops: BatchOperation[] = [
				{
					id: "dup",
					type: "setPixel",
					layerId: "base",
					x: 0,
					y: 0,
					color: INK,
				},
				{
					id: "dup",
					type: "setPixel",
					layerId: "base",
					x: 1,
					y: 1,
					color: INK,
				},
			];
			try {
				applyOperations(canvas, ops);
				check.fail("expected duplicate id to throw");
			} catch (error) {
				if (!(error instanceof McAssetError)) {
					check.fail(`expected McAssetError but got ${String(error)}`);
				}
				const err = error as McAssetError;
				check.equal(err.code, "DUPLICATE_OPERATION_ID", "duplicate code");
				const details = caughtDetails(error);
				check.equal(details.operationIndex, 1, "second occurrence index");
				check.equal(details.operationId, "dup", "duplicate id echoed");
			}
			expectBuffersEqual(
				check,
				snapshotAll(canvas),
				before,
				"duplicate rolls back the first write",
			);
		},
	},
	{
		name: "atomic=false runs every op and counts applied/failed",
		run: (check) => {
			const canvas = fresh(16, 16);
			const ops: BatchOperation[] = [
				{
					id: "good-1",
					type: "setPixel",
					layerId: "base",
					x: 0,
					y: 0,
					color: INK,
				},
				{
					id: "bad",
					type: "setPixel",
					layerId: "base",
					x: 20,
					y: 0,
					color: INK,
				},
				{
					id: "good-2",
					type: "setPixel",
					layerId: "base",
					x: 1,
					y: 1,
					color: FILL,
				},
			];
			const report = applyOperations(canvas, ops, { atomic: false });
			check.equal(report.applied, 2, "two applied");
			check.equal(report.failed, 1, "one failed");
			check.equal(report.operations.length, 3, "every op reported");
			check.deepEqual(
				report.operations[0],
				{ index: 0, id: "good-1", status: "applied" },
				"first applied",
			);
			const failedEntry = report.operations[1];
			if (failedEntry.status === "failed") {
				check.equal(failedEntry.index, 1, "failed index kept");
				check.equal(failedEntry.id, "bad", "failed id kept");
				check.equal(
					failedEntry.error.code,
					"OUT_OF_BOUNDS",
					"failed entry keeps the original code",
				);
			} else {
				check.fail("second entry must be a failure");
			}
			check.deepEqual(
				report.operations[2],
				{ index: 2, id: "good-2", status: "applied" },
				"third still runs after the failure",
			);
			// The op after the failure really painted: no early break, no rollback.
			const layer = getLayer(canvas, "base");
			const at = (x: number, y: number): RGBA => {
				const offset = (y * 16 + x) * 4;
				return {
					r: layer.pixels[offset],
					g: layer.pixels[offset + 1],
					b: layer.pixels[offset + 2],
					a: layer.pixels[offset + 3],
				};
			};
			check.deepEqual(at(0, 0), INK, "first write kept");
			check.deepEqual(at(1, 1), FILL, "write after failure kept");
		},
	},
	{
		name: "unknown operation type fails with UNKNOWN_OPERATION",
		run: (check) => {
			const canvas = fresh(16, 16);
			const before = snapshotAll(canvas);
			const ops = [
				{ id: "mystery", type: "ellipse", layerId: "base", x: 0, y: 0 },
			] as unknown as BatchOperation[];
			try {
				applyOperations(canvas, ops);
				check.fail("expected unknown operation to throw");
			} catch (error) {
				if (!(error instanceof McAssetError)) {
					check.fail(`expected McAssetError but got ${String(error)}`);
				}
				const err = error as McAssetError;
				check.equal(err.code, "UNKNOWN_OPERATION", "unknown code");
				const details = caughtDetails(error);
				check.equal(details.operationIndex, 0, "index 0");
				check.equal(details.operationId, "mystery", "id echoed");
			}
			expectBuffersEqual(
				check,
				snapshotAll(canvas),
				before,
				"unknown op leaves no writes",
			);
		},
	},
	{
		name: "empty batch succeeds with zero applied",
		run: (check) => {
			const canvas = fresh(16, 16);
			const before = snapshotAll(canvas);
			const report = applyOperations(canvas, []);
			check.equal(report.applied, 0, "nothing applied");
			check.deepEqual(report.operations, [], "no per-op entries");
			expectBuffersEqual(
				check,
				snapshotAll(canvas),
				before,
				"empty batch changes nothing",
			);
		},
	},
	{
		name: "rollback restores every layer byte for byte",
		run: (check) => {
			const canvas = createCanvas(8, 8);
			addLayer(canvas, { id: "bottom" });
			addLayer(canvas, { id: "top" });
			const seed: BatchOperation[] = [
				{
					type: "fillRect",
					layerId: "bottom",
					rect: { x: 0, y: 0, width: 8, height: 8 },
					color: FILL,
				},
				{ type: "setPixel", layerId: "top", x: 7, y: 7, color: INK },
			];
			applyOperations(canvas, seed);
			const before = snapshotAll(canvas);
			const ops: BatchOperation[] = [
				{ type: "setPixel", layerId: "bottom", x: 0, y: 0, color: INK },
				{ type: "setPixel", layerId: "top", x: 1, y: 1, color: INK },
				{ type: "setPixel", layerId: "nope", x: 2, y: 2, color: INK },
			];
			try {
				applyOperations(canvas, ops);
				check.fail("expected layer miss to throw");
			} catch (error) {
				if (!(error instanceof McAssetError)) {
					check.fail(`expected McAssetError but got ${String(error)}`);
				}
				check.equal(
					(error as McAssetError).code,
					"LAYER_NOT_FOUND",
					"original code preserved",
				);
				check.equal(
					caughtDetails(error).operationIndex,
					2,
					"failing index reported",
				);
			}
			expectBuffersEqual(
				check,
				snapshotAll(canvas),
				before,
				"both layers restored byte for byte",
			);
		},
	},
	{
		name: "hundred-operation batch completes",
		run: (check) => {
			const canvas = fresh(16, 16);
			const ops: BatchOperation[] = [];
			for (let i = 0; i < 200; i += 1) {
				ops.push({
					type: "setPixel",
					layerId: "base",
					x: i % 16,
					y: ((i / 16) % 16) | 0,
					color: INK,
				});
			}
			const report = applyOperations(canvas, ops);
			check.equal(report.applied, 200, "all 200 applied");
			check.equal(report.operations.length, 200, "all 200 reported");
		},
	},
	{
		name: "same id is reusable across batches",
		run: (check) => {
			const canvas = fresh(16, 16);
			const first: BatchOperation[] = [
				{
					id: "reuse",
					type: "setPixel",
					layerId: "base",
					x: 0,
					y: 0,
					color: INK,
				},
			];
			const second: BatchOperation[] = [
				{
					id: "reuse",
					type: "setPixel",
					layerId: "base",
					x: 1,
					y: 1,
					color: FILL,
				},
			];
			const r1 = applyOperations(canvas, first);
			const r2 = applyOperations(canvas, second);
			check.equal(r1.applied, 1, "first batch applied");
			check.equal(r2.applied, 1, "second batch reuses the id");
			check.deepEqual(
				r2.operations[0],
				{ index: 0, id: "reuse", status: "applied" },
				"second report echoes the id",
			);
		},
	},
	{
		name: "atomic defaults to true when options are omitted",
		run: (check) => {
			const canvas = fresh(16, 16);
			const before = snapshotAll(canvas);
			const ops: BatchOperation[] = [
				{ type: "setPixel", layerId: "base", x: 0, y: 0, color: INK },
				{ type: "setPixel", layerId: "base", x: 20, y: 0, color: INK },
				{ type: "setPixel", layerId: "base", x: 1, y: 1, color: FILL },
			];
			try {
				applyOperations(canvas, ops);
				check.fail("expected default-atomic batch to throw");
			} catch (error) {
				check.equal(
					(error as McAssetError).code,
					"OUT_OF_BOUNDS",
					"default path throws the original code",
				);
			}
			expectBuffersEqual(
				check,
				snapshotAll(canvas),
				before,
				"default atomic=true rolls back",
			);
		},
	},
	{
		name: "all six pixel operation kinds dispatch",
		run: (check) => {
			const canvas = fresh(16, 16);
			const ops: BatchOperation[] = [
				{ type: "setPixel", layerId: "base", x: 0, y: 0, color: INK },
				{ type: "clearPixel", layerId: "base", x: 0, y: 0 },
				{
					type: "drawLine",
					layerId: "base",
					x0: 0,
					y0: 1,
					x1: 3,
					y1: 1,
					color: INK,
				},
				{
					type: "drawRect",
					layerId: "base",
					rect: { x: 5, y: 5, width: 3, height: 3 },
					color: INK,
				},
				{
					type: "fillRect",
					layerId: "base",
					rect: { x: 10, y: 10, width: 2, height: 2 },
					color: FILL,
				},
				{ type: "floodFill", layerId: "base", x: 15, y: 15, color: FILL },
			];
			const report = applyOperations(canvas, ops);
			check.equal(report.applied, 6, "all six kinds applied");
		},
	},
	{
		name: "layer vocabulary dispatches in order",
		run: (check) => {
			const canvas = fresh(8, 8);
			const ops: BatchOperation[] = [
				{ id: "mk", type: "createLayer", layerId: "shade" },
				{
					id: "fill",
					type: "fillLayer",
					layerId: "shade",
					color: FILL,
				},
				{ id: "ren", type: "renameLayer", layerId: "shade", name: "Shadow" },
				{ id: "move", type: "moveLayer", layerId: "shade", dx: 0, dy: 0 },
				{ id: "dup", type: "duplicateLayer", layerId: "shade" },
				{ id: "ord", type: "reorderLayer", layerId: "shade", toIndex: 0 },
				{ id: "clr", type: "clearLayer", layerId: "shade-copy" },
				{
					id: "mrg",
					type: "mergeLayer",
					sourceId: "shade-copy",
					targetId: "shade",
				},
				{ id: "rm", type: "removeLayer", layerId: "shade" },
			];
			const report = applyOperations(canvas, ops);
			check.equal(report.applied, 9, "all nine layer ops applied");
			check.deepEqual(
				canvas.layers.map((layer) => layer.id),
				["base"],
				"merge plus remove collapse back to the seed layer",
			);
			const layer = getLayer(canvas, "base");
			check.ok(layer.pixels.length === 8 * 8 * 4, "base pixels intact");
		},
	},
	{
		name: "region vocabulary dispatches in order",
		run: (check) => {
			const canvas = fresh(8, 8);
			const ops: BatchOperation[] = [
				{ id: "mk", type: "createRegion", regionId: "blade" },
				{
					id: "px",
					type: "setRegionPixel",
					regionId: "blade",
					x: 2,
					y: 3,
					value: 1,
				},
				{ id: "ren", type: "renameRegion", regionId: "blade", name: "Blade" },
				{ id: "mk2", type: "createRegion", regionId: "hilt" },
				{ id: "ord", type: "reorderRegion", regionId: "hilt", toIndex: 0 },
				{ id: "rm", type: "removeRegion", regionId: "hilt" },
			];
			const report = applyOperations(canvas, ops);
			check.equal(report.applied, 6, "all six region ops applied");
			check.deepEqual(
				canvas.regions.map((region) => region.id),
				["blade"],
				"one region survives",
			);
			check.equal(canvas.regions[0]?.mask[3 * 8 + 2], 1, "region pixel set");
			check.equal(canvas.regions[0]?.name, "Blade", "region renamed");
		},
	},
	{
		name: "structural failure rolls the layer list back",
		run: (check) => {
			const canvas = fresh(8, 8);
			const beforeIds = canvas.layers.map((layer) => layer.id);
			const before = snapshotAll(canvas);
			const ops: BatchOperation[] = [
				{ id: "mk", type: "createLayer", layerId: "temp" },
				{
					id: "fill",
					type: "fillLayer",
					layerId: "temp",
					color: INK,
				},
				{ id: "boom", type: "removeLayer", layerId: "nope" },
			];
			try {
				applyOperations(canvas, ops);
				check.fail("expected missing layer to throw");
			} catch (error) {
				check.equal(
					(error as McAssetError).code,
					"LAYER_NOT_FOUND",
					"original code preserved",
				);
				check.equal(
					caughtDetails(error).operationIndex,
					2,
					"failing index reported",
				);
			}
			check.deepEqual(
				canvas.layers.map((layer) => layer.id),
				beforeIds,
				"created layer rolled back",
			);
			expectBuffersEqual(
				check,
				snapshotAll(canvas),
				before,
				"bytes restored too",
			);
		},
	},
	{
		name: "removing the last layer is refused",
		run: (check) => {
			const canvas = fresh(8, 8);
			const before = snapshotAll(canvas);
			try {
				applyOperations(canvas, [
					{ id: "rm", type: "removeLayer", layerId: "base" },
				]);
				check.fail("expected last-layer removal to throw");
			} catch (error) {
				check.equal(
					(error as McAssetError).code,
					"INVALID_ARGUMENT",
					"last layer is kept",
				);
			}
			expectBuffersEqual(
				check,
				snapshotAll(canvas),
				before,
				"refusal writes nothing",
			);
		},
	},
	{
		name: "merging a layer with itself is refused",
		run: (check) => {
			const canvas = fresh(8, 8);
			try {
				applyOperations(canvas, [
					{
						id: "self",
						type: "mergeLayer",
						sourceId: "base",
						targetId: "base",
					},
				]);
				check.fail("expected self-merge to throw");
			} catch (error) {
				check.equal(
					(error as McAssetError).code,
					"INVALID_ARGUMENT",
					"self merge refused",
				);
			}
		},
	},
	{
		name: "duplicate layer id carries DUPLICATE_LAYER_ID with position",
		run: (check) => {
			const canvas = fresh(8, 8);
			const beforeIds = canvas.layers.map((layer) => layer.id);
			try {
				applyOperations(canvas, [
					{ id: "dup", type: "createLayer", layerId: "base" },
				]);
				check.fail("expected duplicate layer id to throw");
			} catch (error) {
				const err = error as McAssetError;
				check.equal(err.code, "DUPLICATE_LAYER_ID", "duplicate code");
				check.equal(caughtDetails(error).operationIndex, 0, "index 0");
			}
			check.deepEqual(
				canvas.layers.map((layer) => layer.id),
				beforeIds,
				"no layer added",
			);
		},
	},
	{
		name: "pixel op with a selection leaves outside raw bytes identical",
		run: (check) => {
			const canvas = fresh(4, 4);
			const layer = getLayer(canvas, "base");
			for (let y = 0; y < 4; y += 1) {
				for (let x = 0; x < 4; x += 1) {
					const offset = (y * 4 + x) * 4;
					layer.pixels[offset] = (x * 16) % 256;
					layer.pixels[offset + 1] = (y * 16) % 256;
					layer.pixels[offset + 2] = ((x + y) * 8) % 256;
					layer.pixels[offset + 3] = 255;
				}
			}
			const hidden = (3 * 4 + 3) * 4;
			layer.pixels[hidden] = 17;
			layer.pixels[hidden + 1] = 34;
			layer.pixels[hidden + 2] = 51;
			layer.pixels[hidden + 3] = 0;
			const before = snapshotAll(canvas);
			const ops = [
				{
					type: "fillRect",
					layerId: "base",
					rect: { x: 0, y: 0, width: 4, height: 4 },
					color: INK,
					selection: "rect:0,0,1,1",
				},
			] as unknown as BatchOperation[];
			const report = applyOperations(canvas, ops);
			check.equal(report.applied, 1, "scoped fill applied");
			const raw = getLayer(canvas, "base").pixels;
			const at00 = 0;
			check.deepEqual(
				[raw[at00], raw[at00 + 1], raw[at00 + 2], raw[at00 + 3]],
				[255, 0, 0, 255],
				"selected pixel painted",
			);
			for (let y = 0; y < 4; y += 1) {
				for (let x = 0; x < 4; x += 1) {
					if (x === 0 && y === 0) {
						continue;
					}
					const offset = (y * 4 + x) * 4;
					check.deepEqual(
						[raw[offset], raw[offset + 1], raw[offset + 2], raw[offset + 3]],
						[
							before[0]?.[offset],
							before[0]?.[offset + 1],
							before[0]?.[offset + 2],
							before[0]?.[offset + 3],
						],
						`outside (${x},${y}) byte-identical`,
					);
				}
			}
		},
	},
	{
		name: "empty selection on a new write is EMPTY_SELECTION with rollback",
		run: (check) => {
			const canvas = fresh(4, 4);
			const before = snapshotAll(canvas);
			const ops = [
				{
					type: "setPixel",
					layerId: "base",
					x: 0,
					y: 0,
					color: INK,
					selection: "rect:1,1,1,1",
				},
				{
					type: "setPixel",
					layerId: "base",
					x: 2,
					y: 2,
					color: INK,
					selection: {
						op: "intersect",
						operands: ["rect:0,0,1,1", "rect:3,3,1,1"],
					},
				},
			] as unknown as BatchOperation[];
			try {
				applyOperations(canvas, ops);
				check.fail("expected empty selection to throw");
			} catch (error) {
				check.equal(
					(error as McAssetError).code,
					"EMPTY_SELECTION",
					"empty selection code",
				);
				check.equal(
					caughtDetails(error).operationIndex,
					1,
					"failing index reported",
				);
			}
			expectBuffersEqual(
				check,
				snapshotAll(canvas),
				before,
				"empty selection rolls back the first write",
			);
		},
	},
	{
		name: "fillRect without a rect fills the selection bounds clipped",
		run: (check) => {
			const canvas = fresh(4, 4);
			const ops = [
				{
					type: "fillRect",
					layerId: "base",
					color: FILL,
					selection: "rect:1,1,2,2",
				},
			] as unknown as BatchOperation[];
			const report = applyOperations(canvas, ops);
			check.equal(report.applied, 1, "rect omitted with selection applied");
			const layer = getLayer(canvas, "base");
			const at = (x: number, y: number): RGBA => {
				const offset = (y * 4 + x) * 4;
				return {
					r: layer.pixels[offset],
					g: layer.pixels[offset + 1],
					b: layer.pixels[offset + 2],
					a: layer.pixels[offset + 3],
				};
			};
			check.deepEqual(at(1, 1), FILL, "inside painted");
			check.deepEqual(
				at(0, 0),
				{ r: 0, g: 0, b: 0, a: 0 },
				"outside untouched",
			);
			const missing: BatchOperation[] = [
				{ type: "fillRect", layerId: "base", color: FILL },
			];
			try {
				applyOperations(fresh(4, 4), missing);
				check.fail("expected missing rect without selection to throw");
			} catch (error) {
				check.equal(
					(error as McAssetError).code,
					"INVALID_ARGUMENT",
					"rect still required without selection",
				);
			}
		},
	},
	{
		name: "stampRect copies verbatim with an overlapping destination",
		run: (check) => {
			const canvas = fresh(4, 4);
			const layer = getLayer(canvas, "base");
			layer.pixels[(0 * 4 + 0) * 4] = 200;
			layer.pixels[(0 * 4 + 0) * 4 + 3] = 255;
			const hidden = (1 * 4 + 0) * 4;
			layer.pixels[hidden] = 17;
			layer.pixels[hidden + 1] = 34;
			layer.pixels[hidden + 2] = 51;
			layer.pixels[hidden + 3] = 0;
			const ops = [
				{
					type: "stampRect",
					layerId: "base",
					source: "rect:0,0,2,2",
					offset: { dx: 1, dy: 0 },
					merge: "replace",
				},
			] as unknown as BatchOperation[];
			const report = applyOperations(canvas, ops);
			check.equal(report.applied, 1, "stamp applied");
			const raw = getLayer(canvas, "base").pixels;
			const dstHidden = (1 * 4 + 1) * 4;
			check.deepEqual(
				[
					raw[dstHidden],
					raw[dstHidden + 1],
					raw[dstHidden + 2],
					raw[dstHidden + 3],
				],
				[17, 34, 51, 0],
				"hidden RGB copied verbatim",
			);
			const dstOpaque = (0 * 4 + 1) * 4;
			check.deepEqual(
				[raw[dstOpaque], raw[dstOpaque + 3]],
				[200, 255],
				"opaque source copied like a snapshot, not smeared",
			);
		},
	},
	{
		name: "stampRect source-over blends with integer straight alpha",
		run: (check) => {
			const canvas = fresh(4, 4);
			const layer = getLayer(canvas, "base");
			const set = (
				x: number,
				y: number,
				r: number,
				g: number,
				b: number,
				a: number,
			): void => {
				const offset = (y * 4 + x) * 4;
				layer.pixels[offset] = r;
				layer.pixels[offset + 1] = g;
				layer.pixels[offset + 2] = b;
				layer.pixels[offset + 3] = a;
			};
			set(0, 0, 255, 0, 0, 128);
			set(2, 2, 0, 0, 255, 255);
			set(0, 1, 9, 9, 9, 0);
			set(2, 3, 1, 2, 3, 0);
			const ops = [
				{
					type: "stampRect",
					layerId: "base",
					source: "rect:0,0,1,2",
					to: { x: 2, y: 2 },
					merge: "source-over",
				},
			] as unknown as BatchOperation[];
			const report = applyOperations(canvas, ops);
			check.equal(report.applied, 1, "source-over stamp applied");
			const raw = getLayer(canvas, "base").pixels;
			const at = (x: number, y: number): number[] => {
				const offset = (y * 4 + x) * 4;
				return [raw[offset], raw[offset + 1], raw[offset + 2], raw[offset + 3]];
			};
			// 128/255 red over opaque blue: (128, 0, 127, 255) by hand.
			check.deepEqual(
				at(2, 2),
				[128, 0, 127, 255],
				"semi blends integer-exact",
			);
			// Transparent over transparent keeps the source hidden RGB.
			check.deepEqual(at(2, 3), [9, 9, 9, 0], "hidden RGB carried over");
		},
	},
	{
		name: "stampRect rotates clockwise with flip applied first",
		run: (check) => {
			const red: RGBA = { r: 255, g: 0, b: 0, a: 255 };
			const green: RGBA = { r: 0, g: 255, b: 0, a: 255 };
			const setup = (): PixelCanvas => {
				const canvas = fresh(4, 4);
				const layer = getLayer(canvas, "base");
				const set = (x: number, y: number, color: RGBA): void => {
					const offset = (y * 4 + x) * 4;
					layer.pixels[offset] = color.r;
					layer.pixels[offset + 1] = color.g;
					layer.pixels[offset + 2] = color.b;
					layer.pixels[offset + 3] = color.a;
				};
				set(0, 0, red);
				set(1, 0, green);
				return canvas;
			};
			const at = (canvas: PixelCanvas, x: number, y: number): RGBA => {
				const raw = getLayer(canvas, "base").pixels;
				const offset = (y * 4 + x) * 4;
				return {
					r: raw[offset],
					g: raw[offset + 1],
					b: raw[offset + 2],
					a: raw[offset + 3],
				};
			};
			const stamp = (
				canvas: PixelCanvas,
				transform: { flip?: "h" | "v"; rotate?: 0 | 90 | 180 | 270 },
			): void => {
				applyOperations(canvas, [
					{
						type: "stampRect",
						layerId: "base",
						source: "rect:0,0,2,1",
						to: { x: 0, y: 2 },
						transform,
					},
				] as unknown as BatchOperation[]);
			};
			const clear: RGBA = { r: 0, g: 0, b: 0, a: 0 };
			const rotated = setup();
			stamp(rotated, { rotate: 90 });
			check.deepEqual(at(rotated, 0, 2), red, "90cw keeps left cell on top");
			check.deepEqual(at(rotated, 0, 3), green, "90cw moves right cell down");
			const flipped = setup();
			stamp(flipped, { flip: "h" });
			check.deepEqual(at(flipped, 0, 2), green, "flip-h swaps the row");
			check.deepEqual(at(flipped, 1, 2), red, "flip-h swaps the row");
			const half = setup();
			stamp(half, { rotate: 180 });
			check.deepEqual(at(half, 0, 2), green, "180 swaps both axes");
			check.deepEqual(at(half, 1, 2), red, "180 swaps both axes");
			const flipThenTurn = setup();
			stamp(flipThenTurn, { flip: "h", rotate: 90 });
			check.deepEqual(at(flipThenTurn, 0, 2), green, "flip runs before rotate");
			check.deepEqual(at(flipThenTurn, 0, 3), red, "flip runs before rotate");
			check.deepEqual(at(flipThenTurn, 1, 2), clear, "no spill outside 1x2");
		},
	},
	{
		name: "stampRect destination selection clips the write",
		run: (check) => {
			const canvas = fresh(4, 4);
			const ops = [
				{
					type: "fillRect",
					layerId: "base",
					rect: { x: 0, y: 0, width: 2, height: 2 },
					color: INK,
				},
				{
					type: "stampRect",
					layerId: "base",
					source: "rect:0,0,2,2",
					to: { x: 2, y: 2 },
					selection: "rect:2,2,1,1",
				},
			] as unknown as BatchOperation[];
			applyOperations(canvas, ops);
			const layer = getLayer(canvas, "base");
			const at = (x: number, y: number): RGBA => {
				const offset = (y * 4 + x) * 4;
				return {
					r: layer.pixels[offset],
					g: layer.pixels[offset + 1],
					b: layer.pixels[offset + 2],
					a: layer.pixels[offset + 3],
				};
			};
			check.deepEqual(at(2, 2), INK, "clipped cell written");
			check.deepEqual(
				at(3, 3),
				{ r: 0, g: 0, b: 0, a: 0 },
				"outside the destination clip untouched",
			);
		},
	},
	{
		name: "stampRect leaves regions alone unless carryRegions is true",
		run: (check) => {
			const setup = (): PixelCanvas => {
				const canvas = fresh(4, 4);
				applyOperations(canvas, [
					{
						type: "createRegion",
						regionId: "r",
					},
					{
						type: "setRegionPixel",
						regionId: "r",
						x: 0,
						y: 0,
						value: 1,
					},
				]);
				return canvas;
			};
			const plain = setup();
			applyOperations(plain, [
				{
					type: "stampRect",
					layerId: "base",
					source: "rect:0,0,1,1",
					to: { x: 2, y: 2 },
				},
			] as unknown as BatchOperation[]);
			check.equal(
				plain.regions[0]?.mask[2 * 4 + 2],
				0,
				"default carries nothing",
			);
			check.equal(plain.regions[0]?.mask[0], 1, "source bit retained");
			const carried = setup();
			applyOperations(carried, [
				{
					type: "stampRect",
					layerId: "base",
					source: "rect:0,0,1,1",
					to: { x: 2, y: 2 },
					carryRegions: true,
				},
			] as unknown as BatchOperation[]);
			check.equal(carried.regions[0]?.mask[2 * 4 + 2], 1, "bit mapped");
			check.equal(carried.regions[0]?.mask[0], 1, "source retained");
			check.deepEqual(
				carried.regions.map((region) => region.id),
				["r"],
				"no region copied or added",
			);
		},
	},
	{
		name: "floodFill with a selection leaves outside raw bytes identical",
		run: (check) => {
			const canvas = fresh(4, 4);
			const layer = getLayer(canvas, "base");
			for (let y = 0; y < 4; y += 1) {
				for (let x = 0; x < 4; x += 1) {
					const offset = (y * 4 + x) * 4;
					const left = x < 2;
					layer.pixels[offset] = left ? 200 : 20;
					layer.pixels[offset + 1] = left ? 100 : 30;
					layer.pixels[offset + 2] = left ? 50 : 40;
					layer.pixels[offset + 3] = 255;
				}
			}
			const hidden = (3 * 4 + 3) * 4;
			layer.pixels[hidden] = 17;
			layer.pixels[hidden + 1] = 34;
			layer.pixels[hidden + 2] = 51;
			layer.pixels[hidden + 3] = 0;
			const before = snapshotAll(canvas);
			const ops = [
				{
					type: "floodFill",
					layerId: "base",
					x: 0,
					y: 0,
					color: FILL,
					selection: "rect:0,0,2,4",
				},
			] as unknown as BatchOperation[];
			const report = applyOperations(canvas, ops);
			check.equal(report.applied, 1, "scoped flood applied");
			const raw = getLayer(canvas, "base").pixels;
			for (let y = 0; y < 4; y += 1) {
				for (let x = 0; x < 4; x += 1) {
					const offset = (y * 4 + x) * 4;
					if (x < 2) {
						check.deepEqual(
							[raw[offset], raw[offset + 1], raw[offset + 2], raw[offset + 3]],
							[0, 255, 0, 255],
							`inside (${x},${y}) filled`,
						);
					} else {
						check.deepEqual(
							[raw[offset], raw[offset + 1], raw[offset + 2], raw[offset + 3]],
							[
								before[0]?.[offset],
								before[0]?.[offset + 1],
								before[0]?.[offset + 2],
								before[0]?.[offset + 3],
							],
							`outside (${x},${y}) byte-identical`,
						);
					}
				}
			}
		},
	},
	{
		name: "stampRect maps 270 degrees clockwise on a non-square source",
		run: (check) => {
			const canvas = fresh(6, 6);
			const layer = getLayer(canvas, "base");
			const set = (x: number, y: number, v: number): void => {
				const offset = (y * 6 + x) * 4;
				layer.pixels[offset] = v;
				layer.pixels[offset + 1] = 0;
				layer.pixels[offset + 2] = 0;
				layer.pixels[offset + 3] = 255;
			};
			// 3x2 source with distinct red channels per cell.
			const values = [
				[11, 12, 13],
				[21, 22, 23],
			];
			for (let ly = 0; ly < 2; ly += 1) {
				for (let lx = 0; lx < 3; lx += 1) {
					set(lx, ly, values[ly]?.[lx] as number);
				}
			}
			applyOperations(canvas, [
				{
					type: "stampRect",
					layerId: "base",
					source: "rect:0,0,3,2",
					to: { x: 3, y: 0 },
					transform: { rotate: 270 },
				},
			] as unknown as BatchOperation[]);
			// 270cw maps (x, y) to (y, w - 1 - x): output is 2 wide, 3 tall.
			const at = (x: number, y: number): number => {
				const raw = getLayer(canvas, "base").pixels;
				return raw[(y * 6 + x) * 4] as number;
			};
			check.equal(at(3, 0), 13, "(2,0) lands top-left");
			check.equal(at(4, 0), 23, "(2,1) lands top-right");
			check.equal(at(3, 1), 12, "(1,0) lands mid-left");
			check.equal(at(4, 1), 22, "(1,1) lands mid-right");
			check.equal(at(3, 2), 11, "(0,0) lands bottom-left");
			check.equal(at(4, 2), 21, "(0,1) lands bottom-right");
			check.equal(at(5, 0), 0, "no spill past the 2-wide output");
		},
	},
	{
		name: "stampRect to and offset together are ARGUMENT_CONFLICT",
		run: (check) => {
			const canvas = fresh(4, 4);
			const before = snapshotAll(canvas);
			const ops = [
				{
					type: "stampRect",
					layerId: "base",
					source: "rect:0,0,1,1",
					to: { x: 2, y: 2 },
					offset: { dx: 2, dy: 2 },
				},
			] as unknown as BatchOperation[];
			try {
				applyOperations(canvas, ops);
				check.fail("expected to/offset conflict to throw");
			} catch (error) {
				check.equal(
					(error as McAssetError).code,
					"ARGUMENT_CONFLICT",
					"to and offset are exclusive",
				);
			}
			expectBuffersEqual(
				check,
				snapshotAll(canvas),
				before,
				"conflict writes nothing",
			);
		},
	},
	{
		name: "stampRect destination outside the canvas rolls back",
		run: (check) => {
			const canvas = fresh(4, 4);
			const before = snapshotAll(canvas);
			const ops = [
				{
					type: "setPixel",
					layerId: "base",
					x: 0,
					y: 0,
					color: INK,
				},
				{
					type: "stampRect",
					layerId: "base",
					source: "rect:0,0,2,2",
					to: { x: 3, y: 3 },
				},
			] as unknown as BatchOperation[];
			try {
				applyOperations(canvas, ops);
				check.fail("expected destination overflow to throw");
			} catch (error) {
				check.equal(
					(error as McAssetError).code,
					"OUT_OF_BOUNDS",
					"destination overflow code",
				);
			}
			expectBuffersEqual(
				check,
				snapshotAll(canvas),
				before,
				"destination overflow rolls everything back",
			);
		},
	},
	{
		name: "regionFromSelection creates and updates region masks",
		run: (check) => {
			const canvas = fresh(4, 4);
			const create = [
				{
					type: "regionFromSelection",
					selection: "rect:0,0,2,2",
					mode: "create",
					regionId: "body",
					name: "Body",
				},
			] as unknown as BatchOperation[];
			const report = applyOperations(canvas, create);
			check.equal(report.applied, 1, "create applied");
			check.deepEqual(
				canvas.regions.map((region) => region.id),
				["body"],
				"region created",
			);
			check.equal(canvas.regions[0]?.mask[0], 1, "mask set");
			check.equal(canvas.regions[0]?.mask[3 * 4 + 3], 0, "outside clear");
			const update = [
				{
					type: "regionFromSelection",
					selection: "rect:2,2,2,2",
					mode: "update",
					regionId: "body",
				},
			] as unknown as BatchOperation[];
			applyOperations(canvas, update);
			check.equal(canvas.regions[0]?.mask[0], 0, "old bits replaced");
			check.equal(canvas.regions[0]?.mask[3 * 4 + 3], 1, "new bits set");
			check.equal(canvas.regions[0]?.name, "Body", "name retained");
			check.deepEqual(
				canvas.regions.map((region) => region.id),
				["body"],
				"position retained",
			);
		},
	},
	{
		name: "regionFromSelection create assigns an id and refuses duplicates",
		run: (check) => {
			const canvas = fresh(4, 4);
			applyOperations(canvas, [
				{
					type: "regionFromSelection",
					selection: "rect:0,0,1,1",
					mode: "create",
				},
			] as unknown as BatchOperation[]);
			check.deepEqual(
				canvas.regions.map((region) => region.id),
				["region-0"],
				"omitted id follows the default sequence",
			);
			check.equal(canvas.regions[0]?.mask[0], 1, "mask set");
			const before = canvas.regions[0]?.mask.slice();
			try {
				applyOperations(canvas, [
					{
						type: "setPixel",
						layerId: "base",
						x: 3,
						y: 3,
						color: INK,
					},
					{
						type: "regionFromSelection",
						selection: "rect:1,1,1,1",
						mode: "create",
						regionId: "region-0",
					},
				] as unknown as BatchOperation[]);
				check.fail("expected duplicate region id to throw");
			} catch (error) {
				check.equal(
					(error as McAssetError).code,
					"DUPLICATE_REGION_ID",
					"duplicate code",
				);
			}
			check.ok(
				before !== undefined &&
					canvas.regions[0] !== undefined &&
					buffersEqual(canvas.regions[0].mask, before),
				"duplicate rolls back without touching the mask",
			);
			check.deepEqual(
				canvas.regions.map((region) => region.id),
				["region-0"],
				"no second region added",
			);
		},
	},
	{
		name: "regionFromSelection update keeps metadata name and order",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			addLayer(canvas, { id: "base" });
			addRegion(canvas, {
				id: "first",
				name: "First",
				metadata: { kept: true },
			});
			addRegion(canvas, { id: "second" });
			setRegionValue(canvas, "first", 0, 0, 1);
			applyOperations(canvas, [
				{
					type: "regionFromSelection",
					selection: "rect:3,3,1,1",
					mode: "update",
					regionId: "first",
				},
			] as unknown as BatchOperation[]);
			check.equal(canvas.regions[0]?.mask[0], 0, "old bits replaced");
			check.equal(canvas.regions[0]?.mask[3 * 4 + 3], 1, "new bits set");
			check.equal(canvas.regions[0]?.name, "First", "name kept when omitted");
			check.deepEqual(
				(canvas.regions[0] as { metadata?: unknown }).metadata,
				{ kept: true },
				"metadata kept",
			);
			check.deepEqual(
				canvas.regions.map((region) => region.id),
				["first", "second"],
				"array position kept",
			);
			applyOperations(canvas, [
				{
					type: "regionFromSelection",
					selection: "rect:0,0,1,1",
					mode: "update",
					regionId: "first",
					name: "Renamed",
				},
			] as unknown as BatchOperation[]);
			check.equal(canvas.regions[0]?.name, "Renamed", "name updated");
			try {
				applyOperations(canvas, [
					{
						type: "regionFromSelection",
						selection: "rect:0,0,1,1",
						mode: "update",
						regionId: "nope",
					},
				] as unknown as BatchOperation[]);
				check.fail("expected unknown region to throw");
			} catch (error) {
				check.equal(
					(error as McAssetError).code,
					"REGION_NOT_FOUND",
					"unknown region code",
				);
			}
		},
	},
	{
		name: "omitted layer selection on a multi-layer canvas is refused",
		run: (check) => {
			const canvas = createCanvas(4, 4);
			addLayer(canvas, { id: "a" });
			addLayer(canvas, { id: "b" });
			try {
				applyOperations(canvas, [
					{
						type: "setPixel",
						layerId: "a",
						x: 0,
						y: 0,
						color: INK,
						selection: "alpha",
					},
				] as unknown as BatchOperation[]);
				check.fail("expected omitted layer id to throw");
			} catch (error) {
				check.equal(
					(error as McAssetError).code,
					"INVALID_ARGUMENT",
					"omission refused",
				);
				check.equal(
					caughtDetails(error).operationIndex,
					0,
					"failing index reported",
				);
			}
		},
	},
	{
		name: "regionFromSelection with an empty mask fails without creating",
		run: (check) => {
			const canvas = fresh(4, 4);
			const idsBefore = canvas.regions.map((region) => region.id);
			const ops = [
				{
					type: "regionFromSelection",
					selection: {
						op: "intersect",
						operands: ["rect:0,0,1,1", "rect:3,3,1,1"],
					},
					mode: "create",
					regionId: "ghost",
				},
			] as unknown as BatchOperation[];
			try {
				applyOperations(canvas, ops);
				check.fail("expected empty selection to throw");
			} catch (error) {
				check.equal(
					(error as McAssetError).code,
					"EMPTY_SELECTION",
					"empty mask code",
				);
			}
			check.deepEqual(
				canvas.regions.map((region) => region.id),
				idsBefore,
				"no empty region created",
			);
		},
	},
	{
		name: "geometry vocabulary stays out of the typed core",
		run: (check) => {
			const canvas = fresh(8, 8);
			const before = snapshotAll(canvas);
			const ops = [
				{ id: "rs", type: "resize", width: 4, height: 4 },
			] as unknown as BatchOperation[];
			try {
				applyOperations(canvas, ops);
				check.fail("expected geometry to throw");
			} catch (error) {
				check.equal(
					(error as McAssetError).code,
					"UNKNOWN_OPERATION",
					"geometry never enters the batch",
				);
			}
			expectBuffersEqual(
				check,
				snapshotAll(canvas),
				before,
				"geometry refusal writes nothing",
			);
		},
	},
];
