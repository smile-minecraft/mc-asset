import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCliInProcess } from "../support/cli-runner.ts";
import { expectedProjectDocument, INIT_FILES } from "./pack-expectations.ts";

/**
 * Bun-only: the `pack init` command is exercised through the program entry,
 * which is what an agent actually calls. Plain Node cannot load this graph —
 * `src/cli/program.ts` imports `package.json` for the version and needs a
 * JSON import attribute there, so the flag wiring stays in this Bun entry
 * only. The shared `pack-init-cases.ts` covers the same engine under Bun and
 * Node, and `pack-init.node.ts` runs those under Node.
 */

async function withTempDir(
	body: (dir: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-cli-"));
	try {
		await body(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function envelope(result: { stdout: Uint8Array }): Record<string, unknown> {
	return JSON.parse(Buffer.from(result.stdout).toString("utf8")) as Record<
		string,
		unknown
	>;
}

/** With --json both envelopes land on stdout; the failure sits under `error`. */
function failureEnvelope(result: {
	stdout: Uint8Array;
}): Record<string, unknown> {
	return (envelope(result).error ?? {}) as Record<string, unknown>;
}

test("pack init passes --namespace, --minecraft-version, --style, and --name into the command", async () => {
	await withTempDir(async (dir) => {
		const projectDir = join(dir, "aurelian-forge");
		const run = await runCliInProcess([
			"pack",
			"init",
			projectDir,
			"--namespace",
			"aurelian",
			"--minecraft-version",
			"1.21.9",
			"--style",
			"soft",
			"--name",
			"aurelian-forge",
			"--json",
		]);
		expect(run.code).toBe(0);
		const result = (envelope(run).result ?? {}) as Record<string, unknown>;
		expect(result.mode).toBe("init");
		expect(result.projectDir).toBe(projectDir);
		expect(result.minecraftVersion).toBe("1.21.9");
		expect(result.packFormat).toBe("69.0");
		expect(result.files).toEqual([...INIT_FILES]);
		expect((await readdir(projectDir)).sort()).toEqual([
			"mc-asset.pack.json",
			"pack",
			"recipes",
		]);
		expect(
			JSON.parse(
				await readFile(join(projectDir, "mc-asset.pack.json"), "utf8"),
			) as unknown,
		).toEqual(expectedProjectDocument({ style: "soft" }));
	});
});

test("pack init passes --resource-pack-version and --allow-minecraft-namespace into the command", async () => {
	await withTempDir(async (dir) => {
		const projectDir = join(dir, "overridden-pack");
		const run = await runCliInProcess([
			"pack",
			"init",
			projectDir,
			"--namespace",
			"minecraft",
			"--minecraft-version",
			"26.3",
			"--name",
			"aurelian-forge",
			"--resource-pack-version",
			"46",
			"--allow-minecraft-namespace",
			"--json",
		]);
		expect(run.code).toBe(0);
		const result = (envelope(run).result ?? {}) as Record<string, unknown>;
		expect(result.packFormat).toBe("46.0");
		expect(
			JSON.parse(
				await readFile(join(projectDir, "mc-asset.pack.json"), "utf8"),
			) as unknown,
		).toEqual(
			expectedProjectDocument({
				allowMinecraftNamespace: true,
				minecraftVersion: "26.3",
				namespace: "minecraft",
				resourcePackVersion: "46.0",
			}),
		);
	});
});

test("pack init reports an occupied target with exit 4 and the conflict list", async () => {
	await withTempDir(async (dir) => {
		const projectDir = join(dir, "busy-pack");
		const first = await runCliInProcess([
			"pack",
			"init",
			projectDir,
			"--namespace",
			"aurelian",
			"--minecraft-version",
			"1.21.9",
			"--json",
		]);
		expect(first.code).toBe(0);
		const second = await runCliInProcess([
			"pack",
			"init",
			projectDir,
			"--namespace",
			"aurelian",
			"--minecraft-version",
			"1.21.9",
			"--json",
		]);
		expect(second.code).toBe(4);
		const failure = failureEnvelope(second);
		expect(failure.code).toBe("PACK_INIT_CONFLICT");
		expect((failure.details as Record<string, unknown>).conflicts).toEqual([
			"mc-asset.pack.json",
			"pack",
			"pack/assets",
			"pack/assets/aurelian",
			"pack/assets/aurelian/items",
			"pack/assets/aurelian/models",
			"pack/assets/aurelian/models/item",
			"pack/assets/aurelian/textures",
			"pack/assets/aurelian/textures/block",
			"pack/assets/aurelian/textures/item",
			"pack/pack.mcmeta",
			"pack/pack.png",
			"recipes",
		]);
	});
});

test("pack init refuses an unknown Minecraft version with exit 2", async () => {
	await withTempDir(async (dir) => {
		const projectDir = join(dir, "unknown-pack");
		const run = await runCliInProcess([
			"pack",
			"init",
			projectDir,
			"--namespace",
			"aurelian",
			"--minecraft-version",
			"1.99",
			"--json",
		]);
		expect(run.code).toBe(2);
		const failure = failureEnvelope(run);
		expect(failure.code).toBe("INVALID_ARGUMENT");
		expect((failure.details as Record<string, unknown>).minecraftVersion).toBe(
			"1.99",
		);
		expect(await readdir(projectDir).catch(() => [])).toEqual([]);
	});
});
