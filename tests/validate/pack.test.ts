import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACK_CASES, type PackCaseCheck } from "./pack-cases.ts";
import {
	makePngBytes,
	modelJson,
	writeCleanBaseline,
	writePackFile,
} from "./pack-fixtures.ts";

const check: PackCaseCheck = {
	equal: (actual, expected, _message) => expect(actual).toBe(expected),
	deepEqual: (actual, expected, _message) => expect(actual).toEqual(expected),
	ok: (value, _message) => expect(value).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("validate-pack engine cases", () => {
	for (const packCase of PACK_CASES) {
		test(packCase.name, async () => {
			await packCase.run(check);
		});
	}
});

// CLI behavior needs real subprocesses, so it stays in this bun:test entry
// on purpose: the node:test mirror (pack.node.ts) only runs the engine
// cases above, keeping the dual entrypoint green on both runtimes.

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

async function treeHash(root: string): Promise<string> {
	const files: string[] = [];
	async function walk(dir: string): Promise<void> {
		const entries = (await readdir(dir)).sort();
		for (const entry of entries) {
			const full = join(dir, entry);
			const st = await lstat(full);
			if (st.isDirectory()) {
				await walk(full);
			} else if (st.isFile()) {
				files.push(full);
			}
		}
	}
	await walk(root);
	files.sort();
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(file.slice(root.length));
		hash.update(await readFile(file));
	}
	return hash.digest("hex");
}

describe("validate-pack command via spawn", () => {
	test("clean pack passes as JSON without touching inputs", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		try {
			await writeCleanBaseline(dir);
			const before = await treeHash(dir);
			const { stdout, stderr, code } = await runCli([
				"validate-pack",
				dir,
				"--resource-pack-version",
				"75",
				"--json",
			]);
			expect(code).toBe(0);
			const envelope = JSON.parse(stdout) as {
				success: boolean;
				result: {
					command: string;
					verdict: string;
					findings: Array<{ level: string }>;
				};
			};
			expect(envelope.success).toBe(true);
			expect(envelope.result.command).toBe("validate-pack");
			expect(envelope.result.verdict).toBe("pass");
			expect(stderr).not.toContain('"success":true');
			expect(await treeHash(dir)).toBe(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("failing pack exits 3 with VALIDATION_FAILED and keeps every finding", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		try {
			await writePackFile(
				dir,
				"assets/minecraft/models/item/broken.json",
				"{ not valid json",
			);
			await writePackFile(
				dir,
				"assets/minecraft/models/item/sword.json",
				modelJson({ textures: { layer0: "minecraft:item/missing" } }),
			);
			const before = await treeHash(dir);
			const { stdout, code } = await runCli([
				"validate-pack",
				dir,
				"--resource-pack-version",
				"75",
				"--json",
			]);
			expect(code).toBe(3);
			const envelope = JSON.parse(stdout) as {
				success: boolean;
				error: { code: string };
				result: {
					verdict: string;
					findings: Array<{ code: string; path?: string }>;
				};
			};
			expect(envelope.success).toBe(false);
			expect(envelope.error.code).toBe("VALIDATION_FAILED");
			expect(envelope.result.verdict).toBe("fail");
			const found = envelope.result.findings.map((f) => f.code).sort();
			expect(found).toEqual(["PACK_INVALID_JSON", "PACK_MISSING_TEXTURE"]);
			expect(await treeHash(dir)).toBe(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("human output prints the verdict line", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		try {
			await writeCleanBaseline(dir);
			const passed = await runCli([
				"validate-pack",
				dir,
				"--resource-pack-version",
				"75",
			]);
			expect(passed.code).toBe(0);
			expect(passed.stdout).toContain("verdict: pass");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("missing root is exit 4, never exit 3", async () => {
		const { stdout, code } = await runCli([
			"validate-pack",
			"/no/such/dir/missing-pack",
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
	}, 30_000);

	test("file path instead of a directory is exit 4", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		try {
			const file = join(dir, "lonely.png");
			await writePackFile(dir, "lonely.png", makePngBytes());
			const { code } = await runCli(["validate-pack", file, "--json"]);
			expect(code).toBe(4);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("both version flags together are exit 2", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		try {
			await writeCleanBaseline(dir);
			const { stdout, stderr, code } = await runCli([
				"validate-pack",
				dir,
				"--minecraft-version",
				"26.3",
				"--resource-pack-version",
				"75",
			]);
			expect(code).toBe(2);
			expect(stdout + stderr).toContain("INVALID_ARGUMENT");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("unknown minecraft version is exit 2", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		try {
			await writeCleanBaseline(dir);
			const { stdout, stderr, code } = await runCli([
				"validate-pack",
				dir,
				"--minecraft-version",
				"99.99",
			]);
			expect(code).toBe(2);
			expect(stdout + stderr).toContain("INVALID_ARGUMENT");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("dotted resource-pack version is exit 2 and never hardcoded", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		try {
			await writeCleanBaseline(dir);
			const { stdout, stderr, code } = await runCli([
				"validate-pack",
				dir,
				"--resource-pack-version",
				"97.1",
			]);
			expect(code).toBe(2);
			expect(stdout + stderr).toContain("INVALID_ARGUMENT");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("file flags are unknown options (exit 2) and create nothing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		try {
			await writeCleanBaseline(dir);
			const before = await readdir(dir);
			const { code } = await runCli([
				"validate-pack",
				dir,
				"--output",
				"out.json",
			]);
			expect(code).toBe(2);
			expect(await readdir(dir)).toEqual(before);
			expect((await stat(dir)).isDirectory()).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--profile is an unknown option (exit 2)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		try {
			await writeCleanBaseline(dir);
			const { code } = await runCli([
				"validate-pack",
				dir,
				"--profile",
				"minecraft:item",
			]);
			expect(code).toBe(2);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("reruns are byte-identical on stdout", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		try {
			await writeCleanBaseline(dir);
			const first = await runCli([
				"validate-pack",
				dir,
				"--resource-pack-version",
				"75",
				"--json",
			]);
			const second = await runCli([
				"validate-pack",
				dir,
				"--resource-pack-version",
				"75",
				"--json",
			]);
			expect(first.code).toBe(0);
			expect(second.stdout).toBe(first.stdout);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
