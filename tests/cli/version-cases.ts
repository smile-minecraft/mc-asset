import { resolveVersionTarget } from "../../src/cli/version-options.ts";
import { McAssetError } from "../../src/core/errors.ts";

/** Runner-agnostic assertion surface: bun:test and node:test entries adapt to this. */
export interface CaseCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
}

function throwsCode(check: CaseCheck, fn: () => unknown, code: string): void {
	try {
		fn();
	} catch (error) {
		if (error instanceof McAssetError && error.code === code) {
			return;
		}
		check.fail(
			`expected McAssetError(${code}) but got ${error instanceof McAssetError ? error.code : String(error)}`,
		);
	}
	check.fail(`expected McAssetError(${code}) but nothing was thrown`);
}

export interface VersionCase {
	name: string;
	run(check: CaseCheck): void;
}

export const VERSION_CASES: VersionCase[] = [
	{
		name: "no flags resolve to engine defaults",
		run: (check) => {
			check.deepEqual(
				resolveVersionTarget({}),
				{
					packFormat: undefined,
					minecraftVersion: undefined,
					resourcePackVersion: undefined,
				},
				"default target",
			);
		},
	},
	{
		name: "--minecraft-version 26.3 maps to the V0.1 version group",
		run: (check) => {
			const resolved = resolveVersionTarget({ minecraftVersion: "26.3" });
			check.equal(resolved.packFormat, 75, "packFormat 75");
			check.equal(resolved.minecraftVersion, "26.3", "echo minecraft version");
			check.equal(
				resolved.resourcePackVersion,
				"97.1",
				"echo resource pack version per section 95",
			);
		},
	},
	{
		name: "--resource-pack-version 75 maps to packFormat 75",
		run: (check) => {
			const resolved = resolveVersionTarget({ resourcePackVersion: "75" });
			check.equal(resolved.packFormat, 75, "packFormat 75");
			check.equal(
				resolved.resourcePackVersion,
				"75",
				"echo resource pack version",
			);
		},
	},
	{
		name: "unknown minecraft version is INVALID_ARGUMENT",
		run: (check) => {
			throwsCode(
				check,
				() => resolveVersionTarget({ minecraftVersion: "99.99" }),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => resolveVersionTarget({ minecraftVersion: "1.20" }),
				"INVALID_ARGUMENT",
			);
		},
	},
	{
		name: "non-integer resource pack version is INVALID_ARGUMENT",
		run: (check) => {
			throwsCode(
				check,
				() => resolveVersionTarget({ resourcePackVersion: "97.1" }),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => resolveVersionTarget({ resourcePackVersion: "abc" }),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => resolveVersionTarget({ resourcePackVersion: "0" }),
				"INVALID_ARGUMENT",
			);
		},
	},
	{
		name: "both version flags together are INVALID_ARGUMENT",
		run: (check) => {
			throwsCode(
				check,
				() =>
					resolveVersionTarget({
						minecraftVersion: "26.3",
						resourcePackVersion: "75",
					}),
				"INVALID_ARGUMENT",
			);
		},
	},
];
