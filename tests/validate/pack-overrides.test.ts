import { describe, expect, test } from "bun:test";
import type { PackCaseCheck } from "./pack-model-cases.ts";
import { PACK_OVERRIDE_CASES } from "./pack-overrides-cases.ts";

const check: PackCaseCheck = {
	equal: (actual, expected, message) => expect(actual, message).toBe(expected),
	deepEqual: (actual, expected, message) =>
		expect(actual, message).toEqual(expected),
	ok: (value, message) => expect(value, message).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("validate-pack override reference cases", () => {
	for (const packCase of PACK_OVERRIDE_CASES) {
		test(packCase.name, async () => {
			await packCase.run(check);
		});
	}
});
