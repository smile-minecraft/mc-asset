import { z } from "zod";

/**
 * Frozen MCP tool surface: nineteen tools for v0.7 CLI parity — the seven
 * original §90 tools plus twelve v0.7 additions (import through
 * validate-pack, with palette/material/preview/animate mode merges). The
 * product document once listed `edit_asset` for the batch-edit slot, and
 * §90 wins, so the frozen name is `apply_asset_operations`. The input
 * shapes below are the frozen contract; handler behavior lands in the
 * next step.
 */

export const MCP_TOOL_NAMES = [
	"analyze_asset",
	"pixelize_asset",
	"render_pixel_asset",
	"apply_asset_operations",
	"recolor_asset",
	"create_variants",
	"validate_asset",
	"import_asset",
	"build_asset",
	"transform_asset",
	"quantize_asset",
	"cleanup_asset",
	"palette_asset",
	"material_asset",
	"tile_asset",
	"generate_asset",
	"preview_asset",
	"animate_asset",
	"validate_pack_asset",
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

const profileField = z
	.enum([
		"generic",
		"minecraft:item",
		"minecraft:block",
		"minecraft:gui",
		"minecraft:particle",
	])
	.optional()
	.describe("Asset profile; omitted means generic.");

const minecraftVersionField = z
	.string()
	.min(1)
	.optional()
	.describe(
		"Target Minecraft version: 1.21.11, 26.1, 26.1.1, 26.1.2, 26.2, or 26.3. Omitted means engine defaults.",
	);

const resourcePackVersionField = z
	.string()
	.min(1)
	.optional()
	.describe(
		"Target resource-pack version as N or N.M (e.g. 84, 97.1); normalized to major.minor. Omitted means engine defaults.",
	);

const outputPngField = z
	.string()
	.min(1)
	.optional()
	.describe(
		"Explicit PNG output path. When omitted, the PNG bytes are embedded in the result instead of written to disk.",
	);

const outputMcpxField = z
	.string()
	.min(1)
	.optional()
	.describe(
		"Explicit .mcpx output path. When omitted, the .mcpx text is embedded in the result instead of written to disk.",
	);

/** One batch operation: the `type` selects the Core primitive; any extra keys are per-type arguments. */
const batchOperationField = z
	.object({ type: z.string().min(1), id: z.string().min(1).optional() })
	.passthrough()
	.describe(
		"Batch operation object with a `type` (setPixel, drawLine, fillRect, floodFill, createLayer, setRegionPixel, and the rest of the Core batch vocabulary) plus its per-type arguments.",
	);

export const TOOL_INPUT_SCHEMAS = {
	analyze_asset: {
		path: z.string().min(1).describe("Raster image path (PNG, JPEG, WebP)."),
		profile: profileField,
		minecraftVersion: minecraftVersionField,
		resourcePackVersion: resourcePackVersionField,
	},
	pixelize_asset: {
		inputPath: z
			.string()
			.min(1)
			.describe("Reference raster image path (PNG, JPEG, WebP; never .mcpx)."),
		size: z
			.string()
			.min(1)
			.optional()
			.describe("Output size: 16, 32, 64, 128, or WxH."),
		preset: z
			.string()
			.min(1)
			.optional()
			.describe("Processing preset: item, block, generic, gui, particle."),
		profile: profileField,
		outputPngPath: outputPngField,
		outputMcpxPath: outputMcpxField,
	},
	render_pixel_asset: {
		gridPath: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Standalone ASCII Grid file path. Exactly one of gridPath and gridText is required.",
			),
		gridText: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Inline ASCII Grid document text. Exactly one of gridPath and gridText is required.",
			),
		operations: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Optional batch operations JSON text applied after the grid is parsed.",
			),
		profile: profileField,
		outputPngPath: outputPngField,
		outputMcpxPath: outputMcpxField,
	},
	apply_asset_operations: {
		sourcePath: z
			.string()
			.min(1)
			.describe("Editable .mcpx source path the batch runs against."),
		operations: z
			.array(batchOperationField)
			.min(1)
			.describe(
				"Batch operations applied in order in a single call; never split pixel work across hundreds of tool calls.",
			),
		atomic: z
			.boolean()
			.optional()
			.describe(
				"Default true: the first failure rolls the canvas back and the whole batch fails.",
			),
		outputPngPath: outputPngField,
		outputMcpxPath: outputMcpxField,
	},
	recolor_asset: {
		sourcePath: z
			.string()
			.min(1)
			.describe("Editable .mcpx source path to recolor."),
		material: z.string().min(1).describe("Builtin material id to apply."),
		region: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Limit the write to one region id; otherwise every layer is recolored.",
			),
		profile: profileField,
		outputPngPath: outputPngField,
		outputMcpxPath: outputMcpxField,
	},
	create_variants: {
		sourcePath: z
			.string()
			.min(1)
			.describe("Editable .mcpx source path to fan out from."),
		materials: z
			.array(z.string().min(1))
			.min(1)
			.describe(
				"Builtin material ids, one variant per entry, each starting from the pristine source.",
			),
		outputDir: z
			.string()
			.min(1)
			.describe(
				"Explicit output directory receiving <stem>_<material>.png plus .mcpx per material.",
			),
		profile: profileField,
	},
	validate_asset: {
		path: z.string().min(1).describe("Asset file path to validate (PNG)."),
		profile: profileField,
		minecraftVersion: minecraftVersionField,
		resourcePackVersion: resourcePackVersionField,
		mcmetaPath: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Explicit .mcmeta path used verbatim; a sibling file is never derived.",
			),
	},
	import_asset: {
		inputPath: z
			.string()
			.min(1)
			.describe("Raster image path (PNG, JPEG, WebP)."),
		operations: z
			.string()
			.min(1)
			.optional()
			.describe("Optional batch operations JSON text."),
		profile: profileField,
		outputPngPath: outputPngField,
		outputMcpxPath: outputMcpxField,
	},
	build_asset: {
		sourcePath: z.string().min(1).describe("Editable .mcpx source path."),
		operations: z
			.string()
			.min(1)
			.optional()
			.describe("Optional batch operations JSON text."),
		profile: profileField,
		outputPngPath: outputPngField,
		outputMcpxPath: outputMcpxField,
	},
	transform_asset: {
		inputPath: z
			.string()
			.min(1)
			.describe("Raster image or .mcpx path to transform."),
		flip: z.enum(["h", "v"]).optional().describe("Flip axis: h or v."),
		rotate: z
			.union([z.literal(90), z.literal(180), z.literal(270)])
			.optional()
			.describe("Rotation in degrees: 90, 180, or 270."),
		crop: z.string().min(1).optional().describe("Crop rectangle as x,y,w,h."),
		pad: z.string().min(1).optional().describe("Padding as l,t,r,b."),
		padColor: z
			.string()
			.min(1)
			.optional()
			.describe('Pad color as hex or "transparent".'),
		translate: z
			.string()
			.min(1)
			.optional()
			.describe("Translation offset as dx,dy."),
		resize: z.string().min(1).optional().describe("Target size as WxH."),
		resizeMode: z
			.enum(["nearest", "box"])
			.optional()
			.describe("Resize sampling: nearest or box."),
		selection: z
			.string()
			.min(1)
			.optional()
			.describe("Scope operations to rect:x,y,w,h or region:id."),
		profile: profileField,
		outputPngPath: outputPngField,
		outputMcpxPath: outputMcpxField,
	},
	quantize_asset: {
		inputPath: z
			.string()
			.min(1)
			.describe("Raster image or .mcpx path to quantize."),
		colors: z.number().describe("Target distinct color count."),
		selection: z
			.string()
			.min(1)
			.optional()
			.describe("Scope operations to rect:x,y,w,h or region:id."),
		profile: profileField,
		outputPngPath: outputPngField,
		outputMcpxPath: outputMcpxField,
	},
	cleanup_asset: {
		inputPath: z
			.string()
			.min(1)
			.describe("Raster image or .mcpx path to clean up."),
		fix: z
			.string()
			.min(1)
			.optional()
			.describe("Comma-separated fix classes to eliminate."),
		allowRenderPassChange: z
			.boolean()
			.optional()
			.describe(
				"Allow fixes that change the render pass (alpha-affecting classes).",
			),
		selection: z
			.string()
			.min(1)
			.optional()
			.describe("Scope operations to rect:x,y,w,h or region:id."),
		profile: profileField,
		outputPngPath: outputPngField,
		outputMcpxPath: outputMcpxField,
	},
	palette_asset: {
		mode: z
			.enum(["extract", "inspect"])
			.describe("Palette subcommand: extract or inspect."),
		inputPath: z
			.string()
			.min(1)
			.describe("Raster image or .mcpx path to inspect."),
	},
	material_asset: {
		mode: z
			.enum(["list", "show"])
			.describe("Material subcommand: list or show."),
		name: z
			.string()
			.min(1)
			.optional()
			.describe("Material name to show; required for show."),
	},
	tile_asset: {
		inputPath: z
			.string()
			.min(1)
			.describe("Raster image or .mcpx path for seam analysis."),
		preview: z
			.enum(["2x2", "4x4", "8x8"])
			.optional()
			.describe("Tiled preview grid: 2x2, 4x4, or 8x8."),
		edgeMatch: z
			.enum(["horizontal", "vertical", "both"])
			.optional()
			.describe("Edge-match axis: horizontal, vertical, or both."),
		brightnessMatch: z
			.enum(["horizontal", "vertical", "both"])
			.optional()
			.describe("Brightness-match axis: horizontal, vertical, or both."),
		profile: profileField,
		outputPngPath: outputPngField,
	},
	generate_asset: {
		pattern: z
			.string()
			.min(1)
			.describe(
				"Procedural pattern: noise, clustered-noise, stripes, checker, gradient, brick, spots, veins, cracks, or grain.",
			),
		size: z.string().min(1).describe("Output size: 16, 32, 64, 128, or WxH."),
		palette: z
			.string()
			.min(1)
			.describe("Builtin material name or .mcpx path for colors."),
		seed: z
			.number()
			.int()
			.min(0)
			.max(4294967295)
			.describe("Deterministic seed: integer 0-4294967295."),
		profile: profileField,
		outputPngPath: outputPngField,
		outputMcpxPath: outputMcpxField,
	},
	preview_asset: {
		inputPath: z
			.string()
			.min(1)
			.describe("Raster image or .mcpx path to preview."),
		mode: z
			.enum(["ascii", "palette-map", "scale", "nine-slice"])
			.describe("Preview mode: ascii, palette-map, scale, or nine-slice."),
		scale: z.number().optional().describe("Upscale factor for scale mode."),
		mcmetaPath: z
			.string()
			.min(1)
			.optional()
			.describe("Explicit .mcmeta path used by nine-slice mode."),
		profile: profileField,
		outputPngPath: outputPngField,
	},
	animate_asset: {
		mode: z
			.enum(["pack", "unpack", "reorder", "resize", "validate", "preview"])
			.describe(
				"Animation subcommand: pack, unpack, reorder, resize, validate, or preview.",
			),
		framesDir: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Frames directory for pack, reorder, resize, validate, preview.",
			),
		sheetPath: z
			.string()
			.min(1)
			.optional()
			.describe("Sprite sheet path used as unpack input."),
		layout: z
			.enum(["vertical", "horizontal", "grid"])
			.optional()
			.describe("Sheet layout: vertical, horizontal, or grid."),
		columns: z.number().optional().describe("Grid column count."),
		frameSize: z.string().min(1).optional().describe("Frame size as N or WxH."),
		resizeMode: z
			.enum(["nearest", "box"])
			.optional()
			.describe("Resize sampling: nearest or box."),
		order: z
			.string()
			.min(1)
			.optional()
			.describe("Frame order for reorder as i,j,..."),
		mcmetaPath: z
			.string()
			.min(1)
			.optional()
			.describe("Explicit .mcmeta path used by unpack and validate."),
		profile: profileField,
		outputPngPath: outputPngField,
		outputDir: z
			.string()
			.min(1)
			.optional()
			.describe("Explicit output directory for unpack, reorder, and resize."),
	},
	validate_pack_asset: {
		packPath: z.string().min(1).describe("Resource pack root directory."),
		minecraftVersion: minecraftVersionField,
		resourcePackVersion: resourcePackVersionField,
	},
} satisfies Record<McpToolName, Record<string, z.ZodTypeAny>>;
