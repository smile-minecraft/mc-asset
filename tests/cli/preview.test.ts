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
import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../src/core/canvas.ts";
import { decodeImage } from "../../src/io/decode.ts";
import { decodePng, encodePng } from "../../src/io/png.ts";

/**
 * preview spawn coverage. Inputs are generated at runtime with the frozen
 * PNG codec (no Mojang assets): a 2x2 black/white checker matching the
 * v03 worked example, plus the shared 8x8 fixtures for multi-format
 * intake. The .mcpx case reuses tests/cli/fixtures/sword.mcpx.
 */

const FIXTURES = "tests/cli/fixtures";
const SWORD_MCPX = join(FIXTURES, "sword.mcpx");
const PNG_8 = join(FIXTURES, "px-8x8.png");
const JPG_8 = join(FIXTURES, "px-8x8.jpg");
const WEBP_8 = join(FIXTURES, "px-lossless.webp");

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

function pngBytesFor(
	width: number,
	height: number,
	pixel: (
		x: number,
		y: number,
	) => {
		r: number;
		g: number;
		b: number;
		a: number;
	},
): Uint8Array {
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: "base" });
	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const color = pixel(x, y);
			const offset = (y * width + x) * 4;
			pixels[offset] = color.r;
			pixels[offset + 1] = color.g;
			pixels[offset + 2] = color.b;
			pixels[offset + 3] = color.a;
		}
	}
	replaceLayerPixels(canvas, layer.id, pixels);
	return encodePng(canvas);
}

const B = { r: 0, g: 0, b: 0, a: 255 };
const W = { r: 255, g: 255, b: 255, a: 255 };
const T = { r: 0, g: 0, b: 0, a: 0 };

async function writeChecker(dir: string): Promise<string> {
	const path = join(dir, "checker.png");
	await writeFile(
		path,
		pngBytesFor(2, 2, (x) => (x === 0 ? B : W)),
	);
	return path;
}

async function writeTransparent(dir: string): Promise<string> {
	const path = join(dir, "alpha.png");
	await writeFile(
		path,
		pngBytesFor(2, 1, (x) => (x === 0 ? T : B)),
	);
	return path;
}

describe("preview wiring via spawn", () => {
	test("no mode is INVALID_ARGUMENT", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-preview-"));
		try {
			const input = await writeChecker(dir);
			const result = await runCli(["--json", "preview", input]);
			expect(result.code).toBe(2);
			expect(parseJsonStdout(result).error?.code).toBe("INVALID_ARGUMENT");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--ascii with --scale is ARGUMENT_CONFLICT", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-preview-"));
		try {
			const input = await writeChecker(dir);
			const result = await runCli([
				"--json",
				"preview",
				input,
				"--ascii",
				"--scale",
				"2",
			]);
			expect(result.code).toBe(2);
			expect(parseJsonStdout(result).error?.code).toBe("ARGUMENT_CONFLICT");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--ascii prints the frozen .grid document", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-preview-"));
		try {
			const input = await writeChecker(dir);
			const result = await runCli(["preview", input, "--ascii"]);
			expect(result.code).toBe(0);
			expect(stdoutText(result)).toBe(
				"[palette]\n0 = #000000FF\n1 = #FFFFFFFF\n\n[grid]\n01\n01\n",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--ascii output feeds render with identical pixels", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-preview-"));
		try {
			const input = await writeChecker(dir);
			const ascii = await runCli(["preview", input, "--ascii"]);
			expect(ascii.code).toBe(0);
			const gridPath = join(dir, "preview.grid");
			await writeFile(gridPath, Buffer.from(ascii.stdout));
			const out = join(dir, "roundtrip.png");
			const rendered = await runCli(["render", gridPath, "--output", out]);
			expect(rendered.code).toBe(0);
			const want = decodePng(new Uint8Array(await readFile(input)));
			const got = decodePng(new Uint8Array(await readFile(out)));
			expect(got.canvas.width).toBe(want.canvas.width);
			expect(got.canvas.height).toBe(want.canvas.height);
			expect(Buffer.from(got.canvas.layers[0]?.pixels ?? [])).toEqual(
				Buffer.from(want.canvas.layers[0]?.pixels ?? []),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--ascii --json shape carries ascii lines palette and size", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-preview-"));
		try {
			const input = await writeChecker(dir);
			const result = await runCli(["--json", "preview", input, "--ascii"]);
			expect(result.code).toBe(0);
			const body = parseJsonStdout(result);
			expect(body.success).toBe(true);
			const preview = body.result as {
				command: string;
				mode: string;
				width: number;
				height: number;
				ascii: string[];
				palette: Record<string, string>;
			};
			expect(preview.command).toBe("preview");
			expect(preview.mode).toBe("ascii");
			expect(preview.width).toBe(2);
			expect(preview.height).toBe(2);
			expect(preview.ascii).toEqual([
				"[palette]",
				"0 = #000000FF",
				"1 = #FFFFFFFF",
				"",
				"[grid]",
				"01",
				"01",
			]);
			expect(preview.palette).toEqual({
				"0": "#000000FF",
				"1": "#FFFFFFFF",
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--ascii on .mcpx keeps the existing symbols", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-preview-"));
		try {
			const result = await runCli(["preview", SWORD_MCPX, "--ascii"]);
			expect(result.code).toBe(0);
			expect(stdoutText(result)).toBe(
				"[palette]\n. = #00000000\nR = #FF0000FF\nG = #00FF00FF\n\n[grid]\n.RR.\nRGGR\nRGGR\n.RR.\n",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--ascii maps transparent to the reserved dot", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-preview-"));
		try {
			const input = await writeTransparent(dir);
			const result = await runCli(["preview", input, "--ascii"]);
			expect(result.code).toBe(0);
			expect(stdoutText(result)).toBe(
				"[palette]\n. = #00000000\n0 = #000000FF\n\n[grid]\n.0\n",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--palette-map matches the frozen shape", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-preview-"));
		try {
			const input = await writeChecker(dir);
			const result = await runCli([
				"--json",
				"preview",
				input,
				"--palette-map",
			]);
			expect(result.code).toBe(0);
			const body = parseJsonStdout(result);
			const preview = body.result as {
				command: string;
				mode: string;
				profile: string;
				width: number;
				height: number;
				colors: Array<{ index: number; color: string; count: number }>;
				rows: number[][];
			};
			expect(preview.command).toBe("preview");
			expect(preview.mode).toBe("palette-map");
			expect(preview.profile).toBe("generic");
			expect(preview.width).toBe(2);
			expect(preview.height).toBe(2);
			expect(preview.colors).toEqual([
				{ index: 0, color: "#000000FF", count: 2 },
				{ index: 1, color: "#FFFFFFFF", count: 2 },
			]);
			expect(preview.rows).toEqual([
				[0, 1],
				[0, 1],
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--scale 2 writes W*2 by H*2 nearest blocks", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-preview-"));
		try {
			const input = await writeChecker(dir);
			const out = join(dir, "scaled.png");
			const result = await runCli([
				"preview",
				input,
				"--scale",
				"2",
				"--output",
				out,
			]);
			expect(result.code).toBe(0);
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(decoded.canvas.width).toBe(4);
			expect(decoded.canvas.height).toBe(4);
			const pixels = decoded.canvas.layers[0]?.pixels ?? new Uint8Array();
			const at = (x: number, y: number): number[] => [
				...pixels.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4),
			];
			// Nearest: each source pixel becomes one 2x2 block.
			expect(at(0, 0)).toEqual([0, 0, 0, 255]);
			expect(at(1, 1)).toEqual([0, 0, 0, 255]);
			expect(at(2, 0)).toEqual([255, 255, 255, 255]);
			expect(at(3, 3)).toEqual([255, 255, 255, 255]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--scale without output is OUTPUT_REQUIRED with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-preview-"));
		try {
			const input = await writeChecker(dir);
			const before = await listAllFiles(dir);
			const result = await runCli(["--json", "preview", input, "--scale", "2"]);
			expect(result.code).toBe(2);
			expect(parseJsonStdout(result).error?.code).toBe("OUTPUT_REQUIRED");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--scale rejects non-integer and over-limit sizes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-preview-"));
		try {
			const input = await writeChecker(dir);
			const fractional = await runCli([
				"--json",
				"preview",
				input,
				"--scale",
				"1.5",
				"--output",
				join(dir, "nope.png"),
			]);
			expect(fractional.code).toBe(2);
			expect(parseJsonStdout(fractional).error?.code).toBe("INVALID_ARGUMENT");
			const huge = await runCli([
				"--json",
				"preview",
				input,
				"--scale",
				"2049",
				"--output",
				join(dir, "huge.png"),
			]);
			expect(huge.code).toBe(2);
			expect(parseJsonStdout(huge).error?.code).toBe("INVALID_DIMENSION");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("report modes reject file flags", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-preview-"));
		try {
			const input = await writeChecker(dir);
			const asciiFile = await runCli([
				"--json",
				"preview",
				input,
				"--ascii",
				"--output",
				join(dir, "ascii.txt"),
			]);
			expect(asciiFile.code).toBe(2);
			expect(parseJsonStdout(asciiFile).error?.code).toBe("INVALID_ARGUMENT");
			const asciiStdout = await runCli([
				"--json",
				"preview",
				input,
				"--ascii",
				"--stdout",
			]);
			expect(asciiStdout.code).toBe(2);
			expect(parseJsonStdout(asciiStdout).error?.code).toBe("INVALID_ARGUMENT");
			const mapFile = await runCli([
				"--json",
				"preview",
				input,
				"--palette-map",
				"--output",
				join(dir, "map.json"),
			]);
			expect(mapFile.code).toBe(2);
			expect(parseJsonStdout(mapFile).error?.code).toBe("INVALID_ARGUMENT");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--in-place --source and tile --preview stay undeclared", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-preview-"));
		try {
			const input = await writeChecker(dir);
			expect(
				(await runCli(["preview", input, "--ascii", "--in-place"])).code,
			).toBe(2);
			expect(
				(
					await runCli([
						"preview",
						input,
						"--ascii",
						"--source",
						join(dir, "x.mcpx"),
					])
				).code,
			).toBe(2);
			expect((await runCli(["preview", input, "--preview", "4x4"])).code).toBe(
				2,
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("PNG JPEG and WebP all enter preview", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-preview-"));
		try {
			for (const fixture of [PNG_8, JPG_8, WEBP_8]) {
				const decoded = await decodeImage(
					new Uint8Array(await readFile(fixture)),
				);
				const result = await runCli([
					"--json",
					"preview",
					fixture,
					"--palette-map",
				]);
				expect(result.code).toBe(0);
				const body = parseJsonStdout(result);
				const preview = body.result as { width: number; height: number };
				expect(preview.width).toBe(decoded.width);
				expect(preview.height).toBe(decoded.height);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("reruns are byte-identical and inputs stay untouched", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-preview-"));
		try {
			const input = await writeChecker(dir);
			const inputHash = sha256(new Uint8Array(await readFile(input)));
			const firstAscii = await runCli(["preview", input, "--ascii"]);
			const secondAscii = await runCli(["preview", input, "--ascii"]);
			expect(firstAscii.code).toBe(0);
			expect(sha256(firstAscii.stdout)).toBe(sha256(secondAscii.stdout));
			const firstMap = await runCli([
				"--json",
				"preview",
				input,
				"--palette-map",
			]);
			const secondMap = await runCli([
				"--json",
				"preview",
				input,
				"--palette-map",
			]);
			expect(sha256(firstMap.stdout)).toBe(sha256(secondMap.stdout));
			const firstOut = join(dir, "first.png");
			const secondOut = join(dir, "second.png");
			expect(
				(await runCli(["preview", input, "--scale", "2", "--output", firstOut]))
					.code,
			).toBe(0);
			expect(
				(
					await runCli([
						"preview",
						input,
						"--scale",
						"2",
						"--output",
						secondOut,
					])
				).code,
			).toBe(0);
			expect(sha256(new Uint8Array(await readFile(firstOut)))).toBe(
				sha256(new Uint8Array(await readFile(secondOut))),
			);
			expect(sha256(new Uint8Array(await readFile(input)))).toBe(inputHash);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("--scale guards OUTPUT_EXISTS force and mkdir", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-preview-"));
		try {
			const input = await writeChecker(dir);
			const out = join(dir, "scaled.png");
			expect(
				(await runCli(["preview", input, "--scale", "2", "--output", out]))
					.code,
			).toBe(0);
			const clash = await runCli([
				"--json",
				"preview",
				input,
				"--scale",
				"2",
				"--output",
				out,
			]);
			expect(clash.code).toBe(4);
			expect(parseJsonStdout(clash).error?.code).toBe("OUTPUT_EXISTS");
			expect(
				(
					await runCli([
						"preview",
						input,
						"--scale",
						"2",
						"--output",
						out,
						"--force",
					])
				).code,
			).toBe(0);
			const nested = join(dir, "missing", "scaled.png");
			const noMkdir = await runCli([
				"--json",
				"preview",
				input,
				"--scale",
				"2",
				"--output",
				nested,
			]);
			expect(noMkdir.code).toBe(4);
			expect(parseJsonStdout(noMkdir).error?.code).toBe("FILESYSTEM_ERROR");
			expect(
				(
					await runCli([
						"preview",
						input,
						"--scale",
						"2",
						"--output",
						nested,
						"--mkdir",
					])
				).code,
			).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("--scale --stdout carries PNG bytes with a stderr log", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-preview-"));
		try {
			const input = await writeChecker(dir);
			await mkdir(join(dir, "work"));
			const result = await runCli([
				"preview",
				input,
				"--scale",
				"2",
				"--stdout",
			]);
			expect(result.code).toBe(0);
			const decoded = decodePng(result.stdout);
			expect(decoded.canvas.width).toBe(4);
			expect(decoded.canvas.height).toBe(4);
			expect(await listAllFiles(join(dir, "work"))).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
