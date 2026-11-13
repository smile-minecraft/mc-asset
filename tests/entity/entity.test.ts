import { describe, expect, test } from "bun:test";
import { ENTITY_CASES, type EntityCaseCheck } from "./entity-cases.ts";

const check: EntityCaseCheck = {
	equal: (actual, expected, message) => expect(actual, message).toBe(expected),
	deepEqual: (actual, expected, message) =>
		expect(actual, message).toEqual(expected),
	ok: (value, message) => expect(value, message).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("entity", () => {
	for (const entityCase of ENTITY_CASES) {
		test(entityCase.name, async () => {
			await entityCase.run(check);
		});
	}
});
