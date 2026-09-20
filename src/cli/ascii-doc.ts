import type { RGBA } from "../core/types.ts";
import { assignSymbols, colorKeyOf } from "../mcpx/index.ts";

export function toHex(color: RGBA): string {
	const byte = (value: number): string => value.toString(16).padStart(2, "0");
	return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}${byte(color.a)}`.toUpperCase();
}

export interface AsciiDoc {
	/** Document lines without the trailing newline, for result.ascii. */
	lines: string[];
	/** Symbol to #RRGGBBAA in assignment order. */
	palette: Record<string, string>;
}

/**
 * Flatten-only ASCII document: existing .mcpx symbols are kept verbatim
 * and new colors take the shared assignSymbols order (transparent fixed
 * to ".", the rest by RGBA 32-bit key ascending), so the same pixels
 * always print the same document. Only colors present in the flatten
 * enter the palette; the grid header follows the compact/tokenized rule.
 */
export function buildAsciiDoc(
	existing: ReadonlyArray<{ id: string; color: RGBA }>,
	pixels: Uint8Array,
	width: number,
	height: number,
): AsciiDoc {
	const colors: RGBA[] = [];
	for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
		colors.push({
			r: pixels[offset] as number,
			g: pixels[offset + 1] as number,
			b: pixels[offset + 2] as number,
			a: pixels[offset + 3] as number,
		});
	}
	const assigned = assignSymbols(existing, colors);
	const symbolForColor = new Map<string, string>();
	for (const entry of assigned) {
		const key = colorKeyOf(entry.color);
		if (!symbolForColor.has(key)) {
			symbolForColor.set(key, entry.id);
		}
	}
	const used = new Set<string>();
	for (const color of colors) {
		used.add(colorKeyOf(color));
	}
	const palette: Record<string, string> = {};
	const paletteLines: string[] = [];
	for (const entry of assigned) {
		if (!used.has(colorKeyOf(entry.color))) {
			continue;
		}
		if (entry.id in palette) {
			continue;
		}
		palette[entry.id] = toHex(entry.color);
		paletteLines.push(`${entry.id} = ${toHex(entry.color)}`);
	}
	const grid: string[][] = [];
	let compact = true;
	for (let y = 0; y < height; y += 1) {
		const cells: string[] = [];
		for (let x = 0; x < width; x += 1) {
			const offset = (y * width + x) * 4;
			const symbol = symbolForColor.get(
				`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]},${pixels[offset + 3]}`,
			) as string;
			if (symbol.length !== 1) {
				compact = false;
			}
			cells.push(symbol);
		}
		grid.push(cells);
	}
	const header = compact ? "[grid]" : "[grid tokens]";
	const rows = grid.map((cells) => cells.join(compact ? "" : " "));
	const lines = ["[palette]", ...paletteLines, "", header, ...rows];
	return { lines, palette };
}
