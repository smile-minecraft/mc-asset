import { describe, expect, test } from "bun:test";
import { FRAMESET_CASES } from "./frameset-cases.ts";
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

describe("frameset engine", () => {
	for (const framesetCase of FRAMESET_CASES) {
		test(framesetCase.name, () => {
			framesetCase.run(check);
		});
	}
});
