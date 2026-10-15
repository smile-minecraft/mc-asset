import assert from "node:assert/strict";
import { mcmetaVersionStatus } from "../../src/cli/mcmeta-version.ts";
import {
	resolveVersionTarget,
	SUPPORTED_MINECRAFT_VERSIONS,
} from "../../src/cli/version-options.ts";
import { McAssetError } from "../../src/core/errors.ts";
import {
	type GenerateAnimationInput,
	type GenerateGuiInput,
	generateAnimationMcmeta,
	generateGuiMcmeta,
} from "../../src/core/mcmeta-generate.ts";
import {
	GUI_SCALING_FACT,
	isPackFormatInKnownRange,
	KNOWN_PACK_FORMAT_RANGE,
} from "../../src/profiles/versions.ts";

function rejectsWith(code: string, run: () => unknown): void {
	assert.throws(run, (error: unknown) => {
		assert.ok(error instanceof McAssetError);
		assert.equal(error.code, code);
		return true;
	});
}
function animation({
	packFormat,
	...input
}: Partial<GenerateAnimationInput> & { packFormat?: string } = {}) {
	return {
		...generateAnimationMcmeta({
			sheetWidth: 16,
			sheetHeight: 64,
			frameSize: "16",
			...input,
		}),
		...mcmetaVersionStatus(packFormat, { mode: "animation" }),
	};
}
function gui(
	type: string,
	{
		packFormat,
		...input
	}: Partial<GenerateGuiInput> & { packFormat?: string } = {},
) {
	return {
		...generateGuiMcmeta({ sheetWidth: 16, sheetHeight: 16, type, ...input }),
		...mcmetaVersionStatus(packFormat, {
			mode: "gui",
			type,
			stretchInner: input.stretchInner,
		}),
	};
}
export const MCMETA_VERSION_CASES: { name: string; run(): void }[] = [
	{
		name: "version: no target reports versionChecked false with a warning",
		run() {
			for (const generated of [animation(), gui("stretch")]) {
				assert.equal(generated.versionChecked, false);
				assert.deepEqual(
					generated.warnings.map((warning) => warning.code),
					["VERSION_NOT_CHECKED"],
				);
			}
		},
	},
	{
		name: "version: an explicit target reports versionChecked true and no warning",
		run() {
			const generated = animation({ packFormat: "46.0" });
			assert.equal(generated.versionChecked, true);
			assert.deepEqual(generated.warnings, []);
		},
	},
	{
		name: "version: stretch_inner before pack format 42.0 is refused, at 42.0 it is written",
		run() {
			const request = {
				border: 2,
				stretchInner: true,
			};
			rejectsWith("ARGUMENT_CONFLICT", () =>
				gui("nine_slice", { ...request, packFormat: "34.0" }),
			);
			rejectsWith("ARGUMENT_CONFLICT", () =>
				gui("nine_slice", { ...request, packFormat: "41.9" }),
			);
			assert.equal(
				gui("nine_slice", { ...request, packFormat: "42.0" }).versionChecked,
				true,
			);
			assert.ok(
				gui("nine_slice", { ...request, packFormat: "42.0" }).text.includes(
					'"stretch_inner":true',
				),
			);
			assert.ok(
				gui("nine_slice", { ...request }).text.includes('"stretch_inner":true'),
			);
		},
	},
	{
		name: "version: an old target does not block output that needs no gated feature",
		run() {
			assert.equal(
				gui("nine_slice", { border: 2, packFormat: "34.0" }).versionChecked,
				true,
			);
		},
	},
	{
		name: "version fact: gui.scaling starts at pack format 16.0 with a traceable source",
		run() {
			assert.equal(GUI_SCALING_FACT.since.packFormat, "16.0");
			assert.equal(GUI_SCALING_FACT.status, "verified");
			assert.ok(GUI_SCALING_FACT.source.includes("23w31a"));
			assert.ok(GUI_SCALING_FACT.source.includes("https://www.minecraft.net/"));
		},
	},
	{
		name: "version fact: the known range equals the first and last release in the table",
		run() {
			const first = resolveVersionTarget({
				minecraftVersion: SUPPORTED_MINECRAFT_VERSIONS[0],
			});
			const last = resolveVersionTarget({
				minecraftVersion:
					SUPPORTED_MINECRAFT_VERSIONS[SUPPORTED_MINECRAFT_VERSIONS.length - 1],
			});
			assert.equal(KNOWN_PACK_FORMAT_RANGE.min, first.packFormat);
			assert.equal(KNOWN_PACK_FORMAT_RANGE.max, last.packFormat);
			assert.equal(isPackFormatInKnownRange("12.0"), true);
			assert.equal(isPackFormatInKnownRange("97.1"), true);
			assert.equal(isPackFormatInKnownRange("11.9"), false);
			assert.equal(isPackFormatInKnownRange("97.2"), false);
		},
	},
	{
		name: "version: every gui type is written at the first pack format that has gui.scaling",
		run() {
			for (const [type, overrides] of [
				["stretch", {}],
				["tile", {}],
				["nine_slice", { border: 4 }],
			] as const) {
				const generated = gui(type, { ...overrides, packFormat: "16.0" });
				assert.equal(generated.versionChecked, true, type);
				assert.deepEqual(generated.warnings, [], type);
				assert.ok(generated.text.includes(`"type":"${type}"`), type);
			}
		},
	},
	{
		name: "version: every gui type is refused before pack format 16.0, below the table too",
		run() {
			for (const packFormat of ["15.0", "12.0", "5.0"]) {
				for (const [type, overrides] of [
					["stretch", {}],
					["tile", {}],
					["nine_slice", { border: 4 }],
				] as const) {
					rejectsWith("ARGUMENT_CONFLICT", () =>
						gui(type, { ...overrides, packFormat }),
					);
				}
			}
		},
	},
	{
		name: "version: stretch_inner has its own 42.0 boundary above the gui.scaling one",
		run() {
			const request = { border: 4, stretchInner: true };
			rejectsWith("ARGUMENT_CONFLICT", () =>
				gui("nine_slice", { ...request, packFormat: "16.0" }),
			);
			rejectsWith("ARGUMENT_CONFLICT", () =>
				gui("nine_slice", { ...request, packFormat: "41.9" }),
			);
			assert.equal(
				gui("nine_slice", { ...request, packFormat: "42.0" }).versionChecked,
				true,
			);
		},
	},
	{
		name: "version: argument errors still win over the version refusal",
		run() {
			rejectsWith("INVALID_ARGUMENT", () =>
				gui("nine_slice", { packFormat: "15.0" }),
			);
			rejectsWith("INVALID_ARGUMENT", () =>
				gui("repeat", { packFormat: "15.0" }),
			);
		},
	},
	{
		name: "version: animation is checked across the whole release table",
		run() {
			for (const packFormat of ["12.0", "15.0", "46.0", "97.1"]) {
				const generated = animation({ packFormat });
				assert.equal(generated.versionChecked, true, packFormat);
				assert.deepEqual(generated.warnings, [], packFormat);
				assert.ok(generated.text.startsWith('{"animation":'), packFormat);
			}
		},
	},
	{
		name: "version: a target outside the release table is not called checked",
		run() {
			for (const generated of [
				animation({ packFormat: "5.0" }),
				animation({ packFormat: "999.0" }),
				gui("stretch", { packFormat: "999.0" }),
				gui("nine_slice", {
					border: 4,
					stretchInner: true,
					packFormat: "999.0",
				}),
			]) {
				assert.equal(generated.versionChecked, false);
				assert.deepEqual(
					generated.warnings.map((warning) => warning.code),
					["VERSION_NOT_CHECKED"],
				);
				assert.notEqual(generated.text, "{}\n");
			}
		},
	},
];
