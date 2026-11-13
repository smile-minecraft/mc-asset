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
 * game. Coordinates are meant to stay below 2**17 subpixel units (8192 px) so
 * every intermediate stays below 2**53 and the arithmetic is exact; each edge
 * function is then at most 2**34 and the texture interpolation stays below
 * 2**48.
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
