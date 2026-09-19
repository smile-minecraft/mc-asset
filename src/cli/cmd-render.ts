import { encodePng } from "../io/png.ts";
import {
	applyBatchText,
	assertMinecraftOutputPath,
	type CommandResult,
	defaultLayerFor,
	emitCommandFailure,
	emitCommandSuccess,
	ensureMcpxText,
	preflightArtifactTargets,
	readInputText,
	readOperationsText,
	resolveArtifactTargets,
	resolveInputPath,
	type WarningNote,
	writeArtifactPayloads,
} from "./artifacts.ts";
import { emitArtifact, type OutputStreams, routeStreams } from "./channels.ts";
import { parseGridFile } from "./grid.ts";
import { parseProfile } from "./profiles.ts";

export interface RenderOptions {
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
 * Hand-grid entry: parse the standalone .grid file, run the optional
 * batch, emit PNG bytes and/or the assigned .mcpx source. The grid file
 * is only read, never written, unless --in-place names it back as the
 * PNG target.
 */
export async function runRender(
	grid: string | undefined,
	options: RenderOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({
		json: globalJson,
		stdoutArtifact: options.stdout === true,
	});
	try {
		const profile = parseProfile(options.profile);
		const inputPath = resolveInputPath(grid, options.input, "render");
		const targets = resolveArtifactTargets({
			command: "render",
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
		const canvas = parseGridFile(await readInputText(inputPath, "grid file"));
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
		// File-target preflight (alias, duplicate, existence, parents) runs
		// before any stdout artifact byte, so a conflict keeps stdout empty.
		// The write phase re-checks per file; the gap between the two is
		// best-effort against concurrent writers (TOCTOU).
		await preflightArtifactTargets(targets, {
			inputPath,
			inPlace: options.inPlace,
			mkdir: options.mkdir,
		});
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
			command: "render",
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
