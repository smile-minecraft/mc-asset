import { describe, expect, test } from "bun:test";
import { type CaseCheck, CONFORMANCE_CASES } from "./conformance-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, _message) => expect(actual).toBe(expected),
	deepEqual: (actual, expected, _message) => expect(actual).toEqual(expected),
	ok: (value, _message) => expect(value).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
	throwsCode: (fn, code, _message) => expect(fn).toThrow(code),
};

describe("conformance net (pure, cross-module)", () => {
	for (const conformanceCase of CONFORMANCE_CASES) {
		test(conformanceCase.name, () => {
			conformanceCase.run(check);
		});
	}
});
