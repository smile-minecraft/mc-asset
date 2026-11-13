import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { executePackBuild, planPackBuild } from "../../src/pack/build.ts";
import { checkResourcePack } from "../../src/pack/check.ts";
import { initializePackProject } from "../../src/pack/init.ts";

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

function recipeText(style?: string): string {
	const recipe: Record<string, unknown> = {
		formatVersion: 1,
		id: "one",
		sources: { one_grid: { kind: "grid", path: "sources/one.grid" } },
		targets: [
			{
				id: "one_iron",
				source: "one_grid",
				output: "assets/aurelian/textures/item/one_iron.png",
				steps: [{ type: "recolor", family: "iron" }],
			},
		],
	};
	if (style !== undefined) {
		recipe.style = style;
	}
	return `${JSON.stringify(recipe, null, 2)}\n`;
}

const CUSTOM_STYLE = `${JSON.stringify(
	{ formatVersion: 1, id: "custom-test", name: "custom test", extends: "soft" },
	null,
	2,
)}\n`;

const INVALID_STYLE = `${JSON.stringify({ formatVersion: 1, unknown: true }, null, 2)}\n`;

async function withProject(
	run: (projectDir: string) => Promise<void>,
	recipeStyle?: string,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-project-style-"));
	try {
		const projectDir = join(dir, "project");
		await initializePackProject({
			projectDir,
			namespace: "aurelian",
			minecraftVersion: "1.21.9",
			name: "project-style",
		});
		await mkdir(join(projectDir, "recipes", "sources"), { recursive: true });
		await writeFile(
			join(projectDir, "recipes", "one.recipe.json"),
			recipeText(recipeStyle),
		);
		await writeFile(join(projectDir, "recipes", "sources", "one.grid"), GRID);
		await run(projectDir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function projectPathOf(projectDir: string): string {
	return join(projectDir, "mc-asset.pack.json");
}

async function setProjectStyle(
	projectDir: string,
	style: string,
): Promise<void> {
	const path = projectPathOf(projectDir);
	const doc = JSON.parse(await readFile(path, "utf8")) as Record<
		string,
		unknown
	>;
	doc.style = style;
	await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
}

async function writeInProject(
	projectDir: string,
	relativePath: string,
	text: string,
): Promise<void> {
	const full = join(projectDir, relativePath);
	await mkdir(dirname(full), { recursive: true });
	await writeFile(full, text);
}

async function build(projectDir: string) {
	return executePackBuild(await planPackBuild(projectPathOf(projectDir)));
}

async function rejectionCode(
	work: Promise<unknown>,
): Promise<string | undefined> {
	try {
		await work;
		return undefined;
	} catch (error) {
		return (error as { code?: string }).code;
	}
}

export interface ProjectStyleCase {
	readonly name: string;
	run(): void | Promise<void>;
}

export const PROJECT_STYLE_CASES: readonly ProjectStyleCase[] = [
	{
		name: "a project style path is resolved against the project directory by build and check",
		async run() {
			await withProject(async (projectDir) => {
				await setProjectStyle(projectDir, "styles/custom.style.json");
				await writeInProject(
					projectDir,
					"styles/custom.style.json",
					CUSTOM_STYLE,
				);
				const executed = await build(projectDir).catch((error) => {
					assert.fail(
						`build failed: ${(error as { code?: string }).code ?? String(error)}`,
					);
				});
				assert.equal(executed.completed.length, 1);
				const summary = await checkResourcePack({
					projectPath: projectPathOf(projectDir),
				});
				assert.notEqual(summary.verdict, "fail");
				assert.ok(!summary.groups.some((g) => g.code === "STYLE_INVALID"));
			});
		},
	},
	{
		name: "a project style file that exists only beside the recipe is not found",
		async run() {
			await withProject(async (projectDir) => {
				await setProjectStyle(projectDir, "styles/custom.style.json");
				await writeInProject(
					projectDir,
					"recipes/styles/custom.style.json",
					CUSTOM_STYLE,
				);
				const code = await rejectionCode(
					planPackBuild(projectPathOf(projectDir)),
				);
				assert.equal(code, "STYLE_INVALID");
			});
		},
	},
	{
		name: "a recipe style path stays relative to the recipe file",
		async run() {
			await withProject(async (projectDir) => {
				await writeInProject(
					projectDir,
					"recipes/styles/recipe.style.json",
					CUSTOM_STYLE,
				);
				const executed = await build(projectDir);
				assert.equal(executed.completed.length, 1);
			}, "styles/recipe.style.json");
		},
	},
	{
		name: "a builtin preset id as the project style resolves in build and check",
		async run() {
			await withProject(async (projectDir) => {
				await setProjectStyle(projectDir, "soft");
				const executed = await build(projectDir);
				assert.equal(executed.completed.length, 1);
				const summary = await checkResourcePack({
					projectPath: projectPathOf(projectDir),
				});
				assert.notEqual(summary.verdict, "fail");
				assert.ok(!summary.groups.some((g) => g.code === "STYLE_INVALID"));
			});
		},
	},
	{
		name: "check reports a missing project style instead of falling back to vanilla",
		async run() {
			await withProject(async (projectDir) => {
				await setProjectStyle(projectDir, "styles/missing.style.json");
				const summary = await checkResourcePack({
					projectPath: projectPathOf(projectDir),
				});
				assert.equal(summary.verdict, "fail");
				assert.ok(summary.groups.some((g) => g.code === "STYLE_INVALID"));
			});
		},
	},
	{
		name: "check reports an invalid project style with the underlying code",
		async run() {
			await withProject(async (projectDir) => {
				await setProjectStyle(projectDir, "styles/bad.style.json");
				await writeInProject(
					projectDir,
					"styles/bad.style.json",
					INVALID_STYLE,
				);
				const summary = await checkResourcePack({
					projectPath: projectPathOf(projectDir),
				});
				assert.equal(summary.verdict, "fail");
				assert.ok(summary.groups.some((g) => g.code === "STYLE_INVALID"));
			});
		},
	},
	{
		name: "the check result for a project style does not depend on the working directory",
		async run() {
			await withProject(async (projectDir) => {
				await setProjectStyle(projectDir, "styles/bad.style.json");
				await writeInProject(
					projectDir,
					"styles/bad.style.json",
					INVALID_STYLE,
				);
				const other = await mkdtemp(
					join(tmpdir(), "mc-asset-project-style-cwd-"),
				);
				const origin = process.cwd();
				try {
					for (const cwd of [projectDir, other]) {
						process.chdir(cwd);
						const summary = await checkResourcePack({
							projectPath: projectPathOf(projectDir),
						});
						assert.equal(summary.verdict, "fail", `cwd ${cwd}`);
						assert.ok(
							summary.groups.some((g) => g.code === "STYLE_INVALID"),
							`cwd ${cwd}`,
						);
					}
				} finally {
					process.chdir(origin);
					await rm(other, { recursive: true, force: true });
				}
			});
		},
	},
];
