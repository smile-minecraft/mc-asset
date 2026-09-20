import { describe, expect, test } from "bun:test";
import { TILE_CASES, type TileCheck } from "./tile-cases.ts";

const check: TileCheck = {
	equal: (actual, expected, message) =>
		expect(actual, message ?? "check failed").toBe(expected),
	deepEqual: (actual, expected, message) =>
		expect(actual, message ?? "check failed").toEqual(expected),
	ok: (value, message) => expect(value, message ?? "check failed").toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
	throwsCode: (fn, code, message) => {
		try {
			fn();
		} catch (error) {
			expect(
				(error as { code?: unknown } | null)?.code,
				message ?? "wrong error code",
			).toBe(code);
			return;
		}
		throw new Error(
			message ?? `expected McAssetError(${code}) but nothing was thrown`,
		);
	},
};

describe("tile engine", () => {
	for (const tileCase of TILE_CASES) {
		test(tileCase.name, () => {
			tileCase.run(check);
		});
	}
});
