import { mcpxError } from "./errors.ts";

/**
 * Line-level tokenizer. It only classifies shapes (blank, comment, section,
 * content) and rejects carriage returns and BOMs; section order, attachment,
 * and value shapes belong to later stages.
 */

export type LineKind = "blank" | "comment" | "section" | "content";

export interface TextLine {
	no: number;
	kind: LineKind;
	text: string;
}

/** A `[name]` line only counts as a section when the inner text is known. */
const SECTION_INNER =
	/^(canvas|metadata|palette|grid tokens|grid|mask|layer [A-Za-z0-9_.-]+|region [A-Za-z0-9_.-]+)$/;

function lineOfOffset(text: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset; i += 1) {
		if (text[i] === "\n") {
			line += 1;
		}
	}
	return line;
}

export function tokenize(text: string): TextLine[] {
	if (typeof text !== "string") {
		throw mcpxError("MCPX_SYNTAX_ERROR", "mcpx input must be a string.", {
			line: 0,
		});
	}
	if (text.charCodeAt(0) === 0xfeff) {
		throw mcpxError(
			"MCPX_SYNTAX_ERROR",
			"mcpx files must be UTF-8 without a BOM.",
			{ line: 1 },
		);
	}
	const cr = text.indexOf("\r");
	if (cr !== -1) {
		throw mcpxError(
			"MCPX_SYNTAX_ERROR",
			"mcpx files must use LF newlines; CR found.",
			{ line: lineOfOffset(text, cr) },
		);
	}
	return text.split("\n").map((raw, index) => {
		const no = index + 1;
		// Trailing blanks are stripped for every line: canonical output never
		// carries them, and hand-written ones must not shift grid widths.
		const stripped = raw.replace(/[ \t]+$/, "");
		if (stripped === "") {
			return { no, kind: "blank", text: "" } as TextLine;
		}
		const trimmed = stripped.replace(/^[ \t]+/, "");
		if (trimmed.startsWith(";")) {
			return { no, kind: "comment", text: trimmed };
		}
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			const inner = trimmed.slice(1, -1).trim().replace(/\s+/g, " ");
			if (SECTION_INNER.test(inner)) {
				return { no, kind: "section", text: inner };
			}
			// A bracketed line that is not a known section stays content:
			// the parser rejects it outside grids, and inside a tokenized
			// grid it is just another token row candidate.
			return { no, kind: "content", text: trimmed };
		}
		return { no, kind: "content", text: trimmed };
	});
}
