import { stat } from "node:fs/promises";
import { type DocumentRef, runModelRequest } from "../cli/cmd-model.ts";
import {
	type OptimizeDestination,
	runOptimizeRequest,
} from "../cli/cmd-optimize.ts";
import { McAssetError } from "../core/errors.ts";
import type { McpTextResult } from "./handlers.ts";
import type { ModelAssetInput, OptimizeAssetInput } from "./schema.ts";

/** Same shape as the textResult in handlers.ts: one JSON text block, no isError. */
function textResult(value: object): McpTextResult {
	return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/**
 * Same shape as the errorResult in handlers.ts. MCP has no --force or --mkdir,
 * so the CLI hint sentences are dropped from the messages.
 */
function errorResult(error: unknown): McpTextResult {
	if (error instanceof McAssetError) {
		const message = error.message
			.replace(/^\[[A-Z0-9_]+\] /, "")
			.replace(" Pass --force to overwrite.", "")
			.replace(" Pass --mkdir to create it.", "");
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						code: error.code,
						message,
						...(error.details === undefined ? {} : { details: error.details }),
					}),
				},
			],
			isError: true,
		};
	}
	const message = error instanceof Error ? error.message : String(error);
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({ code: "INTERNAL_ERROR", message }),
			},
		],
		isError: true,
	};
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** MCP never creates directories: outputDir must already exist. */
async function optimizeDestination(
	input: OptimizeAssetInput,
): Promise<OptimizeDestination> {
	const hasOutput = input.outputPath !== undefined;
	const hasDir = input.outputDir !== undefined;
	if (input.dryRun === true && (hasOutput || hasDir)) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			"dryRun cannot be combined with outputPath or outputDir.",
		);
	}
	if (hasOutput && hasDir) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			"Give outputPath or outputDir, not both.",
		);
	}
	if (input.outputPath !== undefined) {
		return { kind: "file", output: input.outputPath };
	}
	if (input.outputDir !== undefined) {
		if (!(await isDirectory(input.outputDir))) {
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Output directory is missing or not a directory: ${input.outputDir}.`,
			);
		}
		return { kind: "dir", dir: input.outputDir };
	}
	if (input.dryRun === true) return { kind: "dry-run" };
	if (input.inputPaths.length > 1) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Several inputs need outputDir, or dryRun set to true.",
		);
	}
	return { kind: "embed" };
}

/** Optimizes explicit PNG inputs; writes only to explicit new output paths. */
export async function handleOptimizeAsset(
	input: OptimizeAssetInput,
): Promise<McpTextResult> {
	try {
		const outcome = await runOptimizeRequest({
			inputs: input.inputPaths,
			mode: input.mode ?? "auto",
			ancillary: input.ancillary ?? "preserve",
			destination: await optimizeDestination(input),
			force: false,
			mkdir: false,
		});
		return textResult(
			outcome.artifact === undefined
				? outcome.result
				: {
						...outcome.result,
						pngBase64: Buffer.from(outcome.artifact).toString("base64"),
					},
		);
	} catch (error) {
		return errorResult(error);
	}
}

function inlineRef(value: unknown): DocumentRef | undefined {
	return value === undefined ? undefined : { inline: value };
}

/** Inspects, validates, creates, applies, or exports a Java model. */
export async function handleModelAsset(
	input: ModelAssetInput,
): Promise<McpTextResult> {
	try {
		const outcome = await runModelRequest({
			mode: input.mode,
			inputPath: input.inputPath,
			spec: inlineRef(input.spec),
			operations: inlineRef(input.operations),
			binding: inlineRef(input.binding),
			packPath: input.packPath,
			vanillaPath: input.vanillaPath,
			dependencyPaths: input.dependencyPaths,
			minecraftVersion: input.minecraftVersion,
			resourcePackVersion: input.resourcePackVersion,
			outputPath: input.outputPath,
			itemOutputPath: input.itemOutputPath,
			blockstateOutputPath: input.blockstateOutputPath,
			requireOutput: false,
		});
		return textResult(outcome.result);
	} catch (error) {
		return errorResult(error);
	}
}
