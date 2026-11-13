import { type McpToolName, TOOL_INPUT_SCHEMAS } from "./schema.ts";

export interface McpToolDefinition {
	name: McpToolName;
	description: string;
	inputSchema: (typeof TOOL_INPUT_SCHEMAS)[McpToolName];
}

/**
 * Frozen tool surface: the thirty-one names in `MCP_TOOL_NAMES`, each with
 * its final description and input schema. Descriptions state the read/write
 * contract so agents pick batch or grid paths instead of per-pixel calls.
 */
export const MCP_TOOLS: readonly McpToolDefinition[] = [
	{
		name: "compare_assets",
		description:
			"Compare same-size PNGs without modifying sources. Optional diagnostic image marks visible changes magenta and raw-only changes cyan; not a replacement asset.",
		inputSchema: TOOL_INPUT_SCHEMAS.compare_assets,
	},
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
			"Reduce the distinct colors of a raster image or .mcpx source to a target count or an explicit palette, with reserved colors kept byte-identical and an optional selection. Returns PNG bytes and/or the editable source via explicit output paths or embedded artifacts; no force, mkdir, or in-place writes.",
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
	{
		name: "inspect_asset",
		description:
			"Inspect an editable .mcpx source or raster image without writing: structure reports layers, regions, color usage, and overlaps; view returns the composited PNG plus metadata. Raster inputs read as a single base layer.",
		inputSchema: TOOL_INPUT_SCHEMAS.inspect_asset,
	},
	{
		name: "optimize_asset",
		description:
			"Losslessly optimize explicit PNG inputs without rewriting sources.",
		inputSchema: TOOL_INPUT_SCHEMAS.optimize_asset,
	},
	{
		name: "model_asset",
		description:
			"Inspect, validate, create, apply, export, or preview Java models, or exchange a Blockbench Java Block/Item project: import-bbmodel returns model JSON plus PNG textures, export-bbmodel packs a model and PNGs into .bbmodel. Preview renders a diagnostic three-view PNG, or one isometric panel when view is isometric and viewDirection picks the camera; it never writes without outputPath and never claims game rendering.",
		inputSchema: TOOL_INPUT_SCHEMAS.model_asset,
	},
	{
		name: "mcmeta_asset",
		description:
			"Generate an animation or GUI scaling .mcmeta document from a PNG. Writes only to the explicit .mcmeta outputPath (never merges; force replaces the whole file); without outputPath it returns the text. The PNG is read only. Checks the document is valid, not how it looks in game.",
		inputSchema: TOOL_INPUT_SCHEMAS.mcmeta_asset,
	},
	{
		name: "style_asset",
		description:
			"List the builtin style presets, show one resolved style (builtin id or a .style.json path with its extends chain), export a family palette as .mcpx, or write a new .style.json document. Style files are read-only inputs except for create and export-palette, which write only their explicit output path.",
		inputSchema: TOOL_INPUT_SCHEMAS.style_asset,
	},
	{
		name: "pack_asset",
		description:
			"Create a resource pack project: init writes the project document, the pack root metadata for the pinned release version, a 64x64 placeholder icon, and the assets directory skeleton in one preflighted batch. An occupied target refuses the whole batch and reports every conflicting path; nothing is overwritten. The project document is written once and then read only.",
		inputSchema: TOOL_INPUT_SCHEMAS.pack_asset,
	},
	{
		name: "particle_asset",
		description:
			"Generate a particle definition (assets/<namespace>/particles/<id>.json) and its frame sprites (assets/<namespace>/textures/particle/<prefix>_<n>.png) from a frames directory or one PNG/.mcpx frame. Frames are ordered by UTF-8 file-name bytes, never readdir order; textures[] entries are namespaced paths without .png or the textures/particle/ prefix. Every target is checked before the first write, and an occupied path refuses the whole batch unless force is true. The tool cannot add new particle types; a pack only overrides existing ones.",
		inputSchema: TOOL_INPUT_SCHEMAS.particle_asset,
	},
	{
		name: "font_asset",
		description:
			"Lay icon images (PNG or .mcpx) into grid-aligned bitmap font atlases and build the font definition (one bitmap provider per height/ascent group, plus optional space and reference providers) and the icon-to-character table. Each icon may set its own height and ascent; icons that share a pair share one atlas, and a spec with several pairs writes one atlas per pair. Icons are sorted by name and code points are allocated deterministically, so shuffled input produces byte-identical artifacts. Every chars row is padded to the column count with U+0000, ascent may be negative, and space advances are signed. A duplicate code point, an ascent above its height, or an over-tall icon is refused before anything is written.",
		inputSchema: TOOL_INPUT_SCHEMAS.font_asset,
	},
	{
		name: "entity_asset",
		description:
			"Inspect a Minecraft box-UV entity layout, write a template PNG and/or an editable .mcpx with one named region per face (optionally face-colored), validate a texture's size and report non-transparent pixels outside every face, or render four isometric views of the texture wrapped around the layout's parts. Builtin player wide/slim layouts plus caller-supplied layout documents; reads only except template and preview outputs.",
		inputSchema: TOOL_INPUT_SCHEMAS.entity_asset,
	},
	{
		name: "equipment_asset",
		description:
			"Generate an equipment definition (assets/<namespace>/models/equipment/<id>.json at pack format 42.0, assets/<namespace>/equipment/<id>.json from 46.0) plus one 64x32 armor or elytra texture template per layer entry at assets/<namespace>/textures/entity/equipment/<layer type>/<texture>.png. Layer types are checked against the target version's client enum, entries may be dyeable or use the player texture, and only humanoid, humanoid_leggings and wings have a verified texture layout (template false writes the definition alone). Every target is checked before the first write, an occupied path refuses the whole batch unless force is true, and without outputDir the definition text and each template embed instead.",
		inputSchema: TOOL_INPUT_SCHEMAS.equipment_asset,
	},
];
