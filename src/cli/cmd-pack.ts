import { McAssetError } from "../core/errors.ts";
import { executePackBuild, planPackBuild } from "../pack/build.ts";
import { initializePackProject, type PackInitRequest } from "../pack/index.ts";
import { emitCommandFailure } from "./artifacts.ts";
import {
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { successEnvelope } from "./envelope.ts";

/**
 * The `pack` command group. `init` writes one project skeleton: the project
 * document, the pack root metadata for the pinned target, the placeholder
 * icon, and the resource pack directory chain. The whole batch is planned
 * and preflighted before the first byte, and an occupied target refuses the
 * batch with the full conflict list instead of overwriting anything.
 */

export interface PackOptions {
	project?: string | undefined;
	recipe?: string | undefined;
	dryRun?: boolean | undefined;
	namespace?: string | undefined;
	minecraftVersion?: string | undefined;
	name?: string | undefined;
	description?: string | undefined;
	style?: string | undefined;
	resourcePackVersion?: string | undefined;
	allowMinecraftNamespace?: boolean | undefined;
}

/** Read a required flag, naming the flag itself when it is missing. */
function requiredFlag(value: string | undefined, flag: string): string {
	if (value === undefined || value === "") {
		throw new McAssetError("INVALID_ARGUMENT", `pack init needs ${flag}.`, {
			flag,
		});
	}
	return value;
}

function initLine(result: {
	minecraftVersion: string;
	packFormat: string;
	files: readonly string[];
	directories: readonly string[];
}): string {
	return `ok pack init minecraft=${result.minecraftVersion} resource-pack=${result.packFormat} files=${result.files.length} directories=${result.directories.length}`;
}

/**
 * CLI entry for the `pack` group. `init` takes the target directory as its
 * argument and every setting as an explicit flag, then reports the pinned
 * version and what it wrote.
 */
export async function runPack(
	mode: string,
	target: string | undefined,
	options: PackOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({ json: globalJson, stdoutArtifact: false });
	try {
		if (mode === "build") {
			const projectPath = target ?? options.project ?? "./mc-asset.pack.json";
			const plan = await planPackBuild(projectPath, {
				recipe: options.recipe,
				dryRun: options.dryRun,
			});
			const executed = await executePackBuild(plan);
			const result = {
				command: "pack",
				mode: "build",
				recipeId: plan.recipeId,
				outputs: plan.outputs,
				completed: executed.completed,
				dryRun: plan.dryRun,
			};
			if (globalJson) {
				emitEnvelope(successEnvelope(result), streams, route);
			} else {
				emitLog(
					`ok pack build recipe=${plan.recipeId} planned=${plan.outputs.length} completed=${executed.completed.length} dryRun=${plan.dryRun}`,
					streams,
					route,
				);
			}
			return 0;
		}
		if (mode === "init") {
			if (target === undefined || target === "") {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					"pack init needs a project directory.",
					{ flag: "<dir>" },
				);
			}
			const request: PackInitRequest = {
				projectDir: target,
				namespace: requiredFlag(options.namespace, "--namespace"),
				minecraftVersion: requiredFlag(
					options.minecraftVersion,
					"--minecraft-version",
				),
				name: options.name,
				description: options.description,
				style: options.style,
				resourcePackVersion: options.resourcePackVersion,
				allowMinecraftNamespace: options.allowMinecraftNamespace,
			};
			const written = await initializePackProject(request);
			const result = { command: "pack", mode: "init", ...written };
			if (globalJson) {
				emitEnvelope(successEnvelope(result), streams, route);
			} else {
				emitLog(initLine(written), streams, route);
				emitLog(`project=${written.projectPath}`, streams, route);
				for (const file of written.files) {
					emitLog(`file=${file}`, streams, route);
				}
				for (const directory of written.directories) {
					emitLog(`dir=${directory}`, streams, route);
				}
			}
			return 0;
		}
		throw new McAssetError("INVALID_ARGUMENT", "pack takes init or build.", {
			mode,
		});
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}
