import { requiredAtlasesForUsage } from "../../src/validate/atlas.ts";
import {
	collectBlockstateModelRefs,
	collectItemModelRefs,
	computeModelReachability,
	diagnoseTextureVariableExternal,
	findParentCycles,
	type ModelDocView,
	modelRelForValue,
	resolveTextureVariable,
} from "../../src/validate/reference-graph.ts";

/** Runner-agnostic assertion surface shared by the bun and node entries. */
export interface ReferenceGraphCaseCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
}

export interface ReferenceGraphCase {
	name: string;
	run(check: ReferenceGraphCaseCheck): Promise<void> | void;
}

function views(
	entries: Array<{
		rel: string;
		textures?: Record<string, unknown>;
		parent?: unknown;
	}>,
): Map<string, ModelDocView> {
	const out = new Map<string, ModelDocView>();
	for (const entry of entries) {
		out.set(entry.rel, {
			textures: entry.textures ?? {},
			parent: entry.parent,
		});
	}
	return out;
}

export const REFERENCE_GRAPH_CASES: ReferenceGraphCase[] = [
	{
		name: "blockstates variants single and array entries keep field paths",
		run: (check) => {
			const { refs, broken } = collectBlockstateModelRefs({
				variants: {
					"axis=y": { model: "testpack:block/stone" },
					"axis=x": [{ model: "testpack:block/other" }],
				},
			});
			check.equal(broken.length, 0, "no broken entries");
			check.deepEqual(
				refs.map((r) => r.fieldPath).sort(),
				['variants["axis=x"][0].model', 'variants["axis=y"].model'],
				"variants field paths",
			);
			check.deepEqual(
				refs.map((r) => r.value).sort(),
				["testpack:block/other", "testpack:block/stone"],
				"variants targets",
			);
		},
	},
	{
		name: "blockstates multipart single and array apply keep field paths",
		run: (check) => {
			const { refs, broken } = collectBlockstateModelRefs({
				multipart: [
					{ apply: { model: "testpack:block/a" } },
					{
						apply: [
							{ model: "testpack:block/b" },
							{ model: "testpack:block/c" },
						],
					},
				],
			});
			check.equal(broken.length, 0, "no broken entries");
			check.deepEqual(
				refs.map((r) => r.fieldPath),
				[
					"multipart[0].apply.model",
					"multipart[1].apply[0].model",
					"multipart[1].apply[1].model",
				],
				"multipart field paths in order",
			);
		},
	},
	{
		name: "blockstates malformed shapes are broken, never silent",
		run: (check) => {
			const badVariants = collectBlockstateModelRefs({
				variants: { "axis=y": 123 },
			});
			check.equal(badVariants.refs.length, 0, "no refs from bad variants");
			check.equal(badVariants.broken.length, 1, "one broken entry");
			check.equal(
				badVariants.broken[0]?.fieldPath,
				'variants["axis=y"]',
				"broken field path",
			);
			const badMultipart = collectBlockstateModelRefs({
				multipart: [{ nope: true }],
			});
			check.equal(
				badMultipart.broken[0]?.fieldPath,
				"multipart[0].apply",
				"missing apply is broken",
			);
			const badRoot = collectBlockstateModelRefs([]);
			check.equal(badRoot.broken.length, 1, "non-object root is broken");
		},
	},
	{
		name: "items branches resolve with traceable field paths",
		run: (check) => {
			const { refs, skips } = collectItemModelRefs({
				type: "minecraft:composite",
				models: [
					{ type: "minecraft:model", model: "testpack:item/a" },
					{
						type: "minecraft:condition",
						on_true: { type: "minecraft:model", model: "testpack:item/b" },
						on_false: { type: "minecraft:empty" },
					},
					{
						type: "minecraft:select",
						cases: [
							{
								when: "gui",
								model: { type: "minecraft:model", model: "testpack:item/c" },
							},
						],
						fallback: { type: "minecraft:empty" },
					},
					{
						type: "minecraft:range_dispatch",
						entries: [
							{
								threshold: 0.5,
								model: { type: "minecraft:model", model: "testpack:item/d" },
							},
						],
						fallback: { type: "minecraft:model", model: "testpack:item/e" },
					},
				],
			});
			check.equal(skips.length, 0, "no skips for known nodes");
			check.deepEqual(
				refs.map((r) => r.fieldPath),
				[
					"model.models[0].model",
					"model.models[1].on_true.model",
					"model.models[2].cases[0].model.model",
					"model.models[3].entries[0].model.model",
					"model.models[3].fallback.model",
				],
				"item field paths in order",
			);
		},
	},
	{
		name: "items special contributes base plus one renderer skip",
		run: (check) => {
			const { refs, skips } = collectItemModelRefs({
				type: "minecraft:special",
				base: "testpack:item/gone",
				model: { type: "minecraft:chest" },
			});
			check.deepEqual(
				refs.map((r) => [r.fieldPath, r.value]),
				[["model.base", "testpack:item/gone"]],
				"special base is the only model edge",
			);
			check.equal(skips.length, 1, "one renderer skip");
			check.equal(skips[0]?.kind, "item-model-special", "special kind");
			check.equal(
				skips[0]?.reason,
				"renderer-fields-not-interpreted",
				"special reason",
			);
			check.equal(skips[0]?.fieldPath, "model", "special field path");
		},
	},
	{
		name: "items foreign namespaces and unknown types skip without semantics",
		run: (check) => {
			const foreign = collectItemModelRefs({
				type: "custom:my_renderer",
				model: "testpack:item/gone",
			});
			check.equal(foreign.refs.length, 0, "foreign type yields no refs");
			check.deepEqual(
				foreign.skips.map((s) => [s.kind, s.reason]),
				[["item-model-node", "unknown-node-type"]],
				"foreign type skip",
			);
			const future = collectItemModelRefs({
				type: "minecraft:future_type",
				model: "minecraft:item/gone",
			});
			check.equal(
				future.refs.length,
				0,
				"unknown minecraft type yields no refs",
			);
			check.equal(
				future.skips[0]?.reason,
				"unknown-node-type",
				"unknown type skip",
			);
			const sameNameForeignModel = collectItemModelRefs({
				type: "custom:model",
				model: "testpack:item/gone",
			});
			check.equal(
				sameNameForeignModel.refs.length,
				0,
				"same-name foreign model yields no refs",
			);
			check.equal(
				sameNameForeignModel.skips[0]?.reason,
				"unknown-node-type",
				"same-name foreign model skips",
			);
		},
	},
	{
		name: "items empty, bundle leaves, and tags never accuse",
		run: (check) => {
			const { refs, skips } = collectItemModelRefs({
				type: "minecraft:composite",
				models: [
					{ type: "minecraft:empty" },
					{ type: "minecraft:bundle/selected_item" },
					{ type: "bundle/selected_item" },
					{ type: "minecraft:model", model: "#minecraft:tag" },
				],
			});
			check.equal(refs.length, 0, "no refs from empty leaves and tags");
			check.equal(skips.length, 0, "no skips for known leaves");
		},
	},
	{
		name: "texture variable resolves through self then the parent chain",
		run: (check) => {
			const docs = views([
				{
					rel: "assets/testpack/models/item/child.json",
					textures: { layer0: "#base" },
					parent: "testpack:item/base",
				},
				{
					rel: "assets/testpack/models/item/base.json",
					textures: { base: "testpack:item/real" },
				},
			]);
			const hit = resolveTextureVariable(
				docs,
				"assets/testpack/models/item/child.json",
				"layer0",
			);
			// layer0 is defined locally as #base, so it indirections to base
			// in the same file first, then inherits the definition upward.
			check.equal(hit.status, "resolved", "variable resolves");
			if (hit.status === "resolved") {
				check.equal(hit.value, "testpack:item/real", "resolved value");
			}
			const direct = resolveTextureVariable(
				docs,
				"assets/testpack/models/item/base.json",
				"base",
			);
			check.equal(direct.status, "resolved", "self definition resolves");
		},
	},
	{
		name: "texture variable cycles and missing names report their chain",
		run: (check) => {
			const loop = views([
				{
					rel: "assets/testpack/models/item/loop.json",
					textures: { a: "#b", b: "#a" },
				},
			]);
			const cycle = resolveTextureVariable(
				loop,
				"assets/testpack/models/item/loop.json",
				"a",
			);
			check.equal(cycle.status, "cycle", "indirection cycle detected");
			check.ok(cycle.chain.length > 0, "cycle carries its chain");
			const missing = resolveTextureVariable(
				loop,
				"assets/testpack/models/item/loop.json",
				"gone",
			);
			check.equal(missing.status, "not-found", "undefined variable reported");
			const external = resolveTextureVariable(
				views([
					{
						rel: "assets/testpack/models/item/child.json",
						textures: { layer0: "#base" },
						parent: "testpack:item/absent",
					},
				]),
				"assets/testpack/models/item/child.json",
				"layer0",
			);
			check.equal(
				external.status,
				"external",
				"chain leaving known docs stays external",
			);
		},
	},
	{
		name: "long alias chains without a cycle resolve instead of reporting one",
		run: (check) => {
			const textures: Record<string, unknown> = {};
			for (let i = 0; i < 12; i += 1) {
				textures[`v${i}`] = `#v${i + 1}`;
			}
			textures.v12 = "testpack:item/real";
			const docs = views([
				{
					rel: "assets/testpack/models/item/chain.json",
					textures,
				},
			]);
			const hit = resolveTextureVariable(
				docs,
				"assets/testpack/models/item/chain.json",
				"v0",
			);
			check.equal(hit.status, "resolved", "twelve-link chain is not a cycle");
			if (hit.status === "resolved") {
				check.equal(hit.value, "testpack:item/real", "resolved value");
			}
		},
	},
	{
		name: "parent cycles list their closed chain",
		run: (check) => {
			const cycles = findParentCycles(
				new Map([
					["a", "b"],
					["b", "a"],
					["c", undefined],
				]),
			);
			check.equal(cycles.length, 1, "one cycle found");
			check.deepEqual(cycles[0], ["a", "b", "a"], "closed chain");
			const none = findParentCycles(
				new Map([
					["a", "b"],
					["b", undefined],
				]),
			);
			check.equal(none.length, 0, "plain chains have no cycles");
		},
	},
	{
		name: "reachability flows from entries up the parent chain",
		run: (check) => {
			const parentOf = new Map<string, string | undefined>([
				["child", "parent"],
				["parent", undefined],
				["lonely", undefined],
			]);
			const usage = computeModelReachability(parentOf, ["parent"], ["child"]);
			check.deepEqual(
				usage.get("child"),
				{ items: true, blockstates: false },
				"items entry marks its model",
			);
			check.deepEqual(
				usage.get("parent"),
				{ items: true, blockstates: true },
				"shared parent inherits both usages",
			);
			check.equal(usage.has("lonely"), false, "unreachable models stay out");
		},
	},
	{
		name: "atlas demand follows usage, never the models/ path",
		run: (check) => {
			const policy = { itemAtlas: "items", blockAtlas: "blocks" };
			check.deepEqual(
				requiredAtlasesForUsage({ items: true, blockstates: false }, policy),
				["items"],
				"items usage needs the items atlas",
			);
			check.deepEqual(
				requiredAtlasesForUsage({ items: false, blockstates: true }, policy),
				["blocks"],
				"blockstate usage needs the blocks atlas",
			);
			check.deepEqual(
				requiredAtlasesForUsage({ items: true, blockstates: true }, policy),
				["blocks", "items"],
				"dual usage needs both",
			);
			check.deepEqual(
				requiredAtlasesForUsage(undefined, policy),
				[],
				"unreachable models need nothing",
			);
		},
	},
	{
		name: "reference edges keep source, path, target, and status",
		run: (check) => {
			const rel = modelRelForValue("testpack:block/stone");
			check.equal(
				rel,
				"assets/testpack/models/block/stone.json",
				"model value maps onto its file",
			);
			const { refs } = collectBlockstateModelRefs({
				variants: { "": { model: "testpack:block/stone" } },
			});
			check.equal(refs[0]?.fieldPath, 'variants[""].model', "edge field path");
			check.equal(refs[0]?.value, "testpack:block/stone", "edge target RL");
		},
	},
	{
		name: "external texture variables blame the exit rel, not the vanilla tree",
		run: (check) => {
			const diagnosis = diagnoseTextureVariableExternal(
				"textures.layer0",
				"#base",
				"assets/testpack/models/item/child.json",
				"assets/testpack/models/item/absent.json",
			);
			check.equal(
				diagnosis.reason,
				"model-documents-not-loaded",
				"skip reason names the unloaded documents",
			);
			check.equal(
				diagnosis.target,
				"assets/testpack/models/item/absent.json",
				"skip target is the exit rel",
			);
			check.ok(
				diagnosis.message.includes("assets/testpack/models/item/absent.json"),
				"message names the exit rel",
			);
			check.ok(
				!diagnosis.message.includes("vanilla resource tree"),
				"message never blames the vanilla tree",
			);
		},
	},
];
