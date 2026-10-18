import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputStreams } from "../../src/cli/channels.ts";
import { runGenerate } from "../../src/cli/cmd-generate.ts";
import { runQuantize } from "../../src/cli/cmd-quantize.ts";
import { runStyle, type StyleOptions } from "../../src/cli/cmd-style.ts";
import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../src/core/canvas.ts";
import type { McAssetError } from "../../src/core/errors.ts";
import type { RGBA } from "../../src/core/types.ts";
import { decodePng, encodePng, flattenCanvas } from "../../src/io/png.ts";
import { handleStyleAsset } from "../../src/mcp/handlers.ts";
import { parseMcpx } from "../../src/mcpx/index.ts";
import { buildPaletteMcpx } from "../../src/style/export-palette.ts";
import { resolveStyle } from "../../src/style/load.ts";
import { listStylePresets } from "../../src/style/presets.ts";
import type { ResolvedStyle } from "../../src/style/types.ts";
import {
	COMPLETION_FAMILIES,
	EXPECTED_CATEGORY_OVERRIDES,
	EXPECTED_FAMILY_ORDER,
	EXPECTED_PALETTES,
	EXPECTED_PRESET_IDS,
	EXPECTED_PRESET_NAMES,
	EXPECTED_RAMP_ROLES,
	EXPECTED_RULES,
	EXPECTED_SATURATED_COMPLETION,
	EXPECTED_SHADOW_COMPLETION,
	type ExpectedPalette,
	type ExpectedRamp,
	expectedAllPaletteEntries,
	expectedFamilyMcpx,
} from "./style-expectations.ts";

/**
 * Style preset, palette library, and style file cases. Every expectation
 * comes from the frozen spec tables in `style-expectations.ts`, so the
 * shipped constants can never move the target with them.
 */

interface StyleCase {
	name: string;
	run(): void | Promise<void>;
}

/** A refused call: the code, the message, and the structured details. */
interface Refusal {
	code: string;
	message: string;
	details: Record<string, unknown> | null;
}

interface ToolResult {
	isError?: boolean;
	content: { type: string; text?: string }[];
}

async function captureRefusal(
	body: () => unknown | Promise<unknown>,
): Promise<Refusal | null> {
	try {
		await body();
		return null;
	} catch (error) {
		const failure = error as McAssetError;
		return {
			code: failure.code ?? "UNKNOWN",
			message: failure.message ?? String(error),
			details:
				typeof failure.details === "object" && failure.details !== null
					? (failure.details as Record<string, unknown>)
					: null,
		};
	}
}

/** Assert a refusal carries the code and field path a caller localizes on. */
function assertRefusal(
	refusal: Refusal | null,
	code: string,
	field: string,
): Refusal {
	assert.ok(refusal !== null, `expected a ${code} refusal`);
	const actual = refusal as Refusal;
	assert.equal(actual.code, code);
	const details = actual.details;
	assert.ok(details !== null, `${code} carries details`);
	assert.equal(details?.field, field, `${code} names the field path`);
	return actual;
}

/** Parse JSON without throwing, so a wrong payload fails as an assertion. */
function jsonOrNull(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

/** Alpha-aware hex: opaque colors keep the six-digit form, others carry alpha. */
function toHexString(color: RGBA): string {
	const byte = (value: number): string =>
		value.toString(16).padStart(2, "0").toUpperCase();
	const opaque = color.a === 255;
	return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}${opaque ? "" : byte(color.a)}`;
}

/** Write style files into a scratch directory and run the body with it. */
async function withStyleDir(
	files: Record<string, string>,
	body: (dir: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-style-"));
	try {
		for (const [name, content] of Object.entries(files)) {
			await writeFile(join(dir, name), content, "utf8");
		}
		await body(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function styleDocument(fields: Record<string, unknown>): string {
	return `${JSON.stringify({ formatVersion: 1, ...fields }, null, 2)}\n`;
}

function rampOf(styleId: string, family: string): ExpectedRamp {
	const table = EXPECTED_PALETTES[styleId] as ExpectedPalette;
	return table[family] as ExpectedRamp;
}

function rampValue(ramp: ExpectedRamp, role: string): string {
	return (ramp as unknown as Record<string, string>)[role] as string;
}

/** The rule sections `style show` reports, for one preset comparison. */
function reportedRules(style: ResolvedStyle): unknown {
	return {
		outline: style.outline,
		light: style.light,
		limits: style.limits,
		highlight: style.highlight,
		dither: style.dither,
		animation: style.animation,
	};
}

/** Captured stdout/stderr for a command run in process. */
function captureStreams(): {
	streams: OutputStreams;
	stdout(): string;
	stderr(): string;
} {
	const out: Buffer[] = [];
	const err: Buffer[] = [];
	return {
		streams: {
			stdout: {
				write: (chunk: string | Uint8Array): boolean => {
					out.push(Buffer.from(chunk as string));
					return true;
				},
			},
			stderr: {
				write: (chunk: string | Uint8Array): boolean => {
					err.push(Buffer.from(chunk as string));
					return true;
				},
			},
		},
		stdout: () => Buffer.concat(out).toString("utf8"),
		stderr: () => Buffer.concat(err).toString("utf8"),
	};
}

/**
 * `mc-asset quantize` / `mc-asset generate` as the CLI runs them, through
 * the same command entry the CLI wires up, so the exported palette is
 * checked against the real readers without spawning a process.
 */
async function runQuantizeCommand(
	args: string[],
): Promise<{ code: number; stderr: string }> {
	const capture = captureStreams();
	const code = await runQuantize(
		args[0],
		{ palette: args[1], output: args[2] },
		false,
		capture.streams,
	);
	return { code, stderr: capture.stderr() };
}

async function runGenerateCommand(
	args: string[],
): Promise<{ code: number; stderr: string }> {
	const capture = captureStreams();
	const code = await runGenerate(
		args[0],
		{ size: args[1], palette: args[2], seed: args[3], output: args[4] },
		false,
		capture.streams,
	);
	return { code, stderr: capture.stderr() };
}

/** One `mc-asset style ...` run in process, through the command entry. */
async function runStyleCommand(
	mode: string,
	source: string | undefined,
	options: StyleOptions,
): Promise<{ code: number; body: Record<string, unknown> }> {
	const capture = captureStreams();
	const code = await runStyle(mode, source, options, true, capture.streams);
	return {
		code,
		body: handlerBody({
			content: [{ type: "text", text: capture.stdout() }],
		}),
	};
}

function handlerBody(result: ToolResult): Record<string, unknown> {
	const first = result.content[0];
	const parsed = jsonOrNull(first?.text ?? "");
	return typeof parsed === "object" && parsed !== null
		? (parsed as Record<string, unknown>)
		: {};
}

/** Original 4x4 swatch: four colors no exported palette carries. */
function testSwatch() {
	const canvas = createCanvas(4, 4);
	const layer = addLayer(canvas, { id: "base" });
	const colors = ["#203040", "#40A060", "#B05030", "#F0E0A0"];
	const pixels = new Uint8Array(4 * 4 * 4);
	for (let index = 0; index < 16; index += 1) {
		const hex = colors[index % colors.length] as string;
		pixels[index * 4] = Number.parseInt(hex.slice(1, 3), 16);
		pixels[index * 4 + 1] = Number.parseInt(hex.slice(3, 5), 16);
		pixels[index * 4 + 2] = Number.parseInt(hex.slice(5, 7), 16);
		pixels[index * 4 + 3] = 255;
	}
	replaceLayerPixels(canvas, layer.id, pixels);
	return canvas;
}

/** The reserved transparent entry every exported palette opens with. */
const TRANSPARENT_PALETTE_ENTRY = "#00000000";

/** Colors of a written PNG that the exported palette does not declare. */
async function foreignColors(
	path: string,
	allowed: ReadonlySet<string>,
): Promise<string[]> {
	const canvas = decodePng(new Uint8Array(await readFile(path))).canvas;
	const flat = flattenCanvas(canvas);
	const outside = new Set<string>();
	for (let offset = 0; offset + 3 < flat.length; offset += 4) {
		const hex = toHexString({
			r: (flat[offset] ?? 0) as number,
			g: (flat[offset + 1] ?? 0) as number,
			b: (flat[offset + 2] ?? 0) as number,
			a: (flat[offset + 3] ?? 0) as number,
		});
		if (!allowed.has(hex)) outside.add(hex);
	}
	return [...outside].sort();
}

const RESOLVED_KEYS = [
	"animation",
	"categoryOverrides",
	"description",
	"dither",
	"extendsChain",
	"formatVersion",
	"highlight",
	"id",
	"light",
	"limits",
	"name",
	"outline",
	"palettes",
];

const SANDSTONE_RAMP = {
	outline: "#2A2018",
	shadow: "#4C3B28",
	dark: "#6E5436",
	base: "#8C6B44",
	light: "#A98355",
	highlight: "#C9A472",
};

export const STYLE_CASES: StyleCase[] = [
	{
		name: "style list names the four builtin presets with names and descriptions",
		async run() {
			const presets = listStylePresets();
			assert.deepEqual(
				presets.map((preset) => preset.id),
				EXPECTED_PRESET_IDS,
			);
			assert.deepEqual(
				presets.map((preset) => preset.name),
				EXPECTED_PRESET_IDS.map((id) => EXPECTED_PRESET_NAMES[id]),
			);
			for (const preset of presets) {
				assert.equal(typeof preset.description, "string");
				assert.ok(preset.description.length > 0, `${preset.id} description`);
			}
		},
	},
	{
		name: "every builtin preset resolves twelve families with the six frozen ramp roles",
		async run() {
			for (const id of EXPECTED_PRESET_IDS) {
				const style = await resolveStyle(id);
				assert.deepEqual(
					Object.keys(style.palettes).sort(),
					[...EXPECTED_FAMILY_ORDER].sort(),
					`${id} family set`,
				);
				assert.deepEqual(
					style.palettes,
					EXPECTED_PALETTES[id] as unknown as ResolvedStyle["palettes"],
					`${id} ramps`,
				);
				for (const family of EXPECTED_FAMILY_ORDER) {
					const ramp = style.palettes[family];
					assert.ok(ramp !== undefined, `${id} carries ${family}`);
					assert.deepEqual(
						Object.keys(ramp),
						EXPECTED_RAMP_ROLES,
						`${id}.${family} ramp order`,
					);
				}
			}
		},
	},
	{
		name: "builtin presets resolve the frozen outline, light, limits, highlight, dither, and animation values",
		async run() {
			for (const id of EXPECTED_PRESET_IDS) {
				const style = await resolveStyle(id);
				assert.equal(style.id, id, `${id} id`);
				assert.equal(style.formatVersion, 1, `${id} format version`);
				assert.deepEqual(
					reportedRules(style),
					EXPECTED_RULES[id],
					`${id} rules`,
				);
			}
		},
	},
	{
		name: "builtin presets carry the frozen per-category override tables",
		async run() {
			for (const id of EXPECTED_PRESET_IDS) {
				const style = await resolveStyle(id);
				assert.deepEqual(
					style.categoryOverrides,
					EXPECTED_CATEGORY_OVERRIDES[id],
					`${id} category overrides`,
				);
			}
		},
	},
	{
		name: "a resolved style reports the document shape and its extends chain",
		async run() {
			const builtin = await resolveStyle("vanilla");
			assert.deepEqual(Object.keys(builtin).sort(), RESOLVED_KEYS);
			assert.equal(builtin.id, "vanilla");
			assert.equal(builtin.name, EXPECTED_PRESET_NAMES.vanilla);
			assert.deepEqual(builtin.extendsChain, ["vanilla"]);

			await withStyleDir(
				{
					"iron-tide.style.json": styleDocument({
						id: "iron-tide",
						name: "鐵潮",
						extends: "vanilla",
					}),
				},
				async (dir) => {
					const path = join(dir, "iron-tide.style.json");
					const custom = await resolveStyle(path);
					assert.equal(custom.id, "iron-tide");
					assert.equal(custom.name, "鐵潮");
					assert.equal(custom.description, "");
					assert.deepEqual(custom.extendsChain, [path, "vanilla"]);
				},
			);
		},
	},
	{
		name: "a custom style file overrides inherited fields and adds a family",
		async run() {
			await withStyleDir(
				{
					"iron-tide.style.json": styleDocument({
						id: "iron-tide",
						name: "鐵潮",
						extends: "vanilla",
						palettes: {
							stone: { base: "#7A7472" },
							sandstone: SANDSTONE_RAMP,
						},
						outline: { mode: "selective", luminanceDropPermille: 90 },
						limits: { maxColors: 12 },
					}),
				},
				async (dir) => {
					const style = await resolveStyle(join(dir, "iron-tide.style.json"));
					assert.equal(style.outline.mode, "selective");
					assert.equal(style.outline.luminanceDropPermille, 90);
					assert.equal(style.outline.position, "inside");
					assert.equal(style.outline.maxHueOffsetDegrees, 5);
					assert.equal(style.limits.maxColors, 12);
					assert.equal(style.limits.minLevels, 6);
					assert.equal(
						style.palettes.stone?.base,
						"#7A7472",
						"the child overrides one role",
					);
					assert.equal(
						style.palettes.stone?.outline,
						"#212121",
						"the other roles stay inherited",
					);
					assert.deepEqual(
						style.palettes.sandstone,
						SANDSTONE_RAMP,
						"a new family keeps its six roles",
					);
					assert.equal(
						Object.keys(style.palettes).length,
						13,
						"twelve builtin families plus one",
					);
				},
			);
		},
	},
	{
		name: "a custom family with missing roles is completed by the frozen derivation",
		async run() {
			await withStyleDir(
				{
					"slate.style.json": styleDocument({
						id: "slate-study",
						name: "石板練習",
						extends: "vanilla",
						palettes: { slate: { base: "#808080", shadow: "#606060" } },
					}),
				},
				async (dir) => {
					const style = await resolveStyle(join(dir, "slate.style.json"));
					assert.deepEqual(style.palettes.slate, {
						outline: "#393939",
						shadow: "#606060",
						dark: "#666666",
						base: "#808080",
						light: "#999999",
						highlight: "#C6C6C6",
					});
				},
			);
		},
	},
	{
		name: "a missing shadow is completed at the midpoint of outline and the reference role",
		async run() {
			const given = EXPECTED_SHADOW_COMPLETION.missingShadow;
			assert.ok(given !== undefined, "the missing-shadow fixture exists");
			await withStyleDir(
				{
					"gravel.style.json": styleDocument({
						id: "gravel-study",
						name: "礫石練習",
						extends: "vanilla",
						palettes: {
							[COMPLETION_FAMILIES.missingShadow]: given?.given,
						},
					}),
				},
				async (dir) => {
					const style = await resolveStyle(join(dir, "gravel.style.json"));
					assert.deepEqual(
						style.palettes[COMPLETION_FAMILIES.missingShadow],
						given?.completed,
					);
				},
			);
		},
	},
	{
		name: "a family with only outline and base completes its shadow from the base",
		async run() {
			const given = EXPECTED_SHADOW_COMPLETION.twoLevels;
			assert.ok(given !== undefined, "the two-level fixture exists");
			await withStyleDir(
				{
					"basalt.style.json": styleDocument({
						id: "basalt-study",
						name: "玄武練習",
						extends: "vanilla",
						palettes: {
							[COMPLETION_FAMILIES.twoLevels]: given?.given,
						},
					}),
				},
				async (dir) => {
					const style = await resolveStyle(join(dir, "basalt.style.json"));
					assert.deepEqual(
						style.palettes[COMPLETION_FAMILIES.twoLevels],
						given?.completed,
					);
				},
			);
		},
	},
	{
		name: "a saturated family completes shadow, dark, and highlight through the integer conversion",
		async run() {
			const given = EXPECTED_SATURATED_COMPLETION.given;
			await withStyleDir(
				{
					"crimson.style.json": styleDocument({
						id: "crimson-study",
						name: "緋紅練習",
						extends: "vanilla",
						palettes: { [COMPLETION_FAMILIES.saturated]: given },
					}),
				},
				async (dir) => {
					const style = await resolveStyle(join(dir, "crimson.style.json"));
					assert.deepEqual(
						style.palettes[COMPLETION_FAMILIES.saturated],
						EXPECTED_SATURATED_COMPLETION.completed,
					);
				},
			);
		},
	},
	{
		name: "an extends cycle is refused with the chain that repeats",
		async run() {
			await withStyleDir(
				{
					"a.style.json": styleDocument({
						id: "cycle-a",
						name: "循環甲",
						extends: "b.style.json",
					}),
					"b.style.json": styleDocument({
						id: "cycle-b",
						name: "循環乙",
						extends: "a.style.json",
					}),
				},
				async (dir) => {
					const refusal = assertRefusal(
						await captureRefusal(() => resolveStyle(join(dir, "a.style.json"))),
						"STYLE_INHERITANCE_CYCLE",
						"extends",
					);
					assert.deepEqual(refusal.details?.extendsChain, [
						join(dir, "a.style.json"),
						join(dir, "b.style.json"),
						join(dir, "a.style.json"),
					]);
				},
			);
		},
	},
	{
		name: "a family deleted after inheritance is gone and reported as not found",
		async run() {
			await withStyleDir(
				{
					"no-stone.style.json": styleDocument({
						id: "no-stone",
						name: "無石",
						extends: "vanilla",
						palettes: { stone: null },
					}),
				},
				async (dir) => {
					const style = await resolveStyle(join(dir, "no-stone.style.json"));
					assert.equal(
						Object.keys(style.palettes).length,
						11,
						"one family removed",
					);
					assert.equal(style.palettes.stone, undefined);
					const refusal = assertRefusal(
						await captureRefusal(() => buildPaletteMcpx(style, "stone")),
						"STYLE_FAMILY_NOT_FOUND",
						"family",
					);
					assert.equal(refusal.details?.family, "stone");
					assert.equal(refusal.details?.style, "no-stone");
				},
			);
		},
	},
	{
		name: "unknown fields and unknown enum values are refused with their field path",
		async run() {
			await withStyleDir(
				{
					"typo.style.json": styleDocument({
						id: "typo-study",
						name: "錯字",
						extends: "vanilla",
						palette: {},
					}),
					"soft-field.style.json": styleDocument({
						id: "soft-field-study",
						name: "柔性欄位",
						extends: "vanilla",
						outline: { softness: 3 },
					}),
					"angle.style.json": styleDocument({
						id: "angle-study",
						name: "角度",
						extends: "vanilla",
						animation: { sweepAngleDegrees: 60 },
					}),
				},
				async (dir) => {
					const cases: [string, string][] = [
						["typo.style.json", "palette"],
						["soft-field.style.json", "outline.softness"],
						["angle.style.json", "animation.sweepAngleDegrees"],
					];
					for (const [file, field] of cases) {
						const refusal = assertRefusal(
							await captureRefusal(() => resolveStyle(join(dir, file))),
							"STYLE_INVALID",
							field,
						);
						assert.ok(
							refusal.message.includes(`${field}: expected`),
							`${field}: ${refusal.message}`,
						);
					}
				},
			);
		},
	},
	{
		name: "a color must be six-digit hex and the message names the field",
		async run() {
			await withStyleDir(
				{
					"short.style.json": styleDocument({
						id: "short-color",
						name: "短色",
						extends: "vanilla",
						palettes: { stone: { base: "#12345" } },
					}),
					"alpha.style.json": styleDocument({
						id: "alpha-color",
						name: "帶透明",
						extends: "vanilla",
						palettes: { stone: { base: "#12345678" } },
					}),
					"named.style.json": styleDocument({
						id: "named-color",
						name: "具名色",
						extends: "vanilla",
						palettes: { stone: { base: "red" } },
					}),
				},
				async (dir) => {
					const cases: [string, string][] = [
						["short.style.json", '"#12345"'],
						["alpha.style.json", '"#12345678"'],
						["named.style.json", '"red"'],
					];
					for (const [file, value] of cases) {
						const refusal = assertRefusal(
							await captureRefusal(() => resolveStyle(join(dir, file))),
							"STYLE_INVALID",
							"palettes.stone.base",
						);
						assert.ok(
							refusal.message.includes("expected #RRGGBB"),
							`color shape: ${refusal.message}`,
						);
						assert.ok(
							refusal.message.includes(`got ${value}`),
							`color value: ${refusal.message}`,
						);
					}
				},
			);
		},
	},
	{
		name: "family names must match the family id pattern",
		async run() {
			await withStyleDir(
				{
					"upper.style.json": styleDocument({
						id: "upper-study",
						name: "大寫",
						extends: "vanilla",
						palettes: { Iron: { base: "#808080" } },
					}),
					"long.style.json": styleDocument({
						id: "long-study",
						name: "過長",
						extends: "vanilla",
						palettes: { [`f${"x".repeat(40)}`]: { base: "#808080" } },
					}),
				},
				async (dir) => {
					assertRefusal(
						await captureRefusal(() =>
							resolveStyle(join(dir, "upper.style.json")),
						),
						"STYLE_INVALID",
						"palettes.Iron",
					);
					const long = assertRefusal(
						await captureRefusal(() =>
							resolveStyle(join(dir, "long.style.json")),
						),
						"STYLE_INVALID",
						`palettes.f${"x".repeat(40)}`,
					);
					assert.ok(
						(long.message ?? "").includes("palettes."),
						`family key in the message: ${long.message}`,
					);
				},
			);
		},
	},
	{
		name: "style identity, format version, and unknown ids are checked",
		async run() {
			await withStyleDir(
				{
					"builtin-id.style.json": styleDocument({
						id: "vanilla",
						name: "冒用原版",
					}),
					"future.style.json": styleDocument({
						formatVersion: 2,
						id: "future-study",
						name: "未來",
					}),
					"missing-version.style.json": `${JSON.stringify(
						{ id: "missing-version", name: "缺版本" },
						null,
						2,
					)}\n`,
				},
				async (dir) => {
					assertRefusal(
						await captureRefusal(() =>
							resolveStyle(join(dir, "builtin-id.style.json")),
						),
						"STYLE_INVALID",
						"id",
					);
					assertRefusal(
						await captureRefusal(() =>
							resolveStyle(join(dir, "future.style.json")),
						),
						"STYLE_UNSUPPORTED_VERSION",
						"formatVersion",
					);
					assertRefusal(
						await captureRefusal(() =>
							resolveStyle(join(dir, "missing-version.style.json")),
						),
						"STYLE_INVALID",
						"formatVersion",
					);
					assertRefusal(
						await captureRefusal(() => resolveStyle("no-such-style")),
						"STYLE_NOT_FOUND",
						"style",
					);
				},
			);
		},
	},
	{
		name: "empty, unparsable, and missing style files are refused as read failures",
		async run() {
			await withStyleDir(
				{
					"empty.style.json": "",
					"broken.style.json": "{ not json",
				},
				async (dir) => {
					for (const file of ["empty.style.json", "broken.style.json"]) {
						const refusal = assertRefusal(
							await captureRefusal(() => resolveStyle(join(dir, file))),
							"STYLE_INVALID",
							"",
						);
						assert.equal(refusal.details?.reason, "read", `${file} reason`);
						assert.equal(
							refusal.details?.path,
							join(dir, file),
							`${file} path`,
						);
					}
					const missing = assertRefusal(
						await captureRefusal(() =>
							resolveStyle(join(dir, "absent.style.json")),
						),
						"STYLE_INVALID",
						"",
					);
					assert.equal(missing.details?.reason, "read");
					assert.equal(missing.details?.path, join(dir, "absent.style.json"));
				},
			);
		},
	},
	{
		name: "an outline color is allowed only for the uniform mode",
		async run() {
			await withStyleDir(
				{
					"tinted-color.style.json": styleDocument({
						id: "tinted-color-study",
						name: "暗框帶色",
						extends: "vanilla",
						outline: { mode: "tinted", color: "#3B3160" },
					}),
					"uniform-missing.style.json": styleDocument({
						id: "uniform-missing-study",
						name: "平塗缺色",
						extends: "vanilla",
						outline: { mode: "uniform" },
					}),
				},
				async (dir) => {
					assertRefusal(
						await captureRefusal(() =>
							resolveStyle(join(dir, "tinted-color.style.json")),
						),
						"STYLE_INVALID",
						"outline.color",
					);
					assertRefusal(
						await captureRefusal(() =>
							resolveStyle(join(dir, "uniform-missing.style.json")),
						),
						"STYLE_INVALID",
						"outline.color",
					);
				},
			);
		},
	},
	{
		name: "export-palette writes the frozen canonical mcpx for one family",
		async run() {
			const style = await resolveStyle("vanilla");
			assert.equal(
				buildPaletteMcpx(style, "iron"),
				expectedFamilyMcpx("vanilla", "iron"),
			);
		},
	},
	{
		name: "export-palette with family all keeps family-then-role palette order",
		async run() {
			const style = await resolveStyle("dark-frame");
			const text = buildPaletteMcpx(style, "all");
			assert.ok(text.startsWith("mcpx 1\n"), "a canonical mcpx document");
			assert.ok(text.includes("[grid tokens]"), "multi-character symbols");
			const parsed = parseMcpx(text);
			assert.equal(parsed.width, 6);
			assert.equal(parsed.height, 12);
			assert.deepEqual(parsed.metadata, {
				kind: "palette",
				name: "dark-frame-all",
			});
			const entries = parsed.palette?.entries ?? [];
			const expectedEntries = expectedAllPaletteEntries("dark-frame");
			assert.equal(entries.length, 73, "transparent plus twelve families");
			assert.deepEqual(
				entries.map((entry) => entry.id),
				[".", ...expectedEntries.map((entry) => entry.id)],
			);
			assert.deepEqual(
				entries.map((entry) => entry.role ?? null),
				[null, ...expectedEntries.map((entry) => entry.role)],
			);
			assert.deepEqual(
				entries.map((entry) => toHexString(entry.color)),
				["#00000000", ...expectedEntries.map((entry) => entry.hex)],
			);
			const layer = parsed.layers[0];
			assert.ok(layer !== undefined, "one palette layer");
			for (const [row, family] of EXPECTED_FAMILY_ORDER.entries()) {
				for (const [column, role] of EXPECTED_RAMP_ROLES.entries()) {
					const offset = (row * 6 + column) * 4;
					assert.equal(
						toHexString({
							r: (layer?.pixels[offset] ?? 0) as number,
							g: (layer?.pixels[offset + 1] ?? 0) as number,
							b: (layer?.pixels[offset + 2] ?? 0) as number,
							a: (layer?.pixels[offset + 3] ?? 0) as number,
						}),
						rampValue(rampOf("dark-frame", family), role),
						`${family}.${role} cell`,
					);
				}
			}
		},
	},
	{
		name: "an exported palette feeds quantize --palette and generate --palette",
		async run() {
			const style = await resolveStyle("vanilla");
			await withStyleDir({}, async (dir) => {
				const palettePath = join(dir, "vanilla-all.mcpx");
				await writeFile(palettePath, buildPaletteMcpx(style, "all"), "utf8");
				await writeFile(join(dir, "input.png"), encodePng(testSwatch()));
				const allowed = new Set([
					TRANSPARENT_PALETTE_ENTRY,
					...expectedAllPaletteEntries("vanilla").map((entry) => entry.hex),
				]);
				const quantized = join(dir, "quantized.png");
				const quantizeRun = await runQuantizeCommand([
					join(dir, "input.png"),
					palettePath,
					quantized,
				]);
				assert.equal(
					quantizeRun.code,
					0,
					`quantize accepts the palette: ${quantizeRun.stderr}`,
				);
				assert.deepEqual(
					await foreignColors(quantized, allowed),
					[],
					"quantize output stays inside the palette",
				);
				const generated = join(dir, "generated.png");
				const generateRun = await runGenerateCommand([
					"checker",
					"8",
					palettePath,
					"7",
					generated,
				]);
				assert.equal(
					generateRun.code,
					0,
					`generate accepts the palette: ${generateRun.stderr}`,
				);
				assert.deepEqual(
					await foreignColors(generated, allowed),
					[],
					"generate output stays inside the palette",
				);
			});
		},
	},
	{
		name: "style export-palette writes the requested family and refuses to write without an output path",
		async run() {
			await withStyleDir({}, async (dir) => {
				const output = join(dir, "iron.mcpx");
				const run = await runStyleCommand("export-palette", "vanilla", {
					family: "iron",
					output,
				});
				assert.equal(run.code, 0, JSON.stringify(run.body));
				assert.deepEqual(run.body.result, {
					command: "style",
					mode: "export-palette",
					style: "vanilla",
					family: "iron",
					output,
				});
				assert.equal(
					await readFile(output, "utf8"),
					expectedFamilyMcpx("vanilla", "iron"),
				);
				const withoutOutput = await runStyleCommand(
					"export-palette",
					"vanilla",
					{ family: "iron" },
				);
				assert.equal(withoutOutput.code, 2, "an output path is required");
				assert.equal(withoutOutput.body.success, false);
				assert.equal(
					(withoutOutput.body.error as { code?: string } | undefined)?.code,
					"OUTPUT_REQUIRED",
				);
			});
		},
	},
	{
		name: "style create writes the frozen document and keeps the existing target without --force",
		async run() {
			await withStyleDir({}, async (dir) => {
				const output = join(dir, "iron-tide.style.json");
				const first = await runStyleCommand("create", undefined, {
					id: "iron-tide",
					name: "鐵潮",
					extends: "vanilla",
					output,
				});
				assert.equal(first.code, 0, JSON.stringify(first.body));
				assert.deepEqual(jsonOrNull(await readFile(output, "utf8")), {
					formatVersion: 1,
					id: "iron-tide",
					name: "鐵潮",
					extends: "vanilla",
				});
				const second = await runStyleCommand("create", undefined, {
					id: "iron-tide",
					output,
				});
				assert.equal(second.code, 4, "an existing target is refused");
				assert.equal(
					(second.body.error as { code?: string } | undefined)?.code,
					"OUTPUT_EXISTS",
				);
				const forced = await runStyleCommand("create", undefined, {
					id: "iron-tide",
					name: "鐵潮",
					extends: "vanilla",
					output,
					force: true,
				});
				assert.equal(forced.code, 0, JSON.stringify(forced.body));
				const rewritten = jsonOrNull(await readFile(output, "utf8")) as Record<
					string,
					unknown
				>;
				assert.equal(rewritten.id, "iron-tide");
				assert.equal(rewritten.name, "鐵潮");
			});
		},
	},
	{
		name: "the CLI style list and show modes emit the frozen report shapes",
		async run() {
			const list = await runStyleCommand("list", undefined, {});
			assert.equal(list.code, 0, JSON.stringify(list.body));
			const listResult = list.body.result as
				| { command?: string; mode?: string; presets?: { id: string }[] }
				| undefined;
			assert.equal(listResult?.command, "style");
			assert.equal(listResult?.mode, "list");
			assert.deepEqual(
				(listResult?.presets ?? []).map((preset) => preset.id),
				EXPECTED_PRESET_IDS,
			);
			const show = await runStyleCommand("show", "vanilla", {});
			assert.equal(show.code, 0, JSON.stringify(show.body));
			const showResult = show.body.result as
				| { mode?: string; style?: ResolvedStyle }
				| undefined;
			assert.equal(showResult?.mode, "show");
			assert.equal(showResult?.style?.id, "vanilla");
			assert.deepEqual(
				Object.keys(showResult?.style?.palettes ?? {}).sort(),
				[...EXPECTED_FAMILY_ORDER].sort(),
			);
			assert.deepEqual(
				showResult?.style?.palettes,
				EXPECTED_PALETTES.vanilla as unknown as ResolvedStyle["palettes"],
			);
		},
	},
	{
		name: "mcp style_asset list reports presets and refuses a custom path that cannot load",
		async run() {
			const listed = await handleStyleAsset({ mode: "list" });
			const body = handlerBody(listed as ToolResult);
			assert.equal(body.mode, "list");
			assert.deepEqual(
				((body.presets ?? []) as { id: string }[]).map((preset) => preset.id),
				EXPECTED_PRESET_IDS,
			);
			assert.deepEqual(body.custom, []);
			await withStyleDir(
				{
					"iron-tide.style.json": styleDocument({
						id: "iron-tide",
						name: "鐵潮",
						extends: "vanilla",
					}),
				},
				async (dir) => {
					const path = join(dir, "iron-tide.style.json");
					const withCustom = await handleStyleAsset({
						mode: "list",
						paths: [path],
					});
					assert.deepEqual(handlerBody(withCustom as ToolResult).custom, [
						{
							id: "iron-tide",
							name: "鐵潮",
							description: "",
							path,
						},
					]);
					const refused = await handleStyleAsset({
						mode: "list",
						paths: [join(dir, "absent.style.json")],
					});
					assert.equal(
						refused.isError,
						true,
						"an unloadable path fails the whole call",
					);
				},
			);
		},
	},
	{
		name: "mcp style_asset show and export-palette report the resolved style and palette text",
		async run() {
			const shown = await handleStyleAsset({ mode: "show", style: "vanilla" });
			const shownBody = handlerBody(shown as ToolResult);
			assert.equal(shownBody.mode, "show");
			const shownStyle = shownBody.style as ResolvedStyle | undefined;
			assert.equal(shownStyle?.id, "vanilla");
			assert.deepEqual(
				shownStyle?.palettes,
				EXPECTED_PALETTES.vanilla as unknown as ResolvedStyle["palettes"],
			);
			const exported = await handleStyleAsset({
				mode: "export-palette",
				style: "vanilla",
				family: "iron",
			});
			const exportedBody = handlerBody(exported as ToolResult);
			assert.equal(exportedBody.mode, "export-palette");
			assert.equal(exportedBody.style, "vanilla");
			assert.equal(exportedBody.family, "iron");
			assert.equal(
				exportedBody.mcpxText,
				expectedFamilyMcpx("vanilla", "iron"),
			);
		},
	},
	{
		name: "mcp style_asset create writes the document with its merged overrides",
		async run() {
			await withStyleDir({}, async (dir) => {
				const output = join(dir, "iron-tide.style.json");
				const created = await handleStyleAsset({
					mode: "create",
					outputPath: output,
					id: "iron-tide",
					name: "鐵潮",
					extends: "vanilla",
					overrides: { limits: { maxColors: 12 } },
				});
				assert.notEqual(
					created.isError,
					true,
					`create reports a failure: ${handlerBody(created as ToolResult)}`,
				);
				assert.deepEqual(jsonOrNull(await readFile(output, "utf8")), {
					formatVersion: 1,
					id: "iron-tide",
					name: "鐵潮",
					extends: "vanilla",
					limits: { maxColors: 12 },
				});
				const refused = await handleStyleAsset({
					mode: "create",
					outputPath: join(dir, "absent.style"),
					id: "iron-tide",
				});
				assert.equal(
					refused.isError,
					true,
					"a target without the style suffix is refused",
				);
				assert.deepEqual(await readdir(dir), ["iron-tide.style.json"]);
			});
		},
	},
];
