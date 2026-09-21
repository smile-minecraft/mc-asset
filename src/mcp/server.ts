import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION } from "../index.ts";
import {
	handleAnalyzeAsset,
	handleAnimateAsset,
	handleApplyAssetOperations,
	handleBuildAsset,
	handleCleanupAsset,
	handleCreateVariants,
	handleGenerateAsset,
	handleImportAsset,
	handleMaterialAsset,
	handlePaletteAsset,
	handlePixelizeAsset,
	handlePreviewAsset,
	handleQuantizeAsset,
	handleRecolorAsset,
	handleRenderPixelAsset,
	handleScaleGuiAsset,
	handleTileAsset,
	handleTransformAsset,
	handleValidateAsset,
	handleValidatePackAsset,
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
	server.registerTool(
		"import_asset",
		{
			description: toolDescription("import_asset"),
			inputSchema: TOOL_INPUT_SCHEMAS.import_asset,
		},
		handleImportAsset,
	);
	server.registerTool(
		"build_asset",
		{
			description: toolDescription("build_asset"),
			inputSchema: TOOL_INPUT_SCHEMAS.build_asset,
		},
		handleBuildAsset,
	);
	server.registerTool(
		"transform_asset",
		{
			description: toolDescription("transform_asset"),
			inputSchema: TOOL_INPUT_SCHEMAS.transform_asset,
		},
		handleTransformAsset,
	);
	server.registerTool(
		"quantize_asset",
		{
			description: toolDescription("quantize_asset"),
			inputSchema: TOOL_INPUT_SCHEMAS.quantize_asset,
		},
		handleQuantizeAsset,
	);
	server.registerTool(
		"cleanup_asset",
		{
			description: toolDescription("cleanup_asset"),
			inputSchema: TOOL_INPUT_SCHEMAS.cleanup_asset,
		},
		handleCleanupAsset,
	);
	server.registerTool(
		"palette_asset",
		{
			description: toolDescription("palette_asset"),
			inputSchema: TOOL_INPUT_SCHEMAS.palette_asset,
		},
		handlePaletteAsset,
	);
	server.registerTool(
		"material_asset",
		{
			description: toolDescription("material_asset"),
			inputSchema: TOOL_INPUT_SCHEMAS.material_asset,
		},
		handleMaterialAsset,
	);
	server.registerTool(
		"tile_asset",
		{
			description: toolDescription("tile_asset"),
			inputSchema: TOOL_INPUT_SCHEMAS.tile_asset,
		},
		handleTileAsset,
	);
	server.registerTool(
		"generate_asset",
		{
			description: toolDescription("generate_asset"),
			inputSchema: TOOL_INPUT_SCHEMAS.generate_asset,
		},
		handleGenerateAsset,
	);
	server.registerTool(
		"preview_asset",
		{
			description: toolDescription("preview_asset"),
			inputSchema: TOOL_INPUT_SCHEMAS.preview_asset,
		},
		handlePreviewAsset,
	);
	server.registerTool(
		"animate_asset",
		{
			description: toolDescription("animate_asset"),
			inputSchema: TOOL_INPUT_SCHEMAS.animate_asset,
		},
		handleAnimateAsset,
	);
	server.registerTool(
		"validate_pack_asset",
		{
			description: toolDescription("validate_pack_asset"),
			inputSchema: TOOL_INPUT_SCHEMAS.validate_pack_asset,
		},
		handleValidatePackAsset,
	);
	server.registerTool(
		"scale_gui_asset",
		{
			description: toolDescription("scale_gui_asset"),
			inputSchema: TOOL_INPUT_SCHEMAS.scale_gui_asset,
		},
		handleScaleGuiAsset,
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
