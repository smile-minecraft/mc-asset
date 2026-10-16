import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const HARNESS = join(ROOT, "scripts", "compare-runtime.mjs");
const GRID_FIXTURE = join(ROOT, "tests", "cli", "fixtures", "tiny.grid");
const MCPX_FIXTURE = join(ROOT, "tests", "cli", "fixtures", "sword.mcpx");

/**
 * Full-suite opt-in. The comparison below shells out to
 * scripts/compare-runtime.mjs (needs dist/, about 25 seconds). CI already runs
 * that harness as its own step, so the default `bun test` keeps only the
 * three fast checks. Set MC_ASSET_FULL_TESTS=1 (the "test:full" script) to
 * include the comparison locally.
 */
const RUN_FULL_SUITE = /^(1|true|yes)$/i.test(
	process.env.MC_ASSET_FULL_TESTS ?? "",
);

describe("runtime equivalence harness (rel-t03)", () => {
	test("harness script exists and uses only Node builtins", () => {
		expect(existsSync(HARNESS)).toBe(true);
		const text = readFileSync(HARNESS, "utf-8");
		expect(text).not.toMatch(/from ["']bun["']/);
		expect(text).not.toContain("Bun.");
	});

	test("fixed fixtures exist for the comparison", () => {
		expect(existsSync(GRID_FIXTURE)).toBe(true);
		expect(existsSync(MCPX_FIXTURE)).toBe(true);
	});

	test("canonical JSON comparison ignores key order but catches one changed byte", async () => {
		const harness = await import(HARNESS);
		const a = harness.canonicalize({ alpha: 1, beta: [1, 2] });
		const reordered = harness.canonicalize({ beta: [1, 2], alpha: 1 });
		expect(a).toBe(reordered);
		const tampered = `${a.slice(0, -2)}X\n`;
		expect(harness.sha256Hex(a)).not.toBe(harness.sha256Hex(tampered));
		expect(harness.buffersEqual(Buffer.from(a), Buffer.from(tampered))).toBe(
			false,
		);
		expect(harness.buffersEqual(Buffer.from(a), Buffer.from(a))).toBe(true);
	});

	test.skipIf(!RUN_FULL_SUITE)(
		"bun source CLI and node bundle agree on fixed fixtures",
		() => {
			const run = spawnSync("node", [HARNESS], {
				cwd: ROOT,
				encoding: "utf-8",
			});
			const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
			if ((run.status ?? 1) !== 0) {
				throw new Error(`compare-runtime failed:\n${output}`);
			}
			for (const label of ["render.png", "render.mcpx", "build.mcpx"]) {
				expect(output).toContain(label);
			}
		},
		120_000,
	);
});
