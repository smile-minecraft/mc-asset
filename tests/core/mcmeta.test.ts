import { describe, expect, test } from "bun:test";
import { McAssetError } from "../../src/core/errors.ts";
import { type CaseCheck, MCMETA_CASES } from "./mcmeta-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, _message) => expect(actual).toBe(expected),
	deepEqual: (actual, expected, _message) => expect(actual).toEqual(expected),
	ok: (value, _message) => expect(value).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
	throwsCode: (fn, code, _message) => expect(fn).toThrow(code),
};

describe("mcmeta texture scaling", () => {
	for (const mcmetaCase of MCMETA_CASES) {
		test(mcmetaCase.name, () => {
			mcmetaCase.run(check);
		});
	}

	test("thrown errors carry the McAssetError code", () => {
		try {
			MCMETA_CASES[0]?.run({
				...check,
				equal: () => {
					throw new McAssetError("INTERNAL_ERROR", "probe");
				},
			});
			throw new Error("expected a throw");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
		}
	});
});
