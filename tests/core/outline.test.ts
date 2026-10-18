import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { OUTLINE_CASES, type OutlineCheck } from "./outline-cases.ts";

const check: OutlineCheck = {
	equal: (actual, expected, message) =>
		expect(actual, message ?? "check failed").toBe(expected),
	deepEqual: (actual, expected, message) =>
		expect(actual, message ?? "check failed").toEqual(expected),
	ok: (value, message) => expect(value, message ?? "check failed").toBeTruthy(),
	sha256Hex: (bytes) => createHash("sha256").update(bytes).digest("hex"),
	fail: (message): never => {
		throw new Error(message);
	},
	throwsCode: (fn, code, message) => {
		try {
			fn();
		} catch (error) {
			expect(
				(error as { code?: unknown } | null)?.code,
				message ?? "wrong error code",
			).toBe(code);
			return;
		}
		throw new Error(
			message ?? `expected McAssetError(${code}) but nothing was thrown`,
		);
	},
};

describe("outline operation", () => {
	for (const outlineCase of OUTLINE_CASES) {
		test(outlineCase.name, () => {
			outlineCase.run(check);
		});
	}
});
