import { test } from "node:test";
import { runOptimize } from "../../src/cli/cmd-optimize.ts";
import {
	type OptimizeDirSurface,
	optimizeDirCases,
} from "./optimize-dir-cases.ts";
import { type CliResult, captureStreams } from "./optimize-model-cases.ts";

function surface(json: boolean): OptimizeDirSurface {
	const run = async (
		invoke: (streams: ReturnType<typeof captureStreams>) => Promise<number>,
	): Promise<CliResult> => {
		const capture = captureStreams();
		const code = await invoke(capture);
		return {
			code,
			raw: capture.stdout(),
			stderr: capture.stderrText(),
		};
	};
	return {
		optimize: (inputs, options) =>
			run((capture) => runOptimize(inputs, options, json, capture.streams)),
	};
}

for (const entry of optimizeDirCases) {
	test(entry.name, async () => {
		await entry.run(surface(true));
	});
}
