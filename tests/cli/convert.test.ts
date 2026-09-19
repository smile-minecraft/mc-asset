import { describe, expect, test } from "bun:test";
import { type CaseCheck, CONVERT_CASES } from "./convert-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, _message) => expect(actual).toBe(expected),
	deepEqual: (actual, expected, _message) => expect(actual).toEqual(expected),
	ok: (value, _message) => expect(value).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("cli conversion pure cases", () => {
	for (const convertCase of CONVERT_CASES) {
		test(convertCase.name, () => {
			convertCase.run(check);
		});
	}
});
