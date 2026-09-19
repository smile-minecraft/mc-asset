import { parseGridFile } from "../../src/cli/grid.ts";
import { parseOperationsJson } from "../../src/cli/operations-json.ts";
import { getPixel } from "../../src/core/canvas.ts";
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
