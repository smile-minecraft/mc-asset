import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { McAssetError } from "../../src/core/errors.ts";
import { DECODE_CASES, type DecodeCheck } from "./decode-cases.ts";

const check: DecodeCheck = {
	equal: (actual, expected, message) =>
		assert.strictEqual(actual, expected, message ?? "check failed"),
	deepEqual: (actual, expected, message) =>
		assert.deepStrictEqual(actual, expected, message ?? "check failed"),
	ok: (value, message) => assert.ok(value, message ?? "check failed"),
	fail: (message): never => {
		throw new Error(message);
	},
	throwsCodeAsync: async (fn, code, message) => {
		try {
			await fn();
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

describe("multi-format decode", () => {
	for (const decodeCase of DECODE_CASES) {
		it(decodeCase.name, async () => {
			await decodeCase.run(check);
		});
	}
});
