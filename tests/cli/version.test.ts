import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addLayer, createCanvas, setPixel } from "../../src/core/canvas.ts";
import { encodePng } from "../../src/io/png.ts";
import { type CaseCheck, VERSION_CASES } from "./version-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, _message) => expect(actual).toBe(expected),
	deepEqual: (actual, expected, _message) => expect(actual).toEqual(expected),
	ok: (value, _message) => expect(value).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("version flag resolution pure cases", () => {
	for (const versionCase of VERSION_CASES) {
		test(versionCase.name, () => {
			versionCase.run(check);
		});
	}
});

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

async function withPng(run: (input: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-version-"));
	try {
		const input = join(dir, "sprite.png");
		await writeFile(input, makePngBytes());
		await run(input);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

interface VersionShape {
	minecraftVersion?: string;
	resourcePackVersion?: string;
}

function readVersion(result: Record<string, unknown>): VersionShape {
	const version = result.version as VersionShape | undefined;
	expect(version).toBeDefined();
	return version ?? {};
}

describe("version flags via spawn (Red: flags do not exist yet)", () => {
	test("analyze --minecraft-version 26.3 reports a version shape", async () => {
		await withPng(async (input) => {
			const { stdout, code } = await runCli([
				"analyze",
				input,
				"--json",
				"--minecraft-version",
				"26.3",
			]);
			expect(code).toBe(0);
			const envelope = JSON.parse(stdout) as {
				success: boolean;
				result: Record<string, unknown>;
			};
			expect(envelope.success).toBe(true);
			const version = readVersion(envelope.result);
			expect(version.minecraftVersion).toBe("26.3");
			expect(version.resourcePackVersion).toBe("97.1");
			expect("packFormat" in version).toBe(false);
		});
	}, 30_000);

	test("analyze version shape differs from the no-flag default", async () => {
		await withPng(async (input) => {
			const flagged = await runCli([
				"analyze",
				input,
				"--json",
				"--minecraft-version",
				"26.3",
			]);
			const plain = await runCli(["analyze", input, "--json"]);
			expect(flagged.code).toBe(0);
			expect(plain.code).toBe(0);
			const flaggedResult = (
				JSON.parse(flagged.stdout) as {
					result: Record<string, unknown>;
				}
			).result;
			const plainResult = (
				JSON.parse(plain.stdout) as { result: Record<string, unknown> }
			).result;
			expect(JSON.stringify(flaggedResult.version)).not.toBe(
				JSON.stringify(plainResult.version),
			);
		});
	}, 30_000);

	test("analyze --resource-pack-version 75 normalizes to 75.0", async () => {
		await withPng(async (input) => {
			const { stdout, code } = await runCli([
				"analyze",
				input,
				"--json",
				"--resource-pack-version",
				"75",
			]);
			expect(code).toBe(0);
			const envelope = JSON.parse(stdout) as {
				success: boolean;
				result: Record<string, unknown>;
			};
			expect(envelope.success).toBe(true);
			const version = readVersion(envelope.result);
			expect(version.resourcePackVersion).toBe("75.0");
			expect("packFormat" in version).toBe(false);
		});
	}, 30_000);

	test("analyze --resource-pack-version 97.1 stays dotted", async () => {
		await withPng(async (input) => {
			const { stdout, code } = await runCli([
				"analyze",
				input,
				"--json",
				"--resource-pack-version",
				"97.1",
			]);
			expect(code).toBe(0);
			const envelope = JSON.parse(stdout) as {
				success: boolean;
				result: Record<string, unknown>;
			};
			expect(envelope.success).toBe(true);
			expect(readVersion(envelope.result).resourcePackVersion).toBe("97.1");
		});
	}, 30_000);

	test("validate --minecraft-version 26.3 passes with a version shape", async () => {
		await withPng(async (input) => {
			const { stdout, code } = await runCli([
				"validate",
				input,
				"--json",
				"--minecraft-version",
				"26.3",
			]);
			expect(code).toBe(0);
			const envelope = JSON.parse(stdout) as {
				success: boolean;
				result: Record<string, unknown> & {
					verdict: string;
					findings: Array<{ code: string; level: string }>;
				};
			};
			expect(envelope.success).toBe(true);
			expect(envelope.result.verdict).toBe("pass");
			const version = readVersion(envelope.result);
			expect(version.minecraftVersion).toBe("26.3");
			expect(version.resourcePackVersion).toBe("97.1");
		});
	}, 30_000);

	test("analyze human target lines follow the dotted echo shape", async () => {
		await withPng(async (input) => {
			const flagged = await runCli([
				"analyze",
				input,
				"--minecraft-version",
				"26.3",
			]);
			expect(flagged.code).toBe(0);
			expect(flagged.stdout + flagged.stderr).toContain(
				"target: minecraft 26.3 / resource-pack 97.1",
			);
			const dotted = await runCli([
				"analyze",
				input,
				"--resource-pack-version",
				"97.1",
			]);
			expect(dotted.code).toBe(0);
			expect(dotted.stdout + dotted.stderr).toContain(
				"target: resource-pack 97.1",
			);
			const plain = await runCli(["analyze", input]);
			expect(plain.code).toBe(0);
			expect(plain.stdout + plain.stderr).toContain(
				"target: default (engine defaults)",
			);
		});
	}, 30_000);

	test("unknown --minecraft-version is INVALID_ARGUMENT with exit 2", async () => {
		await withPng(async (input) => {
			for (const bad of ["99.99", "26.4"]) {
				const { stdout, stderr, code } = await runCli([
					"analyze",
					input,
					"--minecraft-version",
					bad,
				]);
				expect(code).toBe(2);
				expect(stdout + stderr).toContain("INVALID_ARGUMENT");
				expect(stdout + stderr).toContain("1.19.3 through 26.3");
			}
		});
	}, 30_000);

	test("malformed --resource-pack-version is INVALID_ARGUMENT", async () => {
		await withPng(async (input) => {
			for (const bad of ["abc", "0", "1."]) {
				const { stdout, stderr, code } = await runCli([
					"analyze",
					input,
					"--resource-pack-version",
					bad,
				]);
				expect(code).toBe(2);
				expect(stdout + stderr).toContain("INVALID_ARGUMENT");
			}
		});
	}, 30_000);

	test("both version flags together are INVALID_ARGUMENT", async () => {
		await withPng(async (input) => {
			const { stdout, stderr, code } = await runCli([
				"analyze",
				input,
				"--minecraft-version",
				"26.3",
				"--resource-pack-version",
				"75",
			]);
			expect(code).toBe(2);
			expect(stdout + stderr).toContain("INVALID_ARGUMENT");
		});
	}, 30_000);

	test("repeating a version flag is INVALID_ARGUMENT", async () => {
		await withPng(async (input) => {
			const { stdout, stderr, code } = await runCli([
				"analyze",
				input,
				"--minecraft-version",
				"26.3",
				"--minecraft-version",
				"26.3",
			]);
			expect(code).toBe(2);
			expect(stdout + stderr).toContain("INVALID_ARGUMENT");
		});
	}, 30_000);

	test("sourced facts stay silent under version flags", async () => {
		await withPng(async (input) => {
			const analyzed = await runCli([
				"analyze",
				input,
				"--json",
				"--minecraft-version",
				"26.3",
			]);
			expect(analyzed.code).toBe(0);
			const envelope = JSON.parse(analyzed.stdout) as {
				result: { warnings: Array<{ code: string; level: string }> };
			};
			expect(
				envelope.result.warnings.filter(
					(w) =>
						w.code === "PENDING_SOURCE_PNG_ONLY" ||
						w.code === "VERSION_FACT_UNDETERMINED",
				),
			).toEqual([]);
			const validated = await runCli([
				"validate",
				input,
				"--json",
				"--resource-pack-version",
				"75",
			]);
			expect(validated.code).toBe(0);
			const verdict = JSON.parse(validated.stdout) as {
				result: {
					verdict: string;
					findings: Array<{ code: string; level: string }>;
				};
			};
			expect(verdict.result.verdict).toBe("pass");
			expect(
				verdict.result.findings.filter(
					(f) =>
						f.code === "PENDING_SOURCE_PNG_ONLY" ||
						f.code === "VERSION_FACT_UNDETERMINED",
				),
			).toEqual([]);
		});
	}, 30_000);

	test("analyze --help lists both version flags", async () => {
		const { stdout, stderr, code } = await runCli(["analyze", "--help"]);
		expect(code).toBe(0);
		expect(stdout + stderr).toContain("--minecraft-version");
		expect(stdout + stderr).toContain("--resource-pack-version");
	}, 30_000);

	test("validate --help lists both version flags", async () => {
		const { stdout, stderr, code } = await runCli(["validate", "--help"]);
		expect(code).toBe(0);
		expect(stdout + stderr).toContain("--minecraft-version");
		expect(stdout + stderr).toContain("--resource-pack-version");
	}, 30_000);
});
