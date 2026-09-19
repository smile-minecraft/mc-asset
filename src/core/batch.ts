import { addLayer, addRegion, setPixel, setRegionValue } from "./canvas.ts";
import type { ErrorCode } from "./errors.ts";
import { McAssetError } from "./errors.ts";
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
} from "./layers.ts";
import { clearPixel, drawLine, drawRect, fillRect, floodFill } from "./ops.ts";
import type {
	PixelCanvas,
	PixelLayer,
	PixelRegion,
	Rect,
	RGBA,
} from "./types.ts";

/**
 * Typed batch operations over the pixel primitives (§28) with atomic
 * transaction semantics (§30) and per-operation reporting (§103).
 *
 * The operation vocabulary mirrors the primitive signatures: setPixel,
 * clearPixel, drawLine, drawRect, fillRect, floodFill, plus the layer and
 * region vocabulary (create/remove/rename/reorder/duplicate/merge/clear/
 * fill/move layers, create/remove/rename/reorder regions, setRegionPixel).
 * Geometry operations (resize, crop, pad, translate, flip, rotate) are
 * deliberately absent: they travel through the transform command, never
 * the batch. JSON parsing (hex colors, from/to pairs) is left to the CLI
 * layer; this module only accepts typed objects.
 */

interface OperationBase {
	id?: string;
}

export interface SetPixelOperation extends OperationBase {
	type: "setPixel";
	layerId: string;
	x: number;
	y: number;
	color: RGBA;
}

export interface ClearPixelOperation extends OperationBase {
	type: "clearPixel";
	layerId: string;
	x: number;
	y: number;
}

export interface DrawLineOperation extends OperationBase {
	type: "drawLine";
	layerId: string;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	color: RGBA;
}

export interface DrawRectOperation extends OperationBase {
	type: "drawRect";
	layerId: string;
	rect: Rect;
	color: RGBA;
}

export interface FillRectOperation extends OperationBase {
	type: "fillRect";
	layerId: string;
	rect: Rect;
	color: RGBA;
}

export interface FloodFillOperation extends OperationBase {
	type: "floodFill";
	layerId: string;
	x: number;
	y: number;
	color: RGBA;
}

export interface CreateLayerOperation extends OperationBase {
	type: "createLayer";
	layerId?: string;
	name?: string;
}

export interface RemoveLayerOperation extends OperationBase {
	type: "removeLayer";
	layerId: string;
}

export interface RenameLayerOperation extends OperationBase {
	type: "renameLayer";
	layerId: string;
	name: string;
}

export interface ReorderLayerOperation extends OperationBase {
	type: "reorderLayer";
	layerId: string;
	toIndex: number;
}

export interface DuplicateLayerOperation extends OperationBase {
	type: "duplicateLayer";
	layerId: string;
	newLayerId?: string;
	name?: string;
}

export interface MergeLayerOperation extends OperationBase {
	type: "mergeLayer";
	sourceId: string;
	targetId: string;
}

export interface ClearLayerOperation extends OperationBase {
	type: "clearLayer";
	layerId: string;
}

export interface FillLayerOperation extends OperationBase {
	type: "fillLayer";
	layerId: string;
	color: RGBA;
}

export interface MoveLayerOperation extends OperationBase {
	type: "moveLayer";
	layerId: string;
	dx: number;
	dy: number;
}

export interface CreateRegionOperation extends OperationBase {
	type: "createRegion";
	regionId?: string;
	name?: string;
}

export interface RemoveRegionOperation extends OperationBase {
	type: "removeRegion";
	regionId: string;
}

export interface RenameRegionOperation extends OperationBase {
	type: "renameRegion";
	regionId: string;
	name: string;
}

export interface ReorderRegionOperation extends OperationBase {
	type: "reorderRegion";
	regionId: string;
	toIndex: number;
}

export interface SetRegionPixelOperation extends OperationBase {
	type: "setRegionPixel";
	regionId: string;
	x: number;
	y: number;
	value: number;
}

export type BatchOperation =
	| SetPixelOperation
	| ClearPixelOperation
	| DrawLineOperation
	| DrawRectOperation
	| FillRectOperation
	| FloodFillOperation
	| CreateLayerOperation
	| RemoveLayerOperation
	| RenameLayerOperation
	| ReorderLayerOperation
	| DuplicateLayerOperation
	| MergeLayerOperation
	| ClearLayerOperation
	| FillLayerOperation
	| MoveLayerOperation
	| CreateRegionOperation
	| RemoveRegionOperation
	| RenameRegionOperation
	| ReorderRegionOperation
	| SetRegionPixelOperation;

export interface AppliedOperationReport {
	index: number;
	id?: string;
	status: "applied";
}

export interface FailedOperationReport {
	index: number;
	id?: string;
	status: "failed";
	error: {
		code: ErrorCode;
		message: string;
		details: unknown;
	};
}

export type BatchOperationReport =
	| AppliedOperationReport
	| FailedOperationReport;

export interface BatchReport {
	applied: number;
	failed: number;
	operations: BatchOperationReport[];
}

export interface ApplyOperationsOptions {
	/** Default true: first failure rolls everything back and throws. */
	atomic?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stripCodePrefix(message: string): string {
	return message.replace(/^\[[A-Z0-9_]+\] /, "");
}

function operationIdOf(op: unknown): string | undefined {
	if (isRecord(op) && typeof op.id === "string") {
		return op.id;
	}
	return undefined;
}

function describeType(op: unknown): unknown {
	if (isRecord(op)) {
		return op.type;
	}
	return undefined;
}

function invalidIdError(rawId: unknown): McAssetError {
	return new McAssetError(
		"INVALID_ARGUMENT",
		"Operation id must be a string when provided.",
		{ operationId: rawId },
	);
}

function unknownOperationError(op: unknown): McAssetError {
	return new McAssetError(
		"UNKNOWN_OPERATION",
		`Unknown operation type: ${String(describeType(op))}.`,
		{ type: describeType(op) },
	);
}

function duplicateIdError(operationId: string): McAssetError {
	return new McAssetError(
		"DUPLICATE_OPERATION_ID",
		`Duplicate operation id in one batch: ${operationId}.`,
		{ operationId },
	);
}

/** Merge the cause's details with the batch position (§103). */
function withBatchPosition(
	cause: McAssetError,
	operationIndex: number,
	operationId: string | undefined,
): McAssetError {
	let details: Record<string, unknown>;
	if (isRecord(cause.details)) {
		details = { ...cause.details };
	} else if (cause.details === undefined) {
		details = {};
	} else {
		details = { cause: cause.details };
	}
	details.operationIndex = operationIndex;
	if (operationId !== undefined) {
		details.operationId = operationId;
	}
	return new McAssetError(cause.code, stripCodePrefix(cause.message), details);
}

function wrapUnexpected(
	error: unknown,
	operationIndex: number,
	operationId: string | undefined,
): McAssetError {
	if (error instanceof McAssetError) {
		return withBatchPosition(error, operationIndex, operationId);
	}
	const details: Record<string, unknown> = { operationIndex };
	if (operationId !== undefined) {
		details.operationId = operationId;
	}
	return new McAssetError("INTERNAL_ERROR", String(error), details);
}

function hexByte(value: number): string {
	const digits = "0123456789abcdef";
	return digits[(value >> 4) & 15] + digits[value & 15];
}

function toHexColor(color: RGBA): string {
	return `#${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}${hexByte(color.a)}`;
}

function dispatch(canvas: PixelCanvas, op: BatchOperation): void {
	switch (op.type) {
		case "setPixel":
			assertLayerId(op.layerId);
			setPixel(canvas, op.layerId, op.x, op.y, op.color);
			return;
		case "clearPixel":
			assertLayerId(op.layerId);
			clearPixel(canvas, op.layerId, op.x, op.y);
			return;
		case "drawLine":
			assertLayerId(op.layerId);
			drawLine(canvas, op.layerId, op.x0, op.y0, op.x1, op.y1, op.color);
			return;
		case "drawRect":
			assertLayerId(op.layerId);
			drawRect(canvas, op.layerId, op.rect, op.color);
			return;
		case "fillRect":
			assertLayerId(op.layerId);
			fillRect(canvas, op.layerId, op.rect, op.color);
			return;
		case "floodFill":
			assertLayerId(op.layerId);
			floodFill(canvas, op.layerId, op.x, op.y, op.color);
			return;
		case "createLayer":
			addLayer(canvas, {
				...(op.layerId !== undefined ? { id: op.layerId } : {}),
				...(op.name !== undefined ? { name: op.name } : {}),
			});
			return;
		case "removeLayer":
			assertLayerId(op.layerId);
			removeLayer(canvas, op.layerId);
			return;
		case "renameLayer":
			assertLayerId(op.layerId);
			renameLayer(canvas, op.layerId, op.name);
			return;
		case "reorderLayer":
			assertLayerId(op.layerId);
			reorderLayer(canvas, op.layerId, op.toIndex);
			return;
		case "duplicateLayer":
			assertLayerId(op.layerId);
			duplicateLayer(canvas, op.layerId, {
				...(op.newLayerId !== undefined ? { id: op.newLayerId } : {}),
				...(op.name !== undefined ? { name: op.name } : {}),
			});
			return;
		case "mergeLayer":
			mergeLayer(canvas, op.sourceId, op.targetId);
			return;
		case "clearLayer":
			assertLayerId(op.layerId);
			clearLayer(canvas, op.layerId);
			return;
		case "fillLayer":
			assertLayerId(op.layerId);
			fillLayer(canvas, op.layerId, toHexColor(op.color));
			return;
		case "moveLayer":
			assertLayerId(op.layerId);
			moveLayer(canvas, op.layerId, op.dx, op.dy);
			return;
		case "createRegion":
			addRegion(canvas, {
				...(op.regionId !== undefined ? { id: op.regionId } : {}),
				...(op.name !== undefined ? { name: op.name } : {}),
			});
			return;
		case "removeRegion":
			removeRegion(canvas, op.regionId);
			return;
		case "renameRegion":
			renameRegion(canvas, op.regionId, op.name);
			return;
		case "reorderRegion":
			reorderRegion(canvas, op.regionId, op.toIndex);
			return;
		case "setRegionPixel":
			setRegionValue(canvas, op.regionId, op.x, op.y, op.value);
			return;
		default:
			throw unknownOperationError(op);
	}
}

function assertLayerId(layerId: unknown): void {
	if (typeof layerId !== "string") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Operation layerId must be a string.",
			{ layerId },
		);
	}
}

function appliedEntry(
	index: number,
	operationId: string | undefined,
): AppliedOperationReport {
	if (operationId === undefined) {
		return { index, status: "applied" };
	}
	return { index, id: operationId, status: "applied" };
}

function failedEntry(
	index: number,
	operationId: string | undefined,
	error: McAssetError,
): FailedOperationReport {
	const reportError = {
		code: error.code,
		message: stripCodePrefix(error.message),
		details: error.details,
	};
	if (operationId === undefined) {
		return { index, status: "failed", error: reportError };
	}
	return { index, id: operationId, status: "failed", error: reportError };
}

/**
 * Apply typed operations in order. Atomic (default) rolls the canvas back
 * to its pre-batch bytes on the first failure and rethrows the original
 * error code with operationIndex/operationId in details (§103); it never
 * throws TRANSACTION_FAILED. Non-atomic runs every operation and returns
 * per-operation statuses with applied/failed counts.
 */
export function applyOperations(
	canvas: PixelCanvas,
	operations: BatchOperation[],
	options?: ApplyOperationsOptions,
): BatchReport {
	if (!Array.isArray(operations)) {
		throw new McAssetError("INVALID_ARGUMENT", "Operations must be an array.", {
			operations,
		});
	}
	const atomic = options?.atomic ?? true;
	// Structural snapshot before the first write: layer and region ops can
	// add, remove, or reorder entries, so the rollback restores the whole
	// layer/region lists (deep clones), not just pixel bytes. Dimensions
	// never change on this path, so width/height need no restore.
	const snapshotLayers: PixelLayer[] = canvas.layers.map((layer) => ({
		...layer,
		pixels: layer.pixels.slice(),
		...(layer.metadata !== undefined
			? { metadata: { ...layer.metadata } }
			: {}),
	}));
	const snapshotRegions: PixelRegion[] = canvas.regions.map((region) => ({
		...region,
		mask: region.mask.slice(),
		...(region.metadata !== undefined
			? { metadata: { ...region.metadata } }
			: {}),
	}));
	const rollback = (): void => {
		canvas.layers = snapshotLayers.map((layer) => ({
			...layer,
			pixels: layer.pixels.slice(),
			...(layer.metadata !== undefined
				? { metadata: { ...layer.metadata } }
				: {}),
		}));
		canvas.regions = snapshotRegions.map((region) => ({
			...region,
			mask: region.mask.slice(),
			...(region.metadata !== undefined
				? { metadata: { ...region.metadata } }
				: {}),
		}));
	};
	const seenIds = new Set<string>();
	const reports: BatchOperationReport[] = [];
	let applied = 0;
	let failed = 0;
	for (let index = 0; index < operations.length; index += 1) {
		const op = operations[index] as BatchOperation;
		const rawId = isRecord(op) ? op.id : undefined;
		if (rawId !== undefined && typeof rawId !== "string") {
			const error = withBatchPosition(invalidIdError(rawId), index, undefined);
			if (atomic) {
				rollback();
				throw error;
			}
			reports.push(failedEntry(index, undefined, error));
			failed += 1;
			continue;
		}
		const operationId = operationIdOf(op);
		if (operationId !== undefined) {
			if (seenIds.has(operationId)) {
				const error = withBatchPosition(
					duplicateIdError(operationId),
					index,
					operationId,
				);
				if (atomic) {
					rollback();
					throw error;
				}
				reports.push(failedEntry(index, operationId, error));
				failed += 1;
				continue;
			}
			seenIds.add(operationId);
		}
		try {
			if (!isRecord(op) || typeof op.type !== "string") {
				throw unknownOperationError(op);
			}
			dispatch(canvas, op);
		} catch (error) {
			const enriched = wrapUnexpected(error, index, operationId);
			if (atomic) {
				rollback();
				throw enriched;
			}
			reports.push(failedEntry(index, operationId, enriched));
			failed += 1;
			continue;
		}
		reports.push(appliedEntry(index, operationId));
		applied += 1;
	}
	return { applied, failed, operations: reports };
}
