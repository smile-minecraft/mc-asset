import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executePackBuild, planPackBuild } from "../../src/pack/build.ts";
import { initializePackProject } from "../../src/pack/init.ts";
import { parseLockText } from "../../src/pack/lock.ts";
import { scanPack } from "../../src/validate/pack.ts";

const NAMESPACE = "aurelian";

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

async function withProject(
	body: (projectDir: string) => Promise<void>,
	initOptions?: {
		resourcePackVersion?: string;
		namespace?: string;
		allowMinecraftNamespace?: boolean;
	},
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-item-model-"));
	const projectDir = join(dir, "forge");
	await initializePackProject({
		projectDir,
		namespace: initOptions?.namespace ?? NAMESPACE,
		minecraftVersion: "1.21.9",
		resourcePackVersion: initOptions?.resourcePackVersion,
		allowMinecraftNamespace: initOptions?.allowMinecraftNamespace,
		name: "forge",
	});
	const recipeDir = join(projectDir, "recipes");
	await mkdir(join(recipeDir, "sources"), { recursive: true });
	await writeFile(join(recipeDir, "sources", "sword.grid"), GRID, "utf8");
	try {
		await body(projectDir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function bytesAt(path: string): Promise<Uint8Array | null> {
	try {
		return await readFile(path);
	} catch {
		return null;
	}
}

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

export const ITEM_MODEL_CASES = [
	{
		name: "handheld item model and item definition are generated and pass pack validation",
		async run() {
			await withProject(async (projectDir) => {
				const recipePath = join(projectDir, "recipes", "handheld.recipe.json");
				const texRel = `assets/${NAMESPACE}/textures/item/ruby_sword.png`;
				await writeFile(
					recipePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "ruby-sword-handheld",
							sources: {
								grid: { kind: "grid", path: "sources/sword.grid" },
							},
							targets: [
								{
									id: "ruby_sword",
									category: "sword",
									source: "grid",
									output: texRel,
									steps: [
										{ type: "recolor", family: "iron" },
										{ type: "model", parent: "handheld" },
										{ type: "itemDefinition" },
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
					3,
					"planned texture, model, and itemDefinition",
				);

				const executed = await executePackBuild(plan);
				assert.equal(executed.completed.length, 3, "all 3 files written");

				const modelPath = join(
					projectDir,
					"pack",
					"assets",
					NAMESPACE,
					"models",
					"item",
					"ruby_sword.json",
				);
				const itemDefPath = join(
					projectDir,
					"pack",
					"assets",
					NAMESPACE,
					"items",
					"ruby_sword.json",
				);

				const modelBytes = await bytesAt(modelPath);
				assert.ok(modelBytes, "model file was generated");
				const modelDoc = JSON.parse(new TextDecoder().decode(modelBytes)) as {
					parent?: string;
					textures?: { layer0?: string };
				};
				assert.equal(modelDoc.parent, "minecraft:item/handheld");
				assert.equal(modelDoc.textures?.layer0, `${NAMESPACE}:item/ruby_sword`);

				const itemBytes = await bytesAt(itemDefPath);
				assert.ok(itemBytes, "item definition was generated");
				const itemDoc = JSON.parse(new TextDecoder().decode(itemBytes)) as {
					model?: { type?: string; model?: string };
				};
				assert.equal(itemDoc.model?.type, "minecraft:model");
				assert.equal(itemDoc.model?.model, `${NAMESPACE}:item/ruby_sword`);

				const report = await scanPack(join(projectDir, "pack"));
				assert.equal(report.verdict, "pass");
				assert.deepEqual(
					report.findings.filter((f) => f.level === "error"),
					[],
				);

				const lock = parseLockText(
					await readFile(join(projectDir, "mc-asset.lock.json"), "utf8"),
				);
				assert.equal(
					lock.outputs[`pack/assets/${NAMESPACE}/models/item/ruby_sword.json`]
						?.kind,
					"model",
				);
				assert.equal(
					lock.outputs[`pack/assets/${NAMESPACE}/items/ruby_sword.json`]?.kind,
					"itemDefinition",
				);
			});
		},
	},
	{
		name: "dual-form item definition with select template generates 2D, 3D models and definition",
		async run() {
			await withProject(async (projectDir) => {
				const recipePath = join(projectDir, "recipes", "dual-form.recipe.json");
				await writeFile(
					recipePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "ruby-sword-dual",
							sources: {
								grid: { kind: "grid", path: "sources/sword.grid" },
							},
							targets: [
								{
									id: "ruby_sword",
									category: "sword",
									source: "grid",
									output: `assets/${NAMESPACE}/textures/item/ruby_sword.png`,
									steps: [
										{ type: "recolor", family: "iron" },
										{ type: "model", parent: "handheld" },
										{
											type: "model",
											item: "ruby_sword_3d",
											modelSpec: {
												ambientocclusion: false,
												textures: { layer0: `${NAMESPACE}:item/ruby_sword` },
												elements: [
													{
														from: [0, 0, 5],
														to: [16, 16, 11],
														faces: {
															north: { uv: [0, 0, 16, 16], texture: "#layer0" },
														},
													},
												],
											},
										},
										{
											type: "itemDefinition",
											model: `${NAMESPACE}:item/ruby_sword`,
											definition: {
												type: "select",
												property: "minecraft:display_context",
												cases: [
													{
														when: ["gui", "fixed"],
														model: `${NAMESPACE}:item/ruby_sword`,
													},
													{
														when: [
															"ground",
															"thirdperson_righthand",
															"thirdperson_lefthand",
														],
														model: `${NAMESPACE}:item/ruby_sword_3d`,
													},
												],
												fallback: `${NAMESPACE}:item/ruby_sword`,
											},
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
					4,
					"texture, 2D model, 3D model, and item definition",
				);

				const executed = await executePackBuild(plan);
				assert.equal(executed.completed.length, 4, "all 4 outputs written");

				const model2dBytes = await bytesAt(
					join(
						projectDir,
						"pack",
						"assets",
						NAMESPACE,
						"models",
						"item",
						"ruby_sword.json",
					),
				);
				const model3dBytes = await bytesAt(
					join(
						projectDir,
						"pack",
						"assets",
						NAMESPACE,
						"models",
						"item",
						"ruby_sword_3d.json",
					),
				);
				const itemBytes = await bytesAt(
					join(
						projectDir,
						"pack",
						"assets",
						NAMESPACE,
						"items",
						"ruby_sword.json",
					),
				);

				assert.ok(model2dBytes, "2D model written");
				assert.ok(model3dBytes, "3D model written");
				assert.ok(itemBytes, "item definition written");

				const report = await scanPack(join(projectDir, "pack"));
				assert.equal(report.verdict, "pass");
				assert.deepEqual(
					report.findings.filter((f) => f.level === "error"),
					[],
				);
			});
		},
	},
	{
		name: "durability dispatch item definition with range_dispatch and condition template",
		async run() {
			await withProject(async (projectDir) => {
				const recipePath = join(
					projectDir,
					"recipes",
					"durability.recipe.json",
				);
				await writeFile(
					recipePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "ruby-sword-durability",
							sources: {
								grid: { kind: "grid", path: "sources/sword.grid" },
							},
							targets: [
								{
									id: "ruby_sword",
									category: "sword",
									source: "grid",
									output: `assets/${NAMESPACE}/textures/item/ruby_sword.png`,
									steps: [
										{ type: "recolor", family: "iron" },
										{ type: "model", parent: "handheld" },
										{
											type: "itemDefinition",
											definition: {
												type: "range_dispatch",
												property: "minecraft:damage",
												entries: [
													{
														threshold: 0.5,
														model: `${NAMESPACE}:item/ruby_sword`,
													},
													{
														threshold: 0.9,
														model: `${NAMESPACE}:item/ruby_sword`,
													},
												],
												fallback: `${NAMESPACE}:item/ruby_sword`,
											},
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
				assert.equal(
					executed.completed.length,
					3,
					"texture, model, and range_dispatch definition",
				);

				const itemBytes = await bytesAt(
					join(
						projectDir,
						"pack",
						"assets",
						NAMESPACE,
						"items",
						"ruby_sword.json",
					),
				);
				assert.ok(itemBytes, "range_dispatch item definition written");

				const report = await scanPack(join(projectDir, "pack"));
				assert.equal(report.verdict, "pass");
				assert.deepEqual(
					report.findings.filter((f) => f.level === "error"),
					[],
				);
			});
		},
	},
	{
		name: "itemDefinition step on pack format below 46.0 is refused with RECIPE_VERSION_UNSUPPORTED",
		async run() {
			await withProject(
				async (projectDir) => {
					const recipePath = join(
						projectDir,
						"recipes",
						"old-format.recipe.json",
					);
					await writeFile(
						recipePath,
						`${JSON.stringify(
							{
								formatVersion: 1,
								id: "old-item",
								sources: { grid: { kind: "grid", path: "sources/sword.grid" } },
								targets: [
									{
										id: "old_target",
										source: "grid",
										output: `assets/${NAMESPACE}/textures/item/old.png`,
										steps: [{ type: "itemDefinition" }],
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
					assert.equal(refusal.code, "RECIPE_VERSION_UNSUPPORTED");
					assert.equal(refusal.details?.targetId, "old_target");
				},
				{ resourcePackVersion: "42.0" },
			);
		},
	},
	{
		name: "item definition or model in minecraft namespace without override is refused with RECIPE_INVALID",
		async run() {
			await withProject(
				async (projectDir) => {
					const recipePath = join(
						projectDir,
						"recipes",
						"mc-override.recipe.json",
					);
					await writeFile(
						recipePath,
						`${JSON.stringify(
							{
								formatVersion: 1,
								id: "mc-no-override",
								sources: { grid: { kind: "grid", path: "sources/sword.grid" } },
								targets: [
									{
										id: "iron_sword",
										source: "grid",
										output: "assets/minecraft/textures/item/iron_sword.png",
										steps: [{ type: "model", parent: "handheld" }],
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
					assert.equal(refusal.code, "RECIPE_INVALID");
				},
				{ namespace: "minecraft", allowMinecraftNamespace: true },
			);
		},
	},
	{
		name: "item definition referencing non-existent model is refused with PACK_BROKEN_REFERENCE",
		async run() {
			await withProject(async (projectDir) => {
				const recipePath = join(
					projectDir,
					"recipes",
					"broken-ref.recipe.json",
				);
				await writeFile(
					recipePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "broken-model-ref",
							sources: { grid: { kind: "grid", path: "sources/sword.grid" } },
							targets: [
								{
									id: "sword",
									source: "grid",
									output: `assets/${NAMESPACE}/textures/item/sword.png`,
									steps: [
										{
											type: "itemDefinition",
											model: `${NAMESPACE}:item/missing_3d_model`,
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
				const refusal = await refusalOf(async () => {
					await executePackBuild(
						await planPackBuild(project, { recipe: recipePath }),
					);
				});
				assert.equal(refusal.code, "PACK_BROKEN_REFERENCE");
			});
		},
	},
	{
		name: "recipe target with illegal namespace is refused with RECIPE_INVALID",
		async run() {
			await withProject(async (projectDir) => {
				const recipePath = join(
					projectDir,
					"recipes",
					"illegal-ns.recipe.json",
				);
				await writeFile(
					recipePath,
					`${JSON.stringify(
						{
							formatVersion: 1,
							id: "illegal-ns",
							sources: { grid: { kind: "grid", path: "sources/sword.grid" } },
							targets: [
								{
									id: "bad_target",
									source: "grid",
									output: "assets/UPPERCASE/textures/item/bad.png",
									steps: [{ type: "model" }],
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
				assert.equal(refusal.code, "RECIPE_INVALID");
			});
		},
	},
];
