import assert from "node:assert/strict";
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQuantize } from "../../src/cli/cmd-quantize.ts";
import { handleQuantizeAsset } from "../../src/mcp/handlers.ts";
import { captureQuantizeStreams } from "./quantize-palette-cases.ts";

export const quantizeOutputCases = [
	...["later-conflict", "symlink", "parent-symlink"].map((mode) => ({
		name: `quantize CLI rejects ${mode} before stdout and file writes`,
		async run() {
			const root = await mkdtemp(join(tmpdir(), "quantize-output-"));
			try {
				const input = join(root, "input.mcpx");
				await writeFile(
					input,
					"mcpx 1\n[canvas]\nwidth = 1\nheight = 1\n[palette]\nR = #FF0000FF\n[layer base]\n[grid]\nR\n",
				);
				let output = join(root, "second.mcpx");
				if (mode === "later-conflict") await writeFile(output, "original");
				if (mode === "symlink") {
					const target = join(root, "target.mcpx");
					await writeFile(target, "original");
					await symlink(target, output);
				}
				if (mode === "parent-symlink") {
					await symlink(root, join(root, "parent"));
					output = join(root, "parent/new.mcpx");
				}
				const capture = captureQuantizeStreams();
				const code = await runQuantize(
					input,
					{
						colors: "1",
						stdout: true,
						output: join(root, "first.png"),
						source: output,
						force: mode !== "later-conflict",
					},
					true,
					capture.streams,
				);
				assert.notEqual(code, 0);
				assert.equal(capture.stdout().length, 0);
				assert.ok(!(await readdir(root)).includes("first.png"));
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	})),

	{
		name: "quantize CLI refuses a palette output alias before stdout and file writes",
		async run() {
			const root = await mkdtemp(join(tmpdir(), "quantize-output-"));
			try {
				const input = join(root, "input.mcpx");
				const palette = join(root, "palette.mcpx");
				const text =
					"mcpx 1\n[canvas]\nwidth = 1\nheight = 1\n[palette]\nR = #FF0000FF\n[layer base]\n[grid]\nR\n";
				await writeFile(input, text);
				await writeFile(palette, text);
				const capture = captureQuantizeStreams();
				const code = await runQuantize(
					input,
					{
						palette,
						stdout: true,
						output: join(root, "first.png"),
						source: palette,
						force: true,
					},
					true,
					capture.streams,
				);
				assert.notEqual(code, 0);
				assert.equal(capture.stdout().length, 0);
				assert.ok(!(await readdir(root)).includes("first.png"));
				assert.equal(await readFile(palette, "utf8"), text);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	},
	{
		name: "quantize MCP refuses a palette output alias before any write",
		async run() {
			const root = await mkdtemp(join(tmpdir(), "quantize-output-"));
			try {
				const input = join(root, "input.mcpx");
				const palette = join(root, "palette.mcpx");
				const text =
					"mcpx 1\n[canvas]\nwidth = 1\nheight = 1\n[palette]\nR = #FF0000FF\n[layer base]\n[grid]\nR\n";
				await writeFile(input, text);
				await writeFile(palette, text);
				const result = await handleQuantizeAsset({
					inputPath: input,
					palette,
					outputPngPath: join(root, "first.png"),
					outputMcpxPath: palette,
				});
				assert.equal(result.isError, true);
				assert.deepEqual((await readdir(root)).sort(), [
					"input.mcpx",
					"palette.mcpx",
				]);
				assert.equal(await readFile(palette, "utf8"), text);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	},

	{
		name: "quantize MCP preflights a later conflict before writing the first output",
		async run() {
			const root = await mkdtemp(join(tmpdir(), "quantize-output-"));
			try {
				const input = join(root, "input.mcpx");
				const first = join(root, "first.png");
				const second = join(root, "second.mcpx");
				await writeFile(
					input,
					"mcpx 1\n[canvas]\nwidth = 1\nheight = 1\n[palette]\nR = #FF0000FF\n[layer base]\n[grid]\nR\n",
				);
				await writeFile(second, "original");
				const result = await handleQuantizeAsset({
					inputPath: input,
					colors: 1,
					outputPngPath: first,
					outputMcpxPath: second,
				});
				assert.equal(result.isError, true);
				assert.deepEqual((await readdir(root)).sort(), [
					"input.mcpx",
					"second.mcpx",
				]);
				assert.equal(await readFile(second, "utf8"), "original");
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	},
	...["source", "symlink", "parent-symlink"].map((mode) => ({
		name: `quantize MCP rejects ${mode} output before any write`,
		async run() {
			const root = await mkdtemp(join(tmpdir(), "quantize-output-"));
			try {
				const input = join(root, "input.mcpx");
				const first = join(root, "first.png");
				const text =
					"mcpx 1\n[canvas]\nwidth = 1\nheight = 1\n[palette]\nR = #FF0000FF\n[layer base]\n[grid]\nR\n";
				await writeFile(input, text);
				let output = input;
				if (mode === "symlink") {
					output = join(root, "link.mcpx");
					await symlink(input, output);
				}
				if (mode === "parent-symlink") {
					await symlink(root, join(root, "parent"));
					output = join(root, "parent/new.mcpx");
				}
				const result = await handleQuantizeAsset({
					inputPath: input,
					colors: 1,
					outputPngPath: first,
					outputMcpxPath: output,
				});
				assert.equal(result.isError, true);
				assert.ok(!(await readdir(root)).includes("first.png"));
				assert.equal(await readFile(input, "utf8"), text);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	})),
];

const ONE_PIXEL =
	"mcpx 1\n[canvas]\nwidth = 1\nheight = 1\n[palette]\nR = #FF0000FF\n[layer base]\n[grid]\nR\n";

/** Quantize has always written to whatever extension the caller names. */
for (const source of ["colors", "palette"] as const) {
	quantizeOutputCases.push({
		name: `quantize MCP ${source} keeps accepting any output extension`,
		async run() {
			const root = await mkdtemp(join(tmpdir(), "quantize-output-"));
			try {
				const input = join(root, "input.mcpx");
				const palette = join(root, "palette.mcpx");
				await writeFile(input, ONE_PIXEL);
				await writeFile(palette, ONE_PIXEL);
				const result = await handleQuantizeAsset({
					inputPath: input,
					...(source === "colors" ? { colors: 1 } : { palette }),
					outputPngPath: join(root, "image.dat"),
					outputMcpxPath: join(root, "editable.txt"),
				});
				assert.notEqual(result.isError, true);
				assert.ok((await readFile(join(root, "image.dat"))).length > 8);
				assert.ok(
					(await readFile(join(root, "editable.txt"), "utf8")).startsWith(
						"mcpx 1",
					),
				);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	});
	quantizeOutputCases.push({
		name: `quantize CLI ${source} keeps accepting any output extension`,
		async run() {
			const root = await mkdtemp(join(tmpdir(), "quantize-output-"));
			try {
				const input = join(root, "input.mcpx");
				const palette = join(root, "palette.mcpx");
				await writeFile(input, ONE_PIXEL);
				await writeFile(palette, ONE_PIXEL);
				const capture = captureQuantizeStreams();
				const code = await runQuantize(
					input,
					{
						...(source === "colors" ? { colors: "1" } : { palette }),
						output: join(root, "image.dat"),
						source: join(root, "editable.txt"),
					},
					true,
					capture.streams,
				);
				assert.equal(code, 0);
				assert.ok((await readdir(root)).includes("image.dat"));
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	});
	quantizeOutputCases.push({
		name: `quantize MCP ${source} with odd extensions still refuses palette alias, symlink and later conflict before any write`,
		async run() {
			const root = await mkdtemp(join(tmpdir(), "quantize-output-"));
			try {
				const input = join(root, "input.mcpx");
				const palette = join(root, "palette.mcpx");
				await writeFile(input, ONE_PIXEL);
				await writeFile(palette, ONE_PIXEL);
				const extra = source === "colors" ? { colors: 1 } : { palette };
				const first = join(root, "first.dat");
				const link = join(root, "link.txt");
				await symlink(input, link);
				const existing = join(root, "existing.txt");
				await writeFile(existing, "original");
				for (const later of [palette, link, existing, input]) {
					const result = await handleQuantizeAsset({
						inputPath: input,
						...extra,
						outputPngPath: first,
						outputMcpxPath: later,
					});
					assert.equal(result.isError, true, later);
					assert.ok(!(await readdir(root)).includes("first.dat"), later);
				}
				assert.equal(await readFile(palette, "utf8"), ONE_PIXEL);
				assert.equal(await readFile(existing, "utf8"), "original");
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	});
}
