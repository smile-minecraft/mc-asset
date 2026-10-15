import { isBuiltinMaterialId } from "../core/material.ts";
import type { ResolvedArtifacts } from "./artifacts.ts";
import {
	type PlannedTarget,
	planOutputTargetsKeepingExtension,
	writePlannedTargets,
} from "./safe-output.ts";

/**
 * Quantize has always accepted any output extension, so it uses the preflight
 * without the extension whitelist; all other output checks still apply.
 * Quantize protects the palette input even when the image is rewritten in place. */
export async function planQuantizeOutputs(
	targets: ResolvedArtifacts,
	options: {
		inputPath: string;
		palette?: string | undefined;
		inPlace?: boolean | undefined;
		mkdir?: boolean | undefined;
	},
): Promise<readonly PlannedTarget[]> {
	const inputs = options.inPlace === true ? [] : [options.inputPath];
	if (options.palette !== undefined && !isBuiltinMaterialId(options.palette))
		inputs.push(options.palette);
	return planOutputTargetsKeepingExtension(
		[
			...targets.pngFiles.map((target) => ({
				path: target.path,
				allowOverwrite: target.force,
			})),
			...targets.mcpxFiles.map((target) => ({
				path: target.path,
				allowOverwrite: target.force,
			})),
		],
		{ inputs, mkdir: options.mkdir === true },
	);
}
export async function writeQuantizeOutputs(
	plan: readonly PlannedTarget[],
	targets: ResolvedArtifacts,
	png: Uint8Array | undefined,
	mcpx: string | undefined,
	mkdir: boolean | undefined,
): Promise<void> {
	const payloads = new Map<string, Uint8Array | string>();
	for (const target of targets.pngFiles)
		if (png !== undefined) payloads.set(target.path, png);
	for (const target of targets.mcpxFiles)
		if (mcpx !== undefined) payloads.set(target.path, mcpx);
	await writePlannedTargets(plan, payloads, { mkdir: mkdir === true });
}
