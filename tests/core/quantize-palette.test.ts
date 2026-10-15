import { describe, expect, test } from "bun:test";
import type { CaseCheck } from "./model-cases.ts";
import { QUANTIZE_PALETTE_CASES } from "./quantize-palette-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, _message) => expect(actual).toBe(expected),
	deepEqual: (actual, expected, _message) => expect(actual).toEqual(expected),
	ok: (value, _message) => expect(value).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
	throwsCode: (fn, code, _message) => expect(fn).toThrow(code),
};

describe("quantize with explicit palette and reserved colors", () => {
	for (const paletteCase of QUANTIZE_PALETTE_CASES) {
		test(paletteCase.name, () => {
			paletteCase.run(check);
		});
	}
});
