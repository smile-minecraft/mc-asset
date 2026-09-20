import { z } from "zod";

/**
 * Frozen MCP tool surface: the seven tool names come from the technical
 * specification (§90); the product document once listed `edit_asset` for
 * the batch-edit slot, and §90 wins, so the frozen name is
 * `apply_asset_operations`. The input shapes below are the frozen
 * contract; handler behavior lands in the next step.
 */

export const MCP_TOOL_NAMES = [
	"analyze_asset",
	"pixelize_asset",
	"render_pixel_asset",
	"apply_asset_operations",
	"recolor_asset",
	"create_variants",
	"validate_asset",
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
	.describe("Target Minecraft version (e.g. 26.3).");

const resourcePackVersionField = z
	.string()
	.min(1)
	.optional()
	.describe("Target resource packFormat as a positive integer (e.g. 75).");

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
} satisfies Record<McpToolName, Record<string, z.ZodTypeAny>>;
