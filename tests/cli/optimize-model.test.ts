import { test } from "bun:test";
import { runModel } from "../../src/cli/cmd-model.ts";
import { runOptimize } from "../../src/cli/cmd-optimize.ts";
import {
	type CliResult,
	type CliSurface,
	captureStreams,
	optimizeModelCases,
} from "./optimize-model-cases.ts";

function surface(json: boolean): CliSurface {
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
		model: (mode, input, options) =>
			run((capture) => runModel(mode, input, options, json, capture.streams)),
	};
}

for (const entry of optimizeModelCases) {
	test(entry.name, () => entry.run(surface(true)), 30_000);
}
