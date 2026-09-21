import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeCleanBaseline } from "../validate/pack-fixtures.ts";

/**
 * MCP v0.7 twelve-tool stdio integration: every new tool travels through a
 * real spawned `mc-asset mcp` server via the SDK client. Success paths
 * assert the frozen result shapes (deterministic JSON, no timestamps);
 * error paths assert structured isError results carrying the existing
 * error codes (never a placeholder message).
 *
 * Fixtures: tests/cli/fixtures/px-8x8.png (self-made 8x8 raster),
 * sword.mcpx (self-made 4x4 pattern), v04-anim-frames/ (two 4x4 frames),
 * v04-nine-slice.mcmeta (nine_slice border 1 over a 4x4 design).
 */

const FIXTURES = "tests/cli/fixtures";
const PNG_8X8 = join(FIXTURES, "px-8x8.png");
const SWORD_MCPX = join(FIXTURES, "sword.mcpx");
const FRAMES_DIR = join(FIXTURES, "v04-anim-frames");
const NINE_SLICE_MCMETA = join(FIXTURES, "v04-nine-slice.mcmeta");

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
	const next = new Client({
		name: "mc-asset-v07-tools-test",
		version: "0.0.0",
	});
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

describe("mcp v0.7 twelve tools over stdio", () => {
	test("import_asset embeds PNG bytes and .mcpx text for a raster input", async () => {
		const connected = await connect();
		const result = await callTool(connected, "import_asset", {
			inputPath: PNG_8X8,
		});
		expect(result.isError).toBe(false);
		expect(result.json?.applied).toBe(0);
		const pngBase64 = result.json?.pngBase64 as string | undefined;
		const mcpxText = result.json?.mcpxText as string | undefined;
		expect(typeof pngBase64).toBe("string");
		expect(typeof mcpxText).toBe("string");
		expect(
			pngMagic(new Uint8Array(Buffer.from(pngBase64 as string, "base64"))),
		).toBe(true);
		expect((mcpxText as string).startsWith("mcpx 1")).toBe(true);
	}, 30_000);

	test("import_asset on a missing file is a structured FILESYSTEM_ERROR", async () => {
		const connected = await connect();
		const result = await callTool(connected, "import_asset", {
			inputPath: join(FIXTURES, "does-not-exist.png"),
		});
		expect(result.isError).toBe(true);
		expect(result.json?.code).toBe("FILESYSTEM_ERROR");
	}, 30_000);

	test("build_asset rebuilds an .mcpx source with embedded artifacts", async () => {
		const connected = await connect();
		const result = await callTool(connected, "build_asset", {
			sourcePath: SWORD_MCPX,
		});
		expect(result.isError).toBe(false);
		expect(result.json?.applied).toBe(0);
		expect(typeof result.json?.pngBase64).toBe("string");
		const mcpxText = result.json?.mcpxText as string | undefined;
		expect(typeof mcpxText).toBe("string");
		expect((mcpxText as string).startsWith("mcpx 1")).toBe(true);
	}, 30_000);

	test("build_asset rejects a raster source", async () => {
		const connected = await connect();
		const result = await callTool(connected, "build_asset", {
			sourcePath: PNG_8X8,
		});
		expect(result.isError).toBe(true);
		expect(result.json?.code).toBe("INVALID_ARGUMENT");
	}, 30_000);

	test("transform_asset writes PNG and .mcpx to explicit outputs", async () => {
		const connected = await connect();
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcp-tr-"));
		const outPng = join(dir, "out.png");
		const outMcpx = join(dir, "out.mcpx");
		const result = await callTool(connected, "transform_asset", {
			inputPath: SWORD_MCPX,
			flip: "h",
			outputPngPath: outPng,
			outputMcpxPath: outMcpx,
		});
		expect(result.isError).toBe(false);
		expect(result.json?.geometry).toBe("flip:h");
		expect(result.json?.output).toBe(outPng);
		expect(result.json?.source).toBe(outMcpx);
		expect("pngBase64" in (result.json ?? {})).toBe(false);
		expect("mcpxText" in (result.json ?? {})).toBe(false);
		expect(pngMagic(new Uint8Array(await readFile(outPng)))).toBe(true);
		expect((await readFile(outMcpx, "utf-8")).startsWith("mcpx 1")).toBe(true);
	}, 30_000);

	test("transform_asset enforces the exactly-one-geometry rule", async () => {
		const connected = await connect();
		const conflict = await callTool(connected, "transform_asset", {
			inputPath: SWORD_MCPX,
			flip: "h",
			rotate: 90,
		});
		expect(conflict.isError).toBe(true);
		expect(conflict.json?.code).toBe("ARGUMENT_CONFLICT");
		const none = await callTool(connected, "transform_asset", {
			inputPath: SWORD_MCPX,
		});
		expect(none.isError).toBe(true);
		expect(none.json?.code).toBe("INVALID_ARGUMENT");
	}, 30_000);

	test("quantize_asset reduces colors with embedded artifacts", async () => {
		const connected = await connect();
		const result = await callTool(connected, "quantize_asset", {
			inputPath: PNG_8X8,
			colors: 4,
		});
		expect(result.isError).toBe(false);
		expect(result.json?.colors).toBe(4);
		expect(typeof result.json?.colorCount).toBe("number");
		expect((result.json?.colorCount as number) <= 4).toBe(true);
		expect(typeof result.json?.modifiedPixels).toBe("number");
		expect(typeof result.json?.pngBase64).toBe("string");
		expect(typeof result.json?.mcpxText).toBe("string");
	}, 30_000);

	test("quantize_asset rejects an out-of-range color count", async () => {
		const connected = await connect();
		const result = await callTool(connected, "quantize_asset", {
			inputPath: PNG_8X8,
			colors: 0,
		});
		expect(result.isError).toBe(true);
		expect(result.json?.code).toBe("INVALID_ARGUMENT");
	}, 30_000);

	test("cleanup_asset detect-only run reports without changing pixels", async () => {
		const connected = await connect();
		const result = await callTool(connected, "cleanup_asset", {
			inputPath: SWORD_MCPX,
		});
		expect(result.isError).toBe(false);
		expect(result.json?.modifiedPixels).toBe(0);
		expect(typeof result.json?.detected).toBe("object");
		expect(typeof result.json?.fixed).toBe("object");
		expect(typeof result.json?.pngBase64).toBe("string");
		expect(typeof result.json?.mcpxText).toBe("string");
	}, 30_000);

	test("cleanup_asset fix without render-pass authorization is INVALID_ARGUMENT", async () => {
		const connected = await connect();
		const result = await callTool(connected, "cleanup_asset", {
			inputPath: SWORD_MCPX,
			fix: "isolated",
		});
		expect(result.isError).toBe(true);
		expect(result.json?.code).toBe("INVALID_ARGUMENT");
	}, 30_000);

	test("palette_asset extract lists colors; inspect reports characteristics", async () => {
		const connected = await connect();
		const extract = await callTool(connected, "palette_asset", {
			mode: "extract",
			inputPath: SWORD_MCPX,
		});
		expect(extract.isError).toBe(false);
		expect(extract.json?.mode).toBe("extract");
		expect(typeof extract.json?.colorCount).toBe("number");
		const entries = extract.json?.entries as
			| Array<{ id: string; color: string }>
			| undefined;
		expect((entries?.length ?? 0) > 0).toBe(true);
		expect(typeof entries?.[0]?.color).toBe("string");
		const inspect = await callTool(connected, "palette_asset", {
			mode: "inspect",
			inputPath: SWORD_MCPX,
		});
		expect(inspect.isError).toBe(false);
		expect(inspect.json?.mode).toBe("inspect");
		expect(typeof inspect.json?.colorCount).toBe("number");
	}, 30_000);

	test("palette_asset on a missing file is a structured FILESYSTEM_ERROR", async () => {
		const connected = await connect();
		const result = await callTool(connected, "palette_asset", {
			mode: "extract",
			inputPath: join(FIXTURES, "does-not-exist.png"),
		});
		expect(result.isError).toBe(true);
		expect(result.json?.code).toBe("FILESYSTEM_ERROR");
	}, 30_000);

	test("material_asset lists builtins and shows one definition", async () => {
		const connected = await connect();
		const list = await callTool(connected, "material_asset", { mode: "list" });
		expect(list.isError).toBe(false);
		const materials = list.json?.materials as string[] | undefined;
		expect(Array.isArray(materials)).toBe(true);
		expect(materials).toContain("iron");
		const show = await callTool(connected, "material_asset", {
			mode: "show",
			name: "iron",
		});
		expect(show.isError).toBe(false);
		expect(show.json?.id).toBe("iron");
		const palette = show.json?.palette as unknown[] | undefined;
		expect((palette?.length ?? 0) > 0).toBe(true);
	}, 30_000);

	test("material_asset show rejects an unknown material", async () => {
		const connected = await connect();
		const result = await callTool(connected, "material_asset", {
			mode: "show",
			name: "not_a_material",
		});
		expect(result.isError).toBe(true);
		expect(result.json?.code).toBe("INVALID_ARGUMENT");
	}, 30_000);

	test("tile_asset previews 2x2 with an embedded PNG and seam scores", async () => {
		const connected = await connect();
		const result = await callTool(connected, "tile_asset", {
			inputPath: PNG_8X8,
			preview: "2x2",
		});
		expect(result.isError).toBe(false);
		expect(typeof result.json?.seam).toBe("object");
		expect(typeof result.json?.repeat).toBe("object");
		const pngBase64 = result.json?.pngBase64 as string | undefined;
		expect(typeof pngBase64).toBe("string");
		expect(
			pngMagic(new Uint8Array(Buffer.from(pngBase64 as string, "base64"))),
		).toBe(true);
	}, 30_000);

	test("tile_asset on a missing file is FILESYSTEM_ERROR; existing output is OUTPUT_EXISTS", async () => {
		const connected = await connect();
		const missing = await callTool(connected, "tile_asset", {
			inputPath: join(FIXTURES, "does-not-exist.png"),
		});
		expect(missing.isError).toBe(true);
		expect(missing.json?.code).toBe("FILESYSTEM_ERROR");
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcp-tile-"));
		const outPng = join(dir, "preview.png");
		await writeFile(outPng, "taken", "utf-8");
		const exists = await callTool(connected, "tile_asset", {
			inputPath: PNG_8X8,
			preview: "2x2",
			outputPngPath: outPng,
		});
		expect(exists.isError).toBe(true);
		expect(exists.json?.code).toBe("OUTPUT_EXISTS");
	}, 30_000);

	test("generate_asset synthesizes a deterministic texture with embedded artifacts", async () => {
		const connected = await connect();
		const result = await callTool(connected, "generate_asset", {
			pattern: "checker",
			size: "16",
			palette: "iron",
			seed: 7,
		});
		expect(result.isError).toBe(false);
		expect(result.json?.pattern).toBe("checker");
		expect(result.json?.seed).toBe(7);
		expect(result.json?.width).toBe(16);
		expect(result.json?.height).toBe(16);
		expect(result.json?.palette).toBe("iron");
		const pngBase64 = result.json?.pngBase64 as string | undefined;
		const mcpxText = result.json?.mcpxText as string | undefined;
		expect(typeof pngBase64).toBe("string");
		expect(typeof mcpxText).toBe("string");
		expect(
			pngMagic(new Uint8Array(Buffer.from(pngBase64 as string, "base64"))),
		).toBe(true);
		expect((mcpxText as string).startsWith("mcpx 1")).toBe(true);
	}, 30_000);

	test("generate_asset rejects a non-material palette", async () => {
		const connected = await connect();
		const result = await callTool(connected, "generate_asset", {
			pattern: "checker",
			size: "16",
			palette: "not_a_material",
			seed: 7,
		});
		expect(result.isError).toBe(true);
		expect(result.json?.code).toBe("INVALID_ARGUMENT");
	}, 30_000);

	test("preview_asset ascii reports lines; scale writes a PNG to the explicit path", async () => {
		const connected = await connect();
		const ascii = await callTool(connected, "preview_asset", {
			inputPath: SWORD_MCPX,
			mode: "ascii",
		});
		expect(ascii.isError).toBe(false);
		expect(ascii.json?.mode).toBe("ascii");
		expect(ascii.json?.width).toBe(4);
		expect(ascii.json?.height).toBe(4);
		expect(Array.isArray(ascii.json?.ascii)).toBe(true);
		expect(typeof ascii.json?.palette).toBe("object");
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcp-prev-"));
		const outPng = join(dir, "scaled.png");
		const scaled = await callTool(connected, "preview_asset", {
			inputPath: SWORD_MCPX,
			mode: "scale",
			scale: 2,
			outputPngPath: outPng,
		});
		expect(scaled.isError).toBe(false);
		expect(scaled.json?.mode).toBe("scale");
		expect(scaled.json?.width).toBe(8);
		expect(scaled.json?.height).toBe(8);
		expect(scaled.json?.output).toBe(outPng);
		expect(pngMagic(new Uint8Array(await readFile(outPng)))).toBe(true);
	}, 30_000);

	test("preview_asset nine-slice reports regions with an embedded guide PNG", async () => {
		const connected = await connect();
		const result = await callTool(connected, "preview_asset", {
			inputPath: SWORD_MCPX,
			mode: "nine-slice",
			mcmetaPath: NINE_SLICE_MCMETA,
		});
		expect(result.isError).toBe(false);
		expect(result.json?.mode).toBe("nine-slice");
		expect(typeof result.json?.regions).toBe("object");
		expect(Array.isArray(result.json?.findings)).toBe(true);
		expect(typeof result.json?.pngBase64).toBe("string");
	}, 30_000);

	test("scale_gui_asset stretches a raster to the target size", async () => {
		const connected = await connect();
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcp-gui-"));
		const outPng = join(dir, "scaled.png");
		const result = await callTool(connected, "scale_gui_asset", {
			inputPath: PNG_8X8,
			size: "12x12",
			outputPngPath: outPng,
		});
		expect(result.isError).toBe(false);
		expect(result.json?.width).toBe(12);
		expect(result.json?.height).toBe(12);
		expect(result.json?.scaling).toEqual({ type: "stretch" });
		expect(result.json?.output).toBe(outPng);
		expect(pngMagic(new Uint8Array(await readFile(outPng)))).toBe(true);
	}, 30_000);

	test("scale_gui_asset applies nine_slice with an explicit mcmeta", async () => {
		const connected = await connect();
		const result = await callTool(connected, "scale_gui_asset", {
			inputPath: PNG_8X8,
			size: "12",
			mcmetaPath: NINE_SLICE_MCMETA,
		});
		expect(result.isError).toBe(false);
		expect(result.json?.width).toBe(12);
		expect(result.json?.height).toBe(12);
		expect(typeof result.json?.pngBase64).toBe("string");
	}, 30_000);

	test("scale_gui_asset rejects a bad size", async () => {
		const connected = await connect();
		const result = await callTool(connected, "scale_gui_asset", {
			inputPath: PNG_8X8,
			size: "0",
		});
		expect(result.isError).toBe(true);
		expect(result.json?.code).toBe("INVALID_ARGUMENT");
	}, 30_000);

	test("preview_asset scale rejects a non-positive factor", async () => {
		const connected = await connect();
		const result = await callTool(connected, "preview_asset", {
			inputPath: SWORD_MCPX,
			mode: "scale",
			scale: 0,
		});
		expect(result.isError).toBe(true);
		expect(result.json?.code).toBe("INVALID_ARGUMENT");
	}, 30_000);

	test("animate_asset pack embeds a sheet; validate passes the frames", async () => {
		const connected = await connect();
		const pack = await callTool(connected, "animate_asset", {
			mode: "pack",
			framesDir: FRAMES_DIR,
			layout: "vertical",
		});
		expect(pack.isError).toBe(false);
		expect(pack.json?.mode).toBe("pack");
		expect(pack.json?.frameCount).toBe(2);
		expect(pack.json?.frameWidth).toBe(4);
		expect(pack.json?.frameHeight).toBe(4);
		expect(pack.json?.width).toBe(4);
		expect(pack.json?.height).toBe(8);
		expect(typeof pack.json?.pngBase64).toBe("string");
		const validate = await callTool(connected, "animate_asset", {
			mode: "validate",
			framesDir: FRAMES_DIR,
		});
		expect(validate.isError).toBe(false);
		expect(validate.json?.verdict).toBe("pass");
		expect(validate.json?.frameCount).toBe(2);
	}, 60_000);

	test("animate_asset unpack writes frames under an explicit output directory", async () => {
		const connected = await connect();
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcp-anim-"));
		const sheetPath = join(dir, "sheet.png");
		const packed = await callTool(connected, "animate_asset", {
			mode: "pack",
			framesDir: FRAMES_DIR,
			layout: "vertical",
			outputPngPath: sheetPath,
		});
		expect(packed.isError).toBe(false);
		expect(packed.json?.output).toBe(sheetPath);
		const outDir = join(dir, "frames");
		await mkdir(outDir);
		const unpacked = await callTool(connected, "animate_asset", {
			mode: "unpack",
			sheetPath,
			layout: "vertical",
			frameSize: "4",
			outputDir: outDir,
		});
		expect(unpacked.isError).toBe(false);
		expect(unpacked.json?.frameCount).toBe(2);
		const files = unpacked.json?.files as string[] | undefined;
		expect(files?.length).toBe(2);
		expect(
			(await readFile(join(outDir, files?.[0] as string), "utf-8")).startsWith(
				"mcpx 1",
			),
		).toBe(true);
	}, 60_000);

	test("animate_asset pack without a frames directory is INVALID_ARGUMENT", async () => {
		const connected = await connect();
		const result = await callTool(connected, "animate_asset", {
			mode: "pack",
			layout: "vertical",
		});
		expect(result.isError).toBe(true);
		expect(result.json?.code).toBe("INVALID_ARGUMENT");
	}, 30_000);

	test("validate_pack_asset passes a clean pack", async () => {
		const connected = await connect();
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcp-pack-"));
		await writeCleanBaseline(dir);
		const result = await callTool(connected, "validate_pack_asset", {
			packPath: dir,
			resourcePackVersion: "75",
		});
		expect(result.isError).toBe(false);
		expect(result.json?.verdict).toBe("pass");
		expect(typeof result.json?.target).toBe("string");
		expect(Array.isArray(result.json?.findings)).toBe(true);
	}, 30_000);

	test("validate_pack_asset on a missing pack root is FILESYSTEM_ERROR", async () => {
		const connected = await connect();
		const result = await callTool(connected, "validate_pack_asset", {
			packPath: join(tmpdir(), "mc-asset-mcp-pack-missing"),
		});
		expect(result.isError).toBe(true);
		expect(result.json?.code).toBe("FILESYSTEM_ERROR");
	}, 30_000);
});
