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

export function clampToEdge(value: number): number {
	if (value < 0) return 0;
	if (value > 16) return 16;
	return value;
}

export function sampleTexture(
	decoded: DecodedTexture,
	u: number,
	v: number,
): readonly [number, number, number, number] {
	const cu = clampToEdge(u);
	const cv = clampToEdge(v);
	let tx = Math.floor((cu * decoded.width) / 16);
	let ty = Math.floor((cv * decoded.height) / 16);
	if (tx < 0) tx = 0;
	if (ty < 0) ty = 0;
	if (tx >= decoded.width) tx = decoded.width - 1;
	if (ty >= decoded.height) ty = decoded.height - 1;
	const o = (ty * decoded.width + tx) * 4;
	return [
		decoded.pixels[o] as number,
		decoded.pixels[o + 1] as number,
		decoded.pixels[o + 2] as number,
		decoded.pixels[o + 3] as number,
	];
}

export function rotateFaceCoords(
	fx: number,
	fy: number,
	rotation: FaceRotation,
): readonly [number, number] {
	if (rotation === 90) return [fy, 1 - fx];
	if (rotation === 180) return [1 - fx, 1 - fy];
	if (rotation === 270) return [1 - fy, fx];
	return [fx, fy];
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
