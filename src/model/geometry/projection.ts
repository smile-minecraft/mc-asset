import { divRound, FIXED_UNIT } from "./fixed.ts";
import type { FixedVec3, Mat3 } from "./matrix.ts";
import { applyMat3 } from "./matrix.ts";
import { sixteenthTurnMatrix } from "./rotation.ts";

export interface ProjectedPoint {
	/** Screen x in 1/256 model units; positive goes to the right. */
	readonly x: number;
	/** Screen y in 1/256 model units; positive goes downward. */
	readonly y: number;
	/**
	 * Depth for the z-buffer; larger values are nearer the camera. Orthographic
	 * views report the camera distance axis (-z for the front view, +x for the
	 * right view, +y for the top view) and isometric views report x + y + z,
	 * both in 1/256 model units. Pass it unchanged to the rasteriser so all
	 * faces of one scene are comparable.
	 */
	readonly depth: number;
}

export type OrthographicView = "front" | "right" | "top";

/**
 * Project onto one of the three orthographic views used by the model preview,
 * following the same screen rules as the existing panels: the front view
 * mirrors x and y, the right view mirrors z and y, and the top view shows x
 * and z directly. Shading and faceness are the caller's responsibility; only
 * the xy position and the depth axis are computed.
 */
export function projectOrthographic(
	view: OrthographicView,
	v: FixedVec3,
): ProjectedPoint {
	const [x, y, z] = v;
	if (view === "front") {
		return { x: -x, y: -y, depth: -z };
	}
	if (view === "right") {
		return { x: -z, y: -y, depth: x };
	}
	return { x, y: z, depth: y };
}

/**
 * The four positions the isometric camera can sit in. Each named direction
 * applies one quarter turn about the y axis before the base projection, so a
 * named direction and its standalone yaw matrix compose to the same result.
 * The camera always sits above the world, so every direction shows the top
 * face plus the two adjacent side faces.
 */
export const ISOMETRIC_DIRECTIONS = [
	"south-east",
	"south-west",
	"north-west",
	"north-east",
] as const;

export type IsometricDirection = (typeof ISOMETRIC_DIRECTIONS)[number];

const VIEW_YAW_STEPS: Record<IsometricDirection, number> = {
	"south-east": 0,
	"south-west": 4,
	"north-west": 8,
	"north-east": 12,
};

/** The quarter turn that aims the isometric camera at a named direction. */
export function isometricYawMatrix(direction: IsometricDirection): Mat3 {
	return sixteenthTurnMatrix("y", VIEW_YAW_STEPS[direction]);
}

/**
 * Project with the 2:1 isometric projection used by pixel-art view models.
 *
 * A model unit along x or z appears twice as wide as it is tall, matching the
 * 2:1 slope the in-game isometric camera uses. The three visible faces of a
 * unit cube cover exactly the same area, each two-by-one in width-to-height
 * ratio. The depth is x + y + z in 1/256 model units; larger values are
 * nearer the camera, which sits in the positive-octant corner.
 */
export function projectIsometric(
	v: FixedVec3,
	direction: IsometricDirection = "south-east",
): ProjectedPoint {
	const [x, y, z] = applyMat3(isometricYawMatrix(direction), v);
	return { x: 2 * (x - z), y: x + z - 2 * y, depth: x + y + z };
}

/**
 * Turn a projected point into rasteriser input.
 *
 * `scale` is how many subpixels one model unit occupies (1 subpixel = 1/16 px).
 * The x and y positions round to the nearest subpixel and the depth passes
 * through unchanged so every face of a scene stays comparable.
 */
export interface Viewport {
	readonly scale: number;
	readonly offsetX: number;
	readonly offsetY: number;
}

export function toSubpixel(
	p: ProjectedPoint,
	viewport: Viewport,
): { readonly x: number; readonly y: number; readonly z: number } {
	return {
		x: viewport.offsetX + divRound(p.x * viewport.scale, FIXED_UNIT),
		y: viewport.offsetY + divRound(p.y * viewport.scale, FIXED_UNIT),
		z: p.depth,
	};
}
