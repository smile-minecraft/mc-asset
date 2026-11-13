import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executePackBuild, planPackBuild } from "../../src/pack/build.ts";
import { initializePackProject } from "../../src/pack/init.ts";
import { getToolVersion, parseLockText } from "../../src/pack/lock.ts";
import { requirePackageVersion } from "../../src/version.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Read straight from package.json so the check does not trust the engine. */
const PACKAGE_VERSION = (
	JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
		version: string;
	}
).version;

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

export interface ToolVersionCase {
	readonly name: string;
	run(): void | Promise<void>;
}

export const TOOL_VERSION_CASES: readonly ToolVersionCase[] = [
	{
		name: "getToolVersion reports the package.json version",
		run() {
			assert.equal(getToolVersion(), PACKAGE_VERSION);
		},
	},
	{
		name: "a pack build records the package.json version in the lock",
		async run() {
			const dir = await mkdtemp(join(tmpdir(), "mc-asset-tool-version-"));
			try {
				const projectDir = join(dir, "project");
				await initializePackProject({
					projectDir,
					namespace: "aurelian",
					minecraftVersion: "1.21.9",
					name: "tool-version",
				});
				const recipeDir = join(projectDir, "recipes", "sources");
				await mkdir(recipeDir, { recursive: true });
				await writeFile(join(projectDir, "recipes", "one.recipe.json"), RECIPE);
				await writeFile(join(recipeDir, "one.grid"), GRID);
				const project = join(projectDir, "mc-asset.pack.json");
				const executed = await executePackBuild(await planPackBuild(project));
				assert.equal(executed.completed.length, 1, "one output is written");
				const lock = parseLockText(
					await readFile(join(projectDir, "mc-asset.lock.json"), "utf8"),
				);
				assert.equal(lock.tool.name, "mc-asset");
				assert.equal(lock.tool.version, PACKAGE_VERSION);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	},
	{
		name: "a missing or blank package version is refused, not substituted",
		run() {
			assert.equal(requirePackageVersion("1.2.3"), "1.2.3");
			assert.throws(() => requirePackageVersion(""), /version/);
			assert.throws(() => requirePackageVersion("   "), /version/);
			assert.throws(() => requirePackageVersion(undefined), /version/);
			assert.throws(() => requirePackageVersion(7), /version/);
		},
	},
];
