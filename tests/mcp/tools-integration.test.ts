import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * MCP seven-tool stdio integration: every tool travels through a real
 * spawned `mc-asset mcp` server via the SDK client. Success paths assert
 * the frozen result shapes; error paths assert structured isError results
 * carrying the existing error codes (never a placeholder message).
 *
 * Fixtures: tests/cli/fixtures/px-8x8.png (self-made 8x8 raster),
 * sword.mcpx (self-made 4x4 pattern), tiny.grid (self-made 4x4 grid).
 */

const FIXTURES = "tests/cli/fixtures";
const PNG_8X8 = join(FIXTURES, "px-8x8.png");
const SWORD_MCPX = join(FIXTURES, "sword.mcpx");
const TINY_GRID = join(FIXTURES, "tiny.grid");

let client: Client | undefined;

afterEach(async () => {
	if (client !== undefined) {
		const current = client;
		client = undefined;
		await current.close().catch(() => undefined);
	}
});

async function connect(): Promise<Client> {
	const transport = new StdioClientTransport({
		command: "bun",
		args: ["src/cli/index.ts", "mcp"],
	});
	const next = new Client({ name: "mc-asset-tools-test", version: "0.0.0" });
	await next.connect(transport);
	client = next;
	return next;
}

interface ToolCall {
	isError: boolean;
	text: string;
	json: Record<string, unknown> | undefined;
}

async function callTool(
	connected: Client,
	name: string,
	args: Record<string, unknown>,
): Promise<ToolCall> {
	const result = await connected.callTool({ name, arguments: args });
	const blocks = result.content as Array<{ type: string; text?: string }>;
	const text = blocks[0]?.text ?? "";
	let json: Record<string, unknown> | undefined;
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		json = undefined;
	}
	return { isError: result.isError === true, text, json };
}

function pngMagic(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	);
}

describe("mcp seven tools over stdio", () => {
	test("analyze_asset reports dimensions for a raster input", async () => {
		const connected = await connect();
		const result = await callTool(connected, "analyze_asset", {
			path: PNG_8X8,
		});
		expect(result.isError).toBe(false);
		expect(result.json).toBeDefined();
		const dimensions = result.json?.dimensions as
			| { width: number; height: number }
			| undefined;
		expect(dimensions).toEqual({ width: 8, height: 8 });
		expect(typeof result.json?.colorCount).toBe("number");
	}, 30_000);

	test("analyze_asset on a missing file is a structured FILESYSTEM_ERROR", async () => {
		const connected = await connect();
		const result = await callTool(connected, "analyze_asset", {
			path: join(FIXTURES, "does-not-exist.png"),
		});
		expect(result.isError).toBe(true);
		expect(result.json?.code).toBe("FILESYSTEM_ERROR");
		expect(typeof result.json?.message).toBe("string");
	}, 30_000);

	test("pixelize_asset embeds PNG bytes and .mcpx text when no output path is given", async () => {
		const connected = await connect();
		const result = await callTool(connected, "pixelize_asset", {
			inputPath: PNG_8X8,
			size: "16",
		});
		expect(result.isError).toBe(false);
		expect(result.json?.width).toBe(16);
		expect(result.json?.height).toBe(16);
		const pngBase64 = result.json?.pngBase64 as string | undefined;
		const mcpxText = result.json?.mcpxText as string | undefined;
		expect(typeof pngBase64).toBe("string");
		expect(typeof mcpxText).toBe("string");
		expect(
			pngMagic(new Uint8Array(Buffer.from(pngBase64 as string, "base64"))),
		).toBe(true);
		expect((mcpxText as string).startsWith("mcpx 1")).toBe(true);
	}, 30_000);

	test("pixelize_asset rejects an .mcpx source", async () => {
		const connected = await connect();
		const result = await callTool(connected, "pixelize_asset", {
			inputPath: SWORD_MCPX,
			size: "16",
		});
		expect(result.isError).toBe(true);
		expect(result.json?.code).toBe("UNSUPPORTED_IMAGE_FORMAT");
	}, 30_000);

	test("render_pixel_asset renders inline gridText", async () => {
		const connected = await connect();
		const gridText = await readFile(TINY_GRID, "utf-8");
		const result = await callTool(connected, "render_pixel_asset", {
			gridText,
		});
		expect(result.isError).toBe(false);
		expect(result.json?.width).toBe(4);
		expect(result.json?.height).toBe(4);
		expect(typeof result.json?.pngBase64).toBe("string");
		expect(typeof result.json?.mcpxText).toBe("string");
	}, 30_000);

	test("render_pixel_asset refuses gridPath and gridText together", async () => {
		const connected = await connect();
		const gridText = await readFile(TINY_GRID, "utf-8");
		const result = await callTool(connected, "render_pixel_asset", {
			gridPath: TINY_GRID,
			gridText,
		});
		expect(result.isError).toBe(true);
		expect(result.json?.code).toBe("ARGUMENT_CONFLICT");
	}, 30_000);

	test("apply_asset_operations applies several ops in one call", async () => {
		const connected = await connect();
		const result = await callTool(connected, "apply_asset_operations", {
			sourcePath: SWORD_MCPX,
			operations: [
				{
					type: "setPixel",
					layerId: "base",
					x: 0,
					y: 0,
					color: "#FF0000FF",
				},
				{
					type: "fillRect",
					layerId: "base",
					rect: { x: 1, y: 1, width: 2, height: 2 },
					color: "#00FF00FF",
				},
			],
		});
		expect(result.isError).toBe(false);
		expect(result.json?.applied).toBe(2);
		const operations = result.json?.operations as
			| Array<{ status: string }>
			| undefined;
		expect(operations?.length).toBe(2);
		expect(operations?.every((entry) => entry.status === "applied")).toBe(true);
		expect(typeof result.json?.pngBase64).toBe("string");
		expect(typeof result.json?.mcpxText).toBe("string");
	}, 30_000);

	test("apply_asset_operations reports an unknown operation type", async () => {
		const connected = await connect();
		const result = await callTool(connected, "apply_asset_operations", {
			sourcePath: SWORD_MCPX,
			operations: [{ type: "wigglePixels", layerId: "base" }],
		});
		expect(result.isError).toBe(true);
		expect(result.json?.code).toBe("INVALID_ARGUMENT");
	}, 30_000);

	test("recolor_asset recolors with a builtin material", async () => {
		const connected = await connect();
		const result = await callTool(connected, "recolor_asset", {
			sourcePath: SWORD_MCPX,
			material: "iron",
		});
		expect(result.isError).toBe(false);
		expect(typeof result.json?.pixelsChanged).toBe("number");
		expect(typeof result.json?.pngBase64).toBe("string");
		expect(typeof result.json?.mcpxText).toBe("string");
	}, 30_000);

	test("recolor_asset rejects an unknown material", async () => {
		const connected = await connect();
		const result = await callTool(connected, "recolor_asset", {
			sourcePath: SWORD_MCPX,
			material: "not_a_material",
		});
		expect(result.isError).toBe(true);
		expect(result.json?.code).toBe("INVALID_ARGUMENT");
	}, 30_000);

	test("create_variants fans out under an explicit output directory", async () => {
		const connected = await connect();
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcp-var-"));
		const outDir = join(dir, "out");
		await mkdir(outDir);
		const result = await callTool(connected, "create_variants", {
			sourcePath: SWORD_MCPX,
			materials: ["iron"],
			outputDir: outDir,
		});
		expect(result.isError).toBe(false);
		const files = result.json?.files as
			| Array<{ material: string; png: string; mcpx: string }>
			| undefined;
		expect(files?.length).toBe(1);
		expect(files?.[0]?.material).toBe("iron");
		const pngBytes = new Uint8Array(await readFile(files?.[0]?.png as string));
		expect(pngMagic(pngBytes)).toBe(true);
		const mcpxText = await readFile(files?.[0]?.mcpx as string, "utf-8");
		expect(mcpxText.startsWith("mcpx 1")).toBe(true);
	}, 30_000);

	test("create_variants refuses a missing output directory", async () => {
		const connected = await connect();
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcp-var-"));
		const result = await callTool(connected, "create_variants", {
			sourcePath: SWORD_MCPX,
			materials: ["iron"],
			outputDir: join(dir, "missing-parent", "out"),
		});
		expect(result.isError).toBe(true);
		expect(result.json?.code).toBe("FILESYSTEM_ERROR");
	}, 30_000);

	test("validate_asset passes a clean raster", async () => {
		const connected = await connect();
		const result = await callTool(connected, "validate_asset", {
			path: PNG_8X8,
		});
		expect(result.isError).toBe(false);
		expect(result.json?.verdict).toBe("pass");
		expect(result.json?.coverage).toEqual({ status: "complete", skipped: [] });
	}, 30_000);

	test("validate_asset reports fail as a normal result with findings", async () => {
		const connected = await connect();
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcp-val-"));
		const renamed = join(dir, "Sword.PNG");
		await copyFile(PNG_8X8, renamed);
		const result = await callTool(connected, "validate_asset", {
			path: renamed,
			profile: "minecraft:item",
		});
		expect(result.isError).toBe(false);
		expect(result.json?.verdict).toBe("fail");
		const findings = result.json?.findings as unknown[] | undefined;
		expect((findings?.length ?? 0) > 0).toBe(true);
	}, 30_000);

	test("validate_asset on a missing file is a structured FILESYSTEM_ERROR", async () => {
		const connected = await connect();
		const result = await callTool(connected, "validate_asset", {
			path: join(FIXTURES, "does-not-exist.png"),
		});
		expect(result.isError).toBe(true);
		expect(result.json?.code).toBe("FILESYSTEM_ERROR");
	}, 30_000);

	test("explicit output paths write files; a missing parent is FILESYSTEM_ERROR", async () => {
		const connected = await connect();
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcp-out-"));
		const missingPng = join(dir, "missing-parent", "out.png");
		const missing = await callTool(connected, "pixelize_asset", {
			inputPath: PNG_8X8,
			size: "16",
			outputPngPath: missingPng,
		});
		expect(missing.isError).toBe(true);
		expect(missing.json?.code).toBe("FILESYSTEM_ERROR");

		const outPng = join(dir, "out.png");
		const outMcpx = join(dir, "out.mcpx");
		const written = await callTool(connected, "pixelize_asset", {
			inputPath: PNG_8X8,
			size: "16",
			outputPngPath: outPng,
			outputMcpxPath: outMcpx,
		});
		expect(written.isError).toBe(false);
		expect(written.json?.output).toBe(outPng);
		expect(written.json?.source).toBe(outMcpx);
		expect("pngBase64" in (written.json ?? {})).toBe(false);
		expect("mcpxText" in (written.json ?? {})).toBe(false);
		const pngBytes = new Uint8Array(await readFile(outPng));
		expect(pngMagic(pngBytes)).toBe(true);
		const mcpxText = await readFile(outMcpx, "utf-8");
		expect(mcpxText.startsWith("mcpx 1")).toBe(true);
	}, 30_000);

	test("pixelize repeats byte-identically (determinism)", async () => {
		const connected = await connect();
		const args = { inputPath: PNG_8X8, size: "16" };
		const first = await callTool(connected, "pixelize_asset", args);
		const second = await callTool(connected, "pixelize_asset", args);
		expect(first.isError).toBe(false);
		expect(second.isError).toBe(false);
		expect(second.text).toBe(first.text);
	}, 30_000);

	test("pixelize_asset passes the per-stage report through", async () => {
		const connected = await connect();
		const result = await callTool(connected, "pixelize_asset", {
			inputPath: PNG_8X8,
			size: "16",
			preset: "item",
		});
		expect(result.isError).toBe(false);
		const stages = result.json?.stages as
			| Array<{ stage: string; status: string }>
			| undefined;
		expect(stages?.map((entry) => entry.stage)).toEqual([
			"decode",
			"crop",
			"background",
			"subject",
			"resize",
			"edge",
			"quantize",
			"cluster",
			"cleanup",
			"preset",
			"output",
		]);
		for (const entry of stages ?? []) {
			expect(["applied", "not-needed", "disabled", "unsupported"]).toContain(
				entry.status,
			);
		}
		const byStage = new Map(
			(stages ?? []).map((entry) => [entry.stage, entry.status]),
		);
		for (const stage of ["crop", "background", "subject", "edge", "cluster"]) {
			expect(byStage.get(stage)).not.toBe("disabled");
		}
	}, 30_000);

	test("variant reruns into fresh directories stay byte-identical", async () => {
		const connected = await connect();
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcp-det-"));
		const outA = join(dir, "a");
		const outB = join(dir, "b");
		await mkdir(outA);
		await mkdir(outB);
		const argsFor = (outputDir: string): Record<string, unknown> => ({
			sourcePath: SWORD_MCPX,
			materials: ["iron", "copper"],
			outputDir,
		});
		const first = await callTool(connected, "create_variants", argsFor(outA));
		const second = await callTool(connected, "create_variants", argsFor(outB));
		expect(first.isError).toBe(false);
		expect(second.isError).toBe(false);
		for (const material of ["iron", "copper"]) {
			const pngA = new Uint8Array(
				await readFile(join(outA, `sword_${material}.png`)),
			);
			const pngB = new Uint8Array(
				await readFile(join(outB, `sword_${material}.png`)),
			);
			expect(Buffer.from(pngB).equals(Buffer.from(pngA))).toBe(true);
			const mcpxA = await readFile(
				join(outA, `sword_${material}.mcpx`),
				"utf-8",
			);
			const mcpxB = await readFile(
				join(outB, `sword_${material}.mcpx`),
				"utf-8",
			);
			expect(mcpxB).toBe(mcpxA);
		}
	}, 60_000);

	test("mcmeta wiring is honored verbatim (smoke via validate)", async () => {
		const connected = await connect();
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcp-mcmeta-"));
		const mcmetaPath = join(dir, "anim.mcmeta");
		await writeFile(mcmetaPath, '{"animation": {"frametime": 2}}', "utf-8");
		const result = await callTool(connected, "validate_asset", {
			path: PNG_8X8,
			mcmetaPath,
		});
		expect(result.isError).toBe(false);
		expect(typeof result.json?.verdict).toBe("string");
		expect(result.json?.coverage).toEqual({ status: "complete", skipped: [] });
		const mcmeta = result.json?.mcmeta as
			| { animation?: { frametime?: number } }
			| undefined;
		expect(mcmeta?.animation?.frametime).toBe(2);
	}, 30_000);
});
