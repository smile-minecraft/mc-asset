import { describe, expect, test } from "bun:test";
import { McAssetError } from "../../src/core/errors.ts";
import { GUI_SCALING_CASES, type GuiCaseCheck } from "./gui-scaling-cases.ts";

const check: GuiCaseCheck = {
	equal: (actual, expected, _message) => expect(actual).toBe(expected),
	deepEqual: (actual, expected, _message) => expect(actual).toEqual(expected),
	ok: (value, _message) => expect(value).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("gui scaling", () => {
	for (const guiCase of GUI_SCALING_CASES) {
		test(guiCase.name, () => {
			guiCase.run(check);
		});
	}

	test("thrown errors carry the McAssetError code", () => {
		try {
			GUI_SCALING_CASES[0]?.run({
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
