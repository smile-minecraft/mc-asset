import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	emitArtifact,
	emitEnvelope,
	emitLog,
	routeStreams,
} from "../../src/cli/channels.ts";
import { errorEnvelope, successEnvelope } from "../../src/cli/envelope.ts";
import { atomicWriteFile } from "../../src/cli/filesystem.ts";
import { McAssetError } from "../../src/core/errors.ts";
import { type CaseCheck, CLI_CASES } from "./cli-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, _message) => expect(actual).toBe(expected),
	deepEqual: (actual, expected, _message) => expect(actual).toEqual(expected),
	ok: (value, _message) => expect(value).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
	throwsCode: (fn, code, _message) => expect(fn).toThrow(code),
};

describe("cli framework pure cases", () => {
	for (const cliCase of CLI_CASES) {
		test(cliCase.name, () => {
			cliCase.run(check);
		});
	}
});

interface MemoryStream {
	data: Array<string | Uint8Array>;
	write(chunk: string | Uint8Array): void;
}

function memoryStream(): MemoryStream {
	return {
		data: [],
		write(chunk: string | Uint8Array): void {
			this.data.push(chunk);
		},
	};
}

function streamText(stream: MemoryStream): string {
	return stream.data
		.map((chunk) =>
			typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"),
		)
		.join("");
}

describe("cli channel helpers with injected streams", () => {
	test("default mode keeps human output on stdout", () => {
		const stdout = memoryStream();
		const stderr = memoryStream();
		const route = routeStreams({ json: false, stdoutArtifact: false });
		emitLog("hello human", { stdout, stderr }, route);
		expect(streamText(stdout)).toContain("hello human");
		expect(streamText(stderr)).toBe("");
	});

	test("progress and warnings never reach stdout", () => {
		const stdout = memoryStream();
		const stderr = memoryStream();
		const route = routeStreams({ json: true, stdoutArtifact: true });
		emitLog("working…", { stdout, stderr }, route);
		emitEnvelope(successEnvelope({}), { stdout, stderr }, route);
		expect(streamText(stdout)).not.toContain("working…");
		expect(streamText(stderr)).toContain("working…");
	});

	test("--json --stdout keeps artifact bytes alone on stdout", () => {
		const stdout = memoryStream();
		const stderr = memoryStream();
		const route = routeStreams({ json: true, stdoutArtifact: true });
		const artifact = new TextEncoder().encode("PNG-BYTES");
		emitArtifact(artifact, { stdout, stderr }, route);
		emitEnvelope(successEnvelope({ applied: 1 }), { stdout, stderr }, route);
		const stdoutBytes = Buffer.concat(
			stdout.data.map((chunk) =>
				typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk),
			),
		).toString("utf-8");
		expect(stdoutBytes).toBe("PNG-BYTES");
		const stderrText = streamText(stderr);
		expect(stderrText).toContain('"success":true');
		expect(stderrText).not.toContain("PNG-BYTES");
	});
});

describe("cli atomic write and output guards", () => {
	test("atomic write creates the target with no temp residue", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cli-"));
		try {
			const target = join(dir, "sword.bin");
			await atomicWriteFile(target, new TextEncoder().encode("payload"), {});
			expect(await readFile(target, "utf-8")).toBe("payload");
			const leftovers = await listTempFiles(dir);
			expect(leftovers).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("OUTPUT_EXISTS default refuses without writing a byte", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cli-"));
		try {
			const target = join(dir, "exists.bin");
			await atomicWriteFile(target, new TextEncoder().encode("original"), {
				force: true,
			});
			let code = "";
			let message = "";
			try {
				await atomicWriteFile(
					target,
					new TextEncoder().encode("new-bytes"),
					{},
				);
			} catch (error) {
				code = error instanceof McAssetError ? error.code : String(error);
				message = error instanceof McAssetError ? error.message : String(error);
			}
			expect(code).toBe("OUTPUT_EXISTS");
			expect(message).toContain("--force");
			expect(await readFile(target, "utf-8")).toBe("original");
			expect(await listTempFiles(dir)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("--force overwrites the existing target", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cli-"));
		try {
			const target = join(dir, "overwrite.bin");
			await atomicWriteFile(target, new TextEncoder().encode("v1"), {
				force: true,
			});
			await atomicWriteFile(target, new TextEncoder().encode("v2"), {
				force: true,
			});
			expect(await readFile(target, "utf-8")).toBe("v2");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("missing parent without --mkdir is FILESYSTEM_ERROR with no dirs created", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cli-"));
		try {
			const target = join(dir, "no-such-dir", "nested", "out.bin");
			let code = "";
			let message = "";
			try {
				await atomicWriteFile(target, new TextEncoder().encode("x"), {});
			} catch (error) {
				code = error instanceof McAssetError ? error.code : String(error);
				message = error instanceof McAssetError ? error.message : String(error);
			}
			expect(code).toBe("FILESYSTEM_ERROR");
			expect(message).toContain("--mkdir");
			await expect(stat(join(dir, "no-such-dir"))).rejects.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("--mkdir creates missing parents then writes atomically", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cli-"));
		try {
			const target = join(dir, "fresh", "nested", "out.bin");
			await atomicWriteFile(target, new TextEncoder().encode("made"), {
				mkdir: true,
			});
			expect(await readFile(target, "utf-8")).toBe("made");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("failed write leaves neither target nor temp behind", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cli-"));
		try {
			const target = join(dir, "unwritable.bin");
			let code = "";
			try {
				await atomicWriteFile(
					target,
					new TextEncoder().encode("x"),
					{},
					async () => {
						throw new Error("injected write failure");
					},
				);
			} catch (error) {
				code = error instanceof McAssetError ? error.code : String(error);
			}
			expect(code).toBe("FILESYSTEM_ERROR");
			await expect(stat(target)).rejects.toThrow();
			expect(await listTempFiles(dir)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("error envelope without details omits the field", () => {
		const envelope = errorEnvelope("OUTPUT_REQUIRED", "Missing output.");
		expect(envelope).toEqual({
			success: false,
			error: { code: "OUTPUT_REQUIRED", message: "Missing output." },
		});
	});
});

async function listTempFiles(dir: string): Promise<string[]> {
	const { readdir } = await import("node:fs/promises");
	const entries = await readdir(dir);
	return entries.filter((name) => name.startsWith(".tmp-"));
}

// CLI behavior below needs real subprocesses, so it stays in this bun:test
// entry on purpose: the node:test mirror (cli.node.ts) only runs the pure
// cases above, keeping the dual entrypoint green on both runtimes.

describe("cli program smoke via spawn", () => {
	test("--help exits 0 and lists commands", async () => {
		const proc = Bun.spawn(["bun", "src/cli/index.ts", "--help"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(code).toBe(0);
		expect(out + err).toContain("stub");
	}, 30_000);

	test("--version exits 0", async () => {
		const proc = Bun.spawn(["bun", "src/cli/index.ts", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, code] = await Promise.all([
			new Response(proc.stdout).text(),
			proc.exited,
		]);
		expect(code).toBe(0);
		expect(out.trim().length).toBeGreaterThan(0);
	}, 30_000);

	test("stub without --output/--stdout is OUTPUT_REQUIRED with no files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cli-"));
		try {
			const before = await listAllFiles(dir);
			const proc = Bun.spawn(["bun", "src/cli/index.ts", "stub"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, err, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(code).toBe(2);
			expect(out + err).toContain("OUTPUT_REQUIRED");
			expect(await listAllFiles(dir)).toEqual(before);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("stub --json --stdout keeps stdout as pure artifact bytes", async () => {
		const proc = Bun.spawn(
			["bun", "src/cli/index.ts", "stub", "--json", "--stdout"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const [stdoutBytes, stderrText, code] = await Promise.all([
			new Response(proc.stdout).arrayBuffer(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(code).toBe(0);
		const artifact = Buffer.from(stdoutBytes).toString("utf-8");
		expect(artifact.length).toBeGreaterThan(0);
		expect(artifact).not.toContain("success");
		const envelope = JSON.parse(stderrText) as {
			success: boolean;
			result: unknown;
		};
		expect(envelope.success).toBe(true);
	}, 30_000);

	test("stub --output writes atomically and refuses twice without --force", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-cli-"));
		try {
			const target = join(dir, "stub-out.bin");
			const first = Bun.spawn(
				["bun", "src/cli/index.ts", "stub", "--output", target],
				{ stdout: "pipe", stderr: "pipe" },
			);
			expect(await first.exited).toBe(0);
			expect(await readFile(target, "utf-8")).toContain("stub-ok");
			const second = Bun.spawn(
				["bun", "src/cli/index.ts", "stub", "--output", target],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const [secondOut, secondErr, secondCode] = await Promise.all([
				new Response(second.stdout).text(),
				new Response(second.stderr).text(),
				second.exited,
			]);
			expect(secondCode).toBe(4);
			expect(secondOut + secondErr).toContain("OUTPUT_EXISTS");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});

async function listAllFiles(dir: string): Promise<string[]> {
	const { readdir } = await import("node:fs/promises");
	const entries = await readdir(dir, { recursive: true });
	return [...entries].sort();
}
