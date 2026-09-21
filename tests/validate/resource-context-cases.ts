import {
	BUILTIN_MODEL_IDS,
	isBuiltinModel,
} from "../../src/profiles/builtin-models.ts";
import {
	createResourceContext,
	findCaseVariant,
	type LayerIndex,
	layerIndexFromRels,
	resolveModelReference,
	resolveTextureReference,
} from "../../src/validate/resource-context.ts";

/** Runner-agnostic assertion surface shared by the bun and node entries. */
export interface ResourceContextCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
}

export interface ResourceContextCase {
	name: string;
	run(check: ResourceContextCheck): Promise<void>;
}

function indexOf(...rels: string[]): LayerIndex {
	return layerIndexFromRels(rels);
}

const CURRENT_MODEL = "assets/testpack/models/item/sword.json";
const CURRENT_TEXTURE = "assets/testpack/textures/item/sword.png";

export const RESOURCE_CONTEXT_CASES: ResourceContextCase[] = [
	{
		name: "builtin registry lists the five frozen models",
		run: async (check) => {
			check.deepEqual(
				[...BUILTIN_MODEL_IDS],
				[
					"minecraft:builtin/entity",
					"minecraft:builtin/generated",
					"minecraft:item/generated",
					"minecraft:item/handheld",
					"minecraft:item/handheld_rod",
				],
				"registry holds exactly the frozen ids in byte order",
			);
			for (const id of BUILTIN_MODEL_IDS) {
				check.ok(isBuiltinModel(id), `${id} is builtin`);
			}
			check.ok(
				!isBuiltinModel("minecraft:item/sword"),
				"ordinary vanilla model is not builtin",
			);
			check.ok(
				!isBuiltinModel("minecraft:builtin/generated.png"),
				"extension suffix is not a builtin id",
			);
		},
	},
	{
		name: "current layer wins over every outer layer",
		run: async (check) => {
			const context = createResourceContext(
				indexOf(CURRENT_MODEL),
				[indexOf(CURRENT_MODEL)],
				indexOf(CURRENT_MODEL),
			);
			const resolved = resolveModelReference(context, "testpack:item/sword");
			check.equal(resolved.status, "resolved", "current hit resolves");
			check.equal(resolved.kind, "model", "kind is model");
			check.equal(
				resolved.resourceLocation,
				"testpack:item/sword",
				"location echoed",
			);
			check.equal(resolved.source, "current", "current wins");
			check.equal(resolved.target, CURRENT_MODEL, "target is the rel path");
			check.equal(resolved.reason, undefined, "resolved carries no reason");
		},
	},
	{
		name: "dependency order decides: first provider wins",
		run: async (check) => {
			const rel = "assets/testpack/models/item/wand.json";
			const first = createResourceContext(indexOf(), [indexOf(rel), indexOf()]);
			check.equal(
				resolveModelReference(first, "testpack:item/wand").source,
				"dependency:0",
				"first dependency wins",
			);
			const second = createResourceContext(indexOf(), [
				indexOf(),
				indexOf(rel),
			]);
			check.equal(
				resolveModelReference(second, "testpack:item/wand").source,
				"dependency:1",
				"only provider wins when first lacks the file",
			);
		},
	},
	{
		name: "vanilla layer resolves below dependencies",
		run: async (check) => {
			const rel = "assets/minecraft/models/item/generated.json";
			const context = createResourceContext(indexOf(), [], indexOf(rel));
			const resolved = resolveModelReference(
				context,
				"minecraft:item/generated",
			);
			check.equal(resolved.status, "resolved", "vanilla hit resolves");
			check.equal(resolved.source, "vanilla", "source names the vanilla layer");
			check.equal(resolved.target, rel, "target is the vanilla rel path");
		},
	},
	{
		name: "builtin registry resolves without any file layer",
		run: async (check) => {
			const context = createResourceContext(indexOf(), [], undefined);
			for (const id of [
				"minecraft:builtin/generated",
				"minecraft:builtin/entity",
				"minecraft:item/generated",
				"minecraft:item/handheld",
				"minecraft:item/handheld_rod",
			]) {
				const resolved = resolveModelReference(context, id);
				check.equal(resolved.status, "resolved", `${id} resolves`);
				check.equal(resolved.source, "builtin", `${id} is builtin`);
				check.equal(resolved.target, id, "builtin target is the id itself");
			}
		},
	},
	{
		name: "minecraft reference without vanilla is unresolved, never missing",
		run: async (check) => {
			const context = createResourceContext(indexOf(), [], undefined);
			const model = resolveModelReference(context, "minecraft:item/sword");
			check.equal(model.status, "unresolved", "model is unresolved");
			check.equal(
				model.reason,
				"vanilla-not-provided",
				"unresolved carries the reason",
			);
			check.equal(model.source, undefined, "unresolved has no source");
			check.equal(model.target, undefined, "unresolved has no target");
			const texture = resolveTextureReference(context, "minecraft:item/sword");
			check.equal(texture.status, "unresolved", "texture is unresolved");
			check.equal(
				texture.reason,
				"vanilla-not-provided",
				"texture carries the same reason",
			);
			check.equal(texture.kind, "texture", "texture kind kept");
		},
	},
	{
		name: "minecraft reference with vanilla provided but absent is missing",
		run: async (check) => {
			const context = createResourceContext(
				indexOf(),
				[],
				indexOf("assets/minecraft/models/item/other.json"),
			);
			const model = resolveModelReference(context, "minecraft:item/gone");
			check.equal(model.status, "missing", "absent vanilla model is missing");
			check.equal(
				model.reason,
				"not-found",
				"missing carries a machine reason",
			);
			const texture = resolveTextureReference(context, "minecraft:item/gone");
			check.equal(
				texture.status,
				"missing",
				"absent vanilla texture is missing",
			);
		},
	},
	{
		name: "non-minecraft reference stays missing with or without vanilla",
		run: async (check) => {
			const without = createResourceContext(indexOf(), [], undefined);
			check.equal(
				resolveModelReference(without, "testpack:item/gone").status,
				"missing",
				"missing without vanilla",
			);
			const withVanilla = createResourceContext(
				indexOf(),
				[],
				indexOf("assets/minecraft/models/item/generated.json"),
			);
			check.equal(
				resolveModelReference(withVanilla, "testpack:item/gone").status,
				"missing",
				"missing with vanilla",
			);
			check.equal(
				resolveTextureReference(withVanilla, "testpack:item/gone").status,
				"missing",
				"texture missing with vanilla",
			);
		},
	},
	{
		name: "builtin ids never satisfy texture resolution",
		run: async (check) => {
			const context = createResourceContext(indexOf(), [], undefined);
			const resolved = resolveTextureReference(
				context,
				"minecraft:builtin/generated",
			);
			check.equal(resolved.status, "unresolved", "builtin hit is model-only");
			check.equal(resolved.source, undefined, "no builtin source for textures");
		},
	},
	{
		name: "case folding searches every layer in priority order",
		run: async (check) => {
			const folded = "assets/testpack/models/item/Sword.json";
			const current = createResourceContext(indexOf(folded), [], undefined);
			const inCurrent = findCaseVariant(
				current,
				"model",
				"testpack:item/sword",
			);
			check.equal(inCurrent?.source, "current", "current folded hit");
			check.equal(inCurrent?.target, folded, "folded target is the real rel");
			const outer = createResourceContext(
				indexOf(),
				[indexOf("assets/testpack/models/item/SWORD.json"), indexOf(folded)],
				undefined,
			);
			const inDeps = findCaseVariant(outer, "model", "testpack:item/sword");
			check.equal(inDeps?.source, "dependency:0", "first folded provider wins");
			check.equal(
				findCaseVariant(
					createResourceContext(indexOf(), [], undefined),
					"model",
					"testpack:item/sword",
				),
				undefined,
				"no folded hit anywhere answers undefined",
			);
		},
	},
	{
		name: "empty dependency list behaves like no dependencies",
		run: async (check) => {
			const context = createResourceContext(
				indexOf(CURRENT_MODEL),
				[],
				undefined,
			);
			const resolved = resolveModelReference(context, "testpack:item/sword");
			check.equal(resolved.source, "current", "current still wins");
			const missing = resolveModelReference(context, "minecraft:item/sword");
			check.equal(missing.status, "unresolved", "still unresolved");
		},
	},
	{
		name: "texture rel mapping appends png and honors explicit suffixes",
		run: async (check) => {
			const context = createResourceContext(
				indexOf(CURRENT_TEXTURE),
				[],
				undefined,
			);
			const resolved = resolveTextureReference(context, "testpack:item/sword");
			check.equal(resolved.status, "resolved", "bare path gains .png");
			check.equal(resolved.target, CURRENT_TEXTURE, "target is the png rel");
			check.equal(resolved.kind, "texture", "kind is texture");
			check.equal(
				resolved.resourceLocation,
				"testpack:item/sword",
				"location echoed verbatim",
			);
		},
	},
];
