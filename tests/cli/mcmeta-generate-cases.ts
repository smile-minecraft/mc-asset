import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnimate } from "../../src/cli/cmd-animate.ts";
import { runGuiScale } from "../../src/cli/cmd-gui-scale.ts";
import { type McmetaCliOptions, runMcmeta } from "../../src/cli/cmd-mcmeta.ts";
import { prepareMcmeta } from "../../src/cli/mcmeta-request.ts";
import { runValidate } from "../../src/cli/validate.ts";
import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../src/core/canvas.ts";
import { encodePng } from "../../src/io/png.ts";
import { handleMcmetaAsset } from "../../src/mcp/handlers.ts";
import type { McmetaAssetInput } from "../../src/mcp/schema.ts";
import { captureQuantizeStreams } from "./quantize-palette-cases.ts";

export interface McmetaCliResult {
	code: number;
	stdout: Uint8Array;
	stderr: string;
}

export interface McmetaSurface {
	cli(
		mode: "animation" | "gui",
		input: string | undefined,
		options: McmetaCliOptions,
	): Promise<McmetaCliResult>;
}

export async function runMcmetaCli(
	mode: "animation" | "gui",
	input: string | undefined,
	options: McmetaCliOptions,
): Promise<McmetaCliResult> {
	const capture = captureQuantizeStreams();
	const code = await runMcmeta(mode, input, options, true, capture.streams);
	return { code, stdout: capture.stdout(), stderr: capture.stderrText() };
}

const SHEET_TEXT =
	'{"animation":{"width":16,"height":16,"frametime":1,"frames":[0,1,2,3]}}\n';
const PANEL_TEXT =
	'{"gui":{"scaling":{"type":"nine_slice","width":16,"height":16,"border":{"left":4,"top":4,"right":4,"bottom":4}}}}\n';

function solidPng(width: number, height: number): Uint8Array {
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: "base" });
	const pixels = new Uint8Array(width * height * 4);
	for (let i = 0; i < pixels.length; i += 4) {
		pixels[i] = (i / 4) % 251;
		pixels[i + 1] = 80;
		pixels[i + 2] = 160;
		pixels[i + 3] = 255;
	}
	replaceLayerPixels(canvas, layer.id, pixels);
	return encodePng(canvas);
}

interface Fixture {
	root: string;
	sheet: string;
	panel: string;
	sheetBytes: Uint8Array;
	panelBytes: Uint8Array;
}

async function withFixture(body: (fixture: Fixture) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "mcmeta-generate-"));
	try {
		const sheet = join(root, "sheet.png");
		const panel = join(root, "panel.png");
		const sheetBytes = solidPng(16, 64);
		const panelBytes = solidPng(16, 16);
		await writeFile(sheet, sheetBytes);
		await writeFile(panel, panelBytes);
		await body({ root, sheet, panel, sheetBytes, panelBytes });
		assert.deepEqual(new Uint8Array(await readFile(sheet)), sheetBytes);
		assert.deepEqual(new Uint8Array(await readFile(panel)), panelBytes);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function envelope(result: McmetaCliResult) {
	return JSON.parse(Buffer.from(result.stdout).toString("utf8").trim());
}

function failureCode(result: McmetaCliResult): string {
	return envelope(result).error.code;
}

function mcpBody(result: Awaited<ReturnType<typeof handleMcmetaAsset>>) {
	const block = result.content[0];
	assert.ok(block?.type === "text");
	return { isError: result.isError === true, body: JSON.parse(block.text) };
}

async function mcp(args: McmetaAssetInput) {
	return mcpBody(await handleMcmetaAsset(args));
}

async function listing(root: string): Promise<string[]> {
	return (await readdir(root)).sort();
}

const NINE_SLICE = { type: "nine_slice", border: "4" };

export const MCMETA_GENERATE_SURFACE_CASES: {
	name: string;
	run(surface: McmetaSurface): Promise<void>;
}[] = [
	{
		name: "CLI animation writes the exact document and leaves the PNG alone",
		async run(surface) {
			await withFixture(async ({ root, sheet }) => {
				const output = join(root, "out.mcmeta");
				const result = await surface.cli("animation", sheet, {
					frameSize: "16",
					output,
				});
				assert.equal(result.code, 0, result.stderr);
				assert.equal(await readFile(output, "utf8"), SHEET_TEXT);
				const body = envelope(result);
				assert.equal(body.success, true);
				assert.equal(body.result.mode, "animation");
				assert.equal(body.result.output, output);
				assert.deepEqual(await listing(root), [
					"out.mcmeta",
					"panel.png",
					"sheet.png",
				]);
			});
		},
	},
	{
		name: "CLI gui writes the nine_slice document sized from the PNG",
		async run(surface) {
			await withFixture(async ({ root, panel }) => {
				const output = join(root, "panel.png.mcmeta");
				const result = await surface.cli("gui", panel, {
					...NINE_SLICE,
					output,
				});
				assert.equal(result.code, 0, result.stderr);
				assert.equal(await readFile(output, "utf8"), PANEL_TEXT);
			});
		},
	},
	{
		name: "CLI options reach the document: frametime, interpolate, frames",
		async run(surface) {
			await withFixture(async ({ root, sheet }) => {
				const output = join(root, "out.mcmeta");
				const result = await surface.cli("animation", sheet, {
					frameSize: "16",
					frametime: "4",
					interpolate: true,
					frames: '[3,{"index":0,"time":5},3]',
					output,
				});
				assert.equal(result.code, 0, result.stderr);
				assert.equal(
					await readFile(output, "utf8"),
					'{"animation":{"width":16,"height":16,"frametime":4,"interpolate":true,"frames":[3,{"index":0,"time":5},3]}}\n',
				);
			});
		},
	},
	{
		name: "CLI --stdout prints the document and writes no file",
		async run(surface) {
			await withFixture(async ({ root, sheet }) => {
				const result = await surface.cli("animation", sheet, {
					frameSize: "16",
					stdout: true,
				});
				assert.equal(result.code, 0, result.stderr);
				assert.equal(Buffer.from(result.stdout).toString("utf8"), SHEET_TEXT);
				assert.deepEqual(await listing(root), ["panel.png", "sheet.png"]);
			});
		},
	},
	{
		name: "CLI needs exactly one of --output and --stdout",
		async run(surface) {
			await withFixture(async ({ root, sheet }) => {
				const neither = await surface.cli("animation", sheet, {
					frameSize: "16",
				});
				assert.equal(neither.code, 2);
				assert.equal(failureCode(neither), "OUTPUT_REQUIRED");
				const both = await surface.cli("animation", sheet, {
					frameSize: "16",
					stdout: true,
					output: join(root, "out.mcmeta"),
				});
				assert.equal(both.code, 2);
				assert.equal(failureCode(envelopeOnStderr(both)), "ARGUMENT_CONFLICT");
				assert.deepEqual(await listing(root), ["panel.png", "sheet.png"]);
			});
		},
	},
	{
		name: "CLI refuses fields that belong to the other mode before any write",
		async run(surface) {
			await withFixture(async ({ root, sheet, panel }) => {
				const gui = await surface.cli("gui", panel, {
					type: "stretch",
					frameSize: "16",
					output: join(root, "a.mcmeta"),
				});
				assert.equal(gui.code, 2);
				assert.equal(failureCode(gui), "INVALID_ARGUMENT");
				const animation = await surface.cli("animation", sheet, {
					frameSize: "16",
					type: "stretch",
					output: join(root, "b.mcmeta"),
				});
				assert.equal(animation.code, 2);
				assert.equal(failureCode(animation), "INVALID_ARGUMENT");
				assert.deepEqual(await listing(root), ["panel.png", "sheet.png"]);
			});
		},
	},
	{
		name: "CLI rejects invalid frames and gui parameters with zero bytes on stdout",
		async run(surface) {
			await withFixture(async ({ sheet, panel }) => {
				const outOfRange = await surface.cli("animation", sheet, {
					frameSize: "16",
					frames: "[4]",
					stdout: true,
				});
				assert.equal(outOfRange.code, 2);
				assert.equal(outOfRange.stdout.length, 0);
				const noBorder = await surface.cli("gui", panel, {
					type: "nine_slice",
					stdout: true,
				});
				assert.equal(noBorder.code, 2);
				assert.equal(noBorder.stdout.length, 0);
				const fills = await surface.cli("gui", panel, {
					type: "nine_slice",
					border: "8",
					stdout: true,
				});
				assert.equal(fills.code, 2);
				assert.equal(fills.stdout.length, 0);
			});
		},
	},
	{
		name: "CLI version: stretch_inner on an older target is refused, a newer one writes it",
		async run(surface) {
			await withFixture(async ({ root, panel }) => {
				const old = join(root, "old.mcmeta");
				const refused = await surface.cli("gui", panel, {
					...NINE_SLICE,
					stretchInner: true,
					minecraftVersion: "1.21",
					output: old,
				});
				assert.equal(refused.code, 2);
				assert.equal(failureCode(refused), "ARGUMENT_CONFLICT");
				assert.ok(!(await listing(root)).includes("old.mcmeta"));
				const fresh = join(root, "fresh.mcmeta");
				const accepted = await surface.cli("gui", panel, {
					...NINE_SLICE,
					stretchInner: true,
					minecraftVersion: "1.21.2",
					output: fresh,
				});
				assert.equal(accepted.code, 0, accepted.stderr);
				assert.ok(
					(await readFile(fresh, "utf8")).includes('"stretch_inner":true'),
				);
				assert.equal(envelope(accepted).result.versionChecked, true);
			});
		},
	},
	{
		name: "CLI version: gui.scaling is refused on 1.20.1 and written for every type on 1.20.2",
		async run(surface) {
			await withFixture(async ({ root, panel }) => {
				for (const options of [
					{ type: "stretch" },
					{ type: "tile" },
					{ type: "nine_slice", border: "4" },
				]) {
					const refused = await surface.cli("gui", panel, {
						...options,
						minecraftVersion: "1.20.1",
						output: join(root, "refused.mcmeta"),
					});
					assert.equal(refused.code, 2, options.type);
					assert.equal(failureCode(refused), "ARGUMENT_CONFLICT");
					assert.ok(!(await listing(root)).includes("refused.mcmeta"));
					const output = join(root, `${options.type}.mcmeta`);
					const accepted = await surface.cli("gui", panel, {
						...options,
						minecraftVersion: "1.20.2",
						output,
					});
					assert.equal(accepted.code, 0, accepted.stderr);
					assert.ok(
						(await readFile(output, "utf8")).includes(
							`"type":"${options.type}"`,
						),
					);
					assert.equal(envelope(accepted).result.versionChecked, true);
				}
			});
		},
	},
	{
		name: "CLI resource-pack versions: 16 writes, 15 refuses, out-of-table is unchecked, malformed is rejected",
		async run(surface) {
			await withFixture(async ({ root, panel }) => {
				const ok = await surface.cli("gui", panel, {
					type: "stretch",
					resourcePackVersion: "16",
					output: join(root, "ok.mcmeta"),
				});
				assert.equal(ok.code, 0, ok.stderr);
				assert.equal(envelope(ok).result.versionChecked, true);
				const old = await surface.cli("gui", panel, {
					type: "stretch",
					resourcePackVersion: "15",
					output: join(root, "old.mcmeta"),
				});
				assert.equal(old.code, 2);
				assert.equal(failureCode(old), "ARGUMENT_CONFLICT");
				const far = await surface.cli("gui", panel, {
					type: "stretch",
					resourcePackVersion: "999",
					output: join(root, "far.mcmeta"),
				});
				assert.equal(far.code, 0, far.stderr);
				assert.equal(envelope(far).result.versionChecked, false);
				const bad = await surface.cli("gui", panel, {
					type: "stretch",
					resourcePackVersion: "abc",
					output: join(root, "bad.mcmeta"),
				});
				assert.equal(bad.code, 2);
				assert.equal(failureCode(bad), "INVALID_ARGUMENT");
				assert.deepEqual(await listing(root), [
					"far.mcmeta",
					"ok.mcmeta",
					"panel.png",
					"sheet.png",
				]);
			});
		},
	},
	{
		name: "CLI animation on 1.19.3 is a checked version",
		async run(surface) {
			await withFixture(async ({ root, sheet }) => {
				const result = await surface.cli("animation", sheet, {
					frameSize: "16",
					minecraftVersion: "1.19.3",
					output: join(root, "out.mcmeta"),
				});
				assert.equal(result.code, 0, result.stderr);
				assert.equal(envelope(result).result.versionChecked, true);
				assert.equal(
					await readFile(join(root, "out.mcmeta"), "utf8"),
					SHEET_TEXT,
				);
			});
		},
	},
	{
		name: "CLI without a version says the version was not checked",
		async run(surface) {
			await withFixture(async ({ root, panel }) => {
				const result = await surface.cli("gui", panel, {
					type: "stretch",
					output: join(root, "out.mcmeta"),
				});
				assert.equal(result.code, 0, result.stderr);
				const body = envelope(result).result;
				assert.equal(body.versionChecked, false);
				assert.deepEqual(
					body.warnings.map((warning: { code: string }) => warning.code),
					["VERSION_NOT_CHECKED"],
				);
			});
		},
	},
	{
		name: "CLI keeps an existing output unless --force, then replaces the whole file",
		async run(surface) {
			await withFixture(async ({ root, sheet }) => {
				const output = join(root, "out.mcmeta");
				const previous = '{"texture":{"mipmap_strategy":"mean"}}\n';
				await writeFile(output, previous);
				const refused = await surface.cli("animation", sheet, {
					frameSize: "16",
					output,
				});
				assert.equal(refused.code, 4);
				assert.equal(failureCode(refused), "OUTPUT_EXISTS");
				assert.equal(await readFile(output, "utf8"), previous);
				const forced = await surface.cli("animation", sheet, {
					frameSize: "16",
					output,
					force: true,
				});
				assert.equal(forced.code, 0, forced.stderr);
				assert.equal(await readFile(output, "utf8"), SHEET_TEXT);
			});
		},
	},
	{
		name: "CLI output must end in .mcmeta",
		async run(surface) {
			await withFixture(async ({ root, sheet }) => {
				for (const name of ["out.json", "out.txt", "out.png", "out"]) {
					const result = await surface.cli("animation", sheet, {
						frameSize: "16",
						output: join(root, name),
					});
					assert.equal(result.code, 2, name);
					assert.equal(failureCode(result), "INVALID_ARGUMENT");
				}
				assert.deepEqual(await listing(root), ["panel.png", "sheet.png"]);
			});
		},
	},
	{
		name: "CLI never writes through a symlink, even with --force",
		async run(surface) {
			await withFixture(async ({ root, sheet }) => {
				const target = join(root, "target.mcmeta");
				await writeFile(target, "original");
				const link = join(root, "link.mcmeta");
				await symlink(target, link);
				const direct = await surface.cli("animation", sheet, {
					frameSize: "16",
					output: link,
					force: true,
				});
				assert.equal(direct.code, 4);
				assert.equal(await readFile(target, "utf8"), "original");
				const real = join(root, "real");
				await mkdir(real);
				await symlink(real, join(root, "parent"));
				const viaParent = await surface.cli("animation", sheet, {
					frameSize: "16",
					output: join(root, "parent", "out.mcmeta"),
				});
				assert.equal(viaParent.code, 4);
				assert.deepEqual(await readdir(real), []);
			});
		},
	},
	{
		name: "CLI refuses an output that aliases the source PNG",
		async run(surface) {
			await withFixture(async ({ root }) => {
				const aliased = join(root, "sheet-as.mcmeta");
				const bytes = solidPng(16, 64);
				await writeFile(aliased, bytes);
				const result = await surface.cli("animation", aliased, {
					frameSize: "16",
					output: aliased,
					force: true,
				});
				assert.equal(result.code, 2);
				assert.equal(failureCode(result), "ARGUMENT_CONFLICT");
				assert.deepEqual(new Uint8Array(await readFile(aliased)), bytes);
			});
		},
	},
	{
		name: "CLI leaves an unrelated sibling .mcmeta untouched and never derives a name",
		async run(surface) {
			await withFixture(async ({ root, sheet }) => {
				const sibling = join(root, "sheet.png.mcmeta");
				await writeFile(sibling, '{"keep":true}\n');
				const output = join(root, "elsewhere.mcmeta");
				const result = await surface.cli("animation", sheet, {
					frameSize: "16",
					output,
				});
				assert.equal(result.code, 0, result.stderr);
				assert.equal(await readFile(sibling, "utf8"), '{"keep":true}\n');
				assert.equal(await readFile(output, "utf8"), SHEET_TEXT);
			});
		},
	},
	{
		name: "CLI needs --mkdir for a missing parent and then creates it",
		async run(surface) {
			await withFixture(async ({ root, sheet }) => {
				const output = join(root, "deep", "out.mcmeta");
				const refused = await surface.cli("animation", sheet, {
					frameSize: "16",
					output,
				});
				assert.equal(refused.code, 4);
				assert.ok(!(await listing(root)).includes("deep"));
				const made = await surface.cli("animation", sheet, {
					frameSize: "16",
					output,
					mkdir: true,
				});
				assert.equal(made.code, 0, made.stderr);
				assert.equal(await readFile(output, "utf8"), SHEET_TEXT);
			});
		},
	},
	{
		name: "generated files read back through validate, animate, and gui-scale",
		async run(surface) {
			await withFixture(async ({ root, sheet, panel }) => {
				const animationMeta = join(root, "sheet.mcmeta");
				const written = await surface.cli("animation", sheet, {
					frameSize: "16",
					frames: "[3,1,1]",
					output: animationMeta,
				});
				assert.equal(written.code, 0, written.stderr);
				const validated = captureQuantizeStreams();
				assert.equal(
					await runValidate(
						sheet,
						{ mcmeta: animationMeta },
						true,
						validated.streams,
					),
					0,
					validated.stderrText(),
				);
				const section = JSON.parse(
					Buffer.from(validated.stdout()).toString("utf8").trim(),
				).result.mcmeta.animation;
				assert.equal(section.frameCount, 4);
				assert.deepEqual(section.frameIndices, [3, 1, 1]);
				const framesDir = join(root, "frames");
				await mkdir(framesDir);
				const unpacked = captureQuantizeStreams();
				assert.equal(
					await runAnimate(
						"unpack",
						sheet,
						{
							layout: "vertical",
							frameSize: "16",
							outputDir: framesDir,
							mcmeta: animationMeta,
						},
						true,
						unpacked.streams,
					),
					0,
					unpacked.stderrText(),
				);
				const framesValidated = captureQuantizeStreams();
				assert.equal(
					await runAnimate(
						"validate",
						undefined,
						{ framesDir, mcmeta: animationMeta },
						true,
						framesValidated.streams,
					),
					0,
					framesValidated.stderrText(),
				);
				const guiMeta = join(root, "panel.mcmeta");
				const guiWritten = await surface.cli("gui", panel, {
					...NINE_SLICE,
					output: guiMeta,
				});
				assert.equal(guiWritten.code, 0, guiWritten.stderr);
				const guiValidated = captureQuantizeStreams();
				assert.equal(
					await runValidate(
						panel,
						{ mcmeta: guiMeta },
						true,
						guiValidated.streams,
					),
					0,
					guiValidated.stderrText(),
				);
				const scaled = captureQuantizeStreams();
				assert.equal(
					await runGuiScale(
						panel,
						{ size: "32", mcmeta: guiMeta, output: join(root, "big.png") },
						true,
						scaled.streams,
					),
					0,
					scaled.stderrText(),
				);
				assert.equal(
					JSON.parse(Buffer.from(scaled.stdout()).toString("utf8").trim())
						.result.scaling.type,
					"nine_slice",
				);
			});
		},
	},
];

function envelopeOnStderr(result: McmetaCliResult): McmetaCliResult {
	return { ...result, stdout: new TextEncoder().encode(result.stderr) };
}

export const MCMETA_GENERATE_MCP_CASES: {
	name: string;
	run(): Promise<void>;
}[] = [
	{
		name: "MCP without outputPath returns the text and writes nothing",
		async run() {
			await withFixture(async ({ root, sheet }) => {
				const { isError, body } = await mcp({
					mode: "animation",
					inputPath: sheet,
					frameSize: "16",
				});
				assert.equal(isError, false, JSON.stringify(body));
				assert.equal(body.mcmetaText, SHEET_TEXT);
				assert.equal(body.versionChecked, false);
				assert.deepEqual(await listing(root), ["panel.png", "sheet.png"]);
			});
		},
	},
	{
		name: "MCP and CLI produce the same bytes for animation and gui",
		async run() {
			await withFixture(async ({ root, sheet, panel }) => {
				const viaMcp = await mcp({
					mode: "gui",
					inputPath: panel,
					type: "nine_slice",
					border: 4,
				});
				const cliOut = join(root, "cli.mcmeta");
				const viaCli = await runMcmetaCli("gui", panel, {
					...NINE_SLICE,
					output: cliOut,
				});
				assert.equal(viaCli.code, 0, viaCli.stderr);
				assert.equal(viaMcp.body.mcmetaText, await readFile(cliOut, "utf8"));
				assert.equal(viaMcp.body.mcmetaText, PANEL_TEXT);
				const animation = await mcp({
					mode: "animation",
					inputPath: sheet,
					frameSize: "16",
					frametime: 2,
					frames: [0, { index: 1, time: 9 }],
				});
				assert.equal(
					animation.body.mcmetaText,
					'{"animation":{"width":16,"height":16,"frametime":2,"frames":[0,{"index":1,"time":9}]}}\n',
				);
			});
		},
	},
	{
		name: "MCP outputPath writes through the shared guard",
		async run() {
			await withFixture(async ({ root, sheet }) => {
				const output = join(root, "out.mcmeta");
				const { isError, body } = await mcp({
					mode: "animation",
					inputPath: sheet,
					frameSize: "16",
					outputPath: output,
				});
				assert.equal(isError, false, JSON.stringify(body));
				assert.equal(body.output, output);
				assert.equal("mcmetaText" in body, false);
				assert.equal(await readFile(output, "utf8"), SHEET_TEXT);
			});
		},
	},
	{
		name: "MCP keeps an existing outputPath unless force, then replaces the whole file",
		async run() {
			await withFixture(async ({ root, sheet }) => {
				const output = join(root, "out.mcmeta");
				const previous = '{"texture":{"mipmap_strategy":"mean"}}\n';
				await writeFile(output, previous);
				const refused = await mcp({
					mode: "animation",
					inputPath: sheet,
					frameSize: "16",
					outputPath: output,
				});
				assert.equal(refused.isError, true);
				assert.equal(refused.body.code, "OUTPUT_EXISTS");
				assert.equal(await readFile(output, "utf8"), previous);
				const forced = await mcp({
					mode: "animation",
					inputPath: sheet,
					frameSize: "16",
					outputPath: output,
					force: true,
				});
				assert.equal(forced.isError, false, JSON.stringify(forced.body));
				assert.equal(await readFile(output, "utf8"), SHEET_TEXT);
			});
		},
	},
	{
		name: "MCP output path rules: extension, mkdir, symlink, source alias, force without path",
		async run() {
			await withFixture(async ({ root, sheet }) => {
				const base = {
					mode: "animation",
					inputPath: sheet,
					frameSize: "16",
				} as const;
				const wrong = await mcp({ ...base, outputPath: join(root, "o.json") });
				assert.equal(wrong.body.code, "INVALID_ARGUMENT");
				const missing = await mcp({
					...base,
					outputPath: join(root, "deep", "o.mcmeta"),
				});
				assert.equal(missing.body.code, "FILESYSTEM_ERROR");
				const made = await mcp({
					...base,
					outputPath: join(root, "deep", "o.mcmeta"),
					mkdir: true,
				});
				assert.equal(made.isError, false, JSON.stringify(made.body));
				assert.equal(
					await readFile(join(root, "deep", "o.mcmeta"), "utf8"),
					SHEET_TEXT,
				);
				const target = join(root, "target.mcmeta");
				await writeFile(target, "original");
				await symlink(target, join(root, "link.mcmeta"));
				const linked = await mcp({
					...base,
					outputPath: join(root, "link.mcmeta"),
					force: true,
				});
				assert.equal(linked.isError, true);
				assert.equal(await readFile(target, "utf8"), "original");
				const aliased = join(root, "sheet-as.mcmeta");
				const bytes = solidPng(16, 64);
				await writeFile(aliased, bytes);
				const alias = await mcp({
					...base,
					inputPath: aliased,
					outputPath: aliased,
					force: true,
				});
				assert.equal(alias.body.code, "ARGUMENT_CONFLICT");
				assert.deepEqual(new Uint8Array(await readFile(aliased)), bytes);
				const bare = await mcp({ ...base, force: true });
				assert.equal(bare.body.code, "INVALID_ARGUMENT");
			});
		},
	},
	{
		name: "MCP refuses fields of the other mode and invalid parameters",
		async run() {
			await withFixture(async ({ sheet, panel }) => {
				const crossed = await mcp({
					mode: "animation",
					inputPath: sheet,
					frameSize: "16",
					type: "stretch",
				});
				assert.equal(crossed.body.code, "INVALID_ARGUMENT");
				const flag = await mcp({
					mode: "gui",
					inputPath: panel,
					type: "stretch",
					interpolate: false,
				});
				assert.equal(flag.body.code, "INVALID_ARGUMENT");
				const outOfRange = await mcp({
					mode: "animation",
					inputPath: sheet,
					frameSize: "16",
					frames: [0, 4],
				});
				assert.equal(outOfRange.body.code, "INVALID_ANIMATION_FRAME");
				const noBorder = await mcp({
					mode: "gui",
					inputPath: panel,
					type: "nine_slice",
				});
				assert.equal(noBorder.body.code, "INVALID_ARGUMENT");
				for (const type of ["nine_slice", "repeat"]) {
					await assert.rejects(
						prepareMcmeta({
							mode: "gui",
							inputPath: panel,
							type,
							resourcePackVersion: "15",
						}),
						(error: unknown) =>
							error instanceof Error &&
							"code" in error &&
							error.code === "INVALID_ARGUMENT",
					);
				}
				const fills = await mcp({
					mode: "gui",
					inputPath: panel,
					type: "nine_slice",
					border: 8,
				});
				assert.equal(fills.body.code, "INVALID_MCMETA");
			});
		},
	},
	{
		name: "MCP version: gui.scaling is refused on 1.20.1 and written on 1.20.2 and by pack format",
		async run() {
			await withFixture(async ({ root, panel }) => {
				const base = { mode: "gui", inputPath: panel, type: "tile" } as const;
				const old = await mcp({ ...base, minecraftVersion: "1.20.1" });
				assert.equal(old.body.code, "ARGUMENT_CONFLICT");
				const oldFormat = await mcp({ ...base, resourcePackVersion: "15" });
				assert.equal(oldFormat.body.code, "ARGUMENT_CONFLICT");
				const fresh = await mcp({ ...base, minecraftVersion: "1.20.2" });
				assert.equal(fresh.isError, false, JSON.stringify(fresh.body));
				assert.equal(fresh.body.versionChecked, true);
				const far = await mcp({ ...base, resourcePackVersion: "999" });
				assert.equal(far.body.versionChecked, false);
				assert.deepEqual(
					far.body.warnings.map((warning: { code: string }) => warning.code),
					["VERSION_NOT_CHECKED"],
				);
				const bad = await mcp({ ...base, resourcePackVersion: "abc" });
				assert.equal(bad.body.code, "INVALID_ARGUMENT");
				assert.deepEqual(await listing(root), ["panel.png", "sheet.png"]);
			});
		},
	},
	{
		name: "MCP version: older target refuses stretch_inner, newer writes it, none is unchecked",
		async run() {
			await withFixture(async ({ panel }) => {
				const request = {
					mode: "gui",
					inputPath: panel,
					type: "nine_slice",
					border: 4,
					stretchInner: true,
				} as const;
				const old = await mcp({ ...request, minecraftVersion: "1.21" });
				assert.equal(old.body.code, "ARGUMENT_CONFLICT");
				const fresh = await mcp({ ...request, minecraftVersion: "1.21.2" });
				assert.equal(fresh.isError, false, JSON.stringify(fresh.body));
				assert.equal(fresh.body.versionChecked, true);
				assert.ok(fresh.body.mcmetaText.includes('"stretch_inner":true'));
				const none = await mcp(request);
				assert.equal(none.body.versionChecked, false);
				assert.deepEqual(
					none.body.warnings.map((warning: { code: string }) => warning.code),
					["VERSION_NOT_CHECKED"],
				);
			});
		},
	},
];
