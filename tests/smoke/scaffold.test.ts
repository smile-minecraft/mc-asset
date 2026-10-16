import { describe, expect, test } from "bun:test";
import packageJson from "../../package.json";

describe("scaffold", () => {
	test("package.json scripts include the toolchain keys", () => {
		const scripts =
			(packageJson as { scripts?: Record<string, string> }).scripts ?? {};
		for (const key of [
			"test",
			"test:full",
			"test:typecheck",
			"lint",
			"build",
		]) {
			expect(scripts).toHaveProperty(key);
		}
	});

	test("test:full opts into the skipped runtime comparison", () => {
		const scripts =
			(packageJson as { scripts?: Record<string, string> }).scripts ?? {};
		expect(scripts["test:full"] ?? "").toContain("MC_ASSET_FULL_TESTS");
	});
});
