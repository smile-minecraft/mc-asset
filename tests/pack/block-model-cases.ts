import assert from "node:assert/strict";
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
import { executePackBuild, planPackBuild } from "../../src/pack/build.ts";
import { initializePackProject } from "../../src/pack/init.ts";
import { parseLockText } from "../../src/pack/lock.ts";
import { scanPack } from "../../src/validate/pack.ts";

const NAMESPACE = "aurelian";

const PROJECT = "mc-asset.pack.json";

const V1_GRID = `; small pinned grid
[palette]
. = transparent
M = #C8C8C8FF

[grid]
..M.
.MMM
..M.
....
`;

/**
 * The formatVersion 1 pin. The documents below and the lock's outputHash
 * values were captured from the tree before the block steps were added;
 * inputHash is deliberately not pinned because it includes the tool version,
 * but its shape and the content hashes are.
 */
const V1_MODEL_TEXT = `{
  "parent": "minecraft:item/handheld",
  "textures": {
    "layer0": "aurelian:item/ruby_sword"
  }
}
`;

const V1_ITEM_TEXT = `{
  "model": {
    "cases": [
      {
        "model": "aurelian:item/ruby_sword",
        "when": [
          "gui",
          "fixed"
        ]
      }
    ],
    "fallback": "aurelian:item/ruby_sword",
    "property": "minecraft:display_context",
    "type": "minecraft:select"
  }
}
`;

const V1_OUTPUT_HASHES: Readonly<Record<string, string>> = {
	"pack/assets/aurelian/items/ruby_sword.json":
		"4a8b46e5d66848bdfdbf280bda8231fefd573ac1dfb0dc272b355db8f7316a71",
	"pack/assets/aurelian/models/item/ruby_sword.json":
		"be1c1286eade75abc728ae38366fed7eb66facde2b51e08bbdbe328bea04c886",
	"pack/assets/aurelian/textures/item/ruby_sword.png":
		"04af2285b068983229d9b48dd66ba32cfd8a6f002005f5d0386231334733316a",
};

/**
 * The bytes `main` 3e358c3 writes for a formatVersion 1
 * `itemDefinition` whose unknown `type` degenerates to the simple model
 * document. Pinned so the historical fallback cannot silently become a
 * refusal again.
 */
const V1_FALLBACK_STONE_TEXT = `{
  "model": {
    "model": "minecraft:item/stone",
    "type": "minecraft:model"
  }
}
`;

const V1_FALLBACK_DIRT_TEXT = `{
  "model": {
    "model": "minecraft:item/dirt",
    "type": "minecraft:model"
  }
}
`;

const V1_RECIPE = {
	formatVersion: 1,
	id: "v1-pin",
	sources: { grid: { kind: "grid", path: "sources/v1.grid" } },
	targets: [
		{
			id: "ruby_sword",
			source: "grid",
			output: "assets/aurelian/textures/item/ruby_sword.png",
			steps: [
				{ type: "model", parent: "handheld" },
				{
					type: "itemDefinition",
					definition: {
						type: "select",
						property: "minecraft:display_context",
						cases: [
							{
								when: ["gui", "fixed"],
								model: "aurelian:item/ruby_sword",
							},
						],
						fallback: "aurelian:item/ruby_sword",
					},
				},
			],
		},
	],
};

const BLOCK_MODEL_TEXT = `{
  "parent": "minecraft:block/cube_all",
  "textures": {
    "all": "aurelian:block/ruby_block"
  }
}
`;

const BLOCK_ITEM_MODEL_TEXT = `{
  "parent": "aurelian:block/ruby_block"
}
`;

const BLOCK_ITEM_DEFINITION_TEXT = `{
  "model": {
    "model": "aurelian:item/ruby_block",
    "type": "minecraft:model"
  }
}
`;

const BLOCKSTATE_TEXT = `{
  "variants": {
    "": {
      "model": "aurelian:block/ruby_block"
    }
  }
}
`;

const COMPOSITE_TEXT = `{
  "model": {
    "models": [
      {
        "model": "aurelian:item/lamp_glow",
        "tints": [
          {
            "type": "minecraft:constant",
            "value": -1
          }
        ],
        "type": "minecraft:model"
      },
      {
        "model": "aurelian:item/lamp_frame",
        "tints": [
          {
            "default": -6265536,
            "type": "minecraft:dye"
          }
        ],
        "type": "minecraft:model"
      }
    ],
    "type": "minecraft:composite"
  }
}
`;

const VARIANTS_TEXT = `{
  "variants": {
    "facing=east": [
      {
        "model": "minecraft:block/stone",
        "weight": 2,
        "y": 90
      },
      {
        "model": "minecraft:block/cobblestone",
        "y": 90
      }
    ],
    "facing=north": {
      "model": "minecraft:block/stone",
      "uvlock": true
    }
  }
}
`;

const MULTIPART_TEXT = `{
  "multipart": [
    {
      "apply": {
        "model": "minecraft:block/stone"
      },
      "when": {
        "north": "true"
      }
    },
    {
      "apply": [
        {
          "model": "minecraft:block/stone",
          "weight": 1
        },
        {
          "model": "minecraft:block/cobblestone",
          "weight": 2
        }
      ]
    }
  ]
}
`;

async function withProject(
	body: (projectDir: string) => Promise<void>,
	options: {
		resourcePackVersion?: string;
		minecraftVersion?: string;
	} = {},
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-block-model-"));
	const projectDir = join(dir, "forge");
	await initializePackProject({
		projectDir,
		namespace: NAMESPACE,
		minecraftVersion: options.minecraftVersion ?? "1.21.9",
		...(options.resourcePackVersion === undefined
			? {}
			: { resourcePackVersion: options.resourcePackVersion }),
		name: "forge",
	});
	try {
		await body(projectDir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function writeRecipe(
	projectDir: string,
	name: string,
	recipe: unknown,
): Promise<string> {
	const recipePath = join(projectDir, "recipes", `${name}.recipe.json`);
	await writeFile(recipePath, `${JSON.stringify(recipe, null, 2)}\n`, "utf8");
	return recipePath;
}

async function bytesAt(path: string): Promise<Uint8Array | null> {
	try {
		return await readFile(path);
	} catch {
		return null;
	}
}

async function textAt(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

async function refusalOf(body: () => Promise<unknown>): Promise<{
	code?: string;
	message?: string;
	details?: Record<string, unknown>;
}> {
	try {
		await body();
	} catch (error) {
		return error as {
			code?: string;
			message?: string;
			details?: Record<string, unknown>;
		};
	}
	assert.fail("expected a refusal but the call succeeded");
}

async function buildFrom(
	projectDir: string,
	recipeName: string,
): Promise<{ completed: readonly string[] }> {
	return executePackBuild(
		await planPackBuild(join(projectDir, PROJECT), {
			recipe: join(projectDir, "recipes", `${recipeName}.recipe.json`),
		}),
	);
}

/** A formatVersion 2 block recipe with one generated texture. */
function blockRecipe(): unknown {
	return {
		formatVersion: 2,
		id: "block-flow",
		sources: {
			tex: {
				kind: "generate",
				pattern: "checker",
				size: "16x16",
				palette: "stone",
				seed: 7,
			},
		},
		targets: [
			{
				id: "ruby_block",
				source: "tex",
				output: "assets/aurelian/textures/block/ruby_block.png",
				steps: [
					{
						type: "blockModel",
						parent: "cube_all",
						textures: { all: "aurelian:block/ruby_block" },
					},
					{
						type: "blockstate",
						variants: { "": { model: "aurelian:block/ruby_block" } },
					},
				],
			},
		],
	};
}

export const BLOCK_MODEL_CASES = [
	{
		name: "a block recipe writes the block model, item model, item definition, and blockstate",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(projectDir, "block", blockRecipe());
				const project = join(projectDir, PROJECT);
				const plan = await planPackBuild(project, {
					recipe: join(projectDir, "recipes", "block.recipe.json"),
				});
				assert.deepEqual(
					plan.outputs.map((output) => output.path).sort(),
					[
						"pack/assets/aurelian/blockstates/ruby_block.json",
						"pack/assets/aurelian/items/ruby_block.json",
						"pack/assets/aurelian/models/block/ruby_block.json",
						"pack/assets/aurelian/models/item/ruby_block.json",
						"pack/assets/aurelian/textures/block/ruby_block.png",
					],
					"the recipe plans five outputs",
				);
				const executed = await executePackBuild(plan);
				assert.equal(
					executed.completed.length,
					5,
					"all five files are written",
				);

				assert.equal(
					await textAt(
						join(
							projectDir,
							"pack/assets/aurelian/models/block/ruby_block.json",
						),
					),
					BLOCK_MODEL_TEXT,
					"the block model is the canonical cube_all document",
				);
				assert.equal(
					await textAt(
						join(
							projectDir,
							"pack/assets/aurelian/models/item/ruby_block.json",
						),
					),
					BLOCK_ITEM_MODEL_TEXT,
					"the block item model points at the block model",
				);
				assert.equal(
					await textAt(
						join(projectDir, "pack/assets/aurelian/items/ruby_block.json"),
					),
					BLOCK_ITEM_DEFINITION_TEXT,
					"the block item definition points at the item model",
				);
				assert.equal(
					await textAt(
						join(
							projectDir,
							"pack/assets/aurelian/blockstates/ruby_block.json",
						),
					),
					BLOCKSTATE_TEXT,
					"the blockstate is the canonical variants document",
				);

				const report = await scanPack(join(projectDir, "pack"));
				assert.equal(report.verdict, "pass", "validate-pack passes");
				assert.deepEqual(
					report.findings.filter((finding) => finding.level === "error"),
					[],
					"the six-faced block has no validation error",
				);

				const lock = parseLockText(
					await readFile(join(projectDir, "mc-asset.lock.json"), "utf8"),
				);
				assert.deepEqual(
					Object.fromEntries(
						Object.entries(lock.outputs).map(([path, entry]) => [
							path,
							entry.kind,
						]),
					),
					{
						"pack/assets/aurelian/blockstates/ruby_block.json": "blockstate",
						"pack/assets/aurelian/items/ruby_block.json": "itemDefinition",
						"pack/assets/aurelian/models/block/ruby_block.json": "blockModel",
						"pack/assets/aurelian/models/item/ruby_block.json":
							"blockItemModel",
						"pack/assets/aurelian/textures/block/ruby_block.png": "texture",
					},
					"every document family records its kind",
				);
			});
		},
	},
	{
		name: "every block parent preset writes its vanilla parent and required textures",
		async run() {
			await withProject(async (projectDir) => {
				const presets: Readonly<
					Record<string, Readonly<Record<string, string>>>
				> = {
					cube: {
						down: "minecraft:block/stone",
						up: "minecraft:block/stone",
						north: "minecraft:block/stone",
						south: "minecraft:block/stone",
						east: "minecraft:block/stone",
						west: "minecraft:block/stone",
					},
					cube_all: { all: "minecraft:block/stone" },
					cube_column: {
						end: "minecraft:block/stone",
						side: "minecraft:block/stone",
					},
					cube_bottom_top: {
						bottom: "minecraft:block/stone",
						top: "minecraft:block/stone",
						side: "minecraft:block/stone",
					},
					orientable: {
						front: "minecraft:block/stone",
						side: "minecraft:block/stone",
						top: "minecraft:block/stone",
					},
					cross: { cross: "minecraft:block/stone" },
					slab: {
						side: "minecraft:block/stone",
						bottom: "minecraft:block/stone",
						top: "minecraft:block/stone",
					},
					stairs: {
						side: "minecraft:block/stone",
						bottom: "minecraft:block/stone",
						top: "minecraft:block/stone",
					},
				};
				await writeRecipe(projectDir, "presets", {
					formatVersion: 2,
					id: "presets",
					targets: Object.entries(presets).map(([parent, textures]) => ({
						id: `${parent}_block`,
						steps: [{ type: "blockModel", parent, textures }],
					})),
				});
				const executed = await buildFrom(projectDir, "presets");
				assert.equal(
					executed.completed.length,
					Object.keys(presets).length * 3,
					"three documents per preset",
				);
				for (const [parent, textures] of Object.entries(presets)) {
					const text = await textAt(
						join(
							projectDir,
							`pack/assets/aurelian/models/block/${parent}_block.json`,
						),
					);
					assert.ok(text, `${parent} model is written`);
					const document = JSON.parse(text) as {
						parent?: string;
						textures?: Record<string, string>;
					};
					assert.equal(
						document.parent,
						`minecraft:block/${parent}`,
						`${parent} keeps its vanilla parent`,
					);
					assert.deepEqual(
						document.textures,
						textures,
						`${parent} keeps exactly the declared texture variables`,
					);
				}
				const report = await scanPack(join(projectDir, "pack"));
				assert.equal(report.verdict, "pass", "validate-pack passes");
			});
		},
	},
	{
		name: "a custom ModelSpec block writes elements and passes validation",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(projectDir, "custom", {
					formatVersion: 2,
					id: "custom-block",
					targets: [
						{
							id: "machine_block",
							steps: [
								{
									type: "blockModel",
									modelSpec: {
										parent: "minecraft:block/cube",
										textures: {
											down: "minecraft:block/stone",
											up: "minecraft:block/stone",
											north: "minecraft:block/stone",
											south: "minecraft:block/stone",
											east: "minecraft:block/stone",
											west: "minecraft:block/stone",
										},
										elements: [
											{
												from: [0, 0, 0],
												to: [16, 16, 16],
												faces: {
													down: { texture: "#down" },
													up: { texture: "#up" },
													north: { texture: "#north" },
													south: { texture: "#south" },
													east: { texture: "#east" },
													west: { texture: "#west" },
												},
											},
										],
									},
								},
							],
						},
					],
				});
				await buildFrom(projectDir, "custom");
				const text = await textAt(
					join(
						projectDir,
						"pack/assets/aurelian/models/block/machine_block.json",
					),
				);
				assert.ok(text, "the custom block model is written");
				const document = JSON.parse(text) as {
					parent?: string;
					elements?: Array<{ from?: number[]; to?: number[] }>;
				};
				assert.equal(document.parent, "minecraft:block/cube");
				assert.deepEqual(document.elements?.[0]?.from, [0, 0, 0]);
				assert.deepEqual(document.elements?.[0]?.to, [16, 16, 16]);
				const report = await scanPack(join(projectDir, "pack"));
				assert.equal(report.verdict, "pass", "validate-pack passes");
			});
		},
	},
	{
		name: "blockstate variants keep rotations and weighted alternatives",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(projectDir, "variants", {
					formatVersion: 2,
					id: "variants",
					targets: [
						{
							id: "machine",
							steps: [
								{
									type: "blockstate",
									variants: {
										"facing=north": {
											model: "minecraft:block/stone",
											uvlock: true,
										},
										"facing=east": [
											{
												model: "minecraft:block/stone",
												y: 90,
												weight: 2,
											},
											{
												model: "minecraft:block/cobblestone",
												y: 90,
											},
										],
									},
								},
							],
						},
					],
				});
				await buildFrom(projectDir, "variants");
				assert.equal(
					await textAt(
						join(projectDir, "pack/assets/aurelian/blockstates/machine.json"),
					),
					VARIANTS_TEXT,
					"variants are sorted and rendered as declared",
				);
			});
		},
	},
	{
		name: "blockstate multipart keeps conditions and weighted apply entries",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(projectDir, "multipart", {
					formatVersion: 2,
					id: "multipart",
					targets: [
						{
							id: "multipart_block",
							steps: [
								{
									type: "blockstate",
									multipart: [
										{
											when: { north: "true" },
											apply: { model: "minecraft:block/stone" },
										},
										{
											apply: [
												{
													model: "minecraft:block/stone",
													weight: 1,
												},
												{
													model: "minecraft:block/cobblestone",
													weight: 2,
												},
											],
										},
									],
								},
							],
						},
					],
				});
				await buildFrom(projectDir, "multipart");
				assert.equal(
					await textAt(
						join(
							projectDir,
							"pack/assets/aurelian/blockstates/multipart_block.json",
						),
					),
					MULTIPART_TEXT,
					"multipart is rendered as declared",
				);
			});
		},
	},
	{
		name: "a composite item definition with tints is written byte for byte",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(projectDir, "composite", {
					formatVersion: 2,
					id: "composite",
					sources: {
						tex: {
							kind: "generate",
							pattern: "checker",
							size: "16x16",
							palette: "stone",
							seed: 7,
						},
					},
					targets: [
						{
							id: "lamp",
							source: "tex",
							output: "assets/aurelian/textures/item/lamp.png",
							steps: [
								{
									type: "model",
									item: "lamp_glow",
									parent: "generated",
									texture: "aurelian:item/lamp",
								},
								{
									type: "model",
									item: "lamp_frame",
									parent: "generated",
									texture: "aurelian:item/lamp",
								},
								{
									type: "itemDefinition",
									definition: {
										type: "composite",
										models: [
											{
												type: "model",
												model: "aurelian:item/lamp_glow",
												tints: [{ type: "constant", value: -1 }],
											},
											{
												type: "model",
												model: "aurelian:item/lamp_frame",
												tints: [
													{
														type: "minecraft:dye",
														default: -6265536,
													},
												],
											},
										],
									},
								},
							],
						},
					],
				});
				await buildFrom(projectDir, "composite");
				assert.equal(
					await textAt(
						join(projectDir, "pack/assets/aurelian/items/lamp.json"),
					),
					COMPOSITE_TEXT,
					"the expected JSON matches the written bytes",
				);
				const report = await scanPack(join(projectDir, "pack"));
				assert.equal(report.verdict, "pass", "validate-pack passes");
			});
		},
	},
	{
		name: "a nested select, condition, composite, and special definition resolves",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(projectDir, "nested", {
					formatVersion: 2,
					id: "nested",
					sources: {
						tex: {
							kind: "generate",
							pattern: "checker",
							size: "16x16",
							palette: "stone",
							seed: 7,
						},
					},
					targets: [
						{
							id: "nested_item",
							source: "tex",
							output: "assets/aurelian/textures/item/nested.png",
							steps: [
								{
									type: "model",
									item: "base",
									parent: "generated",
									texture: "aurelian:item/nested",
								},
								{
									type: "model",
									item: "open",
									parent: "generated",
									texture: "aurelian:item/nested",
								},
								{
									type: "model",
									item: "closed",
									parent: "generated",
									texture: "aurelian:item/nested",
								},
								{
									type: "itemDefinition",
									definition: {
										type: "select",
										property: "minecraft:display_context",
										cases: [
											{
												when: "gui",
												model: {
													type: "composite",
													models: [
														{
															type: "model",
															model: "aurelian:item/base",
														},
														{
															type: "special",
															base: "aurelian:item/base",
															model: {
																type: "chest",
																texture: "normal",
															},
														},
													],
												},
											},
										],
										fallback: {
											type: "condition",
											property: "minecraft:damaged",
											on_true: "aurelian:item/open",
											on_false: "aurelian:item/closed",
										},
									},
								},
								{
									type: "blockstate",
									block: "nested_block",
									multipart: [
										{
											when: { north: "true" },
											apply: { model: "minecraft:block/stone" },
										},
									],
								},
							],
						},
					],
				});
				await buildFrom(projectDir, "nested");
				const text = await textAt(
					join(projectDir, "pack/assets/aurelian/items/nested_item.json"),
				);
				assert.ok(text, "the nested item definition is written");
				const document = JSON.parse(text) as {
					model?: {
						type?: string;
						cases?: Array<{
							when?: string;
							model?: {
								type?: string;
								models?: Array<{ type?: string }>;
							};
						}>;
						fallback?: { type?: string };
					};
				};
				assert.equal(document.model?.type, "minecraft:select");
				assert.equal(document.model?.cases?.[0]?.when, "gui");
				assert.equal(
					document.model?.cases?.[0]?.model?.type,
					"minecraft:composite",
				);
				assert.deepEqual(
					document.model?.cases?.[0]?.model?.models?.map((entry) => entry.type),
					["minecraft:model", "minecraft:special"],
				);
				assert.equal(document.model?.fallback?.type, "minecraft:condition");
				const report = await scanPack(join(projectDir, "pack"));
				assert.equal(report.verdict, "pass", "validate-pack passes");
			});
		},
	},
	{
		name: "a second build of the block recipe is own-clean and rewrites nothing",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(projectDir, "block", blockRecipe());
				await buildFrom(projectDir, "block");
				const lockPath = join(projectDir, "mc-asset.lock.json");
				const lockBefore = await bytesAt(lockPath);
				assert.ok(lockBefore, "the first build wrote a lock");
				const second = await planPackBuild(join(projectDir, PROJECT), {
					recipe: join(projectDir, "recipes", "block.recipe.json"),
				});
				assert.ok(
					second.outputs.every((output) => output.judgement === "own-clean"),
					"every output is own-clean",
				);
				const run = await executePackBuild(second);
				assert.deepEqual(run.completed, [], "the rerun rewrites nothing");
				assert.deepEqual(
					await bytesAt(lockPath),
					lockBefore,
					"the lock is byte-identical",
				);
			});
		},
	},
	{
		name: "a hand-edited blockstate is own-modified and refuses the batch",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(projectDir, "block", blockRecipe());
				await buildFrom(projectDir, "block");
				const blockstateRel =
					"pack/assets/aurelian/blockstates/ruby_block.json";
				await writeFile(join(projectDir, blockstateRel), "hand edit", "utf8");
				const textureRel = "pack/assets/aurelian/textures/block/ruby_block.png";
				const textureBefore = await bytesAt(join(projectDir, textureRel));
				const lockPath = join(projectDir, "mc-asset.lock.json");
				const lockBefore = await bytesAt(lockPath);
				const refusal = await refusalOf(async () =>
					buildFrom(projectDir, "block"),
				);
				assert.equal(refusal.code, "PACK_BUILD_CONFLICT");
				assert.deepEqual(refusal.details?.conflicts, [
					{ path: blockstateRel, reason: "own-modified" },
				]);
				assert.deepEqual(
					await bytesAt(join(projectDir, textureRel)),
					textureBefore,
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
		name: "a foreign block model refuses the batch before any write",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(projectDir, "block", blockRecipe());
				const foreignRel = "pack/assets/aurelian/models/block/ruby_block.json";
				await mkdir(join(projectDir, "pack/assets/aurelian/models/block"), {
					recursive: true,
				});
				await writeFile(join(projectDir, foreignRel), "someone else", "utf8");
				const refusal = await refusalOf(async () =>
					buildFrom(projectDir, "block"),
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
				assert.equal(
					await textAt(
						join(projectDir, "pack/assets/aurelian/items/ruby_block.json"),
					),
					null,
					"no other block document is written",
				);
			});
		},
	},
	{
		name: "blockModel below pack format 46.0 refuses with RECIPE_VERSION_UNSUPPORTED and writes nothing",
		async run() {
			await withProject(
				async (projectDir) => {
					await writeRecipe(projectDir, "old-block", {
						formatVersion: 2,
						id: "old-block",
						targets: [
							{
								id: "old_block",
								steps: [
									{
										type: "blockModel",
										parent: "cube_all",
										textures: { all: "minecraft:block/stone" },
									},
								],
							},
						],
					});
					const refusal = await refusalOf(async () =>
						buildFrom(projectDir, "old-block"),
					);
					assert.equal(refusal.code, "RECIPE_VERSION_UNSUPPORTED");
					assert.equal(refusal.details?.stepType, "blockModel");
					assert.equal(refusal.details?.actualFormat, "42.0");
					assert.equal(
						await bytesAt(join(projectDir, "mc-asset.lock.json")),
						null,
						"no lock is written",
					);
					const packEntries = await readdir(join(projectDir, "pack"));
					assert.ok(
						!packEntries.includes("models") &&
							!packEntries.includes("items") &&
							!packEntries.includes("blockstates"),
						"no block document is written",
					);
				},
				{ resourcePackVersion: "42.0", minecraftVersion: "1.21.3" },
			);
		},
	},
	{
		name: "composite item definitions below pack format 46.0 refuse with RECIPE_VERSION_UNSUPPORTED",
		async run() {
			await withProject(
				async (projectDir) => {
					await writeRecipe(projectDir, "old-composite", {
						formatVersion: 2,
						id: "old-composite",
						targets: [
							{
								id: "old_composite",
								steps: [
									{
										type: "itemDefinition",
										definition: {
											type: "composite",
											models: ["minecraft:item/stone"],
										},
									},
								],
							},
						],
					});
					const refusal = await refusalOf(async () =>
						buildFrom(projectDir, "old-composite"),
					);
					assert.equal(refusal.code, "RECIPE_VERSION_UNSUPPORTED");
					assert.equal(refusal.details?.stepType, "itemDefinition");
					assert.equal(
						await bytesAt(join(projectDir, "mc-asset.lock.json")),
						null,
						"no lock is written",
					);
				},
				{ resourcePackVersion: "42.0", minecraftVersion: "1.21.3" },
			);
		},
	},
	{
		name: "a blockstate z rotation below pack format 75.0 refuses with RECIPE_VERSION_UNSUPPORTED",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(projectDir, "z-rotation", {
					formatVersion: 2,
					id: "z-rotation",
					targets: [
						{
							id: "z_block",
							steps: [
								{
									type: "blockstate",
									variants: {
										"": { model: "minecraft:block/stone", z: 90 },
									},
								},
							],
						},
					],
				});
				const refusal = await refusalOf(async () =>
					buildFrom(projectDir, "z-rotation"),
				);
				assert.equal(refusal.code, "RECIPE_VERSION_UNSUPPORTED");
				assert.equal(refusal.details?.feature, "blockstateZRotation");
				assert.equal(
					await bytesAt(join(projectDir, "mc-asset.lock.json")),
					null,
					"no lock is written",
				);
				const packEntries = await readdir(join(projectDir, "pack"));
				assert.ok(
					!packEntries.includes("blockstates"),
					"no blockstate is written",
				);
			});
		},
	},
	{
		name: "formatVersion 1 refuses the formatVersion 2 steps",
		async run() {
			await withProject(async (projectDir) => {
				const attempts: Array<{ name: string; steps: unknown[] }> = [
					{
						name: "v1-block-step",
						steps: [
							{
								type: "blockModel",
								parent: "cube_all",
								textures: { all: "minecraft:block/stone" },
							},
						],
					},
					{
						name: "v1-blockstate-step",
						steps: [
							{
								type: "blockstate",
								variants: { "": { model: "minecraft:block/stone" } },
							},
						],
					},
				];
				for (const attempt of attempts) {
					const recipePath = await writeRecipe(projectDir, attempt.name, {
						formatVersion: 1,
						id: attempt.name,
						targets: [{ id: attempt.name, steps: attempt.steps }],
					});
					const refusal = await refusalOf(async () =>
						planPackBuild(join(projectDir, PROJECT), {
							recipe: recipePath,
						}),
					);
					assert.equal(
						refusal.code,
						"RECIPE_INVALID",
						`${attempt.name} is refused`,
					);
					assert.equal(
						refusal.details?.requiredFormatVersion,
						2,
						`${attempt.name} names the required recipe formatVersion`,
					);
				}
				assert.equal(
					await bytesAt(join(projectDir, "mc-asset.lock.json")),
					null,
					"nothing is built",
				);
			});
		},
	},
	{
		name: "formatVersion 1 keeps the historical fallback for unknown item definition types",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(projectDir, "v1-fallback", {
					formatVersion: 1,
					id: "v1-fallback",
					targets: [
						{
							id: "stone_item",
							steps: [
								{
									type: "itemDefinition",
									model: "minecraft:item/stone",
									definition: { type: "model" },
								},
							],
						},
						{
							id: "dirt_item",
							steps: [
								{
									type: "itemDefinition",
									model: "minecraft:item/dirt",
									definition: { type: "mystery" },
								},
							],
						},
					],
				});
				await buildFrom(projectDir, "v1-fallback");
				assert.equal(
					await textAt(
						join(projectDir, "pack/assets/aurelian/items/stone_item.json"),
					),
					V1_FALLBACK_STONE_TEXT,
					'the type: "model" definition keeps the main bytes',
				);
				const lock = parseLockText(
					await readFile(join(projectDir, "mc-asset.lock.json"), "utf8"),
				);
				assert.equal(
					lock.outputs["pack/assets/aurelian/items/stone_item.json"]
						?.outputHash,
					"6bed2ecb4b4e68535402eae1f8a91242fe76857c3ea8a0c60e6304a4135639ec",
					"the pinned output hash matches main 3e358c3",
				);
				assert.equal(
					await textAt(
						join(projectDir, "pack/assets/aurelian/items/dirt_item.json"),
					),
					V1_FALLBACK_DIRT_TEXT,
					"an unknown definition type also falls back to the simple model",
				);
			});
		},
	},
	{
		name: "a blockstate z rotation is rechecked when an own-clean project drops below format 75.0",
		async run() {
			await withProject(
				async (projectDir) => {
					await writeRecipe(projectDir, "z-rotation", {
						formatVersion: 2,
						id: "z-rotation",
						targets: [
							{
								id: "z_block",
								steps: [
									{
										type: "blockstate",
										variants: {
											"": { model: "minecraft:block/stone", z: 90 },
										},
									},
								],
							},
						],
					});
					await buildFrom(projectDir, "z-rotation");
					const lockPath = join(projectDir, "mc-asset.lock.json");
					const blockstatePath = join(
						projectDir,
						"pack/assets/aurelian/blockstates/z_block.json",
					);
					const lockBefore = await bytesAt(lockPath);
					const blockstateBefore = await bytesAt(blockstatePath);
					assert.ok(lockBefore, "the 75.0 build wrote a lock");
					assert.ok(blockstateBefore, "the 75.0 build wrote the blockstate");

					const projectPath = join(projectDir, PROJECT);
					const project = JSON.parse(
						await readFile(projectPath, "utf8"),
					) as Record<string, unknown>;
					project.minecraftVersion = "1.21.9";
					project.resourcePackVersion = "69.0";
					await writeFile(
						projectPath,
						`${JSON.stringify(project, null, 2)}\n`,
						"utf8",
					);

					const refusal = await refusalOf(async () =>
						buildFrom(projectDir, "z-rotation"),
					);
					assert.equal(refusal.code, "RECIPE_VERSION_UNSUPPORTED");
					assert.equal(refusal.details?.feature, "blockstateZRotation");
					assert.equal(refusal.details?.actualFormat, "69.0");
					assert.deepEqual(
						await bytesAt(lockPath),
						lockBefore,
						"the own-clean lock is unchanged",
					);
					assert.deepEqual(
						await bytesAt(blockstatePath),
						blockstateBefore,
						"the own-clean blockstate is unchanged",
					);
				},
				{ minecraftVersion: "1.21.11" },
			);
		},
	},
	{
		name: "a dry-run plan checks blockstate version support without writing",
		async run() {
			await withProject(async (projectDir) => {
				const recipePath = await writeRecipe(projectDir, "z-rotation", {
					formatVersion: 2,
					id: "z-rotation",
					targets: [
						{
							id: "z_block",
							steps: [
								{
									type: "blockstate",
									variants: {
										"": { model: "minecraft:block/stone", z: 90 },
									},
								},
							],
						},
					],
				});
				const refusal = await refusalOf(async () =>
					planPackBuild(join(projectDir, PROJECT), {
						recipe: recipePath,
						dryRun: true,
					}),
				);
				assert.equal(refusal.code, "RECIPE_VERSION_UNSUPPORTED");
				assert.equal(refusal.details?.feature, "blockstateZRotation");
				assert.equal(refusal.details?.actualFormat, "69.0");
				assert.equal(
					await bytesAt(join(projectDir, "mc-asset.lock.json")),
					null,
					"the dry run writes no lock",
				);
				const packEntries = await readdir(join(projectDir, "pack"));
				assert.ok(
					!packEntries.includes("blockstates"),
					"the dry run writes no blockstate",
				);
			});
		},
	},
	{
		name: "blockstate model references that are not resource locations are refused in planning",
		async run() {
			await withProject(async (projectDir) => {
				const attempts: Array<{
					name: string;
					step: unknown;
					field: string;
				}> = [
					{
						name: "bad-variant-model",
						step: {
							type: "blockstate",
							variants: { "": { model: "INVALID MODEL" } },
						},
						field: "variants.model",
					},
					{
						name: "bad-multipart-model",
						step: {
							type: "blockstate",
							multipart: [{ apply: { model: "aurelian:Block/Stone" } }],
						},
						field: "multipart[0].apply.model",
					},
				];
				for (const attempt of attempts) {
					const recipePath = await writeRecipe(projectDir, attempt.name, {
						formatVersion: 2,
						id: attempt.name,
						targets: [{ id: "bad_block", steps: [attempt.step] }],
					});
					const refusal = await refusalOf(async () =>
						planPackBuild(join(projectDir, PROJECT), {
							recipe: recipePath,
						}),
					);
					assert.equal(
						refusal.code,
						"RECIPE_INVALID",
						`${attempt.name} is refused`,
					);
					assert.equal(refusal.details?.targetId, "bad_block");
					assert.equal(refusal.details?.stepIndex, 0);
					assert.equal(
						refusal.details?.field,
						attempt.field,
						`${attempt.name} names the reference field`,
					);
					assert.equal(
						typeof refusal.details?.model,
						"string",
						`${attempt.name} names the unusable reference`,
					);
				}
				assert.equal(
					await bytesAt(join(projectDir, "mc-asset.lock.json")),
					null,
					"nothing is built",
				);
				const packEntries = await readdir(join(projectDir, "pack"));
				assert.ok(
					!packEntries.includes("blockstates"),
					"no blockstate is written",
				);
			});
		},
	},
	{
		name: "blockstate variant keys expand recipe variables",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(projectDir, "key-substitution", {
					formatVersion: 2,
					id: "key-substitution",
					variables: { facing: ["north", "east"] },
					targets: [
						{
							id: "lamp_{facing}",
							steps: [
								{
									type: "blockstate",
									variants: {
										"facing={facing}": { model: "minecraft:block/stone" },
									},
								},
							],
						},
					],
				});
				await buildFrom(projectDir, "key-substitution");
				const north = JSON.parse(
					(await textAt(
						join(
							projectDir,
							"pack/assets/aurelian/blockstates/lamp_north.json",
						),
					)) ?? "{}",
				) as { variants?: Record<string, unknown> };
				const east = JSON.parse(
					(await textAt(
						join(projectDir, "pack/assets/aurelian/blockstates/lamp_east.json"),
					)) ?? "{}",
				) as { variants?: Record<string, unknown> };
				assert.deepEqual(Object.keys(north.variants ?? {}), ["facing=north"]);
				assert.deepEqual(Object.keys(east.variants ?? {}), ["facing=east"]);
			});
		},
	},
	{
		name: "a variable used only in a variant key counts as used",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(projectDir, "key-only-variable", {
					formatVersion: 2,
					id: "key-only-variable",
					variables: { facing: ["north"] },
					targets: [
						{
							id: "lamp",
							steps: [
								{
									type: "blockstate",
									variants: {
										"facing={facing}": { model: "minecraft:block/stone" },
									},
								},
							],
						},
					],
				});
				await buildFrom(projectDir, "key-only-variable");
				const document = JSON.parse(
					(await textAt(
						join(projectDir, "pack/assets/aurelian/blockstates/lamp.json"),
					)) ?? "{}",
				) as { variants?: Record<string, unknown> };
				assert.deepEqual(Object.keys(document.variants ?? {}), [
					"facing=north",
				]);
			});
		},
	},
	{
		name: "variant keys that collapse after substitution are refused",
		async run() {
			await withProject(async (projectDir) => {
				const recipePath = await writeRecipe(projectDir, "key-collision", {
					formatVersion: 2,
					id: "key-collision",
					variables: { direction: ["north"] },
					targets: [
						{
							id: "lamp",
							steps: [
								{
									type: "blockstate",
									variants: {
										"facing={direction}": { model: "minecraft:block/stone" },
										"facing=north": { model: "minecraft:block/cobblestone" },
									},
								},
							],
						},
					],
				});
				const refusal = await refusalOf(async () =>
					planPackBuild(join(projectDir, PROJECT), { recipe: recipePath }),
				);
				assert.equal(refusal.code, "RECIPE_INVALID");
				assert.equal(refusal.details?.key, "facing=north");
				assert.deepEqual(refusal.details?.keys, [
					"facing={direction}",
					"facing=north",
				]);
				assert.equal(
					await bytesAt(join(projectDir, "mc-asset.lock.json")),
					null,
					"nothing is built",
				);
			});
		},
	},
	{
		name: "an unsupported recipe formatVersion is refused with RECIPE_UNSUPPORTED_VERSION",
		async run() {
			await withProject(async (projectDir) => {
				const recipePath = await writeRecipe(projectDir, "future", {
					formatVersion: 3,
					id: "future",
					targets: [
						{
							id: "future_block",
							steps: [
								{
									type: "blockModel",
									parent: "cube_all",
									textures: { all: "minecraft:block/stone" },
								},
							],
						},
					],
				});
				const refusal = await refusalOf(async () =>
					planPackBuild(join(projectDir, PROJECT), { recipe: recipePath }),
				);
				assert.equal(refusal.code, "RECIPE_UNSUPPORTED_VERSION");
				assert.equal(refusal.details?.formatVersion, 3);
				assert.equal(
					await bytesAt(join(projectDir, "mc-asset.lock.json")),
					null,
					"nothing is planned or built",
				);
			});
		},
	},
	{
		name: "formatVersion 1 documents and lock content stay pinned",
		async run() {
			await withProject(async (projectDir) => {
				const sourceDir = join(projectDir, "recipes", "sources");
				await mkdir(sourceDir, { recursive: true });
				await writeFile(join(sourceDir, "v1.grid"), V1_GRID, "utf8");
				await writeRecipe(projectDir, "v1", V1_RECIPE);
				await buildFrom(projectDir, "v1");

				assert.equal(
					await textAt(
						join(
							projectDir,
							"pack/assets/aurelian/models/item/ruby_sword.json",
						),
					),
					V1_MODEL_TEXT,
					"the v1 model bytes are unchanged",
				);
				assert.equal(
					await textAt(
						join(projectDir, "pack/assets/aurelian/items/ruby_sword.json"),
					),
					V1_ITEM_TEXT,
					"the v1 item definition bytes are unchanged",
				);

				const lockPath = join(projectDir, "mc-asset.lock.json");
				const lockBefore = await bytesAt(lockPath);
				assert.ok(lockBefore, "the v1 build wrote a lock");
				const lock = parseLockText(await readFile(lockPath, "utf8"));
				assert.deepEqual(
					Object.keys(lock.outputs),
					[...Object.keys(V1_OUTPUT_HASHES)].sort(),
					"the lock keys keep their byte order",
				);
				for (const [path, outputHash] of Object.entries(V1_OUTPUT_HASHES)) {
					assert.equal(
						lock.outputs[path]?.outputHash,
						outputHash,
						`${path} keeps its pinned content hash`,
					);
					assert.match(
						lock.outputs[path]?.inputHash ?? "",
						/^[0-9a-f]{64}$/,
						`${path} keeps a well-formed input hash`,
					);
				}
				assert.equal(
					lock.outputs["pack/assets/aurelian/models/item/ruby_sword.json"]
						?.kind,
					"model",
				);
				assert.equal(
					lock.outputs["pack/assets/aurelian/items/ruby_sword.json"]?.kind,
					"itemDefinition",
				);
				assert.equal(
					lock.outputs["pack/assets/aurelian/textures/item/ruby_sword.png"]
						?.kind,
					"texture",
				);

				const rerun = await buildFrom(projectDir, "v1");
				assert.deepEqual(rerun.completed, [], "a v1 rerun rewrites nothing");
				assert.deepEqual(
					await bytesAt(lockPath),
					lockBefore,
					"the v1 lock is byte-identical across runs",
				);
			});
		},
	},
	{
		name: "malformed blockModel steps are refused before any write",
		async run() {
			await withProject(async (projectDir) => {
				const attempts: Array<{ name: string; step: unknown }> = [
					{
						name: "unknown-texture",
						step: {
							type: "blockModel",
							parent: "cube_all",
							textures: { al: "minecraft:block/stone" },
						},
					},
					{
						name: "missing-texture",
						step: {
							type: "blockModel",
							parent: "cube_column",
							textures: { end: "minecraft:block/stone" },
						},
					},
					{
						name: "two-sources",
						step: {
							type: "blockModel",
							parent: "cube_all",
							textures: { all: "minecraft:block/stone" },
							modelSpec: { parent: "minecraft:block/cube_all" },
						},
					},
					{
						name: "dangling-alias",
						step: {
							type: "blockModel",
							parent: "cube_all",
							textures: { all: "#missing" },
						},
					},
					{
						name: "unknown-spec-field",
						step: {
							type: "blockModel",
							modelSpec: {
								parent: "minecraft:block/cube_all",
								bogus: true,
							},
						},
					},
				];
				for (const attempt of attempts) {
					const recipePath = await writeRecipe(projectDir, attempt.name, {
						formatVersion: 2,
						id: attempt.name,
						targets: [{ id: "thing", steps: [attempt.step] }],
					});
					const refusal = await refusalOf(async () =>
						planPackBuild(join(projectDir, PROJECT), {
							recipe: recipePath,
						}),
					);
					assert.equal(
						refusal.code,
						"RECIPE_INVALID",
						`${attempt.name} is refused`,
					);
				}
				assert.equal(
					await bytesAt(join(projectDir, "mc-asset.lock.json")),
					null,
					"nothing is built",
				);
				const packEntries = await readdir(join(projectDir, "pack"));
				assert.ok(!packEntries.includes("models"), "no model is written");
			});
		},
	},
	{
		name: "malformed blockstate steps are refused before any write",
		async run() {
			await withProject(async (projectDir) => {
				const attempts: Array<{ name: string; step: unknown }> = [
					{
						name: "both-shapes",
						step: {
							type: "blockstate",
							variants: { "": { model: "minecraft:block/stone" } },
							multipart: [{ apply: { model: "minecraft:block/stone" } }],
						},
					},
					{
						name: "missing-model",
						step: {
							type: "blockstate",
							variants: { "": { y: 90 } },
						},
					},
					{
						name: "unknown-entry-field",
						step: {
							type: "blockstate",
							variants: {
								"": {
									model: "minecraft:block/stone",
									bogus: true,
								},
							},
						},
					},
					{
						name: "bad-when-value",
						step: {
							type: "blockstate",
							multipart: [
								{
									when: { north: 1 },
									apply: { model: "minecraft:block/stone" },
								},
							],
						},
					},
					{
						name: "weight-outside-array",
						step: {
							type: "blockstate",
							variants: {
								"": { model: "minecraft:block/stone", weight: 2 },
							},
						},
					},
					{
						name: "non-boolean-uvlock",
						step: {
							type: "blockstate",
							variants: {
								"": { model: "minecraft:block/stone", uvlock: "true" },
							},
						},
					},
				];
				for (const attempt of attempts) {
					const recipePath = await writeRecipe(projectDir, attempt.name, {
						formatVersion: 2,
						id: attempt.name,
						targets: [{ id: "thing", steps: [attempt.step] }],
					});
					const refusal = await refusalOf(async () =>
						executePackBuild(
							await planPackBuild(join(projectDir, PROJECT), {
								recipe: recipePath,
							}),
						),
					);
					assert.equal(
						refusal.code,
						"RECIPE_INVALID",
						`${attempt.name} is refused`,
					);
				}
				assert.equal(
					await bytesAt(join(projectDir, "mc-asset.lock.json")),
					null,
					"nothing is built",
				);
				const packEntries = await readdir(join(projectDir, "pack"));
				assert.ok(
					!packEntries.includes("blockstates"),
					"no blockstate is written",
				);
			});
		},
	},
	{
		name: "malformed composite, special, and tint nodes are refused",
		async run() {
			await withProject(async (projectDir) => {
				const attempts: Array<{ name: string; definition: unknown }> = [
					{
						name: "empty-composite",
						definition: { type: "composite", models: [] },
					},
					{
						name: "special-without-base",
						definition: {
							type: "special",
							model: { type: "chest", texture: "normal" },
						},
					},
					{
						name: "tint-without-type",
						definition: {
							type: "model",
							model: "minecraft:item/stone",
							tints: [{ value: -1 }],
						},
					},
					{
						name: "unknown-node",
						definition: { type: "mystery", model: "minecraft:item/stone" },
					},
					{
						name: "select-without-when",
						definition: {
							type: "select",
							cases: [{ model: "minecraft:item/stone" }],
							fallback: "minecraft:item/stone",
						},
					},
				];
				for (const attempt of attempts) {
					const recipePath = await writeRecipe(projectDir, attempt.name, {
						formatVersion: 2,
						id: attempt.name,
						targets: [
							{
								id: "thing",
								steps: [
									{
										type: "itemDefinition",
										definition: attempt.definition,
									},
								],
							},
						],
					});
					const refusal = await refusalOf(async () =>
						executePackBuild(
							await planPackBuild(join(projectDir, PROJECT), {
								recipe: recipePath,
							}),
						),
					);
					assert.equal(
						refusal.code,
						"RECIPE_INVALID",
						`${attempt.name} is refused`,
					);
				}
				assert.equal(
					await bytesAt(join(projectDir, "mc-asset.lock.json")),
					null,
					"nothing is built",
				);
			});
		},
	},
	{
		name: "a nested item definition pointing at a missing model is refused",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(projectDir, "broken-ref", {
					formatVersion: 2,
					id: "broken-ref",
					targets: [
						{
							id: "thing",
							steps: [
								{
									type: "itemDefinition",
									definition: {
										type: "composite",
										models: [
											{
												type: "model",
												model: "aurelian:item/missing_layer",
											},
										],
									},
								},
							],
						},
					],
				});
				const refusal = await refusalOf(async () =>
					planPackBuild(join(projectDir, PROJECT), {
						recipe: join(projectDir, "recipes", "broken-ref.recipe.json"),
					}),
				);
				assert.equal(refusal.code, "PACK_BROKEN_REFERENCE");
				assert.equal(refusal.details?.model, "aurelian:item/missing_layer");
			});
		},
	},
	{
		name: "a blockModel and a model step writing the same item model conflict",
		async run() {
			await withProject(async (projectDir) => {
				await writeRecipe(projectDir, "duplicate", {
					formatVersion: 2,
					id: "duplicate",
					targets: [
						{
							id: "ruby_block",
							steps: [
								{
									type: "blockModel",
									parent: "cube_all",
									textures: { all: "minecraft:block/stone" },
								},
								{ type: "model", item: "ruby_block", parent: "generated" },
							],
						},
					],
				});
				const refusal = await refusalOf(async () =>
					planPackBuild(join(projectDir, PROJECT), {
						recipe: join(projectDir, "recipes", "duplicate.recipe.json"),
					}),
				);
				assert.equal(refusal.code, "RECIPE_OUTPUT_CONFLICT");
				const conflicts = refusal.details?.conflicts as string[];
				assert.ok(
					conflicts.includes("assets/aurelian/models/item/ruby_block.json"),
					"the shared item model is named",
				);
			});
		},
	},
	{
		name: "two recipes writing the same block document conflict",
		async run() {
			await withProject(async (projectDir) => {
				const recipe = (id: string): unknown => ({
					formatVersion: 2,
					id,
					targets: [
						{
							id: "shared_block",
							steps: [
								{
									type: "blockModel",
									parent: "cube_all",
									textures: { all: "minecraft:block/stone" },
								},
							],
						},
					],
				});
				await writeRecipe(projectDir, "first", recipe("first"));
				await writeRecipe(projectDir, "second", recipe("second"));
				const refusal = await refusalOf(async () =>
					planPackBuild(join(projectDir, PROJECT)),
				);
				assert.equal(refusal.code, "RECIPE_OUTPUT_CONFLICT");
				const conflicts = refusal.details?.conflicts as string[];
				assert.deepEqual(conflicts, [
					"pack/assets/aurelian/models/block/shared_block.json",
				]);
			});
		},
	},
];
