import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMcpxText } from "../../src/cli/artifacts.ts";
import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../src/core/canvas.ts";
import type { RGBA } from "../../src/core/types.ts";
import { decodePng } from "../../src/io/png.ts";
import { parseMcpx } from "../../src/mcpx/index.ts";

/**
 * animate spawn coverage: pack / unpack / reorder / resize / validate /
 * preview over runtime-built frames directories (no Mojang assets).
 * Frames are small solid 4x4 canvases serialized with the frozen .mcpx
 * pipeline, so every byte on disk comes from this repo.
 */

interface SpawnResult {
	code: number;
	stdout: Uint8Array;
	stderr: string;
}

interface JsonEnvelope {
	success: boolean;
	result?: Record<string, unknown>;
	error?: { code?: string; message?: string; details?: unknown };
}

function stdoutText(result: SpawnResult): string {
	return Buffer.from(result.stdout).toString("utf-8");
}

function parseJsonStdout(result: SpawnResult): JsonEnvelope {
	return JSON.parse(stdoutText(result)) as JsonEnvelope;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function mustResult(body: JsonEnvelope): Record<string, unknown> {
	const result = body.result as Record<string, unknown> | undefined;
	if (result === undefined) {
		throw new Error("expected a success envelope with a result");
	}
	return result;
}

function mustError(body: JsonEnvelope): { code?: string; details?: unknown } {
	if (body.error === undefined) {
		throw new Error("expected an error envelope");
	}
	return body.error;
}

function errorDetail(body: JsonEnvelope, key: string): unknown {
	const details = mustError(body).details as Record<string, unknown>;
	return details[key];
}

async function runCli(args: string[]): Promise<SpawnResult> {
	const proc = Bun.spawn(["bun", "src/cli/index.ts", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout: new Uint8Array(stdout), stderr };
}

async function listAllFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { recursive: true });
	return [...entries].sort();
}

function frameMcpx(color: RGBA, width = 4, height = 4): string {
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: "base" });
	const pixels = new Uint8Array(width * height * 4);
	for (let i = 0; i < pixels.length; i += 4) {
		pixels[i] = color.r;
		pixels[i + 1] = color.g;
		pixels[i + 2] = color.b;
		pixels[i + 3] = color.a;
	}
	replaceLayerPixels(canvas, layer.id, pixels);
	return ensureMcpxText(canvas, () => {});
}

async function writeFramesDir(
	parent: string,
	name: string,
	colors: RGBA[],
): Promise<string> {
	const dir = join(parent, name);
	await mkdir(dir, { recursive: true });
	for (let i = 0; i < colors.length; i += 1) {
		const color = colors[i] as RGBA;
		await writeFile(join(dir, `frame_${i}.mcpx`), frameMcpx(color));
	}
	return dir;
}

const RED: RGBA = { r: 255, g: 0, b: 0, a: 255 };
const GREEN: RGBA = { r: 0, g: 255, b: 0, a: 255 };
const BLUE: RGBA = { r: 0, g: 0, b: 255, a: 255 };

function headPixelOfMcpx(text: string): number[] {
	const canvas = parseMcpx(text);
	const layer = canvas.layers[0];
	if (layer === undefined) {
		throw new Error("frame needs one layer");
	}
	return [...layer.pixels.slice(0, 4)];
}

describe("animate wiring via spawn", () => {
	test("pack vertical produces the stacked sheet and reruns byte-identical", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-animate-"));
		try {
			const framesDir = await writeFramesDir(dir, "frames", [RED, GREEN]);
			const out = join(dir, "sheet.png");
			const result = await runCli([
				"animate",
				"pack",
				"--frames-dir",
				framesDir,
				"--layout",
				"vertical",
				"--output",
				out,
			]);
			expect(result.code).toBe(0);
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(decoded.canvas.width).toBe(4);
			expect(decoded.canvas.height).toBe(8);
			const again = join(dir, "sheet-again.png");
			expect(
				(
					await runCli([
						"animate",
						"pack",
						"--frames-dir",
						framesDir,
						"--layout",
						"vertical",
						"--output",
						again,
					])
				).code,
			).toBe(0);
			expect(sha256(new Uint8Array(await readFile(out)))).toBe(
				sha256(new Uint8Array(await readFile(again))),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("pack grid leaves the empty cell transparent", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-animate-"));
		try {
			const framesDir = await writeFramesDir(dir, "frames", [RED, GREEN, BLUE]);
			const out = join(dir, "grid.png");
			const result = await runCli([
				"animate",
				"pack",
				"--frames-dir",
				framesDir,
				"--layout",
				"grid",
				"--columns",
				"2",
				"--output",
				out,
			]);
			expect(result.code).toBe(0);
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(decoded.canvas.width).toBe(8);
			expect(decoded.canvas.height).toBe(8);
			const pixels = decoded.canvas.layers[0]?.pixels ?? new Uint8Array();
			const at = (x: number, y: number): number[] => [
				...pixels.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 4),
			];
			expect(at(0, 0)).toEqual([255, 0, 0, 255]);
			expect(at(4, 0)).toEqual([0, 255, 0, 255]);
			expect(at(0, 4)).toEqual([0, 0, 255, 255]);
			expect(at(4, 4)).toEqual([0, 0, 0, 0]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("pack requires --layout and grid requires --columns", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-animate-"));
		try {
			const framesDir = await writeFramesDir(dir, "frames", [RED]);
			const noLayout = await runCli([
				"--json",
				"animate",
				"pack",
				"--frames-dir",
				framesDir,
				"--output",
				join(dir, "out.png"),
			]);
			expect(noLayout.code).toBe(2);
			expect(mustError(parseJsonStdout(noLayout)).code).toBe(
				"INVALID_ARGUMENT",
			);
			const noColumns = await runCli([
				"--json",
				"animate",
				"pack",
				"--frames-dir",
				framesDir,
				"--layout",
				"grid",
				"--output",
				join(dir, "out.png"),
			]);
			expect(noColumns.code).toBe(2);
			expect(mustError(parseJsonStdout(noColumns)).code).toBe(
				"INVALID_ARGUMENT",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("pack without output is OUTPUT_REQUIRED with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-animate-"));
		try {
			const framesDir = await writeFramesDir(dir, "frames", [RED]);
			const before = await listAllFiles(dir);
			const result = await runCli([
				"--json",
				"animate",
				"pack",
				"--frames-dir",
				framesDir,
				"--layout",
				"vertical",
			]);
			expect(result.code).toBe(2);
			expect(mustError(parseJsonStdout(result)).code).toBe("OUTPUT_REQUIRED");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("pack guards OUTPUT_EXISTS force and mkdir", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-animate-"));
		try {
			const framesDir = await writeFramesDir(dir, "frames", [RED]);
			const out = join(dir, "sheet.png");
			expect(
				(
					await runCli([
						"animate",
						"pack",
						"--frames-dir",
						framesDir,
						"--layout",
						"vertical",
						"--output",
						out,
					])
				).code,
			).toBe(0);
			const clash = await runCli([
				"--json",
				"animate",
				"pack",
				"--frames-dir",
				framesDir,
				"--layout",
				"vertical",
				"--output",
				out,
			]);
			expect(clash.code).toBe(4);
			expect(mustError(parseJsonStdout(clash)).code).toBe("OUTPUT_EXISTS");
			expect(
				(
					await runCli([
						"animate",
						"pack",
						"--frames-dir",
						framesDir,
						"--layout",
						"vertical",
						"--output",
						out,
						"--force",
					])
				).code,
			).toBe(0);
			const nested = join(dir, "missing", "sheet.png");
			const noMkdir = await runCli([
				"--json",
				"animate",
				"pack",
				"--frames-dir",
				framesDir,
				"--layout",
				"vertical",
				"--output",
				nested,
			]);
			expect(noMkdir.code).toBe(4);
			expect(mustError(parseJsonStdout(noMkdir)).code).toBe("FILESYSTEM_ERROR");
			expect(
				(
					await runCli([
						"animate",
						"pack",
						"--frames-dir",
						framesDir,
						"--layout",
						"vertical",
						"--output",
						nested,
						"--mkdir",
					])
				).code,
			).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 90_000);

	test("pack --stdout carries PNG bytes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-animate-"));
		try {
			const framesDir = await writeFramesDir(dir, "frames", [RED, GREEN]);
			const result = await runCli([
				"animate",
				"pack",
				"--frames-dir",
				framesDir,
				"--layout",
				"horizontal",
				"--stdout",
			]);
			expect(result.code).toBe(0);
			const decoded = decodePng(result.stdout);
			expect(decoded.canvas.width).toBe(8);
			expect(decoded.canvas.height).toBe(4);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("unpack round-trips to a byte-identical sheet", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-animate-"));
		try {
			const framesDir = await writeFramesDir(dir, "frames", [RED, GREEN, BLUE]);
			const sheet = join(dir, "sheet.png");
			expect(
				(
					await runCli([
						"animate",
						"pack",
						"--frames-dir",
						framesDir,
						"--layout",
						"vertical",
						"--output",
						sheet,
					])
				).code,
			).toBe(0);
			const outDir = join(dir, "unpacked");
			const unpacked = await runCli([
				"animate",
				"unpack",
				sheet,
				"--layout",
				"vertical",
				"--frame-size",
				"4x4",
				"--output-dir",
				outDir,
				"--mkdir",
			]);
			expect(unpacked.code).toBe(0);
			expect(await listAllFiles(outDir)).toEqual([
				"frame_0.mcpx",
				"frame_1.mcpx",
				"frame_2.mcpx",
			]);
			const repacked = join(dir, "repacked.png");
			expect(
				(
					await runCli([
						"animate",
						"pack",
						"--frames-dir",
						outDir,
						"--layout",
						"vertical",
						"--output",
						repacked,
					])
				).code,
			).toBe(0);
			expect(sha256(new Uint8Array(await readFile(sheet)))).toBe(
				sha256(new Uint8Array(await readFile(repacked))),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 90_000);

	test("unpack pads frame names to the count width", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-animate-"));
		try {
			const colors: RGBA[] = [];
			for (let i = 0; i < 12; i += 1) {
				colors.push({ r: i * 20, g: 0, b: 0, a: 255 });
			}
			const framesDir = await writeFramesDir(dir, "frames", colors);
			const sheet = join(dir, "sheet.png");
			expect(
				(
					await runCli([
						"animate",
						"pack",
						"--frames-dir",
						framesDir,
						"--layout",
						"vertical",
						"--output",
						sheet,
					])
				).code,
			).toBe(0);
			const outDir = join(dir, "unpacked");
			expect(
				(
					await runCli([
						"animate",
						"unpack",
						sheet,
						"--layout",
						"vertical",
						"--frame-size",
						"4x4",
						"--output-dir",
						outDir,
						"--mkdir",
					])
				).code,
			).toBe(0);
			const files = await listAllFiles(outDir);
			expect(files[0]).toBe("frame_00.mcpx");
			expect(files[files.length - 1]).toBe("frame_11.mcpx");
			expect(files).toHaveLength(12);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 90_000);

	test("unpack rejects indivisible sheets with layout details", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-animate-"));
		try {
			const framesDir = await writeFramesDir(dir, "frames", [RED]);
			const sheet = join(dir, "sheet.png");
			expect(
				(
					await runCli([
						"animate",
						"pack",
						"--frames-dir",
						framesDir,
						"--layout",
						"vertical",
						"--output",
						sheet,
					])
				).code,
			).toBe(0);
			const bad = await runCli([
				"--json",
				"animate",
				"unpack",
				sheet,
				"--layout",
				"vertical",
				"--frame-size",
				"3x3",
				"--output-dir",
				join(dir, "bad"),
			]);
			expect(bad.code).toBe(2);
			const body = parseJsonStdout(bad);
			expect(mustError(body).code).toBe("INVALID_ANIMATION_FRAME");
			expect(errorDetail(body, "layout")).toBe("vertical");
			const gridBad = await runCli([
				"--json",
				"animate",
				"unpack",
				sheet,
				"--layout",
				"grid",
				"--frame-size",
				"4x4",
				"--columns",
				"3",
				"--output-dir",
				join(dir, "bad-grid"),
			]);
			expect(gridBad.code).toBe(2);
			expect(mustError(parseJsonStdout(gridBad)).code).toBe(
				"INVALID_ANIMATION_FRAME",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 90_000);

	test("unpack without --output-dir writes nothing and --output conflicts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-animate-"));
		try {
			const framesDir = await writeFramesDir(dir, "frames", [RED]);
			const sheet = join(dir, "sheet.png");
			expect(
				(
					await runCli([
						"animate",
						"pack",
						"--frames-dir",
						framesDir,
						"--layout",
						"vertical",
						"--output",
						sheet,
					])
				).code,
			).toBe(0);
			const before = await listAllFiles(dir);
			const missing = await runCli([
				"--json",
				"animate",
				"unpack",
				sheet,
				"--layout",
				"vertical",
				"--frame-size",
				"4x4",
			]);
			expect(missing.code).toBe(2);
			expect(mustError(parseJsonStdout(missing)).code).toBe("OUTPUT_REQUIRED");
			expect(await listAllFiles(dir)).toEqual(before);
			const conflict = await runCli([
				"--json",
				"animate",
				"unpack",
				sheet,
				"--layout",
				"vertical",
				"--frame-size",
				"4x4",
				"--output",
				join(dir, "x.png"),
				"--output-dir",
				join(dir, "out"),
			]);
			expect(conflict.code).toBe(2);
			expect(mustError(parseJsonStdout(conflict)).code).toBe(
				"ARGUMENT_CONFLICT",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 90_000);

	test("reorder permutes frames with unchanged pixels", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-animate-"));
		try {
			const framesDir = await writeFramesDir(dir, "frames", [RED, GREEN, BLUE]);
			const outDir = join(dir, "reordered");
			const result = await runCli([
				"animate",
				"reorder",
				"--frames-dir",
				framesDir,
				"--order",
				"2,0,1",
				"--output-dir",
				outDir,
				"--mkdir",
			]);
			expect(result.code).toBe(0);
			expect(await listAllFiles(outDir)).toEqual([
				"frame_0.mcpx",
				"frame_1.mcpx",
				"frame_2.mcpx",
			]);
			const heads = await Promise.all(
				[0, 1, 2].map((i) =>
					readFile(join(outDir, `frame_${i}.mcpx`), "utf-8").then(
						headPixelOfMcpx,
					),
				),
			);
			expect(heads[0]).toEqual([0, 0, 255, 255]);
			expect(heads[1]).toEqual([255, 0, 0, 255]);
			expect(heads[2]).toEqual([0, 255, 0, 255]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 90_000);

	test("reorder rejects duplicate and out-of-range orders", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-animate-"));
		try {
			const framesDir = await writeFramesDir(dir, "frames", [RED, GREEN]);
			for (const order of ["0,0", "0,5", "0"]) {
				const result = await runCli([
					"--json",
					"animate",
					"reorder",
					"--frames-dir",
					framesDir,
					"--order",
					order,
					"--output-dir",
					join(dir, `out-${order.replace(/,/g, "-")}`),
				]);
				expect(result.code).toBe(2);
				expect(mustError(parseJsonStdout(result)).code).toBe(
					"INVALID_ARGUMENT",
				);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 90_000);

	test("resize nearest keeps the palette and updates dimensions", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-animate-"));
		try {
			const framesDir = await writeFramesDir(dir, "frames", [RED, GREEN]);
			const outDir = join(dir, "resized");
			const result = await runCli([
				"animate",
				"resize",
				"--frames-dir",
				framesDir,
				"--frame-size",
				"8x8",
				"--output-dir",
				outDir,
				"--mkdir",
			]);
			expect(result.code).toBe(0);
			for (const name of ["frame_0.mcpx", "frame_1.mcpx"]) {
				const canvas = parseMcpx(await readFile(join(outDir, name), "utf-8"));
				expect(canvas.width).toBe(8);
				expect(canvas.height).toBe(8);
			}
			const boxDir = join(dir, "boxed");
			expect(
				(
					await runCli([
						"animate",
						"resize",
						"--frames-dir",
						framesDir,
						"--frame-size",
						"2x2",
						"--resize-mode",
						"box",
						"--output-dir",
						boxDir,
						"--mkdir",
					])
				).code,
			).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 90_000);

	test("resize pixel-aware is refused with zero writes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-animate-"));
		try {
			const framesDir = await writeFramesDir(dir, "frames", [RED]);
			const before = await listAllFiles(dir);
			const result = await runCli([
				"--json",
				"animate",
				"resize",
				"--frames-dir",
				framesDir,
				"--frame-size",
				"8x8",
				"--resize-mode",
				"pixel-aware",
				"--output-dir",
				join(dir, "resized"),
			]);
			expect(result.code).toBe(2);
			expect(mustError(parseJsonStdout(result)).code).toBe("INVALID_ARGUMENT");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("validate passes a sound set with a deterministic report", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-animate-"));
		try {
			const framesDir = await writeFramesDir(dir, "frames", [RED, GREEN]);
			const first = await runCli([
				"--json",
				"animate",
				"validate",
				"--frames-dir",
				framesDir,
			]);
			expect(first.code).toBe(0);
			const body = parseJsonStdout(first);
			expect(body.success).toBe(true);
			expect(mustResult(body).verdict).toBe("pass");
			expect(mustResult(body).frameCount).toBe(2);
			const second = await runCli([
				"--json",
				"animate",
				"validate",
				"--frames-dir",
				framesDir,
			]);
			expect(sha256(second.stdout)).toBe(sha256(first.stdout));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("validate rejects mismatched geometry with the frame index", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-animate-"));
		try {
			const framesDir = join(dir, "frames");
			await mkdir(framesDir, { recursive: true });
			await writeFile(join(framesDir, "frame_0.mcpx"), frameMcpx(RED, 4, 4));
			await writeFile(join(framesDir, "frame_1.mcpx"), frameMcpx(GREEN, 6, 4));
			const result = await runCli([
				"--json",
				"animate",
				"validate",
				"--frames-dir",
				framesDir,
			]);
			expect(result.code).toBe(2);
			const body = parseJsonStdout(result);
			expect(mustError(body).code).toBe("INVALID_ANIMATION_FRAME");
			expect(errorDetail(body, "index")).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("preview reports structure without writing files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-animate-"));
		try {
			const framesDir = await writeFramesDir(dir, "frames", [RED, GREEN]);
			const before = await listAllFiles(dir);
			const result = await runCli([
				"--json",
				"animate",
				"preview",
				"--frames-dir",
				framesDir,
				"--layout",
				"horizontal",
			]);
			expect(result.code).toBe(0);
			const body = parseJsonStdout(result);
			expect(mustResult(body).frameCount).toBe(2);
			expect(mustResult(body).layout).toBe("horizontal");
			expect(mustResult(body).sheetWidth).toBe(8);
			expect(mustResult(body).sheetHeight).toBe(4);
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("preview --ascii feeds render with identical sheet pixels", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-animate-"));
		try {
			const framesDir = await writeFramesDir(dir, "frames", [RED, GREEN]);
			const ascii = await runCli([
				"animate",
				"preview",
				"--frames-dir",
				framesDir,
				"--layout",
				"vertical",
				"--ascii",
			]);
			expect(ascii.code).toBe(0);
			const gridPath = join(dir, "preview.grid");
			await writeFile(gridPath, Buffer.from(ascii.stdout));
			const out = join(dir, "sheet.png");
			expect((await runCli(["render", gridPath, "--output", out])).code).toBe(
				0,
			);
			const packed = join(dir, "packed.png");
			expect(
				(
					await runCli([
						"animate",
						"pack",
						"--frames-dir",
						framesDir,
						"--layout",
						"vertical",
						"--output",
						packed,
					])
				).code,
			).toBe(0);
			const want = decodePng(new Uint8Array(await readFile(packed)));
			const got = decodePng(new Uint8Array(await readFile(out)));
			expect(got.canvas.width).toBe(want.canvas.width);
			expect(got.canvas.height).toBe(want.canvas.height);
			expect(Buffer.from(got.canvas.layers[0]?.pixels ?? [])).toEqual(
				Buffer.from(want.canvas.layers[0]?.pixels ?? []),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 90_000);

	test("non-mcpx files are ignored with a warning", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-animate-"));
		try {
			const framesDir = await writeFramesDir(dir, "frames", [RED, GREEN]);
			await writeFile(join(framesDir, "notes.txt"), "not a frame\n");
			const result = await runCli([
				"--json",
				"animate",
				"validate",
				"--frames-dir",
				framesDir,
			]);
			expect(result.code).toBe(0);
			const body = parseJsonStdout(result);
			expect(mustResult(body).frameCount).toBe(2);
			const warnings = mustResult(body).warnings as Array<{
				code: string;
			}>;
			expect(warnings.some((w) => w.code === "NON_MCPX_IGNORED")).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("--mcmeta is a declared read-only option on animate validate", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-animate-"));
		try {
			const framesDir = await writeFramesDir(dir, "frames", [RED]);
			const missing = join(dir, "missing.mcmeta");
			const result = await runCli([
				"--json",
				"animate",
				"validate",
				"--frames-dir",
				framesDir,
				"--mcmeta",
				missing,
			]);
			expect(result.code).toBe(4);
			expect(mustError(parseJsonStdout(result)).code).toBe("FILESYSTEM_ERROR");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
