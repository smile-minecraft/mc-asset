import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Bun-only: these checks bundle the version module with `bun build` (the same
 * bundler scripts/build.mjs drives) and then run the result with plain Node.
 * The shared `tool-version-cases.ts` covers the source path under both
 * runtimes; this entry covers the installed-bundle path.
 */

const ROOT = resolve(import.meta.dir, "..", "..");
const LOCK_MODULE = join(ROOT, "src", "pack", "lock.ts");
const NODE_BUNDLE = join(ROOT, "dist", "mc-asset.js");

const GRID = `[palette]
. = transparent
M = #C8C8C8FF
D = #6E6E6EFF

[grid]
......MM........
.....MMMM.......
.....MMMM.......
.....MMMM.......
.....MMMM.......
....DMMMMD......
.....MMMM.......
.....MMMM.......
.......MM.......
.......MM.......
.......MM.......
.......MM.......
.......MM.......
.......MM.......
.......MM.......
.......MM.......
`;

const RECIPE = `${JSON.stringify(
	{
		formatVersion: 1,
		id: "one",
		style: "vanilla",
		sources: { one_grid: { kind: "grid", path: "sources/one.grid" } },
		targets: [
			{
				id: "one_iron",
				source: "one_grid",
				output: "assets/aurelian/textures/item/one_iron.png",
				steps: [{ type: "recolor", family: "iron" }],
			},
		],
	},
	null,
	2,
)}\n`;

interface CommandResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

function run(
	command: string,
	args: readonly string[],
	cwd: string,
): CommandResult {
	const result = spawnSync(command, [...args], { cwd, encoding: "utf-8" });
	return {
		status: result.status,
		stdout: typeof result.stdout === "string" ? result.stdout : "",
		stderr: typeof result.stderr === "string" ? result.stderr : "",
	};
}

function expectSuccess(result: CommandResult, label: string): void {
	expect(result.status, `${label} failed:\n${result.stderr}`).toBe(0);
}

function envelopeResult(
	result: CommandResult,
	label: string,
): Record<string, unknown> {
	expectSuccess(result, label);
	const envelope = JSON.parse(result.stdout) as {
		success?: boolean;
		result?: Record<string, unknown>;
	};
	expect(envelope.success, `${label} reported failure: ${result.stdout}`).toBe(
		true,
	);
	return envelope.result ?? {};
}

async function packageVersion(): Promise<string> {
	const pkg = JSON.parse(
		await readFile(join(ROOT, "package.json"), "utf-8"),
	) as { version: string };
	return pkg.version;
}

test("a bundle keeps the package.json version outside the package root", async () => {
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-bundled-version-"));
	try {
		// The bundle sits two levels deep in its own tree, so a version lookup
		// relative to the bundle cannot reach the repository package.json.
		const outDir = join(dir, "nested", "deep");
		await mkdir(outDir, { recursive: true });
		const entry = join(dir, "entry.ts");
		await writeFile(
			entry,
			`import { getToolVersion } from ${JSON.stringify(LOCK_MODULE)};\nprocess.stdout.write(getToolVersion());\n`,
		);
		const bundle = join(outDir, "bundle.js");
		expectSuccess(
			run(
				"bun",
				[
					"build",
					entry,
					"--target",
					"node",
					"--format",
					"esm",
					"--outfile",
					bundle,
				],
				dir,
			),
			"bun build",
		);
		expect(existsSync(join(dir, "package.json"))).toBe(false);
		const executed = run("node", [bundle], outDir);
		expectSuccess(executed, "node bundle");
		expect(executed.stdout).toBe(await packageVersion());
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}, 60_000);

test("source CLI and bundled CLI keep the same lock across alternating builds", async () => {
	expectSuccess(run("bun", ["run", "build"], ROOT), "bun run build");
	const version = await packageVersion();
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-alternating-"));
	try {
		const projectDir = join(dir, "project");
		expectSuccess(
			run(
				"bun",
				[
					"src/cli/index.ts",
					"pack",
					"init",
					projectDir,
					"--namespace",
					"aurelian",
					"--minecraft-version",
					"1.21.9",
					"--json",
				],
				ROOT,
			),
			"pack init",
		);
		const recipeDir = join(projectDir, "recipes", "sources");
		await mkdir(recipeDir, { recursive: true });
		await writeFile(join(projectDir, "recipes", "one.recipe.json"), RECIPE);
		await writeFile(join(recipeDir, "one.grid"), GRID);

		const project = join(projectDir, "mc-asset.pack.json");
		const lockPath = join(projectDir, "mc-asset.lock.json");
		const buildArgs = ["pack", "build", "--project", project, "--json"];
		const sourceBuild = () =>
			envelopeResult(
				run("bun", ["src/cli/index.ts", ...buildArgs], ROOT),
				"source build",
			);
		const bundledBuild = () =>
			envelopeResult(
				run("node", [NODE_BUNDLE, ...buildArgs], ROOT),
				"bundled build",
			);

		const first = sourceBuild();
		expect(first.completed).toHaveLength(1);
		const lockBytes = await readFile(lockPath);
		expect(
			(JSON.parse(lockBytes.toString("utf8")) as { tool: { version: string } })
				.tool.version,
		).toBe(version);

		const second = bundledBuild();
		expect(second.completed).toEqual([]);
		const afterBundle = await readFile(lockPath);
		expect(afterBundle.toString("hex")).toBe(lockBytes.toString("hex"));
		expect(
			(
				JSON.parse(afterBundle.toString("utf8")) as {
					tool: { version: string };
				}
			).tool.version,
		).toBe(version);

		const third = sourceBuild();
		expect(third.completed).toEqual([]);
		expect((await readFile(lockPath)).toString("hex")).toBe(
			lockBytes.toString("hex"),
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}, 120_000);
