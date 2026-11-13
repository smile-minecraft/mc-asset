import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { McAssetError } from "../../src/core/errors.ts";
import { type CliResult, runCliInProcess } from "../support/cli-runner.ts";
import {
	baseSpec,
	FONT_CASES,
	type FontCaseCheck,
	withTempDir,
	writeIcon,
	writeSpec,
} from "./font-cases.ts";

const check: FontCaseCheck = {
	equal: (actual, expected, message) => expect(actual, message).toBe(expected),
	deepEqual: (actual, expected, message) =>
		expect(actual, message).toEqual(expected),
	ok: (value, message) => expect(value, message).toBeTruthy(),
	fail: (message): never => {
		throw new Error(message);
	},
	throws: (fn, code, message) => {
		let thrown: unknown;
		try {
			fn();
		} catch (error) {
			thrown = error;
		}
		if (!(thrown instanceof McAssetError)) {
			throw new Error(
				message ?? `expected McAssetError(${code}) but nothing was thrown`,
			);
		}
		expect(String(thrown.code)).toBe(code);
	},
	rejects: async (fn, code, message) => {
		let thrown: unknown;
		try {
			await fn();
		} catch (error) {
			thrown = error;
		}
		if (!(thrown instanceof McAssetError)) {
			throw new Error(
				message ?? `expected McAssetError(${code}) but nothing was thrown`,
			);
		}
		expect(String(thrown.code)).toBe(code);
	},
};

function stdoutText(result: CliResult): string {
	return Buffer.from(result.stdout).toString("utf-8");
}

describe("font icon generator", () => {
	for (const fontCase of FONT_CASES) {
		test(fontCase.name, async () => {
			await fontCase.run(check);
		}, 30_000);
	}
});

describe("font command wiring", () => {
	test("writes the definition, atlas, and table in one run", async () => {
		await withTempDir(async (dir) => {
			await writeIcon(dir, "apple", { r: 255, g: 0, b: 0, a: 255 });
			await writeIcon(dir, "banana", { r: 0, g: 255, b: 0, a: 255 });
			await writeIcon(dir, "cherry", { r: 0, g: 0, b: 255, a: 255 });
			const specPath = await writeSpec(dir, baseSpec());
			const output = join(dir, "pack/assets/example/font/icons.json");
			const atlas = join(dir, "pack/assets/example/textures/font/icons.png");
			const table = join(dir, "table.json");
			const result = await runCliInProcess([
				"--json",
				"font",
				specPath,
				"--output",
				output,
				"--atlas",
				atlas,
				"--table",
				table,
				"--mkdir",
			]);
			expect(result.code).toBe(0);
			const body = JSON.parse(stdoutText(result)) as {
				success: boolean;
				result: {
					command: string;
					font: string;
					icons: number;
					output: string;
					atlas: string;
					table: string;
				};
			};
			expect(body.success).toBe(true);
			expect(body.result.command).toBe("font");
			expect(body.result.font).toBe("example:icons");
			expect(body.result.icons).toBe(3);
			expect(body.result.output).toBe(output);
			expect(body.result.atlas).toBe(atlas);
			expect(body.result.table).toBe(table);
		});
	}, 30_000);

	test("keeps the refusal code and exit 2 for a collision", async () => {
		await withTempDir(async (dir) => {
			await writeIcon(dir, "apple", { r: 255, g: 0, b: 0, a: 255 });
			const spec = baseSpec();
			spec.icons = [
				{
					name: "apple",
					path: "icons/apple.png",
					codePoint: "\uE000",
				},
				{
					name: "banana",
					path: "icons/apple.png",
					codePoint: "\uE000",
				},
			];
			const specPath = await writeSpec(dir, spec);
			const result = await runCliInProcess([
				"--json",
				"font",
				specPath,
				"--output",
				join(dir, "font.json"),
			]);
			expect(result.code).toBe(2);
			const body = JSON.parse(stdoutText(result)) as {
				success: boolean;
				error: { code: string };
			};
			expect(body.success).toBe(false);
			expect(body.error.code).toBe("FONT_CODEPOINT_CONFLICT");
		});
	}, 30_000);
});
