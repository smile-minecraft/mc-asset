import { getLayer, getRegion } from "./canvas.ts";
import { McAssetError } from "./errors.ts";
import type { PixelCanvas, Rect } from "./types.ts";
import {
	assertPixelInBounds,
	assertValidCanvas,
	estimateMemoryBytes,
	MEMORY_BUDGET_BYTES,
	validateCoordinate,
} from "./validate.ts";

export type SelectionKind = "all" | "rect" | "region" | "mask";

/**
 * A resolved, single-call scope for pixel-writing operations. The object is
 * transient: it is resolved once before the first pixel write, shared by every
 * write of that call, and never stored on the canvas or serialized.
 */
export interface ResolvedSelection {
	readonly kind: SelectionKind;
	/** Present only when kind is "rect". A detached copy, safe to read. */
	readonly rect?: Rect;
	/** Present only when kind is "region". The mask is read live, never written. */
	readonly regionId?: string;
	/**
	 * Present only when kind is "mask". A detached read scope computed from
	 * a new atom or a JSON AST: evaluating never writes pixels, never
	 * touches a region mask, and never changes canvas dimensions.
	 */
	readonly mask?: Uint8Array;
}

/**
 * Agent-facing selection expression: an atom string, or a single JSON AST
 * object `{"op": ..., "operands": [...]}`. Operands recurse: each one is
 * again an atom string or an AST object.
 */
export type SelectionExpr = string | SelectionAst;

export interface SelectionAst {
	op: "union" | "intersect" | "subtract" | "invert";
	operands: SelectionExpr[];
}

/** Read scope computed from a SelectionExpr: mask bits plus popcount. */
export interface EvaluatedSelection {
	/** One byte per pixel, row-major; 1 means inside the scope. */
	readonly mask: Uint8Array;
	readonly count: number;
	/** Tight bounds of the set bits, or null when the scope is empty. */
	readonly bounds: Rect | null;
}

export interface SelectedPoint {
	x: number;
	y: number;
}

const RECT_PREFIX = "rect:";
const REGION_PREFIX = "region:";
const DECIMAL_INTEGER = /^[+-]?\d+$/;

function parseDecimalInteger(text: string): number {
	if (!DECIMAL_INTEGER.test(text)) {
		throw new McAssetError(
			"INVALID_COORDINATE",
			"Selection rect components must be decimal integers, without rounding.",
			{ value: text },
		);
	}
	return Number(text);
}

/**
 * Selection rects carry their own error mapping, fixed by the selection
 * freeze: non-integer components are INVALID_COORDINATE, width/height below 1
 * are INVALID_ARGUMENT, and anything outside the canvas is OUT_OF_BOUNDS with
 * no silent clipping. This deliberately differs from the generic rect
 * validator, whose dimension code does not apply on this path.
 */
function parseRect(canvas: PixelCanvas, body: string): Rect {
	const parts = body.split(",");
	if (parts.length !== 4) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Selection rect needs exactly x,y,width,height.",
			{ value: body },
		);
	}
	const numbers = parts.map((part) => {
		// A missing component is a malformed string, not a mistyped number.
		if (part.trim().length === 0) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"Selection rect components must not be empty.",
				{ value: body },
			);
		}
		return parseDecimalInteger(part.trim());
	});
	const rect: Rect = {
		x: numbers[0] as number,
		y: numbers[1] as number,
		width: numbers[2] as number,
		height: numbers[3] as number,
	};
	if (rect.width < 1 || rect.height < 1) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Selection rect width and height must be at least 1.",
			{ width: rect.width, height: rect.height },
		);
	}
	if (
		rect.x < 0 ||
		rect.y < 0 ||
		rect.x + rect.width > canvas.width ||
		rect.y + rect.height > canvas.height
	) {
		throw new McAssetError(
			"OUT_OF_BOUNDS",
			"Selection rect is outside canvas.",
			{
				rect,
				width: canvas.width,
				height: canvas.height,
			},
		);
	}
	return rect;
}

function parseRegion(canvas: PixelCanvas, body: string): string {
	// Region ids are opaque: the id is matched verbatim, without trimming.
	if (body.length === 0) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Selection region needs a non-empty id.",
			{ value: body },
		);
	}
	if (canvas.regions.length === 0) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Selection region needs a source that carries regions.",
			{ id: body },
		);
	}
	// Throws REGION_NOT_FOUND when the id does not exist; the mask is only read.
	getRegion(canvas, body);
	return body;
}

/**
 * Resolve a raw `--selection` value against a canvas. `undefined` (flag
 * omitted) selects the whole canvas. The returned scope is a plain transient
 * value: resolving never writes pixels, never touches a region mask, and never
 * changes canvas dimensions.
 *
 * Dispatch is on the exact first character: a leading `{` parses the value
 * as a JSON selection AST without trimming; anything else enters the atom
 * parser (legacy `rect:`/`region:` paths verbatim, then the new atoms).
 */
export function resolveSelection(
	canvas: PixelCanvas,
	raw: string | undefined,
): ResolvedSelection {
	assertValidCanvas(canvas);
	if (raw === undefined) {
		return { kind: "all" };
	}
	if (raw.length > 0 && raw[0] === "{") {
		return { kind: "mask", mask: evaluateCliAst(canvas, raw).mask };
	}
	const text = raw.trim();
	if (text === "all") {
		return { kind: "all" };
	}
	if (text.startsWith(RECT_PREFIX)) {
		return {
			kind: "rect",
			rect: parseRect(canvas, text.slice(RECT_PREFIX.length)),
		};
	}
	if (text.startsWith(REGION_PREFIX)) {
		return {
			kind: "region",
			regionId: parseRegion(canvas, text.slice(REGION_PREFIX.length)),
		};
	}
	// Direct atoms run through the same preflighted evaluator as AST
	// values, so connected search scratch is budgeted on every entry path.
	return {
		kind: "mask",
		mask: evaluateSelectionExpr(canvas, text, "selection").mask,
	};
}

function evaluateCliAst(canvas: PixelCanvas, raw: string): EvaluatedSelection {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const details: Record<string, unknown> = { selection: raw };
		const offset = parseJsonOffset(error);
		if (offset !== undefined) {
			details.offset = offset;
		}
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Selection JSON is not parseable; pass an atom string or a JSON expression object.",
			details,
		);
	}
	return evaluateSelectionExpr(
		canvas,
		parseSelectionExprValue(parsed, "selection"),
		"selection",
	);
}

function parseJsonOffset(error: unknown): number | undefined {
	const message = error instanceof Error ? error.message : String(error);
	const match = /position (\d+)/.exec(message);
	if (match === null || match[1] === undefined) {
		return undefined;
	}
	return Number(match[1]);
}

const AST_OPS: ReadonlySet<string> = new Set([
	"union",
	"intersect",
	"subtract",
	"invert",
]);

const AST_MAX_DEPTH = 32;
const AST_MAX_NODES = 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Validate an unknown JSON value as a SelectionExpr. Strings pass through
 * as atoms (atom semantics need the canvas, so they validate at
 * evaluation); objects are checked for exact shape, known op, and arity.
 * Depth past 32 or more than 1024 nodes reports RESOURCE_LIMIT_EXCEEDED
 * without truncating; anything else malformed is INVALID_ARGUMENT with an
 * expression path in details.
 */
export function parseSelectionExprValue(
	value: unknown,
	basePath: string,
): SelectionExpr {
	const counter = { nodes: 0 };
	return parseExprNode(value, basePath, 0, counter);
}

function parseExprNode(
	value: unknown,
	path: string,
	depth: number,
	counter: { nodes: number },
): SelectionExpr {
	counter.nodes += 1;
	if (counter.nodes > AST_MAX_NODES) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			"Selection expression has too many nodes; keep it at or under 1024.",
			{ path, nodes: counter.nodes },
		);
	}
	if (typeof value === "string") {
		if (value.length === 0) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"Selection atom must be a non-empty string.",
				{ path },
			);
		}
		return value;
	}
	if (!isRecord(value)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Selection expression must be an atom string or an expression object.",
			{ path },
		);
	}
	for (const key of Object.keys(value)) {
		if (key !== "op" && key !== "operands") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				`Unknown selection expression key: ${key}.`,
				{ path, key },
			);
		}
	}
	const op = value.op;
	if (typeof op !== "string" || !AST_OPS.has(op)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Unknown selection operator: ${String(op)}.`,
			{ path, op },
		);
	}
	const operands = value.operands;
	if (!Array.isArray(operands)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Selection expression operands must be an array.",
			{ path, op },
		);
	}
	if (
		op === "union" || op === "intersect"
			? operands.length < 2
			: op === "subtract"
				? operands.length !== 2
				: operands.length !== 1
	) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Selection operator ${op} needs ${op === "union" || op === "intersect" ? "at least 2" : op === "subtract" ? "exactly 2" : "exactly 1"} operand(s).`,
			{ path, op, count: operands.length },
		);
	}
	if (depth + 1 > AST_MAX_DEPTH) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			"Selection expression is nested too deep; keep depth at or under 32.",
			{ path, depth: depth + 1 },
		);
	}
	const parsed = operands.map((operand, index) =>
		parseExprNode(operand, `${path}.operands[${index}]`, depth + 1, counter),
	);
	return { op: op as SelectionAst["op"], operands: parsed };
}

function resolveAtomLayer(
	canvas: PixelCanvas,
	layerId: string | undefined,
	path: string,
	atom: string,
): string {
	if (layerId === undefined) {
		if (canvas.layers.length === 1) {
			return (canvas.layers[0] as { id: string }).id;
		}
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Selection ${atom} needs an explicit layer id on a multi-layer canvas; pass ${atom}:<layerId> with the layer to read.`,
			{ path, atom },
		);
	}
	// Unknown ids keep the LAYER_NOT_FOUND meaning used everywhere else.
	getLayer(canvas, layerId);
	return layerId;
}

function parseChannelPart(text: string, path: string): number {
	if (!DECIMAL_INTEGER.test(text)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Selection color channels must be decimal integers 0-255, without rounding.",
			{ path, value: text },
		);
	}
	const channel = Number(text);
	if (channel < 0 || channel > 255) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Selection color channels must be decimal integers 0-255.",
			{ path, value: text },
		);
	}
	return channel;
}

function parseSeedPoint(text: string, path: string): { x: number; y: number } {
	const parts = text.split(",");
	if (parts.length !== 2) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Selection seed needs exactly x,y.",
			{ path, value: text },
		);
	}
	const rawX = (parts[0] as string).trim();
	const rawY = (parts[1] as string).trim();
	if (!DECIMAL_INTEGER.test(rawX) || !DECIMAL_INTEGER.test(rawY)) {
		throw new McAssetError(
			"INVALID_COORDINATE",
			"Selection seed coordinates must be integers, without rounding.",
			{ path, value: text },
		);
	}
	return { x: Number(rawX), y: Number(rawY) };
}

interface AtomScope {
	mask: Uint8Array;
	count: number;
	layerId: string | undefined;
}

function fullScope(canvas: PixelCanvas): AtomScope {
	const mask = new Uint8Array(canvas.width * canvas.height).fill(1);
	return { mask, count: canvas.width * canvas.height, layerId: undefined };
}

function finishScope(mask: Uint8Array): AtomScope {
	let count = 0;
	for (let i = 0; i < mask.length; i += 1) {
		if (mask[i] === 1) {
			count += 1;
		}
	}
	return { mask, count, layerId: undefined };
}

function alphaScope(canvas: PixelCanvas, layerId: string): AtomScope {
	const layer = getLayer(canvas, layerId);
	const mask = new Uint8Array(canvas.width * canvas.height);
	const pixels = layer.pixels;
	for (let i = 0; i < mask.length; i += 1) {
		mask[i] = (pixels[i * 4 + 3] as number) !== 0 ? 1 : 0;
	}
	let count = 0;
	for (let i = 0; i < mask.length; i += 1) {
		if (mask[i] === 1) {
			count += 1;
		}
	}
	return { mask, count, layerId };
}

function colorScope(
	canvas: PixelCanvas,
	layerId: string,
	target: { r: number; g: number; b: number; a: number },
): AtomScope {
	const layer = getLayer(canvas, layerId);
	const mask = new Uint8Array(canvas.width * canvas.height);
	const pixels = layer.pixels;
	for (let i = 0; i < mask.length; i += 1) {
		const offset = i * 4;
		mask[i] =
			pixels[offset] === target.r &&
			pixels[offset + 1] === target.g &&
			pixels[offset + 2] === target.b &&
			pixels[offset + 3] === target.a
				? 1
				: 0;
	}
	let count = 0;
	for (let i = 0; i < mask.length; i += 1) {
		if (mask[i] === 1) {
			count += 1;
		}
	}
	return { mask, count, layerId };
}

function connectedScope(
	canvas: PixelCanvas,
	layerId: string,
	seedX: number,
	seedY: number,
	path: string,
): AtomScope {
	validateCoordinate(seedX, "x");
	validateCoordinate(seedY, "y");
	assertPixelInBounds(canvas.width, canvas.height, seedX, seedY);
	const layer = getLayer(canvas, layerId);
	const width = canvas.width;
	const height = canvas.height;
	const seedOffset = (seedY * width + seedX) * 4;
	const target = {
		r: layer.pixels[seedOffset],
		g: layer.pixels[seedOffset + 1],
		b: layer.pixels[seedOffset + 2],
		a: layer.pixels[seedOffset + 3],
	};
	const mask = new Uint8Array(width * height);
	// Bounded index queue: the mask doubles as the visited set (marked at
	// enqueue time), so each cell enters at most once and the tail never
	// passes pixelCount. Flat indices keep the queue at 4 bytes per cell
	// with no per-element boxing.
	const queue = new Uint32Array(width * height);
	let head = 0;
	let tail = 0;
	queue[tail] = seedY * width + seedX;
	tail += 1;
	mask[seedY * width + seedX] = 1;
	while (head < tail) {
		const cur = queue[head] as number;
		head += 1;
		const cx = cur % width;
		const cy = (cur - cx) / width;
		const neighbors: Array<[number, number]> = [
			[cx + 1, cy],
			[cx - 1, cy],
			[cx, cy + 1],
			[cx, cy - 1],
		];
		for (const [nx, ny] of neighbors) {
			if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
				continue;
			}
			const index = ny * width + nx;
			if (mask[index] === 1) {
				continue;
			}
			const offset = index * 4;
			if (
				layer.pixels[offset] !== target.r ||
				layer.pixels[offset + 1] !== target.g ||
				layer.pixels[offset + 2] !== target.b ||
				layer.pixels[offset + 3] !== target.a
			) {
				continue;
			}
			mask[index] = 1;
			queue[tail] = index;
			tail += 1;
		}
	}
	let count = 0;
	for (let i = 0; i < mask.length; i += 1) {
		if (mask[i] === 1) {
			count += 1;
		}
	}
	void path;
	return { mask, count, layerId };
}

/**
 * Evaluate one atom string against a canvas. Legacy `rect:`/`region:`
 * parsing is reused verbatim; the new `alpha:`/`color:`/`connected:`
 * atoms read a single layer with zero tolerance.
 */
function evaluateAtom(
	canvas: PixelCanvas,
	text: string,
	path: string,
): AtomScope {
	if (text === "all") {
		return fullScope(canvas);
	}
	if (text.startsWith(RECT_PREFIX)) {
		const rect = parseRect(canvas, text.slice(RECT_PREFIX.length));
		const mask = new Uint8Array(canvas.width * canvas.height);
		for (let y = rect.y; y < rect.y + rect.height; y += 1) {
			for (let x = rect.x; x < rect.x + rect.width; x += 1) {
				mask[y * canvas.width + x] = 1;
			}
		}
		return finishScope(mask);
	}
	if (text.startsWith(REGION_PREFIX)) {
		const id = parseRegion(canvas, text.slice(REGION_PREFIX.length));
		return finishScope(getRegion(canvas, id).mask.slice());
	}
	if (text === "alpha" || text.startsWith("alpha:")) {
		const rawId = text === "alpha" ? undefined : text.slice("alpha:".length);
		if (rawId !== undefined && rawId.length === 0) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"Selection alpha needs a layer id after alpha:.",
				{ path, value: text },
			);
		}
		const layerId = resolveAtomLayer(canvas, rawId, path, "alpha");
		return alphaScope(canvas, layerId);
	}
	if (text === "color" || text.startsWith("color:")) {
		if (text === "color") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"Selection color needs r,g,b,a channels.",
				{ path, value: text },
			);
		}
		const rest = text.slice("color:".length);
		const split = rest.lastIndexOf(":");
		const rawId = split === -1 ? undefined : rest.slice(0, split);
		const channels = split === -1 ? rest : rest.slice(split + 1);
		if (rawId !== undefined && rawId.length === 0) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"Selection color needs a layer id before the channels.",
				{ path, value: text },
			);
		}
		const parts = channels.split(",");
		if (parts.length !== 4) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"Selection color needs exactly r,g,b,a.",
				{ path, value: text },
			);
		}
		const target = {
			r: parseChannelPart((parts[0] as string).trim(), path),
			g: parseChannelPart((parts[1] as string).trim(), path),
			b: parseChannelPart((parts[2] as string).trim(), path),
			a: parseChannelPart((parts[3] as string).trim(), path),
		};
		const layerId = resolveAtomLayer(canvas, rawId, path, "color");
		return colorScope(canvas, layerId, target);
	}
	if (text === "connected" || text.startsWith("connected:")) {
		if (text === "connected") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"Selection connected needs a seed x,y.",
				{ path, value: text },
			);
		}
		const rest = text.slice("connected:".length);
		const split = rest.lastIndexOf(":");
		const rawId = split === -1 ? undefined : rest.slice(0, split);
		const seed = split === -1 ? rest : rest.slice(split + 1);
		if (rawId !== undefined && rawId.length === 0) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"Selection connected needs a layer id before the seed.",
				{ path, value: text },
			);
		}
		const layerId = resolveAtomLayer(canvas, rawId, path, "connected");
		const point = parseSeedPoint(seed, path);
		return connectedScope(canvas, layerId, point.x, point.y, path);
	}
	throw new McAssetError(
		"INVALID_ARGUMENT",
		"Selection must be all, rect:<x>,<y>,<width>,<height>, region:<id>, alpha[:<layerId>], color[:<layerId>]:<r>,<g>,<b>,<a>, connected[:<layerId>]:<x>,<y>, or a JSON expression object.",
		{ value: text, path },
	);
}

function boundsOf(
	canvas: PixelCanvas,
	mask: Uint8Array,
	count: number,
): Rect | null {
	if (count === 0) {
		return null;
	}
	let minX = canvas.width;
	let minY = canvas.height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < canvas.height; y += 1) {
		for (let x = 0; x < canvas.width; x += 1) {
			if (mask[y * canvas.width + x] === 1) {
				if (x < minX) {
					minX = x;
				}
				if (x > maxX) {
					maxX = x;
				}
				if (y < minY) {
					minY = y;
				}
				if (y > maxY) {
					maxY = y;
				}
			}
		}
	}
	return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Options for selection evaluation. */
export interface SelectionEvaluateOptions {
	/**
	 * Scratch budget in bytes for the preflight; defaults to the engine
	 * 512 MiB resource budget. A test seam: pass a small limit to prove
	 * the preflight rejects before allocating.
	 */
	budgetBytes?: number;
}

/** AST nesting levels: atoms sit at 0, each enclosing object adds one. */
export function selectionExpressionDepth(expr: SelectionExpr): number {
	if (typeof expr === "string") {
		return 0;
	}
	let deepest = 0;
	for (const operand of expr.operands) {
		const child = selectionExpressionDepth(operand);
		if (child > deepest) {
			deepest = child;
		}
	}
	return deepest + 1;
}

/**
 * Extra scratch equivalents of a connected search beyond its output mask:
 * one visited mask plus the bounded index queue at 4 bytes per cell.
 */
export const SELECTION_CONNECTED_EXTRA_EQUIVALENTS = 5;

/** True when any leaf of the expression is a connected atom. */
export function selectionUsesConnectedQueue(expr: SelectionExpr): boolean {
	if (typeof expr === "string") {
		return expr === "connected" || expr.startsWith("connected:");
	}
	return expr.operands.some(selectionUsesConnectedQueue);
}

/**
 * Scratch estimate in bytes for one evaluation: one mask byte per pixel
 * per live mask. The streaming evaluator below holds at most depth + 2
 * full-canvas masks at once (one accumulator per nesting level, one
 * operand under reduction, one atom scratch), plus the connected-search
 * extra when any leaf needs its queue, so this bounds it without
 * retaining one mask per operand.
 */
export function estimateSelectionScratchBytes(
	pixelCount: number,
	expressionDepth: number,
	hasConnectedQueue = false,
): number {
	return (
		pixelCount *
		(expressionDepth +
			2 +
			(hasConnectedQueue ? SELECTION_CONNECTED_EXTRA_EQUIVALENTS : 0))
	);
}

function assertSelectionScratchBudget(
	canvas: PixelCanvas,
	depth: number,
	hasConnectedQueue: boolean,
	basePath: string,
	budgetBytes: number | undefined,
): void {
	// The override is a test seam that may only lower the global hard cap,
	// never raise or bypass it.
	let budget = MEMORY_BUDGET_BYTES;
	if (budgetBytes !== undefined) {
		if (
			!Number.isInteger(budgetBytes) ||
			budgetBytes < 0 ||
			budgetBytes > MEMORY_BUDGET_BYTES
		) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"Selection budget must be an integer within [0, 536870912]; it may lower the 512 MiB cap for tests but never raise it.",
				{ path: basePath, budgetBytes },
			);
		}
		budget = budgetBytes;
	}
	const existing = estimateMemoryBytes(
		canvas.width,
		canvas.height,
		canvas.layers.length,
		canvas.regions.length,
	);
	const scratch = estimateSelectionScratchBytes(
		canvas.width * canvas.height,
		depth,
		hasConnectedQueue,
	);
	if (existing + scratch > budget) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			"Selection evaluation needs more scratch memory than the budget allows; narrow the expression or free layers and regions first.",
			{
				path: basePath,
				needed: existing + scratch,
				budget,
				expressionDepth: depth,
			},
		);
	}
}

/**
 * Evaluate a SelectionExpr against a canvas into a detached mask. The
 * evaluation is transient: it never writes pixels, never touches a region
 * mask, and never changes canvas dimensions. One expression reads a
 * single layer at most: mixing two layer ids is INVALID_ARGUMENT.
 *
 * Operands reduce streaming: each operand mask folds into its parent
 * accumulator and is released before the next one evaluates, so live
 * full-canvas masks stay within depth + 2 no matter how wide the
 * expression is. A budget preflight runs before the first allocation.
 */
export function evaluateSelectionExpr(
	canvas: PixelCanvas,
	expr: SelectionExpr,
	basePath = "selection",
	options?: SelectionEvaluateOptions,
): EvaluatedSelection {
	assertValidCanvas(canvas);
	// Re-validate shape, arity, depth, and node caps so hand-built typed
	// operations get the same limits as parsed JSON; strings pass through.
	const checked = parseSelectionExprValue(expr, basePath);
	assertSelectionScratchBudget(
		canvas,
		selectionExpressionDepth(checked),
		selectionUsesConnectedQueue(checked),
		basePath,
		options?.budgetBytes,
	);
	const seen = new Set<string>();
	const evalOne = (
		node: SelectionExpr,
		path: string,
		depth: number,
	): Uint8Array => {
		if (depth > AST_MAX_DEPTH) {
			throw new McAssetError(
				"RESOURCE_LIMIT_EXCEEDED",
				"Selection expression is nested too deep; keep depth at or under 32.",
				{ path, depth },
			);
		}
		if (typeof node === "string") {
			const scope = evaluateAtom(canvas, node, path);
			if (scope.layerId !== undefined) {
				seen.add(scope.layerId);
			}
			return scope.mask;
		}
		const size = canvas.width * canvas.height;
		const evalOperand = (index: number): Uint8Array =>
			evalOne(
				node.operands[index] as SelectionExpr,
				`${path}.operands[${index}]`,
				depth + 1,
			);
		if (node.op === "invert") {
			const only = evalOperand(0);
			const out = new Uint8Array(size);
			for (let i = 0; i < size; i += 1) {
				out[i] = only[i] === 1 ? 0 : 1;
			}
			return out;
		}
		if (node.op === "union") {
			const out = new Uint8Array(size);
			for (let index = 0; index < node.operands.length; index += 1) {
				const part = evalOperand(index);
				for (let i = 0; i < size; i += 1) {
					if (part[i] === 1) {
						out[i] = 1;
					}
				}
			}
			return out;
		}
		if (node.op === "intersect") {
			const out = new Uint8Array(size).fill(1);
			for (let index = 0; index < node.operands.length; index += 1) {
				const part = evalOperand(index);
				for (let i = 0; i < size; i += 1) {
					if (part[i] !== 1) {
						out[i] = 0;
					}
				}
			}
			return out;
		}
		// Subtract reuses the left mask as the output: two live masks total.
		const left = evalOperand(0);
		const right = evalOperand(1);
		for (let i = 0; i < size; i += 1) {
			if (right[i] === 1) {
				left[i] = 0;
			}
		}
		return left;
	};
	const mask = evalOne(checked, basePath, 0);
	if (seen.size > 1) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"One selection expression reads a single layer; pass one layer id for every alpha, color, or connected atom.",
			{ path: basePath, layers: [...seen].sort() },
		);
	}
	let count = 0;
	for (let i = 0; i < mask.length; i += 1) {
		if (mask[i] === 1) {
			count += 1;
		}
	}
	return { mask, count, bounds: boundsOf(canvas, mask, count) };
}

function rectOf(selection: ResolvedSelection): Rect {
	const rect = selection.rect;
	if (selection.kind !== "rect" || rect === undefined) {
		throw new McAssetError(
			"INTERNAL_ERROR",
			"Rect selection is missing its rect.",
		);
	}
	return rect;
}

function maskOf(canvas: PixelCanvas, selection: ResolvedSelection): Uint8Array {
	if (selection.kind === "mask") {
		const mask = selection.mask;
		if (mask === undefined) {
			throw new McAssetError(
				"INTERNAL_ERROR",
				"Mask selection is missing its mask.",
			);
		}
		return mask;
	}
	if (selection.kind !== "region" || selection.regionId === undefined) {
		throw new McAssetError(
			"INTERNAL_ERROR",
			"Region selection is missing its region id.",
		);
	}
	return getRegion(canvas, selection.regionId).mask;
}

/**
 * Membership test for one pixel. Coordinates keep the strict engine errors:
 * non-integers are INVALID_COORDINATE and out-of-bounds pixels are
 * OUT_OF_BOUNDS, so a selection can never silently clip a write path.
 */
export function isPixelSelected(
	selection: ResolvedSelection,
	canvas: PixelCanvas,
	x: number,
	y: number,
): boolean {
	assertValidCanvas(canvas);
	validateCoordinate(x, "x");
	validateCoordinate(y, "y");
	assertPixelInBounds(canvas.width, canvas.height, x, y);
	if (selection.kind === "all") {
		return true;
	}
	if (selection.kind === "rect") {
		const rect = rectOf(selection);
		return (
			x >= rect.x &&
			x < rect.x + rect.width &&
			y >= rect.y &&
			y < rect.y + rect.height
		);
	}
	if (selection.kind === "region" || selection.kind === "mask") {
		return maskOf(canvas, selection)[y * canvas.width + x] === 1;
	}
	throw new McAssetError("INTERNAL_ERROR", "Unknown selection kind.");
}

/** Enumerate the selected pixels in row-major order (top row first). */
export function listSelectedPixels(
	selection: ResolvedSelection,
	canvas: PixelCanvas,
): SelectedPoint[] {
	assertValidCanvas(canvas);
	const points: SelectedPoint[] = [];
	if (selection.kind === "all") {
		for (let y = 0; y < canvas.height; y += 1) {
			for (let x = 0; x < canvas.width; x += 1) {
				points.push({ x, y });
			}
		}
		return points;
	}
	if (selection.kind === "rect") {
		const rect = rectOf(selection);
		for (let y = rect.y; y < rect.y + rect.height; y += 1) {
			for (let x = rect.x; x < rect.x + rect.width; x += 1) {
				points.push({ x, y });
			}
		}
		return points;
	}
	const mask = maskOf(canvas, selection);
	for (let y = 0; y < canvas.height; y += 1) {
		for (let x = 0; x < canvas.width; x += 1) {
			if (mask[y * canvas.width + x] === 1) {
				points.push({ x, y });
			}
		}
	}
	return points;
}

/**
 * Visit each selected pixel in row-major order without allocating a list.
 * The callback performs the actual write; selection membership only gates it.
 */
export function forEachSelectedPixel(
	selection: ResolvedSelection,
	canvas: PixelCanvas,
	visit: (x: number, y: number) => void,
): void {
	assertValidCanvas(canvas);
	if (selection.kind === "all") {
		for (let y = 0; y < canvas.height; y += 1) {
			for (let x = 0; x < canvas.width; x += 1) {
				visit(x, y);
			}
		}
		return;
	}
	if (selection.kind === "rect") {
		const rect = rectOf(selection);
		for (let y = rect.y; y < rect.y + rect.height; y += 1) {
			for (let x = rect.x; x < rect.x + rect.width; x += 1) {
				visit(x, y);
			}
		}
		return;
	}
	const mask = maskOf(canvas, selection);
	for (let y = 0; y < canvas.height; y += 1) {
		for (let x = 0; x < canvas.width; x += 1) {
			if (mask[y * canvas.width + x] === 1) {
				visit(x, y);
			}
		}
	}
}

/** Count the selected pixels with integer arithmetic only. */
export function countSelectedPixels(
	selection: ResolvedSelection,
	canvas: PixelCanvas,
): number {
	assertValidCanvas(canvas);
	if (selection.kind === "all") {
		return canvas.width * canvas.height;
	}
	if (selection.kind === "rect") {
		const rect = rectOf(selection);
		return rect.width * rect.height;
	}
	const mask = maskOf(canvas, selection);
	let count = 0;
	for (let i = 0; i < mask.length; i += 1) {
		if (mask[i] === 1) {
			count += 1;
		}
	}
	return count;
}
