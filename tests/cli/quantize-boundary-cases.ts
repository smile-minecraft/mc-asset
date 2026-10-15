import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runQuantize } from "../../src/cli/cmd-quantize.ts";
import { planQuantizeOutputs } from "../../src/cli/quantize-output.ts";
import { resolveQuantizePalette } from "../../src/cli/quantize-palette-source.ts";
import { parseMcpx } from "../../src/mcpx/index.ts";
import { captureQuantizeStreams } from "./quantize-palette-cases.ts";

export const quantizeBoundaryCases = [
	{
		name: "commander collects repeated keep-color values in order",
		async run() {
			const script = `
import {buildProgram} from "./src/cli/program.ts";
const program=buildProgram();
const command=program.commands.find(entry=>entry.name()==="quantize");
let received;
command.action((_input,options)=>{received=options.keepColor;});
await program.parseAsync(["node","mc-asset","quantize","input.png","--colors","2","--keep-color","1,2,3,4","--keep-color","5,6,7,8"]);
console.log(JSON.stringify(received));`;
			const output = execFileSync("bun", ["-e", script], { encoding: "utf8" });
			assert.deepEqual(JSON.parse(output), ["1,2,3,4", "5,6,7,8"]);
		},
	},
	{
		name: "colors-only PNG and mcpx bytes match the original source revision",
		async run() {
			const root = await mkdtemp(join(tmpdir(), "quantize-fixed-"));
			try {
				const png = join(root, "out.png"),
					mcpx = join(root, "out.mcpx");
				const capture = captureQuantizeStreams();
				assert.equal(
					await runQuantize(
						resolve("tests/cli/fixtures/sword.mcpx"),
						{ colors: "2", output: png, source: mcpx },
						true,
						capture.streams,
					),
					0,
				);
				const hash = async (path: string) =>
					createHash("sha256")
						.update(await readFile(path))
						.digest("hex");
				assert.equal(
					await hash(png),
					"44560dfd97b6acf3e01e8b00b673678f34e63ef058165564817364613d637523",
				);
				assert.equal(
					await hash(mcpx),
					"9752d52d25c533fe9627804bd2b7e15dbd04f89dc96c1b2170536e944f7b4197",
				);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	},
	...[false, true].flatMap((inPlace) =>
		[false, true].map((link) => ({
			name: `palette source is protected with inPlace=${inPlace}, symlink=${link}`,
			async run() {
				const root = await mkdtemp(join(tmpdir(), "quantize-input-"));
				try {
					const palette = join(root, "palette.mcpx");
					await writeFile(palette, "original");
					const output = link ? join(root, "alias.mcpx") : palette;
					if (link) await symlink(palette, output);
					await assert.rejects(
						planQuantizeOutputs(
							{
								pngStdout: false,
								pngFiles: [],
								mcpxFiles: [{ path: output, force: true }],
							},
							{ inputPath: join(root, "image.mcpx"), palette, inPlace },
						),
						(error) =>
							(error as { code: string }).code === "ARGUMENT_CONFLICT" ||
							(error as { code: string }).code === "FILESYSTEM_ERROR",
					);
					assert.equal(await readFile(palette, "utf8"), "original");
				} finally {
					await rm(root, { recursive: true, force: true });
				}
			},
		})),
	),
	...["empty", "malformed", "missing"].map((kind) => ({
		name: `palette loader preserves ${kind} input error`,
		async run() {
			const root = await mkdtemp(join(tmpdir(), "quantize-loader-"));
			try {
				const file = join(root, "palette.mcpx");
				let code = "FILESYSTEM_ERROR";
				if (kind === "empty") {
					await writeFile(file, "mcpx 1\n[canvas]\nwidth = 1\nheight = 1\n");
					code = "INVALID_ARGUMENT";
				}
				if (kind === "malformed") {
					const text = "not mcpx";
					await writeFile(file, text);
					try {
						parseMcpx(text);
					} catch (error) {
						code = (error as { code: string }).code;
					}
				}
				await assert.rejects(
					resolveQuantizePalette(file),
					(error) => (error as { code: string }).code === code,
				);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	})),
];
