import { describe, expect, test } from "bun:test";
import type { CaseCheck } from "./json-document-cases.ts";
import { PREVIEW_CASES } from "./preview-cases.ts";
import { DISPLAY_PREVIEW_CASES } from "./preview-display-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, message) => expect(actual, message).toBe(expected),
	deepEqual: (actual, expected, message) =>
		expect(actual, message).toEqual(expected),
	ok: (value, message) => expect(value, message).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("model preview", () => {
	for (const modelCase of PREVIEW_CASES) {
		test(modelCase.name, async () => {
			await modelCase.run(check);
		});
	}
});

describe("model preview display, lighting and tint", () => {
	for (const modelCase of DISPLAY_PREVIEW_CASES) {
		test(modelCase.name, async () => {
			await modelCase.run(check);
		});
	}
});
