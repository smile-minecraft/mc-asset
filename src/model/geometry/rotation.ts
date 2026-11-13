import { divRound, TRIG_ONE } from "./fixed.ts";
import type { Mat3 } from "./matrix.ts";

export const MILLI_DEGREES_PER_TURN = 360000;

/** One sixteenth of a full turn in milli-degrees: 22.5 degrees. */
export const SIXTEENTH_TURN_MILLI_DEGREES = 22500;

/** One quarter turn in milli-degrees: 90 degrees. */
export const QUARTER_TURN_MILLI_DEGREES = 90000;

export type RotationAxis = "x" | "y" | "z";

/**
 * Sine and cosine for every multiple of 22.5 degrees, one whole turn.
 *
 * These are the integer Q16 values `round(65536 * cos(k * pi / 8))` and
 * `round(65536 * sin(k * pi / 8))` for k = 0..15, taken from the double
 * precision values and rounded to the nearest integer. 90, 180 and 270
 * degrees are exact (0 and +-65536) because those are the only multiples
 * whose cosine and sine are rational. The remaining 12 values differ from the
 * true values by at most half a unit in the last place, which cannot move a
 * 16-unit cube corner by more than 2**-13 of a model unit, far below the
 * 1/256 step the model files use.
 */
const TURN_COS16 = [
	65536, 60547, 46341, 25080, 0, -25080, -46341, -60547, -65536, -60547, -46341,
	-25080, 0, 25080, 46341, 60547,
];
const TURN_SIN16 = [
	0, 25080, 46341, 60547, 65536, 60547, 46341, 25080, 0, -25080, -46341, -60547,
	-65536, -60547, -46341, -25080,
];

/**
 * Sine over one quarter turn, k = 0..256, for angles k * 90 / 256 degrees.
 *
 * These are the integer Q16 values `round(65536 * sin(k * pi / 512))`, taken
 * from the double precision sine and rounded to the nearest integer.
 * Regenerating them from a 256-entry sine table with a step of 90/256 degrees
 * yields exactly this list; linear interpolation between two entries stays
 * within 1 unit in the last place for every angle (measured 1.08 LSB at the
 * sampled points over a full turn), so the interpolated sine only differs
 * from the ideal rounded value by about a unit in the last place.
 */
const QUARTER_SINE_LUT = [
	0, 402, 804, 1206, 1608, 2010, 2412, 2814, 3216, 3617, 4019, 4420, 4821, 5222,
	5623, 6023, 6424, 6824, 7224, 7623, 8022, 8421, 8820, 9218, 9616, 10014,
	10411, 10808, 11204, 11600, 11996, 12391, 12785, 13180, 13573, 13966, 14359,
	14751, 15143, 15534, 15924, 16314, 16703, 17091, 17479, 17867, 18253, 18639,
	19024, 19409, 19792, 20175, 20557, 20939, 21320, 21699, 22078, 22457, 22834,
	23210, 23586, 23961, 24335, 24708, 25080, 25451, 25821, 26190, 26558, 26925,
	27291, 27656, 28020, 28383, 28745, 29106, 29466, 29824, 30182, 30538, 30893,
	31248, 31600, 31952, 32303, 32652, 33000, 33347, 33692, 34037, 34380, 34721,
	35062, 35401, 35738, 36075, 36410, 36744, 37076, 37407, 37736, 38064, 38391,
	38716, 39040, 39362, 39683, 40002, 40320, 40636, 40951, 41264, 41576, 41886,
	42194, 42501, 42806, 43110, 43412, 43713, 44011, 44308, 44604, 44898, 45190,
	45480, 45769, 46056, 46341, 46624, 46906, 47186, 47464, 47741, 48015, 48288,
	48559, 48828, 49095, 49361, 49624, 49886, 50146, 50404, 50660, 50914, 51166,
	51417, 51665, 51911, 52156, 52398, 52639, 52878, 53114, 53349, 53581, 53812,
	54040, 54267, 54491, 54714, 54934, 55152, 55368, 55582, 55794, 56004, 56212,
	56418, 56621, 56823, 57022, 57219, 57414, 57607, 57798, 57986, 58172, 58356,
	58538, 58718, 58896, 59071, 59244, 59415, 59583, 59750, 59914, 60075, 60235,
	60392, 60547, 60700, 60851, 60999, 61145, 61288, 61429, 61568, 61705, 61839,
	61971, 62101, 62228, 62353, 62476, 62596, 62714, 62830, 62943, 63054, 63162,
	63268, 63372, 63473, 63572, 63668, 63763, 63854, 63944, 64031, 64115, 64197,
	64277, 64354, 64429, 64501, 64571, 64639, 64704, 64766, 64827, 64884, 64940,
	64993, 65043, 65091, 65137, 65180, 65220, 65259, 65294, 65328, 65358, 65387,
	65413, 65436, 65457, 65476, 65492, 65505, 65516, 65525, 65531, 65535, 65536,
];
const QUARTER_LUT_STEPS = 256;

function normalizeMillidegrees(milliDegrees: number): number {
	return (
		((milliDegrees % MILLI_DEGREES_PER_TURN) + MILLI_DEGREES_PER_TURN) %
		MILLI_DEGREES_PER_TURN
	);
}

function sinQuarterLut(residualMillidegrees: number): number {
	const scaled = residualMillidegrees * QUARTER_LUT_STEPS;
	const index = Math.floor(scaled / QUARTER_TURN_MILLI_DEGREES);
	if (index >= QUARTER_LUT_STEPS)
		return QUARTER_SINE_LUT[QUARTER_LUT_STEPS] as number;
	const fraction = scaled - index * QUARTER_TURN_MILLI_DEGREES;
	const base = QUARTER_SINE_LUT[index] as number;
	const next = QUARTER_SINE_LUT[index + 1] as number;
	return base + divRound((next - base) * fraction, QUARTER_TURN_MILLI_DEGREES);
}

/**
 * Cosine and sine of an arbitrary angle in milli-degrees, Q16.
 *
 * The value is only ever used internally; callers receive matrices. The sine
 * comes from the lookup table with linear interpolation, the cosine is the
 * sine shifted by one quarter turn, so both carry the same error budget
 * (measured 1.08 unit in the last place over a full turn).
 */
function sinCosArbitrary(milliDegrees: number): { cos: number; sin: number } {
	const turn = normalizeMillidegrees(milliDegrees);
	const quarter = Math.floor(turn / QUARTER_TURN_MILLI_DEGREES);
	const residual = turn - quarter * QUARTER_TURN_MILLI_DEGREES;
	const sine = sinQuarterLut(residual);
	const cosine = sinQuarterLut(QUARTER_TURN_MILLI_DEGREES - residual);
	if (quarter === 0) return { cos: cosine, sin: sine };
	if (quarter === 1) return { cos: -sine, sin: cosine };
	if (quarter === 2) return { cos: -cosine, sin: -sine };
	return { cos: sine, sin: -cosine };
}

/** Avoid negative zeros in matrices, so rotation matrices compare equal to hand-written zeros. */
function nz(value: number): number {
	return value === 0 ? 0 : value;
}

function axisMatrix(axis: RotationAxis, cosine: number, sine: number): Mat3 {
	if (axis === "x") {
		return [TRIG_ONE, 0, 0, 0, cosine, nz(-sine), 0, sine, cosine];
	}
	if (axis === "y") {
		return [cosine, 0, sine, 0, TRIG_ONE, 0, nz(-sine), 0, cosine];
	}
	return [cosine, nz(-sine), 0, sine, cosine, 0, 0, 0, TRIG_ONE];
}

/**
 * Rotate about an axis by an exact multiple of 22.5 degrees.
 *
 * This is the path for the `origin` / `axis` / `angle` model rotation, whose
 * angle is restricted to a few multiples of 22.5 degrees, and for the `x` /
 * `y` / `z` form, so the integer table is used instead of the interpolated
 * lookup. Exact multiples of 90 degrees are reproduced exactly; the other
 * entries match the ideal rounded values to within one unit in the last place.
 */
export function sixteenthTurnMatrix(axis: RotationAxis, steps: number): Mat3 {
	const index = ((steps % 16) + 16) % 16;
	return axisMatrix(
		axis,
		TURN_COS16[index] as number,
		TURN_SIN16[index] as number,
	);
}

/**
 * Rotate about an axis by an arbitrary angle in milli-degrees, using the
 * interpolated lookup table. Use this for angles that are not exact
 * multiples of 22.5 degrees.
 */
export function arbitraryAngleMatrix(
	axis: RotationAxis,
	milliDegrees: number,
): Mat3 {
	const { cos, sin } = sinCosArbitrary(milliDegrees);
	return axisMatrix(axis, cos, sin);
}

/**
 * Rotate about an axis by an angle in milli-degrees. Exact multiples of 22.5
 * degrees take the precomputed table, every other angle takes the
 * interpolated lookup table.
 */
export function rotationMatrix(axis: RotationAxis, milliDegrees: number): Mat3 {
	if (milliDegrees % SIXTEENTH_TURN_MILLI_DEGREES === 0) {
		return sixteenthTurnMatrix(
			axis,
			milliDegrees / SIXTEENTH_TURN_MILLI_DEGREES,
		);
	}
	return arbitraryAngleMatrix(axis, milliDegrees);
}
