import { mcpxError } from "./errors.ts";
import type { TextLine } from "./tokenizer.ts";

/**
 * Syntax stage: turns classified lines into a raw document. It enforces file
 * structure only (header, known sections, canonical order, grid/mask
 * attachment). Value shapes and cross-references belong to the validator.
 */

export interface RawAttr {
	key: string;
	value: string;
	line: number;
}

export interface RawPaletteEntry {
	symbol: string;
	colorText: string;
	attrs: string[];
	line: number;
}

export interface RawRow {
	text: string;
	line: number;
}

export interface RawGrid {
	kind: "compact" | "tokens";
	rows: RawRow[];
	line: number;
}

export interface RawMask {
	rows: RawRow[];
	line: number;
}

export interface RawLayer {
	id: string;
	line: number;
	attrs: RawAttr[];
	grid: RawGrid | null;
}

export interface RawRegion {
	id: string;
	line: number;
	attrs: RawAttr[];
	mask: RawMask | null;
}

export interface McpxDocument {
	headerLine: number;
	canvasAttrs: RawAttr[];
	canvasLine: number | null;
	metadataAttrs: RawAttr[];
	palette: RawPaletteEntry[];
	layers: RawLayer[];
	regions: RawRegion[];
}

function splitKeyValue(
	text: string,
	line: number,
	what: string,
): { head: string; tail: string } {
	const cut = text.indexOf("=");
	if (cut === -1) {
		throw mcpxError("MCPX_SYNTAX_ERROR", `${what} must contain "=".`, {
			line,
		});
	}
	const head = text.slice(0, cut).trim();
	const tail = text.slice(cut + 1).trim();
	if (head === "" || tail === "") {
		throw mcpxError("MCPX_SYNTAX_ERROR", `${what} needs a key and a value.`, {
			line,
		});
	}
	return { head, tail };
}

export function parseDocument(lines: TextLine[]): McpxDocument {
	let cursor = 0;
	while (
		cursor < lines.length &&
		(lines[cursor]?.kind === "blank" || lines[cursor]?.kind === "comment")
	) {
		cursor += 1;
	}
	const header = lines[cursor];
	if (header === undefined || header.kind !== "content") {
		throw mcpxError(
			"MCPX_SYNTAX_ERROR",
			'mcpx file must start with "mcpx 1".',
			{
				line: header?.no ?? 1,
			},
		);
	}
	const headerMatch = /^mcpx[ \t]+(\S+)$/.exec(header.text);
	if (headerMatch === null || headerMatch[1] === undefined) {
		throw mcpxError("MCPX_SYNTAX_ERROR", 'mcpx header must be "mcpx 1".', {
			line: header.no,
		});
	}
	if (!/^[0-9]+$/.test(headerMatch[1])) {
		throw mcpxError("MCPX_SYNTAX_ERROR", "mcpx version must be an integer.", {
			line: header.no,
		});
	}
	if (Number(headerMatch[1]) !== 1) {
		throw mcpxError(
			"MCPX_UNSUPPORTED_VERSION",
			`Unsupported mcpx major version ${headerMatch[1]}; this build reads v1 only.`,
			{ line: header.no, version: Number(headerMatch[1]) },
		);
	}

	const doc: McpxDocument = {
		headerLine: header.no,
		canvasAttrs: [],
		canvasLine: null,
		metadataAttrs: [],
		palette: [],
		layers: [],
		regions: [],
	};
	// Canonical phase order: canvas(1) metadata(2) palette(3) layers(4) regions(5).
	let phase = 0;
	let openLayer: RawLayer | null = null;
	let openRegion: RawRegion | null = null;
	let collecting: RawGrid | RawMask | null = null;

	const closeLayer = (): void => {
		if (openLayer !== null && openLayer.grid === null) {
			throw mcpxError(
				"MCPX_SYNTAX_ERROR",
				`Layer "${openLayer.id}" is missing its [grid] section.`,
				{ line: openLayer.line, section: `layer ${openLayer.id}` },
			);
		}
		openLayer = null;
		collecting = null;
	};

	const closeRegion = (): void => {
		if (openRegion !== null && openRegion.mask === null) {
			throw mcpxError(
				"MCPX_SYNTAX_ERROR",
				`Region "${openRegion.id}" is missing its [mask] section.`,
				{ line: openRegion.line, section: `region ${openRegion.id}` },
			);
		}
		openRegion = null;
		collecting = null;
	};

	for (let i = cursor + 1; i < lines.length; i += 1) {
		const line = lines[i] as TextLine;
		if (line.kind === "blank") {
			// A grid or mask is one contiguous block of rows: the first blank
			// line after rows ends it, so a later comment is outside the data
			// while a blank line inside the data breaks the block explicitly.
			if (collecting !== null && collecting.rows.length > 0) {
				collecting = null;
			}
			continue;
		}
		if (line.kind === "comment") {
			if (collecting !== null && collecting.rows.length > 0) {
				throw mcpxError(
					"MCPX_SYNTAX_ERROR",
					"Comment lines must not appear inside [grid] or [mask] data.",
					{ line: line.no },
				);
			}
			continue;
		}
		if (line.kind === "section") {
			const name = line.text;
			if (name === "canvas") {
				if (phase !== 0) {
					throw mcpxError(
						"MCPX_SYNTAX_ERROR",
						"[canvas] must be the first section.",
						{ line: line.no },
					);
				}
				closeLayer();
				closeRegion();
				phase = 1;
				doc.canvasLine = line.no;
			} else if (name === "metadata") {
				if (phase !== 1) {
					throw mcpxError(
						"MCPX_SYNTAX_ERROR",
						"[metadata] must follow [canvas].",
						{ line: line.no },
					);
				}
				phase = 2;
			} else if (name === "palette") {
				if (phase !== 1 && phase !== 2) {
					throw mcpxError(
						"MCPX_SYNTAX_ERROR",
						"[palette] must follow [canvas] or [metadata].",
						{ line: line.no },
					);
				}
				phase = 3;
			} else if (name.startsWith("layer ")) {
				if (phase < 1 || phase > 4) {
					throw mcpxError(
						"MCPX_SYNTAX_ERROR",
						"Layers must come after [canvas] and before any [region].",
						{ line: line.no },
					);
				}
				closeLayer();
				closeRegion();
				phase = 4;
				const layer: RawLayer = {
					id: name.slice("layer ".length),
					line: line.no,
					attrs: [],
					grid: null,
				};
				doc.layers.push(layer);
				openLayer = layer;
			} else if (name === "grid" || name === "grid tokens") {
				if (openLayer === null || openLayer.grid !== null || phase !== 4) {
					throw mcpxError(
						"MCPX_SYNTAX_ERROR",
						"[grid] must directly follow its [layer] header.",
						{ line: line.no },
					);
				}
				const grid: RawGrid = {
					kind: name === "grid" ? "compact" : "tokens",
					rows: [],
					line: line.no,
				};
				openLayer.grid = grid;
				collecting = grid;
			} else if (name.startsWith("region ")) {
				if (phase < 1) {
					throw mcpxError(
						"MCPX_SYNTAX_ERROR",
						"Regions must come after [canvas].",
						{ line: line.no },
					);
				}
				closeLayer();
				closeRegion();
				phase = 5;
				const region: RawRegion = {
					id: name.slice("region ".length),
					line: line.no,
					attrs: [],
					mask: null,
				};
				doc.regions.push(region);
				openRegion = region;
			} else if (name === "mask") {
				if (openRegion === null || openRegion.mask !== null || phase !== 5) {
					throw mcpxError(
						"MCPX_SYNTAX_ERROR",
						"[mask] must directly follow its [region] header.",
						{ line: line.no },
					);
				}
				const mask: RawMask = { rows: [], line: line.no };
				openRegion.mask = mask;
				collecting = mask;
			} else {
				throw mcpxError("MCPX_SYNTAX_ERROR", `Unknown section [${name}].`, {
					line: line.no,
				});
			}
			continue;
		}
		// Content line.
		if (collecting !== null) {
			if (line.text.includes("=")) {
				throw mcpxError(
					"MCPX_SYNTAX_ERROR",
					"Key-value lines must not appear inside [grid] or [mask] data.",
					{ line: line.no },
				);
			}
			collecting.rows.push({ text: line.text, line: line.no });
			continue;
		}
		if (line.text.startsWith("[")) {
			throw mcpxError("MCPX_SYNTAX_ERROR", `Unknown section ${line.text}.`, {
				line: line.no,
			});
		}
		if (!line.text.includes("=")) {
			throw mcpxError(
				"MCPX_SYNTAX_ERROR",
				`Row "${line.text}" appears outside [grid] or [mask]; rows must form one contiguous block.`,
				{ line: line.no },
			);
		}
		const { head, tail } = splitKeyValue(line.text, line.no, "Key-value line");
		if (phase === 1 && openLayer === null) {
			doc.canvasAttrs.push({ key: head, value: tail, line: line.no });
		} else if (phase === 2) {
			doc.metadataAttrs.push({ key: head, value: tail, line: line.no });
		} else if (phase === 3) {
			const parts = tail.split(/[ \t]+/);
			const colorText = parts[0] as string;
			doc.palette.push({
				symbol: head,
				colorText,
				attrs: parts.slice(1),
				line: line.no,
			});
		} else if (phase === 4 && openLayer !== null) {
			openLayer.attrs.push({ key: head, value: tail, line: line.no });
		} else if (phase === 5 && openRegion !== null) {
			openRegion.attrs.push({ key: head, value: tail, line: line.no });
		} else {
			throw mcpxError(
				"MCPX_SYNTAX_ERROR",
				"Key-value line appears outside any section.",
				{ line: line.no },
			);
		}
	}

	closeLayer();
	closeRegion();
	if (doc.canvasLine === null) {
		throw mcpxError("MCPX_SYNTAX_ERROR", "mcpx file is missing [canvas].", {
			line: doc.headerLine,
		});
	}
	return doc;
}
