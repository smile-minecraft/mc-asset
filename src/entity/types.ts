/**
 * Entity texture layouts: Minecraft box UV unfolded across cube parts.
 *
 * A layout document is the input contract shared by the CLI, the MCP tool,
 * and a future Blockbench interchange. Sizes and UV origins are texture
 * pixels; origin, pivot, and rotation are model-space hints carried through
 * unchanged for the 3D preview and interchange work.
 */

/** A part belongs to the inner skin layer or the outer overlay layer. */
export type EntityLayer = "base" | "overlay";

/** Face names follow the model convention used by Minecraft and Blockbench. */
export type EntityFaceName =
	| "top"
	| "bottom"
	| "right"
	| "front"
	| "left"
	| "back";

export interface EntityTextureSize {
	readonly width: number;
	readonly height: number;
}

export interface EntityPartDocument {
	readonly id: string;
	/** Box size as [width, height, depth] in texture pixels. */
	readonly size: readonly [number, number, number];
	/** Box UV origin as [u, v] in texture pixels. */
	readonly uv: readonly [number, number];
	readonly mirror?: boolean | undefined;
	/** Defaults to "base". */
	readonly layer?: EntityLayer | undefined;
	/** Minimum model-space corner; carried for later 3D preview output. */
	readonly origin?: readonly [number, number, number] | undefined;
	/** Rotation pivot in model space; carried for later interchange. */
	readonly pivot?: readonly [number, number, number] | undefined;
	/** Euler rotation in degrees; carried for later interchange. */
	readonly rotation?: readonly [number, number, number] | undefined;
}

export interface EntityLayoutDocument {
	readonly format: "mc-asset/entity-layout";
	readonly version: 1;
	readonly id: string;
	readonly texture: EntityTextureSize;
	readonly parts: readonly EntityPartDocument[];
}

export interface EntityRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface EntityFace {
	readonly partId: string;
	readonly layer: EntityLayer;
	readonly face: EntityFaceName;
	/** Pixels this face occupies in the texture. */
	readonly rect: EntityRect;
	/**
	 * Oriented corners in texture pixels, in Blockbench `face.uv` order:
	 * [u1, v1, u2, v2]. A reversed axis means the texture is sampled
	 * right-to-left or bottom-to-top on that face.
	 */
	readonly uv: readonly [number, number, number, number];
	/** The part's mirror flag: right and left swap, and every face is flipped. */
	readonly mirror: boolean;
}

export interface EntityPart {
	readonly id: string;
	readonly layer: EntityLayer;
	readonly size: readonly [number, number, number];
	readonly uv: readonly [number, number];
	readonly mirror: boolean;
	readonly origin?: readonly [number, number, number] | undefined;
	readonly pivot?: readonly [number, number, number] | undefined;
	readonly rotation?: readonly [number, number, number] | undefined;
	readonly faces: readonly EntityFace[];
}

export interface EntityLayout {
	readonly id: string;
	readonly texture: EntityTextureSize;
	readonly parts: readonly EntityPart[];
	/** Every face in part order, then face-name order. */
	readonly faces: readonly EntityFace[];
	readonly mappedPixels: number;
	readonly totalPixels: number;
	readonly unmappedPixels: number;
}
