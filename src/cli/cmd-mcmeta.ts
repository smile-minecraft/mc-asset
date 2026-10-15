import { McAssetError } from "../core/errors.ts";
import {
	parseBorderOption,
	parseFramesOption,
	parsePositiveIntOption,
} from "../core/mcmeta-generate.ts";
import { emitCommandFailure, resolveInputPath } from "./artifacts.ts";
import {
	emitArtifact,
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { successEnvelope } from "./envelope.ts";
import {
	type McmetaRequest,
	planMcmetaOutput,
	prepareMcmeta,
	writeMcmetaOutput,
} from "./mcmeta-request.ts";

export type McmetaMode = "animation" | "gui";

export interface McmetaCliOptions {
	frameSize?: string | undefined;
	frametime?: string | undefined;
	frames?: string | undefined;
	interpolate?: boolean | undefined;
	type?: string | undefined;
	border?: string | undefined;
	stretchInner?: boolean | undefined;
	minecraftVersion?: string | undefined;
	resourcePackVersion?: string | undefined;
	output?: string | undefined;
	stdout?: boolean | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
}

function toRequest(
	mode: McmetaMode,
	inputPath: string,
	options: McmetaCliOptions,
): McmetaRequest {
	return {
		mode,
		inputPath,
		frameSize: options.frameSize,
		frametime:
			options.frametime === undefined
				? undefined
				: parsePositiveIntOption(options.frametime, "--frametime"),
		frames:
			options.frames === undefined
				? undefined
				: parseFramesOption(options.frames),
		interpolate: options.interpolate,
		type: options.type,
		border:
			options.border === undefined
				? undefined
				: parseBorderOption(options.border),
		stretchInner: options.stretchInner,
		minecraftVersion: options.minecraftVersion,
		resourcePackVersion: options.resourcePackVersion,
	};
}

/**
 * `mcmeta animation|gui <png>`: generate one `.mcmeta` document from a PNG.
 * Exactly one of --output (explicit `.mcmeta` path) or --stdout is
 * required; a sibling name is never guessed and an existing `.mcmeta` is
 * never merged. An existing --output is OUTPUT_EXISTS unless --force, which
 * replaces the whole file. The PNG is only read. Every refusal happens
 * before the first stdout byte or file byte.
 */
export async function runMcmeta(
	mode: McmetaMode,
	input: string | undefined,
	options: McmetaCliOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({
		json: globalJson,
		stdoutArtifact: options.stdout === true,
	});
	try {
		const output =
			options.output === undefined || options.output === ""
				? undefined
				: options.output;
		if (output !== undefined && options.stdout === true) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				"--output and --stdout cannot be combined; pass one.",
			);
		}
		if (output === undefined && options.stdout !== true) {
			throw new McAssetError(
				"OUTPUT_REQUIRED",
				"One of --output or --stdout is required.",
			);
		}
		const inputPath = resolveInputPath(input, undefined, `mcmeta ${mode}`);
		const request = toRequest(mode, inputPath, options);
		const prepared = await prepareMcmeta(request);
		const plan =
			output === undefined
				? undefined
				: await planMcmetaOutput({
						output,
						inputPath,
						force: options.force === true,
						mkdir: options.mkdir === true,
					});
		if (options.stdout === true) {
			emitArtifact(new TextEncoder().encode(prepared.text), streams, route);
		}
		if (plan !== undefined) {
			await writeMcmetaOutput(plan, prepared.text, options.mkdir === true);
		}
		const result = {
			command: "mcmeta",
			mode,
			width: prepared.sheetWidth,
			height: prepared.sheetHeight,
			versionChecked: prepared.versionChecked,
			version: prepared.version,
			target: prepared.target,
			warnings: prepared.warnings,
			...(output !== undefined ? { output } : { stdout: true as const }),
		};
		if (globalJson) {
			emitEnvelope(successEnvelope(result), streams, route);
		} else {
			emitLog(
				`ok mcmeta mode=${mode}${output !== undefined ? ` output=${output}` : " stdout=true"}`,
				streams,
				route,
			);
			for (const warning of prepared.warnings) {
				emitLog(`warning [${warning.code}] ${warning.message}`, streams, route);
			}
		}
		return 0;
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}
