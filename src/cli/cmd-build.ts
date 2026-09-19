import { McAssetError } from "../core/errors.ts";
import { encodePng } from "../io/png.ts";
import { parseMcpx } from "../mcpx/index.ts";
import {
	applyBatchText,
	assertMinecraftOutputPath,
	type CommandResult,
	decodeUtf8,
	defaultLayerFor,
	emitCommandFailure,
	emitCommandSuccess,
	ensureMcpxText,
	readInputText,
	readOperationsText,
	readStdinBytes,
	resolveArtifactTargets,
	resolveInputPath,
	type WarningNote,
	writeArtifactPayloads,
} from "./artifacts.ts";
import { emitArtifact, type OutputStreams, routeStreams } from "./channels.ts";
import { parseProfile } from "./profiles.ts";

export interface BuildOptions {
	output?: string | undefined;
	stdout?: boolean | undefined;
	source?: string | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
	inPlace?: boolean | undefined;
	input?: string | undefined;
	profile?: string | undefined;
	operations?: string | undefined;
	stdin?: boolean | undefined;
}

/**
 * Editable-source entry: parse .mcpx from a file or stdin, run the
 * optional batch, emit PNG bytes and/or the re-serialized source.
 * --in-place rewrites the file input with the new source text.
 */
export async function runBuild(
	source: string | undefined,
	options: BuildOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({
		json: globalJson,
		stdoutArtifact: options.stdout === true,
	});
	try {
		const profile = parseProfile(options.profile);
		const wantsStdin = options.stdin === true;
		const positional =
			source === undefined || source === "" ? undefined : source;
		const inputOpt =
			options.input === undefined || options.input === ""
				? undefined
				: options.input;
		if (wantsStdin && positional !== undefined) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				"build takes either a source path or --stdin, not both.",
			);
		}
		if (wantsStdin && inputOpt !== undefined) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				"--input cannot back --stdin; pass a source path instead.",
			);
		}
		if (wantsStdin && options.operations === "-") {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				"build --stdin and --operations - compete for stdin; move one to a file.",
			);
		}
		const inputPath = wantsStdin
			? undefined
			: resolveInputPath(positional, inputOpt, "build");
		const targets = resolveArtifactTargets({
			command: "build",
			output: options.output,
			stdout: options.stdout,
			source: options.source,
			force: options.force,
			inPlace: options.inPlace,
			inputPath,
		});
		if (options.output !== undefined && options.output !== "") {
			assertMinecraftOutputPath(profile, options.output);
		}
		const mcpxInput = wantsStdin
			? decodeUtf8(await readStdinBytes())
			: await readInputText(inputPath as string, "mcpx source");
		const canvas = parseMcpx(mcpxInput);
		const warnings: WarningNote[] = [];
		let applied = 0;
		let operations: CommandResult["operations"] = [];
		if (options.operations !== undefined && options.operations !== "") {
			const report = applyBatchText(
				canvas,
				await readOperationsText(options.operations),
				defaultLayerFor(canvas),
			);
			applied = report.applied;
			operations = report.operations;
		}
		let pngBytes: Uint8Array | undefined;
		if (targets.pngStdout || targets.pngFiles.length > 0) {
			pngBytes = encodePng(canvas);
		}
		let mcpxText: string | undefined;
		if (targets.mcpxFiles.length > 0) {
			mcpxText = ensureMcpxText(canvas, (warning) => {
				warnings.push({ code: warning.code, message: warning.message });
			});
		}
		if (pngBytes !== undefined && targets.pngStdout) {
			emitArtifact(pngBytes, streams, route);
		}
		await writeArtifactPayloads(
			[
				...(targets.pngFiles.length > 0 && pngBytes !== undefined
					? [{ targets: targets.pngFiles, data: pngBytes }]
					: []),
				...(targets.mcpxFiles.length > 0 && mcpxText !== undefined
					? [{ targets: targets.mcpxFiles, data: mcpxText }]
					: []),
			],
			options.mkdir,
		);
		emitCommandSuccess(streams, route, globalJson, {
			command: "build",
			profile,
			applied,
			operations,
			warnings,
			...(targets.pngFiles[0] !== undefined
				? { output: targets.pngFiles[0].path }
				: {}),
			...(targets.mcpxFiles[0] !== undefined
				? { source: targets.mcpxFiles[0].path }
				: {}),
			...(targets.pngStdout ? { stdout: true as const } : {}),
		});
		return 0;
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}
