import { McAssetError } from "../core/errors.ts";
import type { PixelCanvas } from "../core/types.ts";
import { parseMcpx } from "../mcpx/index.ts";

/**
 * Standalone ASCII Grid reader for `render <grid>` (§104.2, §96.8).
 *
 * A .grid file carries exactly two sections: the palette section, then
 * the grid section in compact or tokenized form. Dimensions come from the rows themselves, and the pixels
 * land on a single layer named "base". Everything else (regions, metadata,
 * multi-layer canvases) stays in .mcpx and the build command.
 *
 * Validation reuses the full mcpx pipeline: the grid is wrapped in a
 * synthesized mcpx document and parsed by parseMcpx, so palette colors,
 * roles, symbol rules, and grid sizes report the same codes a .mcpx file
 * would. Synthesized line numbers are mapped back to the grid file before
 * the error leaves this module.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stripCodePrefix(message: string): string {
	return message.replace(/^\[[A-Z0-9_]+\] /, "");
}

function lineOfOffset(text: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset; index += 1) {
		if (text[index] === "\n") {
			line += 1;
		}
	}
	return line;
}

function normalizeSectionHeader(trimmed: string): string | null {
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
		return null;
	}
	return trimmed.slice(1, -1).trim().replace(/\s+/g, " ");
}

export function parseGridFile(text: string): PixelCanvas {
	if (typeof text !== "string") {
		throw new McAssetError(
			"MCPX_SYNTAX_ERROR",
			"grid input must be a string.",
			{
				line: 0,
			},
		);
	}
	if (text.charCodeAt(0) === 0xfeff) {
		throw new McAssetError(
			"MCPX_SYNTAX_ERROR",
			"grid files must be UTF-8 without a BOM.",
			{ line: 1 },
		);
	}
	const cr = text.indexOf("\r");
	if (cr !== -1) {
		throw new McAssetError(
			"MCPX_SYNTAX_ERROR",
			"grid files must use LF newlines; CR found.",
			{ line: lineOfOffset(text, cr) },
		);
	}
	let seenPalette = false;
	let seenGrid = false;
	let inPalette = false;
	let inGrid = false;
	let gridEnded = false;
	let gridTokenized = false;
	let paletteHeaderLine = 0;
	let gridHeaderLine = 0;
	const paletteLines: Array<{ text: string; line: number }> = [];
	const gridRows: Array<{ text: string; line: number }> = [];
	const rawLines = text.split("\n");
	for (let index = 0; index < rawLines.length; index += 1) {
		const no = index + 1;
		const stripped = (rawLines[index] as string).replace(/[ \t]+$/, "");
		if (stripped === "") {
			if (gridRows.length > 0) {
				gridEnded = true;
			}
			continue;
		}
		const trimmed = stripped.replace(/^[ \t]+/, "");
		if (trimmed.startsWith(";")) {
			if (inGrid && gridRows.length > 0) {
				throw new McAssetError(
					"MCPX_SYNTAX_ERROR",
					"Comment lines must not appear inside [grid] data.",
					{ line: no },
				);
			}
			continue;
		}
		const header = normalizeSectionHeader(trimmed);
		if (
			header !== null &&
			(header === "palette" || header === "grid" || header === "grid tokens")
		) {
			if (header === "palette") {
				if (seenPalette) {
					throw new McAssetError(
						"MCPX_SYNTAX_ERROR",
						"Duplicate [palette] section.",
						{ line: no },
					);
				}
				if (seenGrid) {
					throw new McAssetError(
						"MCPX_SYNTAX_ERROR",
						"[palette] must come before [grid].",
						{ line: no },
					);
				}
				seenPalette = true;
				inPalette = true;
				inGrid = false;
				paletteHeaderLine = no;
				continue;
			}
			if (!seenPalette) {
				throw new McAssetError(
					"MCPX_SYNTAX_ERROR",
					"[grid] must follow [palette].",
					{ line: no },
				);
			}
			if (seenGrid) {
				throw new McAssetError(
					"MCPX_SYNTAX_ERROR",
					"Duplicate [grid] section.",
					{
						line: no,
					},
				);
			}
			seenGrid = true;
			inPalette = false;
			inGrid = true;
			gridTokenized = header === "grid tokens";
			gridHeaderLine = no;
			continue;
		}
		if (inGrid && !gridEnded) {
			gridRows.push({ text: trimmed, line: no });
			continue;
		}
		if (inPalette) {
			paletteLines.push({ text: trimmed, line: no });
			continue;
		}
		if (trimmed.startsWith("[")) {
			throw new McAssetError(
				"MCPX_SYNTAX_ERROR",
				`Unknown section ${trimmed}. A grid file holds [palette] and [grid] only.`,
				{ line: no },
			);
		}
		if (!trimmed.includes("=")) {
			throw new McAssetError(
				"MCPX_SYNTAX_ERROR",
				`Row "${trimmed}" appears outside [grid]; rows must form one contiguous block.`,
				{ line: no },
			);
		}
		throw new McAssetError(
			"MCPX_SYNTAX_ERROR",
			"Key-value line appears outside any section.",
			{ line: no },
		);
	}
	if (!seenPalette) {
		throw new McAssetError(
			"MCPX_SYNTAX_ERROR",
			"grid file is missing [palette].",
			{ line: rawLines.length },
		);
	}
	if (!seenGrid) {
		throw new McAssetError(
			"MCPX_SYNTAX_ERROR",
			"grid file is missing [grid].",
			{
				line: rawLines.length,
			},
		);
	}
	if (gridRows.length === 0) {
		throw new McAssetError("MCPX_SYNTAX_ERROR", "[grid] has no rows.", {
			line: gridHeaderLine,
		});
	}
	const firstRow = (gridRows[0] as { text: string }).text;
	const width = gridTokenized
		? firstRow.split(" ").length
		: [...firstRow].length;
	const height = gridRows.length;
	const synth: string[] = [];
	const lineMap: number[] = [];
	const push = (lineText: string, original: number): void => {
		synth.push(lineText);
		lineMap.push(original);
	};
	push("mcpx 1", 0);
	push("", 0);
	push("[canvas]", 0);
	push(`width = ${width}`, 0);
	push(`height = ${height}`, 0);
	push("", 0);
	push("[palette]", paletteHeaderLine);
	for (const entry of paletteLines) {
		push(entry.text, entry.line);
	}
	push("", 0);
	push("[layer base]", 0);
	push("visible = true", 0);
	push("opacity = 1.000", 0);
	push("", 0);
	push(gridTokenized ? "[grid tokens]" : "[grid]", gridHeaderLine);
	for (const row of gridRows) {
		push(row.text, row.line);
	}
	try {
		return parseMcpx(synth.join("\n"));
	} catch (error) {
		if (error instanceof McAssetError) {
			const details = error.details;
			if (isRecord(details) && typeof details.line === "number") {
				const mapped = lineMap[(details.line as number) - 1];
				if (mapped !== undefined && mapped !== 0) {
					throw new McAssetError(error.code, stripCodePrefix(error.message), {
						...details,
						line: mapped,
					});
				}
			}
		}
		throw error;
	}
}
