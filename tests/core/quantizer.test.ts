import { describe, expect, test } from "bun:test";
import type { CaseCheck } from "./model-cases.ts";
import { QUANTIZER_CASES } from "./quantizer-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, _message) => expect(actual).toBe(expected),
	deepEqual: (actual, expected, _message) => expect(actual).toEqual(expected),
	ok: (value, _message) => expect(value).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
	throwsCode: (fn, code, _message) => expect(fn).toThrow(code),
};

describe("integer median-cut quantizer", () => {
	for (const quantizerCase of QUANTIZER_CASES) {
		test(quantizerCase.name, () => {
			quantizerCase.run(check);
		});
	}
});
