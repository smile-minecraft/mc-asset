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
 * `blend: "alpha"` does not change the depth rule: a blended fragment still
 * advances the depth buffer for the pixels it covers. Callers that composite
 * overlapping translucent surfaces should collect fragments with
 * {@link rasterizeQuadFragments} instead and blend them per pixel, because
 * the visible order of two overlapping planes can differ from pixel to
 * pixel; a fragment collected this way is depth-tested against the target's
 * current (opaque) depth only, never against other translucent fragments.
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
	 * over the current pixel with integer straight-alpha src-over (the same
	 * straight-alpha convention the canvas and PNG layers use). A blended
	 * fragment still advances the depth buffer, so draw opaque geometry first,
	 * then translucent geometry from far to near. Defaults to
	 * `replace`.
	 */
	readonly blend?: "replace" | "alpha";
	/**
	 * Fragments whose sampled alpha is exactly zero are dropped before the
	 * depth test. Defaults to true.
	 */
	readonly cutout?: boolean;
}

const TEXEL_UNIT = 256;

/**
 * Triangle areas above 2**28 can push `weight * attribute` past 2**53 for a
 * 4096-texel texture (u below 2**20) or an Int32 depth, so the interpolation
 * switches to BigInt above this limit. At or below it the u and v numerators
 * stay below 3 * 2**48 and plain Number arithmetic is exact.
 */
const BIGINT_AREA_LIMIT = 268_435_456;

/** Round `value / divisor` to the nearest integer, ties away from zero; the divisor must be positive. */
function divRoundBigInt(value: bigint, divisor: bigint): number {
	const half = divisor / 2n;
	if (value >= 0n) return Number((value + half) / divisor);
	return Number(-((-value + half) / divisor));
}

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

/**
 * Porter-Duff `src-over` in straight alpha.
 *
 * The whole toolchain keeps straight RGBA8 (`PixelCanvas`, `flattenCanvas`,
 * the PNG encoder), so the colour must be divided by the resulting alpha
 * instead of being weighted against the destination as if it were already
 * premultiplied: a half-transparent fragment over a transparent pixel keeps
 * its own colour, and over a half-transparent pixel the weights are
 * `sa * 255` against `da * (255 - sa)`. All weights are integers, and the
 * largest intermediate (`65025 * 255`) is far below 2**53.
 */
function blendSrcOver(
	dst: readonly [number, number, number, number],
	src: RgbaColor,
): RgbaColor {
	const sourceAlpha = src[3];
	const dstAlpha = dst[3];
	if (sourceAlpha === 0) return [dst[0], dst[1], dst[2], dst[3]];
	if (sourceAlpha === 255 || dstAlpha === 0) {
		return [src[0], src[1], src[2], sourceAlpha];
	}
	const srcWeight = sourceAlpha * 255;
	const dstWeight = dstAlpha * (255 - sourceAlpha);
	const outAlphaScaled = srcWeight + dstWeight;
	const channel = (s: number, d: number): number =>
		divRound(s * srcWeight + d * dstWeight, outAlphaScaled);
	return [
		channel(src[0], dst[0]),
		channel(src[1], dst[1]),
		channel(src[2], dst[2]),
		divRound(outAlphaScaled, 255),
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

export type FragmentSink = (
	pixelIndex: number,
	depth: number,
	color: RgbaColor,
) => void;

/**
 * The scan loop shared by the drawing and the collecting entry points. It
 * decides coverage, interpolates u, v and depth for each covered pixel and
 * drops fully transparent fragments; the sink decides what happens to the
 * surviving fragment.
 */
function scanTriangle(
	width: number,
	height: number,
	a: RasterVertex,
	b: RasterVertex,
	c: RasterVertex,
	source: RasterSource,
	cutout: boolean,
	sink: FragmentSink,
): void {
	let triB = b;
	let triC = c;
	let area = edgeFunction(a.x, a.y, triB.x, triB.y, triC.x, triC.y);
	if (area < 0) {
		const swapped = triB;
		triB = triC;
		triC = swapped;
		area = -area;
	}
	if (area === 0) return;

	const minX = Math.floor(Math.min(a.x, triB.x, triC.x) / SUBPIXEL);
	const maxX = Math.floor((Math.max(a.x, triB.x, triC.x) - 1) / SUBPIXEL);
	const minY = Math.floor(Math.min(a.y, triB.y, triC.y) / SUBPIXEL);
	const maxY = Math.floor((Math.max(a.y, triB.y, triC.y) - 1) / SUBPIXEL);
	if (width <= 0 || height <= 0) return;
	const useBigInt = area > BIGINT_AREA_LIMIT;
	const bigArea = useBigInt ? BigInt(area) : 0n;
	const left = Math.max(0, minX);
	const right = Math.min(width - 1, maxX);
	const top = Math.max(0, minY);
	const bottom = Math.min(height - 1, maxY);

	const ab = { dx: triB.x - a.x, dy: triB.y - a.y };
	const bc = { dx: triC.x - triB.x, dy: triC.y - triB.y };
	const ca = { dx: a.x - triC.x, dy: a.y - triC.y };
	const includeAb = isTopLeftEdge(ab.dx, ab.dy);
	const includeBc = isTopLeftEdge(bc.dx, bc.dy);
	const includeCa = isTopLeftEdge(ca.dx, ca.dy);

	for (let py = top; py <= bottom; py += 1) {
		const centerY = py * SUBPIXEL + SUBPIXEL / 2;
		for (let px = left; px <= right; px += 1) {
			const centerX = px * SUBPIXEL + SUBPIXEL / 2;
			const weightA = edgeFunction(
				triB.x,
				triB.y,
				triC.x,
				triC.y,
				centerX,
				centerY,
			);
			const weightB = edgeFunction(triC.x, triC.y, a.x, a.y, centerX, centerY);
			const weightC = edgeFunction(a.x, a.y, triB.x, triB.y, centerX, centerY);
			if (weightA < 0 || weightB < 0 || weightC < 0) continue;
			if (weightA === 0 && !includeBc) continue;
			if (weightB === 0 && !includeCa) continue;
			if (weightC === 0 && !includeAb) continue;

			let u: number;
			let v: number;
			let depth: number;
			if (useBigInt) {
				const weightABig = BigInt(weightA);
				const weightBBig = BigInt(weightB);
				const weightCBig = BigInt(weightC);
				u = divRoundBigInt(
					weightABig * BigInt(a.u) +
						weightBBig * BigInt(triB.u) +
						weightCBig * BigInt(triC.u),
					bigArea,
				);
				v = divRoundBigInt(
					weightABig * BigInt(a.v) +
						weightBBig * BigInt(triB.v) +
						weightCBig * BigInt(triC.v),
					bigArea,
				);
				depth = divRoundBigInt(
					weightABig * BigInt(a.z) +
						weightBBig * BigInt(triB.z) +
						weightCBig * BigInt(triC.z),
					bigArea,
				);
			} else {
				u = divRound(weightA * a.u + weightB * triB.u + weightC * triC.u, area);
				v = divRound(weightA * a.v + weightB * triB.v + weightC * triC.v, area);
				depth = divRound(
					weightA * a.z + weightB * triB.z + weightC * triC.z,
					area,
				);
			}

			const fragment = sample(source, u, v);
			if (cutout && fragment[3] === 0) continue;

			sink(py * width + px, depth, fragment);
		}
	}
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

	scanTriangle(
		target.width,
		target.height,
		vertexA,
		vertexB,
		vertexC,
		source,
		cutout,
		(pixelIndex, depth, fragment) => {
			const stored = target.depth[pixelIndex] as number;
			if (depth < stored) return;
			target.depth[pixelIndex] = depth;
			writeFragment(target, pixelIndex, fragment, blend);
		},
	);
}

/**
 * Rasterise a quad into a fragment sink instead of the target: coverage,
 * interpolation and the cutout of alpha-zero fragments match
 * {@link rasterizeQuad}, but nothing is depth-tested and nothing is written,
 * so the caller can compose the whole translucent pass per pixel.
 */
export function rasterizeQuadFragments(
	width: number,
	height: number,
	a: RasterVertex,
	b: RasterVertex,
	c: RasterVertex,
	d: RasterVertex,
	source: RasterSource,
	sink: FragmentSink,
	options?: Pick<RasterOptions, "cutout">,
): void {
	const cutout = options?.cutout ?? true;
	scanTriangle(width, height, a, b, c, source, cutout, sink);
	scanTriangle(width, height, a, c, d, source, cutout, sink);
}

/**
 * Composite one fragment over the pixel already in `target` with integer
 * straight-alpha src-over, leaving the depth buffer untouched.
 */
export function blendFragment(
	target: RasterTarget,
	pixelIndex: number,
	fragment: RgbaColor,
): void {
	writeFragment(target, pixelIndex, fragment, "alpha");
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
