import process from "node:process";
import { realStreams, runCli } from "./program.ts";

/** CLI entry: `bun src/cli/index.ts`. Commander owns --help/--version. */
const code = await runCli(process.argv, realStreams());
if (code !== 0) {
	process.exitCode = code;
}
