import { describe, expect, test } from "bun:test";
import { PACK_COVERAGE_CASES } from "./pack-coverage-cases.ts";
import type { PackCaseCheck } from "./pack-model-cases.ts";

const check: PackCaseCheck = {
	equal: (actual, expected, message) => expect(actual, message).toBe(expected),
	deepEqual: (actual, expected, message) =>
		expect(actual, message).toEqual(expected),
	ok: (value, message) => expect(value, message).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("validate-pack coverage cases", () => {
	for (const packCase of PACK_COVERAGE_CASES) {
		test(packCase.name, async () => {
			await packCase.run(check);
		});
	}
});
