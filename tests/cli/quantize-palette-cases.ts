import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputStreams } from "../../src/cli/channels.ts";
import {
	type QuantizeOptions,
	runQuantize,
} from "../../src/cli/cmd-quantize.ts";
import { resolveQuantizePalette } from "../../src/cli/quantize-palette-source.ts";
import { handleQuantizeAsset } from "../../src/mcp/handlers.ts";
import { parseMcpx } from "../../src/mcpx/index.ts";

export interface QuantizeCliResult {
	code: number;
	raw: Uint8Array;
	stderr: string;
}
export interface QuantizeCliSurface {
	quantize(
		input: string | undefined,
		options: QuantizeOptions,
	): Promise<QuantizeCliResult>;
}
export function captureQuantizeStreams(): {
	streams: OutputStreams;
	stdout(): Uint8Array;
	stderrText(): string;
} {
	const out: Buffer[] = [];
	const err: Buffer[] = [];
	return {
		streams: {
			stdout: {
				write: (chunk) => {
					out.push(Buffer.from(chunk));
				},
			},
			stderr: {
				write: (chunk) => {
					err.push(Buffer.from(chunk));
				},
			},
		},
		stdout: () => new Uint8Array(Buffer.concat(out)),
		stderrText: () => Buffer.concat(err).toString("utf8"),
	};
}
const SOURCE = `mcpx 1
[canvas]
width = 3
height = 1
[palette]
A = #000000FF
B = #640000FF
C = #C80000FF
[layer base]
[grid]
ABC
`;
const PALETTE = `mcpx 1
[canvas]
width = 1
height = 1
[palette]
A = #000000FF
B = #C80000FF
[layer base]
[grid]
A
`;
async function withRoot(body: (root: string, input: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "quantize-palette-"));
	try {
		const input = join(root, "input.mcpx");
		await writeFile(input, SOURCE);
		await body(root, input);
		assert.equal(await readFile(input, "utf8"), SOURCE, "source never changes");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
function envelope(result: QuantizeCliResult) {
	return JSON.parse(Buffer.from(result.raw).toString("utf8").trim());
}
function pixels(text: string) {
	const layer = parseMcpx(text).layers[0];
	assert.ok(layer);
	return Array.from(layer.pixels);
}
const BLACK = [0, 0, 0, 255];
const RED = [200, 0, 0, 255];
const MID = [100, 0, 0, 255];
export const QUANTIZE_PALETTE_CLI_CASES: {
	name: string;
	run(surface: QuantizeCliSurface): Promise<void>;
}[] = [
	{
		name: "CLI reserved budget is independent for each layer",
		async run(surface) {
			await withRoot(async (root, input) => {
				const layered = `${SOURCE}[layer second]\n[grid]\nCCC\n`;
				await writeFile(input, layered);
				const output = join(root, "layers.mcpx");
				const result = await surface.quantize(input, {
					colors: "1",
					keepColor: ["0,0,0,255", "200,0,0,255"],
					selection: "rect:0,0,1,1",
					source: output,
				});
				assert.equal(result.code, 0, JSON.stringify(envelope(result)));
				const canvas = parseMcpx(await readFile(output, "utf8"));
				assert.equal(canvas.layers.length, 2);
				assert.deepEqual(Array.from(canvas.layers[0]?.pixels ?? []), [
					...BLACK,
					100,
					0,
					0,
					255,
					...RED,
				]);
				assert.deepEqual(Array.from(canvas.layers[1]?.pixels ?? []), [
					...RED,
					...RED,
					...RED,
				]);
				await writeFile(input, SOURCE);
			});
		},
	},

	{
		name: "CLI explicit mcpx palette uses first entry on a distance tie",
		async run(surface) {
			await withRoot(async (root, input) => {
				const palette = join(root, "palette.mcpx");
				await writeFile(palette, PALETTE);
				const output = join(root, "result.mcpx");
				const result = await surface.quantize(input, {
					palette,
					source: output,
				});
				assert.equal(result.code, 0, JSON.stringify(envelope(result)));
				assert.deepEqual(pixels(await readFile(output, "utf8")), [
					...BLACK,
					...BLACK,
					...RED,
				]);
			});
		},
	},
	{
		name: "CLI reserved budget counts only selected colors and keeps outside bytes",
		async run(surface) {
			await withRoot(async (root, input) => {
				const output = join(root, "result.mcpx");
				const result = await surface.quantize(input, {
					colors: "1",
					keepColor: ["200,0,0,255"],
					selection: "rect:0,0,2,1",
					source: output,
				});
				assert.equal(result.code, 0, JSON.stringify(envelope(result)));
				assert.deepEqual(pixels(await readFile(output, "utf8")), [
					50,
					0,
					0,
					255,
					50,
					0,
					0,
					255,
					...RED,
				]);
			});
		},
	},
	{
		name: "CLI zero remaining budget maps other selected pixels to the kept color",
		async run(surface) {
			await withRoot(async (root, input) => {
				const output = join(root, "result.mcpx");
				const result = await surface.quantize(input, {
					colors: "1",
					keepColor: ["0,0,0,255", "0,0,0,255"],
					source: output,
				});
				assert.equal(result.code, 0, JSON.stringify(envelope(result)));
				assert.deepEqual(pixels(await readFile(output, "utf8")), [
					...BLACK,
					...BLACK,
					...BLACK,
				]);
			});
		},
	},
	...[
		{
			name: "conflicting sources",
			options: { colors: "2", palette: "iron" },
			code: "ARGUMENT_CONFLICT",
		},
		{
			name: "missing sources",
			options: {},
			code: "INVALID_ARGUMENT",
			message: "--colors is required",
		},
		{
			name: "excess kept colors",
			options: { colors: "1", keepColor: ["0,0,0,255", "200,0,0,255"] },
			code: "INVALID_ARGUMENT",
		},
		{
			name: "kept color outside palette",
			options: { palette: "iron", keepColor: ["0,0,0,255"] },
			code: "INVALID_ARGUMENT",
		},
	].map(({ name, options, code, message }) => ({
		name: `CLI refuses ${name} before writing`,
		async run(surface: QuantizeCliSurface) {
			await withRoot(async (root, input) => {
				const before = (await readdir(root)).sort();
				const result = await surface.quantize(input, {
					...options,
					output: join(root, "out.png"),
					source: join(root, "out.mcpx"),
				});
				assert.equal(envelope(result).error.code, code);
				if (message !== undefined) {
					assert.ok(String(envelope(result).error.message).includes(message));
				}
				assert.deepEqual((await readdir(root)).sort(), before);
			});
		},
	})),
	{
		name: "CLI palette with selection keeps outside bytes and reports normalized keeps",
		async run(surface) {
			await withRoot(async (root, input) => {
				const palette = join(root, "palette.mcpx");
				await writeFile(palette, PALETTE);
				const output = join(root, "result.mcpx");
				const result = await surface.quantize(input, {
					palette,
					keepColor: ["200,0,0,255"],
					selection: "rect:2,0,1,1",
					source: output,
				});
				assert.equal(result.code, 0, JSON.stringify(envelope(result)));
				const body = envelope(result).result;
				assert.deepEqual(body.keepColors, [{ r: 200, g: 0, b: 0, a: 255 }]);
				assert.deepEqual(pixels(await readFile(output, "utf8")), [
					...BLACK,
					...MID,
					...RED,
				]);
			});
		},
	},
	{
		name: "CLI palette keeps outside selection even when the keep color is absent there",
		async run(surface) {
			await withRoot(async (root, input) => {
				const palette = join(root, "palette.mcpx");
				await writeFile(
					palette,
					"mcpx 1\n[canvas]\nwidth = 1\nheight = 1\n[palette]\nA = #FF0000FF\n[layer base]\n[grid]\nA\n",
				);
				const output = join(root, "result.mcpx");
				const result = await surface.quantize(input, {
					palette,
					keepColor: ["255,0,0,255"],
					selection: "rect:0,0,1,1",
					source: output,
				});
				assert.equal(result.code, 0, JSON.stringify(envelope(result)));
				assert.deepEqual(pixels(await readFile(output, "utf8")), [
					255,
					0,
					0,
					255,
					...MID,
					...RED,
				]);
			});
		},
	},
	{
		name: "CLI colors-only has a hand-calculated fixed output",
		async run(surface) {
			await withRoot(async (root, input) => {
				const output = join(root, "out.mcpx");
				const result = await surface.quantize(input, {
					colors: "1",
					source: output,
				});
				assert.equal(result.code, 0);
				assert.deepEqual(
					pixels(await readFile(output, "utf8")),
					[100, 0, 0, 255, 100, 0, 0, 255, 100, 0, 0, 255],
				);
			});
		},
	},
];
export const QUANTIZE_PALETTE_MCP_CASES = [
	{
		name: "palette loader resolves builtin and declared unused mcpx colors in order",
		async run() {
			await withRoot(async (root) => {
				const builtin = await resolveQuantizePalette("iron");
				assert.deepEqual(builtin.colors[0], { r: 26, g: 29, b: 33, a: 255 });
				assert.equal(builtin.colors.length, 7);
				const path = join(root, "palette.mcpx");
				await writeFile(path, PALETTE);
				const loaded = await resolveQuantizePalette(path);
				assert.deepEqual(loaded.colors, [
					{ r: 0, g: 0, b: 0, a: 255 },
					{ r: 200, g: 0, b: 0, a: 255 },
				]);
			});
		},
	},
	{
		name: "MCP palette and CLI palette produce identical editable pixels",
		async run() {
			await withRoot(async (root, input) => {
				const palette = join(root, "palette.mcpx");
				await writeFile(palette, PALETTE);
				const result = await handleQuantizeAsset({ inputPath: input, palette });
				const block = result.content[0];
				assert.ok(block?.type === "text");
				const body = JSON.parse(block.text);
				assert.notEqual(result.isError, true, block.text);
				assert.deepEqual(pixels(body.mcpxText), [...BLACK, ...BLACK, ...RED]);
				const capture = captureQuantizeStreams();
				const output = join(root, "out.mcpx");
				assert.equal(
					await runQuantize(
						input,
						{ palette, source: output },
						true,
						capture.streams,
					),
					0,
				);
				assert.equal(body.mcpxText, await readFile(output, "utf8"));
			});
		},
	},
	{
		name: "MCP preserves reserved colors with a zero remaining budget",
		async run() {
			await withRoot(async (_root, input) => {
				const result = await handleQuantizeAsset({
					inputPath: input,
					colors: 1,
					keepColors: [{ r: 0, g: 0, b: 0, a: 255 }],
				});
				const block = result.content[0];
				assert.ok(block?.type === "text");
				assert.notEqual(result.isError, true, block.text);
				assert.deepEqual(pixels(JSON.parse(block.text).mcpxText), [
					...BLACK,
					...BLACK,
					...BLACK,
				]);
			});
		},
	},
	{
		name: "MCP rejects a keep color outside the selection palette before writing",
		async run() {
			await withRoot(async (root, input) => {
				const palette = join(root, "palette.mcpx");
				await writeFile(palette, PALETTE);
				const before = (await readdir(root)).sort();
				const result = await handleQuantizeAsset({
					inputPath: input,
					palette,
					keepColors: [{ r: 255, g: 0, b: 0, a: 255 }],
					selection: "rect:0,0,1,1",
				});
				assert.equal(result.isError, true);
				const block = result.content[0];
				assert.ok(block?.type === "text");
				assert.equal(JSON.parse(block.text).code, "INVALID_ARGUMENT");
				assert.deepEqual((await readdir(root)).sort(), before);
				assert.equal(await readFile(input, "utf8"), SOURCE);
			});
		},
	},
	{
		name: "MCP colors with selection keeps outside pixels and normalizes keeps",
		async run() {
			await withRoot(async (_root, input) => {
				const result = await handleQuantizeAsset({
					inputPath: input,
					colors: 1,
					keepColors: [{ r: 200, g: 0, b: 0, a: 255 }],
					selection: "rect:0,0,2,1",
				});
				const block = result.content[0];
				assert.ok(block?.type === "text");
				const body = JSON.parse(block.text);
				assert.notEqual(result.isError, true, block.text);
				assert.deepEqual(body.keepColors, [{ r: 200, g: 0, b: 0, a: 255 }]);
				assert.deepEqual(pixels(body.mcpxText), [
					50,
					0,
					0,
					255,
					50,
					0,
					0,
					255,
					...RED,
				]);
			});
		},
	},
	{
		name: "MCP conflicts use ARGUMENT_CONFLICT before input IO",
		async run() {
			const result = await handleQuantizeAsset({
				inputPath: "missing.png",
				colors: 1,
				palette: "iron",
			});
			const block = result.content[0];
			assert.ok(block?.type === "text");
			assert.equal(JSON.parse(block.text).code, "ARGUMENT_CONFLICT");
		},
	},
];
