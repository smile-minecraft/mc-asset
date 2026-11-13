import { divRound, TRIG_ONE } from "./fixed.ts";

/**
 * A 3D point or vector in 1/256 model units.
 *
 * Coordinates are right-handed with +y up: +x points east, +z points south.
 */
export type FixedVec3 = readonly [number, number, number];

/**
 * Row-major 3x3 rotation matrix in Q16 fixed point, where `TRIG_ONE` is 1.0.
 * Rotation matrices only carry sine, cosine and 0/1, so every entry fits the
 * Q16 range exactly. The same class of matrix also carries the quarter turns
 * used to pick an isometric view.
 *
 * Compositions stay determinate because every intermediate is an integer below
 * 2**53: the biggest one, `TRIG_ONE * TRIG_ONE`, is 2**32.
 */
export type Mat3 = readonly [
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
];

/** 1.0 on the diagonal, 0 elsewhere. */
export const IDENTITY_MAT3: Mat3 = [
	TRIG_ONE,
	0,
	0,
	0,
	TRIG_ONE,
	0,
	0,
	0,
	TRIG_ONE,
];

/** Apply a Q16 rotation matrix to a fixed-point vector. */
export function applyMat3(m: Mat3, v: FixedVec3): FixedVec3 {
	const [x, y, z] = v;
	return [
		divRound(m[0] * x + m[1] * y + m[2] * z, TRIG_ONE),
		divRound(m[3] * x + m[4] * y + m[5] * z, TRIG_ONE),
		divRound(m[6] * x + m[7] * y + m[8] * z, TRIG_ONE),
	];
}

function productAt(a: Mat3, b: Mat3, row: number, col: number): number {
	const ar = row * 3;
	return divRound(
		a[ar] * b[col] + a[ar + 1] * b[col + 3] + a[ar + 2] * b[col + 6],
		TRIG_ONE,
	);
}

/** Multiply two Q16 matrices (a * b). Because applyMat3 treats vectors as columns, applying multiplyMat3(a, b) to a vector applies b first, then a: applyMat3(multiplyMat3(a, b), v) === applyMat3(a, applyMat3(b, v)). */
export function multiplyMat3(a: Mat3, b: Mat3): Mat3 {
	return [
		productAt(a, b, 0, 0),
		productAt(a, b, 0, 1),
		productAt(a, b, 0, 2),
		productAt(a, b, 1, 0),
		productAt(a, b, 1, 1),
		productAt(a, b, 1, 2),
		productAt(a, b, 2, 0),
		productAt(a, b, 2, 1),
		productAt(a, b, 2, 2),
	];
}
