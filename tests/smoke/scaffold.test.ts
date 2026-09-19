import { describe, expect, test } from "bun:test";
import packageJson from "../../package.json";
import { VERSION } from "../../src/index.ts";

describe("scaffold", () => {
	test("VERSION constant exists and is a non-empty string", () => {
		expect(typeof VERSION).toBe("string");
		expect(VERSION.length).toBeGreaterThan(0);
	});

	test("Bun runtime is available", () => {
		expect(typeof Bun.version).toBe("string");
		expect(Bun.version.length).toBeGreaterThan(0);
	});

	test("package.json scripts include toolchain keys", () => {
		const scripts =
			(packageJson as { scripts?: Record<string, string> }).scripts ?? {};
		for (const key of ["test", "test:typecheck", "lint", "build"]) {
			expect(scripts).toHaveProperty(key);
		}
	});
});
