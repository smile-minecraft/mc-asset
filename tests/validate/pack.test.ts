import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACK_CASES, type PackCaseCheck } from "./pack-cases.ts";
import {
	atlasJson,
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
				modelJson({ textures: { layer0: "testpack:item/missing" } }),
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

	test("texture outside its atlas exits 3 with NOT_IN_ATLAS, inputs kept", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		const vanilla = await mkdtemp(join(tmpdir(), "mc-asset-vanilla-"));
		try {
			await writePackFile(
				dir,
				"assets/minecraft/models/block/stone.json",
				modelJson({ textures: { all: "minecraft:block/stone" } }),
			);
			await writePackFile(
				dir,
				"assets/minecraft/textures/block/stone.png",
				makePngBytes(),
			);
			await writePackFile(
				dir,
				"assets/minecraft/atlases/blocks.json",
				atlasJson([]),
			);
			await writePackFile(
				vanilla,
				"assets/minecraft/atlases/blocks.json",
				atlasJson([]),
			);
			const before = await treeHash(dir);
			const { stdout, code } = await runCli([
				"validate-pack",
				dir,
				"--resource-pack-version",
				"75",
				"--vanilla",
				vanilla,
				"--json",
			]);
			expect(code).toBe(3);
			const envelope = JSON.parse(stdout) as {
				success: boolean;
				error: { code: string };
				result: {
					verdict: string;
					findings: Array<{ code: string; level: string; path?: string }>;
				};
			};
			expect(envelope.success).toBe(false);
			expect(envelope.error.code).toBe("VALIDATION_FAILED");
			expect(envelope.result.verdict).toBe("fail");
			expect(envelope.result.findings.map((f) => f.code)).toEqual([
				"PACK_TEXTURE_NOT_IN_ATLAS",
			]);
			expect(envelope.result.findings[0]?.level).toBe("error");
			expect(await treeHash(dir)).toBe(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
			await rm(vanilla, { recursive: true, force: true });
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

	test("dotted resource-pack version is accepted with a dotted target", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		try {
			await writeCleanBaseline(dir);
			const { stdout, stderr, code } = await runCli([
				"validate-pack",
				dir,
				"--resource-pack-version",
				"97.1",
			]);
			expect(code).toBe(0);
			expect(stdout + stderr).toContain("resource-pack 97.1");
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

	test("no flags reads pack.mcmeta pack_format and reports it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		try {
			await writeCleanBaseline(dir);
			await writePackFile(
				dir,
				"pack.mcmeta",
				modelJson({ pack: { pack_format: 75, description: "reads" } }),
			);
			const before = await treeHash(dir);
			const { stdout, code } = await runCli(["validate-pack", dir, "--json"]);
			expect(code).toBe(0);
			const envelope = JSON.parse(stdout) as {
				success: boolean;
				result: {
					verdict: string;
					target: string;
					findings: Array<{ code: string; level: string }>;
				};
			};
			expect(envelope.success).toBe(true);
			expect(envelope.result.verdict).toBe("pass");
			expect(envelope.result.target).toBe("pack.mcmeta resource-pack 75.0");
			expect(
				envelope.result.findings.some(
					(f) => f.code === "PACK_VERSION_UNDETERMINED",
				),
			).toBe(false);
			expect(stdout).not.toContain("97.1");
			expect(await treeHash(dir)).toBe(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("no flags resolves min_format/max_format to max with a dotted target", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		try {
			await writeCleanBaseline(dir);
			await writePackFile(
				dir,
				"pack.mcmeta",
				modelJson({
					pack: { min_format: 84, max_format: [88, 0], description: "range" },
				}),
			);
			const { stdout, code } = await runCli(["validate-pack", dir, "--json"]);
			expect(code).toBe(0);
			const envelope = JSON.parse(stdout) as {
				success: boolean;
				result: {
					verdict: string;
					target: string;
					findings: Array<{ code: string; level: string }>;
				};
			};
			expect(envelope.success).toBe(true);
			expect(envelope.result.target).toBe("pack.mcmeta resource-pack 88.0");
			expect(
				envelope.result.findings.some(
					(f) => f.code === "PACK_VERSION_UNDETERMINED",
				),
			).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("no flags resolves a dotted pack_format string with no warning", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		try {
			await writeCleanBaseline(dir);
			await writePackFile(
				dir,
				"pack.mcmeta",
				modelJson({ pack: { pack_format: "97.1", description: "dotted" } }),
			);
			const { stdout, code } = await runCli(["validate-pack", dir, "--json"]);
			expect(code).toBe(0);
			const envelope = JSON.parse(stdout) as {
				success: boolean;
				result: {
					verdict: string;
					target: string;
					findings: Array<{ code: string; level: string }>;
				};
			};
			expect(envelope.success).toBe(true);
			expect(envelope.result.target).toBe("pack.mcmeta resource-pack 97.1");
			expect(
				envelope.result.findings.some(
					(f) => f.code === "PACK_VERSION_UNDETERMINED",
				),
			).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("no flags with an unusable mcmeta warns with the min/max wording", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		try {
			await writeCleanBaseline(dir);
			await writePackFile(
				dir,
				"pack.mcmeta",
				modelJson({
					pack: { max_format: "bogus", min_format: [84], pack_format: 0 },
				}),
			);
			const { stdout, code } = await runCli(["validate-pack", dir, "--json"]);
			expect(code).toBe(0);
			const envelope = JSON.parse(stdout) as {
				success: boolean;
				result: {
					verdict: string;
					findings: Array<{ code: string; level: string; message: string }>;
				};
			};
			expect(envelope.success).toBe(true);
			const undetermined = envelope.result.findings.find(
				(f) => f.code === "PACK_VERSION_UNDETERMINED",
			);
			expect(undetermined?.level).toBe("warning");
			expect(undetermined?.message).toBe(
				"no version flag was given and pack.mcmeta carries no usable min_format/max_format or pack_format; version-dependent checks were skipped with no default applied.",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("no flags without pack.mcmeta warns only and never defaults", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		try {
			await writeCleanBaseline(dir);
			const { stdout, code } = await runCli(["validate-pack", dir, "--json"]);
			expect(code).toBe(0);
			const envelope = JSON.parse(stdout) as {
				success: boolean;
				result: {
					verdict: string;
					findings: Array<{ code: string; level: string }>;
				};
			};
			expect(envelope.success).toBe(true);
			expect(envelope.result.verdict).toBe("pass");
			const undetermined = envelope.result.findings.filter(
				(f) => f.code === "PACK_VERSION_UNDETERMINED",
			);
			expect(undetermined.length).toBe(1);
			expect(undetermined[0]?.level).toBe("warning");
			expect(stdout).not.toContain("97.1");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("no flags with broken pack.mcmeta fails on INVALID_JSON and keeps inputs", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		try {
			await writeCleanBaseline(dir);
			await writePackFile(dir, "pack.mcmeta", "{ not valid json");
			const before = await treeHash(dir);
			const { stdout, code } = await runCli(["validate-pack", dir, "--json"]);
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
			const codes = envelope.result.findings.map((f) => f.code);
			expect(codes).toContain("PACK_INVALID_JSON");
			expect(codes).toContain("PACK_VERSION_UNDETERMINED");
			expect(
				envelope.result.findings.find(
					(f) => f.code === "PACK_VERSION_UNDETERMINED",
				)?.level,
			).toBe("warning");
			expect(await treeHash(dir)).toBe(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("vanilla parent without --vanilla is unresolved with partial coverage", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		try {
			await writePackFile(
				dir,
				"assets/minecraft/models/item/custom.json",
				modelJson({ parent: "minecraft:item/sword" }),
			);
			const { stdout, code } = await runCli([
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
					verdict: string;
					findings: Array<{ code: string; level: string }>;
					coverage: {
						status: string;
						skipped: Array<{ kind: string; reason: string; target: string }>;
					};
				};
			};
			expect(envelope.success).toBe(true);
			expect(envelope.result.verdict).toBe("pass");
			expect(envelope.result.findings.map((f) => f.code)).toEqual([
				"PACK_UNRESOLVED_EXTERNAL",
			]);
			expect(envelope.result.findings[0]?.level).toBe("warning");
			expect(envelope.result.coverage).toEqual({
				status: "partial",
				skipped: [
					{
						kind: "external-reference",
						reason: "vanilla-not-provided",
						target: "minecraft:item/sword",
					},
				],
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("--vanilla resolves the parent with complete coverage", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		const vanilla = await mkdtemp(join(tmpdir(), "mc-asset-vanilla-"));
		try {
			await writePackFile(
				dir,
				"assets/minecraft/models/item/sword.json",
				modelJson({ parent: "minecraft:item/generated" }),
			);
			await writePackFile(
				vanilla,
				"assets/minecraft/models/item/generated.json",
				modelJson({ parent: "minecraft:builtin/generated" }),
			);
			const { stdout, code } = await runCli([
				"validate-pack",
				dir,
				"--resource-pack-version",
				"75",
				"--vanilla",
				vanilla,
				"--json",
			]);
			expect(code).toBe(0);
			const envelope = JSON.parse(stdout) as {
				success: boolean;
				result: {
					verdict: string;
					findings: Array<{ code: string }>;
					coverage: { status: string; skipped: unknown[] };
				};
			};
			expect(envelope.success).toBe(true);
			expect(envelope.result.verdict).toBe("pass");
			expect(envelope.result.findings).toEqual([]);
			expect(envelope.result.coverage).toEqual({
				status: "complete",
				skipped: [],
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
			await rm(vanilla, { recursive: true, force: true });
		}
	}, 30_000);

	test("--vanilla present but still absent is a determined missing with exit 3", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		const vanilla = await mkdtemp(join(tmpdir(), "mc-asset-vanilla-"));
		try {
			await writePackFile(
				dir,
				"assets/minecraft/models/item/sword.json",
				modelJson({ parent: "minecraft:item/gone" }),
			);
			await writePackFile(
				vanilla,
				"assets/minecraft/models/item/other.json",
				modelJson({ textures: {} }),
			);
			const { stdout, code } = await runCli([
				"validate-pack",
				dir,
				"--resource-pack-version",
				"75",
				"--vanilla",
				vanilla,
				"--json",
			]);
			expect(code).toBe(3);
			const envelope = JSON.parse(stdout) as {
				success: boolean;
				error: { code: string };
				result: { findings: Array<{ code: string }> };
			};
			expect(envelope.success).toBe(false);
			expect(envelope.error.code).toBe("VALIDATION_FAILED");
			expect(envelope.result.findings.map((f) => f.code)).toEqual([
				"PACK_MISSING_ASSET",
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
			await rm(vanilla, { recursive: true, force: true });
		}
	}, 30_000);

	test("--dependency is repeatable and every layer is searched", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		const first = await mkdtemp(join(tmpdir(), "mc-asset-dep1-"));
		const second = await mkdtemp(join(tmpdir(), "mc-asset-dep2-"));
		try {
			await writePackFile(
				dir,
				"assets/testpack/models/item/sword.json",
				modelJson({ parent: "testpack:item/base" }),
			);
			await writePackFile(
				first,
				"assets/testpack/models/item/unrelated.json",
				modelJson({ textures: {} }),
			);
			await writePackFile(
				second,
				"assets/testpack/models/item/base.json",
				modelJson({ textures: {} }),
			);
			const { stdout, code } = await runCli([
				"validate-pack",
				dir,
				"--resource-pack-version",
				"75",
				"--dependency",
				first,
				"--dependency",
				second,
				"--json",
			]);
			expect(code).toBe(0);
			const envelope = JSON.parse(stdout) as {
				success: boolean;
				result: {
					verdict: string;
					coverage: { status: string; skipped: unknown[] };
				};
			};
			expect(envelope.success).toBe(true);
			expect(envelope.result.verdict).toBe("pass");
			expect(envelope.result.coverage).toEqual({
				status: "complete",
				skipped: [],
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
			await rm(first, { recursive: true, force: true });
			await rm(second, { recursive: true, force: true });
		}
	}, 30_000);

	test("missing --vanilla root is exit 4, never exit 3", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		try {
			await writeCleanBaseline(dir);
			const { stdout, code } = await runCli([
				"validate-pack",
				dir,
				"--resource-pack-version",
				"75",
				"--vanilla",
				"/no/such/dir/missing-vanilla",
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
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("human output names the coverage line on partial packs", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-"));
		try {
			await writePackFile(
				dir,
				"assets/minecraft/models/item/custom.json",
				modelJson({ parent: "minecraft:item/sword" }),
			);
			const passed = await runCli([
				"validate-pack",
				dir,
				"--resource-pack-version",
				"75",
			]);
			expect(passed.code).toBe(0);
			expect(passed.stdout).toContain("verdict: pass");
			expect(passed.stdout).toContain("coverage: partial (1 skipped)");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
