import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addLayer, createCanvas, setPixel } from "../../src/core/canvas.ts";
import { encodePng } from "../../src/io/png.ts";
import { ANALYZE_CASES, type CaseCheck } from "./analyze-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, _message) => expect(actual).toBe(expected),
	deepEqual: (actual, expected, _message) => expect(actual).toEqual(expected),
	ok: (value, _message) => expect(value).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("analyze engine pure cases", () => {
	for (const analyzeCase of ANALYZE_CASES) {
		test(analyzeCase.name, () => {
			analyzeCase.run(check);
		});
	}
});

// CLI behavior needs real subprocesses, so it stays in this bun:test entry
// on purpose: the node:test mirror (analyze.node.ts) only runs the pure
// cases above, keeping the dual entrypoint green on both runtimes.

function makePngBytes(): Uint8Array {
	const canvas = createCanvas(2, 2);
	const layer = addLayer(canvas, { id: "base" });
	setPixel(canvas, layer.id, 0, 0, { r: 255, g: 0, b: 0, a: 255 });
	setPixel(canvas, layer.id, 1, 0, { r: 0, g: 255, b: 0, a: 255 });
	setPixel(canvas, layer.id, 0, 1, { r: 0, g: 0, b: 255, a: 0 });
	setPixel(canvas, layer.id, 1, 1, { r: 255, g: 255, b: 255, a: 128 });
	return encodePng(canvas);
}

async function runCli(args: string[]): Promise<{
	stdout: string;
	stdoutBytes: Uint8Array;
	stderr: string;
	code: number;
}> {
	const proc = Bun.spawn(["bun", "src/cli/index.ts", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [buffer, stderr, code] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return {
		stdout: Buffer.from(buffer).toString("utf-8"),
		stdoutBytes: new Uint8Array(buffer),
		stderr,
		code,
	};
}

describe("analyze command via spawn", () => {
	test("analyze --json reports dimensions, colors, alpha, predicted", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-analyze-"));
		try {
			const input = join(dir, "sprite.png");
			await writeFile(input, makePngBytes());
			const before = await readFile(input);
			const { stdout, stderr, code } = await runCli([
				"analyze",
				input,
				"--json",
			]);
			expect(code).toBe(0);
			const envelope = JSON.parse(stdout) as {
				success: boolean;
				result: Record<string, unknown>;
			};
			expect(envelope.success).toBe(true);
			const result = envelope.result as {
				dimensions: { width: number; height: number };
				colorCount: number;
				alpha: Record<string, unknown>;
				dominantColors: unknown[];
			};
			expect(result.dimensions).toEqual({ width: 2, height: 2 });
			expect(typeof result.colorCount).toBe("number");
			expect("predictedClassification" in result.alpha).toBe(true);
			expect(JSON.stringify(result).toLowerCase()).toContain("predicted");
			expect(JSON.stringify(result).toLowerCase().includes("effective")).toBe(
				false,
			);
			expect(Array.isArray(result.dominantColors)).toBe(true);
			expect(stderr).not.toContain('"success":true');
			// Read-only: input bytes are untouched.
			expect(await readFile(input)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("analyze human output is minimal text without envelope", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-analyze-"));
		try {
			const input = join(dir, "sprite.png");
			await writeFile(input, makePngBytes());
			const { stdout, code } = await runCli(["analyze", input]);
			expect(code).toBe(0);
			expect(stdout).toContain("2x2");
			expect(stdout.toLowerCase()).toContain("predicted");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("analyze without input exits 2 with no files created", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-analyze-"));
		try {
			const proc = Bun.spawn(["bun", "src/cli/index.ts", "analyze"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, err, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(code).toBe(2);
			expect(out + err).toMatch(/argument/i);
			const { readdir } = await import("node:fs/promises");
			expect([...(await readdir(dir))].sort()).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("analyze missing file reports an error envelope under --json", async () => {
		const { stdout, code } = await runCli([
			"analyze",
			"/no/such/dir/missing.png",
			"--json",
		]);
		expect(code).not.toBe(0);
		const envelope = JSON.parse(stdout) as {
			success: boolean;
			error: { code: string };
		};
		expect(envelope.success).toBe(false);
		expect(typeof envelope.error.code).toBe("string");
	}, 30_000);
});
