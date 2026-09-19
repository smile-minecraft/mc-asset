import { describe, expect, test } from "bun:test";
import { DECODE_CASES, type DecodeCheck } from "./decode-cases.ts";

const check: DecodeCheck = {
	equal: (actual, expected, message) =>
		expect(actual, message ?? "check failed").toBe(expected),
	deepEqual: (actual, expected, message) =>
		expect(actual, message ?? "check failed").toEqual(expected),
	ok: (value, message) => expect(value, message ?? "check failed").toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
	throwsCodeAsync: async (fn, code, message) => {
		try {
			await fn();
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

describe("multi-format decode", () => {
	for (const decodeCase of DECODE_CASES) {
		test(decodeCase.name, async () => {
			await decodeCase.run(check);
		});
	}
});
