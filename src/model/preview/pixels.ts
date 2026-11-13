import type { RgbaTexture } from "../geometry/index.ts";
import type { Direction, FaceRotation } from "../types.ts";

export interface DecodedTexture {
	readonly width: number;
	readonly height: number;
	readonly pixels: Uint8Array;
	/** True when some pixel has an alpha between 1 and 254; such a face belongs to the alpha pass. */
	readonly translucent: boolean;
}

/** 8px cells, magenta first, anchored at the image origin. */
export function checkerColor(
	x: number,
	y: number,
): readonly [number, number, number, number] {
	const cx = Math.floor(x / 8);
	const cy = Math.floor(y / 8);
	return (cx + cy) % 2 === 0 ? [255, 0, 255, 255] : [0, 0, 0, 255];
}

/** A full-image checker, one texel per pixel, for faces whose texture cannot be resolved. */
export function checkerTexture(width: number, height: number): RgbaTexture {
	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const color = checkerColor(x, y);
			const o = (y * width + x) * 4;
			pixels[o] = color[0] as number;
			pixels[o + 1] = color[1] as number;
			pixels[o + 2] = color[2] as number;
			pixels[o + 3] = color[3] as number;
		}
	}
	return { width, height, pixels };
}

/** True when the texture has a partially transparent pixel. */
export function hasTranslucentAlpha(pixels: Uint8Array): boolean {
	for (let index = 3; index < pixels.length; index += 4) {
		const alpha = pixels[index] as number;
		if (alpha !== 0 && alpha !== 255) return true;
	}
	return false;
}

/** Model UV values are kept as integers in 1/256 model units, like model coordinates. */
const UV_SCALE = 256;
/** One texture repeat along an axis: 16 model units. */
const UV_LIMIT = 16 * UV_SCALE;

/** One face's UV rectangle (1/256 model units), pixel size and face rotation. */
export interface FaceRectangle {
	readonly u1: number;
	readonly v1: number;
	readonly u2: number;
	readonly v2: number;
	/** Width of the drawn face rectangle in pixels. */
	readonly width: number;
	/** Height of the drawn face rectangle in pixels. */
	readonly height: number;
	readonly rotation: FaceRotation;
}

/** Build a {@link FaceRectangle}, quantizing the model UVs to 1/256 model units. */
export function faceRectangle(
	uv: readonly [number, number, number, number],
	width: number,
	height: number,
	rotation: FaceRotation,
): FaceRectangle {
	return {
		u1: Math.round(uv[0] * UV_SCALE),
		v1: Math.round(uv[1] * UV_SCALE),
		u2: Math.round(uv[2] * UV_SCALE),
		v2: Math.round(uv[3] * UV_SCALE),
		width,
		height,
		rotation,
	};
}

/** Which sample axis a face rotation reads, and whether it reads it backwards. */
const FACE_ROTATION_AXES: Record<
	FaceRotation,
	{
		readonly uFromV: boolean;
		readonly uFlip: boolean;
		readonly vFromU: boolean;
		readonly vFlip: boolean;
	}
> = {
	0: { uFromV: false, uFlip: false, vFromU: false, vFlip: false },
	90: { uFromV: true, uFlip: false, vFromU: true, vFlip: true },
	180: { uFromV: false, uFlip: true, vFromU: false, vFlip: true },
	270: { uFromV: true, uFlip: true, vFromU: true, vFlip: false },
};

export function rotateFaceCoords(
	fx: number,
	fy: number,
	rotation: FaceRotation,
): readonly [number, number] {
	const axes = FACE_ROTATION_AXES[rotation];
	const su = axes.uFromV ? fy : fx;
	const sv = axes.vFromU ? fx : fy;
	return [axes.uFlip ? 1 - su : su, axes.vFlip ? 1 - sv : sv];
}

/**
 * The texel index for one axis: `floor(clamp(u) * texels / 16)` where `u` is
 * the exact fraction `(origin + span * num / den) / 256`. All integers; the
 * quotient stays below 4096 and its denominator below 2**21, so the division
 * is exact in double precision. A position outside [0, 16] clamps to the
 * texture edge.
 */
function texelIndex(
	origin: number,
	span: number,
	num: number,
	den: number,
	texels: number,
): number {
	let fixed = origin * den + span * num;
	const limit = UV_LIMIT * den;
	if (fixed < 0) fixed = 0;
	else if (fixed > limit) fixed = limit;
	const index = Math.floor((fixed * texels) / (den * UV_LIMIT));
	return index < texels ? index : texels - 1;
}

/**
 * Nearest-texel sample at the centre of one pixel of a textured face, using
 * only integer arithmetic. The pixel centre is the exact fraction
 * `(2x + 1) / (2 * width)` across the face, the face rotation permutes the
 * two axes, and the resulting texture position picks a texel with
 * {@link texelIndex}. `x` and `y` are offsets inside the face rectangle.
 */
export function sampleFacePixel(
	decoded: DecodedTexture,
	face: FaceRectangle,
	x: number,
	y: number,
): readonly [number, number, number, number] {
	const uNum = 2 * x + 1;
	const uDen = 2 * face.width;
	const vNum = 2 * y + 1;
	const vDen = 2 * face.height;
	const axes = FACE_ROTATION_AXES[face.rotation];
	const suNum = axes.uFromV ? vNum : uNum;
	const suDen = axes.uFromV ? vDen : uDen;
	const svNum = axes.vFromU ? uNum : vNum;
	const svDen = axes.vFromU ? uDen : vDen;
	const tx = texelIndex(
		face.u1,
		face.u2 - face.u1,
		axes.uFlip ? suDen - suNum : suNum,
		suDen,
		decoded.width,
	);
	const ty = texelIndex(
		face.v1,
		face.v2 - face.v1,
		axes.vFlip ? svDen - svNum : svNum,
		svDen,
		decoded.height,
	);
	const o = (ty * decoded.width + tx) * 4;
	return [
		decoded.pixels[o] as number,
		decoded.pixels[o + 1] as number,
		decoded.pixels[o + 2] as number,
		decoded.pixels[o + 3] as number,
	];
}

/**
 * The texture rectangle of a face whose `uv` is omitted. North mirrors x,
 * south/east/west mirror z or x directly, and `down` mirrors z; y always
 * maps the top of the texture to the largest y. The same values apply when
 * the element is later rotated, because rotation happens in model space.
 */
export function autoUv(
	face: Direction,
	minX: number,
	minY: number,
	minZ: number,
	maxX: number,
	maxY: number,
	maxZ: number,
): readonly [number, number, number, number] {
	if (face === "north") {
		return [16 - maxX, 16 - maxY, 16 - minX, 16 - minY];
	}
	if (face === "south") {
		return [minX, 16 - maxY, maxX, 16 - minY];
	}
	if (face === "east") {
		return [16 - maxZ, 16 - maxY, 16 - minZ, 16 - minY];
	}
	if (face === "west") {
		return [minZ, 16 - maxY, maxZ, 16 - minY];
	}
	if (face === "down") {
		return [minX, 16 - maxZ, maxX, 16 - minZ];
	}
	return [minX, minZ, maxX, maxZ];
}
