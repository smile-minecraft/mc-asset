import { resolveArtifactTargets } from "../../src/cli/artifacts.ts";
import { routeStreams } from "../../src/cli/channels.ts";
import { exitCodeForMcAssetError } from "../../src/cli/exit.ts";
import {
	ERROR_EXIT_CODE,
	type ErrorCode,
	McAssetError,
	resolveExitCode,
} from "../../src/core/errors.ts";
import type { RGBA } from "../../src/core/types.ts";
import { assignSymbols } from "../../src/mcpx/assign.ts";

/** Runner-agnostic assertion surface: bun:test and node:test entries adapt to this. */
export interface CaseCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
	throwsCode(fn: () => unknown, code: string, message?: string): void;
}

export interface ConformanceCase {
	name: string;
	run(check: CaseCheck): void;
}

function distinctOpaque(count: number): RGBA[] {
	const out: RGBA[] = [];
	for (let i = 1; i <= count; i += 1) {
		out.push({ r: i & 255, g: (i >> 8) & 255, b: 0, a: 255 });
	}
	return out;
}

/**
 * Cross-module conformance net (§83/§98/§98.1/§99/§102/§100.4): pure,
 * runner-agnostic checks that every dual entry (bun:test + node:test)
 * executes. Subprocess behavior lives in cli-conformance.test.ts.
 */
export const CONFORMANCE_CASES: ConformanceCase[] = [
	{
		name: "§99: every registered error code resolves to its table exit",
		run: (check) => {
			for (const [code, exit] of Object.entries(ERROR_EXIT_CODE)) {
				const errorCode = code as ErrorCode;
				check.equal(
					resolveExitCode(errorCode),
					exit,
					`resolveExitCode(${code})`,
				);
				check.equal(
					exitCodeForMcAssetError(new McAssetError(errorCode, "probe")),
					exit,
					`exitCodeForMcAssetError(${code})`,
				);
			}
		},
	},
	{
		name: "§99: TRANSACTION_FAILED unwraps to its cause, else general exit",
		run: (check) => {
			check.equal(
				resolveExitCode("TRANSACTION_FAILED"),
				1,
				"no cause falls back to general exit",
			);
			check.equal(
				resolveExitCode("TRANSACTION_FAILED", "OUTPUT_EXISTS"),
				4,
				"cause decides the exit",
			);
			const wrapped = new McAssetError("TRANSACTION_FAILED", "rollback", {
				cause: "OUTPUT_EXISTS",
			});
			check.equal(
				exitCodeForMcAssetError(wrapped),
				4,
				"CLI unwraps the rollback cause",
			);
			const bare = new McAssetError("TRANSACTION_FAILED", "rollback");
			check.equal(exitCodeForMcAssetError(bare), 1, "bare rollback is exit 1");
		},
	},
	{
		name: "§98.1: channel routing table across the four flag combinations",
		run: (check) => {
			check.deepEqual(
				routeStreams({ json: false, stdoutArtifact: false }),
				{ artifact: null, envelope: "stdout", log: "stdout" },
				"default human output shares stdout",
			);
			check.deepEqual(
				routeStreams({ json: true, stdoutArtifact: false }),
				{ artifact: null, envelope: "stdout", log: "stderr" },
				"--json keeps the envelope on stdout, logs on stderr",
			);
			check.deepEqual(
				routeStreams({ json: false, stdoutArtifact: true }),
				{ artifact: "stdout", envelope: "stderr", log: "stderr" },
				"--stdout gives artifact bytes sole ownership of stdout",
			);
			check.deepEqual(
				routeStreams({ json: true, stdoutArtifact: true }),
				{ artifact: "stdout", envelope: "stderr", log: "stderr" },
				"--json --stdout moves the envelope to stderr",
			);
		},
	},
	{
		name: "overflow details carry the actual color count and the limit",
		run: (check) => {
			try {
				assignSymbols([], distinctOpaque(63), { mode: "compact" });
			} catch (error) {
				if (
					error instanceof McAssetError &&
					error.code === "MCPX_PALETTE_OVERFLOW"
				) {
					const details = error.details as
						| { colorCount?: unknown; limit?: unknown }
						| undefined;
					check.equal(details?.colorCount, 63, "actual color count");
					check.equal(details?.limit, 62, "compact opaque limit");
					return;
				}
				check.fail(
					`expected MCPX_PALETTE_OVERFLOW but got ${error instanceof McAssetError ? error.code : String(error)}`,
				);
			}
			check.fail("expected MCPX_PALETTE_OVERFLOW but nothing was thrown");
		},
	},
	{
		name: "one new color appends one symbol; existing assignments never move",
		run: (check) => {
			const red = { r: 255, g: 0, b: 0, a: 255 };
			const blue = { r: 0, g: 0, b: 255, a: 255 };
			const existing = [{ id: "X", color: { ...red } }];
			const assigned = assignSymbols(existing, [red, blue]);
			check.equal(assigned.length, 2, "exactly one symbol appended");
			check.deepEqual(assigned[0], existing[0], "existing entry verbatim");
			const fresh = assigned[1] as { id: string };
			check.ok(
				typeof fresh.id === "string" &&
					fresh.id.length === 1 &&
					fresh.id !== "X",
				"new color takes a fresh single symbol",
			);
		},
	},
	{
		name: "§83: --source alone is a legal target; no target is OUTPUT_REQUIRED",
		run: (check) => {
			const sourceOnly = resolveArtifactTargets({
				command: "import",
				source: "vector.mcpx",
			});
			check.equal(sourceOnly.pngFiles.length, 0, "no PNG target");
			check.equal(sourceOnly.pngStdout, false, "no stdout bytes");
			check.equal(sourceOnly.mcpxFiles.length, 1, "one .mcpx target");
			check.throwsCode(
				() => resolveArtifactTargets({ command: "build" }),
				"OUTPUT_REQUIRED",
				"missing every output",
			);
		},
	},
	{
		name: "§98.2: --in-place routes to the input with force; --force conflicts",
		run: (check) => {
			const buildInPlace = resolveArtifactTargets({
				command: "build",
				inPlace: true,
				inputPath: "sword.mcpx",
			});
			check.equal(buildInPlace.mcpxFiles.length, 1, "build rewrites the .mcpx");
			check.equal(
				(buildInPlace.mcpxFiles[0] as { force: boolean }).force,
				true,
				"in-place implies force for that target",
			);
			const importInPlace = resolveArtifactTargets({
				command: "import",
				inPlace: true,
				inputPath: "sprite.png",
			});
			check.equal(
				importInPlace.pngFiles.length,
				1,
				"import rewrites the input PNG",
			);
			check.throwsCode(
				() =>
					resolveArtifactTargets({
						command: "build",
						inPlace: true,
						force: true,
						inputPath: "sword.mcpx",
					}),
				"ARGUMENT_CONFLICT",
				"--force with --in-place",
			);
		},
	},
];
