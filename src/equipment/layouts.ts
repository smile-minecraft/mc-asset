import type {
	EntityLayoutDocument,
	EntityPartDocument,
} from "../entity/types.ts";

/**
 * Vanilla equipment facts and the box-UV layouts of their textures.
 *
 * Every fact here was read from the vanilla client jars: the layer-type names
 * come from the `equipment` definition documents each jar ships, and the
 * texture coordinates from `HumanoidModel` and `ElytraModel`. The module
 * comment in `index.ts` records the versions and the cross-check against the
 * vanilla textures.
 */

/** One equipment layer type and the first pack format that ships it. */
export interface EquipmentLayerTypeFact {
	readonly type: string;
	/** First resource-pack format whose vanilla jar has this layer type. */
	readonly since: string;
}

/**
 * The layer type enum grows over releases. Each `since` is the first jar the
 * type was actually observed in, so an unverified middle version never
 * receives a type its client would refuse to parse.
 */
export const EQUIPMENT_LAYER_TYPES: readonly EquipmentLayerTypeFact[] = [
	{ type: "camel_husk_saddle", since: "75.0" },
	{ type: "camel_saddle", since: "55.0" },
	{ type: "donkey_saddle", since: "55.0" },
	{ type: "happy_ghast_body", since: "63.0" },
	{ type: "horse_body", since: "42.0" },
	{ type: "horse_saddle", since: "55.0" },
	{ type: "humanoid", since: "42.0" },
	{ type: "humanoid_baby", since: "84.0" },
	{ type: "humanoid_leggings", since: "42.0" },
	{ type: "llama_body", since: "42.0" },
	{ type: "mule_saddle", since: "55.0" },
	{ type: "nautilus_body", since: "75.0" },
	{ type: "nautilus_saddle", since: "75.0" },
	{ type: "pig_saddle", since: "55.0" },
	{ type: "skeleton_horse_saddle", since: "55.0" },
	{ type: "strider_saddle", since: "55.0" },
	{ type: "wings", since: "42.0" },
	{ type: "wolf_body", since: "42.0" },
	{ type: "zombie_horse_saddle", since: "55.0" },
];

/** The layer types whose texture layout is known, in byte order. */
export const EQUIPMENT_TEMPLATE_LAYER_TYPES: readonly string[] = [
	"humanoid",
	"humanoid_leggings",
	"wings",
];

/** Every armor and elytra sheet is 64x32, from format 42.0 through 97.1. */
export const EQUIPMENT_TEXTURE_SIZE = { width: 64, height: 32 } as const;

/**
 * `HumanoidModel.createMesh` places the head at (0,0), the helmet overlay at
 * (32,0), the body at (16,16), both arms at (40,16), and both legs at (0,16).
 * A left limb samples its right counterpart's cells mirrored, so one region
 * serves both. Origins and pivots are the player skeleton positions, so a
 * later preview can stand the armor on the same model as a player skin.
 */
const HUMANOID_PARTS: readonly EntityPartDocument[] = [
	{
		id: "head",
		size: [8, 8, 8],
		uv: [0, 0],
		origin: [-4, 24, -4],
		pivot: [0, 24, 0],
	},
	{
		id: "hat",
		size: [8, 8, 8],
		uv: [32, 0],
		layer: "overlay",
		origin: [-4, 24, -4],
		pivot: [0, 24, 0],
	},
	{
		id: "body",
		size: [8, 12, 4],
		uv: [16, 16],
		origin: [-4, 12, -2],
		pivot: [0, 24, 0],
	},
	{
		id: "right_arm",
		size: [4, 12, 4],
		uv: [40, 16],
		origin: [-8, 12, -2],
		pivot: [-5, 22, 0],
	},
	{
		id: "right_leg",
		size: [4, 12, 4],
		uv: [0, 16],
		origin: [-4, 0, -2],
		pivot: [-2, 12, 0],
	},
];

/**
 * The leggings mesh keeps only the body and the legs, which is exactly the
 * area vanilla leggings textures paint; the head and arm cells of the same
 * 64x32 sheet are never sampled by that layer.
 */
const LEGGINGS_PARTS: readonly EntityPartDocument[] = HUMANOID_PARTS.filter(
	(part) => part.id === "body" || part.id === "right_leg",
);

/**
 * `ElytraModel.createLayer` gives both wings texOffs(22,0) with a 10x20x2 box
 * and mirrors the right wing, so one texture region carries both. No origin
 * or pivot is claimed: the model mounts the wings on the body with a rotation
 * this texture does not describe.
 */
const WINGS_PARTS: readonly EntityPartDocument[] = [
	{ id: "wing", size: [10, 20, 2], uv: [22, 0] },
];

function layoutDocument(
	id: string,
	parts: readonly EntityPartDocument[],
): EntityLayoutDocument {
	return {
		format: "mc-asset/entity-layout",
		version: 1,
		id,
		texture: { ...EQUIPMENT_TEXTURE_SIZE },
		parts: parts.map((part) => ({
			...part,
			size: [...part.size] as [number, number, number],
			uv: [...part.uv] as [number, number],
		})),
	};
}

const LAYOUTS: Readonly<Record<string, () => EntityLayoutDocument>> = {
	humanoid: () => layoutDocument("equipment_humanoid", HUMANOID_PARTS),
	humanoid_leggings: () =>
		layoutDocument("equipment_humanoid_leggings", LEGGINGS_PARTS),
	wings: () => layoutDocument("equipment_wings", WINGS_PARTS),
};

/** A fresh layout document for a template-capable layer type. */
export function getEquipmentLayout(
	layerType: string,
): EntityLayoutDocument | undefined {
	return LAYOUTS[layerType]?.();
}
