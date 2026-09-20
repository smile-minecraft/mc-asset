import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addLayer, createCanvas, setPixel } from "../../src/core/canvas.ts";
import { encodePng } from "../../src/io/png.ts";
import { type CaseCheck, VALIDATE_CASES } from "./validate-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, _message) => expect(actual).toBe(expected),
	deepEqual: (actual, expected, _message) => expect(actual).toEqual(expected),
	ok: (value, _message) => expect(value).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("validate engine pure cases", () => {
	for (const validateCase of VALIDATE_CASES) {
		test(validateCase.name, () => {
			validateCase.run(check);
		});
	}
});

// CLI behavior needs real subprocesses, so it stays in this bun:test entry
// on purpose: the node:test mirror (validate.node.ts) only runs the pure
// cases above, keeping the dual entrypoint green on both runtimes.

function makePngBytes(): Uint8Array {
	const canvas = createCanvas(2, 2);
	const layer = addLayer(canvas, { id: "base" });
	setPixel(canvas, layer.id, 0, 0, { r: 255, g: 0, b: 0, a: 255 });
	setPixel(canvas, layer.id, 1, 0, { r: 0, g: 255, b: 0, a: 255 });
	setPixel(canvas, layer.id, 0, 1, { r: 0, g: 0, b: 255, a: 255 });
	setPixel(canvas, layer.id, 1, 1, { r: 255, g: 255, b: 0, a: 255 });
	return encodePng(canvas);
}

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

describe("validate command via spawn", () => {
	test("validate --json passes a clean png without touching it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-validate-"));
		try {
			const input = join(dir, "sword.png");
			await writeFile(input, makePngBytes());
			const before = await readFile(input);
			const { stdout, stderr, code } = await runCli([
				"validate",
				input,
				"--json",
			]);
			expect(code).toBe(0);
			const envelope = JSON.parse(stdout) as {
				success: boolean;
				result: { verdict: string; findings: Array<{ level: string }> };
			};
			expect(envelope.success).toBe(true);
			expect(envelope.result.verdict).toBe("pass");
			for (const finding of envelope.result.findings) {
				expect(finding.level).not.toBe("error");
			}
			expect(stderr).not.toContain('"success":true');
			// Read-only: input bytes are untouched.
			expect(await readFile(input)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("validate --json fails a misnamed minecraft asset with exit 3", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-validate-"));
		try {
			const input = join(dir, "Sword.PNG");
			await writeFile(input, makePngBytes());
			const before = await readFile(input);
			const { stdout, code } = await runCli([
				"validate",
				input,
				"--profile",
				"minecraft:item",
				"--json",
			]);
			expect(code).toBe(3);
			const envelope = JSON.parse(stdout) as {
				success: boolean;
				error: { code: string };
				result: {
					verdict: string;
					findings: Array<{ code: string; level: string }>;
				};
			};
			expect(envelope.success).toBe(false);
			expect(envelope.error.code).toBe("VALIDATION_FAILED");
			expect(envelope.result.verdict).toBe("fail");
			expect(
				envelope.result.findings.some(
					(f) => f.code === "FILENAME_EXTENSION_NOT_PNG" && f.level === "error",
				),
			).toBe(true);
			// Read-only even on failure: input bytes are untouched.
			expect(await readFile(input)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("non-png bytes are a tool failure (exit 5), never exit 3", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-validate-"));
		try {
			const input = join(dir, "broken.png");
			await writeFile(input, "this is not a PNG file");
			const { stdout, stderr, code } = await runCli(["validate", input]);
			expect(code).toBe(5);
			expect(code).not.toBe(3);
			expect(stdout + stderr).toContain("UNSUPPORTED_IMAGE_FORMAT");
			expect(stdout + stderr).not.toContain("VALIDATION_FAILED");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("missing file is exit 4, never exit 3", async () => {
		const { stdout, stderr, code } = await runCli([
			"validate",
			"/no/such/dir/missing.png",
			"--json",
		]);
		expect(code).toBe(4);
		expect(code).not.toBe(3);
		const envelope = JSON.parse(stdout) as {
			success: boolean;
			error: { code: string };
		};
		expect(envelope.success).toBe(false);
		expect(envelope.error.code).toBe("FILESYSTEM_ERROR");
		expect(stdout + stderr).not.toContain("VALIDATION_FAILED");
	}, 30_000);

	test("human output prints the verdict line", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-validate-"));
		try {
			const good = join(dir, "good.png");
			await writeFile(good, makePngBytes());
			const passed = await runCli(["validate", good]);
			expect(passed.code).toBe(0);
			expect(passed.stdout).toContain("verdict: pass");
			const bad = join(dir, "bad.webp");
			await writeFile(bad, makePngBytes());
			const failed = await runCli([
				"validate",
				bad,
				"--profile",
				"minecraft:block",
			]);
			expect(failed.code).toBe(3);
			expect(failed.stdout + failed.stderr).toContain("verdict: fail");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("unknown profile is exit 2", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-validate-"));
		try {
			const input = join(dir, "sword.png");
			await writeFile(input, makePngBytes());
			const { stdout, stderr, code } = await runCli([
				"validate",
				input,
				"--profile",
				"minecraft:entity",
			]);
			expect(code).toBe(2);
			expect(stdout + stderr).toContain("INVALID_PROFILE");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
