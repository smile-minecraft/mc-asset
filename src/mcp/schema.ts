import { z } from "zod";

/**
 * Frozen MCP tool surface: twenty-seven tools for agent authoring — the
 * intake and inspection pair, raster transforms, palette and quantization,
 * the deterministic pixelize pipeline, procedural generation, tiling and
 * preview, animation sheets, single-asset and whole-pack validation, model
 * and `.mcmeta` authoring, style presets and palette export, resource-pack
 * project authoring, and PNG comparison. `MCP_TOOL_NAMES` below is the
 * registry this count is checked against.
 * The product document once listed `edit_asset` for the batch-edit slot, and
 * §90 wins, so the frozen name is `apply_asset_operations`. The input
 * shapes below are the frozen contract; handler behavior lives in
 * `src/mcp/handlers.ts`.
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
	"scale_gui_asset",
	"inspect_asset",
	"optimize_asset",
	"model_asset",
	"mcmeta_asset",
	"compare_assets",
	"style_asset",
	"pack_asset",
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
		'Release Minecraft version 1.19.3 through 26.3 (for example "1.19.3", "1.21.4", "26.3"). Omitted means engine defaults.',
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

/** Optional visual feedback for apply_asset_operations; absent means the legacy output shape. */
const feedbackField = z
	.object({
		image: z
			.enum(["none", "full", "changed"])
			.optional()
			.describe(
				"Feedback image: none (default, flags only), full (whole crop), or changed (composited change bounds; the crop is ignored). Changed with no visible difference returns noVisibleChange instead of an image.",
			),
		scale: z
			.number()
			.int()
			.min(1)
			.max(16)
			.optional()
			.describe(
				"Feedback integer upscale factor 1-16 with nearest sampling; omitted auto-scales from the pre-scale long edge below 128.",
			),
		crop: z
			.unknown()
			.optional()
			.describe(
				"Feedback selection expression (atom string or JSON expression object); refused with image none, ignored with image changed.",
			),
		diff: z
			.enum(["none", "summary"])
			.optional()
			.describe(
				"Feedback diff: none (default) or summary with raw, composited, structural, and outsideSelectionUnchanged.",
			),
	})
	.optional()
	.describe(
		"Optional visual feedback for the batch; absent keeps the output fields and bytes exactly as before.",
	);

export const OPTIMIZE_MODES = [
	"auto",
	"rgba",
	"rgb",
	"grayscale",
	"grayscale-alpha",
	"indexed",
] as const;

export const optimizeAssetInput = {
	inputPaths: z
		.array(z.string().min(1))
		.min(1)
		.max(256)
		.optional()
		.describe(
			"PNG files to optimize (1 to 256 explicit paths; no globs, no directories). Mutually exclusive with inputDir. Never written.",
		),
	inputDir: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Directory containing PNG files to optimize (up to 4096 PNGs). Mutually exclusive with inputPaths.",
		),
	recursive: z
		.boolean()
		.optional()
		.describe(
			"When scanning inputDir, recursively include subdirectories (default false).",
		),
	mode: z
		.enum(OPTIMIZE_MODES)
		.optional()
		.describe(
			"auto (default) keeps the smallest exact encoding or the source; a named mode forces that encoding and fails with OPTIMIZE_MODE_NOT_EXACT when it cannot hold the pixels exactly.",
		),
	ancillary: z
		.enum(["preserve", "strip"])
		.optional()
		.describe(
			"preserve (default) copies metadata chunks and refuses sources whose chunks depend on the color layout; strip drops every ancillary chunk and lists them.",
		),
	dryRun: z
		.boolean()
		.optional()
		.describe("Compute the full report and write nothing."),
	outputPath: z
		.string()
		.min(1)
		.optional()
		.describe("Explicit .png output path; only with exactly one input."),
	outputDir: z
		.string()
		.min(1)
		.optional()
		.describe("Existing directory receiving <input basename> for every input."),
};

const direction = z.enum(["down", "up", "north", "south", "west", "east"]);
const displayPosition = z.enum([
	"thirdperson_righthand",
	"thirdperson_lefthand",
	"firstperson_righthand",
	"firstperson_lefthand",
	"gui",
	"head",
	"ground",
	"fixed",
	"on_shelf",
]);
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const uv4 = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const faceRotation = z.union([
	z.literal(0),
	z.literal(90),
	z.literal(180),
	z.literal(270),
]);

const textureEntry = z.union([
	z.string().min(1),
	z
		.object({
			sprite: z.string().min(1),
			forceTranslucent: z.boolean().optional(),
		})
		.strict(),
]);

const faceSpec = z
	.object({
		texture: z.string().min(1),
		uv: uv4.optional(),
		rotation: faceRotation.optional(),
		cullface: direction.optional(),
		tintindex: z.number().int().optional(),
	})
	.strict();

const elementRotation = z.union([
	z
		.object({
			origin: vec3,
			axis: z.enum(["x", "y", "z"]),
			angle: z.number(),
			rescale: z.boolean().optional(),
		})
		.strict(),
	z
		.object({
			origin: vec3,
			x: z.number().optional(),
			y: z.number().optional(),
			z: z.number().optional(),
			rescale: z.boolean().optional(),
		})
		.strict(),
]);

const elementSpec = z
	.object({
		name: z.string().optional(),
		from: vec3,
		to: vec3,
		rotation: elementRotation.optional(),
		shade: z.boolean().optional(),
		shadeDirectionOverride: direction.optional(),
		lightEmission: z.number().int().min(0).max(15).optional(),
		faces: z
			.object({
				down: faceSpec.optional(),
				up: faceSpec.optional(),
				north: faceSpec.optional(),
				south: faceSpec.optional(),
				west: faceSpec.optional(),
				east: faceSpec.optional(),
			})
			.strict(),
	})
	.strict();

const displayTransform = z
	.object({
		rotation: vec3.optional(),
		translation: vec3.optional(),
		scale: vec3.optional(),
	})
	.strict();

export const modelSpecSchema = z
	.object({
		parent: z.string().min(1).optional(),
		ambientocclusion: z.boolean().optional(),
		guiLight: z.enum(["front", "side"]).optional(),
		textures: z.record(z.string().min(1), textureEntry).optional(),
		elements: z.array(elementSpec).max(4096).optional(),
		display: z
			.object({
				thirdperson_righthand: displayTransform.optional(),
				thirdperson_lefthand: displayTransform.optional(),
				firstperson_righthand: displayTransform.optional(),
				firstperson_lefthand: displayTransform.optional(),
				gui: displayTransform.optional(),
				head: displayTransform.optional(),
				ground: displayTransform.optional(),
				fixed: displayTransform.optional(),
				on_shelf: displayTransform.optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

const index = z.number().int().min(0);

export const modelOperationSchema = z.discriminatedUnion("op", [
	z
		.object({
			op: z.literal("set_parent"),
			parent: z.string().min(1).nullable(),
		})
		.strict(),
	z
		.object({
			op: z.literal("set_property"),
			ambientocclusion: z.boolean().nullable().optional(),
			guiLight: z.enum(["front", "side"]).nullable().optional(),
		})
		.strict(),
	z
		.object({
			op: z.literal("set_texture"),
			name: z.string().min(1),
			value: textureEntry,
		})
		.strict(),
	z
		.object({ op: z.literal("remove_texture"), name: z.string().min(1) })
		.strict(),
	z
		.object({
			op: z.literal("add_element"),
			element: elementSpec,
			index: index.optional(),
		})
		.strict(),
	z
		.object({
			op: z.literal("update_element"),
			index,
			changes: z
				.object({
					name: z.string().nullable().optional(),
					from: vec3.optional(),
					to: vec3.optional(),
					rotation: elementRotation.nullable().optional(),
					shade: z.boolean().nullable().optional(),
					shadeDirectionOverride: direction.nullable().optional(),
					lightEmission: z.number().int().min(0).max(15).nullable().optional(),
				})
				.strict(),
		})
		.strict(),
	z.object({ op: z.literal("remove_element"), index }).strict(),
	z
		.object({
			op: z.literal("add_face"),
			element: index,
			face: direction,
			value: faceSpec,
		})
		.strict(),
	z
		.object({
			op: z.literal("update_face"),
			element: index,
			face: direction,
			changes: z
				.object({
					texture: z.string().min(1).optional(),
					uv: uv4.nullable().optional(),
					rotation: faceRotation.nullable().optional(),
					cullface: direction.nullable().optional(),
					tintindex: z.number().int().nullable().optional(),
				})
				.strict(),
		})
		.strict(),
	z
		.object({ op: z.literal("remove_face"), element: index, face: direction })
		.strict(),
	z
		.object({
			op: z.literal("set_display"),
			position: displayPosition,
			value: displayTransform,
		})
		.strict(),
	z
		.object({ op: z.literal("remove_display"), position: displayPosition })
		.strict(),
]);

const blockstateEntry = z
	.object({
		model: z.string().min(1),
		x: faceRotation.optional(),
		y: faceRotation.optional(),
		z: faceRotation.optional(),
		uvlock: z.boolean().optional(),
		weight: z.number().int().min(1).optional(),
	})
	.strict();

export const modelBindingSchema = z
	.object({
		item: z
			.object({
				itemId: z.string().min(1),
				modelId: z.string().min(1),
				handAnimationOnSwap: z.boolean().optional(),
				oversizedInGui: z.boolean().optional(),
				swapAnimationScale: z.number().optional(),
			})
			.strict()
			.optional(),
		blockstate: z
			.object({
				blockId: z.string().min(1),
				variants: z
					.record(
						z.string(),
						z.union([blockstateEntry, z.array(blockstateEntry).min(1)]),
					)
					.optional(),
				multipart: z
					.array(
						z
							.object({
								when: z
									.record(z.string(), z.union([z.string(), z.boolean()]))
									.optional(),
								apply: z.union([
									blockstateEntry,
									z.array(blockstateEntry).min(1),
								]),
							})
							.strict(),
					)
					.max(64)
					.optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

export const MODEL_MODES = [
	"inspect",
	"validate",
	"create",
	"apply",
	"export",
	"preview",
] as const;

export const modelAssetInput = {
	mode: z
		.enum(MODEL_MODES)
		.describe(
			"inspect and validate are read-only; create and apply produce a model document; export places a model and optional bindings; preview renders a diagnostic three-view PNG.",
		),
	inputPath: z
		.string()
		.min(1)
		.optional()
		.describe("Model JSON file for inspect, validate, apply, export."),
	spec: modelSpecSchema
		.optional()
		.describe("create: explicit model description."),
	operations: z
		.array(modelOperationSchema)
		.min(1)
		.max(1000)
		.optional()
		.describe(
			"apply: ordered typed operations; all validated before any result exists.",
		),
	binding: modelBindingSchema
		.optional()
		.describe(
			"export: item definition and/or blockstate to generate next to the model.",
		),
	packPath: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Resource pack root: the current layer; also fixes the model id of inputPath.",
		),
	vanillaPath: z
		.string()
		.min(1)
		.optional()
		.describe("Vanilla assets directory used to resolve minecraft references."),
	dependencyPaths: z
		.array(z.string().min(1))
		.optional()
		.describe(
			"Dependency pack roots; the first entry has the highest priority.",
		),
	minecraftVersion: minecraftVersionField,
	resourcePackVersion: resourcePackVersionField,
	outputPath: z
		.string()
		.min(1)
		.optional()
		.describe("Explicit .json path for the model (create, apply, export)."),
	itemOutputPath: z
		.string()
		.min(1)
		.optional()
		.describe(
			"export: explicit .json path for the item definition (needs binding.item).",
		),
	blockstateOutputPath: z
		.string()
		.min(1)
		.optional()
		.describe(
			"export: explicit .json path for the blockstate (needs binding.blockstate).",
		),
	size: z
		.literal(64)
		.or(z.literal(128))
		.or(z.literal(256))
		.optional()
		.describe(
			"preview only: panel edge in pixels, one of 64, 128, or 256 (default 64).",
		),
	outputPngPath: z
		.string()
		.min(1)
		.optional()
		.describe(
			"preview only: explicit .png path. When omitted nothing is written and the image is returned as a standard image block.",
		),
};

export const compareAssetsInput = {
	beforePath: z.string().min(1),
	afterPath: z.string().min(1),
	image: z.enum(["none", "diff"]).optional(),
	scale: z.number().int().min(1).max(16).optional(),
	outputPath: z.string().min(1).optional(),
	force: z.boolean().optional(),
	mkdir: z.boolean().optional(),
};
export type CompareAssetsInput = z.infer<
	z.ZodObject<typeof compareAssetsInput>
>;

export const mcmetaAssetInput = {
	mode: z
		.enum(["animation", "gui"])
		.describe("animation writes an animation section; gui a gui.scaling one."),
	inputPath: z.string().min(1).describe("PNG path; read only, never written."),
	frameSize: z
		.string()
		.min(1)
		.optional()
		.describe("animation: frame size N or WxH (required)."),
	frametime: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe("animation: ticks per frame, default 1."),
	frames: z
		.array(
			z.union([
				z.number().int().min(0),
				z.object({
					index: z.number().int().min(0),
					time: z.number().int().min(1).optional(),
				}),
			]),
		)
		.optional()
		.describe(
			"animation: playback order of indices and/or {index,time}; repeats and partial lists are valid. Omitted means all frames in order.",
		),
	interpolate: z.boolean().optional().describe("animation: blend frames."),
	type: z
		.enum(["stretch", "tile", "nine_slice"])
		.optional()
		.describe("gui: scaling type (required)."),
	border: z
		.union([
			z.number().int().min(0),
			z.object({
				left: z.number().int().min(0),
				top: z.number().int().min(0),
				right: z.number().int().min(0),
				bottom: z.number().int().min(0),
			}),
		])
		.optional()
		.describe("gui nine_slice: border N or per-side object (required there)."),
	stretchInner: z
		.boolean()
		.optional()
		.describe("gui nine_slice only: stretch the inner bands."),
	minecraftVersion: minecraftVersionField,
	resourcePackVersion: resourcePackVersionField,
	outputPath: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Explicit .mcmeta path. When omitted nothing is written and the document text is returned.",
		),
	force: z
		.boolean()
		.optional()
		.describe("Replace an existing outputPath file as a whole."),
	mkdir: z.boolean().optional().describe("Create missing parent directories."),
};

export const NEW_MCP_TOOL_NAMES = ["optimize_asset", "model_asset"] as const;
export type OptimizeAssetInput = z.infer<
	z.ZodObject<typeof optimizeAssetInput>
>;
export type McmetaAssetInput = z.infer<z.ZodObject<typeof mcmetaAssetInput>>;
export type ModelAssetInput = z.infer<z.ZodObject<typeof modelAssetInput>>;

export const TOOL_INPUT_SCHEMAS = {
	optimize_asset: optimizeAssetInput,
	model_asset: modelAssetInput,
	mcmeta_asset: mcmetaAssetInput,
	compare_assets: compareAssetsInput,
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
		feedback: feedbackField,
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
			.enum(["nearest", "box", "pixel-aware"])
			.optional()
			.describe("Resize sampling: nearest, box, or pixel-aware."),
		selection: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Scope operations to a selection expression: all, rect:x,y,w,h, region:id, alpha[:layer], color[:layer]:r,g,b,a, connected[:layer]:x,y, or a JSON expression object with op union|intersect|subtract|invert and operands [...]; cannot be combined with geometry operations (ARGUMENT_CONFLICT).",
			),
		profile: profileField,
		outputPngPath: outputPngField,
		outputMcpxPath: outputMcpxField,
	},
	quantize_asset: {
		inputPath: z
			.string()
			.min(1)
			.describe("Raster image or .mcpx path to quantize."),
		colors: z.number().optional().describe("Target distinct color count."),
		palette: z
			.string()
			.min(1)
			.optional()
			.describe("Explicit palette source (builtin material id or .mcpx path)."),
		keepColors: z
			.array(
				z.object({
					r: z.number().int().min(0).max(255),
					g: z.number().int().min(0).max(255),
					b: z.number().int().min(0).max(255),
					a: z.number().int().min(0).max(255),
				}),
			)
			.optional()
			.describe("Reserved RGBA colors kept byte-identical."),
		selection: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Scope operations to a selection expression: all, rect:x,y,w,h, region:id, alpha[:layer], color[:layer]:r,g,b,a, connected[:layer]:x,y, or a JSON expression object with op union|intersect|subtract|invert and operands [...].",
			),
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
			.describe(
				"Scope operations to a selection expression: all, rect:x,y,w,h, region:id, alpha[:layer], color[:layer]:r,g,b,a, connected[:layer]:x,y, or a JSON expression object with op union|intersect|subtract|invert and operands [...].",
			),
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
			.describe(
				"Sheet layout: vertical, horizontal, or grid. Required for pack, unpack, and preview.",
			),
		columns: z.number().optional().describe("Grid column count."),
		frameSize: z.string().min(1).optional().describe("Frame size as N or WxH."),
		resizeMode: z
			.enum(["nearest", "box", "pixel-aware"])
			.optional()
			.describe("Resize sampling: nearest, box, or pixel-aware."),
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
		vanillaPath: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Vanilla assets directory used to resolve minecraft references.",
			),
		dependencyPaths: z
			.array(z.string().min(1))
			.optional()
			.describe(
				"Dependency pack roots; the first entry has the highest priority.",
			),
	},
	scale_gui_asset: {
		inputPath: z
			.string()
			.min(1)
			.describe("Raster image or .mcpx path to scale as a GUI sprite."),
		size: z.string().min(1).describe("Target size: N or WxH."),
		mcmetaPath: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Explicit .mcmeta path for the scaling section, used verbatim; omitted means stretch.",
			),
		minecraftVersion: minecraftVersionField,
		resourcePackVersion: resourcePackVersionField,
		outputPngPath: outputPngField,
	},
	inspect_asset: {
		inputPath: z
			.string()
			.min(1)
			.describe(
				"Editable .mcpx source or raster image path to inspect; raster inputs read as a single base layer. Never written.",
			),
		mode: z
			.enum(["structure", "view"])
			.describe(
				"Inspect mode: structure for layers, regions, color usage, and overlaps; view for the composited PNG plus metadata.",
			),
		crop: z
			.unknown()
			.optional()
			.describe(
				"View-only selection expression (atom string or JSON expression object) naming the crop; an empty match refuses with EMPTY_SELECTION.",
			),
		scale: z
			.number()
			.int()
			.min(1)
			.max(16)
			.optional()
			.describe(
				"View-only integer upscale factor 1-16 with nearest sampling; omitted means 1.",
			),
	},
	style_asset: {
		mode: z
			.enum(["list", "show", "export-palette", "create"])
			.describe("Style subcommand: list, show, export-palette, or create."),
		paths: z
			.array(z.string().min(1))
			.optional()
			.describe(
				"list only: custom .style.json paths to report alongside the builtin presets; each one loads or is reported as unreadable.",
			),
		style: z
			.string()
			.min(1)
			.optional()
			.describe(
				"show and export-palette: builtin style id or a .style.json path.",
			),
		family: z
			.string()
			.min(1)
			.optional()
			.describe("export-palette only: family id, or all for every family."),
		outputMcpxPath: z
			.string()
			.min(1)
			.optional()
			.describe(
				"export-palette only: explicit .mcpx output path. When omitted the palette text returns in the result and nothing is written.",
			),
		outputPath: z
			.string()
			.min(1)
			.optional()
			.describe("create only: explicit .style.json output path."),
		id: z.string().min(1).optional().describe("create only: style id."),
		name: z
			.string()
			.min(1)
			.optional()
			.describe("create only: display name; defaults to the id."),
		extends: z
			.string()
			.min(1)
			.optional()
			.describe(
				"create only: builtin id or .style.json path to inherit; defaults to vanilla.",
			),
		overrides: z
			.record(z.unknown())
			.optional()
			.describe(
				'create only: style sections merged into the new document, for example {"limits":{"maxColors":12}}.',
			),
		force: z
			.boolean()
			.optional()
			.describe(
				"Replace an existing output file as a whole (export-palette and create).",
			),
		mkdir: z
			.boolean()
			.optional()
			.describe("Create missing parent directories (create)."),
	},
	pack_asset: {
		mode: z.enum(["init"]).describe("Pack subcommand: init."),
		projectDir: z
			.string()
			.min(1)
			.optional()
			.describe("init only: project directory to create the skeleton in."),
		namespace: z
			.string()
			.min(1)
			.optional()
			.describe(
				"init only: resource namespace of the pack; lowercase letters, digits, underscore, dot, and dash.",
			),
		minecraftVersion: z
			.string()
			.min(1)
			.optional()
			.describe(
				'init only: release version 1.19.3 through 26.3 (for example "1.21.9" or "26.3").',
			),
		name: z
			.string()
			.min(1)
			.optional()
			.describe("init only: project name; defaults to the directory name."),
		description: z
			.string()
			.min(1)
			.optional()
			.describe(
				"init only: pack description of 1 to 128 characters; defaults to the name.",
			),
		style: z
			.string()
			.min(1)
			.optional()
			.describe(
				"init only: builtin style id or a .style.json path recorded in the project document; defaults to vanilla.",
			),
		resourcePackVersion: z
			.string()
			.min(1)
			.optional()
			.describe(
				"init only: resource-pack format N or N.M overriding the release version.",
			),
		allowMinecraftNamespace: z
			.boolean()
			.optional()
			.describe(
				"init only: allow the reserved minecraft namespace; refused without it.",
			),
	},
} satisfies Record<McpToolName, Record<string, z.ZodTypeAny>>;
