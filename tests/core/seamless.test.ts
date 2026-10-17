import { describe, expect, test } from "bun:test";
import { SEAMLESS_CASES, type SeamlessCheck } from "./seamless-cases.ts";

const check: SeamlessCheck = {
	ok: (value, message) => expect(value, message ?? "check failed").toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
};

describe("procedural patterns tile without a seam", () => {
	for (const seamlessCase of SEAMLESS_CASES) {
		test(seamlessCase.name, () => {
			seamlessCase.run(check);
		});
	}
});
