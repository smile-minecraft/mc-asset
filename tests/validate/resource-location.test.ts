import { describe, expect, test } from "bun:test";
import { RESOURCE_LOCATION_CASES } from "./resource-location-cases.ts";
import type { CaseCheck } from "./validate-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, _message) => expect(actual).toBe(expected),
	deepEqual: (actual, expected, _message) => expect(actual).toEqual(expected),
	ok: (value, _message) => expect(value).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("resource location engine pure cases", () => {
	for (const resourceLocationCase of RESOURCE_LOCATION_CASES) {
		test(resourceLocationCase.name, () => {
			resourceLocationCase.run(check);
		});
	}
});
