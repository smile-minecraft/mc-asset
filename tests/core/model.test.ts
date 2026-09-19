import { describe, expect, test } from "bun:test";
import { type CaseCheck, MODEL_CASES } from "./model-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, _message) => expect(actual).toBe(expected),
	deepEqual: (actual, expected, _message) => expect(actual).toEqual(expected),
	ok: (value, _message) => expect(value).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
	throwsCode: (fn, code, _message) => expect(fn).toThrow(code),
};

describe("pixel canvas core model", () => {
	for (const modelCase of MODEL_CASES) {
		test(modelCase.name, () => {
			modelCase.run(check);
		});
	}
});
