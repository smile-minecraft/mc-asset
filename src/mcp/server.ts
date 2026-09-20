import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION } from "../index.ts";
import {
	handleAnalyzeAsset,
	handleApplyAssetOperations,
	handleCreateVariants,
	handlePixelizeAsset,
	handleRecolorAsset,
	handleRenderPixelAsset,
	handleValidateAsset,
} from "./handlers.ts";
import { type McpToolName, TOOL_INPUT_SCHEMAS } from "./schema.ts";
import { MCP_TOOLS } from "./tools.ts";

export const MCP_SERVER_NAME = "mc-asset";

function toolDescription(name: McpToolName): string {
	const found = MCP_TOOLS.find((tool) => tool.name === name);
	if (found === undefined) {
		throw new Error(`Unknown MCP tool: ${name}.`);
	}
	return found.description;
}

/**
 * Build the stdio MCP server: the frozen tool surface hangs directly off
 * Core through the handlers module (no reimplemented image logic). Each
 * tool is registered explicitly so the handler argument type always
 * matches its input schema.
 */
export function createMcpServer(): McpServer {
	const server = new McpServer({ name: MCP_SERVER_NAME, version: VERSION });
	server.registerTool(
		"analyze_asset",
		{
			description: toolDescription("analyze_asset"),
			inputSchema: TOOL_INPUT_SCHEMAS.analyze_asset,
		},
		handleAnalyzeAsset,
	);
	server.registerTool(
		"pixelize_asset",
		{
			description: toolDescription("pixelize_asset"),
			inputSchema: TOOL_INPUT_SCHEMAS.pixelize_asset,
		},
		handlePixelizeAsset,
	);
	server.registerTool(
		"render_pixel_asset",
		{
			description: toolDescription("render_pixel_asset"),
			inputSchema: TOOL_INPUT_SCHEMAS.render_pixel_asset,
		},
		handleRenderPixelAsset,
	);
	server.registerTool(
		"apply_asset_operations",
		{
			description: toolDescription("apply_asset_operations"),
			inputSchema: TOOL_INPUT_SCHEMAS.apply_asset_operations,
		},
		handleApplyAssetOperations,
	);
	server.registerTool(
		"recolor_asset",
		{
			description: toolDescription("recolor_asset"),
			inputSchema: TOOL_INPUT_SCHEMAS.recolor_asset,
		},
		handleRecolorAsset,
	);
	server.registerTool(
		"create_variants",
		{
			description: toolDescription("create_variants"),
			inputSchema: TOOL_INPUT_SCHEMAS.create_variants,
		},
		handleCreateVariants,
	);
	server.registerTool(
		"validate_asset",
		{
			description: toolDescription("validate_asset"),
			inputSchema: TOOL_INPUT_SCHEMAS.validate_asset,
		},
		handleValidateAsset,
	);
	return server;
}

/**
 * Serve MCP over stdio: stdout carries only MCP JSON-RPC, diagnostics go
 * to stderr, and the process ends when stdin closes. Uses only node:
 * imports on this path, so the bundled dist runs under plain Node.
 */
export async function runMcpServer(): Promise<number> {
	try {
		const server = createMcpServer();
		await server.connect(new StdioServerTransport());
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(
			`error [INTERNAL_ERROR] mcp server failed: ${message}\n`,
		);
		return 1;
	}
}
