import type { ModelElementView, ModelTextureResolution } from "../inspect.ts";
import type { Vec3 } from "../types.ts";

/**
 * The flat geometry the vanilla item model generator adds for a recipe-built
 * item model.
 *
 * A model like `{"parent": "minecraft:item/generated", "textures":
 * {"layer0": "mypack:item/ruby"}}` has no `elements` of its own: the client
 * generates them from the layer textures. For every present `layer0` ..
 * `layer4` in order it builds one element from (0, 0, 7.5) to (16, 16, 8.5)
 * with a south face and a north face, then the 1 px edge quads around the
 * opaque outline. The loop stops at the first missing layer, so a gap ends the
 * generated geometry.
 *
 * The vanilla shape and both face UVs are in the 26.2 client jar
 * (`javap -c -p net/minecraft/client/resources/model/cuboid/ItemModelGenerator`):
 * `bakeExtrudedSprite` constructs the box (0, 0, 7.5) .. (16, 16, 8.5), bakes
 * the SOUTH face with `SOUTH_FACE_UVS` and the NORTH face with
 * `NORTH_FACE_UVS` (`Quadrant.R0`), and the static initialiser defines those
 * constants as `UVs(0, 0, 16, 16)` and `UVs(16, 0, 0, 16)`. The client puts
 * every layer on the same box and lets draw order decide; this preview wraps
 * each layer around z = 8 instead (layer L spans `7.5 - L * step` ..
 * `8.5 + L * step`), so the near face is picked by the depth buffer from
 * either viewing direction and an opaque upper layer can never depend on draw
 * order. The north UV `[16, 0, 0, 16]` attaches texel u = 0 to the same
 * model-space x as the south face, so the north face is the sprite's mirrored
 * back, exactly like the vanilla quad.
 *
 * The 1.21.4 `item/generated.json` carries only `parent` / `gui_light` /
 * `display`, so the plane has to be generated. Without this module the
 * preview of a recipe-built item is a fully transparent image, because there
 * is no `elements` array to rasterise. The 1 px edge quads are listed in
 * `unapplied` instead.
 */

/** The texture variables the generator consumes, in layer order. */
export const ITEM_LAYER_NAMES = [
	"layer0",
	"layer1",
	"layer2",
	"layer3",
	"layer4",
] as const;

/** True for the texture variable names the generator turns into a plane. */
export function isItemLayerName(name: string): boolean {
	return (ITEM_LAYER_NAMES as readonly string[]).includes(name);
}

/** The box every layer is wrapped around, in model units (vanilla z range). */
export const ITEM_LAYER_PLANE = {
	from: [0, 0, 7.5] as Vec3,
	to: [16, 16, 8.5] as Vec3,
};

/**
 * The z step between two layers, in model units: 1/256 unit, the preview's
 * integer grid, which is 1/16 of a texel. Layer L grows symmetrically around
 * the vanilla plane: its south face sits at `8.5 + L * step` and its north
 * face at `7.5 - L * step`. From the front the upper south face is nearest;
 * after a 180 degree turn the upper north face is nearest, so the stack keeps
 * the same order from both sides instead of relying on draw order.
 */
export const ITEM_LAYER_Z_STEP = 1 / 256;

/** The part of an inspected texture entry a layer needs. */
export interface ItemLayerTexture {
	readonly name: string;
	readonly resolution: ModelTextureResolution;
}

/**
 * Build one double-sided box per layer texture, in layer order. The first
 * missing layer ends the run, matching the generator, so a model that only
 * declares `layer1` generates nothing. Both faces carry the same tint index
 * as the layer, and the upper layer's near face is in front on either side.
 */
export function itemLayerElements(
	textures: readonly ItemLayerTexture[],
): ModelElementView[] {
	const present = new Map<number, ItemLayerTexture>();
	for (const texture of textures) {
		const layer = ITEM_LAYER_NAMES.indexOf(
			texture.name as (typeof ITEM_LAYER_NAMES)[number],
		);
		if (layer < 0) continue;
		present.set(layer, texture);
	}
	const elements: ModelElementView[] = [];
	for (let layer = 0; layer < ITEM_LAYER_NAMES.length; layer += 1) {
		const texture = present.get(layer);
		if (texture === undefined) break;
		const z = layer * ITEM_LAYER_Z_STEP;
		elements.push({
			index: elements.length,
			from: [
				ITEM_LAYER_PLANE.from[0],
				ITEM_LAYER_PLANE.from[1],
				ITEM_LAYER_PLANE.from[2] - z,
			],
			to: [
				ITEM_LAYER_PLANE.to[0],
				ITEM_LAYER_PLANE.to[1],
				ITEM_LAYER_PLANE.to[2] + z,
			],
			size: [16, 16, 1 + 2 * z],
			faces: [
				{
					face: "south",
					texture: `#${texture.name}`,
					textureResolution: texture.resolution,
					uv: [0, 0, 16, 16],
					rotation: 0,
					tintindex: layer,
				},
				{
					face: "north",
					texture: `#${texture.name}`,
					textureResolution: texture.resolution,
					uv: [16, 0, 0, 16],
					rotation: 0,
					tintindex: layer,
				},
			],
		});
	}
	return elements;
}
