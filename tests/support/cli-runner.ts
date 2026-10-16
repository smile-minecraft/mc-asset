import { Readable } from "node:stream";
import type { OutputStreams } from "../../src/cli/channels.ts";
import { runCli } from "../../src/cli/program.ts";

/**
 * In-process CLI runner for behavior tests.
 *
 * Most write commands send their output through the real process streams
 * instead of the injected ones, so each call captures both: the injected
 * memory sinks and the writes to `process.stdout`/`process.stderr`. The two
 * collectors share one buffer per channel, keeping the original order.
 * `process.exitCode` and `process.stdin` are saved before the call and
 * restored after, so consecutive calls cannot leak state into each other.
 * Calls run one after another because the captured process state is global.
 */

/** Same shape as the spawned-CLI helpers used across the CLI tests. */
export interface CliResult {
	/** Process exit code the spawned CLI would report. */
	code: number;
	/** Raw bytes written to stdout; binary artifacts stay byte-exact. */
	stdout: Uint8Array;
	/** Text written to stderr. */
	stderr: string;
}

export interface InProcessCliOptions {
	/**
	 * Bytes fed to commands that read standard input. When omitted the
	 * command sees end-of-file, matching a spawned run with ignored stdin.
	 */
	stdin?: Uint8Array | undefined;
}

function chunkBytes(chunk: string | Uint8Array): Uint8Array {
	if (typeof chunk === "string") {
		return new TextEncoder().encode(chunk);
	}
	return chunk;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const part of parts) {
		total += part.length;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

/** Queue tail: every call starts after the previous one fully restored state. */
let queueTail: Promise<void> = Promise.resolve();

export function runCliInProcess(
	args: readonly string[],
	options: InProcessCliOptions = {},
): Promise<CliResult> {
	const run = queueTail.then(() => invoke(args, options));
	queueTail = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

async function invoke(
	args: readonly string[],
	options: InProcessCliOptions,
): Promise<CliResult> {
	const stdoutChunks: Uint8Array[] = [];
	const stderrChunks: Uint8Array[] = [];
	const streams: OutputStreams = {
		stdout: {
			write(chunk: string | Uint8Array): boolean {
				stdoutChunks.push(chunkBytes(chunk));
				return true;
			},
		},
		stderr: {
			write(chunk: string | Uint8Array): boolean {
				stderrChunks.push(chunkBytes(chunk));
				return true;
			},
		},
	};
	const savedExitCode = process.exitCode;
	const stdoutTarget = process.stdout as unknown as {
		write: (...args: unknown[]) => unknown;
	};
	const stderrTarget = process.stderr as unknown as {
		write: (...args: unknown[]) => unknown;
	};
	const savedStdoutWrite = stdoutTarget.write;
	const savedStderrWrite = stderrTarget.write;
	const processWithStdin = process as unknown as { stdin: unknown };
	const savedStdin = processWithStdin.stdin;
	stdoutTarget.write = (chunk: unknown) => {
		stdoutChunks.push(chunkBytes(chunk as string | Uint8Array));
		return true;
	};
	stderrTarget.write = (chunk: unknown) => {
		stderrChunks.push(chunkBytes(chunk as string | Uint8Array));
		return true;
	};
	process.exitCode = undefined;
	processWithStdin.stdin = Readable.from(
		options.stdin === undefined ? [] : [options.stdin],
	);
	try {
		const code = await runCli(["node", "mc-asset", ...args], streams);
		return {
			code,
			stdout: concatBytes(stdoutChunks),
			stderr: new TextDecoder().decode(concatBytes(stderrChunks)),
		};
	} finally {
		stdoutTarget.write = savedStdoutWrite;
		stderrTarget.write = savedStderrWrite;
		processWithStdin.stdin = savedStdin;
		process.exitCode = savedExitCode;
	}
}
