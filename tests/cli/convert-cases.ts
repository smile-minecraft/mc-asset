import { parseGridFile } from "../../src/cli/grid.ts";
import { parseOperationsJson } from "../../src/cli/operations-json.ts";
import { applyOperations } from "../../src/core/batch.ts";
import { addLayer, createCanvas, getPixel } from "../../src/core/canvas.ts";
import { McAssetError } from "../../src/core/errors.ts";

/** Runner-agnostic assertion surface: bun:test and node:test entries adapt to this. */
export interface CaseCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
}

export interface ConvertCase {
	name: string;
	run(check: CaseCheck): void;
}

function expectCode(
	check: CaseCheck,
	fn: () => unknown,
	code: string,
	path?: string,
): void {
	try {
		fn();
	} catch (error) {
		if (error instanceof McAssetError && error.code === code) {
			if (path !== undefined) {
				const details = error.details as { path?: unknown } | undefined;
				check.equal(details?.path, path, `field path for ${code}`);
			}
			return;
		}
		check.fail(
			`expected McAssetError(${code}) but got ${error instanceof McAssetError ? `${error.code} ${error.message}` : String(error)}`,
		);
	}
	check.fail(`expected McAssetError(${code}) but nothing was thrown`);
}

export const CONVERT_CASES: ConvertCase[] = [
	{
		name: "setPixel parses a hex color into RGBA channels",
		run: (check) => {
			const ops = parseOperationsJson(
				'{"operations": [{"id": "a", "type": "setPixel", "layerId": "base", "x": 1, "y": 2, "color": "#FF0080FF"}]}',
			);
			check.deepEqual(
				ops,
				[
					{
						id: "a",
						type: "setPixel",
						layerId: "base",
						x: 1,
						y: 2,
						color: { r: 255, g: 0, b: 128, a: 255 },
					},
				],
				"typed setPixel",
			);
		},
	},
	{
		name: "six-digit hex defaults alpha to opaque, case-insensitive",
		run: (check) => {
			const ops = parseOperationsJson(
				'[{"type": "setPixel", "layerId": "base", "x": 0, "y": 0, "color": "#adb7c0"}]',
			);
			check.deepEqual(
				(ops[0] as { color: unknown }).color,
				{ r: 173, g: 183, b: 192, a: 255 },
				"opaque gray",
			);
		},
	},
	{
		name: "transparent keyword maps to zero RGBA",
		run: (check) => {
			const ops = parseOperationsJson(
				'[{"type": "setPixel", "layerId": "base", "x": 0, "y": 0, "color": "transparent"}]',
			);
			check.deepEqual(
				(ops[0] as { color: unknown }).color,
				{ r: 0, g: 0, b: 0, a: 0 },
				"transparent",
			);
		},
	},
	{
		name: "missing layerId falls back to the given default layer",
		run: (check) => {
			const ops = parseOperationsJson(
				'[{"type": "clearPixel", "x": 3, "y": 1}]',
				"base",
			);
			check.deepEqual(
				ops,
				[{ type: "clearPixel", layerId: "base", x: 3, y: 1 }],
				"default layerId",
			);
		},
	},
	{
		name: "missing layerId without a default is INVALID_ARGUMENT with path",
		run: (check) => {
			expectCode(
				check,
				() => parseOperationsJson('[{"type": "clearPixel", "x": 0, "y": 0}]'),
				"INVALID_ARGUMENT",
				"operations[0].layerId",
			);
		},
	},
	{
		name: "drawLine maps from/to pairs to endpoints",
		run: (check) => {
			const ops = parseOperationsJson(
				'[{"id": "edge", "type": "drawLine", "layerId": "base", "from": [0, 0], "to": [3, 0], "color": "#FFFFFFFF"}]',
				"base",
			);
			check.deepEqual(
				ops,
				[
					{
						id: "edge",
						type: "drawLine",
						layerId: "base",
						x0: 0,
						y0: 0,
						x1: 3,
						y1: 0,
						color: { r: 255, g: 255, b: 255, a: 255 },
					},
				],
				"typed drawLine",
			);
		},
	},
	{
		name: "fillRect takes a rect object with integer edges",
		run: (check) => {
			const ops = parseOperationsJson(
				'[{"type": "fillRect", "rect": {"x": 1, "y": 1, "width": 2, "height": 2}, "color": "#00FF00FF"}]',
				"base",
			);
			check.deepEqual(
				ops,
				[
					{
						type: "fillRect",
						layerId: "base",
						rect: { x: 1, y: 1, width: 2, height: 2 },
						color: { r: 0, g: 255, b: 0, a: 255 },
					},
				],
				"typed fillRect",
			);
		},
	},
	{
		name: "pixel op keeps its selection expression verbatim",
		run: (check) => {
			const ops = parseOperationsJson(
				'[{"type": "fillRect", "rect": {"x": 0, "y": 0, "width": 2, "height": 2}, "color": "#00FF00FF", "selection": "region:blade"}]',
				"base",
			);
			check.deepEqual(
				(ops[0] as { selection?: unknown }).selection,
				"region:blade",
				"atom string kept",
			);
			const ast = parseOperationsJson(
				'[{"type": "fillRect", "rect": {"x": 0, "y": 0, "width": 2, "height": 2}, "color": "#00FF00FF", "selection": {"op": "subtract", "operands": ["region:blade", "rect:0,0,1,1"]}}]',
				"base",
			);
			check.deepEqual(
				(ast[0] as { selection?: unknown }).selection,
				{
					op: "subtract",
					operands: ["region:blade", "rect:0,0,1,1"],
				},
				"AST object kept",
			);
		},
	},
	{
		name: "fillRect without a rect needs a selection",
		run: (check) => {
			expectCode(
				check,
				() =>
					parseOperationsJson(
						'[{"type": "fillRect", "color": "#00FF00FF"}]',
						"base",
					),
				"INVALID_ARGUMENT",
				"operations[0].rect",
			);
			const ops = parseOperationsJson(
				'[{"type": "fillRect", "color": "#00FF00FF", "selection": "rect:0,0,2,2"}]',
				"base",
			);
			check.equal(ops.length, 1, "selection-backed fillRect parses");
		},
	},
	{
		name: "stampRect parses source placement and merge",
		run: (check) => {
			const ops = parseOperationsJson(
				'[{"type": "stampRect", "layerId": "base", "source": "rect:0,0,2,2", "offset": {"dx": 1, "dy": 0}, "merge": "replace"}]',
				"base",
			);
			check.deepEqual(
				ops,
				[
					{
						type: "stampRect",
						layerId: "base",
						source: "rect:0,0,2,2",
						offset: { dx: 1, dy: 0 },
						merge: "replace",
					},
				],
				"typed stampRect",
			);
			expectCode(
				check,
				() =>
					parseOperationsJson(
						'[{"type": "stampRect", "to": {"x": 2, "y": 2}}]',
						"base",
					),
				"INVALID_ARGUMENT",
				"operations[0].source",
			);
		},
	},
	{
		name: "regionFromSelection needs no top-level layerId",
		run: (check) => {
			// Multi-layer canvases have no default layer; regionFromSelection
			// carries no layerId by contract, so parsing must not ask for one.
			const ops = parseOperationsJson(
				'[{"type": "regionFromSelection", "selection": "rect:0,0,1,1", "mode": "create", "regionId": "body"}]',
				undefined,
			);
			check.deepEqual(
				ops,
				[
					{
						type: "regionFromSelection",
						selection: "rect:0,0,1,1",
						mode: "create",
						regionId: "body",
					},
				],
				"typed regionFromSelection without layerId",
			);
			const regionOps = parseOperationsJson(
				'[{"type": "removeRegion", "regionId": "body"}]',
				undefined,
			);
			check.deepEqual(
				regionOps,
				[{ type: "removeRegion", regionId: "body" }],
				"region ops take no layerId either",
			);
		},
	},
	{
		name: "regionFromSelection parses and applies on a multi-layer canvas",
		run: (check) => {
			// The same parse entry the MCP handler uses: no default layer on
			// a multi-layer canvas, and no top-level layerId by contract.
			const ops = parseOperationsJson(
				'[{"type": "regionFromSelection", "selection": "rect:0,0,2,2", "mode": "create", "regionId": "body"}]',
				undefined,
			);
			const canvas = createCanvas(4, 4);
			addLayer(canvas, { id: "a" });
			addLayer(canvas, { id: "b" });
			const report = applyOperations(canvas, ops);
			check.equal(report.applied, 1, "applied with two layers present");
			check.deepEqual(
				canvas.regions.map((region) => region.id),
				["body"],
				"region created",
			);
			check.equal(canvas.regions[0]?.mask[0], 1, "mask set");
			check.equal(
				canvas.regions[0]?.mask[3 * 4 + 3],
				0,
				"outside the read scope stays clear",
			);
		},
	},
	{
		name: "regionFromSelection parses selection with mode",
		run: (check) => {
			const ops = parseOperationsJson(
				'[{"type": "regionFromSelection", "selection": "alpha:base", "mode": "create", "regionId": "body"}]',
				"base",
			);
			check.deepEqual(
				ops,
				[
					{
						type: "regionFromSelection",
						selection: "alpha:base",
						mode: "create",
						regionId: "body",
					},
				],
				"typed regionFromSelection",
			);
		},
	},
	{
		name: "ellipse parses rect color mode and selection",
		run: (check) => {
			const ops = parseOperationsJson(
				'[{"id": "ring", "type": "ellipse", "layerId": "base", "rect": {"x": 8, "y": 8, "width": 16, "height": 12}, "color": "#C8C8C8", "mode": "outline", "selection": "rect:0,0,16,32"}]',
				"base",
			);
			check.deepEqual(
				ops,
				[
					{
						id: "ring",
						type: "ellipse",
						layerId: "base",
						rect: { x: 8, y: 8, width: 16, height: 12 },
						color: { r: 200, g: 200, b: 200, a: 255 },
						mode: "outline",
						selection: "rect:0,0,16,32",
					},
				],
				"typed ellipse",
			);
		},
	},
	{
		name: "ellipse rejects an unknown mode with path",
		run: (check) => {
			expectCode(
				check,
				() =>
					parseOperationsJson(
						'[{"type": "ellipse", "rect": {"x": 0, "y": 0, "width": 4, "height": 4}, "color": "#FFFFFFFF", "mode": "dashed"}]',
						"base",
					),
				"INVALID_ARGUMENT",
				"operations[0].mode",
			);
		},
	},
	{
		name: "ellipse without a rect is INVALID_ARGUMENT with path",
		run: (check) => {
			expectCode(
				check,
				() =>
					parseOperationsJson(
						'[{"type": "ellipse", "color": "#FFFFFFFF", "mode": "fill"}]',
						"base",
					),
				"INVALID_ARGUMENT",
				"operations[0].rect",
			);
		},
	},
	{
		name: "polygonFill parses points and color",
		run: (check) => {
			const ops = parseOperationsJson(
				'[{"type": "polygonFill", "layerId": "base", "points": [[4, 4], [28, 4], [16, 28]], "color": "#787878"}]',
				"base",
			);
			check.deepEqual(
				ops,
				[
					{
						type: "polygonFill",
						layerId: "base",
						points: [
							{ x: 4, y: 4 },
							{ x: 28, y: 4 },
							{ x: 16, y: 28 },
						],
						color: { r: 120, g: 120, b: 120, a: 255 },
					},
				],
				"typed polygonFill",
			);
		},
	},
	{
		name: "polygonFill rejects malformed points with path",
		run: (check) => {
			expectCode(
				check,
				() =>
					parseOperationsJson(
						'[{"type": "polygonFill", "color": "#787878"}]',
						"base",
					),
				"INVALID_ARGUMENT",
				"operations[0].points",
			);
			expectCode(
				check,
				() =>
					parseOperationsJson(
						'[{"type": "polygonFill", "points": [[4, 4], [28]], "color": "#787878"}]',
						"base",
					),
				"INVALID_ARGUMENT",
				"operations[0].points[1]",
			);
		},
	},
	{
		name: "polygonFill over 4096 points fails before point normalization",
		run: (check) => {
			const pairs: Array<[number, number]> = [];
			for (let i = 0; i < 4097; i += 1) {
				pairs.push([i % 64, (i / 64) | 0]);
			}
			const text = JSON.stringify({
				operations: [
					{
						type: "polygonFill",
						layerId: "base",
						points: pairs,
						color: "#787878",
					},
				],
			});
			try {
				parseOperationsJson(text, "base");
				check.fail("expected the oversized polygon to throw");
			} catch (error) {
				if (!(error instanceof McAssetError)) {
					check.fail(`expected McAssetError but got ${String(error)}`);
				}
				const err = error as McAssetError;
				check.equal(
					err.code,
					"RESOURCE_LIMIT_EXCEEDED",
					"oversized polygon code",
				);
				const details = err.details as
					| { path?: unknown; count?: unknown; limit?: unknown }
					| undefined;
				check.equal(
					details?.path,
					"operations[0].points",
					"actionable operations path",
				);
				check.equal(details?.count, 4097, "actual point count");
				check.equal(details?.limit, 4096, "frozen point limit");
			}
		},
	},
	{
		name: "strokeMask parses source color and selection",
		run: (check) => {
			const ops = parseOperationsJson(
				'[{"type": "strokeMask", "layerId": "base", "source": "region:badge", "color": "#000000"}]',
				"base",
			);
			check.deepEqual(
				ops,
				[
					{
						type: "strokeMask",
						layerId: "base",
						source: "region:badge",
						color: { r: 0, g: 0, b: 0, a: 255 },
					},
				],
				"typed strokeMask",
			);
			const scoped = parseOperationsJson(
				'[{"type": "strokeMask", "layerId": "base", "source": "alpha:overlay", "color": "#000000", "selection": "rect:0,0,16,32"}]',
				"base",
			);
			check.deepEqual(
				(scoped[0] as { selection?: unknown }).selection,
				"rect:0,0,16,32",
				"destination clip kept",
			);
		},
	},
	{
		name: "strokeMask needs a source with path",
		run: (check) => {
			expectCode(
				check,
				() =>
					parseOperationsJson(
						'[{"type": "strokeMask", "color": "#000000"}]',
						"base",
					),
				"INVALID_ARGUMENT",
				"operations[0].source",
			);
		},
	},
	{
		name: "ellipse with fractional dimensions parses for the core to classify",
		run: (check) => {
			const ops = parseOperationsJson(
				'[{"type": "ellipse", "rect": {"x": 0, "y": 0, "width": 4.5, "height": 4}, "color": "#FFFFFFFF", "mode": "fill"}]',
				"base",
			);
			check.deepEqual(
				(ops[0] as { rect: unknown }).rect,
				{ x: 0, y: 0, width: 4.5, height: 4 },
				"fraction preserved for the typed validator",
			);
			const canvas = createCanvas(16, 16);
			addLayer(canvas, { id: "base" });
			expectCode(
				check,
				() => applyOperations(canvas, ops),
				"INVALID_DIMENSION",
			);
		},
	},
	{
		name: "ellipse rejects non-number rect fields with path",
		run: (check) => {
			expectCode(
				check,
				() =>
					parseOperationsJson(
						'[{"type": "ellipse", "rect": {"x": 0, "y": 0, "width": "wide", "height": 4}, "color": "#FFFFFFFF", "mode": "fill"}]',
						"base",
					),
				"INVALID_ARGUMENT",
				"operations[0].rect.width",
			);
			expectCode(
				check,
				() =>
					parseOperationsJson(
						'[{"type": "ellipse", "rect": {"x": 0, "y": 0, "height": 4}, "color": "#FFFFFFFF", "mode": "fill"}]',
						"base",
					),
				"INVALID_ARGUMENT",
				"operations[0].rect.width",
			);
		},
	},
	{
		name: "unknown operation kind is INVALID_ARGUMENT with path",
		run: (check) => {
			expectCode(
				check,
				() =>
					parseOperationsJson('[{"type": "smear", "x": 0, "y": 0}]', "base"),
				"INVALID_ARGUMENT",
				"operations[0].type",
			);
		},
	},
	{
		name: "illegal hex is INVALID_ARGUMENT with path",
		run: (check) => {
			expectCode(
				check,
				() =>
					parseOperationsJson(
						'[{"type": "setPixel", "x": 0, "y": 0, "color": "not-a-color"}]',
						"base",
					),
				"INVALID_ARGUMENT",
				"operations[0].color",
			);
			expectCode(
				check,
				() =>
					parseOperationsJson(
						'[{"type": "setPixel", "x": 0, "y": 0, "color": "#FFF"}]',
						"base",
					),
				"INVALID_ARGUMENT",
				"operations[0].color",
			);
		},
	},
	{
		name: "non-integer coordinate is INVALID_ARGUMENT with path",
		run: (check) => {
			expectCode(
				check,
				() =>
					parseOperationsJson(
						'[{"type": "setPixel", "x": 1.5, "y": 0, "color": "#FFFFFFFF"}]',
						"base",
					),
				"INVALID_ARGUMENT",
				"operations[0].x",
			);
		},
	},
	{
		name: "missing color is INVALID_ARGUMENT with path",
		run: (check) => {
			expectCode(
				check,
				() =>
					parseOperationsJson('[{"type": "setPixel", "x": 0, "y": 0}]', "base"),
				"INVALID_ARGUMENT",
				"operations[0].color",
			);
		},
	},
	{
		name: "malformed from pair is INVALID_ARGUMENT with path",
		run: (check) => {
			expectCode(
				check,
				() =>
					parseOperationsJson(
						'[{"type": "drawLine", "from": [0], "to": [3, 0], "color": "#FFFFFFFF"}]',
						"base",
					),
				"INVALID_ARGUMENT",
				"operations[0].from",
			);
		},
	},
	{
		name: "bare array and envelope both parse; empty is a no-op",
		run: (check) => {
			check.deepEqual(parseOperationsJson("[]", "base"), [], "bare empty");
			check.deepEqual(
				parseOperationsJson('{"operations": []}', "base"),
				[],
				"envelope empty",
			);
		},
	},
	{
		name: "malformed JSON body is INVALID_ARGUMENT",
		run: (check) => {
			expectCode(
				check,
				() => parseOperationsJson("{oops", "base"),
				"INVALID_ARGUMENT",
				"operations",
			);
		},
	},
	{
		name: "non-array operations body is INVALID_ARGUMENT",
		run: (check) => {
			expectCode(
				check,
				() => parseOperationsJson('{"operations": {}}', "base"),
				"INVALID_ARGUMENT",
				"operations",
			);
		},
	},
	{
		name: "minimal grid builds a single-layer canvas with exact pixels",
		run: (check) => {
			const canvas = parseGridFile(
				"[palette]\n. = transparent\nS = #ADB7C0FF\n\n[grid]\n.S\nSS\n",
			);
			check.equal(canvas.width, 2, "width from rows");
			check.equal(canvas.height, 2, "height from rows");
			check.equal(canvas.layers.length, 1, "single layer");
			check.equal(canvas.layers[0]?.id, "base", "layer id");
			check.deepEqual(
				getPixel(canvas, "base", 0, 0),
				{ r: 0, g: 0, b: 0, a: 0 },
				"transparent dot",
			);
			check.deepEqual(
				getPixel(canvas, "base", 1, 0),
				{ r: 173, g: 183, b: 192, a: 255 },
				"steel pixel",
			);
		},
	},
	{
		name: "tokenized grid rows split on single spaces",
		run: (check) => {
			const canvas = parseGridFile(
				"[palette]\nT01 = #FF0000FF\nT02 = #00FF00FF\n\n[grid tokens]\nT01 T02\nT02 T01\n",
			);
			check.equal(canvas.width, 2, "token width");
			check.equal(canvas.height, 2, "token height");
			check.deepEqual(
				getPixel(canvas, "base", 0, 0),
				{ r: 255, g: 0, b: 0, a: 255 },
				"red token",
			);
		},
	},
	{
		name: "grid without a palette section is MCPX_SYNTAX_ERROR",
		run: (check) => {
			expectCode(
				check,
				() => parseGridFile("[grid]\n..\n..\n"),
				"MCPX_SYNTAX_ERROR",
			);
		},
	},
	{
		name: "comment lines inside grid data are MCPX_SYNTAX_ERROR",
		run: (check) => {
			expectCode(
				check,
				() =>
					parseGridFile(
						"[palette]\n. = transparent\n\n[grid]\n..\n; stray\n..\n",
					),
				"MCPX_SYNTAX_ERROR",
			);
		},
	},
	{
		name: "ragged grid rows are INVALID_GRID_SIZE",
		run: (check) => {
			expectCode(
				check,
				() => parseGridFile("[palette]\n. = transparent\n\n[grid]\n...\n..\n"),
				"INVALID_GRID_SIZE",
			);
		},
	},
	{
		name: "unknown grid sections are MCPX_SYNTAX_ERROR",
		run: (check) => {
			expectCode(
				check,
				() => parseGridFile("[palette]\n. = transparent\n\n[region r]\n..\n"),
				"MCPX_SYNTAX_ERROR",
			);
		},
	},
];
