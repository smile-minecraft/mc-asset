import { describe, expect, test } from "bun:test";
import { type CaseCheck, MCPX_CASES } from "./mcpx-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, _message) => expect(actual).toBe(expected),
	deepEqual: (actual, expected, _message) => expect(actual).toEqual(expected),
	ok: (value, _message) => expect(value).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
	throwsCode: (fn, code, _message) => expect(fn).toThrow(code),
};

describe("mcpx grammar, canonical output, and round-trips", () => {
	for (const mcpxCase of MCPX_CASES) {
		test(mcpxCase.name, () => {
			mcpxCase.run(check);
		});
	}
});
