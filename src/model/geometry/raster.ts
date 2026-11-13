import { divRound, SUBPIXEL } from "./fixed.ts";

/**
 * Deterministic RGBA8 rasteriser.
 *
 * Everything here is integer arithmetic on fixed-point grids, so a given
 * scene produces byte-identical output on Bun and Node. Vertices carry
 * positions in 1/16 pixel (`SUBPIXEL` per pixel), depth values in the
 * caller's units (larger is nearer), and texture coordinates in 1/256 texel.
 *
 * Coverage uses a top-left style rule: a pixel is drawn when its centre sits
 * strictly inside the triangle, or on an edge that runs along the top or
 * down the left side of the triangle. Pixels shared by two triangles are
 * therefore drawn exactly once, which keeps alpha blending idempotent for
 * quads that are split into two triangles along their diagonal. The winding
 * is normalised to a positive area before the rule is applied, so both
 * orientations tile the same pixels.
 *
 * Depth is tested with "larger wins": a pixel is repainted only when its new
 * depth is greater than or equal to the stored one, so on an exact tie the
 * later draw wins. Depth is only advanced for pixels that are drawn, so a
 * transparent fragment cannot hide what is behind it.
 *
 * Texture sampling is nearest neighbour with clamp-to-edge wrapping; out of
 * range coordinates clamp. Coordinates on the screen are expected to stay
 * below 2**17 subpixel units so the edge functions stay exact.
 */

export type RgbaColor = readonly [number, number, number, number];

export interface RgbaTexture {
	readonly width: number;
	readonly height: number;
	/** Row-major RGBA8 pixels, `width * height * 4` bytes. */
	readonly pixels: Uint8Array;
}

export interface RasterTarget {
	readonly width: number;
	readonly height: number;
	/** Row-major RGBA8 pixels. */
	readonly pixels: Uint8Array;
	/** One depth per pixel; larger is nearer, {@link DEPTH_EMPTY} means "nothing drawn". */
	readonly depth: Int32Array;
}

/** Initial value of every depth cell: "nothing drawn yet". */
export const DEPTH_EMPTY = -2147483648;

export function createRasterTarget(
	width: number,
	height: number,
): RasterTarget {
	return {
		width,
		height,
		pixels: new Uint8Array(width * height * 4),
		depth: new Int32Array(width * height).fill(DEPTH_EMPTY),
	};
}

export interface RasterVertex {
	/** Screen x in 1/16 pixel. */
	readonly x: number;
	/** Screen y in 1/16 pixel. */
	readonly y: number;
	/** Depth for the z-buffer; larger values are nearer the camera. */
	readonly z: number;
	/** Texture u in 1/256 texel. */
	readonly u: number;
	/** Texture v in 1/256 texel. */
	readonly v: number;
}

/** What covers the triangle; exactly one of these is used. */
export type RasterSource =
	| { readonly texture: RgbaTexture }
	| { readonly color: RgbaColor };

export interface RasterOptions {
	/**
	 * `replace` copies the fragment RGBA verbatim; `alpha` composes the colour
	 * over the current pixel with integer src-over. Defaults to `replace`.
	 */
	readonly blend?: "replace" | "alpha";
	/**
	 * Fragments whose sampled alpha is exactly zero are dropped before the
	 * depth test. Defaults to true.
	 */
	readonly cutout?: boolean;
}

const TEXEL_UNIT = 256;

function edgeFunction(
	ax: number,
	ay: number,
	bx: number,
	by: number,
	px: number,
	py: number,
): number {
	return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

function isTopLeftEdge(dx: number, dy: number): boolean {
	if (dy === 0) return dx > 0;
	return dy < 0;
}

function clampIndex(index: number, size: number): number {
	if (index < 0) return 0;
	if (index >= size) return size - 1;
	return index;
}

function textureAt(texture: RgbaTexture, u: number, v: number): RgbaColor {
	const tx = clampIndex(Math.floor(u / TEXEL_UNIT), texture.width);
	const ty = clampIndex(Math.floor(v / TEXEL_UNIT), texture.height);
	const offset = (ty * texture.width + tx) * 4;
	return [
		texture.pixels[offset] as number,
		texture.pixels[offset + 1] as number,
		texture.pixels[offset + 2] as number,
		texture.pixels[offset + 3] as number,
	];
}

function blendSrcOver(
	dst: readonly [number, number, number, number],
	src: RgbaColor,
): RgbaColor {
	const sourceAlpha = src[3];
	if (sourceAlpha === 0) return [dst[0], dst[1], dst[2], dst[3]];
	if (sourceAlpha === 255) return [src[0], src[1], src[2], src[3]];
	const dstAlpha = dst[3];
	const channel = (s: number, d: number): number =>
		d + divRound((s - d) * sourceAlpha, 255);
	return [
		channel(src[0], dst[0]),
		channel(src[1], dst[1]),
		channel(src[2], dst[2]),
		dstAlpha + divRound((255 - dstAlpha) * sourceAlpha, 255),
	];
}

function writeFragment(
	target: RasterTarget,
	pixelIndex: number,
	fragment: RgbaColor,
	blend: "replace" | "alpha",
): void {
	const o = pixelIndex * 4;
	if (blend === "replace") {
		target.pixels[o] = fragment[0];
		target.pixels[o + 1] = fragment[1];
		target.pixels[o + 2] = fragment[2];
		target.pixels[o + 3] = fragment[3];
		return;
	}
	const blended = blendSrcOver(
		[
			target.pixels[o] as number,
			target.pixels[o + 1] as number,
			target.pixels[o + 2] as number,
			target.pixels[o + 3] as number,
		],
		fragment,
	);
	target.pixels[o] = blended[0];
	target.pixels[o + 1] = blended[1];
	target.pixels[o + 2] = blended[2];
	target.pixels[o + 3] = blended[3];
}

function sample(source: RasterSource, u: number, v: number): RgbaColor {
	if ("texture" in source) return textureAt(source.texture, u, v);
	return source.color;
}

/**
 * Rasterise one triangle. Vertices are not expected to be pre-ordered; the
 * winding is normalised to a positive area before coverage is decided.
 */
export function rasterizeTriangle(
	target: RasterTarget,
	vertexA: RasterVertex,
	vertexB: RasterVertex,
	vertexC: RasterVertex,
	source: RasterSource,
	options?: RasterOptions,
): void {
	const cutout = options?.cutout ?? true;
	const blend = options?.blend ?? "replace";

	const a = vertexA;
	let b = vertexB;
	let c = vertexC;
	let area = edgeFunction(a.x, a.y, b.x, b.y, c.x, c.y);
	if (area < 0) {
		const swapped = b;
		b = c;
		c = swapped;
		area = -area;
	}
	if (area === 0) return;

	const minX = Math.floor(Math.min(a.x, b.x, c.x) / SUBPIXEL);
	const maxX = Math.floor((Math.max(a.x, b.x, c.x) - 1) / SUBPIXEL);
	const minY = Math.floor(Math.min(a.y, b.y, c.y) / SUBPIXEL);
	const maxY = Math.floor((Math.max(a.y, b.y, c.y) - 1) / SUBPIXEL);
	if (target.width <= 0 || target.height <= 0) return;
	const left = Math.max(0, minX);
	const right = Math.min(target.width - 1, maxX);
	const top = Math.max(0, minY);
	const bottom = Math.min(target.height - 1, maxY);

	const ab = { dx: b.x - a.x, dy: b.y - a.y };
	const bc = { dx: c.x - b.x, dy: c.y - b.y };
	const ca = { dx: a.x - c.x, dy: a.y - c.y };
	const includeAb = isTopLeftEdge(ab.dx, ab.dy);
	const includeBc = isTopLeftEdge(bc.dx, bc.dy);
	const includeCa = isTopLeftEdge(ca.dx, ca.dy);

	for (let py = top; py <= bottom; py += 1) {
		const centerY = py * SUBPIXEL + SUBPIXEL / 2;
		for (let px = left; px <= right; px += 1) {
			const centerX = px * SUBPIXEL + SUBPIXEL / 2;
			const weightA = edgeFunction(b.x, b.y, c.x, c.y, centerX, centerY);
			const weightB = edgeFunction(c.x, c.y, a.x, a.y, centerX, centerY);
			const weightC = edgeFunction(a.x, a.y, b.x, b.y, centerX, centerY);
			if (weightA < 0 || weightB < 0 || weightC < 0) continue;
			if (weightA === 0 && !includeBc) continue;
			if (weightB === 0 && !includeCa) continue;
			if (weightC === 0 && !includeAb) continue;

			const u = divRound(weightA * a.u + weightB * b.u + weightC * c.u, area);
			const v = divRound(weightA * a.v + weightB * b.v + weightC * c.v, area);
			const depth = divRound(
				weightA * a.z + weightB * b.z + weightC * c.z,
				area,
			);

			const fragment = sample(source, u, v);
			if (cutout && fragment[3] === 0) continue;

			const pixelIndex = py * target.width + px;
			const stored = target.depth[pixelIndex] as number;
			if (depth < stored) continue;
			target.depth[pixelIndex] = depth;
			writeFragment(target, pixelIndex, fragment, blend);
		}
	}
}

/**
 * Rasterise a quad as two triangles. The diagonal runs from the first to the
 * third vertex; coverage along it is decided by the same top-left rule, so a
 * quad never paints a pixel twice.
 */
export function rasterizeQuad(
	target: RasterTarget,
	a: RasterVertex,
	b: RasterVertex,
	c: RasterVertex,
	d: RasterVertex,
	source: RasterSource,
	options?: RasterOptions,
): void {
	rasterizeTriangle(target, a, b, c, source, options);
	rasterizeTriangle(target, a, c, d, source, options);
}
