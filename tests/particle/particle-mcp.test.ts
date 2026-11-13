import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../src/core/canvas.ts";
import { encodePng } from "../../src/io/png.ts";

/**
 * One real stdio round trip for the particle tool: registration, the Zod
 * input shape, the success report, and the OUTPUT_EXISTS refusal all travel
 * through a spawned `mc-asset mcp` server, not a direct handler call.
 */

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
	const next = new Client({ name: "mc-asset-particle-test", version: "0.0.0" });
	await next.connect(transport);
	client = next;
	return next;
}

function framePng(): Uint8Array {
	const canvas = createCanvas(8, 8);
	const layer = addLayer(canvas, { id: "base" });
	const pixels = new Uint8Array(8 * 8 * 4);
	for (let index = 0; index < pixels.length; index += 4) {
		pixels[index] = 200;
		pixels[index + 3] = 255;
	}
	replaceLayerPixels(canvas, layer.id, pixels);
	return encodePng(canvas);
}

describe("particle_asset over stdio", () => {
	test("writes the definition and refuses a second run without force", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-particle-mcp-"));
		try {
			const framesDir = join(dir, "frames");
			await mkdir(framesDir, { recursive: true });
			await writeFile(join(framesDir, "frame_2.png"), framePng());
			await writeFile(join(framesDir, "frame_10.png"), framePng());
			const packDir = join(dir, "pack");
			const connected = await connect();

			const first = await connected.callTool({
				name: "particle_asset",
				arguments: {
					inputPath: framesDir,
					outputDir: packDir,
					namespace: "demo",
					id: "spark",
					mkdir: true,
				},
			});
			expect(first.isError).not.toBe(true);
			const block = (
				first.content as Array<{ type: string; text?: string }>
			)[0];
			const report = JSON.parse(block?.text ?? "{}") as {
				command: string;
				frames: Array<{ input: string }>;
			};
			expect(report.command).toBe("particle");
			expect(report.frames.map((frame) => frame.input)).toEqual([
				"frame_10.png",
				"frame_2.png",
			]);
			expect(
				await readFile(
					join(packDir, "assets/demo/particles/spark.json"),
					"utf8",
				),
			).toBe(
				`{\n  "textures": [\n    "demo:spark_0",\n    "demo:spark_1"\n  ]\n}\n`,
			);

			const refused = await connected.callTool({
				name: "particle_asset",
				arguments: {
					inputPath: framesDir,
					outputDir: packDir,
					namespace: "demo",
					id: "spark",
				},
			});
			expect(refused.isError).toBe(true);
			const failure = JSON.parse(
				(refused.content as Array<{ type: string; text?: string }>)[0]?.text ??
					"{}",
			) as { code: string };
			expect(failure.code).toBe("OUTPUT_EXISTS");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
