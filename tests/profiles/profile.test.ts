import { describe, expect, test } from "bun:test";
import { type CaseCheck, MODEL_CASES } from "./profile-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, _message) => expect(actual).toBe(expected),
	deepEqual: (actual, expected, _message) => expect(actual).toEqual(expected),
	ok: (value, _message) => expect(value).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("asset profiles and predicted alpha", () => {
	for (const modelCase of MODEL_CASES) {
		test(modelCase.name, () => {
			modelCase.run(check);
		});
	}
});
