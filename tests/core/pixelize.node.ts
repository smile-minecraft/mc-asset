import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { McAssetError } from "../../src/core/errors.ts";
import { PIXELIZE_CASES, type PixelizeCheck } from "./pixelize-cases.ts";

const check: PixelizeCheck = {
	equal: (actual, expected, message) =>
		assert.strictEqual(actual, expected, message ?? "check failed"),
	deepEqual: (actual, expected, message) =>
		assert.deepStrictEqual(actual, expected, message ?? "check failed"),
	ok: (value, message) => assert.ok(value, message ?? "check failed"),
	fail: (message): never => {
		throw new Error(message);
	},
	throwsCode: (fn, code, message) => {
		try {
			fn();
		} catch (error) {
			assert.ok(
				error instanceof McAssetError,
				message ?? "expected McAssetError",
			);
			assert.strictEqual(error.code, code, message ?? "wrong error code");
			return;
		}
		throw new Error(
			message ?? `expected McAssetError(${code}) but nothing was thrown`,
		);
	},
};

describe("pixelize pipeline", () => {
	for (const pixelizeCase of PIXELIZE_CASES) {
		it(pixelizeCase.name, () => {
			pixelizeCase.run(check);
		});
	}
});
