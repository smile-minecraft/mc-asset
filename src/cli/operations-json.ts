import type { BatchOperation } from "../core/batch.ts";
import { McAssetError } from "../core/errors.ts";
import type { SelectionExpr } from "../core/selection.ts";
import type { Rect, RGBA } from "../core/types.ts";

/**
 * Batch-operations JSON seam (§29/§103 authoring shape to typed core ops).
 *
 * The CLI accepts the agent-facing JSON vocabulary: hex color strings,
 * from/to coordinate pairs, and an optional layerId. Anything the typed
 * core cannot take fails here as INVALID_ARGUMENT with a field path in
 * details (for example "operations[2].color"), so agents never have to
 * parse human text. Unknown operation kinds are INVALID_ARGUMENT at this
 * seam; the typed core keeps its own UNKNOWN_OPERATION for direct API
 * misuse.
 */

const KNOWN_TYPES: ReadonlySet<string> = new Set([
	"setPixel",
	"clearPixel",
	"drawLine",
	"drawRect",
	"fillRect",
	"floodFill",
	"createLayer",
	"removeLayer",
	"renameLayer",
	"reorderLayer",
	"duplicateLayer",
	"mergeLayer",
	"clearLayer",
	"fillLayer",
	"moveLayer",
	"createRegion",
	"removeRegion",
	"renameRegion",
	"reorderRegion",
	"setRegionPixel",
	"stampRect",
	"regionFromSelection",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function invalid(
	path: string,
	message: string,
	received?: unknown,
): McAssetError {
	const details: Record<string, unknown> = { path };
	if (received !== undefined) {
		details.received = received;
	}
	return new McAssetError("INVALID_ARGUMENT", message, details);
}

function takeInt(value: unknown, path: string, what: string): number {
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw invalid(path, `${what} must be an integer, without rounding.`, value);
	}
	return value;
}

function nibble(code: number): number {
	if (code >= 48 && code <= 57) {
		return code - 48;
	}
	if (code >= 65 && code <= 70) {
		return code - 65 + 10;
	}
	if (code >= 97 && code <= 102) {
		return code - 97 + 10;
	}
	return -1;
}

function takeColor(value: unknown, path: string): RGBA {
	if (value === "transparent") {
		return { r: 0, g: 0, b: 0, a: 0 };
	}
	if (typeof value !== "string") {
		throw invalid(
			path,
			"Color must be transparent, #RRGGBB, or #RRGGBBAA.",
			value,
		);
	}
	const hex = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(value);
	if (hex === null || hex[1] === undefined) {
		throw invalid(
			path,
			"Color must be transparent, #RRGGBB, or #RRGGBBAA.",
			value,
		);
	}
	const digits = hex[1];
	const byte = (index: number): number =>
		nibble(digits.charCodeAt(index)) * 16 +
		nibble(digits.charCodeAt(index + 1));
	return {
		r: byte(0),
		g: byte(2),
		b: byte(4),
		a: digits.length === 8 ? byte(6) : 255,
	};
}

function takePoint(
	value: unknown,
	path: string,
	what: string,
): { x: number; y: number } {
	if (!Array.isArray(value) || value.length !== 2) {
		throw invalid(path, `${what} must be a [x, y] pair of integers.`, value);
	}
	return {
		x: takeInt(value[0], `${path}[0]`, `${what} x`),
		y: takeInt(value[1], `${path}[1]`, `${what} y`),
	};
}

function takeRect(value: unknown, path: string): Rect {
	if (!isRecord(value)) {
		throw invalid(
			path,
			"Rect must be an object with x, y, width, and height.",
			value,
		);
	}
	const rect: Rect = {
		x: takeInt(value.x, `${path}.x`, "Rect x"),
		y: takeInt(value.y, `${path}.y`, "Rect y"),
		width: takeInt(value.width, `${path}.width`, "Rect width"),
		height: takeInt(value.height, `${path}.height`, "Rect height"),
	};
	if (rect.width < 1 || rect.height < 1) {
		throw invalid(path, "Rect width and height must be at least 1.", value);
	}
	return rect;
}

function takeLayerId(
	op: Record<string, unknown>,
	path: string,
	defaultLayerId: string | undefined,
): string {
	const raw = op.layerId;
	if (raw === undefined) {
		if (defaultLayerId === undefined) {
			throw invalid(
				`${path}.layerId`,
				"Operation layerId is missing and the canvas has more than one layer; set layerId explicitly.",
				op,
			);
		}
		return defaultLayerId;
	}
	if (typeof raw !== "string" || raw === "") {
		throw invalid(
			`${path}.layerId`,
			"Operation layerId must be a non-empty string.",
			raw,
		);
	}
	return raw;
}

function attachId<T extends object>(
	op: T,
	id: string | undefined,
): T & { id?: string } {
	return id === undefined ? op : { ...op, id };
}

function takeId(op: Record<string, unknown>, path: string): string | undefined {
	const raw = op.id;
	if (raw === undefined) {
		return undefined;
	}
	if (typeof raw !== "string") {
		throw invalid(
			`${path}.id`,
			"Operation id must be a string when provided.",
			raw,
		);
	}
	return raw;
}

function takeOptionalId(
	op: Record<string, unknown>,
	field: string,
	path: string,
	what: string,
): string | undefined {
	const raw = op[field];
	if (raw === undefined) {
		return undefined;
	}
	if (typeof raw !== "string" || raw === "") {
		throw invalid(
			`${path}.${field}`,
			`${what} must be a non-empty string when provided.`,
			raw,
		);
	}
	return raw;
}

function takeName(
	op: Record<string, unknown>,
	path: string,
	what: string,
): string {
	const raw = op.name;
	if (typeof raw !== "string" || raw === "") {
		throw invalid(`${path}.name`, `${what} must be a non-empty string.`, raw);
	}
	return raw;
}

function takeOptionalName(
	op: Record<string, unknown>,
	path: string,
	what: string,
): string | undefined {
	if (op.name === undefined) {
		return undefined;
	}
	return takeName(op, path, what);
}

function takeToIndex(op: Record<string, unknown>, path: string): number {
	const at = takeInt(op.toIndex, `${path}.toIndex`, "Stack position");
	if (at < 0) {
		throw invalid(
			`${path}.toIndex`,
			"Stack position must be 0 or a positive integer.",
			op.toIndex,
		);
	}
	return at;
}

function takeMaskValue(op: Record<string, unknown>, path: string): number {
	const at = takeInt(op.value, `${path}.value`, "Region mask value");
	if (at !== 0 && at !== 1) {
		throw invalid(
			`${path}.value`,
			"Region mask value must be 0 (outside) or 1 (inside).",
			op.value,
		);
	}
	return at;
}

function takeSelectionValue(value: unknown, path: string): SelectionExpr {
	if (typeof value === "string") {
		if (value.length === 0) {
			throw invalid(
				path,
				"Selection must be a non-empty atom string or an expression object.",
				value,
			);
		}
		return value;
	}
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as SelectionExpr;
	}
	throw invalid(
		path,
		"Selection must be an atom string or an expression object with op and operands.",
		value,
	);
}

function takeRequiredSelection(
	op: Record<string, unknown>,
	path: string,
	field: string,
): SelectionExpr {
	if (op[field] === undefined) {
		throw invalid(
			`${path}.${field}`,
			`Operation needs ${field}: the SelectionExpr deciding the read scope.`,
			op,
		);
	}
	return takeSelectionValue(op[field], `${path}.${field}`);
}

function takeOptionalSelection(
	op: Record<string, unknown>,
	path: string,
): SelectionExpr | undefined {
	if (op.selection === undefined) {
		return undefined;
	}
	return takeSelectionValue(op.selection, `${path}.selection`);
}

function takeToPoint(
	op: Record<string, unknown>,
	path: string,
): { x: number; y: number } | undefined {
	if (op.to === undefined) {
		return undefined;
	}
	const raw = op.to;
	if (!isRecord(raw)) {
		throw invalid(
			`${path}.to`,
			"Destination to must be an object with x and y.",
			raw,
		);
	}
	return {
		x: takeInt(raw.x, `${path}.to.x`, "Destination x"),
		y: takeInt(raw.y, `${path}.to.y`, "Destination y"),
	};
}

function takeOffsetPoint(
	op: Record<string, unknown>,
	path: string,
): { dx: number; dy: number } | undefined {
	if (op.offset === undefined) {
		return undefined;
	}
	const raw = op.offset;
	if (!isRecord(raw)) {
		throw invalid(
			`${path}.offset`,
			"Destination offset must be an object with dx and dy.",
			raw,
		);
	}
	return {
		dx: takeInt(raw.dx, `${path}.offset.dx`, "Offset dx"),
		dy: takeInt(raw.dy, `${path}.offset.dy`, "Offset dy"),
	};
}

function takeStampTransform(
	op: Record<string, unknown>,
	path: string,
): { flip?: "h" | "v"; rotate?: 0 | 90 | 180 | 270 } | undefined {
	if (op.transform === undefined) {
		return undefined;
	}
	const raw = op.transform;
	if (!isRecord(raw)) {
		throw invalid(
			`${path}.transform`,
			"Stamp transform must be an object with optional flip and rotate.",
			raw,
		);
	}
	let flip: "h" | "v" | undefined;
	if (raw.flip !== undefined) {
		if (raw.flip !== "h" && raw.flip !== "v") {
			throw invalid(
				`${path}.transform.flip`,
				'Stamp flip must be "h" or "v".',
				raw.flip,
			);
		}
		flip = raw.flip;
	}
	let rotate: 0 | 90 | 180 | 270 | undefined;
	if (raw.rotate !== undefined) {
		if (
			raw.rotate !== 0 &&
			raw.rotate !== 90 &&
			raw.rotate !== 180 &&
			raw.rotate !== 270
		) {
			throw invalid(
				`${path}.transform.rotate`,
				"Stamp rotate must be 0, 90, 180, or 270 clockwise.",
				raw.rotate,
			);
		}
		rotate = raw.rotate;
	}
	return {
		...(flip !== undefined ? { flip } : {}),
		...(rotate !== undefined ? { rotate } : {}),
	};
}

function takeStampMerge(
	op: Record<string, unknown>,
	path: string,
): "replace" | "source-over" | undefined {
	if (op.merge === undefined) {
		return undefined;
	}
	if (op.merge !== "replace" && op.merge !== "source-over") {
		throw invalid(
			`${path}.merge`,
			'Stamp merge must be "replace" or "source-over".',
			op.merge,
		);
	}
	return op.merge;
}

function takeCarryRegions(
	op: Record<string, unknown>,
	path: string,
): boolean | undefined {
	if (op.carryRegions === undefined) {
		return undefined;
	}
	if (typeof op.carryRegions !== "boolean") {
		throw invalid(
			`${path}.carryRegions`,
			"Stamp carryRegions must be a boolean when provided.",
			op.carryRegions,
		);
	}
	return op.carryRegions;
}

function takeRegionMode(
	op: Record<string, unknown>,
	path: string,
): "create" | "update" {
	if (op.mode !== "create" && op.mode !== "update") {
		throw invalid(
			`${path}.mode`,
			'regionFromSelection mode must be "create" or "update".',
			op.mode,
		);
	}
	return op.mode;
}

function takeRegionId(op: Record<string, unknown>, path: string): string {
	const raw = op.regionId;
	if (typeof raw !== "string" || raw === "") {
		throw invalid(
			`${path}.regionId`,
			"Operation regionId must be a non-empty string.",
			raw,
		);
	}
	return raw;
}

function parseOneOperation(
	item: unknown,
	path: string,
	defaultLayerId: string | undefined,
): BatchOperation {
	if (!isRecord(item)) {
		throw invalid(path, "Each operation must be an object.", item);
	}
	const rawType = item.type;
	if (typeof rawType !== "string" || !KNOWN_TYPES.has(rawType)) {
		throw invalid(
			`${path}.type`,
			`Unknown operation type: ${String(rawType)}. Pixel ops are setPixel, clearPixel, drawLine, drawRect, fillRect, floodFill; layer ops are createLayer, removeLayer, renameLayer, reorderLayer, duplicateLayer, mergeLayer, clearLayer, fillLayer, moveLayer; region ops are createRegion, removeRegion, renameRegion, reorderRegion, setRegionPixel; local-edit ops are stampRect, regionFromSelection. Geometry never enters the batch; use the transform command.`,
			rawType,
		);
	}
	const id = takeId(item, path);
	// Operations without a top-level layerId (regionFromSelection, mergeLayer,
	// and the region vocabulary) must parse on multi-layer canvases, so the
	// layer default resolves lazily inside the branches that declare it.
	const needLayerId = (): string => takeLayerId(item, path, defaultLayerId);
	switch (rawType) {
		case "setPixel": {
			const layerId = needLayerId();
			const selection = takeOptionalSelection(item, path);
			return attachId(
				{
					type: "setPixel" as const,
					layerId,
					x: takeInt(item.x, `${path}.x`, "Pixel x"),
					y: takeInt(item.y, `${path}.y`, "Pixel y"),
					color: takeColor(item.color, `${path}.color`),
					...(selection !== undefined ? { selection } : {}),
				},
				id,
			);
		}
		case "clearPixel": {
			const layerId = needLayerId();
			const selection = takeOptionalSelection(item, path);
			return attachId(
				{
					type: "clearPixel" as const,
					layerId,
					x: takeInt(item.x, `${path}.x`, "Pixel x"),
					y: takeInt(item.y, `${path}.y`, "Pixel y"),
					...(selection !== undefined ? { selection } : {}),
				},
				id,
			);
		}
		case "drawLine": {
			const layerId = needLayerId();
			const from = takePoint(item.from, `${path}.from`, "Line from");
			const to = takePoint(item.to, `${path}.to`, "Line to");
			const selection = takeOptionalSelection(item, path);
			return attachId(
				{
					type: "drawLine" as const,
					layerId,
					x0: from.x,
					y0: from.y,
					x1: to.x,
					y1: to.y,
					color: takeColor(item.color, `${path}.color`),
					...(selection !== undefined ? { selection } : {}),
				},
				id,
			);
		}
		case "drawRect": {
			const layerId = needLayerId();
			const selection = takeOptionalSelection(item, path);
			return attachId(
				{
					type: "drawRect" as const,
					layerId,
					rect: takeRect(item.rect, `${path}.rect`),
					color: takeColor(item.color, `${path}.color`),
					...(selection !== undefined ? { selection } : {}),
				},
				id,
			);
		}
		case "fillRect": {
			const layerId = needLayerId();
			const selection = takeOptionalSelection(item, path);
			if (item.rect === undefined) {
				if (selection === undefined) {
					// Same error as before the selection add-on: rect stays
					// required when no selection backs the fill.
					throw invalid(
						`${path}.rect`,
						"Rect must be an object with x, y, width, and height.",
						item.rect,
					);
				}
				return attachId(
					{
						type: "fillRect" as const,
						layerId,
						color: takeColor(item.color, `${path}.color`),
						selection,
					},
					id,
				);
			}
			return attachId(
				{
					type: "fillRect" as const,
					layerId,
					rect: takeRect(item.rect, `${path}.rect`),
					color: takeColor(item.color, `${path}.color`),
					...(selection !== undefined ? { selection } : {}),
				},
				id,
			);
		}
		case "floodFill": {
			const layerId = needLayerId();
			const selection = takeOptionalSelection(item, path);
			return attachId(
				{
					type: "floodFill" as const,
					layerId,
					x: takeInt(item.x, `${path}.x`, "Pixel x"),
					y: takeInt(item.y, `${path}.y`, "Pixel y"),
					color: takeColor(item.color, `${path}.color`),
					...(selection !== undefined ? { selection } : {}),
				},
				id,
			);
		}
		case "createLayer": {
			const createdId = takeOptionalId(item, "layerId", path, "Layer id");
			const createdName = takeOptionalName(item, path, "Layer");
			return attachId(
				{
					type: "createLayer" as const,
					...(createdId !== undefined ? { layerId: createdId } : {}),
					...(createdName !== undefined ? { name: createdName } : {}),
				},
				id,
			);
		}
		case "removeLayer":
			return attachId(
				{ type: "removeLayer" as const, layerId: needLayerId() },
				id,
			);
		case "renameLayer":
			return attachId(
				{
					type: "renameLayer" as const,
					layerId: needLayerId(),
					name: takeName(item, path, "Layer"),
				},
				id,
			);
		case "reorderLayer":
			return attachId(
				{
					type: "reorderLayer" as const,
					layerId: needLayerId(),
					toIndex: takeToIndex(item, path),
				},
				id,
			);
		case "duplicateLayer": {
			const layerId = needLayerId();
			const copyId = takeOptionalId(item, "newLayerId", path, "New layer id");
			const copyName = takeOptionalName(item, path, "Layer");
			return attachId(
				{
					type: "duplicateLayer" as const,
					layerId,
					...(copyId !== undefined ? { newLayerId: copyId } : {}),
					...(copyName !== undefined ? { name: copyName } : {}),
				},
				id,
			);
		}
		case "mergeLayer": {
			const sourceId = takeOptionalId(item, "sourceId", path, "Source layer");
			const targetId = takeOptionalId(item, "targetId", path, "Target layer");
			if (sourceId === undefined || targetId === undefined) {
				throw invalid(
					`${path}.sourceId`,
					"mergeLayer needs both sourceId and targetId.",
					item,
				);
			}
			return attachId({ type: "mergeLayer" as const, sourceId, targetId }, id);
		}
		case "clearLayer":
			return attachId(
				{ type: "clearLayer" as const, layerId: needLayerId() },
				id,
			);
		case "fillLayer":
			return attachId(
				{
					type: "fillLayer" as const,
					layerId: needLayerId(),
					color: takeColor(item.color, `${path}.color`),
				},
				id,
			);
		case "moveLayer":
			return attachId(
				{
					type: "moveLayer" as const,
					layerId: needLayerId(),
					dx: takeInt(item.dx, `${path}.dx`, "Move dx"),
					dy: takeInt(item.dy, `${path}.dy`, "Move dy"),
				},
				id,
			);
		case "createRegion": {
			const createdRegionId = takeOptionalId(
				item,
				"regionId",
				path,
				"Region id",
			);
			const createdRegionName = takeOptionalName(item, path, "Region");
			return attachId(
				{
					type: "createRegion" as const,
					...(createdRegionId !== undefined
						? { regionId: createdRegionId }
						: {}),
					...(createdRegionName !== undefined
						? { name: createdRegionName }
						: {}),
				},
				id,
			);
		}
		case "removeRegion":
			return attachId(
				{ type: "removeRegion" as const, regionId: takeRegionId(item, path) },
				id,
			);
		case "renameRegion":
			return attachId(
				{
					type: "renameRegion" as const,
					regionId: takeRegionId(item, path),
					name: takeName(item, path, "Region"),
				},
				id,
			);
		case "reorderRegion":
			return attachId(
				{
					type: "reorderRegion" as const,
					regionId: takeRegionId(item, path),
					toIndex: takeToIndex(item, path),
				},
				id,
			);
		case "stampRect": {
			const layerId = needLayerId();
			const source = takeRequiredSelection(item, path, "source");
			const to = takeToPoint(item, path);
			const offset = takeOffsetPoint(item, path);
			if (to === undefined && offset === undefined) {
				throw invalid(
					`${path}.to`,
					"stampRect needs to or offset for the destination origin.",
					item,
				);
			}
			const transform = takeStampTransform(item, path);
			const merge = takeStampMerge(item, path);
			const carryRegions = takeCarryRegions(item, path);
			const selection = takeOptionalSelection(item, path);
			return attachId(
				{
					type: "stampRect" as const,
					layerId,
					source,
					...(to !== undefined ? { to } : {}),
					...(offset !== undefined ? { offset } : {}),
					...(transform !== undefined ? { transform } : {}),
					...(merge !== undefined ? { merge } : {}),
					...(carryRegions !== undefined ? { carryRegions } : {}),
					...(selection !== undefined ? { selection } : {}),
				},
				id,
			);
		}
		case "regionFromSelection": {
			const selection = takeRequiredSelection(item, path, "selection");
			const mode = takeRegionMode(item, path);
			const regionId = takeOptionalId(item, "regionId", path, "Region id");
			const name = takeOptionalName(item, path, "Region");
			return attachId(
				{
					type: "regionFromSelection" as const,
					selection,
					mode,
					...(regionId !== undefined ? { regionId } : {}),
					...(name !== undefined ? { name } : {}),
				},
				id,
			);
		}
		default:
			return attachId(
				{
					type: "setRegionPixel" as const,
					regionId: takeRegionId(item, path),
					x: takeInt(item.x, `${path}.x`, "Pixel x"),
					y: takeInt(item.y, `${path}.y`, "Pixel y"),
					value: takeMaskValue(item, path),
				},
				id,
			);
	}
}

/**
 * Parse a batch-operations JSON body into typed core operations. Accepts a
 * bare array or an {"operations": [...]} envelope; an empty array is a
 * valid no-op. defaultLayerId backs a missing layerId (the caller passes
 * the sole layer id for single-layer canvases); without it a missing
 * layerId is INVALID_ARGUMENT. Operations without a top-level layerId
 * (regionFromSelection, mergeLayer, and the region vocabulary) never ask
 * for one.
 */
export function parseOperationsJson(
	text: string,
	defaultLayerId?: string,
): BatchOperation[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw invalid("operations", "Operations input is not valid JSON.", text);
	}
	let list: unknown;
	if (Array.isArray(parsed)) {
		list = parsed;
	} else if (isRecord(parsed) && "operations" in parsed) {
		list = parsed.operations;
	} else {
		throw invalid(
			"operations",
			'Operations input must be an array or an object with an "operations" array.',
			parsed,
		);
	}
	if (!Array.isArray(list)) {
		throw invalid(
			"operations",
			'Operations input must be an array or an object with an "operations" array.',
			list,
		);
	}
	const out: BatchOperation[] = [];
	for (let index = 0; index < list.length; index += 1) {
		out.push(
			parseOneOperation(list[index], `operations[${index}]`, defaultLayerId),
		);
	}
	return out;
}
