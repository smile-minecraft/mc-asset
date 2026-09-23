import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMcpxText } from "../../src/cli/artifacts.ts";
import { addLayer, createCanvas, setPixel } from "../../src/core/canvas.ts";
import { encodePng } from "../../src/io/png.ts";
import {
	handleApplyAssetOperations,
	handleInspectAsset,
	type McpTextResult,
} from "../../src/mcp/handlers.ts";
import { TOOL_INPUT_SCHEMAS } from "../../src/mcp/schema.ts";
import { type CaseCheck, INSPECT_CASES } from "./inspect-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, _message) => expect(actual).toBe(expected),
	deepEqual: (actual, expected, _message) => expect(actual).toEqual(expected),
	ok: (value, _message) => expect(value).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("inspect engine pure cases", () => {
	for (const inspectCase of INSPECT_CASES) {
		test(inspectCase.name, () => {
			inspectCase.run(check);
		});
	}
});

// CLI behavior needs real subprocesses, so it stays in this bun:test entry
// on purpose: the node:test mirror (inspect.node.ts) only runs the pure
// cases above, keeping the dual entrypoint green on both runtimes.

function makePngBytes(): Uint8Array {
	const canvas = createCanvas(4, 4);
	const layer = addLayer(canvas, { id: "base" });
	setPixel(canvas, layer.id, 0, 0, { r: 255, g: 0, b: 0, a: 255 });
	setPixel(canvas, layer.id, 3, 3, { r: 0, g: 255, b: 0, a: 255 });
	return encodePng(canvas);
}

const SWORD_MCPX = "tests/cli/fixtures/sword.mcpx";
const CANONICAL_MCPX = "tests/mcpx/fixtures/canonical.mcpx";

async function runCli(args: string[]): Promise<{
	stdout: string;
	stderr: string;
	code: number;
}> {
	const proc = Bun.spawn(["bun", "src/cli/index.ts", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code };
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

function firstText(result: McpTextResult): string {
	const block = result.content[0] as { type: string; text?: string };
	return block.text ?? "{}";
}

describe("inspect command via spawn", () => {
	test("inspect --mode structure --json reports layers regions and overlaps", async () => {
		const { stdout, code } = await runCli([
			"inspect",
			CANONICAL_MCPX,
			"--mode",
			"structure",
			"--json",
		]);
		expect(code).toBe(0);
		const envelope = JSON.parse(stdout) as {
			success: boolean;
			result: Record<string, unknown>;
		};
		expect(envelope.success).toBe(true);
		const result = envelope.result as {
			command: string;
			mode: string;
			width: number;
			height: number;
			layers: Array<Record<string, unknown>>;
			regions: Array<Record<string, unknown>>;
			overlaps: { layerBounds: unknown[]; regionPixels: unknown[] };
		};
		expect(result.command).toBe("inspect");
		expect(result.mode).toBe("structure");
		expect(result.width).toBe(16);
		expect(result.height).toBe(16);
		expect(result.layers.length).toBe(1);
		const firstLayer = result.layers[0] as Record<string, unknown>;
		expect(firstLayer.id).toBe("base");
		expect(
			typeof (firstLayer.colorUsage as { uniqueColors: number }).uniqueColors,
		).toBe("number");
		expect(result.regions.length).toBe(1);
		const firstRegion = result.regions[0] as Record<string, unknown>;
		expect(firstRegion.id).toBe("blade");
		expect(Object.keys(firstRegion).sort()).toEqual([
			"area",
			"bounds",
			"id",
			"index",
			"name",
		]);
		expect(Array.isArray(result.overlaps.layerBounds)).toBe(true);
		expect(Array.isArray(result.overlaps.regionPixels)).toBe(true);
	}, 30_000);

	test("inspect --mode view --json returns metadata plus pngBase64", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-inspect-"));
		try {
			const input = join(dir, "sprite.png");
			await writeFile(input, makePngBytes());
			const before = await readFile(input);
			const { stdout, code } = await runCli([
				"inspect",
				input,
				"--mode",
				"view",
				"--json",
			]);
			expect(code).toBe(0);
			const envelope = JSON.parse(stdout) as {
				success: boolean;
				result: Record<string, unknown>;
			};
			expect(envelope.success).toBe(true);
			const result = envelope.result as {
				mode: string;
				scale: number;
				outputDimensions: { width: number; height: number };
				colorFormat: string;
				pngBase64: string;
			};
			expect(result.mode).toBe("view");
			expect(result.colorFormat).toBe("RGBA8");
			expect(typeof result.pngBase64).toBe("string");
			expect(
				pngMagic(new Uint8Array(Buffer.from(result.pngBase64, "base64"))),
			).toBe(true);
			// Read-only: input bytes are untouched.
			expect(await readFile(input)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("inspect rejects file flags and view-only options on structure", async () => {
		const flagged = await runCli([
			"inspect",
			CANONICAL_MCPX,
			"--mode",
			"structure",
			"--json",
			"--output",
			"out.png",
		]);
		expect(flagged.code).toBe(2);
		expect(JSON.parse(flagged.stdout) as unknown).toMatchObject({
			success: false,
		});
		const scoped = await runCli([
			"inspect",
			CANONICAL_MCPX,
			"--mode",
			"structure",
			"--json",
			"--crop",
			"rect:0,0,2,2",
		]);
		expect(scoped.code).toBe(2);
		const badMode = await runCli([
			"inspect",
			CANONICAL_MCPX,
			"--mode",
			"map",
			"--json",
		]);
		expect(badMode.code).toBe(2);
	}, 30_000);

	test("inspect view refuses an empty crop and an over-limit edge", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-inspect-"));
		try {
			const input = join(dir, "sprite.png");
			await writeFile(input, makePngBytes());
			const empty = await runCli([
				"inspect",
				input,
				"--mode",
				"view",
				"--json",
				"--crop",
				"color:base:1,2,3,4",
			]);
			expect(empty.code).toBe(2);
			expect(
				(JSON.parse(empty.stdout) as { error: { code: string } }).error.code,
			).toBe("EMPTY_SELECTION");
			const wide = createCanvas(1100, 10);
			addLayer(wide, { id: "base" });
			const widePath = join(dir, "wide.png");
			await writeFile(widePath, encodePng(wide));
			const over = await runCli([
				"inspect",
				widePath,
				"--mode",
				"view",
				"--json",
			]);
			expect(over.code).toBe(5);
			expect(
				(JSON.parse(over.stdout) as { error: { code: string } }).error.code,
			).toBe("RESOURCE_LIMIT_EXCEEDED");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("inspect_asset and feedback over direct handlers", () => {
	test("inspect_asset structure works for .mcpx and raster without writing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-inspect-"));
		try {
			const input = join(dir, "sprite.png");
			await writeFile(input, makePngBytes());
			const mcpxBefore = await readFile(CANONICAL_MCPX);
			const mcpx = await handleInspectAsset({
				inputPath: CANONICAL_MCPX,
				mode: "structure",
			});
			expect(mcpx.isError).not.toBe(true);
			const mcpxJson = JSON.parse(firstText(mcpx)) as {
				layers: Array<{ id: string }>;
				regions: Array<{ id: string }>;
			};
			expect(mcpxJson.layers[0]?.id).toBe("base");
			expect(mcpxJson.regions[0]?.id).toBe("blade");
			const rasterBefore = await readFile(input);
			const raster = await handleInspectAsset({
				inputPath: input,
				mode: "structure",
			});
			expect(raster.isError).not.toBe(true);
			const rasterJson = JSON.parse(firstText(raster)) as {
				layers: Array<{ id: string }>;
				regions: unknown[];
			};
			expect(rasterJson.layers[0]?.id).toBe("base");
			expect(rasterJson.regions).toEqual([]);
			expect(await readFile(CANONICAL_MCPX)).toEqual(mcpxBefore);
			expect(await readFile(input)).toEqual(rasterBefore);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("inspect_asset view returns a standard image block with no embedded duplicate", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-inspect-"));
		try {
			const input = join(dir, "sprite.png");
			await writeFile(input, makePngBytes());
			const result = await handleInspectAsset({
				inputPath: input,
				mode: "view",
			});
			expect(result.isError).not.toBe(true);
			expect(result.content.length).toBe(2);
			const text = JSON.parse(
				(result.content[0] as { text: string }).text ?? "{}",
			) as Record<string, unknown>;
			expect(text.mode).toBe("view");
			expect("pngBase64" in text).toBe(false);
			const image = result.content[1] as {
				type: string;
				data: string;
				mimeType: string;
			};
			expect(image.type).toBe("image");
			expect(image.mimeType).toBe("image/png");
			expect(pngMagic(new Uint8Array(Buffer.from(image.data, "base64")))).toBe(
				true,
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("apply without feedback keeps the exact legacy shape and bytes", async () => {
		const args = {
			sourcePath: SWORD_MCPX,
			operations: [
				{
					type: "setPixel",
					layerId: "base",
					x: 0,
					y: 0,
					color: "#FF0000FF",
				},
			],
		};
		const first = await handleApplyAssetOperations(args);
		const second = await handleApplyAssetOperations(args);
		expect(first.isError).not.toBe(true);
		const one = JSON.parse(firstText(first)) as Record<string, unknown>;
		const two = JSON.parse(firstText(second)) as Record<string, unknown>;
		expect(Object.keys(one)).toEqual([
			"applied",
			"failed",
			"operations",
			"warnings",
			"pngBase64",
			"mcpxText",
		]);
		expect(one).toEqual(two);
		expect("feedback" in one).toBe(false);
	});

	test("apply with feedback full omits pngBase64 and returns an image block", async () => {
		const result = await handleApplyAssetOperations({
			sourcePath: SWORD_MCPX,
			operations: [
				{
					type: "setPixel",
					layerId: "base",
					x: 0,
					y: 0,
					color: "#FF0000FF",
				},
			],
			feedback: { image: "full", diff: "summary" },
		});
		expect(result.isError).not.toBe(true);
		expect(result.content.length).toBe(2);
		const text = JSON.parse(
			(result.content[0] as { text: string }).text ?? "{}",
		) as {
			feedback: {
				image: string;
				imageIncluded: boolean;
				diff: {
					raw: unknown;
					composited: unknown;
					structural: unknown;
					outsideSelectionUnchanged: boolean;
				};
			};
			pngBase64?: unknown;
			mcpxText: unknown;
		};
		expect("pngBase64" in text).toBe(false);
		expect(text.feedback.image).toBe("full");
		expect(text.feedback.imageIncluded).toBe(true);
		expect(typeof text.feedback.diff.outsideSelectionUnchanged).toBe("boolean");
		expect(typeof text.mcpxText).toBe("string");
		const image = result.content[1] as {
			type: string;
			data: string;
			mimeType: string;
		};
		expect(image.type).toBe("image");
		expect(image.mimeType).toBe("image/png");
		expect(pngMagic(new Uint8Array(Buffer.from(image.data, "base64")))).toBe(
			true,
		);
	});

	test("apply with feedback none carries no image block and no pngBase64", async () => {
		const result = await handleApplyAssetOperations({
			sourcePath: SWORD_MCPX,
			operations: [
				{
					type: "setPixel",
					layerId: "base",
					x: 0,
					y: 0,
					color: "#FF0000FF",
				},
			],
			feedback: { image: "none" },
		});
		expect(result.isError).not.toBe(true);
		expect(result.content.length).toBe(1);
		const text = JSON.parse(
			(result.content[0] as { text: string }).text ?? "{}",
		) as { feedback: Record<string, unknown>; pngBase64?: unknown };
		expect(text.feedback).toEqual({ image: "none", imageIncluded: false });
		expect("pngBase64" in text).toBe(false);
	});

	test("apply with feedback changed and no visible change sets flags only", async () => {
		const result = await handleApplyAssetOperations({
			sourcePath: SWORD_MCPX,
			operations: [
				{
					type: "clearPixel",
					layerId: "base",
					x: 0,
					y: 0,
				},
			],
			feedback: { image: "changed", diff: "summary" },
		});
		expect(result.isError).not.toBe(true);
		expect(result.content.length).toBe(1);
		const text = JSON.parse(
			(result.content[0] as { text: string }).text ?? "{}",
		) as {
			feedback: {
				image: string;
				imageIncluded: boolean;
				noVisibleChange: boolean;
				diff: { composited: { changedPixels: number } };
			};
		};
		// sword.mcpx (0,0) is already transparent, so clearing it moves nothing.
		expect(text.feedback.imageIncluded).toBe(false);
		expect(text.feedback.noVisibleChange).toBe(true);
		expect(text.feedback.diff.composited.changedPixels).toBe(0);
	});

	test("inspect view defaults to scale 1 over direct handlers", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-inspect-"));
		try {
			const input = join(dir, "sprite.png");
			await writeFile(input, makePngBytes());
			const result = await handleInspectAsset({
				inputPath: input,
				mode: "view",
			});
			expect(result.isError).not.toBe(true);
			const text = JSON.parse(firstText(result)) as {
				scale: number;
				outputDimensions: { width: number; height: number };
			};
			check.equal(text.scale, 1);
			check.deepEqual(text.outputDimensions, { width: 4, height: 4 });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("schema rejects non-integer and out-of-range scales", async () => {
		const inspectScale = TOOL_INPUT_SCHEMAS.inspect_asset.scale;
		expect(inspectScale.safeParse(1).success).toBe(true);
		expect(inspectScale.safeParse(16).success).toBe(true);
		expect(inspectScale.safeParse(1.5).success).toBe(false);
		expect(inspectScale.safeParse(0).success).toBe(false);
		expect(inspectScale.safeParse(17).success).toBe(false);
		const feedbackShape = TOOL_INPUT_SCHEMAS.apply_asset_operations.feedback;
		expect(feedbackShape.safeParse({ scale: 2 }).success).toBe(true);
		expect(feedbackShape.safeParse({ scale: 1.5 }).success).toBe(false);
		expect(feedbackShape.safeParse({ scale: 0 }).success).toBe(false);
		expect(feedbackShape.safeParse({ scale: 17 }).success).toBe(false);
	});

	test("apply atomic:false partial batch with feedback changed keeps partial success", async () => {
		const operations = [
			{
				type: "setPixel",
				layerId: "base",
				x: 0,
				y: 0,
				color: "#FF0000FF",
			},
			{
				type: "setPixel",
				layerId: "base",
				x: -1,
				y: 0,
				color: "#FF0000FF",
			},
		];
		const result = await handleApplyAssetOperations({
			sourcePath: SWORD_MCPX,
			operations,
			atomic: false,
			feedback: { image: "changed" },
		});
		expect(result.isError).not.toBe(true);
		const text = JSON.parse(firstText(result)) as {
			applied: number;
			failed: number;
			feedback: { image: string; imageIncluded: boolean };
		};
		expect(text.applied).toBe(1);
		expect(text.failed).toBe(1);
		expect(text.feedback.image).toBe("changed");
		expect(text.feedback.imageIncluded).toBe(true);
		expect(result.content.length).toBe(2);
		expect(result.content[1]?.type).toBe("image");
	});

	test("apply atomic:false partial batch with feedback summary keeps counts", async () => {
		const operations = [
			{
				type: "setPixel",
				layerId: "base",
				x: 0,
				y: 0,
				color: "#FF0000FF",
			},
			{
				type: "setPixel",
				layerId: "base",
				x: -1,
				y: 0,
				color: "#FF0000FF",
			},
		];
		const result = await handleApplyAssetOperations({
			sourcePath: SWORD_MCPX,
			operations,
			atomic: false,
			feedback: { diff: "summary" },
		});
		expect(result.isError).not.toBe(true);
		const text = JSON.parse(firstText(result)) as {
			applied: number;
			failed: number;
			feedback: {
				image: string;
				imageIncluded: boolean;
				diff: {
					raw: { changedPixels: number };
					composited: { changedPixels: number };
					outsideSelectionUnchanged: boolean;
				};
			};
		};
		expect(text.applied).toBe(1);
		expect(text.failed).toBe(1);
		expect(text.feedback.diff.raw.changedPixels).toBe(1);
		expect(text.feedback.diff.composited.changedPixels).toBe(1);
		expect(text.feedback.diff.outsideSelectionUnchanged).toBe(true);
	});

	test("apply atomic:false partial batch keeps later ops after a failure", async () => {
		const operations = [
			{
				type: "setPixel",
				layerId: "base",
				x: 0,
				y: 0,
				color: "#FF0000FF",
			},
			{
				type: "setPixel",
				layerId: "base",
				x: -1,
				y: 0,
				color: "#FF0000FF",
			},
			{
				type: "setPixel",
				layerId: "base",
				x: 3,
				y: 3,
				color: "#FF0000FF",
			},
		];
		const result = await handleApplyAssetOperations({
			sourcePath: SWORD_MCPX,
			operations,
			atomic: false,
			feedback: { image: "changed", diff: "summary" },
		});
		expect(result.isError).not.toBe(true);
		const text = JSON.parse(firstText(result)) as {
			applied: number;
			failed: number;
			feedback: { diff: { raw: { changedPixels: number } } };
		};
		expect(text.applied).toBe(2);
		expect(text.failed).toBe(1);
		expect(text.feedback.diff.raw.changedPixels).toBe(2);
	});

	test("apply atomic:false partial batch without feedback stays success", async () => {
		const operations = [
			{
				type: "setPixel",
				layerId: "base",
				x: 0,
				y: 0,
				color: "#FF0000FF",
			},
			{
				type: "setPixel",
				layerId: "base",
				x: -1,
				y: 0,
				color: "#FF0000FF",
			},
		];
		for (const feedback of [
			undefined,
			{ image: "none" },
			{ image: "full" },
		] as const) {
			const result = await handleApplyAssetOperations({
				sourcePath: SWORD_MCPX,
				operations,
				atomic: false,
				...(feedback === undefined ? {} : { feedback }),
			});
			expect(result.isError).not.toBe(true);
			const text = JSON.parse(firstText(result)) as {
				applied: number;
				failed: number;
			};
			expect(text.applied).toBe(1);
			expect(text.failed).toBe(1);
		}
	});

	test("apply atomic:true with a failing op still rolls back as an error", async () => {
		const operations = [
			{
				type: "setPixel",
				layerId: "base",
				x: 0,
				y: 0,
				color: "#FF0000FF",
			},
			{
				type: "setPixel",
				layerId: "base",
				x: -1,
				y: 0,
				color: "#FF0000FF",
			},
		];
		const result = await handleApplyAssetOperations({
			sourcePath: SWORD_MCPX,
			operations,
			atomic: true,
		});
		expect(result.isError).toBe(true);
		expect((JSON.parse(firstText(result)) as { code: string }).code).toBe(
			"OUT_OF_BOUNDS",
		);
	});
});

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

describe("invalid feedback writes no output artifacts", () => {
	test("crop with none leaves output paths untouched", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-inspect-"));
		try {
			const outPng = join(dir, "out.png");
			const outMcpx = join(dir, "out.mcpx");
			const result = await handleApplyAssetOperations({
				sourcePath: SWORD_MCPX,
				operations: [
					{
						type: "setPixel",
						layerId: "base",
						x: 0,
						y: 0,
						color: "#FF0000FF",
					},
				],
				outputPngPath: outPng,
				outputMcpxPath: outMcpx,
				feedback: { crop: "rect:0,0,1,1" },
			});
			expect(result.isError).toBe(true);
			const json = JSON.parse(firstText(result)) as { code: string };
			expect(json.code).toBe("INVALID_ARGUMENT");
			expect(await pathExists(outPng)).toBe(false);
			expect(await pathExists(outMcpx)).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("empty crop leaves output paths untouched", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-inspect-"));
		try {
			const outPng = join(dir, "out.png");
			const outMcpx = join(dir, "out.mcpx");
			const result = await handleApplyAssetOperations({
				sourcePath: SWORD_MCPX,
				operations: [
					{
						type: "setPixel",
						layerId: "base",
						x: 0,
						y: 0,
						color: "#FF0000FF",
					},
				],
				outputPngPath: outPng,
				outputMcpxPath: outMcpx,
				feedback: { image: "full", crop: "color:base:1,2,3,4" },
			});
			expect(result.isError).toBe(true);
			const json = JSON.parse(firstText(result)) as { code: string };
			expect(json.code).toBe("EMPTY_SELECTION");
			expect(await pathExists(outPng)).toBe(false);
			expect(await pathExists(outMcpx)).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("oversized full and changed responses leave output paths untouched", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-inspect-"));
		try {
			const wide = createCanvas(1100, 10);
			addLayer(wide, { id: "base" });
			const source = join(dir, "wide.mcpx");
			await writeFile(
				source,
				ensureMcpxText(wide, () => undefined),
			);
			const setOp = {
				type: "setPixel",
				layerId: "base",
				x: 0,
				y: 0,
				color: "#FF0000FF",
			};
			const fullPng = join(dir, "full.png");
			const full = await handleApplyAssetOperations({
				sourcePath: source,
				operations: [setOp],
				outputPngPath: fullPng,
				feedback: { image: "full" },
			});
			expect(full.isError).toBe(true);
			expect((JSON.parse(firstText(full)) as { code: string }).code).toBe(
				"RESOURCE_LIMIT_EXCEEDED",
			);
			expect(await pathExists(fullPng)).toBe(false);
			const changedMcpx = join(dir, "changed.mcpx");
			const changed = await handleApplyAssetOperations({
				sourcePath: source,
				operations: [
					{ type: "fillLayer", layerId: "base", color: "#FF0000FF" },
				],
				outputMcpxPath: changedMcpx,
				feedback: { image: "changed" },
			});
			expect(changed.isError).toBe(true);
			expect((JSON.parse(firstText(changed)) as { code: string }).code).toBe(
				"RESOURCE_LIMIT_EXCEEDED",
			);
			expect(await pathExists(changedMcpx)).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
