import { expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePackAsset } from "../../src/mcp/handlers.ts";
import { initializePackProject } from "../../src/pack/init.ts";
import { runCliInProcess } from "../support/cli-runner.ts";

/**
 * Bun-only: `pack build` is exercised through the program entry. Plain Node
 * cannot load that graph (see pack-cli.test.ts for the import-attribute
 * reason), so the flag wiring stays in this Bun entry only.
 */

const NAMESPACE = "aurelian";
const MATERIALS = [
	"iron",
	"gold",
	"diamond",
	"netherite",
	"copper",
	"wood",
	"stone",
] as const;
const TOOLS = ["sword", "pickaxe", "axe", "shovel", "hoe"] as const;

const GRID = `; original 16x16 tool grid
[palette]
. = transparent
M = #C8C8C8FF
D = #6E6E6EFF
H = #8A5A2BFF

[grid]
......MM........
.....MMMM.......
.....MMMM.......
.....MMMM.......
.....MMMM.......
....DMMMMD......
.....MMMM.......
.....MMMM.......
.......HH.......
.......HH.......
.......HH.......
.......HH.......
.......HH.......
.......HH.......
.......HH.......
.......HH.......
`;

const RECIPE = `${JSON.stringify(
	{
		formatVersion: 1,
		id: "tool-matrix",
		style: "vanilla",
		variables: {
			material: [...MATERIALS],
			tool: [...TOOLS],
		},
		sources: Object.fromEntries(
			TOOLS.map((tool) => [
				`${tool}_grid`,
				{ kind: "grid", path: `sources/${tool}.grid` },
			]),
		),
		targets: [
			{
				id: "{material}_{tool}",
				category: "{tool}",
				source: "{tool}_grid",
				output: "assets/{namespace}/textures/item/{material}_{tool}.png",
				steps: [
					{ type: "recolor", family: "{material}" },
					{ type: "outline", mode: "tinted", position: "inside" },
				],
			},
		],
	},
	null,
	2,
)}\n`;

async function withProject(
	body: (projectDir: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-pack-build-"));
	try {
		const projectDir = join(dir, "aurelian-forge");
		await initializePackProject({
			projectDir,
			namespace: NAMESPACE,
			minecraftVersion: "1.21.9",
			name: "aurelian-forge",
		});
		const recipeDir = join(projectDir, "recipes");
		await mkdir(join(recipeDir, "sources"), { recursive: true });
		await writeFile(join(recipeDir, "tool-matrix.recipe.json"), RECIPE, "utf8");
		for (const tool of TOOLS) {
			await writeFile(join(recipeDir, "sources", `${tool}.grid`), GRID, "utf8");
		}
		await body(projectDir);
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

test("pack build --dry-run classifies every output and writes nothing", async () => {
	await withProject(async (projectDir) => {
		const run = await runCliInProcess([
			"pack",
			"build",
			"--project",
			join(projectDir, "mc-asset.pack.json"),
			"--dry-run",
			"--json",
		]);
		expect(run.code).toBe(0);
		const result = (envelope(run).result ?? {}) as Record<string, unknown>;
		expect(result.mode).toBe("build");
		expect(result.dryRun).toBe(true);
		const outputs = (result.outputs ?? []) as Array<{ judgement: string }>;
		expect(outputs.length).toBe(35);
		expect(outputs.every((output) => output.judgement === "new")).toBe(true);
		expect(
			(
				await readdir(
					join(projectDir, "pack", "assets", NAMESPACE, "textures", "item"),
				)
			).length,
		).toBe(0);
		await expect(
			readFile(join(projectDir, "mc-asset.lock.json"), "utf8"),
		).rejects.toThrow();
	});
});

test("pack build writes the matrix once and a rerun writes nothing", async () => {
	await withProject(async (projectDir) => {
		const project = join(projectDir, "mc-asset.pack.json");
		const first = await runCliInProcess([
			"pack",
			"build",
			"--project",
			project,
			"--json",
		]);
		expect(first.code).toBe(0);
		const firstResult = (envelope(first).result ?? {}) as Record<
			string,
			unknown
		>;
		expect(((firstResult.completed ?? []) as string[]).length).toBe(35);
		expect(
			(
				await readdir(
					join(projectDir, "pack", "assets", NAMESPACE, "textures", "item"),
				)
			).length,
		).toBe(35);
		await readFile(join(projectDir, "mc-asset.lock.json"), "utf8");
		const second = await runCliInProcess([
			"pack",
			"build",
			"--project",
			project,
			"--json",
		]);
		expect(second.code).toBe(0);
		const secondResult = (envelope(second).result ?? {}) as Record<
			string,
			unknown
		>;
		expect(secondResult.completed).toEqual([]);
	});
});

test("mcp handlePackAsset build reports the same plan shape", async () => {
	await withProject(async (projectDir) => {
		const result = await handlePackAsset({
			mode: "build",
			projectPath: join(projectDir, "mc-asset.pack.json"),
			dryRun: true,
		});
		expect(result.isError).not.toBe(true);
		const body = JSON.parse(
			(result.content[0] as { text?: string })?.text ?? "{}",
		) as Record<string, unknown>;
		expect(body.mode).toBe("build");
		expect(((body.outputs ?? []) as unknown[]).length).toBe(35);
		expect(body.dryRun).toBe(true);
	});
});
