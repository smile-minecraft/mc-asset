/**
 * Fixed-point scales shared by the geometry core.
 *
 * Vertices, projected screen coordinates and texture coordinates are integers,
 * so nothing in the pipeline depends on floating point and Bun and Node produce
 * byte-identical buffers. The screen-space rasteriser works on a finer
 * "subpixel" grid and only rounds to whole pixels at the end.
 *
 * A step of `FIXED_UNIT` equals exactly the model file step of 1/16 of one
 * unit (a 1/256 nudge), matching how model coordinates are described by the
 * game. Coordinates are meant to stay with an absolute value below 2**17
 * subpixel units (8192 px): differences then stay below 2**18, each product
 * in an edge function stays below 2**36 and the edge function itself stays
 * below 2**37, so coverage arithmetic is exact in doubles.
 *
 * Interpolation multiplies each weight (at most the triangle area) by a
 * vertex attribute: below 2**20 for a texture coordinate of a 4096-texel
 * texture at 1/256 texel, or any Int32 for a depth. `raster.ts` divides the
 * interpolated numerator with a Number `divRound` while the area is at most
 * 2**28 — then the u and v numerators stay below 3 * 2**48, far under
 * 2**53 — and with a BigInt `divRoundBigInt` above it, which stays exact for
 * any Int32 depth.
 *
 * `TRIG_ONE` is the integer that stands for 1.0 in every sine and cosine
 * value. A power of two keeps the division in `divRound` exact in binary
 * floating point whenever the dividend is an integer below 2**53.
 */
export const FIXED_UNIT = 256;
export const TRIG_ONE = 65536;
export const SUBPIXEL = 16;

/**
 * Round `value / divisor` to the nearest integer, ties away from zero. The
 * divisor must be positive. Divisors that are a power of two are exact in
 * binary floating point, and the other divisors used here (90000) are small
 * enough that an IEEE result is identical on Bun and Node.
 */
export function divRound(value: number, divisor: number): number {
	if (value >= 0) {
		const result = Math.floor((value + divisor / 2) / divisor);
		// Never return negative zero, so matrices compare equal to hand-written zeros.
		return result === 0 ? 0 : result;
	}
	const result = -Math.floor((-value + divisor / 2) / divisor);
	return result === 0 ? 0 : result;
}
