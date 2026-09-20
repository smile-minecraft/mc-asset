import { type RouteFlags, routeStreams } from "../../src/cli/channels.ts";
import { errorEnvelope, successEnvelope } from "../../src/cli/envelope.ts";
import { exitCodeForMcAssetError } from "../../src/cli/exit.ts";
import { resolveOutputTarget } from "../../src/cli/output-guard.ts";
import { parseProfile, SUPPORTED_PROFILES } from "../../src/cli/profiles.ts";
import type { ErrorCode } from "../../src/core/errors.ts";
import { McAssetError } from "../../src/core/errors.ts";

/** Runner-agnostic assertion surface: bun:test and node:test entries adapt to this. */
export interface CaseCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
	throwsCode(fn: () => unknown, code: string, message?: string): void;
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

export interface CliCase {
	name: string;
	run(check: CaseCheck): void;
}

export const CLI_CASES: CliCase[] = [
	{
		name: "success envelope shape matches section 60",
		run: (check) => {
			const envelope = successEnvelope({ applied: 1 });
			check.deepEqual(
				envelope,
				{ success: true, result: { applied: 1 } },
				"success envelope",
			);
		},
	},
	{
		name: "error envelope shape matches section 60",
		run: (check) => {
			const envelope = errorEnvelope(
				"OUT_OF_BOUNDS",
				"Pixel coordinate is outside canvas.",
				{
					x: 18,
					y: 4,
					width: 16,
					height: 16,
				},
			);
			check.deepEqual(
				envelope,
				{
					success: false,
					error: {
						code: "OUT_OF_BOUNDS",
						message: "Pixel coordinate is outside canvas.",
						details: { x: 18, y: 4, width: 16, height: 16 },
					},
				},
				"error envelope",
			);
		},
	},
	{
		name: "error envelope carries batch rollback result per section 103",
		run: (check) => {
			const envelope = errorEnvelope(
				"OUT_OF_BOUNDS",
				"Pixel coordinate is outside canvas.",
				{ operationIndex: 2, operationId: "guard" },
				{ applied: 0, rolledBack: true },
			);
			check.deepEqual(
				envelope,
				{
					success: false,
					error: {
						code: "OUT_OF_BOUNDS",
						message: "Pixel coordinate is outside canvas.",
						details: { operationIndex: 2, operationId: "guard" },
					},
					result: { applied: 0, rolledBack: true },
				},
				"batch failure envelope",
			);
		},
	},
	{
		name: "missing --output/--stdout/--in-place is OUTPUT_REQUIRED",
		run: (check) => {
			throwsCode(check, () => resolveOutputTarget({}), "OUTPUT_REQUIRED");
			throwsCode(
				check,
				() => resolveOutputTarget({ force: true }),
				"OUTPUT_REQUIRED",
			);
		},
	},
	{
		name: "--force with --in-place is ARGUMENT_CONFLICT",
		run: (check) => {
			throwsCode(
				check,
				() =>
					resolveOutputTarget({
						inPlace: true,
						input: "sword.png",
						force: true,
					}),
				"ARGUMENT_CONFLICT",
			);
		},
	},
	{
		name: "--in-place resolves output to the input path",
		run: (check) => {
			const resolved = resolveOutputTarget({
				inPlace: true,
				input: "sword.png",
			});
			check.deepEqual(
				resolved,
				{ mode: "file", path: "sword.png" },
				"in-place targets input",
			);
		},
	},
	{
		name: "--in-place without input is INVALID_ARGUMENT",
		run: (check) => {
			throwsCode(
				check,
				() => resolveOutputTarget({ inPlace: true }),
				"INVALID_ARGUMENT",
			);
		},
	},
	{
		name: "explicit --output resolves to file mode",
		run: (check) => {
			const resolved = resolveOutputTarget({ output: "out/sword.png" });
			check.deepEqual(
				resolved,
				{ mode: "file", path: "out/sword.png" },
				"file target",
			);
		},
	},
	{
		name: "--stdout resolves to stdout mode",
		run: (check) => {
			const resolved = resolveOutputTarget({ stdout: true });
			check.deepEqual(resolved, { mode: "stdout" }, "stdout target");
		},
	},
	{
		name: "channel routing follows the section 98.1 table",
		run: (check) => {
			const cases: Array<{
				flags: RouteFlags;
				expected: { artifact: unknown; envelope: unknown; log: unknown };
			}> = [
				{
					flags: { json: false, stdoutArtifact: false },
					expected: { artifact: null, envelope: "stdout", log: "stdout" },
				},
				{
					flags: { json: true, stdoutArtifact: false },
					expected: { artifact: null, envelope: "stdout", log: "stderr" },
				},
				{
					flags: { json: false, stdoutArtifact: true },
					expected: { artifact: "stdout", envelope: "stderr", log: "stderr" },
				},
				{
					flags: { json: true, stdoutArtifact: true },
					expected: { artifact: "stdout", envelope: "stderr", log: "stderr" },
				},
			];
			for (const entry of cases) {
				check.deepEqual(
					routeStreams(entry.flags),
					entry.expected,
					`route json=${entry.flags.json} stdout=${entry.flags.stdoutArtifact}`,
				);
			}
		},
	},
	{
		name: "exit wiring consumes the section 99 table without a local copy",
		run: (check) => {
			const samples: Array<[ErrorCode, number]> = [
				["OUTPUT_REQUIRED", 2],
				["ARGUMENT_CONFLICT", 2],
				["INVALID_PROFILE", 2],
				["VALIDATION_FAILED", 3],
				["OUTPUT_EXISTS", 4],
				["FILESYSTEM_ERROR", 4],
				["MCPX_UNSUPPORTED_VERSION", 5],
				["INTERNAL_ERROR", 1],
			];
			for (const [code, exit] of samples) {
				check.equal(
					exitCodeForMcAssetError(new McAssetError(code, "probe")),
					exit,
					`exit for ${code}`,
				);
			}
			check.equal(
				exitCodeForMcAssetError(
					new McAssetError("TRANSACTION_FAILED", "rollback", {
						cause: "OUT_OF_BOUNDS",
					}),
				),
				2,
				"transaction unwraps to cause",
			);
		},
	},
	{
		name: "profiles cover generic plus the four minecraft asset profiles",
		run: (check) => {
			check.deepEqual(
				[...SUPPORTED_PROFILES],
				[
					"generic",
					"minecraft:item",
					"minecraft:block",
					"minecraft:gui",
					"minecraft:particle",
				],
				"supported profiles",
			);
			check.equal(parseProfile(undefined), "generic", "default profile");
			check.equal(
				parseProfile("minecraft:item"),
				"minecraft:item",
				"item profile",
			);
			check.equal(
				parseProfile("minecraft:gui"),
				"minecraft:gui",
				"gui profile",
			);
			check.equal(
				parseProfile("minecraft:particle"),
				"minecraft:particle",
				"particle profile",
			);
			throwsCode(check, () => parseProfile("photo"), "INVALID_PROFILE");
		},
	},
];
