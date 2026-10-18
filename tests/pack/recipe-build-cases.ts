import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addLayer, createCanvas } from "../../src/core/canvas.ts";
import { decodePng, encodePng } from "../../src/io/png.ts";
import { executePackBuild, planPackBuild } from "../../src/pack/build.ts";
import { initializePackProject } from "../../src/pack/init.ts";
import { parseLockText } from "../../src/pack/lock.ts";

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

/** The 35 expanded target ids in UTF-8 byte order, as the frozen spec pins them. */
const EXPECTED_IDS = MATERIALS.flatMap((material) =>
	TOOLS.map((tool) => `${material}_${tool}`),
).sort();

/** The project-root-relative output path of one expanded target. */
function expectedOutputPath(id: string): string {
	return `pack/assets/${NAMESPACE}/textures/item/${id}.png`;
}

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
		description: "5 tools x 7 materials: family recolor then a tinted outline",
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
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-recipe-"));
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
}

/** Read a file's bytes, or null when it does not exist. */
async function bytesAt(path: string): Promise<Uint8Array | null> {
	try {
		return await readFile(path);
	} catch {
		return null;
	}
}

/** Run a body and return the refusal it throws. */
async function refusalOf(body: () => Promise<unknown>): Promise<{
	code?: string;
	details?: Record<string, unknown>;
}> {
	try {
		await body();
	} catch (error) {
		return error as { code?: string; details?: Record<string, unknown> };
	}
	assert.fail("expected a refusal but the call succeeded");
}

export const RECIPE_BUILD_CASES = [
	{
		name: "the tool matrix expands to 35 outputs and a lock entry for each",
		async run() {
			await withProject(async (projectDir) => {
				const plan = await planPackBuild(
					join(projectDir, "mc-asset.pack.json"),
				);
				assert.equal(plan.outputs.length, 35, "35 expanded outputs");
				assert.deepEqual(
					plan.outputs.map((output) => output.targetId).sort(),
					[...EXPECTED_IDS],
					"target ids follow the byte-order expansion",
				);
				assert.deepEqual(
					[...new Set(plan.outputs.map((output) => output.path))].sort(),
					EXPECTED_IDS.map(expectedOutputPath),
					"paths are the pinned project-relative outputs",
				);
				const executed = await executePackBuild(plan);
				assert.equal(executed.completed.length, 35, "35 files are written");
				const lockText = await readFile(
					join(projectDir, "mc-asset.lock.json"),
					"utf8",
				);
				const lock = parseLockText(lockText);
				assert.deepEqual(
					[...Object.keys(lock.outputs)].sort(),
					EXPECTED_IDS.map(expectedOutputPath),
					"lock keys are project-relative paths in byte order",
				);
				for (const path of EXPECTED_IDS.map(expectedOutputPath)) {
					const entry = lock.outputs[path];
					assert.ok(entry, `an entry for ${path}`);
					assert.equal(entry.recipeId, "tool-matrix", "recipe id recorded");
					assert.match(entry.inputHash, /^[0-9a-f]{64}$/, "input hash shape");
					assert.match(entry.outputHash, /^[0-9a-f]{64}$/, "output hash shape");
				}
			});
		},
	},
	{
		name: "a rerun with unchanged inputs writes nothing and keeps the lock byte-identical",
		async run() {
			await withProject(async (projectDir) => {
				const project = join(projectDir, "mc-asset.pack.json");
				await executePackBuild(await planPackBuild(project));
				const lockPath = join(projectDir, "mc-asset.lock.json");
				const lockBefore = await bytesAt(lockPath);
				assert.ok(lockBefore, "the first build wrote a lock");
				const second = await planPackBuild(project);
				assert.ok(
					second.outputs.every((output) => output.judgement === "own-clean"),
					"every output is own-clean on a rerun",
				);
				const run = await executePackBuild(second);
				assert.deepEqual(run.completed, [], "the rerun rewrites nothing");
				assert.deepEqual(
					await bytesAt(lockPath),
					lockBefore,
					"the lock is unchanged",
				);
			});
		},
	},
	{
		name: "a changed source rewrites only the targets that read it",
		async run() {
			await withProject(async (projectDir) => {
				const project = join(projectDir, "mc-asset.pack.json");
				await executePackBuild(await planPackBuild(project));
				const lockPath = join(projectDir, "mc-asset.lock.json");
				const before = parseLockText(await readFile(lockPath, "utf8"));
				const untouchedRel = expectedOutputPath("iron_axe");
				const untouchedBefore = await bytesAt(join(projectDir, untouchedRel));
				await writeFile(
					join(projectDir, "recipes", "sources", "sword.grid"),
					`${GRID}; changed\n`,
					"utf8",
				);
				const run = await executePackBuild(await planPackBuild(project));
				const expectedSwords = MATERIALS.map((material) =>
					expectedOutputPath(`${material}_sword`),
				).sort();
				assert.deepEqual(
					[...run.completed].sort(),
					expectedSwords,
					"only the sword targets rewrite",
				);
				assert.deepEqual(
					await bytesAt(join(projectDir, untouchedRel)),
					untouchedBefore,
					"untouched targets keep their bytes",
				);
				const after = parseLockText(await readFile(lockPath, "utf8"));
				assert.equal(
					after.outputs[untouchedRel].inputHash,
					before.outputs[untouchedRel].inputHash,
					"an unrelated input hash stays",
				);
				const swordRel = expectedOutputPath("iron_sword");
				assert.notEqual(
					after.outputs[swordRel].inputHash,
					before.outputs[swordRel].inputHash,
					"a changed source updates its input hash",
				);
			});
		},
	},
	{
		name: "a hand-modified output refuses the whole batch and lists the conflict",
		async run() {
			await withProject(async (projectDir) => {
				const project = join(projectDir, "mc-asset.pack.json");
				await executePackBuild(await planPackBuild(project));
				const modifiedRel = expectedOutputPath("copper_axe");
				await writeFile(join(projectDir, modifiedRel), "hand edit", "utf8");
				const intactRel = expectedOutputPath("iron_sword");
				const intactBefore = await bytesAt(join(projectDir, intactRel));
				const lockPath = join(projectDir, "mc-asset.lock.json");
				const lockBefore = await bytesAt(lockPath);
				const refusal = await refusalOf(async () =>
					executePackBuild(await planPackBuild(project)),
				);
				assert.equal(refusal.code, "PACK_BUILD_CONFLICT");
				assert.deepEqual(refusal.details?.conflicts, [
					{ path: modifiedRel, reason: "own-modified" },
				]);
				assert.deepEqual(
					await bytesAt(join(projectDir, intactRel)),
					intactBefore,
					"no other output is rewritten",
				);
				assert.deepEqual(
					await bytesAt(lockPath),
					lockBefore,
					"the lock is unchanged",
				);
			});
		},
	},
	{
		name: "a foreign file at an output path refuses the batch before any write",
		async run() {
			await withProject(async (projectDir) => {
				const foreignRel = expectedOutputPath("iron_sword");
				await writeFile(join(projectDir, foreignRel), "someone else", "utf8");
				const refusal = await refusalOf(async () =>
					executePackBuild(
						await planPackBuild(join(projectDir, "mc-asset.pack.json")),
					),
				);
				assert.equal(refusal.code, "PACK_BUILD_CONFLICT");
				assert.deepEqual(refusal.details?.conflicts, [
					{ path: foreignRel, reason: "foreign" },
				]);
				assert.equal(
					await bytesAt(join(projectDir, "mc-asset.lock.json")),
					null,
					"a refused batch writes no lock",
				);
			});
		},
	},
	{
		name: "deleting the lock treats existing outputs as foreign and refuses",
		async run() {
			await withProject(async (projectDir) => {
				const project = join(projectDir, "mc-asset.pack.json");
				await executePackBuild(await planPackBuild(project));
				await rm(join(projectDir, "mc-asset.lock.json"));
				const refusal = await refusalOf(async () =>
					executePackBuild(await planPackBuild(project)),
				);
				assert.equal(refusal.code, "PACK_BUILD_CONFLICT");
				const conflicts = refusal.details?.conflicts as Array<{
					reason: string;
				}>;
				assert.equal(conflicts.length, 35, "all 35 outputs are foreign");
				assert.ok(conflicts.every((conflict) => conflict.reason === "foreign"));
			});
		},
	},
	{
		name: "a corrupt lock refuses the build",
		async run() {
			await withProject(async (projectDir) => {
				const project = join(projectDir, "mc-asset.pack.json");
				await executePackBuild(await planPackBuild(project));
				await writeFile(
					join(projectDir, "mc-asset.lock.json"),
					"{ not json",
					"utf8",
				);
				const outputRel = expectedOutputPath("iron_axe");
				const outputBefore = await bytesAt(join(projectDir, outputRel));
				const refusal = await refusalOf(async () => {
					await executePackBuild(await planPackBuild(project));
				});
				assert.equal(refusal.code, "PACK_LOCK_INVALID");
				assert.deepEqual(
					await bytesAt(join(projectDir, outputRel)),
					outputBefore,
					"nothing is rewritten",
				);
			});
		},
	},
	{
		name: "a dry run classifies every output and writes nothing",
		async run() {
			await withProject(async (projectDir) => {
				const project = join(projectDir, "mc-asset.pack.json");
				const plan = await planPackBuild(project, { dryRun: true });
				assert.equal(plan.outputs.length, 35, "35 planned outputs");
				assert.ok(plan.dryRun, "the plan is a dry run");
				assert.ok(
					plan.outputs.every((output) => output.judgement === "new"),
					"every output is new on a blank project",
				);
				const run = await executePackBuild(plan);
				assert.deepEqual(run.completed, [], "a dry run writes nothing");
				assert.equal(
					await bytesAt(join(projectDir, expectedOutputPath("iron_axe"))),
					null,
					"no output file is created",
				);
				assert.equal(
					await bytesAt(join(projectDir, "mc-asset.lock.json")),
					null,
					"no lock is written",
				);
			});
		},
	},

	{
		name: "a failing step names the target and the step index",
		async run() {
			await withProject(async (projectDir) => {
				const recipePath = join(projectDir, "recipes", "bad.recipe.json");
				await writeFile(
					recipePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "bad-family",
							sources: {
								grid: { kind: "grid", path: "sources/sword.grid" },
							},
							targets: [
								{
									id: "bad",
									source: "grid",
									output: "assets/{namespace}/textures/item/bad.png",
									steps: [{ type: "recolor", family: "not-a-family" }],
								},
							],
						},
						null,
						2,
					)}\n`,
					"utf8",
				);
				const refusal = await refusalOf(async () => {
					await executePackBuild(
						await planPackBuild(join(projectDir, "mc-asset.pack.json"), {
							recipe: recipePath,
						}),
					);
				});
				assert.equal(refusal.code, "STYLE_FAMILY_NOT_FOUND");
				assert.equal(refusal.details?.targetId, "bad");
				assert.equal(refusal.details?.stepIndex, 0);
				assert.equal(
					await bytesAt(join(projectDir, expectedOutputPath("bad"))),
					null,
					"nothing is written",
				);
			});
		},
	},
	{
		name: "two targets that expand to the same output are refused with the duplicated path",
		async run() {
			await withProject(async (projectDir) => {
				const recipePath = join(projectDir, "recipes", "dupe.recipe.json");
				const output = "assets/{namespace}/textures/item/same.png";
				await writeFile(
					recipePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "dupe",
							sources: {
								grid: { kind: "grid", path: "sources/sword.grid" },
							},
							targets: [
								{
									id: "one",
									source: "grid",
									output,
									steps: [{ type: "outline" }],
								},
								{
									id: "two",
									source: "grid",
									output,
									steps: [{ type: "outline" }],
								},
							],
						},
						null,
						2,
					)}\n`,
					"utf8",
				);
				const refusal = await refusalOf(async () => {
					await executePackBuild(
						await planPackBuild(join(projectDir, "mc-asset.pack.json"), {
							recipe: recipePath,
						}),
					);
				});
				assert.equal(refusal.code, "RECIPE_OUTPUT_CONFLICT");
				assert.ok(
					JSON.stringify(refusal.details ?? {}).includes("same.png"),
					"the duplicated path is listed",
				);
			});
		},
	},
	{
		name: "an output that escapes the output directory is refused",
		async run() {
			await withProject(async (projectDir) => {
				const recipePath = join(projectDir, "recipes", "escape.recipe.json");
				await writeFile(
					recipePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "escape",
							sources: {
								grid: { kind: "grid", path: "sources/sword.grid" },
							},
							targets: [
								{
									id: "escape",
									source: "grid",
									output: "../outside.png",
									steps: [{ type: "outline" }],
								},
							],
						},
						null,
						2,
					)}\n`,
					"utf8",
				);
				const refusal = await refusalOf(async () => {
					await executePackBuild(
						await planPackBuild(join(projectDir, "mc-asset.pack.json"), {
							recipe: recipePath,
						}),
					);
				});
				assert.equal(refusal.code, "RECIPE_INVALID");
				assert.equal(
					await bytesAt(join(projectDir, "outside.png")),
					null,
					"nothing lands outside the output directory",
				);
			});
		},
	},
	{
		name: "a symlinked output parent refuses the build",
		async run() {
			await withProject(async (projectDir) => {
				const itemDir = join(
					projectDir,
					"pack",
					"assets",
					NAMESPACE,
					"textures",
					"item",
				);
				const elsewhere = join(projectDir, "elsewhere");
				await mkdir(elsewhere, { recursive: true });
				await rm(itemDir, { recursive: true, force: true });
				await symlink(elsewhere, itemDir, "dir");
				const refusal = await refusalOf(async () =>
					executePackBuild(
						await planPackBuild(join(projectDir, "mc-asset.pack.json")),
					),
				);
				assert.equal(refusal.code, "FILESYSTEM_ERROR");
				assert.deepEqual(
					await bytesAt(join(elsewhere, "iron_axe.png")),
					null,
					"nothing lands in the link target",
				);
			});
		},
	},
	{
		name: "more planned outputs than the budget allows is refused",
		async run() {
			await withProject(async (projectDir) => {
				const names = Array.from(
					{ length: 4097 },
					(_, index) => `item${index}`,
				);
				const recipePath = join(projectDir, "recipes", "huge.recipe.json");
				await writeFile(
					recipePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "huge",
							variables: { name: names },
							sources: {
								grid: { kind: "grid", path: "sources/sword.grid" },
							},
							targets: [
								{
									id: "{name}",
									source: "grid",
									output: "assets/{namespace}/textures/item/{name}.png",
									steps: [{ type: "outline" }],
								},
							],
						},
						null,
						2,
					)}\n`,
					"utf8",
				);
				const refusal = await refusalOf(async () => {
					await executePackBuild(
						await planPackBuild(join(projectDir, "mc-asset.pack.json"), {
							recipe: recipePath,
						}),
					);
				});
				assert.equal(refusal.code, "RESOURCE_LIMIT_EXCEEDED");
			});
		},
	},
	{
		name: "sweep step generates vertical sprite sheet and mcmeta with lock entries for both",
		async run() {
			await withProject(async (projectDir) => {
				const recipePath = join(projectDir, "recipes", "anim.recipe.json");
				const textureRel = `assets/${NAMESPACE}/textures/item/sword_anim.png`;
				const mcmetaRel = `assets/${NAMESPACE}/textures/item/sword_anim.png.mcmeta`;
				await writeFile(
					recipePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "animated-sword",
							sources: {
								sword_grid: {
									kind: "grid",
									path: "sources/sword.grid",
								},
							},
							targets: [
								{
									id: "sword_anim",
									source: "sword_grid",
									output: textureRel,
									steps: [
										{
											type: "sweep",
											frames: 8,
											mcmetaOutput: mcmetaRel,
										},
									],
								},
							],
						},
						null,
						2,
					)}\n`,
					"utf8",
				);
				const project = join(projectDir, "mc-asset.pack.json");
				const plan = await planPackBuild(project, { recipe: recipePath });
				assert.equal(
					plan.outputs.length,
					2,
					"two planned outputs (png and mcmeta)",
				);
				assert.ok(
					plan.outputs.every((o) => o.judgement === "new"),
					"both are new",
				);
				const executed = await executePackBuild(plan);
				assert.equal(executed.completed.length, 2, "both files are written");

				const textureFull = join(projectDir, "pack", textureRel);
				const mcmetaFull = join(projectDir, "pack", mcmetaRel);
				const textureBytes = await bytesAt(textureFull);
				const mcmetaText = await readFile(mcmetaFull, "utf8");
				assert.ok(
					textureBytes && textureBytes.length > 0,
					"texture exists and is non-empty",
				);
				assert.ok(
					mcmetaText.includes('"animation"'),
					"mcmeta has animation section",
				);
				assert.ok(mcmetaText.includes('"frames"'), "mcmeta has frames list");

				const lock = parseLockText(
					await readFile(join(projectDir, "mc-asset.lock.json"), "utf8"),
				);
				const texKey = `pack/${textureRel}`;
				const mcmetaKey = `pack/${mcmetaRel}`;
				assert.ok(lock.outputs[texKey], "lock has texture entry");
				assert.equal(lock.outputs[texKey]?.kind, "texture");
				assert.ok(lock.outputs[mcmetaKey], "lock has mcmeta entry");
				assert.equal(lock.outputs[mcmetaKey]?.kind, "mcmeta");

				// Rerun is idempotent
				const rerun = await executePackBuild(
					await planPackBuild(project, { recipe: recipePath }),
				);
				assert.deepEqual(rerun.completed, [], "rerun writes nothing");

				// Hand edit on mcmeta refuses with conflict
				await writeFile(mcmetaFull, '{"animation":{}}', "utf8");
				const refusal = await refusalOf(async () =>
					executePackBuild(
						await planPackBuild(project, { recipe: recipePath }),
					),
				);
				assert.equal(refusal.code, "PACK_BUILD_CONFLICT");
				assert.deepEqual(refusal.details?.conflicts, [
					{ path: mcmetaKey, reason: "own-modified" },
				]);
			});
		},
	},
	{
		name: "generate source synthesizes non-empty pattern and is idempotent on rerun",
		async run() {
			await withProject(async (projectDir) => {
				const recipePath = join(projectDir, "recipes", "gen.recipe.json");
				const outputRel = `assets/${NAMESPACE}/textures/item/checker_iron.png`;
				await writeFile(
					recipePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "procedural-checker",
							sources: {
								checker_src: {
									kind: "generate",
									pattern: "checker",
									size: "16x16",
									palette: "iron",
									seed: 42,
								},
							},
							targets: [
								{
									id: "checker_iron",
									source: "checker_src",
									output: outputRel,
									steps: [{ type: "outline", mode: "tinted" }],
								},
							],
						},
						null,
						2,
					)}\n`,
					"utf8",
				);
				const project = join(projectDir, "mc-asset.pack.json");
				const plan = await planPackBuild(project, { recipe: recipePath });
				assert.equal(plan.outputs.length, 1, "one planned output");
				assert.equal(plan.outputs[0]?.judgement, "new");
				const executed = await executePackBuild(plan);
				assert.equal(executed.completed.length, 1, "one file written");

				const textureFull = join(projectDir, "pack", outputRel);
				const textureBytes = await bytesAt(textureFull);
				assert.ok(
					textureBytes && textureBytes.length > 0,
					"generated texture is non-empty",
				);

				const lock = parseLockText(
					await readFile(join(projectDir, "mc-asset.lock.json"), "utf8"),
				);
				const key = `pack/${outputRel}`;
				assert.ok(lock.outputs[key], "lock has entry for generated asset");
				assert.equal(lock.outputs[key]?.kind, "texture");

				// Rerun writes nothing
				const rerun = await executePackBuild(
					await planPackBuild(project, { recipe: recipePath }),
				);
				assert.deepEqual(rerun.completed, [], "rerun writes nothing");
			});
		},
	},
	{
		name: "vanilla source without vanillaSource configured in project document is refused",
		async run() {
			await withProject(async (projectDir) => {
				const recipePath = join(projectDir, "recipes", "vanilla.recipe.json");
				await writeFile(
					recipePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "vanilla-sword",
							sources: {
								vanilla_src: {
									kind: "vanilla",
									path: "minecraft/textures/item/iron_sword.png",
								},
							},
							targets: [
								{
									id: "vanilla_target",
									source: "vanilla_src",
									output: `assets/${NAMESPACE}/textures/item/vanilla_sword.png`,
									steps: [{ type: "outline" }],
								},
							],
						},
						null,
						2,
					)}\n`,
					"utf8",
				);
				const project = join(projectDir, "mc-asset.pack.json");
				const refusal = await refusalOf(async () => {
					await executePackBuild(
						await planPackBuild(project, { recipe: recipePath }),
					);
				});
				assert.equal(refusal.code, "RECIPE_SOURCE_MISSING");
			});
		},
	},
	{
		name: "a recipe referencing a non-existent style file is refused with zero writes",
		async run() {
			await withProject(async (projectDir) => {
				const recipePath = join(projectDir, "recipes", "bad-style.recipe.json");
				await writeFile(
					recipePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "bad-style",
							style: "nope.style.json",
							sources: {
								grid: { kind: "grid", path: "sources/sword.grid" },
							},
							targets: [
								{
									id: "bad_target",
									source: "grid",
									output: `assets/${NAMESPACE}/textures/item/bad_target.png`,
									steps: [{ type: "outline" }],
								},
							],
						},
						null,
						2,
					)}\n`,
					"utf8",
				);
				const project = join(projectDir, "mc-asset.pack.json");
				const refusal = await refusalOf(async () => {
					await executePackBuild(
						await planPackBuild(project, { recipe: recipePath }),
					);
				});
				assert.equal(refusal.code, "STYLE_INVALID");
				assert.equal(
					await bytesAt(
						join(
							projectDir,
							"pack",
							"assets",
							NAMESPACE,
							"textures",
							"item",
							"bad_target.png",
						),
					),
					null,
					"nothing is written on bad style",
				);
				assert.equal(
					await bytesAt(join(projectDir, "mc-asset.lock.json")),
					null,
					"no lock is written on bad style",
				);
			});
		},
	},
	{
		name: "a custom style with extends is applied end-to-end to recolor and animation steps",
		async run() {
			await withProject(async (projectDir) => {
				const stylePath = join(projectDir, "recipes", "neon.style.json");
				await writeFile(
					stylePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "neon",
							name: "Neon",
							extends: "vanilla",
							palettes: {
								iron: {
									base: "#00FF00",
									light: "#123456",
								},
							},
							animation: {
								sweepColor: "#00FF00",
							},
						},
						null,
						2,
					)}\n`,
					"utf8",
				);
				const recipePath = join(
					projectDir,
					"recipes",
					"custom-style.recipe.json",
				);
				await writeFile(
					recipePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "custom-neon-recipe",
							style: "neon.style.json",
							sources: {
								grid: { kind: "grid", path: "sources/sword.grid" },
							},
							targets: [
								{
									id: "neon_sword",
									source: "grid",
									output: `assets/${NAMESPACE}/textures/item/neon_sword.png`,
									steps: [
										{ type: "recolor", family: "iron" },
										{ type: "sweep", frames: 4 },
									],
								},
							],
						},
						null,
						2,
					)}\n`,
					"utf8",
				);
				const project = join(projectDir, "mc-asset.pack.json");
				const plan = await planPackBuild(project, { recipe: recipePath });
				assert.equal(plan.outputs.length, 1);
				const executed = await executePackBuild(plan);
				assert.equal(executed.completed.length, 1);
				const writtenBytes = await bytesAt(
					join(
						projectDir,
						"pack",
						"assets",
						NAMESPACE,
						"textures",
						"item",
						"neon_sword.png",
					),
				);
				assert.ok(
					writtenBytes && writtenBytes.length > 0,
					"neon sword was generated",
				);

				// The overridden light (#123456) proves the recolor ramp
				// itself came from the custom style (the source grid maps
				// to the light band only), while the sweep color (#00FF00)
				// proves the animation defaults flowed through the same
				// inheritance chain.
				assert.ok(writtenBytes, "neon sword bytes available");
				const canvas = decodePng(writtenBytes).canvas;
				function hasOpaquePixel(r: number, g: number, b: number): boolean {
					for (const layer of canvas.layers) {
						for (let i = 0; i < layer.pixels.length; i += 4) {
							if (
								layer.pixels[i] === r &&
								layer.pixels[i + 1] === g &&
								layer.pixels[i + 2] === b &&
								layer.pixels[i + 3] === 255
							) {
								return true;
							}
						}
					}
					return false;
				}
				assert.ok(
					hasOpaquePixel(18, 52, 86),
					"custom iron light (#123456) from the recolor ramp appears in pixels",
				);
				assert.ok(
					hasOpaquePixel(0, 255, 0),
					"sweep color (#00FF00) from the custom animation defaults appears in pixels",
				);
			});
		},
	},
	{
		name: "soft and vanilla styles produce different output bytes for outline step",
		async run() {
			await withProject(async (projectDir) => {
				const makeRecipe = (id: string, style: string) =>
					`${JSON.stringify(
						{
							formatVersion: 1,
							id,
							style,
							sources: {
								grid: { kind: "grid", path: "sources/sword.grid" },
							},
							targets: [
								{
									id: `${id}_sword`,
									source: "grid",
									output: `assets/${NAMESPACE}/textures/item/${id}_sword.png`,
									steps: [{ type: "outline" }],
								},
							],
						},
						null,
						2,
					)}\n`;

				const vanillaRecipePath = join(
					projectDir,
					"recipes",
					"vanilla-outline.recipe.json",
				);
				const softRecipePath = join(
					projectDir,
					"recipes",
					"soft-outline.recipe.json",
				);
				await writeFile(
					vanillaRecipePath,
					makeRecipe("vanilla_outline", "vanilla"),
					"utf8",
				);
				await writeFile(
					softRecipePath,
					makeRecipe("soft_outline", "soft"),
					"utf8",
				);

				const project = join(projectDir, "mc-asset.pack.json");
				await executePackBuild(
					await planPackBuild(project, { recipe: vanillaRecipePath }),
				);
				await executePackBuild(
					await planPackBuild(project, { recipe: softRecipePath }),
				);

				const vanillaBytes = await bytesAt(
					join(
						projectDir,
						"pack",
						"assets",
						NAMESPACE,
						"textures",
						"item",
						"vanilla_outline_sword.png",
					),
				);
				const softBytes = await bytesAt(
					join(
						projectDir,
						"pack",
						"assets",
						NAMESPACE,
						"textures",
						"item",
						"soft_outline_sword.png",
					),
				);
				assert.ok(vanillaBytes && softBytes, "both files exist");
				assert.notDeepEqual(
					vanillaBytes,
					softBytes,
					"soft (luminanceDrop 60) and vanilla (luminanceDrop 120) produce different outline bytes",
				);
			});
		},
	},
	{
		name: "outline step with uniform mode and hex color succeeds and paints uniform border",
		async run() {
			await withProject(async (projectDir) => {
				const recipePath = join(projectDir, "recipes", "uniform.recipe.json");
				await writeFile(
					recipePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "uniform-outline",
							sources: {
								grid: { kind: "grid", path: "sources/sword.grid" },
							},
							targets: [
								{
									id: "uniform_sword",
									source: "grid",
									output: `assets/${NAMESPACE}/textures/item/uniform_sword.png`,
									steps: [
										{
											type: "outline",
											mode: "uniform",
											color: "#112233",
										},
									],
								},
							],
						},
						null,
						2,
					)}\n`,
					"utf8",
				);
				const project = join(projectDir, "mc-asset.pack.json");
				const plan = await planPackBuild(project, { recipe: recipePath });
				const executed = await executePackBuild(plan);
				assert.equal(executed.completed.length, 1);
				const written = await bytesAt(
					join(
						projectDir,
						"pack",
						"assets",
						NAMESPACE,
						"textures",
						"item",
						"uniform_sword.png",
					),
				);
				assert.ok(
					written && written.length > 0,
					"uniform outline sword written",
				);
			});
		},
	},
	{
		name: "unsupported step type or missing output is refused in planning phase with RECIPE_INVALID",
		async run() {
			await withProject(async (projectDir) => {
				const project = join(projectDir, "mc-asset.pack.json");

				// 1. Unsupported step type
				const badStepPath = join(projectDir, "recipes", "bad-step.recipe.json");
				await writeFile(
					badStepPath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "bad-step",
							sources: {
								grid: { kind: "grid", path: "sources/sword.grid" },
							},
							targets: [
								{
									id: "bad_target",
									source: "grid",
									output: `assets/${NAMESPACE}/textures/item/bad.png`,
									steps: [{ type: "unsupported_magic" }],
								},
							],
						},
						null,
						2,
					)}\n`,
					"utf8",
				);
				const refusal1 = await refusalOf(async () => {
					await planPackBuild(project, { recipe: badStepPath, dryRun: true });
				});
				assert.equal(refusal1.code, "RECIPE_INVALID");

				// 2. Missing output on image target
				const noOutputPath = join(
					projectDir,
					"recipes",
					"no-output.recipe.json",
				);
				await writeFile(
					noOutputPath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "no-output",
							sources: {
								grid: { kind: "grid", path: "sources/sword.grid" },
							},
							targets: [
								{
									id: "no_out_target",
									source: "grid",
									steps: [{ type: "outline" }],
								},
							],
						},
						null,
						2,
					)}\n`,
					"utf8",
				);
				const refusal2 = await refusalOf(async () => {
					await planPackBuild(project, { recipe: noOutputPath });
				});
				assert.equal(refusal2.code, "RECIPE_INVALID");
			});
		},
	},
	{
		name: "sources exceeding decoded pixels budget of 16M is refused before writing",
		async run() {
			await withProject(async (projectDir) => {
				const c1 = createCanvas(4096, 4096);
				addLayer(c1, { id: "base" });
				const png1 = encodePng(c1);

				const c2 = createCanvas(4096, 4096);
				addLayer(c2, { id: "base" });
				const png2 = encodePng(c2);

				const p1Path = join(projectDir, "recipes", "sources", "huge1.png");
				const p2Path = join(projectDir, "recipes", "sources", "huge2.png");
				await writeFile(p1Path, png1);
				await writeFile(p2Path, png2);

				const recipePath = join(
					projectDir,
					"recipes",
					"huge-pixels.recipe.json",
				);
				await writeFile(
					recipePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "huge-pixels",
							sources: {
								h1: { kind: "png", path: "sources/huge1.png" },
								h2: { kind: "png", path: "sources/huge2.png" },
							},
							targets: [
								{
									id: "t1",
									source: "h1",
									output: `assets/${NAMESPACE}/textures/item/t1.png`,
									steps: [{ type: "outline" }],
								},
								{
									id: "t2",
									source: "h2",
									output: `assets/${NAMESPACE}/textures/item/t2.png`,
									steps: [{ type: "outline" }],
								},
							],
						},
						null,
						2,
					)}\n`,
					"utf8",
				);

				const project = join(projectDir, "mc-asset.pack.json");
				const refusal = await refusalOf(async () => {
					await planPackBuild(project, { recipe: recipePath });
				});
				assert.equal(refusal.code, "RESOURCE_LIMIT_EXCEEDED");
			});
		},
	},
	{
		name: "generate source with mcpx palette updates inputHash and rewrites on palette change",
		async run() {
			await withProject(async (projectDir) => {
				const palettePath = join(
					projectDir,
					"recipes",
					"sources",
					"gen-pal.mcpx",
				);
				await writeFile(
					palettePath,
					`mcpx 1\n\n[canvas]\nwidth = 4\nheight = 4\n\n[palette]\n. = transparent\nA = #FF0000FF\nB = #00FF00FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n....\n....\n....\n....\n`,
					"utf8",
				);

				const recipePath = join(projectDir, "recipes", "gen-mcpx.recipe.json");
				const outputRel = `assets/${NAMESPACE}/textures/item/gen_mcpx.png`;
				await writeFile(
					recipePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "gen-mcpx",
							sources: {
								src: {
									kind: "generate",
									pattern: "checker",
									size: "16x16",
									palette: "sources/gen-pal.mcpx",
									seed: 123,
								},
							},
							targets: [
								{
									id: "gen_target",
									source: "src",
									output: outputRel,
									steps: [{ type: "outline" }],
								},
							],
						},
						null,
						2,
					)}\n`,
					"utf8",
				);

				const project = join(projectDir, "mc-asset.pack.json");
				const first = await executePackBuild(
					await planPackBuild(project, { recipe: recipePath }),
				);
				assert.equal(first.completed.length, 1);

				const lock1 = parseLockText(
					await readFile(join(projectDir, "mc-asset.lock.json"), "utf8"),
				);
				const inputHash1 = lock1.outputs[`pack/${outputRel}`]?.inputHash;
				assert.ok(inputHash1);

				// Modify the mcpx palette file
				await writeFile(
					palettePath,
					`mcpx 1\n\n[canvas]\nwidth = 4\nheight = 4\n\n[palette]\n. = transparent\nA = #0000FFFF\nB = #FFFF00FF\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n....\n....\n....\n....\n`,
					"utf8",
				);

				// Re-plan and rebuild
				const secondPlan = await planPackBuild(project, { recipe: recipePath });
				const second = await executePackBuild(secondPlan);
				assert.equal(
					second.completed.length,
					1,
					"target rewrites because mcpx palette changed",
				);

				const lock2 = parseLockText(
					await readFile(join(projectDir, "mc-asset.lock.json"), "utf8"),
				);
				const inputHash2 = lock2.outputs[`pack/${outputRel}`]?.inputHash;
				assert.notEqual(inputHash1, inputHash2, "inputHash was updated");
			});
		},
	},
	{
		name: "mixed sources (mcpx, png, vanilla) in one recipe build successfully and rerun writes nothing",
		async run() {
			await withProject(async (projectDir) => {
				const projectPath = join(projectDir, "mc-asset.pack.json");
				const projectDoc = JSON.parse(await readFile(projectPath, "utf8"));
				projectDoc.vanillaSource = {
					kind: "assets-dir",
					path: "vanilla",
				};
				await writeFile(
					projectPath,
					JSON.stringify(projectDoc, null, 2),
					"utf8",
				);

				// 1. Prepare vanilla source PNG
				const vanillaDir = join(
					projectDir,
					"vanilla",
					"minecraft",
					"textures",
					"item",
				);
				await mkdir(vanillaDir, { recursive: true });
				const smallCanvas = createCanvas(16, 16);
				addLayer(smallCanvas, { id: "base" });
				await writeFile(
					join(vanillaDir, "iron_sword.png"),
					encodePng(smallCanvas),
				);

				// 2. Prepare mcpx source
				const mcpxSource = `mcpx 1\n\n[canvas]\nwidth = 16\nheight = 16\n\n[palette]\n. = transparent\n\n[layer base]\nvisible = true\nopacity = 1.000\n\n[grid]\n................\n................\n................\n................\n................\n................\n................\n................\n................\n................\n................\n................\n................\n................\n................\n................\n`;
				await writeFile(
					join(projectDir, "recipes", "sources", "sample.mcpx"),
					mcpxSource,
					"utf8",
				);

				// 3. Prepare regular png source
				await writeFile(
					join(projectDir, "recipes", "sources", "sample.png"),
					encodePng(smallCanvas),
				);

				const recipePath = join(projectDir, "recipes", "mixed.recipe.json");
				await writeFile(
					recipePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "mixed-sources",
							sources: {
								s_mcpx: { kind: "mcpx", path: "sources/sample.mcpx" },
								s_png: { kind: "png", path: "sources/sample.png" },
								s_vanilla: {
									kind: "vanilla",
									path: "minecraft/textures/item/iron_sword.png",
								},
							},
							targets: [
								{
									id: "target_mcpx",
									source: "s_mcpx",
									output: `assets/${NAMESPACE}/textures/item/from_mcpx.png`,
									steps: [{ type: "outline" }],
								},
								{
									id: "target_png",
									source: "s_png",
									output: `assets/${NAMESPACE}/textures/item/from_png.png`,
									steps: [{ type: "outline" }],
								},
								{
									id: "target_vanilla",
									source: "s_vanilla",
									output: `assets/${NAMESPACE}/textures/item/from_vanilla.png`,
									steps: [{ type: "outline" }],
								},
							],
						},
						null,
						2,
					)}\n`,
					"utf8",
				);

				const plan = await planPackBuild(projectPath, { recipe: recipePath });
				assert.equal(plan.outputs.length, 3, "three planned outputs");
				const executed = await executePackBuild(plan);
				assert.equal(executed.completed.length, 3, "all 3 files written");

				// Rerun writes nothing
				const rerun = await executePackBuild(
					await planPackBuild(projectPath, { recipe: recipePath }),
				);
				assert.deepEqual(rerun.completed, [], "rerun writes nothing");
			});
		},
	},
	{
		name: "a style document with unreadable JSON is refused with STYLE_INVALID and zero writes",
		async run() {
			await withProject(async (projectDir) => {
				const stylePath = join(projectDir, "recipes", "broken.style.json");
				await writeFile(stylePath, "{ not json", "utf8");
				const recipePath = join(
					projectDir,
					"recipes",
					"broken-style.recipe.json",
				);
				await writeFile(
					recipePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "broken-style",
							style: "broken.style.json",
							sources: {
								grid: { kind: "grid", path: "sources/sword.grid" },
							},
							targets: [
								{
									id: "broken_target",
									source: "grid",
									output: `assets/${NAMESPACE}/textures/item/broken_target.png`,
									steps: [{ type: "outline" }],
								},
							],
						},
						null,
						2,
					)}\n`,
					"utf8",
				);
				const project = join(projectDir, "mc-asset.pack.json");
				const refusal = await refusalOf(async () => {
					await executePackBuild(
						await planPackBuild(project, { recipe: recipePath }),
					);
				});
				assert.equal(refusal.code, "STYLE_INVALID");
				assert.equal(
					await bytesAt(join(projectDir, "mc-asset.lock.json")),
					null,
					"no lock is written on broken style",
				);
			});
		},
	},
	{
		name: "a style document that is not an object is refused with STYLE_INVALID and zero writes",
		async run() {
			await withProject(async (projectDir) => {
				const stylePath = join(projectDir, "recipes", "array.style.json");
				await writeFile(stylePath, `[]`, "utf8");
				const recipePath = join(
					projectDir,
					"recipes",
					"array-style.recipe.json",
				);
				await writeFile(
					recipePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "array-style",
							style: "array.style.json",
							sources: {
								grid: { kind: "grid", path: "sources/sword.grid" },
							},
							targets: [
								{
									id: "array_target",
									source: "grid",
									output: `assets/${NAMESPACE}/textures/item/array_target.png`,
									steps: [{ type: "outline" }],
								},
							],
						},
						null,
						2,
					)}\n`,
					"utf8",
				);
				const project = join(projectDir, "mc-asset.pack.json");
				const refusal = await refusalOf(async () => {
					await executePackBuild(
						await planPackBuild(project, { recipe: recipePath }),
					);
				});
				assert.equal(refusal.code, "STYLE_INVALID");
				assert.equal(
					await bytesAt(join(projectDir, "mc-asset.lock.json")),
					null,
					"no lock is written on non-object style",
				);
			});
		},
	},
	{
		name: "a style document with newer formatVersion is refused with STYLE_UNSUPPORTED_VERSION and zero writes",
		async run() {
			await withProject(async (projectDir) => {
				const stylePath = join(projectDir, "recipes", "future.style.json");
				await writeFile(
					stylePath,
					`${JSON.stringify(
						{ formatVersion: 99, id: "future", name: "Future" },
						null,
						2,
					)}\n`,
					"utf8",
				);
				const recipePath = join(
					projectDir,
					"recipes",
					"future-style.recipe.json",
				);
				await writeFile(
					recipePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "future-style",
							style: "future.style.json",
							sources: {
								grid: { kind: "grid", path: "sources/sword.grid" },
							},
							targets: [
								{
									id: "future_target",
									source: "grid",
									output: `assets/${NAMESPACE}/textures/item/future_target.png`,
									steps: [{ type: "outline" }],
								},
							],
						},
						null,
						2,
					)}\n`,
					"utf8",
				);
				const project = join(projectDir, "mc-asset.pack.json");
				const refusal = await refusalOf(async () => {
					await executePackBuild(
						await planPackBuild(project, { recipe: recipePath }),
					);
				});
				assert.equal(refusal.code, "STYLE_UNSUPPORTED_VERSION");
				assert.equal(
					await bytesAt(join(projectDir, "mc-asset.lock.json")),
					null,
					"no lock is written on future style version",
				);
			});
		},
	},
	{
		name: "operations step converts JSON operations and executes them",
		async run() {
			await withProject(async (projectDir) => {
				const recipePath = join(projectDir, "recipes", "ops.recipe.json");
				const outputRel = `assets/${NAMESPACE}/textures/item/ops_sword.png`;
				await writeFile(
					recipePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "ops-recipe",
							sources: {
								grid: { kind: "grid", path: "sources/sword.grid" },
							},
							targets: [
								{
									id: "ops_target",
									source: "grid",
									output: outputRel,
									steps: [
										{
											type: "operations",
											operations: [
												{
													type: "setPixel",
													layerId: "base",
													color: "#FF00FFFF",
													x: 0,
													y: 0,
												},
											],
										},
									],
								},
							],
						},
						null,
						2,
					)}\n`,
					"utf8",
				);

				const project = join(projectDir, "mc-asset.pack.json");
				const plan = await planPackBuild(project, { recipe: recipePath });
				const executed = await executePackBuild(plan);
				assert.equal(executed.completed.length, 1);

				const writtenBytes = await bytesAt(join(projectDir, "pack", outputRel));
				assert.ok(writtenBytes, "output file exists");
				const canvas = decodePng(writtenBytes).canvas;
				const layer = canvas.layers[0];
				assert.ok(layer);
				const p = layer.pixels;
				assert.equal(p[0], 255);
				assert.equal(p[1], 0);
				assert.equal(p[2], 255);
				assert.equal(p[3], 255);

				// Rerun writes nothing
				const rerun = await executePackBuild(
					await planPackBuild(project, { recipe: recipePath }),
				);
				assert.deepEqual(rerun.completed, [], "rerun writes nothing");
			});
		},
	},
];
