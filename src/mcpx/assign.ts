import type {
	AuthoringPaletteEntry,
	PixelCanvas,
	RGBA,
} from "../core/types.ts";
import { validateColor } from "../core/validate.ts";
import { mcpxError } from "./errors.ts";

/**
 * Palette assignment (§96.6) and expression-range enforcement (§97).
 *
 * Assignment never reorders or remaps existing symbols: callers keep their
 * palette, new colors arrive sorted by RGBA 32-bit key, and symbols are
 * taken in charset order. That keeps a one-pixel edit to a one-pixel diff.
 */

/** Compact symbol order: dot, digits, uppercase, lowercase (63 total). */
export const COMPACT_SYMBOLS =
	".0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Compact grids hold at most one color per single-character symbol. */
export const COMPACT_LIMIT = 63;

/** Tokenized grids hold at most this many distinct colors. */
export const TOKENIZED_LIMIT = 4096;

/** Practical mcpx size (§102): past this edge a warning is emitted. */
export const MCPX_WARN_EDGE = 512;

export interface McpxWarning {
	code: "MCPX_LARGE_CANVAS";
	message: string;
	details: {
		width: number;
		height: number;
	};
}

export type AssignMode = "compact" | "tokenized" | "auto";

export interface AssignOptions {
	/** Defaults to "auto": compact while it fits, tokenized beyond 63. */
	mode?: AssignMode;
}

/** Exact per-channel key: integer channels joined, no float formatting. */
export function colorKeyOf(color: RGBA): string {
	return `${color.r},${color.g},${color.b},${color.a}`;
}

/** RGBA packed as an unsigned 32-bit integer for total ordering. */
export function colorKey32(color: RGBA): number {
	return color.r * 16777216 + color.g * 65536 + color.b * 256 + color.a;
}

function isTransparent(color: RGBA): boolean {
	return color.r === 0 && color.g === 0 && color.b === 0 && color.a === 0;
}

const SINGLE_SYMBOL = /^[.0-9A-Za-z]$/;

/**
 * Serializer seam validation: every palette id a canvas carries must be
 * readable back by the parser. Anything outside this shape is rejected
 * before a single line is emitted, so no bad file ever leaves serialize.
 */
export function assertValidPaletteSymbols(
	entries: ReadonlyArray<Pick<AuthoringPaletteEntry, "id" | "color">>,
): void {
	const seen = new Set<string>();
	for (const entry of entries) {
		const id = entry.id;
		if (typeof id !== "string" || id.length === 0) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				"Palette symbols must be non-empty strings.",
				{ section: "palette" },
			);
		}
		if (seen.has(id)) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				`Duplicate palette symbol "${id}".`,
				{ section: "palette", symbol: id },
			);
		}
		seen.add(id);
		if (/[\s=]/.test(id)) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				`Palette symbol "${id}" must not contain blanks or "=".`,
				{ section: "palette", symbol: id },
			);
		}
		if (/[#[\];]/.test(id)) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				`Palette symbol "${id}" uses a reserved character ("#", "[", "]", ";").`,
				{ section: "palette", symbol: id },
			);
		}
		if (id.length === 1 && !SINGLE_SYMBOL.test(id)) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				`Single-character symbol "${id}" is outside [.0-9A-Za-z].`,
				{ section: "palette", symbol: id },
			);
		}
		validateColor(entry.color);
		if (id === "." && !isTransparent(entry.color)) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				'"." is reserved for transparent (#00000000).',
				{ section: "palette", symbol: id },
			);
		}
		if (id !== "." && isTransparent(entry.color)) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				'Transparent (#00000000) must use the reserved symbol ".".',
				{ section: "palette", symbol: id },
			);
		}
	}
}

function paletteOverflow(colorCount: number, limit: number): never {
	throw mcpxError(
		"MCPX_PALETTE_OVERFLOW",
		`Palette needs ${colorCount} colors but mcpx holds at most ${limit}; store as PNG instead.`,
		{
			colorCount,
			limit,
			suggestion: "store as PNG instead",
		},
	);
}

function nextToken(taken: ReadonlySet<string>, start: number): string {
	let seq = start;
	for (;;) {
		const symbol = `T${String(seq).padStart(4, "0")}`;
		if (!taken.has(symbol)) {
			return symbol;
		}
		seq += 1;
	}
}

/**
 * Assign symbols to colors. Existing entries keep their symbols verbatim,
 * their order, and their role/metadata; each unmapped color takes the next
 * free symbol, with missing colors ordered by RGBA 32-bit key ascending.
 * Transparent always takes "." in every mode, before any other assignment,
 * and "." is never handed to another color. Past the compact range, new
 * symbols are tokenized (T0001 …) unless mode is "compact", which overflows
 * instead.
 */
export function assignSymbols(
	existing: ReadonlyArray<Pick<AuthoringPaletteEntry, "id" | "color">>,
	colors: ReadonlyArray<RGBA> | Iterable<RGBA>,
	options?: AssignOptions,
): AuthoringPaletteEntry[] {
	assertValidPaletteSymbols(existing);
	const mode = options?.mode ?? "auto";

	const colorToSymbol = new Map<string, string>();
	for (const entry of existing) {
		const key = colorKeyOf(entry.color);
		if (!colorToSymbol.has(key)) {
			colorToSymbol.set(key, entry.id);
		}
	}
	const missing = new Map<string, RGBA>();
	for (const color of colors) {
		const key = colorKeyOf(color);
		if (!colorToSymbol.has(key) && !missing.has(key)) {
			missing.set(key, { ...color });
		}
	}
	const distinctCount = colorToSymbol.size + missing.size;
	const existingHasTransparent = existing.some((entry) =>
		isTransparent(entry.color),
	);
	if (mode !== "compact" && distinctCount > TOKENIZED_LIMIT) {
		paletteOverflow(distinctCount, TOKENIZED_LIMIT);
	}

	const taken = new Set<string>(existing.map((entry) => entry.id));
	// The dot stays empty without transparent, so opaque-only compact
	// holds 62; with transparent the total is 63.
	let compactLimit = COMPACT_LIMIT - 1;
	if (mode === "compact") {
		for (const entry of existing) {
			if (entry.id.length !== 1) {
				throw mcpxError(
					"MCPX_SCHEMA_ERROR",
					`Compact assignment cannot keep tokenized symbol "${entry.id}".`,
					{ section: "palette", symbol: entry.id },
				);
			}
		}
		if (
			existingHasTransparent ||
			[...missing.values()].some((color) => isTransparent(color))
		) {
			compactLimit = COMPACT_LIMIT;
		}
		if (distinctCount > compactLimit) {
			paletteOverflow(distinctCount, compactLimit);
		}
	}

	const ordered = [...missing.values()].sort(
		(a, b) => colorKey32(a) - colorKey32(b),
	);
	const created: AuthoringPaletteEntry[] = [];
	const take = (color: RGBA, symbol: string): void => {
		taken.add(symbol);
		colorToSymbol.set(colorKeyOf(color), symbol);
		created.push({ id: symbol, color: { ...color } });
	};
	// Transparent first, in every mode: the dot is its alone.
	for (const color of ordered) {
		if (!isTransparent(color)) {
			continue;
		}
		if (taken.has(".")) {
			throw mcpxError(
				"MCPX_SCHEMA_ERROR",
				'"." is reserved for transparent (#00000000).',
				{ section: "palette", symbol: "." },
			);
		}
		take(color, ".");
	}
	let tokenSeq = 1;
	for (const color of ordered) {
		if (isTransparent(color)) {
			continue;
		}
		let symbol: string | undefined;
		if (mode !== "tokenized") {
			for (const candidate of COMPACT_SYMBOLS) {
				if (candidate === "." || taken.has(candidate)) {
					continue;
				}
				symbol = candidate;
				break;
			}
		}
		if (symbol === undefined) {
			if (mode === "compact") {
				paletteOverflow(distinctCount, compactLimit);
			}
			symbol = nextToken(taken, tokenSeq);
			tokenSeq = Number(symbol.slice(1)) + 1;
		}
		take(color, symbol);
	}

	return [...existing.map((entry) => ({ ...entry })), ...created];
}

/** Distinct colors referenced by any layer, in first-use order. */
export function collectCanvasColors(canvas: PixelCanvas): RGBA[] {
	const seen = new Set<string>();
	const out: RGBA[] = [];
	for (const layer of canvas.layers) {
		const pixels = layer.pixels;
		for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
			const color: RGBA = {
				r: pixels[offset] as number,
				g: pixels[offset + 1] as number,
				b: pixels[offset + 2] as number,
				a: pixels[offset + 3] as number,
			};
			const key = colorKeyOf(color);
			if (!seen.has(key)) {
				seen.add(key);
				out.push(color);
			}
		}
	}
	return out;
}

/** Practical-size gate (§102): either edge past 512 warns on mcpx save. */
export function isLargeCanvasForMcpx(width: number, height: number): boolean {
	return width > MCPX_WARN_EDGE || height > MCPX_WARN_EDGE;
}
