import { describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
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

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

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
					atlases: Array<{ atlas: string }>;
					table: string;
				};
			};
			expect(body.success).toBe(true);
			expect(body.result.command).toBe("font");
			expect(body.result.font).toBe("example:icons");
			expect(body.result.icons).toBe(3);
			expect(body.result.output).toBe(output);
			expect(body.result.atlases[0]?.atlas).toBe(atlas);
			expect(body.result.table).toBe(table);
		});
	}, 30_000);

	test("refuses to run without the table or an atlas sink", async () => {
		await withTempDir(async (dir) => {
			await writeIcon(dir, "apple", { r: 255, g: 0, b: 0, a: 255 });
			await writeIcon(dir, "banana", { r: 0, g: 255, b: 0, a: 255 });
			await writeIcon(dir, "cherry", { r: 0, g: 0, b: 255, a: 255 });
			const specPath = await writeSpec(dir, baseSpec());
			const output = join(dir, "font.json");
			const atlas = join(dir, "atlas.png");
			const table = join(dir, "table.json");
			const missing: Array<{ label: string; args: string[] }> = [
				{
					label: "no table",
					args: ["--output", output, "--atlas", atlas],
				},
				{
					label: "no atlas sink",
					args: ["--output", output, "--table", table],
				},
				{
					label: "no output",
					args: ["--atlas", atlas, "--table", table],
				},
			];
			for (const entry of missing) {
				const result = await runCliInProcess([
					"--json",
					"font",
					specPath,
					...entry.args,
				]);
				expect(result.code, entry.label).toBe(2);
				const body = JSON.parse(stdoutText(result)) as {
					success: boolean;
					error: { code: string };
				};
				expect(body.success).toBe(false);
				expect(body.error.code, entry.label).toBe("INVALID_ARGUMENT");
			}
			for (const path of [output, atlas, table]) {
				expect(await exists(path)).toBe(false);
			}
		});
	}, 30_000);

	test("writes one atlas per height/ascent group into --output-dir", async () => {
		await withTempDir(async (dir) => {
			await writeIcon(dir, "apple", { r: 255, g: 0, b: 0, a: 255 }, 8);
			await writeIcon(dir, "banana", { r: 0, g: 255, b: 0, a: 255 }, 16);
			const spec = {
				...baseSpec(),
				icons: [
					{ name: "apple", path: "icons/apple.png" },
					{
						name: "banana",
						path: "icons/banana.png",
						height: 16,
						ascent: 16,
					},
				],
			};
			const specPath = await writeSpec(dir, spec);
			const output = join(dir, "pack/assets/example/font/icons.json");
			const atlasDir = join(dir, "pack/assets/example/textures/font");
			const table = join(dir, "table.json");
			const result = await runCliInProcess([
				"--json",
				"font",
				specPath,
				"--output",
				output,
				"--output-dir",
				atlasDir,
				"--table",
				table,
				"--mkdir",
			]);
			expect(result.code).toBe(0);
			const body = JSON.parse(stdoutText(result)) as {
				result: { atlases: Array<{ atlas: string; height: number }> };
			};
			expect(body.result.atlases.map((atlas) => atlas.atlas)).toEqual([
				join(atlasDir, "icons_h8a7.png"),
				join(atlasDir, "icons_h16a16.png"),
			]);
			expect(await exists(join(atlasDir, "icons_h8a7.png"))).toBe(true);
			expect(await exists(join(atlasDir, "icons_h16a16.png"))).toBe(true);
			expect(await exists(join(atlasDir, "icons.png"))).toBe(false);
		});
	}, 30_000);

	test("refuses --atlas when the spec needs more than one atlas", async () => {
		await withTempDir(async (dir) => {
			await writeIcon(dir, "apple", { r: 255, g: 0, b: 0, a: 255 }, 8);
			await writeIcon(dir, "banana", { r: 0, g: 255, b: 0, a: 255 }, 16);
			const spec = {
				...baseSpec(),
				icons: [
					{ name: "apple", path: "icons/apple.png" },
					{
						name: "banana",
						path: "icons/banana.png",
						height: 16,
						ascent: 16,
					},
				],
			};
			const specPath = await writeSpec(dir, spec);
			const output = join(dir, "font.json");
			const atlas = join(dir, "atlas.png");
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
			]);
			expect(result.code).toBe(2);
			const body = JSON.parse(stdoutText(result)) as {
				error: { code: string; message: string };
			};
			expect(body.error.code).toBe("ARGUMENT_CONFLICT");
			expect(body.error.message).toContain("--output-dir");
			for (const path of [output, atlas, table]) {
				expect(await exists(path)).toBe(false);
			}
		});
	}, 30_000);

	test("--force never overwrites the spec or an icon image", async () => {
		await withTempDir(async (dir) => {
			await writeIcon(dir, "apple", { r: 255, g: 0, b: 0, a: 255 });
			const specPath = await writeSpec(dir, {
				...baseSpec(),
				icons: [{ name: "apple", path: "icons/apple.png" }],
			});
			const specBefore = await readFile(specPath, "utf8");
			const iconPath = join(dir, "icons/apple.png");
			const iconBefore = await readFile(iconPath);
			const output = join(dir, "font.json");
			const atlas = join(dir, "atlas.png");
			const table = join(dir, "table.json");
			const attempts = [
				["--output", specPath],
				["--table", specPath],
				["--atlas", iconPath],
			];
			for (const attempt of attempts) {
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
					...attempt,
					"--force",
				]);
				expect(result.code, attempt.join(" ")).toBe(2);
				const body = JSON.parse(stdoutText(result)) as {
					error: { code: string };
				};
				expect(body.error.code, attempt.join(" ")).toBe("ARGUMENT_CONFLICT");
			}
			expect(await readFile(specPath, "utf8")).toBe(specBefore);
			expect(
				Buffer.from(await readFile(iconPath)).equals(Buffer.from(iconBefore)),
			).toBe(true);
			for (const path of [output, atlas, table]) {
				expect(await exists(path)).toBe(false);
			}
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
				"--atlas",
				join(dir, "atlas.png"),
				"--table",
				join(dir, "table.json"),
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
