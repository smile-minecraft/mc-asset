import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CaseCheck } from "./model-cases.ts";
import { QUANTIZE_PALETTE_CASES } from "./quantize-palette-cases.ts";

const check: CaseCheck = {
	equal: (actual, expected, message) =>
		assert.strictEqual(actual, expected, message ?? "check failed"),
	deepEqual: (actual, expected, message) =>
		assert.deepStrictEqual(actual, expected, message ?? "check failed"),
	ok: (value, message) => assert.ok(value, message ?? "check failed"),
	fail: (message): never => {
		throw new Error(message);
	},
	throwsCode: (fn, code, message) => {
		try {
			fn();
		} catch (error) {
			assert.ok(error instanceof Error, message ?? "expected an error");

			assert.match(
				String((error as { code?: unknown }).code ?? error),
				new RegExp(code),
				message ?? "wrong error code",
			);
			return;
		}
		throw new Error(message ?? `expected error ${code} but nothing was thrown`);
	},
};

describe("quantize with explicit palette and reserved colors", () => {
	for (const paletteCase of QUANTIZE_PALETTE_CASES) {
		it(paletteCase.name, () => {
			paletteCase.run(check);
		});
	}
});
