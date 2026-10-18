import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseZipArchive } from "../../src/io/zip-read.ts";
import { executePackBuild, planPackBuild } from "../../src/pack/build.ts";
import { checkResourcePack } from "../../src/pack/check.ts";
import { initializePackProject } from "../../src/pack/init.ts";
import { packageResourcePack } from "../../src/pack/package.ts";

export interface E2eCase {
	readonly name: string;
	run(): Promise<void>;
}

const SWORD_GRID = `[palette]
. = transparent
O = #2B1D14FF role=outline
D = #4E3524FF role=shadow
B = #704D34FF role=base
L = #996947FF role=highlight
H = #5C3A21FF role=custom

[grid]
..............LL
.............LBL
............LBL.
...........LBL..
..........LBL...
.........LBL....
........LBL.....
.......LBL......
..OO..LBL.......
.ODDO.LBL.......
.ODDDO.L........
..ODDDO.........
...ODDDO........
....HH..........
...HH...........
..HH............`;

const PICKAXE_GRID = `[palette]
. = transparent
O = #2B1D14FF role=outline
D = #4E3524FF role=shadow
B = #704D34FF role=base
L = #996947FF role=highlight
H = #5C3A21FF role=custom

[grid]
.....LLLL.......
...LLBBBDDLL....
..LBBBDDDDDDLL..
.LBD...HH...DDL.
.LD...LHH......L
.....LLHH.......
......LHH.......
.......HH.......
.......HH.......
......LHH.......
.....LHH........
....LHH.........
...LHH..........
..LHH...........
.LHH............
.HH.............`;

const AXE_GRID = `[palette]
. = transparent
O = #2B1D14FF role=outline
D = #4E3524FF role=shadow
B = #704D34FF role=base
L = #996947FF role=highlight
H = #5C3A21FF role=custom

[grid]
.....LLLLLL.....
...LLBBBBBBDD...
..LBBBBBBBDDDD..
.LBBBD...HH.DDD.
.LBBD...LHH..DD.
.LBD...LLHH...D.
.......LLHH.....
........LHH.....
........LHH.....
.......LHH......
......LHH.......
.....LHH........
....LHH.........
...LHH..........
..LHH...........
.HH.............`;

const SHOVEL_GRID = `[palette]
. = transparent
O = #2B1D14FF role=outline
D = #4E3524FF role=shadow
B = #704D34FF role=base
L = #996947FF role=highlight
H = #5C3A21FF role=custom

[grid]
............LL..
...........LBBB.
..........LBBBBD
.........LBBBBBD
.........LBBBBD.
..........LBDD..
...........HH...
..........LHH...
.........LHH....
........LHH.....
.......LHH......
......LHH.......
.....LHH........
....LHH.........
...LHH..........
..HH............`;

const HOE_GRID = `[palette]
. = transparent
O = #2B1D14FF role=outline
D = #4E3524FF role=shadow
B = #704D34FF role=base
L = #996947FF role=highlight
H = #5C3A21FF role=custom

[grid]
...LLLLLLLLL....
..LBBBBBBBBBDD..
.LBBBD...LHH.DD.
.LBD....LHH...D.
........LHH.....
.......LHH......
.......LHH......
......LHH.......
......LHH.......
.....LHH........
....LHH.........
...LHH..........
..LHH...........
.LHH............
.HH.............
................`;

const GEM_GRID = `[palette]
. = transparent
D = #4E3524FF role=shadow
B = #704D34FF role=base
L = #996947FF role=highlight

[grid]
................
......LLLL......
....LLBBBBLL....
...LBBBBBBBBLL..
..LBBBBBBBBBBBD.
..LBBBBBBBBBBBD.
..LBBBBBBBBBBBD.
...LBBBBBBBBBBD.
....LBBBBBBBBD..
.....LBBBBBBBD..
......LBBBBBBD..
.......LBBBBDD..
........LBBBDD..
.........LBDD...
..........LDD...
................`;

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export const E2E_CASES: readonly E2eCase[] = [
	{
		name: "author complete pack: 35 tools, 3 animated gems, 1 dual-form item, check, and reproducible zip",
		async run() {
			const dir = await mkdtemp(join(tmpdir(), "mc-asset-e2e-"));
			const projectDir = join(dir, "aurelian-forge");

			try {
				// 1. Initialize project
				await initializePackProject({
					projectDir,
					namespace: "aurelian",
					minecraftVersion: "1.21.9",
					name: "aurelian-forge",
					style: "vanilla",
				});

				const recipeDir = join(projectDir, "recipes");
				const sourcesDir = join(recipeDir, "sources");
				await mkdir(sourcesDir, { recursive: true });

				// Write original source grids
				await writeFile(join(sourcesDir, "sword.grid"), SWORD_GRID, "utf8");
				await writeFile(join(sourcesDir, "pickaxe.grid"), PICKAXE_GRID, "utf8");
				await writeFile(join(sourcesDir, "axe.grid"), AXE_GRID, "utf8");
				await writeFile(join(sourcesDir, "shovel.grid"), SHOVEL_GRID, "utf8");
				await writeFile(join(sourcesDir, "hoe.grid"), HOE_GRID, "utf8");
				await writeFile(join(sourcesDir, "gem.grid"), GEM_GRID, "utf8");

				// Recipe 1: 5 tools x 7 materials = 35 textures
				const toolRecipe = {
					formatVersion: 1,
					id: "tool-matrix",
					style: "vanilla",
					variables: {
						tool: ["sword", "pickaxe", "axe", "shovel", "hoe"],
						material: [
							"iron",
							"gold",
							"diamond",
							"netherite",
							"copper",
							"wood",
							"stone",
						],
					},
					sources: {
						sword_grid: { kind: "grid", path: "sources/sword.grid" },
						pickaxe_grid: { kind: "grid", path: "sources/pickaxe.grid" },
						axe_grid: { kind: "grid", path: "sources/axe.grid" },
						shovel_grid: { kind: "grid", path: "sources/shovel.grid" },
						hoe_grid: { kind: "grid", path: "sources/hoe.grid" },
					},
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
				};
				await writeFile(
					join(recipeDir, "tools.recipe.json"),
					JSON.stringify(toolRecipe, null, 2),
					"utf8",
				);

				// Recipe 2: 3 gem sweep animations
				const gemRecipe = {
					formatVersion: 1,
					id: "gem-shimmer",
					sources: { gem_grid: { kind: "grid", path: "sources/gem.grid" } },
					targets: [
						{
							id: "ruby",
							category: "item",
							source: "gem_grid",
							output: "assets/{namespace}/textures/item/ruby.png",
							steps: [
								{ type: "recolor", family: "redstone" },
								{
									type: "sweep",
									angle: 135,
									width: 2,
									frames: 4,
									holdTicks: 20,
									mcmetaOutput:
										"assets/{namespace}/textures/item/ruby.png.mcmeta",
								},
							],
						},
						{
							id: "sapphire",
							category: "item",
							source: "gem_grid",
							output: "assets/{namespace}/textures/item/sapphire.png",
							steps: [
								{ type: "recolor", family: "lapis" },
								{
									type: "sweep",
									angle: 135,
									width: 2,
									frames: 4,
									holdTicks: 20,
									mcmetaOutput:
										"assets/{namespace}/textures/item/sapphire.png.mcmeta",
								},
							],
						},
						{
							id: "topaz",
							category: "item",
							source: "gem_grid",
							output: "assets/{namespace}/textures/item/topaz.png",
							steps: [
								{ type: "recolor", family: "gold" },
								{
									type: "sweep",
									angle: 135,
									width: 2,
									frames: 4,
									holdTicks: 20,
									mcmetaOutput:
										"assets/{namespace}/textures/item/topaz.png.mcmeta",
								},
							],
						},
					],
				};
				await writeFile(
					join(recipeDir, "gems.recipe.json"),
					JSON.stringify(gemRecipe, null, 2),
					"utf8",
				);

				// Recipe 3: 1 dual-form item
				const dualRecipe = {
					formatVersion: 1,
					id: "dual-blade",
					sources: { blade_grid: { kind: "grid", path: "sources/sword.grid" } },
					targets: [
						{
							id: "relic_blade",
							category: "sword",
							source: "blade_grid",
							output: "assets/{namespace}/textures/item/relic_blade.png",
							steps: [
								{ type: "recolor", family: "amethyst" },
								{ type: "model", parent: "handheld" },
								{
									type: "model",
									item: "relic_blade_3d",
									modelSpec: {
										ambientocclusion: false,
										textures: { layer0: "{namespace}:item/relic_blade" },
										elements: [
											{
												from: [0, 0, 6],
												to: [16, 16, 10],
												faces: {
													north: {
														uv: [0, 0, 16, 16],
														texture: "#layer0",
													},
												},
											},
										],
									},
								},
								{
									type: "itemDefinition",
									model: "{namespace}:item/relic_blade",
									definition: {
										type: "select",
										property: "minecraft:display_context",
										cases: [
											{
												when: ["gui", "fixed"],
												model: "{namespace}:item/relic_blade",
											},
											{
												when: [
													"ground",
													"thirdperson_righthand",
													"thirdperson_lefthand",
												],
												model: "{namespace}:item/relic_blade_3d",
											},
										],
										fallback: "{namespace}:item/relic_blade",
									},
								},
							],
						},
					],
				};
				await writeFile(
					join(recipeDir, "dual.recipe.json"),
					JSON.stringify(dualRecipe, null, 2),
					"utf8",
				);

				const projectPath = join(projectDir, "mc-asset.pack.json");

				// 2. Plan and execute build
				const plan = await planPackBuild(projectPath);
				assert.equal(
					plan.outputs.length,
					45,
					"35 tools + 6 gems + 4 dual-form",
				);

				const executed = await executePackBuild(plan);
				assert.equal(executed.completed.length, 45, "all 45 outputs written");

				// 3. Whole-pack check has zero errors
				const checkSummary = await checkResourcePack({ projectPath });
				const errorList = checkSummary.fixList.filter(
					(f) => f.level === "error",
				);
				assert.deepEqual(errorList, [], "zero errors in pack check");
				assert.equal(
					checkSummary.textureCount,
					39,
					"35 tools + 3 gems + 1 blade",
				);

				// 4. Package into reproducible zip
				const zipPath1 = join(projectDir, "dist", "pack-1.zip");
				const zipPath2 = join(projectDir, "dist", "pack-2.zip");
				const pkg1 = await packageResourcePack({
					projectPath,
					outputPath: zipPath1,
					mkdir: true,
				});
				const pkg2 = await packageResourcePack({
					projectPath,
					outputPath: zipPath2,
					mkdir: true,
				});

				assert.equal(
					pkg1.fileCount,
					47,
					"39 textures + 3 mcmeta + 3 models + 1 item + 1 mcmeta",
				);
				assert.equal(pkg1.fileCount, pkg2.fileCount);
				assert.equal(pkg1.totalBytes, pkg2.totalBytes);

				const bytes1 = await readFile(zipPath1);
				const bytes2 = await readFile(zipPath2);
				assert.equal(
					sha256(bytes1),
					sha256(bytes2),
					"deterministic zip packaging",
				);

				// 5. Verify archive contents
				const archive = parseZipArchive(new Uint8Array(bytes1));
				const names = archive.entries.map((e) => e.name);
				assert.ok(names.includes("pack.mcmeta"), "pack.mcmeta at zip root");
				assert.ok(names.includes("pack.png"), "pack icon in zip");
				assert.ok(
					names.includes("assets/aurelian/textures/item/ruby.png"),
					"gem texture in zip",
				);
				assert.ok(
					names.includes("assets/aurelian/textures/item/ruby.png.mcmeta"),
					"gem mcmeta in zip",
				);
				assert.ok(
					names.includes("assets/aurelian/textures/item/iron_sword.png"),
					"tool texture in zip",
				);
				assert.ok(
					names.includes("assets/aurelian/models/item/relic_blade.json"),
					"2D model in zip",
				);
				assert.ok(
					names.includes("assets/aurelian/models/item/relic_blade_3d.json"),
					"3D model in zip",
				);
				assert.ok(
					names.includes("assets/aurelian/items/relic_blade.json"),
					"item definition in zip",
				);

				// Excluded internal files
				assert.ok(!names.some((n) => n.includes(".DS_Store")));
				assert.ok(!names.some((n) => n.includes("mc-asset.pack.json")));
				assert.ok(!names.some((n) => n.includes("mc-asset.lock.json")));
				assert.ok(!names.some((n) => n.includes("recipes/")));
				assert.ok(!names.some((n) => n.startsWith("__MACOSX")));
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	},
];
