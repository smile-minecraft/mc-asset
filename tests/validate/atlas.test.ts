import { describe, expect, test } from "bun:test";
import { ATLAS_CASES, type AtlasCaseCheck } from "./atlas-cases.ts";

const check: AtlasCaseCheck = {
	equal: (actual, expected, _message) => expect(actual).toBe(expected),
	deepEqual: (actual, expected, _message) => expect(actual).toEqual(expected),
	ok: (value, _message) => expect(value).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("atlas sources cases", () => {
	for (const atlasCase of ATLAS_CASES) {
		test(atlasCase.name, async () => {
			await atlasCase.run(check);
		});
	}
});
