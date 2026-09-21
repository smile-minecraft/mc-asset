import { type McpToolName, TOOL_INPUT_SCHEMAS } from "./schema.ts";

export interface McpToolDefinition {
	name: McpToolName;
	description: string;
	inputSchema: (typeof TOOL_INPUT_SCHEMAS)[McpToolName];
}

/**
 * Frozen tool surface: twenty tools for v0.7 CLI parity — the seven
 * original §90 tools plus twelve v0.7 additions — plus the
 * capability-completion scale_gui_asset, each with its final
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
	{
		name: "import_asset",
		description:
			"Decode a raster image (PNG, JPEG, WebP) into the Pixel Canvas with an optional batch applied after import. Returns PNG bytes and/or the editable .mcpx source via explicit output paths or embedded artifacts; no force, mkdir, or in-place writes.",
		inputSchema: TOOL_INPUT_SCHEMAS.import_asset,
	},
	{
		name: "build_asset",
		description:
			"Build an editable .mcpx source into a texture or re-serialize the source, with an optional batch applied after parsing. Returns PNG bytes and/or the built source via explicit output paths or embedded artifacts; no force, mkdir, or in-place writes.",
		inputSchema: TOOL_INPUT_SCHEMAS.build_asset,
	},
	{
		name: "transform_asset",
		description:
			"Apply one spatial transformation (flip, rotate, crop, pad, resize, or translate) to a raster image or .mcpx source. Returns PNG bytes and/or the editable source via explicit output paths or embedded artifacts; no force, mkdir, or in-place writes.",
		inputSchema: TOOL_INPUT_SCHEMAS.transform_asset,
	},
	{
		name: "quantize_asset",
		description:
			"Reduce the distinct colors of a raster image or .mcpx source to a target count, optionally scoped by a selection. Returns PNG bytes and/or the editable source via explicit output paths or embedded artifacts; no force, mkdir, or in-place writes.",
		inputSchema: TOOL_INPUT_SCHEMAS.quantize_asset,
	},
	{
		name: "cleanup_asset",
		description:
			"Detect or eliminate isolated, noise, or outlier pixels in a raster image or .mcpx source, optionally scoped by a selection. Returns PNG bytes and/or the editable source via explicit output paths or embedded artifacts; no force, mkdir, or in-place writes.",
		inputSchema: TOOL_INPUT_SCHEMAS.cleanup_asset,
	},
	{
		name: "palette_asset",
		description:
			"Run the palette extract or inspect subcommand over an image and return a read-only report of unique colors, distribution, roles, or contrast. Reads only, never writes.",
		inputSchema: TOOL_INPUT_SCHEMAS.palette_asset,
	},
	{
		name: "material_asset",
		description:
			"Run the material list or show subcommand and return a read-only report of builtin material definitions or one material's color ramps. Reads only, never writes.",
		inputSchema: TOOL_INPUT_SCHEMAS.material_asset,
	},
	{
		name: "tile_asset",
		description:
			"Analyze seams, edge repetition, and brightness continuity of a tileable image, with an optional tiled preview grid. Reads the input and returns a report, or writes a preview PNG only to the explicit output path; never invents filenames.",
		inputSchema: TOOL_INPUT_SCHEMAS.tile_asset,
	},
	{
		name: "generate_asset",
		description:
			"Generate a deterministic procedural texture from a named pattern, size, palette, and seed. Returns PNG bytes and/or the editable .mcpx source via explicit output paths or embedded artifacts; no force, mkdir, or in-place writes.",
		inputSchema: TOOL_INPUT_SCHEMAS.generate_asset,
	},
	{
		name: "preview_asset",
		description:
			"Preview an image in ascii, palette-map, scale, or nine-slice mode. Read-only except scale and nine-slice, which may write a PNG only to the explicit output path; never invents filenames.",
		inputSchema: TOOL_INPUT_SCHEMAS.preview_asset,
	},
	{
		name: "animate_asset",
		description:
			"Run one animation subcommand (pack, unpack, reorder, resize, validate, or preview) over frames or a sprite sheet. Pack writes a sheet PNG only to the explicit output path and unpack, reorder, and resize write frames only to the explicit output directory; validate and preview return read-only reports.",
		inputSchema: TOOL_INPUT_SCHEMAS.animate_asset,
	},
	{
		name: "validate_pack_asset",
		description:
			"Scan a resource pack root for namespace, model, texture, and atlas integrity and return a read-only verdict with findings. Reads only, never writes.",
		inputSchema: TOOL_INPUT_SCHEMAS.validate_pack_asset,
	},
	{
		name: "scale_gui_asset",
		description:
			"Scale a GUI sprite to N or WxH with the mcmeta stretch/tile/nine_slice mapping. Returns PNG bytes and/or the scaled PNG via an explicit output path; never invents filenames.",
		inputSchema: TOOL_INPUT_SCHEMAS.scale_gui_asset,
	},
];
