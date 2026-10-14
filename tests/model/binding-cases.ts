import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McAssetError } from "../../src/core/errors.ts";
import {
	assertBindingOutputTarget,
	type BlockstateBindingSpec,
	buildBlockstate,
	buildItemDefinition,
	type ItemBindingSpec,
} from "../../src/model/binding.ts";
import { validateBlockstateStructure } from "../../src/model/blockstate-structure.ts";
import { parseJsonDocument } from "../../src/model/json-document.ts";
import { resolveModelRules } from "../../src/model/versions.ts";
import {
	assertError,
	type CaseCheck,
	type ModelCase,
} from "./json-document-cases.ts";

export const BINDING_CASES: ModelCase[] = [
	// ─── Item Definition Cases ──────────────────────────────────────────────
	{
		name: "item definition at 46.0 produces valid json with model reference",
		run: (check: CaseCheck) => {
			const rules = resolveModelRules("46.0");
			const spec: ItemBindingSpec = {
				itemId: "minecraft:custom_sword",
				modelId: "minecraft:item/custom_sword",
			};
			const result = buildItemDefinition(spec, rules);
			check.ok(result.text.length > 0, "output text should not be empty");
			const parsed = JSON.parse(result.text);
			check.deepEqual(
				parsed.model,
				{
					type: "minecraft:model",
					model: "minecraft:item/custom_sword",
				},
				"model block matches spec",
			);
			check.equal(
				parsed.hand_animation_on_swap,
				undefined,
				"unspecified optional fields omitted",
			);
		},
	},
	{
		name: "item definition at 46.0 includes hand_animation_on_swap when given",
		run: (check: CaseCheck) => {
			const rules = resolveModelRules("46.0");
			const spec: ItemBindingSpec = {
				itemId: "minecraft:custom_sword",
				modelId: "minecraft:item/custom_sword",
				handAnimationOnSwap: false,
			};
			const result = buildItemDefinition(spec, rules);
			const parsed = JSON.parse(result.text);
			check.equal(
				parsed.hand_animation_on_swap,
				false,
				"hand_animation_on_swap included",
			);
		},
	},
	{
		name: "item definition at 63.0 includes oversized_in_gui when given",
		run: (check: CaseCheck) => {
			const rules = resolveModelRules("63.0");
			const spec: ItemBindingSpec = {
				itemId: "minecraft:custom_shield",
				modelId: "minecraft:item/custom_shield",
				oversizedInGui: true,
			};
			const result = buildItemDefinition(spec, rules);
			const parsed = JSON.parse(result.text);
			check.equal(parsed.oversized_in_gui, true, "oversized_in_gui included");
		},
	},
	{
		name: "item definition rejects oversized_in_gui below 63.0",
		run: (check: CaseCheck) => {
			const rules = resolveModelRules("46.0");
			const spec: ItemBindingSpec = {
				itemId: "minecraft:custom_shield",
				modelId: "minecraft:item/custom_shield",
				oversizedInGui: true,
			};
			const err = assertError(check, () => buildItemDefinition(spec, rules), [
				"MODEL_UNSUPPORTED_VERSION",
			]);
			const details = (err as McAssetError).details as
				| Record<string, unknown>
				| undefined;
			check.equal(
				details?.feature,
				"oversizedInGui",
				"details names oversizedInGui",
			);
		},
	},
	{
		name: "item definition at 75.0 includes swap_animation_scale when given",
		run: (check: CaseCheck) => {
			const rules = resolveModelRules("75.0");
			const spec: ItemBindingSpec = {
				itemId: "minecraft:custom_bow",
				modelId: "minecraft:item/custom_bow",
				swapAnimationScale: 1.5,
			};
			const result = buildItemDefinition(spec, rules);
			const parsed = JSON.parse(result.text);
			check.equal(
				parsed.swap_animation_scale,
				1.5,
				"swap_animation_scale included",
			);
		},
	},
	{
		name: "item definition rejects swap_animation_scale below 75.0",
		run: (check: CaseCheck) => {
			const rules = resolveModelRules("63.0");
			const spec: ItemBindingSpec = {
				itemId: "minecraft:custom_bow",
				modelId: "minecraft:item/custom_bow",
				swapAnimationScale: 1.5,
			};
			const err = assertError(check, () => buildItemDefinition(spec, rules), [
				"MODEL_UNSUPPORTED_VERSION",
			]);
			const details = (err as McAssetError).details as
				| Record<string, unknown>
				| undefined;
			check.equal(
				details?.feature,
				"swapAnimationScale",
				"details names swapAnimationScale",
			);
		},
	},
	{
		name: "item definition rejected below 46.0 with unsupported version",
		run: (check: CaseCheck) => {
			const rules = resolveModelRules("45.0");
			const spec: ItemBindingSpec = {
				itemId: "minecraft:custom_item",
				modelId: "minecraft:item/custom_item",
			};
			const err = assertError(check, () => buildItemDefinition(spec, rules), [
				"MODEL_UNSUPPORTED_VERSION",
			]);
			const details = (err as McAssetError).details as
				| Record<string, unknown>
				| undefined;
			check.equal(
				details?.reason,
				"item-definitions-require-46.0",
				"details explains requirement",
			);
		},
	},
	{
		name: "item definition rejected when version is undetermined",
		run: (check: CaseCheck) => {
			const rules = resolveModelRules(undefined);
			const spec: ItemBindingSpec = {
				itemId: "minecraft:custom_item",
				modelId: "minecraft:item/custom_item",
			};
			const err = assertError(check, () => buildItemDefinition(spec, rules), [
				"MODEL_UNSUPPORTED_VERSION",
			]);
			const details = (err as McAssetError).details as
				| Record<string, unknown>
				| undefined;
			check.equal(
				details?.reason,
				"item-definitions-require-46.0",
				"details explains requirement",
			);
		},
	},

	// ─── Blockstate Binding Cases ───────────────────────────────────────────
	{
		name: "blockstate builds single variants definition",
		run: (check: CaseCheck) => {
			const rules = resolveModelRules("75.0");
			const spec: BlockstateBindingSpec = {
				blockId: "minecraft:stone",
				variants: {
					"": { model: "minecraft:block/stone" },
				},
			};
			const result = buildBlockstate(spec, rules);
			check.ok(result.text.length > 0, "output text should not be empty");
			const parsed = JSON.parse(result.text);
			check.deepEqual(
				parsed.variants,
				{
					"": { model: "minecraft:block/stone" },
				},
				"variants match",
			);
		},
	},
	{
		name: "blockstate sorts variants keys in byte order with empty string first",
		run: (check: CaseCheck) => {
			const rules = resolveModelRules("75.0");
			const spec: BlockstateBindingSpec = {
				blockId: "minecraft:door",
				variants: {
					"facing=south,half=upper": { model: "minecraft:block/door_s_u" },
					"": { model: "minecraft:block/door_default" },
					"facing=north,half=lower": { model: "minecraft:block/door_n_l" },
				},
			};
			const result = buildBlockstate(spec, rules);
			const parsed = JSON.parse(result.text);
			const keys = Object.keys(parsed.variants);
			check.deepEqual(
				keys,
				["", "facing=north,half=lower", "facing=south,half=upper"],
				"keys are byte-order sorted",
			);
		},
	},
	{
		name: "blockstate formats variants alternative array with weight",
		run: (check: CaseCheck) => {
			const rules = resolveModelRules("75.0");
			const spec: BlockstateBindingSpec = {
				blockId: "minecraft:stone",
				variants: {
					"": [
						{ model: "minecraft:block/stone", weight: 3 },
						{ model: "minecraft:block/stone_alt", weight: 1 },
					],
				},
			};
			const result = buildBlockstate(spec, rules);
			const parsed = JSON.parse(result.text);
			check.deepEqual(
				parsed.variants[""],
				[
					{ model: "minecraft:block/stone", weight: 3 },
					{ model: "minecraft:block/stone_alt", weight: 1 },
				],
				"alternative array preserves weight",
			);
		},
	},
	{
		name: "blockstate formats multipart single item and array apply",
		run: (check: CaseCheck) => {
			const rules = resolveModelRules("75.0");
			const spec: BlockstateBindingSpec = {
				blockId: "minecraft:fence",
				multipart: [
					{
						when: { north: true },
						apply: { model: "minecraft:block/fence_side" },
					},
					{
						apply: [{ model: "minecraft:block/fence_post" }],
					},
				],
			};
			const result = buildBlockstate(spec, rules);
			const parsed = JSON.parse(result.text);
			check.equal(parsed.multipart.length, 2, "multipart has 2 parts");
			check.equal(
				parsed.multipart[0].when.north,
				"true",
				"boolean condition rendered as string true",
			);
			check.deepEqual(
				parsed.multipart[0].apply,
				{ model: "minecraft:block/fence_side" },
				"single apply matches",
			);
			check.deepEqual(
				parsed.multipart[1].apply,
				[{ model: "minecraft:block/fence_post" }],
				"array apply matches",
			);
		},
	},
	{
		name: "blockstate allows z rotation at pack format 75.0",
		run: (check: CaseCheck) => {
			const rules = resolveModelRules("75.0");
			const spec: BlockstateBindingSpec = {
				blockId: "minecraft:pillar",
				variants: {
					"": { model: "minecraft:block/pillar", z: 90 },
				},
			};
			const result = buildBlockstate(spec, rules);
			const parsed = JSON.parse(result.text);
			check.equal(parsed.variants[""].z, 90, "z rotation preserved");
		},
	},
	{
		name: "blockstate rejects z rotation below pack format 75.0",
		run: (check: CaseCheck) => {
			const rules = resolveModelRules("63.0");
			const spec: BlockstateBindingSpec = {
				blockId: "minecraft:pillar",
				variants: {
					"": { model: "minecraft:block/pillar", z: 90 },
				},
			};
			const err = assertError(check, () => buildBlockstate(spec, rules), [
				"MODEL_UNSUPPORTED_VERSION",
			]);
			const details = (err as McAssetError).details as
				| Record<string, unknown>
				| undefined;
			check.equal(
				details?.feature,
				"blockstateZRotation",
				"details names blockstateZRotation",
			);
		},
	},
	{
		name: "blockstate rejects weight on single non-array entry",
		run: (check: CaseCheck) => {
			const rules = resolveModelRules("75.0");
			const spec: BlockstateBindingSpec = {
				blockId: "minecraft:stone",
				variants: {
					"": { model: "minecraft:block/stone", weight: 2 },
				},
			};
			assertError(check, () => buildBlockstate(spec, rules), [
				"MODEL_INVALID_STRUCTURE",
				"INVALID_ARGUMENT",
				"MODEL_INVALID_OPERATION",
			]);
		},
	},
	{
		name: "blockstate rejects both variants and multipart provided simultaneously",
		run: (check: CaseCheck) => {
			const rules = resolveModelRules("75.0");
			const spec: BlockstateBindingSpec = {
				blockId: "minecraft:stone",
				variants: { "": { model: "minecraft:block/stone" } },
				multipart: [{ apply: { model: "minecraft:block/stone" } }],
			};
			assertError(check, () => buildBlockstate(spec, rules), [
				"MODEL_INVALID_STRUCTURE",
				"INVALID_ARGUMENT",
				"MODEL_INVALID_OPERATION",
			]);
		},
	},
	{
		name: "blockstate rejects neither variants nor multipart provided",
		run: (check: CaseCheck) => {
			const rules = resolveModelRules("75.0");
			const spec: BlockstateBindingSpec = {
				blockId: "minecraft:stone",
			};
			assertError(check, () => buildBlockstate(spec, rules), [
				"MODEL_INVALID_STRUCTURE",
				"INVALID_ARGUMENT",
				"MODEL_INVALID_OPERATION",
			]);
		},
	},
	{
		name: "blockstate rejects illegal variant key format",
		run: (check: CaseCheck) => {
			const rules = resolveModelRules("75.0");
			const spec: BlockstateBindingSpec = {
				blockId: "minecraft:stone",
				variants: {
					"INVALID KEY!": { model: "minecraft:block/stone" },
				},
			};
			assertError(check, () => buildBlockstate(spec, rules), [
				"MODEL_INVALID_STRUCTURE",
				"INVALID_ARGUMENT",
			]);
		},
	},
	{
		name: "blockstate rejects exceeding maximum variant keys limit (256)",
		run: (check: CaseCheck) => {
			const rules = resolveModelRules("75.0");
			const variants: Record<string, { model: string }> = {};
			for (let i = 0; i < 257; i += 1) {
				variants[`state_${i}=val`] = { model: "minecraft:block/stone" };
			}
			const spec: BlockstateBindingSpec = {
				blockId: "minecraft:stone",
				variants,
			};
			assertError(check, () => buildBlockstate(spec, rules), [
				"RESOURCE_LIMIT_EXCEEDED",
			]);
		},
	},
	{
		name: "blockstate rejects exceeding maximum multipart items limit (64)",
		run: (check: CaseCheck) => {
			const rules = resolveModelRules("75.0");
			const multipart = Array.from({ length: 65 }, () => ({
				apply: { model: "minecraft:block/stone" },
			}));
			const spec: BlockstateBindingSpec = {
				blockId: "minecraft:stone",
				multipart,
			};
			assertError(check, () => buildBlockstate(spec, rules), [
				"RESOURCE_LIMIT_EXCEEDED",
			]);
		},
	},

	// ─── Blockstate Structure Validation Cases ──────────────────────────────
	{
		name: "validateBlockstateStructure passes for well-formed blockstate",
		run: (check: CaseCheck) => {
			const doc = parseJsonDocument(
				JSON.stringify({
					variants: {
						"": {
							model: "minecraft:block/stone",
							x: 90,
							y: 180,
							uvlock: true,
						},
					},
				}),
			);
			const rules = resolveModelRules("75.0");
			const result = validateBlockstateStructure(
				doc,
				rules,
				"assets/minecraft/blockstates/stone.json",
			);
			check.equal(result.findings.length, 0, "no error findings");
		},
	},
	{
		name: "validateBlockstateStructure reports MODEL_INVALID_ROTATION for non-90-step angle",
		run: (check: CaseCheck) => {
			const doc = parseJsonDocument(
				JSON.stringify({
					variants: {
						"": {
							model: "minecraft:block/stone",
							x: 45,
						},
					},
				}),
			);
			const rules = resolveModelRules("75.0");
			const result = validateBlockstateStructure(
				doc,
				rules,
				"assets/minecraft/blockstates/stone.json",
			);
			check.ok(
				result.findings.some((f) => f.code === "MODEL_INVALID_ROTATION"),
				"reports MODEL_INVALID_ROTATION for x=45",
			);
		},
	},
	{
		name: "validateBlockstateStructure reports finding for z rotation below 75.0",
		run: (check: CaseCheck) => {
			const doc = parseJsonDocument(
				JSON.stringify({
					variants: {
						"": {
							model: "minecraft:block/stone",
							z: 90,
						},
					},
				}),
			);
			const rules = resolveModelRules("63.0");
			const result = validateBlockstateStructure(
				doc,
				rules,
				"assets/minecraft/blockstates/stone.json",
			);
			check.ok(
				result.findings.some(
					(f) =>
						f.code === "MODEL_VERSION_FEATURE" ||
						f.code === "MODEL_INVALID_ROTATION",
				),
				"reports version feature finding for z rotation below 75.0",
			);
		},
	},
	{
		name: "validateBlockstateStructure reports MODEL_INVALID_STRUCTURE for weight on non-array",
		run: (check: CaseCheck) => {
			const doc = parseJsonDocument(
				JSON.stringify({
					variants: {
						"": {
							model: "minecraft:block/stone",
							weight: 5,
						},
					},
				}),
			);
			const rules = resolveModelRules("75.0");
			const result = validateBlockstateStructure(
				doc,
				rules,
				"assets/minecraft/blockstates/stone.json",
			);
			check.ok(
				result.findings.some((f) => f.code === "MODEL_INVALID_STRUCTURE"),
				"reports MODEL_INVALID_STRUCTURE for weight on single entry",
			);
		},
	},
	{
		name: "validateBlockstateStructure reports MODEL_INVALID_STRUCTURE for non-boolean uvlock",
		run: (check: CaseCheck) => {
			const doc = parseJsonDocument(
				JSON.stringify({
					variants: {
						"": {
							model: "minecraft:block/stone",
							uvlock: "true",
						},
					},
				}),
			);
			const rules = resolveModelRules("75.0");
			const result = validateBlockstateStructure(
				doc,
				rules,
				"assets/minecraft/blockstates/stone.json",
			);
			check.ok(
				result.findings.some((f) => f.code === "MODEL_INVALID_STRUCTURE"),
				"reports MODEL_INVALID_STRUCTURE for string uvlock",
			);
		},
	},

	// ─── Do Not Overwrite Cases ─────────────────────────────────────────────
	{
		name: "assertBindingOutputTarget throws OUTPUT_EXISTS when file exists even with force true",
		run: async (check: CaseCheck) => {
			const tmp = await mkdtemp(join(tmpdir(), "binding-test-"));
			try {
				const target = join(tmp, "sword.json");
				await writeFile(target, "initial content", "utf-8");
				assertError(
					check,
					() =>
						assertBindingOutputTarget(target, {
							kind: "item",
							id: "minecraft:sword",
							force: true,
						}),
					["OUTPUT_EXISTS"],
				);
				const contentAfter = await readFile(target, "utf-8");
				check.equal(
					contentAfter,
					"initial content",
					"existing file content untouched (zero bytes written)",
				);
			} finally {
				await rm(tmp, { recursive: true, force: true });
			}
		},
	},
	{
		name: "assertBindingOutputTarget validates packPath layout when packPath is given",
		run: (check: CaseCheck) => {
			const packPath = "/fake/pack";
			const outsideTarget = "/other/directory/sword.json";
			assertError(
				check,
				() =>
					assertBindingOutputTarget(outsideTarget, {
						packPath,
						kind: "item",
						id: "minecraft:sword",
					}),
				["INVALID_ARGUMENT"],
			);
		},
	},
];

for (const version of [undefined, "999.0"]) {
	BINDING_CASES.push({
		name: `unknown blockstate z version ${version}`,
		run: (check) => {
			const result = validateBlockstateStructure(
				parseJsonDocument(
					'{"variants":{"":{"model":"probe:block/example","z":90}}}',
				),
				resolveModelRules(version),
				"assets/probe/blockstates/example.json",
			);
			check.ok(
				!result.findings.some((f) => f.code === "MODEL_VERSION_FEATURE"),
				"unknown version does not reject z",
			);
			check.ok(
				result.skipped.some((s) => s.kind === "model-version-rules"),
				"unknown version coverage",
			);
		},
	});
}
for (const weight of [-2, 1.5]) {
	BINDING_CASES.push({
		name: `builder rejects invalid alternative weight ${weight}`,
		run: (check) => {
			const spec = {
				blockId: "probe:example",
				variants: { "": [{ model: "probe:block/example", weight }] },
			};
			const result = validateBlockstateStructure(
				parseJsonDocument(JSON.stringify(spec)),
				resolveModelRules("75.0"),
				"example.json",
			);
			check.ok(
				result.findings.some((f) => f.level === "error"),
				"checker rejects weight",
			);
			assertError(
				check,
				() => buildBlockstate(spec, resolveModelRules("75.0")),
				["MODEL_INVALID_STRUCTURE"],
			);
		},
	});
}
for (const [target, options] of [
	["/fake/pack/assets/../../escape.json", { packPath: "/fake/pack" }],
	[
		"/fake/pack/assets/probe/items/../../../../outside.json",
		{ packPath: "/fake/pack", kind: "item", id: "probe:../../../../outside" },
	],
	[
		"/fake/pack/assets/probe/textures/not_model.json",
		{ packPath: "/fake/pack" },
	],
	[
		"/fake/pack/assets/probe/models/item/../example.json",
		{ packPath: "/fake/pack" },
	],
	[
		"/fake/pack/assets/probe/items/example.json",
		{ packPath: "/fake/pack", kind: "item", id: "probe:../example" },
	],
] as const) {
	BINDING_CASES.push({
		name: `reject invalid binding target ${target} ${"id" in options ? options.id : ""}`,
		run: (check) => {
			assertError(check, () => assertBindingOutputTarget(target, options), [
				"INVALID_ARGUMENT",
			]);
		},
	});
}
BINDING_CASES.push({
	name: "accept valid nested model and binding targets",
	run: () => {
		assertBindingOutputTarget(
			"/fake/pack/assets/probe/models/item/example.json",
			{ packPath: "/fake/pack" },
		);
		assertBindingOutputTarget("/fake/pack/assets/probe/items/example.json", {
			packPath: "/fake/pack",
			kind: "item",
			id: "probe:example",
		});
		assertBindingOutputTarget(
			"/fake/pack/assets/probe/blockstates/example.json",
			{ packPath: "/fake/pack", kind: "blockstate", id: "probe:example" },
		);
	},
});

BINDING_CASES.push({
	name: "blockstate z at 45.0 remains a version error",
	run: (check) => {
		const result = validateBlockstateStructure(
			parseJsonDocument(
				'{"variants":{"":{"model":"probe:block/example","z":90}}}',
			),
			resolveModelRules("45.0"),
			"assets/probe/blockstates/example.json",
		);
		check.ok(
			result.findings.some(
				(f) => f.code === "MODEL_VERSION_FEATURE" && f.level === "error",
			),
			"known unsupported version rejected",
		);
	},
});
