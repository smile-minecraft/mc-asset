import { describe, expect, test } from "bun:test";
import { PIXELIZE_CASES, type PixelizeCheck } from "./pixelize-cases.ts";

const check: PixelizeCheck = {
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

describe("pixelize pipeline", () => {
	for (const pixelizeCase of PIXELIZE_CASES) {
		test(pixelizeCase.name, () => {
			pixelizeCase.run(check);
		});
	}
});
