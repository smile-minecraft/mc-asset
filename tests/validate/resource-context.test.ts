import { describe, expect, test } from "bun:test";
import {
	RESOURCE_CONTEXT_CASES,
	type ResourceContextCheck,
} from "./resource-context-cases.ts";

const check: ResourceContextCheck = {
	equal: (actual, expected, _message) => expect(actual).toBe(expected),
	deepEqual: (actual, expected, _message) => expect(actual).toEqual(expected),
	ok: (value, _message) => expect(value).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("resource resolution context cases", () => {
	for (const resourceCase of RESOURCE_CONTEXT_CASES) {
		test(resourceCase.name, async () => {
			await resourceCase.run(check);
		});
	}
});
