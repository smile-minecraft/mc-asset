import { describe, expect, test } from "bun:test";
import { BATCH_CASES } from "./batch-cases.ts";
import type { CaseCheck } from "./model-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, _message) => expect(actual).toBe(expected),
	deepEqual: (actual, expected, _message) => expect(actual).toEqual(expected),
	ok: (value, _message) => expect(value).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
	throwsCode: (fn, code, _message) => expect(fn).toThrow(code),
};

describe("batch operations", () => {
	for (const batchCase of BATCH_CASES) {
		test(batchCase.name, () => {
			batchCase.run(check);
		});
	}
});
