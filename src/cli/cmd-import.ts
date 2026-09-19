import { decodePng, encodePng } from "../io/png.ts";
import {
	applyBatchText,
	assertMinecraftOutputPath,
	type CommandResult,
	defaultLayerFor,
	emitCommandFailure,
	emitCommandSuccess,
	ensureMcpxText,
	readInputFile,
	readOperationsText,
	resolveArtifactTargets,
	resolveInputPath,
	type WarningNote,
	writeFileTargets,
} from "./artifacts.ts";
import { emitArtifact, type OutputStreams, routeStreams } from "./channels.ts";
import { parseProfile } from "./profiles.ts";

export interface ImportOptions {
	output?: string | undefined;
	stdout?: boolean | undefined;
	source?: string | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
	inPlace?: boolean | undefined;
	input?: string | undefined;
	profile?: string | undefined;
	operations?: string | undefined;
}

/**
 * Binary raster entry: decode PNG, run the optional batch, emit PNG bytes
 * and/or the assigned .mcpx source. The input file is only read, never
 * written, unless --in-place names it back as the PNG target.
 */
export async function runImport(
	image: string | undefined,
	options: ImportOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({
		json: globalJson,
		stdoutArtifact: options.stdout === true,
	});
	try {
		const profile = parseProfile(options.profile);
		const inputPath = resolveInputPath(image, options.input, "import");
		const targets = resolveArtifactTargets({
			command: "import",
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
		const decoded = decodePng(await readInputFile(inputPath, "image"));
		const warnings: WarningNote[] = decoded.warnings.map((warning) => ({
			code: warning.code,
			message: warning.message,
		}));
		let applied = 0;
		let operations: CommandResult["operations"] = [];
		if (options.operations !== undefined && options.operations !== "") {
			const report = applyBatchText(
				decoded.canvas,
				await readOperationsText(options.operations),
				defaultLayerFor(decoded.canvas),
			);
			applied = report.applied;
			operations = report.operations;
		}
		let pngBytes: Uint8Array | undefined;
		if (targets.pngStdout || targets.pngFiles.length > 0) {
			pngBytes = encodePng(decoded.canvas);
		}
		let mcpxText: string | undefined;
		if (targets.mcpxFiles.length > 0) {
			mcpxText = ensureMcpxText(decoded.canvas, (warning) => {
				warnings.push({ code: warning.code, message: warning.message });
			});
		}
		if (pngBytes !== undefined && targets.pngStdout) {
			emitArtifact(pngBytes, streams, route);
		}
		if (pngBytes !== undefined) {
			await writeFileTargets(targets.pngFiles, pngBytes, options.mkdir);
		}
		if (mcpxText !== undefined) {
			await writeFileTargets(targets.mcpxFiles, mcpxText, options.mkdir);
		}
		emitCommandSuccess(streams, route, globalJson, {
			command: "import",
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
