import type { EntityLayoutDocument, EntityPartDocument } from "./types.ts";

/** Builtin player skin layouts: 64x64, inner and outer layers. */
export type BuiltinEntityLayoutId = "player_wide" | "player_slim";

const PLAYER_TEXTURE = { width: 64, height: 64 } as const;

const LAYOUT_ALIASES: Readonly<Record<string, BuiltinEntityLayoutId>> = {
	steve: "player_wide",
	alex: "player_slim",
};

const BUILTIN_IDS: readonly BuiltinEntityLayoutId[] = [
	"player_wide",
	"player_slim",
];

function part(
	id: string,
	size: readonly [number, number, number],
	uv: readonly [number, number],
	layer: "base" | "overlay",
	origin: readonly [number, number, number],
	pivot: readonly [number, number, number],
	inflate?: number,
): EntityPartDocument {
	return {
		id,
		size,
		uv,
		layer,
		origin,
		pivot,
		...(inflate === undefined ? {} : { inflate }),
	};
}

/**
 * The vanilla player model's standing pose. Coordinates are model units with
 * +y up and the feet at y = 0; vanilla `ModelBiped` uses the same boxes with
 * +y down from the neck, so head 24..32, body 12..24, arms 12..24, and legs
 * 0..12 here.
 *
 * Verified against vanilla `ModelPlayer` / `ModelBiped`:
 *   head      box (-4,-8,-4) size 8x8x8 at pivot (0,0,0)
 *   body      box (-4, 0,-2) size 8x12x4 at pivot (0,0,0)
 *   arms      box (-3,-2,-2) / (4,12,4) at pivot (±5,2,0), width 4 or 3
 *   legs      box (-2, 0,-2) size 4x12x4 at pivot (±1.9,12,0)
 * The builtin keeps the already-published grid origins (legs at ±2 and ±4
 * rather than vanilla's ±1.9, which is not a multiple of 1/256), so the
 * inspect report does not change. The outer layer is the same box with the
 * vanilla dilation: the hat grows 0.5 on every side, the jacket, sleeves and
 * pants 0.25. The standing pose has no rotations; an omitted `rotation` means
 * none.
 *
 * Arm width is 4 for the wide (classic) model and 3 for the slim model;
 * everything else is shared. The 64x64 skin format gives the left arm and left
 * leg their own UV regions, so those parts are not mirrored: `ModelPlayer`
 * builds every left limb with a fresh `ModelRenderer` at its own offset,
 * unlike the shared-region biped mobs.
 */
function playerLayout(armWidth: 3 | 4): EntityLayoutDocument {
	const wide = armWidth === 4;
	const rightArmX = wide ? -8 : -7;
	return {
		format: "mc-asset/entity-layout",
		version: 1,
		id: wide ? "player_wide" : "player_slim",
		texture: { ...PLAYER_TEXTURE },
		parts: [
			part("head", [8, 8, 8], [0, 0], "base", [-4, 24, -4], [0, 24, 0]),
			part(
				"head_overlay",
				[8, 8, 8],
				[32, 0],
				"overlay",
				[-4, 24, -4],
				[0, 24, 0],
				0.5,
			),
			part("body", [8, 12, 4], [16, 16], "base", [-4, 12, -2], [0, 24, 0]),
			part(
				"body_overlay",
				[8, 12, 4],
				[16, 32],
				"overlay",
				[-4, 12, -2],
				[0, 24, 0],
				0.25,
			),
			part(
				"right_arm",
				[armWidth, 12, 4],
				[40, 16],
				"base",
				[rightArmX, 12, -2],
				[-5, 22, 0],
			),
			part(
				"right_arm_overlay",
				[armWidth, 12, 4],
				[40, 32],
				"overlay",
				[rightArmX, 12, -2],
				[-5, 22, 0],
				0.25,
			),
			part(
				"left_arm",
				[armWidth, 12, 4],
				[32, 48],
				"base",
				[4, 12, -2],
				[5, 22, 0],
			),
			part(
				"left_arm_overlay",
				[armWidth, 12, 4],
				[48, 48],
				"overlay",
				[4, 12, -2],
				[5, 22, 0],
				0.25,
			),
			part("right_leg", [4, 12, 4], [0, 16], "base", [-4, 0, -2], [-2, 12, 0]),
			part(
				"right_leg_overlay",
				[4, 12, 4],
				[0, 32],
				"overlay",
				[-4, 0, -2],
				[-2, 12, 0],
				0.25,
			),
			part("left_leg", [4, 12, 4], [16, 48], "base", [0, 0, -2], [2, 12, 0]),
			part(
				"left_leg_overlay",
				[4, 12, 4],
				[0, 48],
				"overlay",
				[0, 0, -2],
				[2, 12, 0],
				0.25,
			),
		],
	};
}

/** Canonical builtin ids, in stable order. */
export function listEntityLayoutIds(): BuiltinEntityLayoutId[] {
	return [...BUILTIN_IDS];
}

/** Resolve a canonical id or its alias (`steve`, `alex`). */
export function canonicalEntityLayoutId(
	value: string,
): BuiltinEntityLayoutId | undefined {
	if (value === "player_wide" || value === "player_slim") {
		return value;
	}
	return LAYOUT_ALIASES[value];
}

/** A fresh document, so callers can never mutate the builtin registry. */
export function getEntityLayoutDocument(id: string): EntityLayoutDocument {
	const canonical = canonicalEntityLayoutId(id);
	if (canonical === undefined) {
		throw new Error(`Unknown builtin entity layout: ${id}.`);
	}
	return playerLayout(canonical === "player_wide" ? 4 : 3);
}
