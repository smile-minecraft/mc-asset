import { readFileSync } from "node:fs";
import {
	addLayer,
	createCanvas,
	getPixel,
	getRegionValue,
	setPixel,
} from "../../src/core/canvas.ts";
import { McAssetError } from "../../src/core/errors.ts";
import type { PixelCanvas, RGBA } from "../../src/core/types.ts";
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
];
