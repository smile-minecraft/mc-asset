import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputStreams } from "../../src/cli/channels.ts";
import { runStyle } from "../../src/cli/cmd-style.ts";
import type { PixelCanvas } from "../../src/core/types.ts";
import { encodePng } from "../../src/io/png.ts";
import { handleStyleAsset } from "../../src/mcp/handlers.ts";
import {
	lintStyle,
	resolveStyleThresholds,
	type StyleFinding,
	type StyleLintReport,
} from "../../src/style/lint.ts";
import { resolveStyle } from "../../src/style/load.ts";
import type { ResolvedStyle } from "../../src/style/types.ts";
import {
	animationStripCanvas,
	blankCanvas,
	checkerCanvas,
	gemCanvas,
	ingotCanvas,
	paintedCanvas,
	pixelsOf,
	rgba,
	solidCanvas,
	swordCanvas,
	TRANSPARENT,
} from "../analyze/style-fixtures.ts";
import { referenceStyleMetrics } from "../analyze/style-metrics-reference.ts";

/**
 * Style check cases. The thresholds in each case are transcribed from the
 * frozen preset table (style section 2.9 and its category overrides), so a
 * case never reads the preset data it is checking against.
 */

interface LintCase {
	name: string;
	run(): void | Promise<void>;
}

/** Vanilla preset thresholds (spec section 2.9), written out here. */
const VANILLA = {
	minTlBrPermille: 30,
	darknessGapPermille: 50,
	maxHueOffsetDegrees: 5,
	minLevels: 6,
	maxLevels: 16,
	dynamicRangeMinPermille: 450,
	maxColors: 13,
	requireMargin: false,
	highlightMinPixels: 1,
	highlightMaxPixels: 6,
	highlightMinRatioPermille: 10,
	highlightMaxRatioPermille: 80,
	bufferMinRatioPermille: 400,
	ditherMode: "allow",
	ditherMaxRatioPermille: 150,
} as const;

/** gem_crystal category overrides of the same table. */
const GEM_CRYSTAL = {
	minLevels: 8,
	maxLevels: 12,
	dynamicRangeMinPermille: 750,
	minTlBrPermille: 70,
} as const;

/** sword category overrides of the same table. */
const SWORD = {
	minLevels: 10,
	maxLevels: 14,
	dynamicRangeMinPermille: 750,
	minTlBrPermille: 60,
} as const;

async function vanillaStyle(): Promise<ResolvedStyle> {
	return resolveStyle("vanilla");
}

/** A style document on disk, resolved so overrides can be exercised. */
async function customStyle(
	fields: Record<string, unknown>,
): Promise<ResolvedStyle> {
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-lint-style-"));
	try {
		const path = join(dir, "case.style.json");
		await writeFile(
			path,
			`${JSON.stringify(
				{
					formatVersion: 1,
					id: "case-study",
					name: "案例",
					extends: "vanilla",
					...fields,
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		return await resolveStyle(path);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function report(
	canvas: PixelCanvas,
	style: ResolvedStyle,
	category: string | null = null,
	firstFrameOnly = false,
): StyleLintReport {
	return lintStyle({
		canvas,
		path: "assets/pack/textures/item/case.png",
		style,
		category,
		firstFrameOnly,
	});
}

/** The reference measurement of a canvas, for the metrics a case asserts. */
function referenceOf(canvas: PixelCanvas, firstFrameOnly = false): unknown {
	return referenceStyleMetrics(
		pixelsOf(canvas),
		canvas.width,
		canvas.height,
		firstFrameOnly,
	);
}

function finding(
	result: StyleLintReport,
	code: string,
): StyleFinding | undefined {
	return result.findings.find((entry) => entry.code === code);
}

/** Assertion shared by the rule cases: the finding exists and carries numbers. */
function assertFinding(
	result: StyleLintReport,
	code: string,
	expected: { level: string; measured: number; threshold: number },
): StyleFinding {
	const found = finding(result, code);
	assert.ok(
		found !== undefined,
		`expected ${code}; findings: ${JSON.stringify(result.findings)}`,
	);
	const entry = found as StyleFinding;
	assert.equal(entry.level, expected.level, `${code} level`);
	assert.equal(entry.measured, expected.measured, `${code} measured`);
	assert.equal(entry.threshold, expected.threshold, `${code} threshold`);
	return entry;
}

/** A flat rectangle painted in `count` distinct steps, one band per row. */
function bandedCanvas(colors: readonly string[]): PixelCanvas {
	const tones = colors.map((hex) => rgba(hex));
	return paintedCanvas(16, 16, (x, y) => {
		if (x < 2 || x > 13 || y < 2 || y > 13) {
			return TRANSPARENT;
		}
		const index = Math.min(
			tones.length - 1,
			Math.trunc(((y - 2) * tones.length) / 12),
		);
		return tones[index] as ReturnType<typeof rgba>;
	});
}

/** One brightest pixel with no transitional neighbor beside it. */
function isolatedHighlightCanvas(): PixelCanvas {
	return paintedCanvas(16, 16, (x, y) => {
		if (x < 3 || x > 12 || y < 3 || y > 12) {
			return TRANSPARENT;
		}
		if (x === 3 || x === 12 || y === 3 || y === 12) {
			return rgba("#202020");
		}
		if (x === 5 && y === 5) {
			return rgba("#FFFFFF");
		}
		return rgba("#787878");
	});
}

/** More distinct tones than the vanilla color budget allows. */
function overBudgetCanvas(count = 16): PixelCanvas {
	const tones: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const value = 20 + index * 10;
		tones.push(`#${value.toString(16).padStart(2, "0").repeat(3)}`);
	}
	return paintedCanvas(16, 16, (x, y) => {
		if (x < 2 || x > 13 || y < 2 || y > 13) {
			return TRANSPARENT;
		}
		const cell = (y - 2) * 12 + (x - 2);
		const index = Math.min(
			tones.length - 1,
			Math.trunc((cell * tones.length) / 144),
		);
		return rgba(tones[index] as string);
	});
}

async function withTempPng(
	canvas: PixelCanvas,
	body: (dir: string, path: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-lint-png-"));
	try {
		const path = join(dir, "case.png");
		await writeFile(path, encodePng(canvas));
		await body(dir, path);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function captureStreams(): {
	streams: OutputStreams;
	stdout(): string;
} {
	const out: Buffer[] = [];
	return {
		streams: {
			stdout: {
				write: (chunk: string | Uint8Array): boolean => {
					out.push(Buffer.from(chunk as string));
					return true;
				},
			},
			stderr: {
				write: (): boolean => true,
			},
		},
		stdout: () => Buffer.concat(out).toString("utf8"),
	};
}

export const LINT_CASES: LintCase[] = [
	{
		name: "a blade lit from the top left reports the frozen metrics and no light finding",
		async run() {
			const result = report(
				swordCanvas({ highlightCorner: "top-left" }),
				await vanillaStyle(),
			);
			assert.equal(finding(result, "STYLE_LIGHT_DIRECTION"), undefined);
			assert.equal(result.mode, "lint");
			assert.equal(result.category, null);
			assert.equal(result.style, "vanilla");
			assert.equal(result.metrics.opaquePixels, 144);
			assert.equal(result.metrics.levels, 7);
			assert.equal(result.metrics.firstFrameOnly, false);
		},
	},
	{
		name: "a blade lit from the bottom right reports the light direction finding",
		async run() {
			const result = report(
				swordCanvas({ highlightCorner: "bottom-right" }),
				await vanillaStyle(),
			);
			const measured = result.metrics.tlBrPermille ?? 0;
			assertFinding(result, "STYLE_LIGHT_DIRECTION", {
				level: "warning",
				measured,
				threshold: VANILLA.minTlBrPermille,
			});
			assert.equal(result.verdict, "warnings");
		},
	},
	{
		name: "a gem with a light outline reports the outline darkness finding",
		async run() {
			const result = report(gemCanvas("#C9CFE0"), await vanillaStyle());
			assertFinding(result, "STYLE_OUTLINE_DARKNESS", {
				level: "warning",
				measured: result.metrics.outlineGapPermille ?? 0,
				threshold: VANILLA.darknessGapPermille,
			});
		},
	},
	{
		name: "a gem with a same-hue dark outline reports no outline finding",
		async run() {
			const result = report(gemCanvas("#0A1A36"), await vanillaStyle());
			assert.equal(finding(result, "STYLE_OUTLINE_DARKNESS"), undefined);
			assert.equal(finding(result, "STYLE_OUTLINE_HUE"), undefined);
			assert.ok(
				(result.metrics.outlineGapPermille ?? 0) >= VANILLA.darknessGapPermille,
				"the ring clears the darkness threshold",
			);
		},
	},
	{
		name: "a gem with a foreign outline hue reports the outline hue finding",
		async run() {
			const result = report(gemCanvas("#B03030"), await vanillaStyle());
			assertFinding(result, "STYLE_OUTLINE_HUE", {
				level: "warning",
				measured: result.metrics.outlineHueOffsetDegrees ?? 0,
				threshold: VANILLA.maxHueOffsetDegrees,
			});
		},
	},
	{
		name: "a uniform outline style skips the outline hue check",
		async run() {
			const style = await customStyle({
				outline: { mode: "uniform", color: "#B03030" },
			});
			const canvas = gemCanvas("#B03030");
			const result = report(canvas, style);
			assert.equal(
				finding(result, "STYLE_OUTLINE_HUE"),
				undefined,
				"mode uniform never compares hues",
			);
			assert.deepEqual(result.metrics, referenceOf(canvas));
			assert.ok(
				(result.metrics.outlineHueOffsetDegrees ?? 0) > 0,
				"the hue offset is still measured, only not judged",
			);
		},
	},
	{
		name: "an ingot with too few steps reports the level count finding",
		async run() {
			const result = report(ingotCanvas(5), await vanillaStyle());
			assertFinding(result, "STYLE_LEVELS_TOO_FEW", {
				level: "warning",
				measured: result.metrics.levels,
				threshold: VANILLA.minLevels,
			});
		},
	},
	{
		name: "an ingot with too many steps reports the level count finding",
		async run() {
			const result = report(ingotCanvas(17), await vanillaStyle());
			assertFinding(result, "STYLE_LEVELS_TOO_MANY", {
				level: "warning",
				measured: result.metrics.levels,
				threshold: VANILLA.maxLevels,
			});
		},
	},
	{
		name: "an ingot inside the level range reports no level finding",
		async run() {
			const result = report(ingotCanvas(9), await vanillaStyle());
			assert.equal(finding(result, "STYLE_LEVELS_TOO_FEW"), undefined);
			assert.equal(finding(result, "STYLE_LEVELS_TOO_MANY"), undefined);
			assert.ok(
				result.metrics.levels >= VANILLA.minLevels &&
					result.metrics.levels <= VANILLA.maxLevels,
				`levels ${result.metrics.levels} inside the range`,
			);
		},
	},
	{
		name: "a low contrast sprite reports the dynamic range finding",
		async run() {
			const result = report(
				bandedCanvas(["#808080", "#8A8A8A", "#949494"]),
				await vanillaStyle(),
			);
			assertFinding(result, "STYLE_DYNAMIC_RANGE", {
				level: "warning",
				measured: result.metrics.dynamicRangePermille,
				threshold: VANILLA.dynamicRangeMinPermille,
			});
		},
	},
	{
		name: "too many brightest pixels report the highlight count finding",
		async run() {
			const result = report(
				bandedCanvas(["#F4F4F4", "#909090", "#404040"]),
				await vanillaStyle(),
			);
			assertFinding(result, "STYLE_HIGHLIGHT_COUNT", {
				level: "warning",
				measured: result.metrics.highlightPixels ?? 0,
				threshold: VANILLA.highlightMaxPixels,
			});
		},
	},
	{
		name: "an isolated brightest pixel reports the highlight buffer finding",
		async run() {
			const result = report(isolatedHighlightCanvas(), await vanillaStyle());
			assertFinding(result, "STYLE_HIGHLIGHT_ISOLATED", {
				level: "warning",
				measured: result.metrics.bufferRatioPermille ?? 0,
				threshold: VANILLA.bufferMinRatioPermille,
			});
		},
	},
	{
		name: "a dither policy reports the dither finding and allows it otherwise",
		async run() {
			const discouraged = await customStyle({
				dither: { mode: "discourage", maxRatioPermille: 150 },
			});
			const canvas = checkerCanvas();
			const reported = report(canvas, discouraged);
			assertFinding(reported, "STYLE_DITHER", {
				level: "warning",
				measured: reported.metrics.ditherPermille,
				threshold: 150,
			});
			const allowed = report(canvas, await vanillaStyle());
			assert.equal(
				finding(allowed, "STYLE_DITHER"),
				undefined,
				"mode allow never reports dithering",
			);
			const forbidden = await customStyle({ dither: { mode: "forbid" } });
			assertFinding(report(canvas, forbidden), "STYLE_DITHER", {
				level: "warning",
				measured: reported.metrics.ditherPermille,
				threshold: 0,
			});
		},
	},
	{
		name: "too many colors report the only error level finding",
		async run() {
			const result = report(overBudgetCanvas(16), await vanillaStyle());
			assertFinding(result, "STYLE_COLOR_BUDGET", {
				level: "error",
				measured: result.metrics.colors,
				threshold: VANILLA.maxColors,
			});
			assert.equal(result.verdict, "fail");
			for (const entry of result.findings) {
				if (entry.code !== "STYLE_COLOR_BUDGET") {
					assert.equal(entry.level, "warning", `${entry.code} stays a warning`);
				}
			}
		},
	},
	{
		name: "a sprite inside the color budget reports no budget finding",
		async run() {
			const canvas = overBudgetCanvas(8);
			const result = report(canvas, await vanillaStyle());
			assert.equal(finding(result, "STYLE_COLOR_BUDGET"), undefined);
			assert.ok(result.metrics.colors <= VANILLA.maxColors);
			assert.deepEqual(result.metrics, referenceOf(canvas));
		},
	},
	{
		name: "a required margin reports the margin finding and is skipped otherwise",
		async run() {
			const edge = solidCanvas("#4C74B4", 32, 32);
			const strict = await customStyle({ limits: { requireMargin: true } });
			assertFinding(report(edge, strict), "STYLE_MARGIN_TOUCH", {
				level: "warning",
				measured: 0,
				threshold: 1,
			});
			assert.equal(
				finding(report(edge, await vanillaStyle()), "STYLE_MARGIN_TOUCH"),
				undefined,
				"requireMargin false skips the rule",
			);
			assert.equal(
				finding(report(swordCanvas(), strict), "STYLE_MARGIN_TOUCH"),
				undefined,
				"a sprite with a two pixel margin clears the rule",
			);
		},
	},
	{
		name: "a category in the axis list reports the axis angle finding",
		async run() {
			const result = report(swordCanvas(), await vanillaStyle(), "sword");
			assertFinding(result, "STYLE_AXIS_ANGLE", {
				level: "warning",
				measured: 0,
				threshold: 45,
			});
			assert.equal(result.category, "sword");
		},
	},
	{
		name: "without a category the category scoped rules stay quiet",
		async run() {
			const canvas = swordCanvas();
			const style = await vanillaStyle();
			const withoutCategory = report(canvas, style);
			assert.equal(
				finding(withoutCategory, "STYLE_AXIS_ANGLE"),
				undefined,
				"no category means no axis check",
			);
			assert.equal(
				finding(report(canvas, style, "gem_crystal"), "STYLE_AXIS_ANGLE"),
				undefined,
				"gem_crystal is not in the axis list",
			);
			assert.deepEqual(withoutCategory.metrics, referenceOf(canvas));
		},
	},
	{
		name: "category overrides raise the thresholds that apply",
		async run() {
			const style = await vanillaStyle();
			const global = resolveStyleThresholds(style, null);
			const gem = resolveStyleThresholds(style, "gem_crystal");
			const sword = resolveStyleThresholds(style, "sword");
			assert.equal(global.limits.minLevels, VANILLA.minLevels);
			assert.equal(gem.limits.minLevels, GEM_CRYSTAL.minLevels);
			assert.equal(gem.limits.maxLevels, GEM_CRYSTAL.maxLevels);
			assert.equal(gem.light.minTlBrPermille, GEM_CRYSTAL.minTlBrPermille);
			assert.equal(sword.limits.minLevels, SWORD.minLevels);
			assert.equal(sword.light.minTlBrPermille, SWORD.minTlBrPermille);
			assert.equal(
				global.outline.maxHueOffsetDegrees,
				VANILLA.maxHueOffsetDegrees,
				"an unlisted category keeps the style wide value",
			);
			const gemSprite = gemCanvas("#0A1A36");
			assertFinding(
				report(gemSprite, style, "gem_crystal"),
				"STYLE_LEVELS_TOO_FEW",
				{
					level: "warning",
					// The gem paints an outline plus three body tones.
					measured: 4,
					threshold: GEM_CRYSTAL.minLevels,
				},
			);
		},
	},
	{
		name: "a category threshold changes which findings fire",
		async run() {
			const style = await vanillaStyle();
			// Seven tones clear the global minimum of six and miss the
			// gem_crystal minimum of eight.
			const blade = swordCanvas();
			const global = report(blade, style);
			const categorical = report(blade, style, "gem_crystal");
			assert.equal(
				finding(global, "STYLE_LEVELS_TOO_FEW"),
				undefined,
				"seven steps clear the global minimum",
			);
			assertFinding(categorical, "STYLE_LEVELS_TOO_FEW", {
				level: "warning",
				measured: categorical.metrics.levels,
				threshold: GEM_CRYSTAL.minLevels,
			});
		},
	},
	{
		name: "every finding carries the frozen shape",
		async run() {
			const result = report(
				overBudgetCanvas(16),
				await vanillaStyle(),
				"sword",
			);
			assert.ok(result.findings.length > 0, "the fixture reports something");
			for (const entry of result.findings) {
				assert.ok(entry.code.startsWith("STYLE_"), `${entry.code} code`);
				assert.ok(
					entry.level === "error" || entry.level === "warning",
					`${entry.code} level`,
				);
				assert.ok(Number.isInteger(entry.measured), `${entry.code} measured`);
				assert.ok(Number.isInteger(entry.threshold), `${entry.code} threshold`);
				assert.ok(entry.message.length > 0, `${entry.code} message`);
				assert.ok(entry.suggestion.length > 0, `${entry.code} suggestion`);
			}
			assert.ok(["pass", "warnings", "fail"].includes(result.verdict));
		},
	},
	{
		name: "a transparent image reports no finding and says why it stopped",
		async run() {
			const result = report(blankCanvas(16, 16), await vanillaStyle());
			assert.deepEqual(result.findings, []);
			assert.equal(result.verdict, "pass");
			const reasons = result.skipped.map((entry) => entry.reason);
			assert.ok(
				reasons.includes("no-opaque-pixels"),
				`skipped reasons: ${JSON.stringify(reasons)}`,
			);
		},
	},
	{
		name: "an opaque sheet, a single color, a one pixel image, and a 32x32 sprite all measure",
		async run() {
			const style = await vanillaStyle();
			const sheets = [
				solidCanvas("#4C74B4", 32, 32),
				solidCanvas("#8A8A8A", 16, 16),
				solidCanvas("#7A7A7A", 1, 1),
				swordCanvas({ margin: 0 }),
			];
			for (const canvas of sheets) {
				const result = report(canvas, style);
				assert.equal(result.metrics.opaquePixels, canvas.width * canvas.height);
				assert.ok(result.metrics.levels >= 1, "at least one level");
				assert.ok(["pass", "warnings", "fail"].includes(result.verdict));
			}
		},
	},
	{
		name: "an animation strip measures the first frame and says so",
		async run() {
			const frame = swordCanvas();
			const strip = animationStripCanvas(frame, 3);
			const result = report(strip, await vanillaStyle(), null, true);
			assert.equal(result.metrics.firstFrameOnly, true);
			assert.deepEqual(
				result.metrics.opaquePixels,
				report(frame, await vanillaStyle()).metrics.opaquePixels,
				"one frame, not the whole strip",
			);
			const reasons = result.skipped.map((entry) => entry.reason);
			assert.ok(
				reasons.includes("animation-first-frame-only"),
				`skipped reasons: ${JSON.stringify(reasons)}`,
			);
		},
	},
	{
		name: "the CLI lint command reports through the command entry",
		async run() {
			await withTempPng(overBudgetCanvas(16), async (_dir, path) => {
				const capture = captureStreams();
				const code = await runStyle(
					"lint",
					path,
					{ style: "vanilla" },
					true,
					capture.streams,
				);
				const body = JSON.parse(capture.stdout()) as {
					result?: StyleLintReport & { command?: string };
				};
				assert.equal(body.result?.command, "style");
				assert.equal(body.result?.style, "vanilla");
				assert.equal(body.result?.path, path);
				assert.equal(
					body.result?.verdict,
					"fail",
					"an error-level finding fails the run",
				);
				assert.equal(code, 3, "the same exit code a failing validation uses");
			});
		},
	},
	{
		name: "the MCP lint mode returns the same report and needs an input path",
		async run() {
			await withTempPng(
				swordCanvas({ highlightCorner: "bottom-right" }),
				async (_dir, path) => {
					const result = await handleStyleAsset({
						mode: "lint",
						inputPath: path,
						style: "vanilla",
						category: "sword",
					});
					const body = JSON.parse(
						(result.content[0] as { text?: string }).text ?? "{}",
					) as StyleLintReport & { category?: string };
					assert.equal(body.mode, "lint");
					assert.equal(body.category, "sword");
					assert.ok(
						finding(body, "STYLE_LIGHT_DIRECTION") !== undefined,
						`findings: ${JSON.stringify(body.findings)}`,
					);
					const missing = await handleStyleAsset({ mode: "lint" });
					assert.equal(missing.isError, true);
					assert.ok(
						(missing.content[0] as { text?: string }).text?.includes(
							"INVALID_ARGUMENT",
						),
						"a missing input path is refused",
					);
				},
			);
		},
	},
];
