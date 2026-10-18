import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { McAssetError } from "../../src/core/errors.ts";
import { OUTLINE_CASES, type OutlineCheck } from "./outline-cases.ts";

const check: OutlineCheck = {
	equal: (actual, expected, message) =>
		assert.strictEqual(actual, expected, message ?? "check failed"),
	deepEqual: (actual, expected, message) =>
		assert.deepStrictEqual(actual, expected, message ?? "check failed"),
	ok: (value, message) => assert.ok(value, message ?? "check failed"),
	sha256Hex: (bytes) => createHash("sha256").update(bytes).digest("hex"),
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

describe("outline operation", () => {
	for (const outlineCase of OUTLINE_CASES) {
		it(outlineCase.name, () => {
			outlineCase.run(check);
		});
	}
});
