import { readFileSync } from "node:fs";
import {
	addLayer,
	createCanvas,
	getPixel,
	getRegionValue,
	replaceLayerPixels,
	setPixel,
} from "../../src/core/canvas.ts";
import { McAssetError } from "../../src/core/errors.ts";
import type { PaletteRole, PixelCanvas, RGBA } from "../../src/core/types.ts";
import type { McpxWarning } from "../../src/mcpx/assign.ts";
import {
	assignSymbols,
	COMPACT_LIMIT,
	collectCanvasColors,
	colorKey32,
	TOKENIZED_LIMIT,
} from "../../src/mcpx/assign.ts";
import { parseMcpx, serializeMcpx } from "../../src/mcpx/index.ts";

/** Runner-agnostic assertion surface: bun:test and node:test entries adapt to this. */
export interface CaseCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
	throwsCode(fn: () => unknown, code: string, message?: string): void;
}

export interface McpxCase {
	name: string;
	run(check: CaseCheck): void;
}

function fixture(name: string): string {
	return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

function expectMcpxError(
	check: CaseCheck,
	fn: () => unknown,
	code: string,
	line: number,
): McAssetError {
	try {
		fn();
	} catch (error) {
		if (error instanceof McAssetError && error.code === code) {
			const details = error.details as { line?: unknown } | undefined;
			check.equal(details?.line, line, `error line for ${code}`);
			return error;
		}
		check.fail(
			`expected McAssetError(${code}) at line ${line} but got ${error instanceof McAssetError ? `${error.code} ${error.message}` : String(error)}`,
		);
	}
	return check.fail(`expected McAssetError(${code}) but nothing was thrown`);
}

function pixelOf(
	canvas: PixelCanvas,
	layer: string,
	x: number,
	y: number,
): RGBA {
	return getPixel(canvas, layer, x, y);
}

/** Deterministic distinct opaque colors: index i maps to one RGBA. */
function distinctColor(i: number): RGBA {
	return {
		r: i & 0xff,
		g: (i >> 8) & 0xff,
		b: (i >> 16) & 0x0f,
		a: 255,
	};
}

function manyColors(count: number): RGBA[] {
	const out: RGBA[] = [];
	for (let i = 0; i < count; i += 1) {
		out.push(distinctColor(i));
	}
	return out;
}

function expectOverflow(
	check: CaseCheck,
	fn: () => unknown,
	expectedCount: number,
	expectedLimit: number,
): McAssetError {
	try {
		fn();
	} catch (error) {
		if (
			error instanceof McAssetError &&
			error.code === "MCPX_PALETTE_OVERFLOW"
		) {
			const details = error.details as
				| { colorCount?: unknown; limit?: unknown }
				| undefined;
			check.equal(details?.colorCount, expectedCount, "overflow colorCount");
			check.equal(details?.limit, expectedLimit, "overflow limit");
			check.ok(/PNG/.test(error.message), "overflow message suggests PNG");
			return error;
		}
		check.fail(
			`expected McAssetError(MCPX_PALETTE_OVERFLOW) but got ${error instanceof McAssetError ? `${error.code} ${error.message}` : String(error)}`,
		);
	}
	return check.fail("expected McAssetError(MCPX_PALETTE_OVERFLOW)");
}

/** Bypass the canvas API guards to simulate a hand-built illegal canvas. */
function canvasWithRawPalette(
	width: number,
	height: number,
	entries: Array<{
		id: string;
		color: RGBA;
		role?: unknown;
		metadata?: Record<string, unknown>;
	}>,
	pixels: RGBA[],
): PixelCanvas {
	const canvas = createCanvas(width, height);
	canvas.palette = {
		entries: entries.map((entry) => ({
			id: entry.id,
			color: { ...entry.color },
			...(entry.role !== undefined ? { role: entry.role as PaletteRole } : {}),
			...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
		})),
	};
	const layer = addLayer(canvas, { id: "base" });
	const buf = new Uint8Array(width * height * 4);
	for (let i = 0; i < pixels.length; i += 1) {
		const color = pixels[i] as RGBA;
		buf[i * 4] = color.r;
		buf[i * 4 + 1] = color.g;
		buf[i * 4 + 2] = color.b;
		buf[i * 4 + 3] = color.a;
	}
	replaceLayerPixels(canvas, layer.id, buf);
	return canvas;
}

function tinyCanvas(): string {
	return [
		"mcpx 1",
		"",
		"[canvas]",
		"width = 2",
		"height = 1",
		"",
		"[palette]",
		". = transparent",
		"X = #FF0000FF",
		"",
		"[layer base]",
		"visible = true",
		"opacity = 1.000",
		"",
		"[grid]",
		"X.",
		"",
	].join("\n");
}

export const MCPX_CASES: McpxCase[] = [
	{
		name: "canonical §21 example parses with exact canvas state",
		run: (check) => {
			const canvas = parseMcpx(fixture("canonical.mcpx"));
			check.equal(canvas.version, 1, "version");
			check.equal(canvas.width, 16, "width");
			check.equal(canvas.height, 16, "height");
			check.deepEqual(
				canvas.metadata,
				{ name: "iron_sword", type: "item" },
				"metadata",
			);
			check.equal(canvas.palette?.entries.length, 6, "palette size");
			check.deepEqual(
				canvas.palette?.entries.map((entry) => entry.id),
				[".", "O", "D", "S", "H", "W"],
				"palette order preserved",
			);
			check.deepEqual(
				canvas.palette?.entries[0]?.color,
				{ r: 0, g: 0, b: 0, a: 0 },
				"dot is transparent",
			);
			check.deepEqual(
				canvas.palette?.entries[1],
				{
					id: "O",
					color: { r: 37, g: 40, b: 43, a: 255 },
					role: "outline",
				},
				"O entry keeps role",
			);
			check.deepEqual(
				canvas.palette?.entries[5],
				{ id: "W", color: { r: 111, g: 71, b: 48, a: 255 } },
				"W entry has no role",
			);
			check.equal(canvas.layers.length, 1, "one layer");
			check.equal(canvas.layers[0]?.id, "base", "layer id");
			check.equal(canvas.layers[0]?.visible, true, "visible");
			check.equal(canvas.layers[0]?.opacity, 1, "opacity");
			check.deepEqual(
				pixelOf(canvas, "base", 0, 0),
				{ r: 0, g: 0, b: 0, a: 0 },
				"(0,0) transparent",
			);
			check.deepEqual(
				pixelOf(canvas, "base", 7, 1),
				{ r: 225, g: 231, b: 234, a: 255 },
				"(7,1) highlight",
			);
			check.deepEqual(
				pixelOf(canvas, "base", 7, 2),
				{ r: 173, g: 183, b: 192, a: 255 },
				"(7,2) base",
			);
			check.deepEqual(
				pixelOf(canvas, "base", 2, 10),
				{ r: 37, g: 40, b: 43, a: 255 },
				"(2,10) outline",
			);
			check.deepEqual(
				pixelOf(canvas, "base", 5, 11),
				{ r: 111, g: 71, b: 48, a: 255 },
				"(5,11) wood",
			);
			check.equal(canvas.regions.length, 1, "one region");
			check.equal(canvas.regions[0]?.id, "blade", "region id");
			check.equal(canvas.regions[0]?.name, "Blade", "region name");
			check.equal(getRegionValue(canvas, "blade", 7, 1), 1, "blade (7,1)");
			check.equal(getRegionValue(canvas, "blade", 0, 0), 0, "outside (0,0)");
			check.equal(
				getRegionValue(canvas, "blade", 2, 10),
				0,
				"outline pixel outside blade",
			);
		},
	},
	{
		name: "canonical text normalizes once, then stays byte-stable",
		run: (check) => {
			const first = serializeMcpx(parseMcpx(fixture("canonical.mcpx")));
			check.ok(
				first.includes(". = #00000000"),
				"transparent literal normalized",
			);
			check.ok(
				!first.includes("transparent"),
				"no transparent literal emitted",
			);
			check.ok(first.includes("opacity = 1.000"), "opacity fixed decimals");
			const second = serializeMcpx(parseMcpx(first));
			check.equal(second, first, "serialize -> parse -> serialize is stable");
			const third = serializeMcpx(parseMcpx(second));
			check.equal(third, second, "third generation still identical");
		},
	},
	{
		name: "comments vanish on round-trip but pixels and semantics stay",
		run: (check) => {
			const plain = parseMcpx(fixture("canonical.mcpx"));
			const noted = parseMcpx(fixture("commented.mcpx"));
			check.equal(
				serializeMcpx(noted),
				serializeMcpx(plain),
				"commented and plain serialize identically",
			);
			check.ok(
				!serializeMcpx(noted).includes(";"),
				"serializer emits no comment lines",
			);
			for (let y = 0; y < 16; y += 1) {
				for (let x = 0; x < 16; x += 1) {
					check.deepEqual(
						pixelOf(noted, "base", x, y),
						pixelOf(plain, "base", x, y),
						`pixel (${x},${y})`,
					);
					check.equal(
						getRegionValue(noted, "blade", x, y),
						getRegionValue(plain, "blade", x, y),
						`mask (${x},${y})`,
					);
				}
			}
		},
	},
	{
		name: "orphan grid without a layer is a syntax error with a line",
		run: (check) => {
			expectMcpxError(
				check,
				() =>
					parseMcpx(
						[
							"mcpx 1",
							"",
							"[canvas]",
							"width = 2",
							"height = 1",
							"",
							"[grid]",
							"..",
							"",
						].join("\n"),
					),
				"MCPX_SYNTAX_ERROR",
				7,
			);
		},
	},
	{
		name: "unknown section is a syntax error",
		run: (check) => {
			expectMcpxError(
				check,
				() =>
					parseMcpx(
						[
							"mcpx 1",
							"",
							"[canvas]",
							"width = 2",
							"height = 1",
							"",
							"[include ./other.mcpx]",
							"",
						].join("\n"),
					),
				"MCPX_SYNTAX_ERROR",
				7,
			);
		},
	},
	{
		name: "non-numeric width is a schema error with a line",
		run: (check) => {
			expectMcpxError(
				check,
				() =>
					parseMcpx(
						["mcpx 1", "", "[canvas]", "width = abc", "height = 1", ""].join(
							"\n",
						),
					),
				"MCPX_SCHEMA_ERROR",
				4,
			);
		},
	},
	{
		name: "grid symbol missing from the palette is a semantic error",
		run: (check) => {
			expectMcpxError(
				check,
				() => parseMcpx(tinyCanvas().replace("X.", "Z.")),
				"MCPX_SEMANTIC_ERROR",
				16,
			);
		},
	},
	{
		name: "unsupported major version reports its own code",
		run: (check) => {
			expectMcpxError(
				check,
				() => parseMcpx("mcpx 2\n"),
				"MCPX_UNSUPPORTED_VERSION",
				1,
			);
		},
	},
	{
		name: "short grid row reports INVALID_GRID_SIZE",
		run: (check) => {
			expectMcpxError(
				check,
				() => parseMcpx(tinyCanvas().replace("X.", "X")),
				"INVALID_GRID_SIZE",
				16,
			);
		},
	},
	{
		name: "missing grid row reports INVALID_GRID_SIZE",
		run: (check) => {
			const oneOfTwo = [
				"mcpx 1",
				"",
				"[canvas]",
				"width = 2",
				"height = 2",
				"",
				"[palette]",
				". = transparent",
				"",
				"[layer base]",
				"",
				"[grid]",
				"..",
				"",
			].join("\n");
			expectMcpxError(
				check,
				() => parseMcpx(oneOfTwo),
				"INVALID_GRID_SIZE",
				12,
			);
		},
	},
	{
		name: "short mask row reports INVALID_MASK_SIZE",
		run: (check) => {
			const bad = [
				"mcpx 1",
				"",
				"[canvas]",
				"width = 2",
				"height = 1",
				"",
				"[region blade]",
				"",
				"[mask]",
				".",
				"",
			].join("\n");
			expectMcpxError(check, () => parseMcpx(bad), "INVALID_MASK_SIZE", 10);
		},
	},
	{
		name: "#FF000000 never serializes as transparent and stays distinct",
		run: (check) => {
			const text = [
				"mcpx 1",
				"",
				"[canvas]",
				"width = 2",
				"height = 1",
				"",
				"[palette]",
				". = transparent",
				"X = #FF000000",
				"",
				"[layer base]",
				"",
				"[grid]",
				"X.",
				"",
			].join("\n");
			const canvas = parseMcpx(text);
			check.deepEqual(
				pixelOf(canvas, "base", 0, 0),
				{ r: 255, g: 0, b: 0, a: 0 },
				"hidden red kept",
			);
			const out = serializeMcpx(canvas);
			check.ok(out.includes("X = #FF000000"), "opaque-black hex emitted");
			check.ok(!out.includes("transparent"), "no transparent shortcut emitted");
			const again = parseMcpx(out);
			check.deepEqual(
				pixelOf(again, "base", 0, 0),
				{ r: 255, g: 0, b: 0, a: 0 },
				"hidden red survives",
			);
			check.deepEqual(
				pixelOf(again, "base", 1, 0),
				{ r: 0, g: 0, b: 0, a: 0 },
				"real transparent stays distinct",
			);
			check.equal(
				serializeMcpx(again),
				out,
				"transparent fixture is byte-stable",
			);
		},
	},
	{
		name: "environment variable shapes are never expanded",
		run: (check) => {
			const text = [
				"mcpx 1",
				"",
				"[canvas]",
				"width = 1",
				"height = 1",
				"",
				"[metadata]",
				`path = $${"{HOME}"}/textures`,
				"cmd = $(whoami)",
				"",
				"[palette]",
				". = transparent",
				"",
				"[layer base]",
				"",
				"[grid]",
				".",
				"",
			].join("\n");
			const canvas = parseMcpx(text);
			const homePath = `$${"{HOME}"}/textures`;
			check.equal(canvas.metadata.path, homePath, "dollar brace kept");
			check.equal(canvas.metadata.cmd, "$(whoami)", "command shape kept");
			const out = serializeMcpx(canvas);
			check.ok(out.includes(`path = ${homePath}`), "literal serialized");
			check.equal(
				serializeMcpx(parseMcpx(out)),
				out,
				"env-like text is byte-stable",
			);
		},
	},
	{
		name: "CRLF newlines are rejected instead of silently mangled",
		run: (check) => {
			const crlf = `${fixture("tokenized.mcpx").replaceAll("\n", "\r\n")}`;
			expectMcpxError(check, () => parseMcpx(crlf), "MCPX_SYNTAX_ERROR", 1);
		},
	},
	{
		name: "tokenized grid parses and forces tokenized serialization",
		run: (check) => {
			const text = fixture("tokenized.mcpx");
			const canvas = parseMcpx(text);
			check.equal(canvas.width, 3, "width");
			check.equal(canvas.height, 2, "height");
			check.deepEqual(
				pixelOf(canvas, "base", 0, 0),
				{ r: 33, g: 53, b: 72, a: 255 },
				"C01 decodes",
			);
			check.deepEqual(
				pixelOf(canvas, "base", 1, 0),
				{ r: 162, g: 209, b: 232, a: 255 },
				"C02 decodes",
			);
			check.deepEqual(
				pixelOf(canvas, "base", 2, 0),
				{ r: 0, g: 0, b: 0, a: 0 },
				"dot decodes",
			);
			check.equal(canvas.layers[0]?.opacity, 0.5, "opacity halves");
			const out = serializeMcpx(canvas);
			check.ok(out.includes("[grid tokens]"), "tokenized mode kept");
			check.ok(!out.includes("[grid]\n"), "compact mode not used");
			check.equal(
				parseMcpx(out) && serializeMcpx(parseMcpx(out)),
				out,
				"stable",
			);
		},
	},
	{
		name: "hex parse accepts short form and lowercase, serializer uppercases",
		run: (check) => {
			const text = [
				"mcpx 1",
				"",
				"[canvas]",
				"width = 2",
				"height = 1",
				"",
				"[palette]",
				"a = #ff0000",
				"b = #00ff0080",
				"",
				"[layer base]",
				"",
				"[grid]",
				"ab",
				"",
			].join("\n");
			const canvas = parseMcpx(text);
			check.deepEqual(
				pixelOf(canvas, "base", 0, 0),
				{ r: 255, g: 0, b: 0, a: 255 },
				"short red gains full alpha",
			);
			check.deepEqual(
				pixelOf(canvas, "base", 1, 0),
				{ r: 0, g: 255, b: 0, a: 128 },
				"lowercase long hex decodes",
			);
			const out = serializeMcpx(canvas);
			check.ok(out.includes("a = #FF0000FF"), "red normalized");
			check.ok(out.includes("b = #00FF0080"), "green normalized");
		},
	},
	{
		name: "opacity accepts plain and padded decimals, rejects the rest",
		run: (check) => {
			for (const literal of [
				"1",
				"1.0",
				"1.000",
				"0",
				"0.0",
				"0.500",
				"0.25",
			]) {
				const canvas = parseMcpx(
					tinyCanvas().replace("opacity = 1.000", `opacity = ${literal}`),
				);
				check.ok(canvas.layers[0] !== undefined, `opacity ${literal} parses`);
			}
			check.equal(
				parseMcpx(tinyCanvas().replace("opacity = 1.000", "opacity = 0.25"))
					.layers[0]?.opacity,
				0.25,
				"quarter kept",
			);
			for (const [literal, line] of [
				["1.5", 13],
				["abc", 13],
				["1e0", 13],
			] as Array<[string, number]>) {
				expectMcpxError(
					check,
					() =>
						parseMcpx(
							tinyCanvas().replace("opacity = 1.000", `opacity = ${literal}`),
						),
					"MCPX_SCHEMA_ERROR",
					line,
				);
			}
		},
	},
	{
		name: "sections out of canonical order are rejected",
		run: (check) => {
			expectMcpxError(
				check,
				() =>
					parseMcpx(
						[
							"mcpx 1",
							"",
							"[canvas]",
							"width = 1",
							"height = 1",
							"",
							"[palette]",
							". = transparent",
							"",
							"[metadata]",
							"name = late",
							"",
							"[layer base]",
							"",
							"[grid]",
							".",
							"",
						].join("\n"),
					),
				"MCPX_SYNTAX_ERROR",
				10,
			);
		},
	},
	{
		name: "comment lines inside grid data are rejected",
		run: (check) => {
			const twoRows = [
				"mcpx 1",
				"",
				"[canvas]",
				"width = 1",
				"height = 2",
				"",
				"[palette]",
				". = transparent",
				"",
				"[layer base]",
				"",
				"[grid]",
				".",
				"; a note between rows",
				".",
				"",
			].join("\n");
			expectMcpxError(check, () => parseMcpx(twoRows), "MCPX_SYNTAX_ERROR", 14);
		},
	},
	{
		name: "unknown palette attribute and role are schema errors",
		run: (check) => {
			expectMcpxError(
				check,
				() =>
					parseMcpx(
						tinyCanvas().replace("X = #FF0000FF", "X = #FF0000FF foo=bar"),
					),
				"MCPX_SCHEMA_ERROR",
				9,
			);
			expectMcpxError(
				check,
				() =>
					parseMcpx(
						tinyCanvas().replace("X = #FF0000FF", "X = #FF0000FF role=wood"),
					),
				"MCPX_SCHEMA_ERROR",
				9,
			);
		},
	},
	{
		name: "reserved dot rules are enforced on palette entries",
		run: (check) => {
			expectMcpxError(
				check,
				() =>
					parseMcpx(tinyCanvas().replace(". = transparent", ". = #FF000000")),
				"MCPX_SCHEMA_ERROR",
				8,
			);
			expectMcpxError(
				check,
				() =>
					parseMcpx(tinyCanvas().replace("X = #FF0000FF", "X = transparent")),
				"MCPX_SCHEMA_ERROR",
				9,
			);
		},
	},
	{
		name: "duplicate layer ids are semantic errors",
		run: (check) => {
			const dup = [
				"mcpx 1",
				"",
				"[canvas]",
				"width = 1",
				"height = 1",
				"",
				"[palette]",
				". = transparent",
				"",
				"[layer base]",
				"",
				"[grid]",
				".",
				"",
				"[layer base]",
				"",
				"[grid]",
				".",
				"",
			].join("\n");
			expectMcpxError(check, () => parseMcpx(dup), "MCPX_SEMANTIC_ERROR", 15);
		},
	},
	{
		name: "region without its mask is a structural error",
		run: (check) => {
			const missing = [
				"mcpx 1",
				"",
				"[canvas]",
				"width = 1",
				"height = 1",
				"",
				"[region blade]",
				"name = Blade",
				"",
			].join("\n");
			expectMcpxError(check, () => parseMcpx(missing), "MCPX_SYNTAX_ERROR", 7);
		},
	},
	{
		name: "integer shapes reject leading zeros, signs, and out-of-range edges",
		run: (check) => {
			for (const literal of ["016", "+16", "16.0", "-1", "0", "4097"]) {
				expectMcpxError(
					check,
					() =>
						parseMcpx(tinyCanvas().replace("width = 2", `width = ${literal}`)),
					"MCPX_SCHEMA_ERROR",
					4,
				);
			}
			expectMcpxError(
				check,
				() =>
					parseMcpx(tinyCanvas().replace("visible = true", "visible = True")),
				"MCPX_SCHEMA_ERROR",
				12,
			);
		},
	},
	{
		name: "header-only canvas with no layers round-trips",
		run: (check) => {
			const text = [
				"mcpx 1",
				"",
				"[canvas]",
				"width = 4",
				"height = 2",
				"",
			].join("\n");
			const canvas = parseMcpx(text);
			check.equal(canvas.layers.length, 0, "no layers");
			check.equal(canvas.regions.length, 0, "no regions");
			check.deepEqual(canvas.metadata, {}, "empty metadata");
			const out = serializeMcpx(canvas);
			check.equal(out, text, "minimal file is already canonical");
			check.equal(serializeMcpx(parseMcpx(out)), out, "stable");
		},
	},
	{
		name: "large grid parses without surprises and keeps spot pixels",
		run: (check) => {
			const width = 256;
			const height = 256;
			// Integer-only fill: no randomness source, no float helpers.
			let state = 0x12345678;
			const next = (): number => {
				state = (state * 1664525 + 1013904223) >>> 0;
				return (state >>> 24) & 0xff;
			};
			const symbols = [".", "A", "B"];
			const rows: string[] = [];
			const expected: number[][] = [];
			for (let y = 0; y < height; y += 1) {
				let row = "";
				const erow: number[] = [];
				for (let x = 0; x < width; x += 1) {
					const pick = next() % 3;
					row += symbols[pick];
					erow.push(pick);
				}
				rows.push(row);
				expected.push(erow);
			}
			const text = [
				"mcpx 1",
				"",
				"[canvas]",
				`width = ${width}`,
				`height = ${height}`,
				"",
				"[palette]",
				". = #00000000",
				"A = #112233FF",
				"B = #AABBCCFF",
				"",
				"[layer base]",
				"visible = true",
				"opacity = 1.000",
				"",
				"[grid]",
				...rows,
				"",
			].join("\n");
			const canvas = parseMcpx(text);
			const colors = [
				{ r: 0, g: 0, b: 0, a: 0 },
				{ r: 17, g: 34, b: 51, a: 255 },
				{ r: 170, g: 187, b: 204, a: 255 },
			];
			for (const [x, y] of [
				[0, 0],
				[width - 1, 0],
				[0, height - 1],
				[width - 1, height - 1],
				[137, 42],
			] as Array<[number, number]>) {
				const pick = expected[y]?.[x] ?? 0;
				check.deepEqual(
					pixelOf(canvas, "base", x, y),
					colors[pick],
					`spot (${x},${y})`,
				);
			}
			check.equal(
				serializeMcpx(canvas),
				text,
				"large canonical input is already byte-stable",
			);
		},
	},
	{
		name: "canonical output uses LF only and separates sections cleanly",
		run: (check) => {
			const out = serializeMcpx(parseMcpx(fixture("canonical.mcpx")));
			check.ok(!out.includes("\r"), "no carriage returns");
			check.ok(out.endsWith("\n") && !out.endsWith("\n\n"), "single final LF");
			for (const [index, line] of out.split("\n").entries()) {
				check.ok(
					line === line.trimEnd(),
					`line ${index + 1} has no trailing blank`,
				);
			}
			check.ok(
				out.includes("opacity = 1.000\n\n[grid]"),
				"blank line before grid",
			);
			check.ok(
				out.includes("................\n\n[region blade]"),
				"blank line before region",
			);
			check.ok(!out.includes("\n\n\n"), "never two blank lines");
		},
	},
	{
		name: "hostile and empty inputs fail closed with a line",
		run: (check) => {
			expectMcpxError(
				check,
				() => parseMcpx("\uFEFFmcpx 1\n"),
				"MCPX_SYNTAX_ERROR",
				1,
			);
			expectMcpxError(check, () => parseMcpx(""), "MCPX_SYNTAX_ERROR", 1);
			expectMcpxError(
				check,
				() => parseMcpx("; only a comment\n"),
				"MCPX_SYNTAX_ERROR",
				1,
			);
			const doubled = fixture("tokenized.mcpx").replace(
				"C01 C02 .",
				"C01  C02 .",
			);
			expectMcpxError(check, () => parseMcpx(doubled), "MCPX_SYNTAX_ERROR", 17);
		},
	},
	{
		name: "palette-less canvas states its serialize limit for the next task",
		run: (check) => {
			const canvas = createCanvas(2, 1, { metadata: { z: "1", a: "2" } });
			const layer = addLayer(canvas, { id: "paint", name: "Paint" });
			setPixel(canvas, layer.id, 0, 0, { r: 1, g: 2, b: 3, a: 255 });
			try {
				serializeMcpx(canvas);
			} catch (error) {
				check.ok(error instanceof McAssetError, "McAssetError raised");
				check.equal(
					(error as McAssetError).code,
					"MCPX_SEMANTIC_ERROR",
					"missing symbol assignment reported",
				);
				return;
			}
			check.fail("serialize without palette coverage must throw");
		},
	},
	{
		name: "layer names survive and metadata serializes sorted",
		run: (check) => {
			const text = [
				"mcpx 1",
				"",
				"[canvas]",
				"width = 1",
				"height = 1",
				"",
				"[metadata]",
				"z = 1",
				"a = 2",
				"",
				"[palette]",
				". = transparent",
				"",
				"[layer base]",
				"name = Paint",
				"",
				"[grid]",
				".",
				"",
			].join("\n");
			const out = serializeMcpx(parseMcpx(text));
			check.ok(
				out.indexOf("a = 2") < out.indexOf("z = 1"),
				"metadata keys sorted",
			);
			check.ok(out.includes("name = Paint"), "layer name kept");
			check.equal(serializeMcpx(parseMcpx(out)), out, "stable");
		},
	},
	{
		name: "assign keeps existing symbols and orders new ones by RGBA key",
		run: (check) => {
			check.equal(COMPACT_LIMIT, 63, "compact limit");
			check.equal(TOKENIZED_LIMIT, 4096, "tokenized limit");
			check.equal(colorKey32({ r: 0, g: 0, b: 0, a: 0 }), 0, "zero key");
			check.equal(
				colorKey32({ r: 255, g: 255, b: 255, a: 255 }),
				4294967295,
				"max key",
			);
			const red: RGBA = { r: 255, g: 0, b: 0, a: 255 };
			const blue: RGBA = { r: 0, g: 0, b: 255, a: 255 };
			const green: RGBA = { r: 0, g: 255, b: 0, a: 255 };
			const transparent: RGBA = { r: 0, g: 0, b: 0, a: 0 };
			check.ok(
				colorKey32(blue) < colorKey32(green) &&
					colorKey32(green) < colorKey32(red),
				"blue < green < red by 32-bit key",
			);
			const assigned = assignSymbols(
				[{ id: "W", color: red }],
				[red, blue, green, transparent],
			);
			check.deepEqual(
				assigned.map((entry) => entry.id),
				["W", ".", "0", "1"],
				"existing kept, transparent takes dot, rest in charset order",
			);
			check.deepEqual(assigned[0]?.color, red, "existing color untouched");
			check.deepEqual(
				assigned[2]?.color,
				blue,
				"smallest new key takes the first free symbol",
			);
			check.deepEqual(
				assigned[3]?.color,
				green,
				"next key takes the next free symbol",
			);
		},
	},
	{
		name: "changing one pixel only changes one pixel of output",
		run: (check) => {
			const transparent: RGBA = { r: 0, g: 0, b: 0, a: 0 };
			const red: RGBA = { r: 255, g: 0, b: 0, a: 255 };
			const blue: RGBA = { r: 0, g: 0, b: 255, a: 255 };
			const first = assignSymbols([], [transparent, red]);
			check.deepEqual(
				first.map((entry) => entry.id),
				[".", "0"],
				"transparent dot, red zero",
			);
			const before = canvasWithRawPalette(2, 1, first, [red, transparent]);
			const textBefore = serializeMcpx(before);
			check.ok(textBefore.includes("0 = #FF0000FF"), "red keeps zero");
			const second = assignSymbols(first, [transparent, red, blue]);
			check.deepEqual(
				second.map((entry) => entry.id),
				[".", "0", "1"],
				"red keeps zero even though blue sorts smaller",
			);
			const after = canvasWithRawPalette(2, 1, second, [blue, transparent]);
			const textAfter = serializeMcpx(after);
			check.ok(textAfter.includes("0 = #FF0000FF"), "red still zero");
			check.ok(textAfter.includes("1 = #0000FFFF"), "blue appended as one");
			const gridBefore = textBefore.split("\n").filter((line) => line === "0.");
			const gridAfter = textAfter.split("\n").filter((line) => line === "1.");
			check.equal(gridBefore.length, 1, "one grid row before");
			check.equal(gridAfter.length, 1, "one grid row after");
			check.equal(
				collectCanvasColors(after).length,
				2,
				"two distinct colors in use",
			);
		},
	},
	{
		name: "opaque-only assignment never emits dot and serializes",
		run: (check) => {
			const red: RGBA = { r: 255, g: 0, b: 0, a: 255 };
			const assigned = assignSymbols([], [red]);
			check.deepEqual(
				assigned.map((entry) => entry.id),
				["0"],
				"first opaque color takes zero, dot stays empty",
			);
			const out = serializeMcpx(canvasWithRawPalette(1, 1, assigned, [red]));
			check.ok(out.includes("0 = #FF0000FF"), "red emitted as zero");
			check.ok(
				!out.split("\n").some((line) => line.startsWith(". =")),
				"no dot entry without transparent",
			);
			check.equal(serializeMcpx(parseMcpx(out)), out, "stable");
		},
	},
	{
		name: "tokenized assignment still gives transparent the dot",
		run: (check) => {
			const transparent: RGBA = { r: 0, g: 0, b: 0, a: 0 };
			const red: RGBA = { r: 255, g: 0, b: 0, a: 255 };
			const blue: RGBA = { r: 0, g: 0, b: 255, a: 255 };
			const assigned = assignSymbols([], [transparent, red, blue], {
				mode: "tokenized",
			});
			check.equal(assigned[0]?.id, ".", "transparent takes dot in any mode");
			check.deepEqual(
				assigned[0]?.color,
				transparent,
				"dot maps to transparent",
			);
			check.ok(
				assigned
					.slice(1)
					.every((entry) => entry.id.length > 1 && entry.id !== "."),
				"other colors take tokenized symbols",
			);
			const out = serializeMcpx(
				canvasWithRawPalette(3, 1, assigned, [transparent, red, blue]),
			);
			check.ok(out.includes("[grid tokens]"), "tokenized grid emitted");
			check.equal(serializeMcpx(parseMcpx(out)), out, "stable");
		},
	},
	{
		name: "reassignment keeps existing roles and metadata",
		run: (check) => {
			const canvas = parseMcpx(fixture("canonical.mcpx"));
			const entries = canvas.palette?.entries ?? [];
			const reassigned = assignSymbols(entries, collectCanvasColors(canvas));
			check.equal(
				reassigned.length,
				entries.length,
				"no new colors means no new entries",
			);
			check.equal(
				reassigned.find((entry) => entry.id === "O")?.role,
				"outline",
				"outline role survives reassignment",
			);
			canvas.palette = { entries: reassigned };
			const out = serializeMcpx(canvas);
			check.ok(out.includes("role=outline"), "role still serialized");
		},
	},
	{
		name: "illegal canvas metadata keys fail serialize",
		run: (check) => {
			for (const key of ["a b", "Name", "9lives"]) {
				const canvas = createCanvas(1, 1, { metadata: { [key]: "1" } });
				const layer = addLayer(canvas, { id: "base" });
				setPixel(canvas, layer.id, 0, 0, { r: 0, g: 0, b: 0, a: 0 });
				canvas.palette = {
					entries: [{ id: ".", color: { r: 0, g: 0, b: 0, a: 0 } }],
				};
				check.throwsCode(
					() => serializeMcpx(canvas),
					"MCPX_SCHEMA_ERROR",
					`metadata key ${JSON.stringify(key)} rejected`,
				);
			}
		},
	},
	{
		name: "palette entry metadata fails serialize instead of vanishing",
		run: (check) => {
			const red: RGBA = { r: 255, g: 0, b: 0, a: 255 };
			const canvas = canvasWithRawPalette(
				1,
				1,
				[{ id: "X", color: red }],
				[red],
			);
			const palette = canvas.palette;
			if (palette !== undefined) {
				palette.entries[0].metadata = { note: "kept?" };
				check.throwsCode(
					() => serializeMcpx(canvas),
					"MCPX_SCHEMA_ERROR",
					"palette metadata rejected like layer metadata",
				);
				return;
			}
			check.fail("expected one palette entry");
		},
	},
	{
		name: "illegal palette roles fail serialize",
		run: (check) => {
			const red: RGBA = { r: 255, g: 0, b: 0, a: 255 };
			for (const role of ["wood", "a b"]) {
				const canvas = canvasWithRawPalette(
					1,
					1,
					[{ id: "X", color: red, role }],
					[red],
				);
				check.throwsCode(
					() => serializeMcpx(canvas),
					"MCPX_SCHEMA_ERROR",
					`role ${JSON.stringify(role)} rejected`,
				);
			}
		},
	},
	{
		name: "illegal layer and region ids fail serialize",
		run: (check) => {
			const red: RGBA = { r: 255, g: 0, b: 0, a: 255 };
			const badLayer = canvasWithRawPalette(
				1,
				1,
				[{ id: "X", color: red }],
				[red],
			);
			badLayer.layers[0].id = "a]b";
			check.throwsCode(
				() => serializeMcpx(badLayer),
				"MCPX_SCHEMA_ERROR",
				"bracketed layer id rejected",
			);
			const badRegion = canvasWithRawPalette(
				1,
				1,
				[{ id: "X", color: red }],
				[red],
			);
			badRegion.regions.push({
				id: "no spaces",
				mask: new Uint8Array([1]),
			});
			check.throwsCode(
				() => serializeMcpx(badRegion),
				"MCPX_SCHEMA_ERROR",
				"spaced region id rejected",
			);
		},
	},
	{
		name: "compact assignment holds 62 opaque colors and overflows on the 63rd",
		run: (check) => {
			const ok = assignSymbols([], manyColors(62), { mode: "compact" });
			check.equal(ok.length, 62, "62 opaque colors fit compact");
			check.ok(
				ok.every((entry) => entry.id.length === 1),
				"compact symbols stay single characters",
			);
			check.ok(
				ok.every((entry) => entry.id !== "."),
				"dot stays empty without transparent",
			);
			expectOverflow(
				check,
				() => assignSymbols([], manyColors(63), { mode: "compact" }),
				63,
				62,
			);
			const withGlass = assignSymbols(
				[],
				[{ r: 0, g: 0, b: 0, a: 0 }, ...manyColors(62)],
				{ mode: "compact" },
			);
			check.equal(withGlass.length, 63, "transparent plus 62 fits");
			check.equal(withGlass[0]?.id, ".", "transparent takes dot");
		},
	},
	{
		name: "tokenized assignment holds 4096 colors and overflows after",
		run: (check) => {
			const ok = assignSymbols([], manyColors(4096));
			check.equal(ok.length, 4096, "4096 colors fit tokenized");
			const symbols = new Set(ok.map((entry) => entry.id));
			check.equal(symbols.size, 4096, "assigned symbols stay unique");
			expectOverflow(
				check,
				() => assignSymbols([], manyColors(4097)),
				4097,
				4096,
			);
		},
	},
	{
		name: "serialize refuses a tokenized canvas past 4096 colors",
		run: (check) => {
			const colors = manyColors(4096);
			const full = canvasWithRawPalette(
				64,
				64,
				colors.map((color, index) => ({
					id: `T${String(index + 1).padStart(4, "0")}`,
					color,
				})),
				colors,
			);
			const out = serializeMcpx(full);
			check.ok(out.includes("[grid tokens]"), "4096 colors stay tokenized");
			check.equal(
				serializeMcpx(parseMcpx(out)),
				out,
				"4096-color file round-trips",
			);
			const tooMany = manyColors(4160);
			const overflowing = canvasWithRawPalette(
				65,
				64,
				tooMany.map((color, index) => ({
					id: `T${String(index + 1).padStart(4, "0")}`,
					color,
				})),
				tooMany,
			);
			expectOverflow(check, () => serializeMcpx(overflowing), 4160, 4096);
		},
	},
	{
		name: "serialize rejects illegally-symboled palettes outright",
		run: (check) => {
			const red: RGBA = { r: 255, g: 0, b: 0, a: 255 };
			const blue: RGBA = { r: 0, g: 0, b: 255, a: 255 };
			const transparent: RGBA = { r: 0, g: 0, b: 0, a: 0 };
			const badIds = ["A B", "A=B", "A#B", "[A]", "A;B", ";X", "!", "X#"];
			for (const id of badIds) {
				try {
					serializeMcpx(
						canvasWithRawPalette(1, 1, [{ id, color: red }], [red]),
					);
				} catch (error) {
					check.ok(
						error instanceof McAssetError && error.code === "MCPX_SCHEMA_ERROR",
						`symbol ${JSON.stringify(id)} rejected as schema error`,
					);
					continue;
				}
				check.fail(`symbol ${JSON.stringify(id)} must not serialize`);
			}
			for (const entries of [
				[{ id: ".", color: red }],
				[{ id: "X", color: transparent }],
				[
					{ id: "A", color: red },
					{ id: "A", color: blue },
				],
			] as Array<Array<{ id: string; color: RGBA }>>) {
				try {
					serializeMcpx(
						canvasWithRawPalette(
							1,
							1,
							entries,
							entries.map((entry) => entry.color),
						),
					);
				} catch (error) {
					check.ok(
						error instanceof McAssetError && error.code === "MCPX_SCHEMA_ERROR",
						"dot reservation and duplicate symbols rejected",
					);
					continue;
				}
				check.fail("reserved-dot and duplicate cases must not serialize");
			}
		},
	},
	{
		name: "serializer rejects opacity past 3 decimals instead of rounding",
		run: (check) => {
			const red: RGBA = { r: 255, g: 0, b: 0, a: 255 };
			const canvas = canvasWithRawPalette(
				1,
				1,
				[{ id: "X", color: red }],
				[red],
			);
			const layer = canvas.layers[0];
			if (layer === undefined) {
				check.fail("expected one layer");
			}
			layer.opacity = 0.9999;
			try {
				serializeMcpx(canvas);
			} catch (error) {
				check.ok(
					error instanceof McAssetError && error.code === "MCPX_SCHEMA_ERROR",
					"0.9999 rejected as schema error",
				);
				const details = (error as McAssetError).details as
					| { opacity?: unknown }
					| undefined;
				check.equal(details?.opacity, 0.9999, "offending value reported");
				layer.opacity = 0.5;
				const out = serializeMcpx(canvas);
				check.ok(out.includes("opacity = 0.500"), "halves print padded");
				const quarter = serializeMcpx(
					parseMcpx(tinyCanvas().replace("opacity = 1.000", "opacity = 0.25")),
				);
				check.ok(quarter.includes("opacity = 0.250"), "quarters stay exact");
				return;
			}
			check.fail("opacity 0.9999 must not silently round to 1.000");
		},
	},
	{
		name: "canvases past 512 on any edge warn when saving mcpx",
		run: (check) => {
			const red: RGBA = { r: 255, g: 0, b: 0, a: 255 };
			const paint = (width: number, height: number): PixelCanvas => {
				const canvas = createCanvas(width, height);
				canvas.palette = { entries: [{ id: "X", color: { ...red } }] };
				const layer = addLayer(canvas, { id: "base" });
				const buf = new Uint8Array(width * height * 4);
				for (let i = 0; i < width * height; i += 1) {
					buf[i * 4] = 255;
					buf[i * 4 + 3] = 255;
				}
				replaceLayerPixels(canvas, layer.id, buf);
				return canvas;
			};
			const seen: McpxWarning[] = [];
			const wide = serializeMcpx(paint(513, 1), {
				onWarning: (warning) => {
					seen.push(warning);
				},
			});
			check.equal(seen.length, 1, "513-wide canvas warns once");
			check.equal(seen[0]?.code, "MCPX_LARGE_CANVAS", "warning code");
			check.ok(wide.includes("[grid]"), "wide canvas still serializes");
			const tallSeen: McpxWarning[] = [];
			serializeMcpx(paint(1, 513), {
				onWarning: (warning) => {
					tallSeen.push(warning);
				},
			});
			check.equal(tallSeen.length, 1, "513-tall canvas warns once");
			const quiet: McpxWarning[] = [];
			serializeMcpx(paint(512, 512), {
				onWarning: (warning) => {
					quiet.push(warning);
				},
			});
			check.equal(quiet.length, 0, "512 square stays quiet");
			check.ok(
				serializeMcpx(paint(513, 1)).includes("[grid]"),
				"warning never blocks without a listener",
			);
		},
	},
];
