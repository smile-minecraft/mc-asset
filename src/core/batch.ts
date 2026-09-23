import {
	addLayer,
	addRegion,
	getLayer,
	getRegion,
	setPixel,
	setRegionValue,
} from "./canvas.ts";
import type { ErrorCode } from "./errors.ts";
import { McAssetError } from "./errors.ts";
import {
	clearLayer,
	compositePixel,
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
import { evaluateSelectionExpr, type SelectionExpr } from "./selection.ts";
import type {
	PixelCanvas,
	PixelLayer,
	PixelRegion,
	Rect,
	RGBA,
} from "./types.ts";
import { validateCoordinate } from "./validate.ts";

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

/**
 * Optional write scope shared by the six pixel operations. Absent means
 * the whole canvas (existing behavior); present means only the selected
 * pixels are written and every unselected raw byte is restored verbatim.
 */
export interface PixelWriteScope {
	selection?: SelectionExpr;
}

export interface SetPixelOperation extends OperationBase, PixelWriteScope {
	type: "setPixel";
	layerId: string;
	x: number;
	y: number;
	color: RGBA;
}

export interface ClearPixelOperation extends OperationBase, PixelWriteScope {
	type: "clearPixel";
	layerId: string;
	x: number;
	y: number;
}

export interface DrawLineOperation extends OperationBase, PixelWriteScope {
	type: "drawLine";
	layerId: string;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	color: RGBA;
}

export interface DrawRectOperation extends OperationBase, PixelWriteScope {
	type: "drawRect";
	layerId: string;
	rect: Rect;
	color: RGBA;
}

export interface FillRectOperation extends OperationBase, PixelWriteScope {
	type: "fillRect";
	layerId: string;
	/**
	 * May be omitted only when selection is present: the fill covers the
	 * selection bounding box, clipped again by the selection itself.
	 */
	rect?: Rect;
	color: RGBA;
}

export interface FloodFillOperation extends OperationBase, PixelWriteScope {
	type: "floodFill";
	layerId: string;
	x: number;
	y: number;
	color: RGBA;
}

export interface StampTransform {
	flip?: "h" | "v";
	rotate?: 0 | 90 | 180 | 270;
}

/**
 * Copy a selected read scope within one layer. `source` decides which
 * pixels are read; the optional `selection` only clips the write. `to`
 * pins the transformed output's top-left; `offset` shifts it relative to
 * the source bounds; the two are mutually exclusive.
 */
export interface StampRectOperation extends OperationBase {
	type: "stampRect";
	layerId: string;
	source: SelectionExpr;
	to?: { x: number; y: number };
	offset?: { dx: number; dy: number };
	transform?: StampTransform;
	merge?: "replace" | "source-over";
	carryRegions?: boolean;
	selection?: SelectionExpr;
}

/** Build or replace a region mask from a selection read scope. */
export interface RegionFromSelectionOperation extends OperationBase {
	type: "regionFromSelection";
	selection: SelectionExpr;
	mode: "create" | "update";
	regionId?: string;
	name?: string;
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
	| SetRegionPixelOperation
	| StampRectOperation
	| RegionFromSelectionOperation;

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

function emptySelectionError(path: string): McAssetError {
	return new McAssetError(
		"EMPTY_SELECTION",
		"Selection matched no pixels, so the write was refused with no changes. Widen the read scope (rect, region, alpha, color, connected, or expression operands); source decides the read scope while selection only clips the write.",
		{ path },
	);
}

/**
 * Evaluate an optional write scope. Absent means the whole layer
 * (existing behavior). Present but empty is EMPTY_SELECTION: the caller
 * must not have written anything yet, so the batch rollback stays trivial.
 */
function resolveWriteMask(
	canvas: PixelCanvas,
	selection: SelectionExpr | undefined,
	path: string,
): Uint8Array | undefined {
	if (selection === undefined) {
		return undefined;
	}
	const evaluated = evaluateSelectionExpr(canvas, selection, path);
	if (evaluated.count === 0) {
		throw emptySelectionError(path);
	}
	return evaluated.mask;
}

/**
 * Run a single-layer pixel write, then restore every unselected raw byte
 * verbatim, including hidden RGB under A = 0. The restore is the scoping
 * mechanism: outside bytes are bit-identical by construction.
 */
function withWriteScope(
	canvas: PixelCanvas,
	layerId: string,
	mask: Uint8Array | undefined,
	write: () => void,
): void {
	if (mask === undefined) {
		write();
		return;
	}
	const layer = getLayer(canvas, layerId);
	const snapshot = layer.pixels.slice();
	write();
	const pixels = getLayer(canvas, layerId).pixels;
	const width = canvas.width;
	const height = canvas.height;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			if (mask[y * width + x] === 1) {
				continue;
			}
			const offset = (y * width + x) * 4;
			pixels[offset] = snapshot[offset] as number;
			pixels[offset + 1] = snapshot[offset + 1] as number;
			pixels[offset + 2] = snapshot[offset + 2] as number;
			pixels[offset + 3] = snapshot[offset + 3] as number;
		}
	}
}

function applyStampRect(canvas: PixelCanvas, op: StampRectOperation): void {
	assertLayerId(op.layerId);
	const layer = getLayer(canvas, op.layerId);
	if (op.source === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"stampRect needs source: the SelectionExpr deciding which pixels are read.",
			{ path: "source" },
		);
	}
	const hasTo = op.to !== undefined;
	const hasOffset = op.offset !== undefined;
	if (hasTo && hasOffset) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			"stampRect takes either to or offset, not both: source decides the read scope while selection only clips the write.",
			{ to: op.to, offset: op.offset },
		);
	}
	if (!hasTo && !hasOffset) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"stampRect needs to or offset for the destination origin.",
			{},
		);
	}
	const flip = op.transform?.flip ?? "none";
	if (flip !== "none" && flip !== "h" && flip !== "v") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			'stampRect flip must be "h" or "v".',
			{ flip },
		);
	}
	const rotate = op.transform?.rotate ?? 0;
	if (rotate !== 0 && rotate !== 90 && rotate !== 180 && rotate !== 270) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"stampRect rotate must be 0, 90, 180, or 270 clockwise.",
			{ rotate },
		);
	}
	const merge = op.merge ?? "replace";
	if (merge !== "replace" && merge !== "source-over") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			'stampRect merge must be "replace" or "source-over".',
			{ merge },
		);
	}
	const read = evaluateSelectionExpr(canvas, op.source, "source");
	if (read.count === 0) {
		throw emptySelectionError("source");
	}
	const bounds = read.bounds as Rect;
	// Snapshot the source layer first: source and destination may overlap,
	// and the result must equal copy-then-paste.
	const srcBytes = layer.pixels.slice();
	const width = canvas.width;
	const height = canvas.height;
	// Flip first, then rotate clockwise with integer index mapping; 90/270
	// swap the output dimensions. No float pivot anywhere.
	const mapCell = (lx: number, ly: number): { dx: number; dy: number } => {
		let x = flip === "h" ? bounds.width - 1 - lx : lx;
		let y = flip === "v" ? bounds.height - 1 - ly : ly;
		let w = bounds.width;
		let h = bounds.height;
		if (rotate === 90) {
			const nx = h - 1 - y;
			y = x;
			x = nx;
			w = bounds.height;
			h = bounds.width;
		} else if (rotate === 180) {
			x = w - 1 - x;
			y = h - 1 - y;
		} else if (rotate === 270) {
			const nx = y;
			y = w - 1 - x;
			x = nx;
			w = bounds.height;
			h = bounds.width;
		}
		void w;
		void h;
		return { dx: x, dy: y };
	};
	let originX: number;
	let originY: number;
	if (hasTo) {
		const to = op.to as { x: number; y: number };
		validateCoordinate(to.x, "x");
		validateCoordinate(to.y, "y");
		originX = to.x;
		originY = to.y;
	} else {
		const offset = op.offset as { dx: number; dy: number };
		validateCoordinate(offset.dx, "x");
		validateCoordinate(offset.dy, "y");
		originX = bounds.x + offset.dx;
		originY = bounds.y + offset.dy;
	}
	const clip = resolveWriteMask(canvas, op.selection, "selection");
	const writes: Array<{ src: number; dst: number }> = [];
	for (let sy = bounds.y; sy < bounds.y + bounds.height; sy += 1) {
		for (let sx = bounds.x; sx < bounds.x + bounds.width; sx += 1) {
			if (read.mask[sy * width + sx] !== 1) {
				continue;
			}
			const mapped = mapCell(sx - bounds.x, sy - bounds.y);
			const dx = originX + mapped.dx;
			const dy = originY + mapped.dy;
			if (dx < 0 || dy < 0 || dx >= width || dy >= height) {
				throw new McAssetError(
					"OUT_OF_BOUNDS",
					"stampRect destination is outside the canvas; no pixels were written.",
					{
						to: hasTo ? op.to : undefined,
						offset: hasOffset ? op.offset : undefined,
						width,
						height,
					},
				);
			}
			if (clip !== undefined && clip[dy * width + dx] !== 1) {
				continue;
			}
			writes.push({
				src: (sy * width + sx) * 4,
				dst: (dy * width + dx) * 4,
			});
		}
	}
	const pixels = getLayer(canvas, op.layerId).pixels;
	for (const write of writes) {
		if (merge === "replace") {
			pixels[write.dst] = srcBytes[write.src] as number;
			pixels[write.dst + 1] = srcBytes[write.src + 1] as number;
			pixels[write.dst + 2] = srcBytes[write.src + 2] as number;
			pixels[write.dst + 3] = srcBytes[write.src + 3] as number;
		} else {
			compositePixel(srcBytes, write.src, pixels, write.dst, pixels, write.dst);
		}
	}
	if (op.carryRegions === true) {
		for (const region of canvas.regions) {
			const srcMask = region.mask.slice();
			for (let sy = bounds.y; sy < bounds.y + bounds.height; sy += 1) {
				for (let sx = bounds.x; sx < bounds.x + bounds.width; sx += 1) {
					if (read.mask[sy * width + sx] !== 1) {
						continue;
					}
					const mapped = mapCell(sx - bounds.x, sy - bounds.y);
					const dx = originX + mapped.dx;
					const dy = originY + mapped.dy;
					if (clip !== undefined && clip[dy * width + dx] !== 1) {
						continue;
					}
					// Selected source bits map onto the destination; the
					// source bits are retained and no region id is copied.
					region.mask[dy * width + dx] = srcMask[sy * width + sx] as number;
				}
			}
		}
	}
}

function applyRegionFromSelection(
	canvas: PixelCanvas,
	op: RegionFromSelectionOperation,
): void {
	if (op.selection === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"regionFromSelection needs selection: the SelectionExpr to convert.",
			{ path: "selection" },
		);
	}
	if (op.mode !== "create" && op.mode !== "update") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			'regionFromSelection mode must be "create" or "update".',
			{ mode: op.mode },
		);
	}
	if (op.regionId !== undefined && typeof op.regionId !== "string") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"regionFromSelection regionId must be a string when provided.",
			{ regionId: op.regionId },
		);
	}
	const read = evaluateSelectionExpr(canvas, op.selection, "selection");
	if (read.count === 0) {
		throw emptySelectionError("selection");
	}
	if (op.mode === "create") {
		const region = addRegion(canvas, {
			...(op.regionId !== undefined ? { id: op.regionId } : {}),
			...(op.name !== undefined ? { name: op.name } : {}),
		});
		region.mask.set(read.mask);
		return;
	}
	if (op.regionId === undefined || op.regionId === "") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"regionFromSelection update needs regionId of an existing region.",
			{ path: "regionId" },
		);
	}
	// REGION_NOT_FOUND when the id does not exist; the mask replaces
	// wholesale while id, metadata, and array position are preserved.
	const region = getRegion(canvas, op.regionId);
	region.mask.set(read.mask);
	if (op.name !== undefined) {
		renameRegion(canvas, op.regionId, op.name);
	}
}

function dispatch(canvas: PixelCanvas, op: BatchOperation): void {
	switch (op.type) {
		case "setPixel": {
			assertLayerId(op.layerId);
			const mask = resolveWriteMask(canvas, op.selection, "selection");
			withWriteScope(canvas, op.layerId, mask, () => {
				setPixel(canvas, op.layerId, op.x, op.y, op.color);
			});
			return;
		}
		case "clearPixel": {
			assertLayerId(op.layerId);
			const mask = resolveWriteMask(canvas, op.selection, "selection");
			withWriteScope(canvas, op.layerId, mask, () => {
				clearPixel(canvas, op.layerId, op.x, op.y);
			});
			return;
		}
		case "drawLine": {
			assertLayerId(op.layerId);
			const mask = resolveWriteMask(canvas, op.selection, "selection");
			withWriteScope(canvas, op.layerId, mask, () => {
				drawLine(canvas, op.layerId, op.x0, op.y0, op.x1, op.y1, op.color);
			});
			return;
		}
		case "drawRect": {
			assertLayerId(op.layerId);
			const mask = resolveWriteMask(canvas, op.selection, "selection");
			withWriteScope(canvas, op.layerId, mask, () => {
				drawRect(canvas, op.layerId, op.rect, op.color);
			});
			return;
		}
		case "fillRect": {
			assertLayerId(op.layerId);
			if (op.rect === undefined) {
				if (op.selection === undefined) {
					throw new McAssetError(
						"INVALID_ARGUMENT",
						"fillRect needs rect; rect may only be omitted when selection is present.",
						{ path: "rect" },
					);
				}
				const evaluated = evaluateSelectionExpr(
					canvas,
					op.selection,
					"selection",
				);
				if (evaluated.count === 0) {
					throw emptySelectionError("selection");
				}
				const bounds = evaluated.bounds as Rect;
				withWriteScope(canvas, op.layerId, evaluated.mask, () => {
					fillRect(canvas, op.layerId, bounds, op.color);
				});
				return;
			}
			const mask = resolveWriteMask(canvas, op.selection, "selection");
			withWriteScope(canvas, op.layerId, mask, () => {
				fillRect(canvas, op.layerId, op.rect as Rect, op.color);
			});
			return;
		}
		case "floodFill": {
			assertLayerId(op.layerId);
			const mask = resolveWriteMask(canvas, op.selection, "selection");
			withWriteScope(canvas, op.layerId, mask, () => {
				floodFill(canvas, op.layerId, op.x, op.y, op.color);
			});
			return;
		}
		case "stampRect":
			applyStampRect(canvas, op);
			return;
		case "regionFromSelection":
			applyRegionFromSelection(canvas, op);
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
