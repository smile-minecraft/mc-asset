import type { PaletteRole, RGBA } from "../core/types.ts";
import { CANVAS_MAX_EDGE, CANVAS_MIN_EDGE } from "../core/validate.ts";
import { mcpxError } from "./errors.ts";
import type { McpxDocument, RawAttr, RawLayer, RawRegion } from "./parser.ts";

/**
 * Schema + semantic stage: value shapes first (MCPX_SCHEMA_ERROR), then
 * cross-references and sizes (MCPX_SEMANTIC_ERROR, INVALID_GRID_SIZE,
 * INVALID_MASK_SIZE). The builder behind this stage trusts every value.
 */

export interface ValidPaletteEntry {
	symbol: string;
	color: RGBA;
	role?: PaletteRole;
	line: number;
}

export interface ValidLayer {
	id: string;
	visible: boolean;
	opacity: number;
	name?: string;
	gridKind: "compact" | "tokens";
	cells: string[][];
	gridLine: number;
	line: number;
}

export interface ValidRegion {
	id: string;
	name?: string;
	cells: number[][];
	maskLine: number;
	line: number;
}

export interface ValidDocument {
	width: number;
	height: number;
	metadata: Record<string, string>;
	palette: ValidPaletteEntry[];
	layers: ValidLayer[];
	regions: ValidRegion[];
}

export const KEY = /^[a-z][a-z0-9_]*$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const OPACITY = /^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$/;
const SYMBOL_CHAR = /^[.0-9A-Za-z]$/;
const NO_BLANK = /^[^\s=]+$/;
const OBJECT_ID = /^[A-Za-z0-9_.-]+$/;
const HEX6 = /^#([0-9a-fA-F]{6})$/;
const HEX8 = /^#([0-9a-fA-F]{8})$/;

export const ROLES: ReadonlySet<string> = new Set([
	"outline",
	"shadow",
	"dark",
	"base",
	"light",
	"highlight",
	"accent",
	"custom",
]);

const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };

function hexByte(pair: string): number {
	return Number.parseInt(pair, 16);
}

function parseColor(text: string): RGBA | null {
	if (text === "transparent") {
		return { ...TRANSPARENT };
	}
	const short = HEX6.exec(text);
	if (short?.[1] !== undefined) {
		const digits = short[1];
		return {
			r: hexByte(digits.slice(0, 2)),
			g: hexByte(digits.slice(2, 4)),
			b: hexByte(digits.slice(4, 6)),
			a: 255,
		};
	}
	const long = HEX8.exec(text);
	if (long?.[1] !== undefined) {
		const digits = long[1];
		return {
			r: hexByte(digits.slice(0, 2)),
			g: hexByte(digits.slice(2, 4)),
			b: hexByte(digits.slice(4, 6)),
			a: hexByte(digits.slice(6, 8)),
		};
	}
	return null;
}

function isTransparent(color: RGBA): boolean {
	return color.r === 0 && color.g === 0 && color.b === 0 && color.a === 0;
}

function uniqueAttrs(attrs: RawAttr[], section: string): Map<string, RawAttr> {
	const seen = new Map<string, RawAttr>();
	for (const attr of attrs) {
		if (!KEY.test(attr.key)) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				`Invalid key "${attr.key}" in ${section}; keys match [a-z][a-z0-9_]*.`,
				{ line: attr.line, section },
			);
		}
		if (seen.has(attr.key)) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				`Duplicate key "${attr.key}" in ${section}.`,
				{ line: attr.line, section },
			);
		}
		seen.set(attr.key, attr);
	}
	return seen;
}

function takeDimension(
	attrs: Map<string, RawAttr>,
	key: string,
	section: string,
	fallbackLine: number,
): number {
	const attr = attrs.get(key);
	if (attr === undefined) {
		throw mcpxError("MCPX_SCHEMA_ERROR", `${section} is missing "${key}".`, {
			line: fallbackLine,
			section,
		});
	}
	if (!UINT.test(attr.value)) {
		throw mcpxError(
			"MCPX_SCHEMA_ERROR",
			`"${key}" must be a decimal integer without leading zeros or signs.`,
			{ line: attr.line, section },
		);
	}
	const value = Number(attr.value);
	if (value < CANVAS_MIN_EDGE || value > CANVAS_MAX_EDGE) {
		throw mcpxError(
			"MCPX_SCHEMA_ERROR",
			`"${key}" must be within [${CANVAS_MIN_EDGE}, ${CANVAS_MAX_EDGE}].`,
			{ line: attr.line, section, value },
		);
	}
	return value;
}

function parseOpacity(attr: RawAttr, section: string): number {
	if (!OPACITY.test(attr.value)) {
		throw mcpxError(
			"MCPX_SCHEMA_ERROR",
			'"opacity" must be a decimal within [0, 1], without exponents.',
			{ line: attr.line, section },
		);
	}
	return Number(attr.value);
}

function parseVisible(attr: RawAttr, section: string): boolean {
	if (attr.value === "true") {
		return true;
	}
	if (attr.value === "false") {
		return false;
	}
	throw mcpxError("MCPX_SCHEMA_ERROR", '"visible" must be true or false.', {
		line: attr.line,
		section,
	});
}

function checkObjectId(id: string, line: number, kind: string): void {
	if (!OBJECT_ID.test(id)) {
		throw mcpxError(
			"MCPX_SCHEMA_ERROR",
			`${kind} id "${id}" uses characters outside [A-Za-z0-9_.-].`,
			{ line },
		);
	}
}

function validatePalette(doc: McpxDocument): ValidPaletteEntry[] {
	const out: ValidPaletteEntry[] = [];
	const seen = new Set<string>();
	for (const entry of doc.palette) {
		if (!NO_BLANK.test(entry.symbol)) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				`Palette symbol "${entry.symbol}" must not contain blanks or "=".`,
				{ line: entry.line, section: "palette" },
			);
		}
		if (entry.symbol.length === 1 && !SYMBOL_CHAR.test(entry.symbol)) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				`Single-character symbol "${entry.symbol}" is outside [.0-9A-Za-z].`,
				{ line: entry.line, section: "palette" },
			);
		}
		if (seen.has(entry.symbol)) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				`Duplicate palette symbol "${entry.symbol}".`,
				{ line: entry.line, section: "palette" },
			);
		}
		seen.add(entry.symbol);
		const color = parseColor(entry.colorText);
		if (color === null) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				`Invalid color "${entry.colorText}"; use transparent, #RRGGBB, or #RRGGBBAA.`,
				{ line: entry.line, section: "palette" },
			);
		}
		if (entry.symbol === "." && !isTransparent(color)) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				'"." is reserved for transparent (#00000000).',
				{ line: entry.line, section: "palette" },
			);
		}
		if (entry.symbol !== "." && isTransparent(color)) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				'Transparent (#00000000) must use the reserved symbol ".".',
				{ line: entry.line, section: "palette" },
			);
		}
		let role: PaletteRole | undefined;
		const attrSeen = new Set<string>();
		for (const raw of entry.attrs) {
			const cut = raw.indexOf("=");
			const key = raw.slice(0, cut);
			const value = raw.slice(cut + 1);
			if (!KEY.test(key) || value === "" || /\s/.test(value)) {
				throw mcpxError(
					"MCPX_SCHEMA_ERROR",
					`Malformed palette attribute "${raw}"; use key=value without blanks.`,
					{ line: entry.line, section: "palette" },
				);
			}
			if (attrSeen.has(key)) {
				throw mcpxError(
					"MCPX_SCHEMA_ERROR",
					`Duplicate palette attribute "${key}".`,
					{ line: entry.line, section: "palette" },
				);
			}
			attrSeen.add(key);
			if (key !== "role") {
				throw mcpxError(
					"MCPX_SCHEMA_ERROR",
					`Unknown palette attribute "${key}"; v1 only defines role.`,
					{ line: entry.line, section: "palette" },
				);
			}
			if (!ROLES.has(value)) {
				throw mcpxError(
					"MCPX_SCHEMA_ERROR",
					`Unknown palette role "${value}".`,
					{ line: entry.line, section: "palette" },
				);
			}
			role = value as PaletteRole;
		}
		out.push({
			symbol: entry.symbol,
			color,
			...(role !== undefined ? { role } : {}),
			line: entry.line,
		});
	}
	return out;
}

function validateLayer(
	raw: RawLayer,
	symbols: ReadonlySet<string>,
	width: number,
	height: number,
): ValidLayer {
	checkObjectId(raw.id, raw.line, "Layer");
	const section = `layer ${raw.id}`;
	const attrs = uniqueAttrs(raw.attrs, section);
	for (const key of attrs.keys()) {
		if (key !== "visible" && key !== "opacity" && key !== "name") {
			const attr = attrs.get(key) as RawAttr;
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				`Unknown layer key "${key}"; v1 supports visible, opacity, name.`,
				{ line: attr.line, section },
			);
		}
	}
	const visibleAttr = attrs.get("visible");
	const opacityAttr = attrs.get("opacity");
	const nameAttr = attrs.get("name");
	const visible =
		visibleAttr === undefined ? true : parseVisible(visibleAttr, section);
	const opacity =
		opacityAttr === undefined ? 1 : parseOpacity(opacityAttr, section);
	let name: string | undefined;
	if (nameAttr !== undefined) {
		if (/\s/.test(nameAttr.value)) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				'Layer "name" must not contain blanks in v1 (no quoting).',
				{ line: nameAttr.line, section },
			);
		}
		name = nameAttr.value;
	}
	const grid = raw.grid as NonNullable<RawLayer["grid"]>;
	const cells: string[][] = [];
	for (const row of grid.rows) {
		let parts: string[];
		if (grid.kind === "compact") {
			parts = [...row.text];
		} else {
			parts = row.text.split(" ");
			if (parts.some((part) => part === "")) {
				throw mcpxError(
					"MCPX_SYNTAX_ERROR",
					"Tokenized grid rows separate tokens with single spaces.",
					{ line: row.line, section },
				);
			}
		}
		if (parts.length !== width) {
			throw mcpxError(
				"INVALID_GRID_SIZE",
				`Grid row has ${parts.length} symbols but canvas width is ${width}.`,
				{ line: row.line, section, expected: width, actual: parts.length },
			);
		}
		for (const symbol of parts) {
			if (!symbols.has(symbol)) {
				throw mcpxError(
					"MCPX_SEMANTIC_ERROR",
					`Grid symbol "${symbol}" is missing from [palette].`,
					{ line: row.line, section, symbol },
				);
			}
		}
		cells.push(parts);
	}
	if (cells.length !== height) {
		throw mcpxError(
			"INVALID_GRID_SIZE",
			`Grid has ${cells.length} rows but canvas height is ${height}.`,
			{ line: grid.line, section, expected: height, actual: cells.length },
		);
	}
	return {
		id: raw.id,
		visible,
		opacity,
		...(name !== undefined ? { name } : {}),
		gridKind: grid.kind,
		cells,
		gridLine: grid.line,
		line: raw.line,
	};
}

function validateRegion(
	raw: RawRegion,
	width: number,
	height: number,
): ValidRegion {
	checkObjectId(raw.id, raw.line, "Region");
	const section = `region ${raw.id}`;
	const attrs = uniqueAttrs(raw.attrs, section);
	for (const key of attrs.keys()) {
		if (key !== "name") {
			const attr = attrs.get(key) as RawAttr;
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				`Unknown region key "${key}"; v1 supports name only.`,
				{ line: attr.line, section },
			);
		}
	}
	const nameAttr = attrs.get("name");
	let name: string | undefined;
	if (nameAttr !== undefined) {
		if (/\s/.test(nameAttr.value)) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				'Region "name" must not contain blanks in v1 (no quoting).',
				{ line: nameAttr.line, section },
			);
		}
		name = nameAttr.value;
	}
	const mask = raw.mask as NonNullable<RawRegion["mask"]>;
	const cells: number[][] = [];
	for (const row of mask.rows) {
		const parts = [...row.text];
		if (parts.length !== width) {
			throw mcpxError(
				"INVALID_MASK_SIZE",
				`Mask row has ${parts.length} cells but canvas width is ${width}.`,
				{ line: row.line, section, expected: width, actual: parts.length },
			);
		}
		const parsed: number[] = [];
		for (const cell of parts) {
			if (cell === ".") {
				parsed.push(0);
			} else if (cell === "#") {
				parsed.push(1);
			} else {
				throw mcpxError(
					"MCPX_SYNTAX_ERROR",
					`Mask cell "${cell}" must be "." or "#".`,
					{ line: row.line, section },
				);
			}
		}
		cells.push(parsed);
	}
	if (cells.length !== height) {
		throw mcpxError(
			"INVALID_MASK_SIZE",
			`Mask has ${cells.length} rows but canvas height is ${height}.`,
			{ line: mask.line, section, expected: height, actual: cells.length },
		);
	}
	return {
		id: raw.id,
		...(name !== undefined ? { name } : {}),
		cells,
		maskLine: mask.line,
		line: raw.line,
	};
}

export function validateDocument(doc: McpxDocument): ValidDocument {
	const canvasAttrs = uniqueAttrs(doc.canvasAttrs, "canvas");
	for (const key of canvasAttrs.keys()) {
		if (key !== "width" && key !== "height") {
			const attr = canvasAttrs.get(key) as RawAttr;
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				`Unknown canvas key "${key}"; v1 supports width and height.`,
				{ line: attr.line, section: "canvas" },
			);
		}
	}
	const width = takeDimension(
		canvasAttrs,
		"width",
		"canvas",
		doc.canvasLine ?? doc.headerLine,
	);
	const height = takeDimension(
		canvasAttrs,
		"height",
		"canvas",
		doc.canvasLine ?? doc.headerLine,
	);

	const metadata: Record<string, string> = {};
	const seenMeta = new Set<string>();
	for (const attr of doc.metadataAttrs) {
		if (!KEY.test(attr.key)) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				`Invalid metadata key "${attr.key}".`,
				{ line: attr.line, section: "metadata" },
			);
		}
		if (seenMeta.has(attr.key)) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				`Duplicate metadata key "${attr.key}".`,
				{ line: attr.line, section: "metadata" },
			);
		}
		seenMeta.add(attr.key);
		if (/\s/.test(attr.value)) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				"Metadata values must not contain blanks in v1 (no quoting).",
				{ line: attr.line, section: "metadata" },
			);
		}
		metadata[attr.key] = attr.value;
	}

	const palette = validatePalette(doc);
	const symbols = new Set(palette.map((entry) => entry.symbol));

	const layers: ValidLayer[] = [];
	const layerIds = new Set<string>();
	for (const raw of doc.layers) {
		const layer = validateLayer(raw, symbols, width, height);
		if (layerIds.has(layer.id)) {
			throw mcpxError(
				"MCPX_SEMANTIC_ERROR",
				`Duplicate layer id "${layer.id}".`,
				{
					line: raw.line,
					section: `layer ${layer.id}`,
				},
			);
		}
		layerIds.add(layer.id);
		layers.push(layer);
	}

	const regions: ValidRegion[] = [];
	const regionIds = new Set<string>();
	for (const raw of doc.regions) {
		const region = validateRegion(raw, width, height);
		if (regionIds.has(region.id)) {
			throw mcpxError(
				"MCPX_SEMANTIC_ERROR",
				`Duplicate region id "${region.id}".`,
				{ line: raw.line, section: `region ${region.id}` },
			);
		}
		regionIds.add(region.id);
		regions.push(region);
	}

	return { width, height, metadata, palette, layers, regions };
}
