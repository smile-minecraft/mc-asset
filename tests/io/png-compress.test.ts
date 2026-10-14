import { describe, expect, test } from "bun:test";
import { McAssetError } from "../../src/core/errors.ts";
import type { CaseCheck } from "./png-cases.ts";
import { PNG_COMPRESS_CASES } from "./png-compress-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, _message) => expect(actual).toBe(expected),
	deepEqual: (actual, expected, _message) => expect(actual).toEqual(expected),
	ok: (value, _message) => expect(value).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
	throwsCode: (fn, code, _message) => {
		try {
			fn();
		} catch (error) {
			expect(error).toBeInstanceOf(McAssetError);
			expect((error as McAssetError).code as string).toBe(code);
			return;
		}
		throw new Error(`expected McAssetError(${code}) but nothing was thrown`);
	},
};

describe("png compression", () => {
	for (const pngCase of PNG_COMPRESS_CASES) {
		test(pngCase.name, () => {
			pngCase.run(check);
		});
	}
});
