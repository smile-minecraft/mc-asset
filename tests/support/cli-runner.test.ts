import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliResult, runCliInProcess } from "./cli-runner.ts";

interface SpawnResult {
	code: number;
	stdout: Uint8Array;
	stderr: string;
}

async function spawnCli(
	args: string[],
	stdin?: Uint8Array,
): Promise<SpawnResult> {
	const proc = Bun.spawn(["bun", "src/cli/index.ts", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: stdin === undefined ? "ignore" : stdin,
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout: new Uint8Array(stdout), stderr };
}

function expectSameResult(actual: CliResult, expected: SpawnResult): void {
	expect(actual.code).toBe(expected.code);
	expect(Buffer.from(actual.stdout).equals(Buffer.from(expected.stdout))).toBe(
		true,
	);
	expect(actual.stderr).toBe(expected.stderr);
}

const SWORD_MCPX = "tests/cli/fixtures/sword.mcpx";

describe("in-process cli runner", () => {
	test("successful generate reports code 0 with the log on stdout", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-runner-"));
		try {
			const result = await runCliInProcess([
				"generate",
				"stripes",
				"--size",
				"8",
				"--palette",
				"stone",
				"--seed",
				"5",
				"--output",
				join(dir, "gen.png"),
			]);
			expect(result.code).toBe(0);
			expect(Buffer.from(result.stdout).toString("utf-8")).toContain(
				"ok generate",
			);
			expect(result.stderr).toBe("");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("error paths match the subprocess byte for byte", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-runner-"));
		try {
			const cases: string[][] = [
				[
					"generate",
					"noise",
					"--size",
					"8",
					"--palette",
					"stone",
					"--seed",
					"1",
					"--output",
					join(dir, "x.png"),
					"--input",
					"x",
				],
				["--json", "generate", "noise"],
				[
					"--json",
					"generate",
					"checker",
					"--size",
					"8",
					"--palette",
					join(dir, "no-such.mcpx"),
					"--seed",
					"3",
					"--output",
					join(dir, "missing.png"),
				],
				["--help"],
				["--version"],
			];
			for (const args of cases) {
				const [actual, expected] = await Promise.all([
					runCliInProcess(args),
					spawnCli(args),
				]);
				expectSameResult(actual, expected);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("a nonzero exit does not leak into the next call", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-runner-"));
		const before = process.exitCode;
		process.exitCode = 7;
		try {
			const failing = await runCliInProcess(["--json", "generate", "noise"]);
			expect(failing.code).toBe(2);
			const passing = await runCliInProcess([
				"generate",
				"stripes",
				"--size",
				"8",
				"--palette",
				"stone",
				"--seed",
				"5",
				"--output",
				join(dir, "gen.png"),
			]);
			expect(passing.code).toBe(0);
			expect(process.exitCode).toBe(7);
		} finally {
			process.exitCode = before;
			await rm(dir, { recursive: true, force: true });
		}
		expect(process.exitCode).toBe(before);
	}, 30_000);

	test("--stdout artifact bytes match file output and the subprocess", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-runner-"));
		try {
			const args = [
				"generate",
				"stripes",
				"--size",
				"8",
				"--palette",
				"stone",
				"--seed",
				"5",
			];
			const out = join(dir, "gen.png");
			const filed = await runCliInProcess([...args, "--output", out]);
			expect(filed.code).toBe(0);
			const [viaStdout, viaSpawn] = await Promise.all([
				runCliInProcess([...args, "--stdout"]),
				spawnCli([...args, "--stdout"]),
			]);
			expect(viaStdout.code).toBe(0);
			expectSameResult(viaStdout, viaSpawn);
			expect(
				Buffer.from(viaStdout.stdout).equals(Buffer.from(await readFile(out))),
			).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("stdin reaches commands that read it and stdio state is restored", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-runner-"));
		const savedStdin = process.stdin;
		const savedExit = process.exitCode;
		try {
			const source = await readFile(SWORD_MCPX, "utf-8");
			const stdinBytes = new TextEncoder().encode(source);
			const inProcessOut = join(dir, "in-process.png");
			const spawnedOut = join(dir, "spawned.png");
			const [actual, expected] = await Promise.all([
				runCliInProcess(["build", "--stdin", "--output", inProcessOut], {
					stdin: stdinBytes,
				}),
				spawnCli(["build", "--stdin", "--output", spawnedOut], stdinBytes),
			]);
			expect(actual.code).toBe(0);
			// The success log names the output file, so normalize the path
			// before comparing: the two runs must target different files.
			const normalizedStdout = Buffer.from(actual.stdout)
				.toString("utf-8")
				.split(inProcessOut)
				.join(spawnedOut);
			expect(actual.code).toBe(expected.code);
			expect(
				Buffer.from(normalizedStdout).equals(Buffer.from(expected.stdout)),
			).toBe(true);
			expect(actual.stderr).toBe(expected.stderr);
			expect(
				Buffer.from(await readFile(inProcessOut)).equals(
					Buffer.from(await readFile(spawnedOut)),
				),
			).toBe(true);
			expect(process.stdin).toBe(savedStdin);
			expect(process.exitCode).toBe(savedExit);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
