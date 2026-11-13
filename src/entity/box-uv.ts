import type {
	EntityFace,
	EntityFaceName,
	EntityLayer,
	EntityRect,
} from "./types.ts";

/**
 * Minecraft box UV unfolding. The footprint is 2 * (width + depth) wide and
 * depth + height tall:
 *
 *   +---------+-----------+
 *   |  top    |  bottom   |
 *   +---------+-----------+-------+-------+
 *   |  right  |  front    | left  | back  |
 *   +---------+-----------+-------+-------+
 *
 * The oriented UV corners match Blockbench's `face.uv`; `top` samples in
 * reverse on both axes and `bottom` on U because of how the box faces map
 * onto the sheet.
 *
 * With `mirror`, every face flips horizontally inside its own cell and the
 * right and left cells swap. Biped mobs that paint both limbs from one UV
 * region use it; the 64x64 player skin does not, because its left limbs have
 * dedicated regions.
 */
export const ENTITY_FACE_NAMES: readonly EntityFaceName[] = [
	"top",
	"bottom",
	"right",
	"front",
	"left",
	"back",
];

interface FaceFrame {
	rect: EntityRect;
	u1: number;
	v1: number;
	u2: number;
	v2: number;
}

function boxUvFrame(
	size: readonly [number, number, number],
): Record<EntityFaceName, FaceFrame> {
	const [width, height, depth] = size;
	return {
		top: {
			rect: { x: depth, y: 0, width, height: depth },
			u1: depth + width,
			v1: depth,
			u2: depth,
			v2: 0,
		},
		bottom: {
			rect: { x: width + depth, y: 0, width, height: depth },
			u1: 2 * width + depth,
			v1: 0,
			u2: width + depth,
			v2: depth,
		},
		right: {
			rect: { x: 0, y: depth, width: depth, height },
			u1: 0,
			v1: depth,
			u2: depth,
			v2: depth + height,
		},
		front: {
			rect: { x: depth, y: depth, width, height },
			u1: depth,
			v1: depth,
			u2: depth + width,
			v2: depth + height,
		},
		left: {
			rect: { x: width + depth, y: depth, width: depth, height },
			u1: width + depth,
			v1: depth,
			u2: width + 2 * depth,
			v2: depth + height,
		},
		back: {
			rect: { x: width + 2 * depth, y: depth, width, height },
			u1: width + 2 * depth,
			v1: depth,
			u2: 2 * width + 2 * depth,
			v2: depth + height,
		},
	};
}

/** Flip one face's U corners inside its own cell, leaving the cell in place. */
function flipFrameU(frame: FaceFrame): void {
	const flippedU1 = 2 * frame.rect.x + frame.rect.width - frame.u1;
	const flippedU2 = 2 * frame.rect.x + frame.rect.width - frame.u2;
	frame.u1 = flippedU1;
	frame.u2 = flippedU2;
}

/**
 * The six faces of one box, in `ENTITY_FACE_NAMES` order, with absolute
 * texture coordinates. Callers must have validated size and UV first.
 */
export function boxUvFaces(
	partId: string,
	layer: EntityLayer,
	size: readonly [number, number, number],
	uv: readonly [number, number],
	mirror: boolean,
): EntityFace[] {
	const frames = boxUvFrame(size);
	if (mirror) {
		for (const name of ENTITY_FACE_NAMES) {
			flipFrameU(frames[name]);
		}
		const right = frames.right;
		frames.right = frames.left;
		frames.left = right;
	}
	const [u, v] = uv;
	return ENTITY_FACE_NAMES.map((face) => {
		const frame = frames[face];
		return {
			partId,
			layer,
			face,
			rect: {
				x: u + frame.rect.x,
				y: v + frame.rect.y,
				width: frame.rect.width,
				height: frame.rect.height,
			},
			uv: [u + frame.u1, v + frame.v1, u + frame.u2, v + frame.v2] as const,
			mirror,
		};
	});
}
