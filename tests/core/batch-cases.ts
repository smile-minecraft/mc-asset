import { applyOperations, type BatchOperation } from "../../src/core/batch.ts";
import { addLayer, createCanvas, getLayer } from "../../src/core/canvas.ts";
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
];
