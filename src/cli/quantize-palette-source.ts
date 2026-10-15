import { McAssetError } from "../core/errors.ts";
import { getMaterialPalette, isBuiltinMaterialId } from "../core/material.ts";
import { QUANTIZE_PALETTE_MAX_COLORS } from "../core/quantize-palette.ts";
import type { RGBA } from "../core/types.ts";
import { parseMcpx } from "../mcpx/index.ts";
import { readInputText } from "./artifacts.ts";

/**
 * Shared palette source loader for quantize.
 *
 * - An exact builtin material id wins (same list as generate); otherwise the
 *   value must be an `.mcpx` path whose `[palette]` supplies the colors.
 * - Anything else, an empty palette, or more than 4096 colors is
 *   INVALID_ARGUMENT; an unreadable file is FILESYSTEM_ERROR; malformed
 *   `.mcpx` keeps its MCPX_* code. No derived filenames.
 */

export interface ResolvedQuantizePalette {
	colors: RGBA[];
	label: string;
}

/**
 * Resolve the quantize `--palette` source to explicit RGBA colors.
 * Declared `.mcpx` palette order is kept verbatim, including unused colors.
 */
export async function resolveQuantizePalette(
	raw: string,
): Promise<ResolvedQuantizePalette> {
	if (isBuiltinMaterialId(raw)) {
		const entries = getMaterialPalette(raw).entries;
		return {
			colors: entries.map((entry) => ({ ...entry.color })),
			label: raw,
		};
	}
	if (!raw.toLowerCase().endsWith(".mcpx")) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`--palette must be a builtin material id or an .mcpx path, got "${raw}".`,
			{ palette: raw },
		);
	}
	const text = await readInputText(raw, "palette file");
	const canvas = parseMcpx(text);
	const colors = (canvas.palette?.entries ?? []).map((entry) => ({
		...entry.color,
	}));
	if (colors.length === 0) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Palette file has no [palette] colors: ${raw}.`,
			{ palette: raw },
		);
	}
	if (colors.length > QUANTIZE_PALETTE_MAX_COLORS) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Palette file holds too many colors: ${colors.length} (max ${QUANTIZE_PALETTE_MAX_COLORS}).`,
			{ palette: raw, colorCount: colors.length },
		);
	}
	return { colors, label: raw };
}
