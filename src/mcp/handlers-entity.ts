import { Buffer } from "node:buffer";
import { type EntityLayoutRef, runEntityRequest } from "../cli/cmd-entity.ts";
import { McAssetError } from "../core/errors.ts";
import type { McpTextResult } from "./handlers.ts";
import type { EntityAssetInput } from "./schema.ts";

/** MCP has no --force or --mkdir, so the CLI hint sentences are dropped. */
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

function layoutRef(layout: EntityAssetInput["layout"]): EntityLayoutRef {
	if (layout === undefined) {
		return { kind: "name", value: "player_wide" };
	}
	if (typeof layout === "string") {
		return { kind: "name", value: layout };
	}
	return { kind: "inline", value: layout };
}

/**
 * entity_asset: one request core shared with the CLI. Template outputs are
 * written only to explicit paths; an omitted PNG or .mcpx comes back inline
 * (image block or sourceText), and nothing else touches disk.
 */
export async function handleEntityAsset(
	input: EntityAssetInput,
): Promise<McpTextResult> {
	try {
		const outcome = await runEntityRequest({
			mode: input.mode,
			layout: layoutRef(input.layout),
			inputPath: input.inputPath,
			fill: input.fill,
			outputPngPath: input.outputPngPath,
			outputMcpxPath: input.outputMcpxPath,
			stdout: false,
			force: false,
			mkdir: false,
			requireOutput: false,
		});
		const body: Record<string, unknown> = {
			...outcome.result,
			...(outcome.mcpxText === undefined
				? {}
				: { sourceText: outcome.mcpxText }),
		};
		const content: McpTextResult["content"] = [
			{ type: "text", text: JSON.stringify(body) },
		];
		if (outcome.png !== undefined) {
			content.push({
				type: "image",
				data: Buffer.from(outcome.png).toString("base64"),
				mimeType: "image/png",
			});
		}
		return { content };
	} catch (error) {
		return errorResult(error);
	}
}
