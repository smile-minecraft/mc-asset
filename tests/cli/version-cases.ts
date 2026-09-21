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

const VERSION_BAND_MARKERS = ["1.19.3", "through", "26.3"];

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
		name: "--minecraft-version 1.21.11 maps to resource-pack 75.0",
		run: (check) => {
			const resolved = resolveVersionTarget({
				minecraftVersion: "1.21.11",
			});
			check.equal(resolved.packFormat, "75.0", "packFormat 75.0");
			check.equal(
				resolved.minecraftVersion,
				"1.21.11",
				"echo minecraft version",
			);
			check.equal(
				resolved.resourcePackVersion,
				"75.0",
				"echo dotted resource pack version",
			);
		},
	},
	{
		name: "--minecraft-version 26.1 group maps to resource-pack 84.0",
		run: (check) => {
			for (const version of ["26.1", "26.1.1", "26.1.2"]) {
				const resolved = resolveVersionTarget({ minecraftVersion: version });
				check.equal(
					resolved.packFormat,
					"84.0",
					`packFormat 84.0 for ${version}`,
				);
				check.equal(
					resolved.resourcePackVersion,
					"84.0",
					`echo resource pack version for ${version}`,
				);
			}
		},
	},
	{
		name: "--minecraft-version 26.2 maps to resource-pack 88.0",
		run: (check) => {
			const resolved = resolveVersionTarget({ minecraftVersion: "26.2" });
			check.equal(resolved.packFormat, "88.0", "packFormat 88.0");
			check.equal(
				resolved.resourcePackVersion,
				"88.0",
				"echo dotted resource pack version",
			);
		},
	},
	{
		name: "--minecraft-version 26.3 maps to resource-pack 97.1",
		run: (check) => {
			const resolved = resolveVersionTarget({ minecraftVersion: "26.3" });
			check.equal(resolved.packFormat, "97.1", "packFormat 97.1");
			check.equal(resolved.minecraftVersion, "26.3", "echo minecraft version");
			check.equal(
				resolved.resourcePackVersion,
				"97.1",
				"echo resource pack version per section 95",
			);
		},
	},
	{
		name: "--resource-pack-version N normalizes to N.0",
		run: (check) => {
			const resolved = resolveVersionTarget({ resourcePackVersion: "75" });
			check.equal(resolved.packFormat, "75.0", "packFormat 75.0");
			check.equal(
				resolved.resourcePackVersion,
				"75.0",
				"echo normalized resource pack version",
			);
			check.equal(
				resolved.minecraftVersion,
				undefined,
				"no minecraft version derived",
			);
		},
	},
	{
		name: "--resource-pack-version N.M stays as-is",
		run: (check) => {
			const resolved = resolveVersionTarget({ resourcePackVersion: "97.1" });
			check.equal(resolved.packFormat, "97.1", "packFormat 97.1");
			check.equal(
				resolved.resourcePackVersion,
				"97.1",
				"echo dotted resource pack version",
			);
		},
	},
	{
		name: "every supported release version maps to its resource-pack format",
		run: (check) => {
			const expected: ReadonlyArray<readonly [string, string]> = [
				["1.19.3", "12.0"],
				["1.19.4", "13.0"],
				["1.20", "15.0"],
				["1.20.1", "15.0"],
				["1.20.2", "18.0"],
				["1.20.3", "22.0"],
				["1.20.4", "22.0"],
				["1.20.5", "32.0"],
				["1.20.6", "32.0"],
				["1.21", "34.0"],
				["1.21.1", "34.0"],
				["1.21.2", "42.0"],
				["1.21.3", "42.0"],
				["1.21.4", "46.0"],
				["1.21.5", "55.0"],
				["1.21.6", "63.0"],
				["1.21.7", "64.0"],
				["1.21.8", "64.0"],
				["1.21.9", "69.0"],
				["1.21.10", "69.0"],
				["1.21.11", "75.0"],
				["26.1", "84.0"],
				["26.1.1", "84.0"],
				["26.1.2", "84.0"],
				["26.2", "88.0"],
				["26.3", "97.1"],
			];
			check.equal(expected.length, 26, "twenty-six supported releases");
			for (const [version, packFormat] of expected) {
				const resolved = resolveVersionTarget({
					minecraftVersion: version,
				});
				check.equal(
					resolved.packFormat,
					packFormat,
					`packFormat ${packFormat} for ${version}`,
				);
				check.equal(
					resolved.minecraftVersion,
					version,
					`echo minecraft version for ${version}`,
				);
				check.equal(
					resolved.resourcePackVersion,
					packFormat,
					`echo dotted resource pack version for ${version}`,
				);
			}
		},
	},
	{
		name: "unknown minecraft version is INVALID_ARGUMENT with the release band",
		run: (check) => {
			throwsCode(
				check,
				() => resolveVersionTarget({ minecraftVersion: "99.99" }),
				"INVALID_ARGUMENT",
			);
			throwsCode(
				check,
				() => resolveVersionTarget({ minecraftVersion: "26.4" }),
				"INVALID_ARGUMENT",
			);
			try {
				resolveVersionTarget({ minecraftVersion: "26.4" });
				check.fail("expected INVALID_ARGUMENT for 26.4");
			} catch (error) {
				for (const marker of VERSION_BAND_MARKERS) {
					check.ok(
						error instanceof McAssetError && error.message.includes(marker),
						`error message names the release band (${marker})`,
					);
				}
			}
		},
	},
	{
		name: "malformed resource pack version is INVALID_ARGUMENT",
		run: (check) => {
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
			throwsCode(
				check,
				() => resolveVersionTarget({ resourcePackVersion: "1." }),
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
