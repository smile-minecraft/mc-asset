import {
	type AtlasLayerInput,
	atlasSpriteCoverageFor,
	parseAtlasLayers,
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

function layerOf(
	docs: Array<[string, unknown]>,
	files: string[],
): AtlasLayerInput {
	return { docs: docsOf(docs), files: new Set(files) };
}

function skipSummary(
	parsed: ReturnType<typeof parseAtlasLayers>,
): Array<{ kind: string; reason: string; target: string; atlas: string }> {
	return parsed.skips.map((skip) => ({
		kind: skip.kind,
		reason: skip.reason,
		target: skip.target,
		atlas: skip.atlas,
	}));
}

export const ATLAS_CASES: AtlasCase[] = [
	{
		name: "directory source covers its subtree only",
		run: (check) => {
			const parsed = parseAtlasLayers(
				[
					layerOf(
						[
							[
								"assets/minecraft/atlases/blocks.json",
								{
									sources: [
										{ type: "directory", source: "block", prefix: "block/" },
									],
								},
							],
						],
						[
							"assets/minecraft/textures/block/stone.png",
							"assets/minecraft/textures/item/sword.png",
						],
					),
				],
				{ packFormat: "75.0", hasVanilla: true },
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "blocks", "minecraft:block/stone"),
				"covered",
				"subtree texture is covered",
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "blocks", "minecraft:item/sword"),
				"not-covered",
				"outside texture is not covered",
			);
			check.deepEqual(skipSummary(parsed), [], "nothing skipped");
		},
	},
	{
		name: "single source covers exactly its resource",
		run: (check) => {
			const parsed = parseAtlasLayers(
				[
					layerOf(
						[
							[
								"assets/minecraft/atlases/items.json",
								{
									sources: [
										{ type: "single", resource: "minecraft:item/sword" },
									],
								},
							],
						],
						[],
					),
				],
				{ packFormat: "75.0", hasVanilla: true },
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "items", "minecraft:item/sword"),
				"covered",
				"listed texture is covered",
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "items", "minecraft:item/shield"),
				"not-covered",
				"unlisted texture is not covered",
			);
		},
	},
	{
		name: "unknown source types are reported and never accuse",
		run: (check) => {
			const parsed = parseAtlasLayers(
				[
					layerOf(
						[
							[
								"assets/minecraft/atlases/blocks.json",
								{
									sources: [
										{ type: "directory", source: "block", prefix: "block/" },
										{ type: "minecraft:filter", pattern: { path: "stone" } },
										{
											type: "paletted_permutations",
											textures: ["minecraft:item/x"],
											palette_key: "minecraft:palette/key",
											permutations: { emerald: "minecraft:palette/emerald" },
										},
									],
								},
							],
						],
						[
							"assets/minecraft/textures/block/stone.png",
							"assets/minecraft/textures/block/dirt.png",
							"assets/minecraft/textures/item/x.png",
							"assets/minecraft/textures/palette/key.png",
							"assets/minecraft/textures/palette/emerald.png",
						],
					),
				],
				{ packFormat: "75.0", hasVanilla: true },
			);
			check.deepEqual(
				parsed.unknownSourceTypes,
				[],
				"understood types are never reported",
			);
			check.deepEqual(skipSummary(parsed), [], "nothing skipped");
			// Filters and permutations execute like any other source: the
			// filtered sprite is confirmed absent while its sibling stays.
			check.equal(
				atlasSpriteCoverageFor(parsed, "blocks", "minecraft:block/stone"),
				"not-covered",
				"filtered sprite is confirmed absent",
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "blocks", "minecraft:block/dirt"),
				"covered",
				"unfiltered sprite stays covered",
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "items", "minecraft:item/x_emerald"),
				"unknown",
				"missing items definition stays unknown, never not-covered",
			);
		},
	},
	{
		name: "missing atlas answers unknown, never not-covered",
		run: (check) => {
			const parsed = parseAtlasLayers([], {
				packFormat: "75.0",
				hasVanilla: true,
			});
			check.equal(
				atlasSpriteCoverageFor(parsed, "blocks", "minecraft:block/stone"),
				"unknown",
				"undefined atlas skips",
			);
		},
	},
	{
		name: "unusable atlas documents skip without inventing members",
		run: (check) => {
			const parsed = parseAtlasLayers(
				[
					layerOf(
						[
							["assets/minecraft/atlases/blocks.json", { sources: "nope" }],
							["assets/minecraft/atlases/items.json", ["not", "an", "object"]],
							["assets/minecraft/atlases/nested/deep.json", { sources: [] }],
							["assets/minecraft/textures/block/stone.png", { sources: [] }],
						],
						[],
					),
				],
				{ packFormat: "75.0", hasVanilla: true },
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "blocks", "minecraft:block/stone"),
				"unknown",
				"non-array sources skip",
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "items", "minecraft:item/sword"),
				"unknown",
				"non-object document skips",
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "deep", "minecraft:block/stone"),
				"unknown",
				"nested atlas files are ignored",
			);
			check.deepEqual(
				skipSummary(parsed),
				[
					{
						kind: "atlas-source",
						reason: "invalid-source",
						target: "assets/minecraft/atlases/blocks.json",
						atlas: "blocks",
					},
					{
						kind: "atlas-source",
						reason: "invalid-source",
						target: "assets/minecraft/atlases/items.json",
						atlas: "items",
					},
				],
				"unusable documents are diagnosed skips",
			);
		},
	},
	{
		name: "directory maps sprites across namespaces with its prefix",
		run: (check) => {
			const parsed = parseAtlasLayers(
				[
					layerOf(
						[
							[
								"assets/minecraft/atlases/blocks.json",
								{
									sources: [
										{ type: "directory", source: "block", prefix: "block/" },
									],
								},
							],
						],
						[
							"assets/minecraft/textures/block/stone.png",
							"assets/minecraft/textures/block/deepslate/brick.png",
							"assets/minecraft/textures/block/stone.png.mcmeta",
							"assets/minecraft/textures/item/sword.png",
							"assets/testpack/textures/block/custom.png",
						],
					),
				],
				{ packFormat: "75.0", hasVanilla: true },
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "blocks", "minecraft:block/stone"),
				"covered",
				"subtree texture is covered",
			);
			check.equal(
				atlasSpriteCoverageFor(
					parsed,
					"blocks",
					"minecraft:block/deepslate/brick",
				),
				"covered",
				"nested subdirectory texture is covered",
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "blocks", "minecraft:item/sword"),
				"not-covered",
				"outside texture is not covered",
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "blocks", "testpack:block/custom"),
				"covered",
				"other namespaces are searched with the same prefix",
			);
			check.deepEqual(skipSummary(parsed), [], "nothing skipped");
		},
	},
	{
		name: "single maps its resource onto an optional renamed sprite",
		run: (check) => {
			const parsed = parseAtlasLayers(
				[
					layerOf(
						[
							[
								"assets/minecraft/atlases/items.json",
								{
									sources: [
										{
											type: "single",
											resource: "minecraft:item/sword",
											sprite: "minecraft:item/renamed",
										},
										{ type: "single", resource: "minecraft:item/shield" },
									],
								},
							],
						],
						[],
					),
				],
				{ packFormat: "75.0", hasVanilla: true },
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "items", "minecraft:item/renamed"),
				"covered",
				"renamed sprite is covered",
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "items", "minecraft:item/sword"),
				"not-covered",
				"resource without the rename is not the sprite",
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "items", "minecraft:item/shield"),
				"covered",
				"sprite defaults to the resource",
			);
			check.deepEqual(skipSummary(parsed), [], "nothing skipped");
		},
	},
	{
		name: "filter removes sprites by nested find patterns in order",
		run: (check) => {
			const docs: Array<[string, unknown]> = [
				[
					"assets/minecraft/atlases/blocks.json",
					{
						sources: [
							{ type: "directory", source: "block", prefix: "block/" },
							{ type: "filter", pattern: { path: "sto" } },
						],
					},
				],
			];
			const files = [
				"assets/minecraft/textures/block/stone.png",
				"assets/minecraft/textures/block/dirt.png",
				"assets/testpack/textures/block/stone.png",
			];
			const parsed = parseAtlasLayers([layerOf(docs, files)], {
				packFormat: "75.0",
				hasVanilla: true,
			});
			check.equal(
				atlasSpriteCoverageFor(parsed, "blocks", "minecraft:block/stone"),
				"not-covered",
				"substring pattern removes the sprite",
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "blocks", "minecraft:block/dirt"),
				"covered",
				"non-matching sprite stays",
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "blocks", "testpack:block/stone"),
				"not-covered",
				"path-only pattern spans namespaces",
			);
			const namespaced = parseAtlasLayers(
				[
					layerOf(
						[
							[
								"assets/minecraft/atlases/blocks.json",
								{
									sources: [
										{ type: "directory", source: "block", prefix: "block/" },
										{ type: "filter", pattern: { namespace: "testpack" } },
									],
								},
							],
						],
						files,
					),
				],
				{ packFormat: "75.0", hasVanilla: true },
			);
			check.equal(
				atlasSpriteCoverageFor(namespaced, "blocks", "testpack:block/stone"),
				"not-covered",
				"namespace-only pattern removes that namespace",
			);
			check.equal(
				atlasSpriteCoverageFor(namespaced, "blocks", "minecraft:block/stone"),
				"covered",
				"other namespaces stay",
			);
			const readded = parseAtlasLayers(
				[
					layerOf(
						[
							[
								"assets/minecraft/atlases/blocks.json",
								{
									sources: [
										{ type: "directory", source: "block", prefix: "block/" },
										{ type: "filter", pattern: { path: "stone" } },
										{ type: "directory", source: "block", prefix: "block/" },
									],
								},
							],
						],
						files,
					),
				],
				{ packFormat: "75.0", hasVanilla: true },
			);
			check.equal(
				atlasSpriteCoverageFor(readded, "blocks", "minecraft:block/stone"),
				"covered",
				"a later source re-adds the filtered sprite",
			);
			const matchAll = parseAtlasLayers(
				[
					layerOf(
						[
							[
								"assets/minecraft/atlases/blocks.json",
								{
									sources: [
										{ type: "directory", source: "block", prefix: "block/" },
										{ type: "filter", pattern: {} },
									],
								},
							],
						],
						files,
					),
				],
				{ packFormat: "75.0", hasVanilla: true },
			);
			check.equal(
				atlasSpriteCoverageFor(matchAll, "blocks", "minecraft:block/dirt"),
				"not-covered",
				"missing fields match everything",
			);
		},
	},
	{
		name: "paletted permutations generate sprites gated by version",
		run: (check) => {
			const docs: Array<[string, unknown]> = [
				[
					"assets/minecraft/atlases/items.json",
					{
						sources: [
							{
								type: "paletted_permutations",
								textures: ["minecraft:item/x"],
								palette_key: "minecraft:palette/key",
								permutations: { emerald: "minecraft:palette/emerald" },
							},
						],
					},
				],
			];
			const legacyFiles = [
				"assets/minecraft/textures/item/x.png",
				"assets/minecraft/textures/palette/key.png",
				"assets/minecraft/textures/palette/emerald.png",
			];
			const legacy = parseAtlasLayers([layerOf(docs, legacyFiles)], {
				packFormat: "75.0",
				hasVanilla: true,
			});
			check.equal(
				atlasSpriteCoverageFor(legacy, "items", "minecraft:item/x_emerald"),
				"covered",
				"generated id joins texture and key with the default separator",
			);
			check.deepEqual(skipSummary(legacy), [], "resolvable deps skip nothing");
			const renamed = parseAtlasLayers(
				[
					layerOf(
						[
							[
								"assets/minecraft/atlases/items.json",
								{
									sources: [
										{
											type: "paletted_permutations",
											textures: ["minecraft:item/x"],
											palette_key: "minecraft:palette/key",
											permutations: { emerald: "minecraft:palette/emerald" },
											separator: "-",
										},
									],
								},
							],
						],
						legacyFiles,
					),
				],
				{ packFormat: "75.0", hasVanilla: true },
			);
			check.equal(
				atlasSpriteCoverageFor(renamed, "items", "minecraft:item/x-emerald"),
				"covered",
				"separator applies once its version gate is active",
			);
			const gated = parseAtlasLayers(
				[
					layerOf(
						[
							[
								"assets/minecraft/atlases/items.json",
								{
									sources: [
										{
											type: "paletted_permutations",
											textures: ["minecraft:item/x"],
											palette_key: "minecraft:palette/key",
											permutations: { emerald: "minecraft:palette/emerald" },
											separator: "-",
										},
									],
								},
							],
						],
						legacyFiles,
					),
				],
				{ packFormat: "46.0", hasVanilla: true },
			);
			check.equal(
				atlasSpriteCoverageFor(gated, "items", "minecraft:item/x_emerald"),
				"covered",
				"separator is ignored below its gate",
			);
			check.equal(
				atlasSpriteCoverageFor(gated, "items", "minecraft:item/x-emerald"),
				"not-covered",
				"ignored separator generates nothing",
			);
			const movedFiles = [
				"assets/minecraft/textures/item/x.png",
				"assets/minecraft/textures/palettes/palette/key.png",
				"assets/minecraft/textures/palettes/palette/emerald.png",
			];
			const moved = parseAtlasLayers([layerOf(docs, movedFiles)], {
				packFormat: "97.1",
				hasVanilla: true,
			});
			check.equal(
				atlasSpriteCoverageFor(moved, "items", "minecraft:item/x_emerald"),
				"covered",
				"palette root moves at its version gate",
			);
			const stale = parseAtlasLayers([layerOf(docs, legacyFiles)], {
				packFormat: "97.1",
				hasVanilla: true,
			});
			check.equal(
				atlasSpriteCoverageFor(stale, "items", "minecraft:item/x_emerald"),
				"unknown",
				"old palette location is no longer resolved",
			);
			check.deepEqual(
				skipSummary(stale),
				[
					{
						kind: "atlas-source",
						reason: "missing-dependency",
						target: "assets/minecraft/atlases/items.json",
						atlas: "items",
					},
				],
				"missing palette is a diagnosed skip",
			);
		},
	},
	{
		name: "paletted permutations without a vanilla tree stay unknown",
		run: (check) => {
			const parsed = parseAtlasLayers(
				[
					layerOf(
						[
							[
								"assets/minecraft/atlases/items.json",
								{
									sources: [
										{
											type: "paletted_permutations",
											textures: ["minecraft:item/x"],
											palette_key: "minecraft:palette/key",
											permutations: { emerald: "minecraft:palette/emerald" },
										},
									],
								},
							],
						],
						[],
					),
				],
				{ packFormat: "75.0", hasVanilla: false },
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "items", "minecraft:item/x_emerald"),
				"unknown",
				"unconfirmable deps never accuse",
			);
			check.deepEqual(
				skipSummary(parsed),
				[
					{
						kind: "atlas-source",
						reason: "unresolved-dependency",
						target: "assets/minecraft/atlases/items.json",
						atlas: "items",
					},
				],
				"unresolved deps are a diagnosed skip",
			);
		},
	},
	{
		name: "unsupported sources never accuse and stay visible as skips",
		run: (check) => {
			const parsed = parseAtlasLayers(
				[
					layerOf(
						[
							[
								"assets/minecraft/atlases/blocks.json",
								{
									sources: [
										{ type: "directory", source: "block", prefix: "block/" },
										{ type: "unstitch", reason: "nope" },
										{ type: "future-type", anything: true },
									],
								},
							],
						],
						["assets/minecraft/textures/block/stone.png"],
					),
				],
				{ packFormat: "75.0", hasVanilla: true },
			);
			check.deepEqual(
				parsed.unknownSourceTypes,
				["future-type", "unstitch"],
				"skipped types are reported back, sorted",
			);
			check.deepEqual(
				skipSummary(parsed),
				[
					{
						kind: "atlas-source",
						reason: "unsupported-source-type",
						target: "assets/minecraft/atlases/blocks.json",
						atlas: "blocks",
					},
					{
						kind: "atlas-source",
						reason: "unsupported-source-type",
						target: "assets/minecraft/atlases/blocks.json",
						atlas: "blocks",
					},
				],
				"one skip per unsupported source",
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "blocks", "minecraft:block/stone"),
				"unknown",
				"partial knowledge never accuses",
			);
		},
	},
	{
		name: "unsupported regex filters are not applied and stay visible",
		run: (check) => {
			const files = ["assets/minecraft/textures/block/stone.png"];
			const parsed = parseAtlasLayers(
				[
					layerOf(
						[
							[
								"assets/minecraft/atlases/blocks.json",
								{
									sources: [
										{ type: "directory", source: "block", prefix: "block/" },
										{ type: "filter", pattern: { path: "(?>stone)" } },
										{ type: "filter", pattern: { path: "\\Qstone\\E" } },
										{ type: "filter", pattern: { path: "sto++" } },
										{ type: "filter", pattern: { namespace: "\\p{L}+" } },
										{ type: "filter", pattern: { path: "\\Astone" } },
										{ type: "filter", pattern: { path: "stone\\Z" } },
										{ type: "filter", pattern: { path: "stone\\z" } },
										{ type: "filter", pattern: { namespace: "\\Gminecraft" } },
									],
								},
							],
						],
						files,
					),
				],
				{ packFormat: "75.0", hasVanilla: true },
			);
			check.deepEqual(
				skipSummary(parsed),
				[
					{
						kind: "atlas-filter",
						reason: "unsupported-regex",
						target: "assets/minecraft/atlases/blocks.json",
						atlas: "blocks",
					},
					{
						kind: "atlas-filter",
						reason: "unsupported-regex",
						target: "assets/minecraft/atlases/blocks.json",
						atlas: "blocks",
					},
					{
						kind: "atlas-filter",
						reason: "unsupported-regex",
						target: "assets/minecraft/atlases/blocks.json",
						atlas: "blocks",
					},
					{
						kind: "atlas-filter",
						reason: "unsupported-regex",
						target: "assets/minecraft/atlases/blocks.json",
						atlas: "blocks",
					},
					{
						kind: "atlas-filter",
						reason: "unsupported-regex",
						target: "assets/minecraft/atlases/blocks.json",
						atlas: "blocks",
					},
					{
						kind: "atlas-filter",
						reason: "unsupported-regex",
						target: "assets/minecraft/atlases/blocks.json",
						atlas: "blocks",
					},
					{
						kind: "atlas-filter",
						reason: "unsupported-regex",
						target: "assets/minecraft/atlases/blocks.json",
						atlas: "blocks",
					},
					{
						kind: "atlas-filter",
						reason: "unsupported-regex",
						target: "assets/minecraft/atlases/blocks.json",
						atlas: "blocks",
					},
				],
				"every unsupported filter is a skip",
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "blocks", "minecraft:block/stone"),
				"unknown",
				"partial knowledge never accuses",
			);
			check.ok(
				parsed.atlases.get("blocks")?.sprites.has("minecraft:block/stone") ===
					true,
				"skipped filters remove nothing",
			);
		},
	},
	{
		name: "java-only escapes are not applied and stay visible",
		run: (check) => {
			const files = ["assets/minecraft/textures/block/stone.png"];
			const parsed = parseAtlasLayers(
				[
					layerOf(
						[
							[
								"assets/minecraft/atlases/blocks.json",
								{
									sources: [
										{ type: "directory", source: "block", prefix: "block/" },
										{ type: "filter", pattern: { path: "sto\\hne" } },
										{ type: "filter", pattern: { path: "sto\\Hne" } },
										{ type: "filter", pattern: { path: "\\R" } },
										{ type: "filter", pattern: { path: "\\V+" } },
										{ type: "filter", pattern: { path: "\\Xstone" } },
										{
											type: "filter",
											pattern: { path: "\\N{LATIN SMALL LETTER A}" },
										},
										{ type: "filter", pattern: { path: "st\\eone" } },
										{ type: "filter", pattern: { path: "ston\\e" } },
										{ type: "filter", pattern: { path: "ston\\ea" } },
									],
								},
							],
						],
						files,
					),
				],
				{ packFormat: "75.0", hasVanilla: true },
			);
			check.equal(parsed.skips.length, 9, "every java-only escape is a skip");
			for (const skip of parsed.skips) {
				check.equal(skip.kind, "atlas-filter", "skip kind");
				check.equal(skip.reason, "unsupported-regex", "skip reason");
				check.equal(
					skip.target,
					"assets/minecraft/atlases/blocks.json",
					"skip target",
				);
			}
			check.equal(
				atlasSpriteCoverageFor(parsed, "blocks", "minecraft:block/stone"),
				"unknown",
				"partial knowledge never accuses",
			);
			check.ok(
				parsed.atlases.get("blocks")?.sprites.has("minecraft:block/stone") ===
					true,
				"skipped filters remove nothing",
			);
		},
	},
	{
		name: "legal javascript escapes still run as filters",
		run: (check) => {
			const parsed = parseAtlasLayers(
				[
					layerOf(
						[
							[
								"assets/minecraft/atlases/blocks.json",
								{
									sources: [
										{ type: "directory", source: "block", prefix: "block/" },
										{ type: "filter", pattern: { path: "dirt\\d" } },
										{ type: "filter", pattern: { path: "sto\\x6ee" } },
										{ type: "filter", pattern: { path: "a\\sb" } },
										{ type: "filter", pattern: { path: "ston\\u0065" } },
										{ type: "filter", pattern: { path: "\\bstone\\b" } },
									],
								},
							],
						],
						[
							"assets/minecraft/textures/block/stone.png",
							"assets/minecraft/textures/block/dirt1.png",
						],
					),
				],
				{ packFormat: "75.0", hasVanilla: true },
			);
			check.deepEqual(skipSummary(parsed), [], "legal escapes need no skip");
			check.equal(
				atlasSpriteCoverageFor(parsed, "blocks", "minecraft:block/stone"),
				"not-covered",
				"the hex and boundary filters still remove stone",
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "blocks", "minecraft:block/dirt1"),
				"not-covered",
				"the digit filter still removes dirt1",
			);
		},
	},
	{
		name: "escaped backslash before h is legal and needs no skip",
		run: (check) => {
			const parsed = parseAtlasLayers(
				[
					layerOf(
						[
							[
								"assets/minecraft/atlases/blocks.json",
								{
									sources: [
										{ type: "directory", source: "block", prefix: "block/" },
										{ type: "filter", pattern: { path: "\\\\h" } },
									],
								},
							],
						],
						["assets/minecraft/textures/block/stone.png"],
					),
				],
				{ packFormat: "75.0", hasVanilla: true },
			);
			check.deepEqual(
				skipSummary(parsed),
				[],
				"escaped backslash never trips the detector",
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "blocks", "minecraft:block/stone"),
				"covered",
				"the applied filter matches no sprite and the sprite stays",
			);
		},
	},
	{
		name: "layers merge in load order with later sources winning",
		run: (check) => {
			const parsed = parseAtlasLayers(
				[
					layerOf(
						[
							[
								"assets/minecraft/atlases/blocks.json",
								{
									sources: [
										{ type: "directory", source: "block", prefix: "block/" },
										{ type: "filter", pattern: { path: "stone" } },
									],
								},
							],
						],
						[
							"assets/minecraft/textures/block/stone.png",
							"assets/minecraft/textures/block/dirt.png",
						],
					),
					layerOf(
						[
							[
								"assets/minecraft/atlases/blocks.json",
								{
									sources: [
										{ type: "directory", source: "block", prefix: "block/" },
									],
								},
							],
						],
						["assets/minecraft/textures/block/stone.png"],
					),
				],
				{ packFormat: "75.0", hasVanilla: true },
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "blocks", "minecraft:block/stone"),
				"covered",
				"higher layer re-adds the filtered sprite",
			);
			check.equal(
				atlasSpriteCoverageFor(parsed, "blocks", "minecraft:block/dirt"),
				"covered",
				"lower layer sprites survive",
			);
			check.equal(
				parsed.atlases.get("blocks")?.sprites.get("minecraft:block/stone")
					?.entity,
				"assets/minecraft/textures/block/stone.png",
				"entity names the winning file",
			);
			const filtered = parseAtlasLayers(
				[
					layerOf(
						[
							[
								"assets/minecraft/atlases/blocks.json",
								{
									sources: [
										{ type: "directory", source: "block", prefix: "block/" },
									],
								},
							],
						],
						["assets/minecraft/textures/block/dirt.png"],
					),
					layerOf(
						[
							[
								"assets/minecraft/atlases/blocks.json",
								{
									sources: [{ type: "filter", pattern: { path: "dirt" } }],
								},
							],
						],
						[],
					),
				],
				{ packFormat: "75.0", hasVanilla: true },
			);
			check.equal(
				atlasSpriteCoverageFor(filtered, "blocks", "minecraft:block/dirt"),
				"not-covered",
				"higher layer filter removes lower layer sprites",
			);
			check.deepEqual(skipSummary(filtered), [], "filters need no skip");
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
