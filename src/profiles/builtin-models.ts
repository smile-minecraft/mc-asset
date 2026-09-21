/**
 * Builtin model registry for pack reference resolution. These five ids are
 * the only models the resolver accepts without a file on disk: the two
 * program-level models that terminate a parent chain, and the three stable
 * vanilla template models whose parent chain ends at builtin/generated
 * and which carry no textures section of their own (a referencing model
 * supplies layer0). Contents verified against the 1.21.4 vanilla assets
 * mirror:
 * https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/1.21.4/assets/minecraft/models/item/generated.json
 * ({"parent":"builtin/generated","gui_light":"front","display":{...}}),
 * with item/handheld.json parenting item/generated and
 * item/handheld_rod.json parenting item/handheld. The registry MUST NOT be
 * read as "every minecraft namespace reference exists": anything outside
 * these ids still resolves through the file layers or stays unresolved.
 */

/** Frozen builtin model ids in byte order. */
export const BUILTIN_MODEL_IDS: readonly string[] = [
	"minecraft:builtin/entity",
	"minecraft:builtin/generated",
	"minecraft:item/generated",
	"minecraft:item/handheld",
	"minecraft:item/handheld_rod",
];

const BUILTIN_MODEL_SET: ReadonlySet<string> = new Set(BUILTIN_MODEL_IDS);

/** Exact-id membership: folded or suffixed lookalikes never match. */
export function isBuiltinModel(resourceLocation: string): boolean {
	return BUILTIN_MODEL_SET.has(resourceLocation);
}
