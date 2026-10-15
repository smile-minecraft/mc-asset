import { test } from "bun:test";
import { runQuantize } from "../../src/cli/cmd-quantize.ts";
import {
	captureQuantizeStreams,
	QUANTIZE_PALETTE_CLI_CASES,
	QUANTIZE_PALETTE_MCP_CASES,
} from "./quantize-palette-cases.ts";

const surface = {
	quantize: async (
		input: string | undefined,
		options: Parameters<typeof runQuantize>[1],
	) => {
		const capture = captureQuantizeStreams();
		const code = await runQuantize(input, options, true, capture.streams);
		return {
			code,
			raw: capture.stdout(),
			stderr: capture.stderrText(),
		};
	},
};

for (const entry of QUANTIZE_PALETTE_CLI_CASES) {
	test(entry.name, () => entry.run(surface), 30_000);
}

for (const entry of QUANTIZE_PALETTE_MCP_CASES) {
	test(entry.name, entry.run, 30_000);
}
