import { McAssetError } from "../core/errors.ts";
import type {
	AuthoringPaletteEntry,
	PixelCanvas,
	RGBA,
} from "../core/types.ts";
import { CANVAS_VERSION } from "../core/validate.ts";
import { serializeMcpx } from "../mcpx/index.ts";
import { parseHexColor } from "./color.ts";
import { paletteFamilyOrder } from "./palette.ts";
import { FAMILY_ROLES, type FamilyRamp, type ResolvedStyle } from "./types.ts";

/**
 * Palette export: one family, or every family the style resolves to, as an
 * `.mcpx` palette a `.mcpx`-reading command can take directly. The canvas
 * holds one row per family and one column per ramp role, and the declared
 * `[palette]` keeps the family-then-role order so every consumer sees the
 * ramps in the same sequence.
 */

/** Every family of a style in export order: builtin twelve, then extras. */
export type PaletteExport = {
	readonly styleId: string;
	readonly familyIds: readonly string[];
};

/** The `--family` value that selects every family the style carries. */
const ALL_FAMILIES = "all";

/** Symbols of the six roles on the single-family canvas, in ramp order. */
const SINGLE_FAMILY_SYMBOLS = ["A", "B", "C", "D", "E", "F"] as const;

/** Palette width: one column per ramp role. */
const PALETTE_WIDTH = FAMILY_ROLES.length;

/** Transparent cell: declared first, mapped to `#00000000`. */
const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };

/**
 * Build the canonical `.mcpx` palette of one family, or of every family in
 * `all`. A family the resolved style does not carry is STYLE_FAMILY_NOT_FOUND.
 */
export function buildPaletteMcpx(style: ResolvedStyle, family: string): string {
	const familyIds = exportFamilies(style, family);
	const entries: AuthoringPaletteEntry[] = [
		{ id: ".", color: { ...TRANSPARENT } },
	];
	const pixels = new Uint8Array(PALETTE_WIDTH * familyIds.length * 4);
	for (const [row, familyId] of familyIds.entries()) {
		const ramp = style.palettes[familyId] as FamilyRamp;
		for (const [column, role] of FAMILY_ROLES.entries()) {
			const symbol =
				familyIds.length === 1
					? SINGLE_FAMILY_SYMBOLS[column]
					: `${familyId}-${role}`;
			const color: RGBA = { ...parseHexColor(ramp[role]), a: 255 };
			entries.push({ id: symbol, color, role });
			const offset = (row * PALETTE_WIDTH + column) * 4;
			pixels[offset] = color.r;
			pixels[offset + 1] = color.g;
			pixels[offset + 2] = color.b;
			pixels[offset + 3] = color.a;
		}
	}
	const canvas: PixelCanvas = {
		version: CANVAS_VERSION,
		width: PALETTE_WIDTH,
		height: familyIds.length,
		layers: [
			{
				id: "base",
				pixels,
				visible: true,
				opacity: 1,
				blendMode: "normal",
			},
		],
		regions: [],
		palette: { entries },
		metadata: { kind: "palette", name: `${style.id}-${family}` },
	};
	return serializeMcpx(canvas);
}

/** The requested families in export order. */
function exportFamilies(style: ResolvedStyle, family: string): string[] {
	const familyIds =
		family === ALL_FAMILIES
			? paletteFamilyOrder(Object.keys(style.palettes))
			: style.palettes[family] === undefined
				? []
				: [family];
	if (familyIds.length === 0) {
		throw new McAssetError(
			"STYLE_FAMILY_NOT_FOUND",
			`family: expected a family of style ${style.id}, got ${JSON.stringify(family)}`,
			{ field: "family", family, style: style.id },
		);
	}
	return familyIds;
}
