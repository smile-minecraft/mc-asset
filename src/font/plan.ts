import { addLayer, createCanvas, replaceLayerPixels } from "../core/canvas.ts";
import { McAssetError } from "../core/errors.ts";
import type { PixelCanvas } from "../core/types.ts";
import { CANVAS_MAX_EDGE } from "../core/validate.ts";
import { encodePng, flattenCanvas } from "../io/png.ts";
import {
	FONT_DEFAULT_COLUMNS,
	FONT_PUA_LAST,
	type FontSpec,
	type FontSpecIcon,
} from "./spec.ts";

/**
 * Font atlas planning: pure functions over a parsed spec and the loaded
 * icon canvases. Layout, code-point allocation and both document bodies are
 * decided here; the caller owns reading images and writing bytes. Every
 * value is integer-only, so the same spec and pixels always produce the
 * same PNG bytes and JSON text on Bun and Node.
 */

/** One loaded icon image, keyed by the spec name. */
export interface FontGlyphSource {
	readonly name: string;
	readonly canvas: PixelCanvas;
}

/** Where one icon landed inside its own atlas: code point and cell. */
export interface FontPlanGlyph {
	readonly name: string;
	readonly codePoint: number;
	readonly character: string;
	readonly column: number;
	readonly row: number;
}

/** The encoded atlas and the geometry the definition describes. */
export interface FontAtlas {
	readonly width: number;
	readonly height: number;
	readonly png: Uint8Array;
}

/** Minecraft `bitmap` provider. */
export interface FontBitmapProvider {
	readonly type: "bitmap";
	readonly file: string;
	readonly ascent: number;
	readonly height: number;
	readonly chars: readonly string[];
}

/** Minecraft `space` provider. */
export interface FontSpaceProvider {
	readonly type: "space";
	readonly advances: Readonly<Record<string, number>>;
}

/** Minecraft `reference` provider. */
export interface FontReferenceProvider {
	readonly type: "reference";
	readonly id: string;
}

export type FontProvider =
	| FontBitmapProvider
	| FontSpaceProvider
	| FontReferenceProvider;

/** The `assets/<ns>/font/<id>.json` body. */
export interface FontDefinition {
	readonly providers: readonly FontProvider[];
}

/** One row of the icon-to-character table. */
export interface FontTableIcon {
	readonly name: string;
	readonly character: string;
	readonly codePoint: number;
}

/** The standalone icon-to-character table. */
export interface FontTable {
	readonly font: string;
	readonly icons: readonly FontTableIcon[];
}

/** One grid-aligned atlas and the `bitmap` provider that reads it. */
export interface FontAtlasPlan {
	/** Bitmap `file` resource location of this atlas, `.png` included. */
	readonly texture: string;
	/** Provider height (also the atlas cell height). */
	readonly height: number;
	/** Provider ascent; negative values move the glyph down. */
	readonly ascent: number;
	readonly columns: number;
	readonly rows: number;
	readonly atlasWidth: number;
	readonly atlasHeight: number;
	/** Icons in this atlas, in name order. */
	readonly cells: readonly FontPlanGlyph[];
	readonly atlas: FontAtlas;
	readonly provider: FontBitmapProvider;
}

/** Everything one run produces, before any byte is written. */
export interface FontPlan {
	readonly font: string;
	/** One atlas per distinct `(height, ascent)` pair, smallest height first. */
	readonly atlases: readonly FontAtlasPlan[];
	/** Every icon in name order; the table rows and the icon count. */
	readonly glyphs: readonly FontTableIcon[];
	readonly definition: FontDefinition;
	readonly definitionText: string;
	readonly table: FontTable;
	readonly tableText: string;
}

/**
 * Cell filler for a partly filled `chars` row. Minecraft's bitmap loader
 * requires the same cell count in every row of one provider, so the last row
 * is padded; U+0000 names no glyph, so the cell stays empty.
 */
const PAD_CHARACTER = "\u0000";

/**
 * Canonical document text: byte-ordered keys, two-space indent, trailing
 * newline. The same rule every project document uses (see
 * `src/pack/document.ts`); kept local so `src/font` does not depend on the
 * pack modules that will call it.
 */
function canonicalFontText(value: unknown): string {
	return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => sortKeys(entry));
	}
	if (typeof value === "object" && value !== null) {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
		}
		return sorted;
	}
	return value;
}

function characterOf(codePoint: number): string {
	return String.fromCodePoint(codePoint);
}

function fontInvalid(field: string, message: string, extra = {}): never {
	throw new McAssetError("FONT_INVALID", message, { field, ...extra });
}

/** A named image, present because sourcesByName checked the pairing. */
function canvasOf(
	byName: ReadonlyMap<string, PixelCanvas>,
	name: string,
): PixelCanvas {
	const canvas = byName.get(name);
	if (canvas === undefined) {
		throw new McAssetError(
			"INTERNAL_ERROR",
			`Missing the loaded image for "${name}".`,
		);
	}
	return canvas;
}

/** Pair every spec icon with exactly one loaded canvas. */
function sourcesByName(
	spec: FontSpec,
	sources: readonly FontGlyphSource[],
): ReadonlyMap<string, PixelCanvas> {
	const byName = new Map<string, PixelCanvas>();
	for (const source of sources) {
		if (byName.has(source.name)) {
			fontInvalid(
				"icons",
				`The icon "${source.name}" was loaded more than once.`,
			);
		}
		byName.set(source.name, source.canvas);
	}
	const specNames = new Set(spec.icons.map((icon) => icon.name));
	for (const icon of spec.icons) {
		if (!byName.has(icon.name)) {
			fontInvalid("icons", `The icon "${icon.name}" has no loaded image.`);
		}
	}
	for (const name of byName.keys()) {
		if (!specNames.has(name)) {
			fontInvalid("icons", `The image "${name}" is not named in the spec.`);
		}
	}
	return byName;
}

/**
 * Assign the remaining code points in name order, skipping every fixed
 * one. The result depends only on the sorted names, the fixed set, and the
 * start, never on the order the caller listed the icons in.
 */
function allocateCodePoints(spec: FontSpec): Map<string, number> {
	const claimed = new Map<number, string>();
	for (const icon of spec.icons) {
		if (icon.codePoint !== undefined) {
			claimed.set(icon.codePoint, icon.name);
		}
	}
	if (spec.space !== undefined) {
		claimed.set(spec.space.codePoint, "space");
	}
	const assigned = new Map<string, number>();
	let next = spec.start;
	for (const icon of spec.icons) {
		if (icon.codePoint !== undefined) {
			assigned.set(icon.name, icon.codePoint);
			continue;
		}
		while (claimed.has(next)) {
			next += 1;
		}
		if (next > FONT_PUA_LAST) {
			throw new McAssetError(
				"FONT_INVALID",
				`No free private use code point is left at or after U+${spec.start.toString(16).toUpperCase().padStart(4, "0")} for "${icon.name}".`,
				{ field: "start", codePoint: spec.start, name: icon.name },
			);
		}
		claimed.set(next, icon.name);
		assigned.set(icon.name, next);
		next += 1;
	}
	return assigned;
}

/**
 * Draw every icon of one group into its cell. Cells are `cellWidth x height`,
 * cells in a row share the baseline grid, and a shorter image keeps its
 * top-left corner at the cell's top-left; the remaining rows stay transparent.
 */
function buildAtlas(
	cells: readonly FontPlanGlyph[],
	byName: ReadonlyMap<string, PixelCanvas>,
	cellWidth: number,
	height: number,
	columns: number,
	rows: number,
): FontAtlas {
	const width = cellWidth * columns;
	const atlasHeight = height * rows;
	if (width > CANVAS_MAX_EDGE || atlasHeight > CANVAS_MAX_EDGE) {
		fontInvalid(
			"icons",
			`The atlas would be ${width}x${atlasHeight}; the canvas edge limit is ${CANVAS_MAX_EDGE}. Use fewer icons or a larger columns value.`,
			{ width, height: atlasHeight },
		);
	}
	const pixels = new Uint8Array(width * atlasHeight * 4);
	for (const cell of cells) {
		const canvas = canvasOf(byName, cell.name);
		const source = flattenCanvas(canvas);
		const left = cell.column * cellWidth * 4;
		const top = cell.row * height;
		for (let y = 0; y < canvas.height; y += 1) {
			const from = y * canvas.width * 4;
			const to = (top + y) * width * 4 + left;
			pixels.set(source.subarray(from, from + canvas.width * 4), to);
		}
	}
	const canvas = createCanvas(width, atlasHeight);
	const layer = addLayer(canvas, { id: "atlas" });
	replaceLayerPixels(canvas, layer.id, pixels);
	return { width, height: atlasHeight, png: encodePng(canvas) };
}

/**
 * One `chars` entry per row, in name order. Minecraft reads the grid by
 * splitting every row into the same number of cells, so each row is padded
 * to `columns` with U+0000; a short last row would make the loader reject
 * the provider.
 */
function charsRows(
	cells: readonly FontPlanGlyph[],
	columns: number,
): readonly string[] {
	const rows: string[] = [];
	for (let start = 0; start < cells.length; start += columns) {
		const characters = cells
			.slice(start, start + columns)
			.map((cell) => cell.character);
		while (characters.length < columns) {
			characters.push(PAD_CHARACTER);
		}
		rows.push(characters.join(""));
	}
	return rows;
}

/** One `(height, ascent)` pair and the icons whose provider uses it. */
interface AtlasGroup {
	readonly height: number;
	readonly ascent: number;
	readonly icons: readonly FontSpecIcon[];
}

/**
 * Group the name-sorted icons by their resolved geometry. Groups are ordered
 * by height and then ascent, so the group order — and with it the provider
 * order and the derived texture names — depends only on the values, never on
 * the order the caller listed the icons in.
 */
function groupByGeometry(spec: FontSpec): readonly AtlasGroup[] {
	const byKey = new Map<
		string,
		{ height: number; ascent: number; icons: FontSpecIcon[] }
	>();
	for (const icon of spec.icons) {
		const key = `${icon.height}/${icon.ascent}`;
		let group = byKey.get(key);
		if (group === undefined) {
			group = { height: icon.height, ascent: icon.ascent, icons: [] };
			byKey.set(key, group);
		}
		group.icons.push(icon);
	}
	return [...byKey.values()].sort(
		(left, right) => left.height - right.height || left.ascent - right.ascent,
	);
}

/**
 * Atlas name for one geometry group: the base texture with
 * `_h<height>a<ascent>` before the extension, e.g. `example:font/icons.png`
 * becomes `example:font/icons_h8a7.png`. Only `[a-z0-9_-]` is inserted, so a
 * valid base texture stays a valid texture path.
 */
function groupTexture(base: string, height: number, ascent: number): string {
	const extension = base.toLowerCase().lastIndexOf(".png");
	return `${base.slice(0, extension)}_h${height}a${ascent}${base.slice(extension)}`;
}

/**
 * Plan one font: validate the images against their provider geometry,
 * allocate code points, lay one atlas out per `(height, ascent)` group, and
 * render both documents. Nothing here touches the filesystem.
 */
export function planFont(
	spec: FontSpec,
	sources: readonly FontGlyphSource[],
): FontPlan {
	const byName = sourcesByName(spec, sources);
	const assigned = allocateCodePoints(spec);
	const glyphs: FontTableIcon[] = spec.icons.map((icon) => {
		const codePoint = assigned.get(icon.name) as number;
		return {
			name: icon.name,
			codePoint,
			character: characterOf(codePoint),
		};
	});
	const characters = new Map(glyphs.map((glyph) => [glyph.name, glyph]));
	const groups = groupByGeometry(spec);
	const atlases: FontAtlasPlan[] = groups.map((group) => {
		const texture =
			groups.length === 1
				? spec.texture
				: groupTexture(spec.texture, group.height, group.ascent);
		let cellWidth = 0;
		for (const icon of group.icons) {
			const canvas = canvasOf(byName, icon.name);
			if (canvas.height > group.height) {
				fontInvalid(
					"icons",
					`The icon "${icon.name}" is ${canvas.height}px tall, taller than its provider height ${group.height}.`,
					{
						name: icon.name,
						imageHeight: canvas.height,
						height: group.height,
					},
				);
			}
			if (canvas.width > cellWidth) {
				cellWidth = canvas.width;
			}
		}
		const columns =
			spec.columns === undefined
				? Math.min(group.icons.length, FONT_DEFAULT_COLUMNS)
				: Math.min(spec.columns, group.icons.length);
		const rows = Math.ceil(group.icons.length / columns);
		const cells: FontPlanGlyph[] = group.icons.map((icon, index) => {
			const glyph = characters.get(icon.name) as FontTableIcon;
			return {
				name: icon.name,
				codePoint: glyph.codePoint,
				character: glyph.character,
				column: index % columns,
				row: Math.floor(index / columns),
			};
		});
		const atlas = buildAtlas(
			cells,
			byName,
			cellWidth,
			group.height,
			columns,
			rows,
		);
		return {
			texture,
			height: group.height,
			ascent: group.ascent,
			columns,
			rows,
			atlasWidth: atlas.width,
			atlasHeight: atlas.height,
			cells,
			atlas,
			provider: {
				type: "bitmap",
				file: texture,
				ascent: group.ascent,
				height: group.height,
				chars: charsRows(cells, columns),
			},
		};
	});
	const font = `${spec.namespace}:${spec.id}`;
	const providers: FontProvider[] = atlases.map((atlas) => atlas.provider);
	if (spec.space !== undefined) {
		providers.push({
			type: "space",
			advances: { [characterOf(spec.space.codePoint)]: spec.space.advance },
		});
	}
	if (spec.reference !== undefined) {
		providers.push({ type: "reference", id: spec.reference });
	}
	const definition: FontDefinition = { providers };
	const table: FontTable = { font, icons: glyphs };
	return {
		font,
		atlases,
		glyphs,
		definition,
		definitionText: canonicalFontText(definition),
		table,
		tableText: canonicalFontText(table),
	};
}
