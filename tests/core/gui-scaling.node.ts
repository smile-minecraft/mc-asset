import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { McAssetError } from "../../src/core/errors.ts";
import { GUI_SCALING_CASES, type GuiCaseCheck } from "./gui-scaling-cases.ts";

const check: GuiCaseCheck = {
	equal: (actual, expected, message) =>
		assert.strictEqual(actual, expected, message ?? "check failed"),
	deepEqual: (actual, expected, message) =>
		assert.deepStrictEqual(actual, expected, message ?? "check failed"),
	ok: (value, message) => assert.ok(value, message ?? "check failed"),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("gui scaling", () => {
	for (const guiCase of GUI_SCALING_CASES) {
		it(guiCase.name, () => {
			guiCase.run(check);
		});
	}

	it("thrown errors carry the McAssetError code", () => {
		try {
			GUI_SCALING_CASES[0]?.run({
				...check,
				equal: () => {
					throw new McAssetError("INTERNAL_ERROR", "probe");
				},
			});
			throw new Error("expected a throw");
		} catch (error) {
			assert.ok(error instanceof Error);
		}
	});
});
