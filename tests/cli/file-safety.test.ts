import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
	mkdir,
	mkdtemp,
	writeFile as nodeWriteFile,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import {
	preflightArtifactTargets,
	resolveArtifactTargets,
	writeArtifactPayloads,
} from "../../src/cli/artifacts.ts";
import { atomicWriteFile } from "../../src/cli/filesystem.ts";
import { McAssetError } from "../../src/core/errors.ts";
import { decodePng } from "../../src/io/png.ts";
import { PNG_VECTORS } from "../io/png-cases.ts";

// File-output safety net (release hardening): same-path/alias refusal,
// duplicate-target refusal, exclusive temps, stdout timing, per-file atomic
// multi-write semantics, and same-target concurrency. Written Red-first:
// several cases below fail against the pre-hardening implementation.

const FIXTURES = "tests/cli/fixtures";
const SWORD_MCPX = join(FIXTURES, "sword.mcpx");
const TINY_GRID = join(FIXTURES, "tiny.grid");

interface SpawnResult {
	code: number;
	stdout: Uint8Array;
	stderr: string;
}

function stdoutText(result: SpawnResult): string {
	return Buffer.from(result.stdout).toString("utf-8");
}

async function runCli(args: string[], stdin?: string): Promise<SpawnResult> {
	const proc = Bun.spawn(["bun", "src/cli/index.ts", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: stdin === undefined ? "ignore" : Buffer.from(stdin, "utf-8"),
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout: new Uint8Array(stdout), stderr };
}

function syncCode(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		if (error instanceof McAssetError) {
			return error.code;
		}
		throw error;
	}
	return "NO_THROW";
}

async function writeVectorPng(dir: string, name: string): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, Buffer.from(PNG_VECTORS.V_PATTERN_2X2, "base64"));
	return path;
}

async function tempResidue(dir: string): Promise<string[]> {
	const entries = await readdir(dir);
	return entries.filter((name) => name.startsWith(".tmp-")).sort();
}

describe("file safety: input/output alias is refused without --in-place", () => {
	test("literal same path is ARGUMENT_CONFLICT", () => {
		expect(
			syncCode(() =>
				resolveArtifactTargets({
					command: "import",
					output: "work.png",
					inputPath: "work.png",
				}),
			),
		).toBe("ARGUMENT_CONFLICT");
	});

	test("relative vs absolute alias is ARGUMENT_CONFLICT", () => {
		const abs = resolve("work-alias.png");
		const rel = relative(process.cwd(), abs);
		expect(rel).not.toBe(abs);
		expect(
			syncCode(() =>
				resolveArtifactTargets({
					command: "import",
					output: rel,
					inputPath: abs,
				}),
			),
		).toBe("ARGUMENT_CONFLICT");
	});

	test("dot-segment alias is ARGUMENT_CONFLICT", () => {
		expect(
			syncCode(() =>
				resolveArtifactTargets({
					command: "import",
					output: "dir/../work-dot.png",
					inputPath: "work-dot.png",
				}),
			),
		).toBe("ARGUMENT_CONFLICT");
	});

	test("symlink alias is refused end to end and the input is untouched", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-safety-"));
		try {
			const real = await writeVectorPng(dir, "real.png");
			const link = join(dir, "link.png");
			await symlink(real, link);
			const before = await readFile(real);
			const result = await runCli(["import", link, "--output", real]);
			expect(result.code).toBe(2);
			expect(stdoutText(result) + result.stderr).toContain("ARGUMENT_CONFLICT");
			expect(await readFile(real)).toEqual(before);
			expect(await tempResidue(dir)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("explicit --in-place still rewrites the input", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-safety-"));
		try {
			const png = await writeVectorPng(dir, "work.png");
			const result = await runCli(["import", png, "--in-place"]);
			expect(result.code).toBe(0);
			const decoded = decodePng(new Uint8Array(await readFile(png)));
			expect(decoded.canvas.width).toBe(2);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("file safety: duplicate targets are refused before the first byte", () => {
	test("PNG and mcpx sharing one target is ARGUMENT_CONFLICT", () => {
		expect(
			syncCode(() =>
				resolveArtifactTargets({
					command: "import",
					output: "same.bin",
					source: "same.bin",
				}),
			),
		).toBe("ARGUMENT_CONFLICT");
	});

	test("PNG and mcpx aliasing via path form is ARGUMENT_CONFLICT", () => {
		const abs = resolve("dup-alias.bin");
		expect(
			syncCode(() =>
				resolveArtifactTargets({
					command: "import",
					output: relative(process.cwd(), abs),
					source: abs,
				}),
			),
		).toBe("ARGUMENT_CONFLICT");
	});

	test("--in-place plus an explicit output on the input is ARGUMENT_CONFLICT", () => {
		expect(
			syncCode(() =>
				resolveArtifactTargets({
					command: "build",
					output: "work.mcpx",
					inPlace: true,
					inputPath: "work.mcpx",
				}),
			),
		).toBe("ARGUMENT_CONFLICT");
	});

	test("case-only distinct names are the same target", () => {
		expect(
			syncCode(() =>
				resolveArtifactTargets({
					command: "import",
					output: "case.png",
					source: "CASE.png",
				}),
			),
		).toBe("ARGUMENT_CONFLICT");
	});

	test("NFC and NFD spellings are the same target", () => {
		// Both spellings written as escapes so the source encoding can never
		// fold them for us: NFC caf\u00e9 vs NFD cafe\u0301.
		const nfc = "caf\u00e9.png";
		const nfd = "cafe\u0301.png";
		expect(nfc).not.toBe(nfd);
		expect(nfc.normalize("NFC")).toBe(nfd.normalize("NFC"));
		expect(
			syncCode(() =>
				resolveArtifactTargets({
					command: "import",
					output: nfc,
					source: nfd,
				}),
			),
		).toBe("ARGUMENT_CONFLICT");
	});
});

describe("file safety: case and Unicode identity end to end", () => {
	test("case-only PNG/mcpx pair is refused with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-safety-"));
		try {
			const before = await readdir(dir);
			const result = await runCli([
				"render",
				TINY_GRID,
				"--output",
				join(dir, "case.png"),
				"--source",
				join(dir, "CASE.png"),
				"--force",
			]);
			expect(result.code).toBe(2);
			expect(stdoutText(result) + result.stderr).toContain("ARGUMENT_CONFLICT");
			expect(await readdir(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("NFC/NFD PNG/mcpx pair is refused with zero files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-safety-"));
		try {
			const nfc = "caf\u00e9.png";
			const nfd = "cafe\u0301.png";
			const before = await readdir(dir);
			const result = await runCli([
				"render",
				TINY_GRID,
				"--output",
				join(dir, nfc),
				"--source",
				join(dir, nfd),
				"--force",
			]);
			expect(result.code).toBe(2);
			expect(stdoutText(result) + result.stderr).toContain("ARGUMENT_CONFLICT");
			expect(await readdir(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("file safety: stdout timing against file-target conflicts", () => {
	test("build stdout stays at zero bytes when a file target conflicts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-safety-"));
		try {
			const existing = join(dir, "taken.png");
			expect(
				(await runCli(["build", SWORD_MCPX, "--output", existing])).code,
			).toBe(0);
			const refused = await runCli([
				"build",
				SWORD_MCPX,
				"--stdout",
				"--output",
				existing,
			]);
			expect(refused.code).toBe(4);
			expect(stdoutText(refused) + refused.stderr).toContain("OUTPUT_EXISTS");
			expect(refused.stdout.length).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("import stdout stays at zero bytes when a file target conflicts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-safety-"));
		try {
			const input = await writeVectorPng(dir, "in.png");
			const existing = join(dir, "taken.png");
			expect((await runCli(["import", input, "--output", existing])).code).toBe(
				0,
			);
			const refused = await runCli([
				"import",
				input,
				"--stdout",
				"--output",
				existing,
			]);
			expect(refused.code).toBe(4);
			expect(stdoutText(refused) + refused.stderr).toContain("OUTPUT_EXISTS");
			expect(refused.stdout.length).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("render stdout stays at zero bytes when a file target conflicts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-safety-"));
		try {
			const existing = join(dir, "taken.png");
			expect(
				(await runCli(["render", TINY_GRID, "--output", existing])).code,
			).toBe(0);
			const refused = await runCli([
				"render",
				TINY_GRID,
				"--stdout",
				"--output",
				existing,
			]);
			expect(refused.code).toBe(4);
			expect(stdoutText(refused) + refused.stderr).toContain("OUTPUT_EXISTS");
			expect(refused.stdout.length).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("file safety: multi-file failure semantics are per-file atomic", () => {
	test("union preflight refuses a missing parent with zero bytes anywhere", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-safety-"));
		try {
			const first = join(dir, "first.bin");
			const second = join(dir, "no-such-dir", "second.bin");
			let code = "";
			try {
				await writeArtifactPayloads(
					[
						{
							targets: [{ path: first, force: false }],
							data: new Uint8Array([1, 2, 3]),
						},
						{
							targets: [{ path: second, force: false }],
							data: "second",
						},
					],
					false,
				);
			} catch (error) {
				code = error instanceof McAssetError ? error.code : String(error);
			}
			expect(code).toBe("FILESYSTEM_ERROR");
			await expect(stat(first)).rejects.toThrow();
			await expect(stat(second)).rejects.toThrow();
			expect(await tempResidue(dir)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("write-phase failure keeps the first commit and reports it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-safety-"));
		try {
			const first = join(dir, "first.bin");
			const second = join(dir, "second.bin");
			let error: unknown;
			try {
				await writeArtifactPayloads(
					[
						{
							targets: [{ path: first, force: false }],
							data: new Uint8Array([1, 2, 3]),
						},
						{
							targets: [{ path: second, force: false }],
							data: "second",
						},
					],
					false,
					{
						renameFile: async (oldPath, newPath) => {
							if (newPath === second) {
								throw new Error("injected rename failure");
							}
							await rename(oldPath, newPath);
						},
					},
				);
			} catch (caught) {
				error = caught;
			}
			expect(error instanceof McAssetError).toBe(true);
			expect((error as McAssetError).code).toBe("FILESYSTEM_ERROR");
			// Per-file atomic, explicitly NOT all-or-nothing: the first target
			// is a complete commit, the second never lands.
			expect(new Uint8Array(await readFile(first))).toEqual(
				new Uint8Array([1, 2, 3]),
			);
			await expect(stat(second)).rejects.toThrow();
			const details = (error as McAssetError).details as
				| { completed?: unknown; failedTarget?: unknown }
				| undefined;
			expect(Array.isArray(details?.completed)).toBe(true);
			const completed = (details as { completed: string[] }).completed;
			expect(completed.some((entry) => entry === first)).toBe(true);
			expect(details?.failedTarget).toBe(second);
			expect(await tempResidue(dir)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("file safety: exclusive temp files", () => {
	test("temp names carry a random segment beyond the fixed counter", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-safety-"));
		try {
			const seen: string[] = [];
			for (let index = 0; index < 2; index += 1) {
				await atomicWriteFile(
					join(dir, `name-${index}.bin`),
					new TextEncoder().encode("x"),
					{},
					async (tempPath, data) => {
						seen.push(tempPath);
						await nodeWriteFile(tempPath, data, { flag: "wx" });
					},
				);
			}
			expect(seen.length).toBe(2);
			expect(seen[0]).not.toBe(seen[1]);
			for (const tempPath of seen) {
				expect(tempPath).toMatch(/\.tmp-\d+-\d+-[0-9a-f]{16}-/);
			}
			expect(await tempResidue(dir)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("temp collision retries with a fresh name and still lands", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-safety-"));
		try {
			const target = join(dir, "collision.bin");
			let calls = 0;
			await atomicWriteFile(
				target,
				new TextEncoder().encode("landed"),
				{},
				async (tempPath, data) => {
					calls += 1;
					if (calls === 1) {
						const exists = new Error("injected collision");
						(exists as { code?: string }).code = "EEXIST";
						throw exists;
					}
					await nodeWriteFile(tempPath, data, { flag: "wx" });
				},
				{ randomSuffix: () => "fixedsuffix000000" },
			);
			expect(calls).toBe(2);
			expect(await readFile(target, "utf-8")).toBe("landed");
			expect(await tempResidue(dir)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("persistent temp collision is FILESYSTEM_ERROR with no residue", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-safety-"));
		try {
			const target = join(dir, "blocked.bin");
			let calls = 0;
			let code = "";
			try {
				await atomicWriteFile(
					target,
					new TextEncoder().encode("x"),
					{},
					async () => {
						calls += 1;
						const exists = new Error("always collides");
						(exists as { code?: string }).code = "EEXIST";
						throw exists;
					},
					{ randomSuffix: () => "fixedsuffix000001" },
				);
			} catch (error) {
				code = error instanceof McAssetError ? error.code : String(error);
			}
			expect(code).toBe("FILESYSTEM_ERROR");
			expect(calls).toBe(5);
			await expect(stat(target)).rejects.toThrow();
			expect(await tempResidue(dir)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("persistent collision never unlinks a foreign temp", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-safety-"));
		try {
			const target = join(dir, "blocked.bin");
			const unlinked: string[] = [];
			let calls = 0;
			let code = "";
			try {
				await atomicWriteFile(
					target,
					new TextEncoder().encode("x"),
					{},
					async () => {
						calls += 1;
						const exists = new Error("always collides");
						(exists as { code?: string }).code = "EEXIST";
						throw exists;
					},
					{
						randomSuffix: () => "fixedsuffix000003",
						unlinkFile: async (path) => {
							unlinked.push(path);
						},
					},
				);
			} catch (error) {
				code = error instanceof McAssetError ? error.code : String(error);
			}
			expect(code).toBe("FILESYSTEM_ERROR");
			expect(calls).toBe(5);
			// None of the collided temps was created by this call, so none
			// may be removed: ownership stays with whoever owns them.
			expect(unlinked).toEqual([]);
			await expect(stat(target)).rejects.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a collided temp owned by someone else survives the retry", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-safety-"));
		try {
			const target = join(dir, "landed.bin");
			const seen: string[] = [];
			let first = true;
			await atomicWriteFile(
				target,
				new TextEncoder().encode("landed"),
				{},
				async (tempPath, data) => {
					seen.push(tempPath);
					if (first) {
						first = false;
						await nodeWriteFile(tempPath, "FOREIGN");
						const exists = new Error("injected collision");
						(exists as { code?: string }).code = "EEXIST";
						throw exists;
					}
					await nodeWriteFile(tempPath, data, { flag: "wx" });
				},
				{ randomSuffix: () => "fixedsuffix000004" },
			);
			expect(seen.length).toBe(2);
			expect((seen[0] as string).length).toBeGreaterThan(0);
			expect(await readFile(seen[0] as string, "utf-8")).toBe("FOREIGN");
			expect(await readFile(target, "utf-8")).toBe("landed");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("rename failure leaves neither target nor temp behind", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-safety-"));
		try {
			const target = join(dir, "rename-fail.bin");
			let code = "";
			try {
				await atomicWriteFile(
					target,
					new TextEncoder().encode("x"),
					{},
					undefined,
					{
						renameFile: async () => {
							throw new Error("injected rename failure");
						},
					},
				);
			} catch (error) {
				code = error instanceof McAssetError ? error.code : String(error);
			}
			expect(code).toBe("FILESYSTEM_ERROR");
			await expect(stat(target)).rejects.toThrow();
			expect(await tempResidue(dir)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("file safety: symlink-aware preflight without spawning", () => {
	test("symlink parent alias is ARGUMENT_CONFLICT", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-safety-"));
		try {
			const realDir = join(dir, "real");
			await mkdir(realDir, { recursive: true });
			const linkDir = join(dir, "link");
			await symlink(realDir, linkDir);
			const input = join(realDir, "in.png");
			await writeVectorPng(realDir, "in.png");
			let code = "";
			try {
				await preflightArtifactTargets(
					{
						pngStdout: false,
						pngFiles: [{ path: join(linkDir, "in.png"), force: true }],
						mcpxFiles: [],
					},
					{ inputPath: input },
				);
			} catch (error) {
				code = error instanceof McAssetError ? error.code : String(error);
			}
			expect(code).toBe("ARGUMENT_CONFLICT");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("missing target under a symlinked parent still resolves the alias", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-safety-"));
		try {
			const realDir = join(dir, "real");
			await mkdir(realDir, { recursive: true });
			const linkDir = join(dir, "link");
			await symlink(realDir, linkDir);
			const input = join(realDir, "absent.png");
			let code = "";
			try {
				await preflightArtifactTargets(
					{
						pngStdout: false,
						pngFiles: [{ path: join(linkDir, "absent.png"), force: true }],
						mcpxFiles: [],
					},
					{ inputPath: input },
				);
			} catch (error) {
				code = error instanceof McAssetError ? error.code : String(error);
			}
			// Neither path exists, yet the symlinked parent anchors both keys
			// to the same canonical target.
			expect(code).toBe("ARGUMENT_CONFLICT");
			expect(basename(input)).toBe("absent.png");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("file safety: same-target concurrent writes are last-wins and whole", () => {
	test("two parallel forced writes leave one complete payload, no residue", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-safety-"));
		try {
			const target = join(dir, "race.bin");
			const first = new TextEncoder().encode(`first-${"A".repeat(4096)}`);
			const second = new TextEncoder().encode(`second-${"B".repeat(4096)}`);
			const codes = await Promise.all([
				atomicWriteFile(target, first, { force: true }).then(
					() => "ok",
					() => "fail",
				),
				atomicWriteFile(target, second, { force: true }).then(
					() => "ok",
					() => "fail",
				),
			]);
			// Best-effort preflight cannot serialize two writers; both pass and
			// the atomic rename decides. At least the file is always whole.
			expect(codes).toContain("ok");
			const final = new Uint8Array(await readFile(target));
			const isFirst =
				final.length === first.length &&
				final.every((byte, index) => byte === first[index]);
			const isSecond =
				final.length === second.length &&
				final.every((byte, index) => byte === second[index]);
			expect(isFirst || isSecond).toBe(true);
			expect(await tempResidue(dir)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
