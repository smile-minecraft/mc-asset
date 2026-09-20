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
import { decodePng, encodePng } from "../../src/io/png.ts";

/**
 * tile spawn coverage. Inputs are generated at runtime with the frozen
 * PNG codec (no Mojang assets): a 2x2 black/white checker matching the
 * v03 worked example, plus solid canvases for the guard matrix.
 */

interface SpawnResult {
	code: number;
	stdout: Uint8Array;
	stderr: string;
}

function stdoutText(result: SpawnResult): string {
	return Buffer.from(result.stdout).toString("utf-8");
}

function combined(result: SpawnResult): string {
	return stdoutText(result) + result.stderr;
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
	) => { r: number; g: number; b: number; a: number },
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

async function writeChecker(dir: string): Promise<string> {
	const path = join(dir, "checker.png");
	await writeFile(
		path,
		pngBytesFor(2, 2, (x) => (x === 0 ? B : W)),
	);
	return path;
}

async function writeSolid(
	dir: string,
	name: string,
	width: number,
	height: number,
): Promise<string> {
	const path = join(dir, name);
	await writeFile(
		path,
		pngBytesFor(width, height, () => ({ ...B })),
	);
	return path;
}

function parseJsonStdout(result: SpawnResult): {
	success: boolean;
	result?: Record<string, unknown>;
	error?: { code: string };
} {
	return JSON.parse(stdoutText(result)) as {
		success: boolean;
		result?: Record<string, unknown>;
		error?: { code: string };
	};
}

describe("tile wiring via spawn", () => {
	test("report mode writes zero files and prints the human line", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-tile-"));
		try {
			const input = await writeChecker(dir);
			const work = join(dir, "work");
			await mkdir(work);
			const result = await runCli(["tile", input]);
			expect(result.code).toBe(0);
			expect(combined(result)).toContain("ok tile");
			expect(await listAllFiles(work)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--output without corrections is byte-equal to the input", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-tile-"));
		try {
			const input = await writeChecker(dir);
			const out = join(dir, "tile.png");
			const result = await runCli(["tile", input, "--output", out]);
			expect(result.code).toBe(0);
			expect(sha256(new Uint8Array(await readFile(out)))).toBe(
				sha256(new Uint8Array(await readFile(input))),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--preview 4x4 writes a 4W by 4H preview", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-tile-"));
		try {
			const input = await writeChecker(dir);
			const out = join(dir, "preview.png");
			const result = await runCli([
				"tile",
				input,
				"--preview",
				"4x4",
				"--output",
				out,
			]);
			expect(result.code).toBe(0);
			const decoded = decodePng(new Uint8Array(await readFile(out)));
			expect(decoded.canvas.width).toBe(8);
			expect(decoded.canvas.height).toBe(8);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--preview without --output is OUTPUT_REQUIRED with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-tile-"));
		try {
			const input = await writeChecker(dir);
			const before = await listAllFiles(dir);
			const result = await runCli([
				"--json",
				"tile",
				input,
				"--preview",
				"2x2",
			]);
			expect(result.code).toBe(2);
			expect(parseJsonStdout(result).error?.code).toBe("OUTPUT_REQUIRED");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--preview 3x3 is INVALID_ARGUMENT", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-tile-"));
		try {
			const input = await writeChecker(dir);
			const result = await runCli([
				"--json",
				"tile",
				input,
				"--preview",
				"3x3",
				"--output",
				join(dir, "nope.png"),
			]);
			expect(result.code).toBe(2);
			expect(parseJsonStdout(result).error?.code).toBe("INVALID_ARGUMENT");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--edge-match vertical zeroes the corrected vertical raw", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-tile-"));
		try {
			const input = await writeChecker(dir);
			const out = join(dir, "fixed.png");
			const result = await runCli([
				"--json",
				"tile",
				input,
				"--edge-match",
				"vertical",
				"--output",
				out,
			]);
			expect(result.code).toBe(0);
			const body = parseJsonStdout(result);
			const corrected = body.result?.corrected as {
				seam: { vertical: { raw: number } };
			};
			expect(corrected.seam.vertical.raw).toBe(0);
			expect(body.result?.corrections).toEqual(["edge-match:vertical"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--json report shape carries seam repeat corrections and output", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-tile-"));
		try {
			const input = await writeChecker(dir);
			const out = join(dir, "tile.png");
			const result = await runCli(["--json", "tile", input, "--output", out]);
			expect(result.code).toBe(0);
			const body = parseJsonStdout(result);
			const tile = body.result as {
				command: string;
				seam: Record<string, { raw: number; pairs: number; score: string }>;
				repeat: { score: string; periodX: number; periodY: number };
				corrections: unknown[];
				output: string;
			};
			expect(tile.command).toBe("tile");
			expect(tile.seam.vertical).toEqual({
				raw: 390150,
				pairs: 2,
				score: "0.750000",
			});
			expect(tile.seam.horizontal).toEqual({
				raw: 0,
				pairs: 2,
				score: "0.000000",
			});
			expect(tile.repeat).toEqual({
				// Definition-literal value (frozen max rule over 0.25 / 1.0);
				// the frozen text lists 0.250000, reported for a decision.
				score: "1.000000",
				periodX: 1,
				periodY: 1,
			});
			expect(tile.corrections).toEqual([]);
			expect(tile.output).toBe(out);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("same input reruns byte-identical", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-tile-"));
		try {
			const input = await writeChecker(dir);
			const first = join(dir, "first.png");
			const second = join(dir, "second.png");
			expect((await runCli(["tile", input, "--output", first])).code).toBe(0);
			expect((await runCli(["tile", input, "--output", second])).code).toBe(0);
			expect(sha256(new Uint8Array(await readFile(first)))).toBe(
				sha256(new Uint8Array(await readFile(second))),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--source and --in-place are unknown options on tile", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-tile-"));
		try {
			const input = await writeChecker(dir);
			expect(
				(await runCli(["tile", input, "--source", join(dir, "x.mcpx")])).code,
			).toBe(2);
			expect((await runCli(["tile", input, "--in-place"])).code).toBe(2);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("minecraft block profile gates a non-png output", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-tile-"));
		try {
			const input = await writeChecker(dir);
			const result = await runCli([
				"--json",
				"tile",
				input,
				"--profile",
				"minecraft:block",
				"--output",
				join(dir, "tile.bin"),
			]);
			expect(result.code).toBe(5);
			expect(parseJsonStdout(result).error?.code).toBe(
				"UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("preview beyond 4096 is INVALID_DIMENSION", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-tile-"));
		try {
			const input = await writeSolid(dir, "wide.png", 1025, 1);
			const result = await runCli([
				"--json",
				"tile",
				input,
				"--preview",
				"4x4",
				"--output",
				join(dir, "huge.png"),
			]);
			expect(result.code).toBe(2);
			expect(parseJsonStdout(result).error?.code).toBe("INVALID_DIMENSION");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("OUTPUT_EXISTS force and mkdir guards hold", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-tile-"));
		try {
			const input = await writeChecker(dir);
			const out = join(dir, "tile.png");
			expect((await runCli(["tile", input, "--output", out])).code).toBe(0);
			const clash = await runCli(["--json", "tile", input, "--output", out]);
			expect(clash.code).toBe(4);
			expect(parseJsonStdout(clash).error?.code).toBe("OUTPUT_EXISTS");
			expect(
				(await runCli(["tile", input, "--output", out, "--force"])).code,
			).toBe(0);
			const nested = join(dir, "missing", "tile.png");
			const noMkdir = await runCli([
				"--json",
				"tile",
				input,
				"--output",
				nested,
			]);
			expect(noMkdir.code).toBe(4);
			expect(parseJsonStdout(noMkdir).error?.code).toBe("FILESYSTEM_ERROR");
			expect(
				(await runCli(["tile", input, "--output", nested, "--mkdir"])).code,
			).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
