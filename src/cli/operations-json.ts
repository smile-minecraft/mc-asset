import type { BatchOperation } from "../core/batch.ts";
import { McAssetError } from "../core/errors.ts";
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
			`Unknown operation type: ${String(rawType)}. Pixel ops are setPixel, clearPixel, drawLine, drawRect, fillRect, floodFill; layer ops are createLayer, removeLayer, renameLayer, reorderLayer, duplicateLayer, mergeLayer, clearLayer, fillLayer, moveLayer; region ops are createRegion, removeRegion, renameRegion, reorderRegion, setRegionPixel. Geometry never enters the batch; use the transform command.`,
			rawType,
		);
	}
	const layerId = takeLayerId(item, path, defaultLayerId);
	const id = takeId(item, path);
	switch (rawType) {
		case "setPixel":
			return attachId(
				{
					type: "setPixel" as const,
					layerId,
					x: takeInt(item.x, `${path}.x`, "Pixel x"),
					y: takeInt(item.y, `${path}.y`, "Pixel y"),
					color: takeColor(item.color, `${path}.color`),
				},
				id,
			);
		case "clearPixel":
			return attachId(
				{
					type: "clearPixel" as const,
					layerId,
					x: takeInt(item.x, `${path}.x`, "Pixel x"),
					y: takeInt(item.y, `${path}.y`, "Pixel y"),
				},
				id,
			);
		case "drawLine": {
			const from = takePoint(item.from, `${path}.from`, "Line from");
			const to = takePoint(item.to, `${path}.to`, "Line to");
			return attachId(
				{
					type: "drawLine" as const,
					layerId,
					x0: from.x,
					y0: from.y,
					x1: to.x,
					y1: to.y,
					color: takeColor(item.color, `${path}.color`),
				},
				id,
			);
		}
		case "drawRect":
			return attachId(
				{
					type: "drawRect" as const,
					layerId,
					rect: takeRect(item.rect, `${path}.rect`),
					color: takeColor(item.color, `${path}.color`),
				},
				id,
			);
		case "fillRect":
			return attachId(
				{
					type: "fillRect" as const,
					layerId,
					rect: takeRect(item.rect, `${path}.rect`),
					color: takeColor(item.color, `${path}.color`),
				},
				id,
			);
		case "floodFill":
			return attachId(
				{
					type: "floodFill" as const,
					layerId,
					x: takeInt(item.x, `${path}.x`, "Pixel x"),
					y: takeInt(item.y, `${path}.y`, "Pixel y"),
					color: takeColor(item.color, `${path}.color`),
				},
				id,
			);
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
			return attachId({ type: "removeLayer" as const, layerId }, id);
		case "renameLayer":
			return attachId(
				{
					type: "renameLayer" as const,
					layerId,
					name: takeName(item, path, "Layer"),
				},
				id,
			);
		case "reorderLayer":
			return attachId(
				{
					type: "reorderLayer" as const,
					layerId,
					toIndex: takeToIndex(item, path),
				},
				id,
			);
		case "duplicateLayer": {
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
			return attachId({ type: "clearLayer" as const, layerId }, id);
		case "fillLayer":
			return attachId(
				{
					type: "fillLayer" as const,
					layerId,
					color: takeColor(item.color, `${path}.color`),
				},
				id,
			);
		case "moveLayer":
			return attachId(
				{
					type: "moveLayer" as const,
					layerId,
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
 * layerId is INVALID_ARGUMENT.
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
