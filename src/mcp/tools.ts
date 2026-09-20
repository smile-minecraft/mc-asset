import { type McpToolName, TOOL_INPUT_SCHEMAS } from "./schema.ts";

export interface McpToolDefinition {
	name: McpToolName;
	description: string;
	inputSchema: (typeof TOOL_INPUT_SCHEMAS)[McpToolName];
}

/**
 * Frozen tool surface: exactly the seven §90 tools, each with its final
 * name, description, and input schema. Descriptions state the read/write
 * contract so agents pick batch or grid paths instead of per-pixel calls.
 */
export const MCP_TOOLS: readonly McpToolDefinition[] = [
	{
		name: "analyze_asset",
		description:
			"Analyze a raster image (PNG, JPEG, WebP) and return a read-only report: dimensions, palette, predicted alpha classification, pixel-art characteristics, and processing recommendations. Reads only, never writes.",
		inputSchema: TOOL_INPUT_SCHEMAS.analyze_asset,
	},
	{
		name: "pixelize_asset",
		description:
			"Run a reference raster image through the deterministic pixelize pipeline and return PNG bytes and/or the editable .mcpx source. The input must be PNG, JPEG, or WebP, never .mcpx.",
		inputSchema: TOOL_INPUT_SCHEMAS.pixelize_asset,
	},
	{
		name: "render_pixel_asset",
		description:
			"Render a hand-authored ASCII Grid (inline text or a .grid file, exactly one) into PNG bytes and/or the editable .mcpx source, with an optional batch applied after parsing. For pixel-level authorship without per-pixel tool calls.",
		inputSchema: TOOL_INPUT_SCHEMAS.render_pixel_asset,
	},
	{
		name: "apply_asset_operations",
		description:
			"Apply a batch of Core pixel/layer/region operations to an editable .mcpx source in one call (atomic by default: the first failure rolls everything back). This is the batch-edit slot; never split pixel work across hundreds of per-pixel tool calls.",
		inputSchema: TOOL_INPUT_SCHEMAS.apply_asset_operations,
	},
	{
		name: "recolor_asset",
		description:
			"Recolor an editable .mcpx source with a builtin material id, optionally limited to one region id, and return PNG bytes and/or the recolored source.",
		inputSchema: TOOL_INPUT_SCHEMAS.recolor_asset,
	},
	{
		name: "create_variants",
		description:
			"Fan out one editable .mcpx source into per-material variants under an explicit output directory, each starting from the pristine source so reruns stay byte-identical.",
		inputSchema: TOOL_INPUT_SCHEMAS.create_variants,
	},
	{
		name: "validate_asset",
		description:
			"Validate an asset file and return a read-only verdict with findings. Reads only, never writes; an optional explicit .mcmeta path is used verbatim.",
		inputSchema: TOOL_INPUT_SCHEMAS.validate_asset,
	},
];
