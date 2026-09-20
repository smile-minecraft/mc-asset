import {
	atlasCoverageFor,
	parseAtlasDefinitions,
	requiredAtlasForModel,
} from "../../src/validate/atlas.ts";

/** Runner-agnostic assertion surface shared by the bun and node entries. */
export interface AtlasCaseCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
}

export interface AtlasCase {
	name: string;
	run(check: AtlasCaseCheck): Promise<void> | void;
}

function docsOf(entries: Array<[string, unknown]>): Map<string, unknown> {
	return new Map(entries);
}

export const ATLAS_CASES: AtlasCase[] = [
	{
		name: "directory source covers its subtree only",
		run: (check) => {
			const parsed = parseAtlasDefinitions(
				docsOf([
					[
						"assets/minecraft/atlases/blocks.json",
						{
							sources: [
								{ type: "directory", source: "block", prefix: "block" },
							],
						},
					],
				]),
			);
			check.equal(
				atlasCoverageFor(
					parsed,
					"blocks",
					"assets/minecraft/textures/block/stone.png",
				),
				"covered",
				"subtree texture is covered",
			);
			check.equal(
				atlasCoverageFor(
					parsed,
					"blocks",
					"assets/minecraft/textures/item/sword.png",
				),
				"not-covered",
				"outside texture is not covered",
			);
			check.deepEqual(parsed.unknownSourceTypes, [], "nothing skipped");
		},
	},
	{
		name: "single source covers exactly its resource",
		run: (check) => {
			const parsed = parseAtlasDefinitions(
				docsOf([
					[
						"assets/minecraft/atlases/items.json",
						{ sources: [{ type: "single", resource: "minecraft:item/sword" }] },
					],
				]),
			);
			check.equal(
				atlasCoverageFor(
					parsed,
					"items",
					"assets/minecraft/textures/item/sword.png",
				),
				"covered",
				"listed texture is covered",
			);
			check.equal(
				atlasCoverageFor(
					parsed,
					"items",
					"assets/minecraft/textures/item/shield.png",
				),
				"not-covered",
				"unlisted texture is not covered",
			);
		},
	},
	{
		name: "unknown source types are reported and never accuse",
		run: (check) => {
			const parsed = parseAtlasDefinitions(
				docsOf([
					[
						"assets/minecraft/atlases/blocks.json",
						{
							sources: [
								{ type: "directory", source: "block", prefix: "block" },
								{
									type: "paletted_permutations",
									textures: ["minecraft:item/x"],
								},
								{ type: "filter", pattern: { namespace: "minecraft" } },
							],
						},
					],
				]),
			);
			check.deepEqual(
				parsed.unknownSourceTypes,
				["filter", "paletted_permutations"],
				"skipped types are reported back, sorted",
			);
			// One skipped source poisons the whole atlas: membership is no
			// longer determinable, so every query answers unknown.
			check.equal(
				atlasCoverageFor(
					parsed,
					"blocks",
					"assets/minecraft/textures/block/stone.png",
				),
				"unknown",
				"partial knowledge never accuses",
			);
		},
	},
	{
		name: "missing atlas answers unknown, never not-covered",
		run: (check) => {
			const parsed = parseAtlasDefinitions(docsOf([]));
			check.equal(
				atlasCoverageFor(
					parsed,
					"blocks",
					"assets/minecraft/textures/block/stone.png",
				),
				"unknown",
				"undefined atlas skips",
			);
		},
	},
	{
		name: "unusable atlas documents skip without inventing members",
		run: (check) => {
			const parsed = parseAtlasDefinitions(
				docsOf([
					["assets/minecraft/atlases/blocks.json", { sources: "nope" }],
					["assets/minecraft/atlases/items.json", ["not", "an", "object"]],
					["assets/minecraft/atlases/nested/deep.json", { sources: [] }],
					["assets/minecraft/textures/block/stone.png", { sources: [] }],
				]),
			);
			check.equal(
				atlasCoverageFor(
					parsed,
					"blocks",
					"assets/minecraft/textures/block/stone.png",
				),
				"unknown",
				"non-array sources skip",
			);
			check.equal(
				atlasCoverageFor(
					parsed,
					"items",
					"assets/minecraft/textures/item/sword.png",
				),
				"unknown",
				"non-object document skips",
			);
			check.equal(
				atlasCoverageFor(
					parsed,
					"deep",
					"assets/minecraft/textures/block/stone.png",
				),
				"unknown",
				"nested atlas files are ignored",
			);
		},
	},
	{
		name: "required atlas follows the model kind through the policy",
		run: (check) => {
			const policy = { itemAtlas: "items", blockAtlas: "blocks" };
			check.equal(
				requiredAtlasForModel(
					"assets/minecraft/models/block/stone.json",
					policy,
				),
				"blocks",
				"block model takes the blocks value",
			);
			check.equal(
				requiredAtlasForModel(
					"assets/minecraft/models/item/sword.json",
					policy,
				),
				"items",
				"item model takes the items value",
			);
			check.equal(
				requiredAtlasForModel(
					"assets/minecraft/models/entity/pig.json",
					policy,
				),
				undefined,
				"other kinds have no required atlas",
			);
			check.equal(
				requiredAtlasForModel(
					"assets/minecraft/textures/block/stone.png",
					policy,
				),
				undefined,
				"non-models never qualify",
			);
		},
	},
];
