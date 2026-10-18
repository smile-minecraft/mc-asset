import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCliInProcess } from "../support/cli-runner.ts";
import { expectedFamilyMcpx } from "./style-expectations.ts";

/**
 * Bun-only: the `style` command group is exercised through the program
 * entry, which is what an agent actually calls. Plain Node cannot load
 * this graph — `src/cli/program.ts` imports `package.json` for the version
 * and needs a JSON import attribute there, so the command-level flags stay
 * out of the shared cases and live in this Bun entry only. The shared
 * `style-cases.ts` covers the same modes through `runStyle` directly, and
 * `style.node.ts` runs those under Node.
 */

async function withTempDir(
	body: (dir: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-style-cli-"));
	try {
		await body(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Parse JSON without throwing, so an unwritten payload fails as a mismatch. */
function jsonOrNull(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

function envelope(result: { stdout: Uint8Array }): Record<string, unknown> {
	return JSON.parse(Buffer.from(result.stdout).toString("utf8")) as Record<
		string,
		unknown
	>;
}

test("style export-palette passes --family and --output into the command", async () => {
	await withTempDir(async (dir) => {
		const output = join(dir, "iron.mcpx");
		const run = await runCliInProcess([
			"style",
			"export-palette",
			"vanilla",
			"--family",
			"iron",
			"--output",
			output,
			"--json",
		]);
		expect(run.code).toBe(0);
		const result = (envelope(run).result ?? {}) as Record<string, unknown>;
		expect(result.mode).toBe("export-palette");
		expect(result.family).toBe("iron");
		expect(result.output).toBe(output);
		expect(await readFile(output, "utf8")).toBe(
			expectedFamilyMcpx("vanilla", "iron"),
		);
	});
});

test("style create passes --id, --name, --extends, and --output into the command", async () => {
	await withTempDir(async (dir) => {
		const output = join(dir, "iron-tide.style.json");
		const run = await runCliInProcess([
			"style",
			"create",
			"--id",
			"iron-tide",
			"--name",
			"鐵潮",
			"--extends",
			"vanilla",
			"--output",
			output,
			"--json",
		]);
		expect(run.code).toBe(0);
		const result = (envelope(run).result ?? {}) as Record<string, unknown>;
		expect(result.mode).toBe("create");
		expect(result.id).toBe("iron-tide");
		expect(result.output).toBe(output);
		expect(jsonOrNull(await readFile(output, "utf8"))).toEqual({
			formatVersion: 1,
			id: "iron-tide",
			name: "鐵潮",
			extends: "vanilla",
		});
	});
});

test("style list and show need no file flags and report through the program entry", async () => {
	const list = await runCliInProcess(["style", "list", "--json"]);
	expect(list.code).toBe(0);
	expect((envelope(list).result as Record<string, unknown>).mode).toBe("list");
	const show = await runCliInProcess(["style", "show", "vanilla", "--json"]);
	expect(show.code).toBe(0);
	const style = ((envelope(show).result as Record<string, unknown>).style ??
		{}) as Record<string, unknown>;
	expect(style.id).toBe("vanilla");
	expect(Object.keys(style.palettes as Record<string, unknown>)).toHaveLength(
		12,
	);
});
