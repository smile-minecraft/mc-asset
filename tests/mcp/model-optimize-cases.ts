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
import { z } from "zod";
import { runOptimize } from "../../src/cli/cmd-optimize.ts";
import {
	handleModelAsset,
	handleOptimizeAsset,
} from "../../src/mcp/handlers-model-optimize.ts";
import { MCP_TOOL_NAMES, TOOL_INPUT_SCHEMAS } from "../../src/mcp/schema.ts";
import { captureStreams } from "../cli/optimize-model-cases.ts";
import { PNG_VECTORS } from "../io/png-cases.ts";
export const modelOptimizeCases = [
	{
		name: "additive tool names",
		async run() {
			assert.equal(MCP_TOOL_NAMES.length, 25);
			assert.deepEqual(MCP_TOOL_NAMES.slice(-4), [
				"optimize_asset",
				"model_asset",
				"mcmeta_asset",
				"compare_assets",
			]);
		},
	},
	{
		name: "optimize input count limit",
		async run() {
			assert.equal(
				z
					.object(TOOL_INPUT_SCHEMAS.optimize_asset)
					.safeParse({ inputPaths: Array(257).fill("a.png") }).success,
				false,
			);
		},
	},
	{
		name: "model operation count limit",
		async run() {
			assert.equal(
				z.object(TOOL_INPUT_SCHEMAS.model_asset).safeParse({
					mode: "apply",
					inputPath: "a.json",
					operations: Array(1001).fill({ op: "remove_element", index: 0 }),
				}).success,
				false,
			);
		},
	},
	{
		name: "model create embeds JSON",
		async run() {
			const result = await handleModelAsset({
				mode: "create",
				spec: { textures: { all: "test:block/a" } },
			});
			const text = result.content.find((c) => c.type === "text");
			assert.ok(text?.type === "text");
			const body = JSON.parse(text.text);
			assert.equal(body.command, "model");
			assert.equal(body.mode, "create");
			assert.equal(typeof body.modelText, "string");
		},
	},
	...["inspect", "validate", "apply", "export"].map((mode) => ({
		name: `model ${mode} requires input`,
		async run() {
			const result = await handleModelAsset({
				mode: mode as "inspect" | "validate" | "apply" | "export",
			});
			assert.equal(result.isError, true);
			const content = result.content[0];
			assert.ok(content?.type === "text");
			assert.ok(content.text.includes("INVALID_ARGUMENT"));
		},
	})),
	{
		name: "optimize output conflict",
		async run() {
			const result = await handleOptimizeAsset({
				inputPaths: ["a.png"],
				dryRun: true,
				outputPath: "out.png",
			});
			assert.equal(result.isError, true);
		},
	},
	{
		name: "optimize batch needs outputDir",
		async run() {
			const result = await handleOptimizeAsset({
				inputPaths: ["a.png", "b.png"],
			});
			assert.equal(result.isError, true);
		},
	},
];

export const modelOptimizeSurfaceCases = [
	{
		name: "optimize embeds a single result without output paths",
		async run() {
			const root = await mkdtemp(join(tmpdir(), "mcp-embed-"));
			try {
				const input = join(root, "a.png");
				await writeFile(
					input,
					Buffer.from(PNG_VECTORS.V_PATTERN_2X2, "base64"),
				);
				const result = await handleOptimizeAsset({ inputPaths: [input] });
				if (result.isError === true)
					throw new Error("embedded result reported an error");
				const body = JSON.parse(
					(result.content[0] as { text: string }).text,
				) as Record<string, unknown>;
				if (body.command !== "optimize") throw new Error("command");
				if (typeof body.pngBase64 !== "string") throw new Error("pngBase64");
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	},
	{
		name: "optimize dry run writes nothing",
		async run() {
			const root = await mkdtemp(join(tmpdir(), "mcp-dry-"));
			try {
				const input = join(root, "a.png");
				await writeFile(
					input,
					Buffer.from(PNG_VECTORS.V_PATTERN_2X2, "base64"),
				);
				const result = await handleOptimizeAsset({
					inputPaths: [input],
					dryRun: true,
				});
				if (result.isError === true)
					throw new Error("dry run reported an error");
				const body = JSON.parse(
					(result.content[0] as { text: string }).text,
				) as Record<string, unknown>;
				if (body.dryRun !== true) throw new Error("dryRun");
				const files = body.files as Record<string, unknown>[];
				if (files[0]?.output !== null) throw new Error("dry-run output");
				const names = await readdir(root);
				if (names.join() !== "a.png")
					throw new Error(`dry run wrote: ${names.join()}`);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	},
	{
		name: "optimize refuses a symlink output even through the tool",
		async run() {
			const root = await mkdtemp(join(tmpdir(), "mcp-symlink-"));
			try {
				const input = join(root, "a.png");
				await writeFile(
					input,
					Buffer.from(PNG_VECTORS.V_PATTERN_2X2, "base64"),
				);
				const elsewhere = join(root, "elsewhere.png");
				await writeFile(elsewhere, "old");
				const link = join(root, "out.png");
				await symlink(elsewhere, link);
				const result = await handleOptimizeAsset({
					inputPaths: [input],
					outputPath: link,
				});
				if (result.isError !== true) throw new Error("symlink target accepted");
				const body = JSON.parse(
					(result.content[0] as { text: string }).text,
				) as Record<string, unknown>;
				if (body.code !== "FILESYSTEM_ERROR") throw new Error("code");
				const details = body.details as Record<string, unknown>;
				if (details.reason !== "target-is-symlink") throw new Error("reason");
				if ((await readFile(elsewhere, "utf8")) !== "old")
					throw new Error("link target rewritten");
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	},
	{
		name: "model export embeds every binding artifact",
		async run() {
			const root = await mkdtemp(join(tmpdir(), "mcp-export-"));
			try {
				const input = join(root, "model.json");
				await writeFile(
					input,
					JSON.stringify({ textures: { all: "minecraft:block/stone" } }),
				);
				const binding = join(root, "binding.json");
				await writeFile(
					binding,
					JSON.stringify({
						item: { itemId: "minecraft:ruby", modelId: "minecraft:item/ruby" },
					}),
				);
				const result = await handleModelAsset({
					mode: "export",
					inputPath: input,
					binding: JSON.parse(await readFile(binding, "utf8")),
					minecraftVersion: "1.21.11",
				});
				if (result.isError === true)
					throw new Error("export reported an error");
				const body = JSON.parse(
					(result.content[0] as { text: string }).text,
				) as Record<string, unknown>;
				if (typeof body.modelText !== "string") throw new Error("modelText");
				if (typeof body.itemText !== "string") throw new Error("itemText");
				const names = (await readdir(root)).sort();
				if (names.join() !== ["binding.json", "model.json"].join())
					throw new Error(`export wrote: ${names.join()}`);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	},
];

export const cliMcpConsistencyCases = [
	{
		name: "optimize reports identical fields through the CLI and the tool",
		async run() {
			const root = await mkdtemp(join(tmpdir(), "mcp-consistency-"));
			try {
				const input = join(root, "a.png");
				await writeFile(
					input,
					Buffer.from(PNG_VECTORS.V_PATTERN_2X2, "base64"),
				);
				const capture = captureStreams();
				const code = await runOptimize(
					[input],
					{ dryRun: true },
					true,
					capture.streams,
				);
				if (code !== 0) throw new Error(`cli exit ${code}`);
				const cliBody = JSON.parse(
					Buffer.from(capture.stdout())
						.toString("utf-8")
						.trim()
						.split("\n")
						.filter(Boolean)
						.pop() ?? "{}",
				) as Record<string, unknown>;
				const tool = await handleOptimizeAsset({
					inputPaths: [input],
					dryRun: true,
				});
				if (tool.isError === true) throw new Error("tool reported an error");
				const toolBody = JSON.parse(
					(tool.content[0] as { text: string }).text,
				) as Record<string, unknown>;
				const cliResult = cliBody.result as Record<string, unknown>;
				for (const key of [
					"command",
					"dryRun",
					"mode",
					"ancillary",
					"engine",
					"totals",
				]) {
					if (JSON.stringify(cliResult[key]) !== JSON.stringify(toolBody[key]))
						throw new Error(
							`${key}: ${JSON.stringify(cliResult[key])} vs ${JSON.stringify(toolBody[key])}`,
						);
				}
				const cliFile = (
					cliResult.files as Record<string, unknown>[]
				)[0] as Record<string, unknown>;
				const toolFile = (
					toolBody.files as Record<string, unknown>[]
				)[0] as Record<string, unknown>;
				for (const key of [
					"status",
					"source",
					"result",
					"savedBytes",
					"savedPermille",
					"candidates",
					"preservedChunks",
					"strippedChunks",
					"interlaceRemoved",
					"warnings",
				]) {
					if (JSON.stringify(cliFile[key]) !== JSON.stringify(toolFile[key]))
						throw new Error(`files.${key} differs`);
				}
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	},
];
