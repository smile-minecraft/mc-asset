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
 * whose south face carries the whole 0..16 texture rectangle with the layer's
 * ordinal as its tint index, then the 1 px edge quads around the opaque
 * outline. The loop stops at the first missing layer, so a gap ends the
 * generated geometry. The shape is the vanilla `ItemModelGenerator` path; the
 * modern port in StationAPI reproduces it (`LAYERS`, `create`,
 * `addLayerElements`:
 * https://github.com/ModificationStation/StationAPI/blob/489703cd99e8623400a3907e79b56b1b5e272aca/station-renderer-api-v0/src/main/java/net/modificationstation/stationapi/api/client/render/model/ItemModelGenerator.java),
 * and the 1.21.4 `item/generated.json` carries only `parent` / `gui_light` /
 * `display`, so the plane has to be generated. Without this module the
 * preview of a recipe-built item is a fully transparent image, because there
 * is no `elements` array to rasterise.
 *
 * This preview draws the front plane only: that is the face the GUI item
 * camera sees, it is what makes a `display` rotation visible, and a single
 * plane is what the report's `coverage` can honestly call complete. The 1 px
 * edge quads are listed in `unapplied` instead.
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

/** The plane every layer is drawn on, in model units. */
export const ITEM_LAYER_PLANE = {
	from: [0, 0, 7.5] as Vec3,
	to: [16, 16, 8.5] as Vec3,
};

/**
 * The z step between two layers, in model units: 1/256 unit, the preview's
 * integer grid, which is 1/16 of a texel. The client puts every layer on the
 * same plane and lets draw order decide; the preview gives each layer its own
 * depth so a translucent upper layer can never depend on draw order.
 */
export const ITEM_LAYER_Z_STEP = 1 / 256;

/** The part of an inspected texture entry a layer needs. */
export interface ItemLayerTexture {
	readonly name: string;
	readonly resolution: ModelTextureResolution;
}

/**
 * Build one plane element per layer texture, in layer order. The first
 * missing layer ends the run, matching the generator, so a model that only
 * declares `layer1` generates nothing. The last element is the nearest to the
 * camera, so an opaque upper layer covers the one below it.
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
				ITEM_LAYER_PLANE.from[2] + z,
			],
			to: [
				ITEM_LAYER_PLANE.to[0],
				ITEM_LAYER_PLANE.to[1],
				ITEM_LAYER_PLANE.to[2] + z,
			],
			size: [16, 16, 1],
			faces: [
				{
					face: "south",
					texture: `#${texture.name}`,
					textureResolution: texture.resolution,
					uv: [0, 0, 16, 16],
					rotation: 0,
					tintindex: layer,
				},
			],
		});
	}
	return elements;
}
