import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { McAssetError } from "../../src/core/errors.ts";
import { FONT_CASES, type FontCaseCheck } from "./font-cases.ts";

const check: FontCaseCheck = {
	equal: (actual, expected, message) =>
		assert.strictEqual(actual, expected, message ?? "check failed"),
	deepEqual: (actual, expected, message) =>
		assert.deepStrictEqual(actual, expected, message ?? "check failed"),
	ok: (value, message) => assert.ok(value, message ?? "check failed"),
	fail: (message): never => {
		throw new Error(message);
	},
	throws: (fn, code, message) => {
		assert.throws(
			fn,
			(error: unknown) => {
				assert.ok(error instanceof McAssetError, "expected McAssetError");
				assert.strictEqual(error.code, code, message ?? "wrong error code");
				return true;
			},
			message,
		);
	},
	rejects: async (fn, code, message) => {
		let thrown: unknown;
		try {
			await fn();
		} catch (error) {
			thrown = error;
		}
		assert.ok(
			thrown instanceof McAssetError,
			message ?? `expected McAssetError(${code}) but nothing was thrown`,
		);
		assert.strictEqual(thrown.code, code, message ?? "wrong error code");
	},
};

describe("font icon generator", () => {
	for (const fontCase of FONT_CASES) {
		it(fontCase.name, async () => {
			await fontCase.run(check);
		});
	}
});
