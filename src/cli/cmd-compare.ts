import { McAssetError } from "../core/errors.ts";
import { emitCommandFailure } from "./artifacts.ts";
import {
	emitArtifact,
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { prepareCompare, writeCompare } from "./compare-request.ts";
import { successEnvelope } from "./envelope.ts";

export interface CompareCliOptions {
	output?: string;
	stdout?: boolean;
	scale?: string;
	force?: boolean;
	mkdir?: boolean;
}
export async function runCompare(
	beforePath: string,
	afterPath: string,
	options: CompareCliOptions,
	json: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({ json, stdoutArtifact: options.stdout === true });
	try {
		if (options.output !== undefined && options.stdout) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				"--output and --stdout cannot be combined.",
			);
		}
		const args = {
			beforePath,
			afterPath,
			image:
				options.output !== undefined || options.stdout
					? ("diff" as const)
					: ("none" as const),
			scale: options.scale === undefined ? 1 : Number(options.scale),
			...(options.output === undefined ? {} : { outputPath: options.output }),
			force: options.force === true,
			mkdir: options.mkdir === true,
		};
		const prepared = await prepareCompare(args);
		await writeCompare(args, prepared);
		if (options.stdout && prepared.png !== undefined)
			emitArtifact(prepared.png, streams, route);
		if (json) emitEnvelope(successEnvelope(prepared.report), streams, route);
		else emitLog(JSON.stringify(prepared.report), streams, route);
		return 0;
	} catch (error) {
		return emitCommandFailure(streams, route, json, error);
	}
}
