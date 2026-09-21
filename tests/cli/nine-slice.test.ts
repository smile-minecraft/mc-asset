import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../src/core/canvas.ts";
import { decodePng, encodePng } from "../../src/io/png.ts";

/**
 * preview --nine-slice spawn coverage. Inputs are generated at runtime with
 * the frozen PNG codec (no Mojang assets): a 16x16 sprite plus hand-written
 * .mcmeta documents covering the frozen nine_slice shape, its findings, and
 * the error paths.
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

function spriteBytes(
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

async function writeSprite(dir: string): Promise<string> {
	const path = join(dir, "panel.png");
	await writeFile(
		path,
		spriteBytes(16, 16, (x, y) => ({
			r: (x * 16) % 256,
			g: (y * 16) % 256,
			b: 128,
			a: 255,
		})),
	);
	return path;
}

async function writeMcmeta(
	dir: string,
	name: string,
	doc: unknown,
): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, typeof doc === "string" ? doc : JSON.stringify(doc));
	return path;
}

function nineSliceDoc(
	border: { left: number; top: number; right: number; bottom: number },
	stretchInner = false,
	width = 16,
	height = 16,
): unknown {
	return {
		gui: {
			scaling: {
				type: "nine_slice",
				width,
				height,
				border,
				stretch_inner: stretchInner,
			},
		},
	};
}

describe("preview --nine-slice via spawn", () => {
	test("report matches the frozen JSON shape value by value", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-nine-"));
		try {
			const input = await writeSprite(dir);
			const mcmeta = await writeMcmeta(
				dir,
				"panel.png.mcmeta",
				nineSliceDoc({ left: 4, top: 4, right: 4, bottom: 4 }),
			);
			const result = await runCli([
				"--json",
				"preview",
				input,
				"--nine-slice",
				"--mcmeta",
				mcmeta,
			]);
			expect(result.code).toBe(0);
			const body = parseJsonStdout(result);
			expect(body.success).toBe(true);
			expect(body.result).toEqual({
				command: "preview",
				mode: "nine-slice",
				profile: "generic",
				width: 16,
				height: 16,
				mcmeta: basename(mcmeta),
				scaling: { type: "nine_slice" },
				nineSlice: {
					border: { left: 4, top: 4, right: 4, bottom: 4 },
					stretchInner: false,
				},
				regions: {
					topLeft: { x: 0, y: 0, width: 4, height: 4 },
					top: { x: 4, y: 0, width: 8, height: 4 },
					topRight: { x: 12, y: 0, width: 4, height: 4 },
					left: { x: 0, y: 4, width: 4, height: 8 },
					center: { x: 4, y: 4, width: 8, height: 8 },
					right: { x: 12, y: 4, width: 4, height: 8 },
					bottomLeft: { x: 0, y: 12, width: 4, height: 4 },
					bottom: { x: 4, y: 12, width: 8, height: 4 },
					bottomRight: { x: 12, y: 12, width: 4, height: 4 },
				},
				findings: [],
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("PNG keeps sprite pixels and paints four 1px guide lines", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-nine-"));
		try {
			const input = await writeSprite(dir);
			const mcmeta = await writeMcmeta(
				dir,
				"panel.png.mcmeta",
				nineSliceDoc({ left: 4, top: 4, right: 4, bottom: 4 }),
			);
			const out = join(dir, "guide.png");
			const result = await runCli([
				"preview",
				input,
				"--nine-slice",
				"--mcmeta",
				mcmeta,
				"--output",
				out,
			]);
			expect(result.code).toBe(0);
			const preview = decodePng(new Uint8Array(await readFile(out)));
			expect(preview.canvas.width).toBe(16);
			expect(preview.canvas.height).toBe(16);
			const source = decodePng(new Uint8Array(await readFile(input)));
			const got = preview.canvas.layers[0]?.pixels ?? new Uint8Array();
			const want = source.canvas.layers[0]?.pixels ?? new Uint8Array();
			const at = (pixels: Uint8Array, x: number, y: number): number[] => [
				...pixels.slice((y * 16 + x) * 4, (y * 16 + x) * 4 + 4),
			];
			const guide = [255, 0, 255, 255];
			for (let y = 0; y < 16; y += 1) {
				expect(at(got, 4, y)).toEqual(guide);
				expect(at(got, 12, y)).toEqual(guide);
			}
			for (let x = 0; x < 16; x += 1) {
				expect(at(got, x, 4)).toEqual(guide);
				expect(at(got, x, 12)).toEqual(guide);
			}
			// Away from the guides every pixel stays byte-identical.
			expect(at(got, 0, 0)).toEqual(at(want, 0, 0));
			expect(at(got, 5, 5)).toEqual(at(want, 5, 5));
			expect(at(got, 15, 15)).toEqual(at(want, 15, 15));
			expect(at(got, 11, 3)).toEqual(at(want, 11, 3));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("missing --mcmeta is INVALID_ARGUMENT", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-nine-"));
		try {
			const input = await writeSprite(dir);
			const before = await listAllFiles(dir);
			const result = await runCli(["--json", "preview", input, "--nine-slice"]);
			expect(result.code).toBe(2);
			expect(parseJsonStdout(result).error?.code).toBe("INVALID_ARGUMENT");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("broken mcmeta JSON is INVALID_MCMETA with exit 2", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-nine-"));
		try {
			const input = await writeSprite(dir);
			const mcmeta = await writeMcmeta(dir, "broken.mcmeta", "{not json");
			const before = await listAllFiles(dir);
			const result = await runCli([
				"--json",
				"preview",
				input,
				"--nine-slice",
				"--mcmeta",
				mcmeta,
			]);
			expect(result.code).toBe(2);
			expect(parseJsonStdout(result).error?.code).toBe("INVALID_MCMETA");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("oversize border reports an error finding but stays exit 0", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-nine-"));
		try {
			const input = await writeSprite(dir);
			const mcmeta = await writeMcmeta(
				dir,
				"wide.mcmeta",
				nineSliceDoc({ left: 9, top: 4, right: 8, bottom: 4 }),
			);
			const result = await runCli([
				"--json",
				"preview",
				input,
				"--nine-slice",
				"--mcmeta",
				mcmeta,
			]);
			expect(result.code).toBe(0);
			const body = parseJsonStdout(result);
			expect(body.success).toBe(true);
			const findings = (body.result as { findings: Array<{ level: string }> })
				.findings;
			expect(findings.length).toBeGreaterThan(0);
			expect(findings.every((finding) => finding.level === "error")).toBe(true);
			expect(body.result?.regions).toBeUndefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("equal border sums are an error finding but stay exit 0", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-nine-"));
		try {
			const input = await writeSprite(dir);
			const mcmeta = await writeMcmeta(
				dir,
				"equal.mcmeta",
				nineSliceDoc({ left: 8, top: 8, right: 8, bottom: 8 }),
			);
			const result = await runCli([
				"--json",
				"preview",
				input,
				"--nine-slice",
				"--mcmeta",
				mcmeta,
			]);
			expect(result.code).toBe(0);
			const body = parseJsonStdout(result);
			expect(body.success).toBe(true);
			const findings = (body.result as { findings: Array<{ level: string }> })
				.findings;
			expect(findings.length).toBeGreaterThan(0);
			expect(findings.every((finding) => finding.level === "error")).toBe(true);
			expect(body.result?.regions).toBeUndefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("stretch_inner true only warns and is reported verbatim", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-nine-"));
		try {
			const input = await writeSprite(dir);
			const mcmeta = await writeMcmeta(
				dir,
				"inner.mcmeta",
				nineSliceDoc({ left: 4, top: 4, right: 4, bottom: 4 }, true),
			);
			const result = await runCli([
				"--json",
				"preview",
				input,
				"--nine-slice",
				"--mcmeta",
				mcmeta,
			]);
			expect(result.code).toBe(0);
			const body = parseJsonStdout(result);
			const nineSlice = (
				body.result as { nineSlice: { stretchInner: boolean } }
			).nineSlice;
			expect(nineSlice.stretchInner).toBe(true);
			const findings = (body.result as { findings: Array<{ level: string }> })
				.findings;
			expect(findings.length).toBe(1);
			expect(findings[0]?.level).toBe("warning");
			// Regions still derive: stretch_inner must not change geometry.
			expect(body.result?.regions).toBeDefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("mode flags stay exactly one: none, two, and ascii mix", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-nine-"));
		try {
			const input = await writeSprite(dir);
			const mcmeta = await writeMcmeta(
				dir,
				"panel.png.mcmeta",
				nineSliceDoc({ left: 4, top: 4, right: 4, bottom: 4 }),
			);
			const clash = await runCli([
				"--json",
				"preview",
				input,
				"--nine-slice",
				"--mcmeta",
				mcmeta,
				"--ascii",
			]);
			expect(clash.code).toBe(2);
			expect(parseJsonStdout(clash).error?.code).toBe("ARGUMENT_CONFLICT");
			const clashScale = await runCli([
				"--json",
				"preview",
				input,
				"--nine-slice",
				"--mcmeta",
				mcmeta,
				"--scale",
				"2",
				"--output",
				join(dir, "x.png"),
			]);
			expect(clashScale.code).toBe(2);
			expect(parseJsonStdout(clashScale).error?.code).toBe("ARGUMENT_CONFLICT");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("reruns are byte-identical and inputs stay untouched", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-nine-"));
		try {
			const input = await writeSprite(dir);
			const mcmeta = await writeMcmeta(
				dir,
				"panel.png.mcmeta",
				nineSliceDoc({ left: 4, top: 4, right: 4, bottom: 4 }),
			);
			const inputHash = sha256(new Uint8Array(await readFile(input)));
			const mcmetaHash = sha256(new Uint8Array(await readFile(mcmeta)));
			const first = await runCli([
				"--json",
				"preview",
				input,
				"--nine-slice",
				"--mcmeta",
				mcmeta,
			]);
			const second = await runCli([
				"--json",
				"preview",
				input,
				"--nine-slice",
				"--mcmeta",
				mcmeta,
			]);
			expect(first.code).toBe(0);
			expect(sha256(first.stdout)).toBe(sha256(second.stdout));
			const firstOut = join(dir, "first.png");
			const secondOut = join(dir, "second.png");
			expect(
				(
					await runCli([
						"preview",
						input,
						"--nine-slice",
						"--mcmeta",
						mcmeta,
						"--output",
						firstOut,
					])
				).code,
			).toBe(0);
			expect(
				(
					await runCli([
						"preview",
						input,
						"--nine-slice",
						"--mcmeta",
						mcmeta,
						"--output",
						secondOut,
					])
				).code,
			).toBe(0);
			expect(sha256(new Uint8Array(await readFile(firstOut)))).toBe(
				sha256(new Uint8Array(await readFile(secondOut))),
			);
			expect(sha256(new Uint8Array(await readFile(input)))).toBe(inputHash);
			expect(sha256(new Uint8Array(await readFile(mcmeta)))).toBe(mcmetaHash);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("--nine-slice --stdout carries PNG bytes with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-nine-"));
		try {
			const input = await writeSprite(dir);
			const mcmeta = await writeMcmeta(
				dir,
				"panel.png.mcmeta",
				nineSliceDoc({ left: 4, top: 4, right: 4, bottom: 4 }),
			);
			const before = await listAllFiles(dir);
			const result = await runCli([
				"preview",
				input,
				"--nine-slice",
				"--mcmeta",
				mcmeta,
				"--stdout",
			]);
			expect(result.code).toBe(0);
			const decoded = decodePng(result.stdout);
			expect(decoded.canvas.width).toBe(16);
			expect(decoded.canvas.height).toBe(16);
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
