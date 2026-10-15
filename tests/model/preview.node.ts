import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CaseCheck } from "./json-document-cases.ts";
import { PREVIEW_CASES } from "./preview-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, message) =>
		assert.strictEqual(actual, expected, message ?? "check failed"),
	deepEqual: (actual, expected, message) =>
		assert.deepStrictEqual(actual, expected, message ?? "check failed"),
	ok: (value, message) => assert.ok(value, message ?? "check failed"),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("model preview", () => {
	for (const modelCase of PREVIEW_CASES) {
		it(modelCase.name, async () => {
			await modelCase.run(check);
		});
	}
});
