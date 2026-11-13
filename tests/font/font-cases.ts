import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputStreams } from "../../src/cli/channels.ts";
import { runFontRequest } from "../../src/cli/cmd-font.ts";
import { runValidatePack } from "../../src/cli/cmd-validate-pack.ts";
import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../src/core/canvas.ts";
import { McAssetError } from "../../src/core/errors.ts";
import type { RGBA } from "../../src/core/types.ts";
import { decodePng, encodePng, flattenCanvas } from "../../src/io/png.ts";
import { handleFontAsset } from "../../src/mcp/handlers.ts";

/**
 * Shared font-icon cases. They run under Bun and Node through the two
 * entry files, so every assertion uses the small check adapter below and
 * never a runner-specific API.
 */

export interface FontCaseCheck {
	equal(actual: unknown, expected: unknown, message?: string): void;
	deepEqual(actual: unknown, expected: unknown, message?: string): void;
	ok(value: unknown, message?: string): void;
	fail(message: string): never;
	throws(fn: () => unknown, code: string, message?: string): void;
	rejects(
		fn: () => Promise<unknown>,
		code: string,
		message?: string,
	): Promise<void>;
}

export interface FontCase {
	readonly name: string;
	run(check: FontCaseCheck): Promise<void> | void;
}

const RED: RGBA = { r: 255, g: 0, b: 0, a: 255 };
const GREEN: RGBA = { r: 0, g: 255, b: 0, a: 255 };
const BLUE: RGBA = { r: 0, g: 0, b: 255, a: 255 };

function solidPng(width: number, height: number, color: RGBA): Uint8Array {
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: "base" });
	const pixels = new Uint8Array(width * height * 4);
	for (let i = 0; i < pixels.length; i += 4) {
		pixels[i] = color.r;
		pixels[i + 1] = color.g;
		pixels[i + 2] = color.b;
		pixels[i + 3] = color.a;
	}
	replaceLayerPixels(canvas, layer.id, pixels);
	return encodePng(canvas);
}

export async function withTempDir<T>(
	run: (dir: string) => Promise<T>,
): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-font-"));
	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Write one solid icon and return its spec path, relative to the spec file. */
export async function writeIcon(
	dir: string,
	name: string,
	color: RGBA,
	size = 8,
): Promise<string> {
	const icons = join(dir, "icons");
	await mkdir(icons, { recursive: true });
	await writeFile(join(icons, `${name}.png`), solidPng(size, size, color));
	return `icons/${name}.png`;
}

export function baseSpec(): Record<string, unknown> {
	return {
		formatVersion: 1,
		namespace: "example",
		id: "icons",
		height: 8,
		ascent: 7,
		icons: [
			{ name: "apple", path: "icons/apple.png" },
			{ name: "banana", path: "icons/banana.png" },
			{ name: "cherry", path: "icons/cherry.png" },
		],
	};
}

export async function writeSpec(
	dir: string,
	spec: Record<string, unknown>,
	name = "font-spec.json",
): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, `${JSON.stringify(spec, null, 2)}\n`);
	return path;
}

function captureStreams(): {
	streams: OutputStreams;
	stdoutText(): string;
} {
	const out: Array<string | Uint8Array> = [];
	return {
		streams: {
			stdout: {
				write(chunk: string | Uint8Array): void {
					out.push(chunk);
				},
			},
			stderr: {
				write(): void {},
			},
		},
		stdoutText(): string {
			return out
				.map((chunk) =>
					typeof chunk === "string"
						? chunk
						: new TextDecoder("utf-8").decode(chunk),
				)
				.join("");
		},
	};
}

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function errorCode(error: unknown): string {
	return error instanceof McAssetError ? error.code : String(error);
}

/** Await a refusal and return the code, so cases can assert it directly. */
async function refusalCode(
	run: () => Promise<unknown>,
): Promise<{ code: string; message: string } | undefined> {
	try {
		await run();
		return undefined;
	} catch (error) {
		return { code: errorCode(error), message: String(error) };
	}
}

const DEFINITION_THREE = `{
  "providers": [
    {
      "ascent": 7,
      "chars": [
        "\uE000\uE001\uE002"
      ],
      "file": "example:font/icons.png",
      "height": 8,
      "type": "bitmap"
    }
  ]
}
`;

const TABLE_THREE = `{
  "font": "example:icons",
  "icons": [
    {
      "character": "\uE000",
      "codePoint": 57344,
      "name": "apple"
    },
    {
      "character": "\uE001",
      "codePoint": 57345,
      "name": "banana"
    },
    {
      "character": "\uE002",
      "codePoint": 57346,
      "name": "cherry"
    }
  ]
}
`;

export const FONT_CASES: readonly FontCase[] = [
	{
		name: "three 8x8 icons produce one atlas, one definition, and one table",
		async run(check) {
			await withTempDir(async (dir) => {
				await writeIcon(dir, "apple", RED);
				await writeIcon(dir, "banana", GREEN);
				await writeIcon(dir, "cherry", BLUE);
				const specPath = await writeSpec(dir, baseSpec());
				const pack = join(dir, "pack");
				const outputPath = join(pack, "assets/example/font/icons.json");
				const atlasPath = join(pack, "assets/example/textures/font/icons.png");
				const tablePath = join(dir, "icons-table.json");
				const outcome = await runFontRequest({
					specPath,
					outputPath,
					atlasPath,
					tablePath,
					mkdir: true,
					requireOutput: true,
				});
				const result = outcome.result;
				check.equal(result.font, "example:icons");
				check.equal(result.texture, "example:font/icons.png");
				check.equal(result.icons, 3);
				check.equal(result.columns, 3);
				check.equal(result.rows, 1);
				check.equal(result.height, 8);
				check.equal(result.ascent, 7);
				check.equal(result.output, outputPath);
				check.equal(result.atlas, atlasPath);
				check.equal(result.table, tablePath);
				check.equal(result.definitionText, undefined);
				check.equal(result.pngBase64, undefined);

				const definition = await readFile(outputPath, "utf8");
				check.equal(definition, DEFINITION_THREE);
				const table = await readFile(tablePath, "utf8");
				check.equal(table, TABLE_THREE);

				// The real atlas pixels: red, green, blue left to right.
				const decoded = decodePng(new Uint8Array(await readFile(atlasPath)));
				check.equal(decoded.canvas.width, 24);
				check.equal(decoded.canvas.height, 8);
				const pixels = flattenCanvas(decoded.canvas);
				check.deepEqual(
					[...pixels.slice(0, 4)],
					[255, 0, 0, 255],
					"apple cell starts red",
				);
				check.deepEqual(
					[...pixels.slice(8 * 4, 8 * 4 + 4)],
					[0, 255, 0, 255],
					"banana cell starts green",
				);
				check.deepEqual(
					[...pixels.slice(16 * 4, 16 * 4 + 4)],
					[0, 0, 255, 255],
					"cherry cell starts blue",
				);

				// Pack verdict: the font reference resolves to the atlas just
				// written, so a known pack format produces no error at all.
				const captured = captureStreams();
				const code = await runValidatePack(
					pack,
					{ resourcePackVersion: "46" },
					true,
					captured.streams,
				);
				check.equal(code, 0, "validate-pack exits 0");
				const envelope = JSON.parse(captured.stdoutText()) as {
					success: boolean;
					result: {
						verdict: string;
						findings: Array<{ code: string; level: string }>;
					};
				};
				check.equal(envelope.success, true);
				check.equal(envelope.result.verdict, "pass");
				check.deepEqual(
					envelope.result.findings.filter(
						(finding) => finding.level === "error",
					),
					[],
					"no error findings",
				);
				check.equal(
					envelope.result.findings.some(
						(finding) => finding.code === "PACK_MISSING_TEXTURE",
					),
					false,
					"the bitmap file resolves",
				);
			});
		},
	},
	{
		name: "shuffled icon order produces byte-identical artifacts",
		async run(check) {
			await withTempDir(async (dir) => {
				await writeIcon(dir, "apple", RED);
				await writeIcon(dir, "banana", GREEN);
				await writeIcon(dir, "cherry", BLUE);
				const forward = baseSpec();
				const reversed = {
					...baseSpec(),
					icons: [
						{ name: "cherry", path: "icons/cherry.png" },
						{ name: "apple", path: "icons/apple.png" },
						{ name: "banana", path: "icons/banana.png" },
					],
				};
				const forwardPath = await writeSpec(dir, forward, "forward.json");
				const reversedPath = await writeSpec(dir, reversed, "reversed.json");
				const runInto = async (specPath: string, name: string) => {
					const outputPath = join(dir, `${name}.json`);
					const atlasPath = join(dir, `${name}.png`);
					const tablePath = join(dir, `${name}-table.json`);
					await runFontRequest({
						specPath,
						outputPath,
						atlasPath,
						tablePath,
						requireOutput: true,
					});
					return {
						definition: await readFile(outputPath),
						atlas: new Uint8Array(await readFile(atlasPath)),
						table: await readFile(tablePath),
					};
				};
				const first = await runInto(forwardPath, "first");
				const second = await runInto(reversedPath, "second");
				check.equal(
					sha256(first.definition),
					sha256(second.definition),
					"definition bytes match",
				);
				check.equal(
					sha256(first.atlas),
					sha256(second.atlas),
					"atlas bytes match",
				);
				check.equal(
					sha256(first.table),
					sha256(second.table),
					"table bytes match",
				);
			});
		},
	},
	{
		name: "a duplicate code point is refused before anything is written",
		async run(check) {
			await withTempDir(async (dir) => {
				await writeIcon(dir, "apple", RED);
				await writeIcon(dir, "banana", GREEN);
				await writeIcon(dir, "cherry", BLUE);
				const spec = baseSpec();
				spec.icons = [
					{ name: "apple", path: "icons/apple.png", codePoint: "\uE001" },
					{ name: "banana", path: "icons/banana.png", codePoint: "\uE001" },
					{ name: "cherry", path: "icons/cherry.png" },
				];
				const specPath = await writeSpec(dir, spec);
				const outputPath = join(dir, "out/font.json");
				const atlasPath = join(dir, "out/icons.png");
				const tablePath = join(dir, "out/table.json");
				await mkdir(join(dir, "out"), { recursive: true });
				// A pre-existing target with --force must stay untouched, which
				// proves the refusal lands before the write phase.
				await writeFile(outputPath, "sentinel");
				const refused = await refusalCode(() =>
					runFontRequest({
						specPath,
						outputPath,
						atlasPath,
						tablePath,
						force: true,
						requireOutput: true,
					}),
				);
				check.equal(refused?.code, "FONT_CODEPOINT_CONFLICT");
				check.equal(await readFile(outputPath, "utf8"), "sentinel");
				check.equal(await exists(atlasPath), false);
				check.equal(await exists(tablePath), false);
			});
		},
	},
	{
		name: "ascent above height is refused before anything is written",
		async run(check) {
			await withTempDir(async (dir) => {
				await writeIcon(dir, "apple", RED);
				const spec = {
					...baseSpec(),
					ascent: 9,
					icons: [{ name: "apple", path: "icons/apple.png" }],
				};
				const specPath = await writeSpec(dir, spec);
				const outputPath = join(dir, "font.json");
				const atlasPath = join(dir, "icons.png");
				const refused = await refusalCode(() =>
					runFontRequest({
						specPath,
						outputPath,
						atlasPath,
						requireOutput: true,
					}),
				);
				check.equal(refused?.code, "FONT_INVALID");
				check.ok(
					refused?.message.includes("ascent"),
					"the message names ascent",
				);
				check.equal(await exists(outputPath), false);
				check.equal(await exists(atlasPath), false);
			});
		},
	},
	{
		name: "explicit code points are kept and automatic allocation skips them",
		async run(check) {
			await withTempDir(async (dir) => {
				await writeIcon(dir, "apple", RED);
				await writeIcon(dir, "banana", GREEN);
				await writeIcon(dir, "cherry", BLUE);
				const spec = baseSpec();
				spec.icons = [
					{ name: "apple", path: "icons/apple.png", codePoint: 0xe001 },
					{ name: "banana", path: "icons/banana.png" },
					{ name: "cherry", path: "icons/cherry.png" },
				];
				const specPath = await writeSpec(dir, spec);
				const outcome = await runFontRequest({
					specPath,
					requireOutput: false,
				});
				const table = JSON.parse(outcome.result.tableText ?? "") as {
					icons: Array<{ name: string; codePoint: number }>;
				};
				check.deepEqual(
					table.icons.map((icon) => [icon.name, icon.codePoint]),
					[
						["apple", 0xe001],
						["banana", 0xe000],
						["cherry", 0xe002],
					],
				);
				const definition = JSON.parse(outcome.result.definitionText ?? "") as {
					providers: Array<{ chars: string[] }>;
				};
				check.equal(
					definition.providers[0]?.chars[0],
					"\uE001\uE000\uE002",
					"layout order follows the name order, not the code point",
				);
			});
		},
	},
	{
		name: "space and reference providers follow the bitmap provider",
		async run(check) {
			await withTempDir(async (dir) => {
				await writeIcon(dir, "apple", RED);
				const spec = {
					formatVersion: 1,
					namespace: "example",
					id: "icons",
					height: 8,
					ascent: 7,
					texture: "example:font/custom.png",
					space: { advance: 4 },
					reference: "example:base",
					icons: [{ name: "apple", path: "icons/apple.png" }],
				};
				const specPath = await writeSpec(dir, spec);
				const outcome = await runFontRequest({
					specPath,
					requireOutput: false,
				});
				check.equal(outcome.result.texture, "example:font/custom.png");
				check.deepEqual(outcome.result.space, {
					character: " ",
					codePoint: 0x20,
					advance: 4,
				});
				check.equal(outcome.result.reference, "example:base");
				check.equal(
					outcome.result.definitionText,
					`{
  "providers": [
    {
      "ascent": 7,
      "chars": [
        "\uE000"
      ],
      "file": "example:font/custom.png",
      "height": 8,
      "type": "bitmap"
    },
    {
      "advances": {
        " ": 4
      },
      "type": "space"
    },
    {
      "id": "example:base",
      "type": "reference"
    }
  ]
}
`,
				);
			});
		},
	},
	{
		name: "a fixed column count wraps icons into rows",
		async run(check) {
			await withTempDir(async (dir) => {
				const names = ["alpha", "bravo", "charlie", "delta", "echo"];
				const icons: Array<{ name: string; path: string }> = [];
				for (const name of names) {
					const path = await writeIcon(dir, name, RED, 6);
					icons.push({ name, path });
				}
				const spec = {
					formatVersion: 1,
					namespace: "example",
					id: "grid",
					height: 8,
					ascent: 8,
					columns: 2,
					icons,
				};
				const specPath = await writeSpec(dir, spec);
				const outcome = await runFontRequest({
					specPath,
					requireOutput: false,
				});
				const result = outcome.result;
				check.equal(result.columns, 2);
				check.equal(result.rows, 3);
				check.equal(result.atlas, undefined);
				const definition = JSON.parse(result.definitionText ?? "") as {
					providers: Array<{ chars: string[] }>;
				};
				check.deepEqual(definition.providers[0]?.chars, [
					"\uE000\uE001",
					"\uE002\uE003",
					"\uE004",
				]);
				const decoded = decodePng(
					Buffer.from(result.pngBase64 ?? "", "base64"),
				);
				check.equal(decoded.canvas.width, 12);
				check.equal(decoded.canvas.height, 24);
				const pixels = flattenCanvas(decoded.canvas);
				// Third row, first column: "echo" starts at y = 16.
				check.equal(pixels[(16 * 12 + 0) * 4 + 3], 255);
				// The empty second cell of the last row stays transparent.
				check.equal(pixels[(16 * 12 + 6) * 4 + 3], 0);
			});
		},
	},
	{
		name: "an icon taller than the provider height is refused",
		async run(check) {
			await withTempDir(async (dir) => {
				await writeIcon(dir, "apple", RED, 9);
				const spec = baseSpec();
				spec.icons = [{ name: "apple", path: "icons/apple.png" }];
				const specPath = await writeSpec(dir, spec);
				const refused = await refusalCode(() =>
					runFontRequest({ specPath, requireOutput: false }),
				);
				check.equal(refused?.code, "FONT_INVALID");
				check.ok(
					refused?.message.includes("taller"),
					"the message explains the height problem",
				);
			});
		},
	},
	{
		name: "spec refusals name the field and write nothing",
		async run(check) {
			await withTempDir(async (dir) => {
				await writeIcon(dir, "apple", RED);
				await writeIcon(dir, "banana", GREEN);
				const cases: Array<{
					spec: Record<string, unknown>;
					code: string;
					needle: string;
				}> = [
					{
						spec: { ...baseSpec(), formatVersion: 2 },
						code: "FONT_UNSUPPORTED_VERSION",
						needle: "formatVersion",
					},
					{
						spec: { ...baseSpec(), unexpected: true },
						code: "FONT_INVALID",
						needle: "unexpected",
					},
					{
						spec: { ...baseSpec(), columns: 9 },
						code: "FONT_INVALID",
						needle: "columns",
					},
					{
						spec: {
							...baseSpec(),
							icons: [
								{ name: "apple", path: "icons/apple.png" },
								{ name: "apple", path: "icons/banana.png" },
							],
						},
						code: "FONT_INVALID",
						needle: "apple",
					},
					{
						spec: {
							...baseSpec(),
							icons: [
								{
									name: "apple",
									path: "icons/apple.png",
									codePoint: "\u0041",
								},
							],
						},
						code: "FONT_INVALID",
						needle: "private use",
					},
					{
						spec: {
							...baseSpec(),
							start: "\uF8FF",
							icons: [
								{ name: "apple", path: "icons/apple.png" },
								{ name: "banana", path: "icons/banana.png" },
							],
						},
						code: "FONT_INVALID",
						needle: "private use code point",
					},
					{
						spec: {
							...baseSpec(),
							space: { advance: 4, codePoint: "\uE000" },
							icons: [
								{
									name: "apple",
									path: "icons/apple.png",
									codePoint: "\uE000",
								},
							],
						},
						code: "FONT_CODEPOINT_CONFLICT",
						needle: "U+E000",
					},
				];
				for (const [index, entry] of cases.entries()) {
					const specPath = await writeSpec(
						dir,
						entry.spec,
						`case-${index}.json`,
					);
					const outputPath = join(dir, `case-${index}.json.out`);
					const refused = await refusalCode(() =>
						runFontRequest({
							specPath,
							outputPath,
							requireOutput: true,
						}),
					);
					check.equal(
						refused?.code,
						entry.code,
						`case ${index} reports ${entry.code}`,
					);
					check.ok(
						refused?.message.includes(entry.needle),
						`case ${index} message names ${entry.needle}: ${refused?.message}`,
					);
					check.equal(
						await exists(outputPath),
						false,
						`case ${index} wrote nothing`,
					);
				}
			});
		},
	},
	{
		name: "the shared pipeline requires exactly one spec source",
		async run(check) {
			const missing = await refusalCode(() =>
				runFontRequest({ requireOutput: false }),
			);
			check.equal(missing?.code, "INVALID_ARGUMENT");
			const both = await refusalCode(() =>
				runFontRequest({
					specPath: "a.json",
					spec: { formatVersion: 1 },
					requireOutput: false,
				}),
			);
			check.equal(both?.code, "INVALID_ARGUMENT");
			const noOutput = await refusalCode(() =>
				runFontRequest({
					spec: { formatVersion: 1 },
					requireOutput: true,
				}),
			);
			check.equal(noOutput?.code, "INVALID_ARGUMENT");
		},
	},
	{
		name: "existing outputs are refused without force and stay untouched",
		async run(check) {
			await withTempDir(async (dir) => {
				await writeIcon(dir, "apple", RED);
				const spec = {
					...baseSpec(),
					icons: [{ name: "apple", path: "icons/apple.png" }],
				};
				const specPath = await writeSpec(dir, spec);
				const outputPath = join(dir, "font-out.json");
				const atlasPath = join(dir, "atlas.png");
				const request = {
					specPath,
					outputPath,
					atlasPath,
					requireOutput: true,
				};
				await runFontRequest(request);
				const before = await readFile(outputPath);
				const refused = await refusalCode(() => runFontRequest(request));
				check.equal(refused?.code, "OUTPUT_EXISTS");
				check.equal(sha256(await readFile(outputPath)), sha256(before));
				const replaced = await runFontRequest({ ...request, force: true });
				check.equal(replaced.result.output, outputPath);
			});
		},
	},
	{
		name: "the MCP tool embeds the same bytes the CLI writes",
		async run(check) {
			await withTempDir(async (dir) => {
				await writeIcon(dir, "apple", RED);
				await writeIcon(dir, "banana", GREEN);
				await writeIcon(dir, "cherry", BLUE);
				const specPath = await writeSpec(dir, baseSpec());
				const written = await runFontRequest({
					specPath,
					outputPath: join(dir, "font.json"),
					atlasPath: join(dir, "icons.png"),
					tablePath: join(dir, "table.json"),
					requireOutput: true,
				});
				const embedded = await runFontRequest({
					specPath,
					requireOutput: false,
				});
				check.equal(
					embedded.result.definitionText,
					await readFile(join(dir, "font.json"), "utf8"),
					"embedded definition text matches the written file",
				);
				check.equal(embedded.result.tableText, TABLE_THREE);
				check.equal(
					embedded.result.pngBase64,
					Buffer.from(
						new Uint8Array(await readFile(join(dir, "icons.png"))),
					).toString("base64"),
				);
				check.equal(written.result.output, join(dir, "font.json"));

				const mcp = await handleFontAsset({
					specPath,
					outputPath: join(dir, "mcp-font.json"),
					atlasPath: join(dir, "mcp-icons.png"),
				});
				const text = mcp.content.find((entry) => entry.type === "text");
				check.ok(text?.type === "text", "the tool returns a text block");
				const body = JSON.parse(text?.type === "text" ? text.text : "{}") as {
					command: string;
					font: string;
					output: string;
					atlas: string;
				};
				check.equal(body.command, "font");
				check.equal(body.font, "example:icons");
				check.equal(
					await readFile(join(dir, "mcp-font.json"), "utf8"),
					DEFINITION_THREE,
				);
				check.equal(
					sha256(new Uint8Array(await readFile(join(dir, "mcp-icons.png")))),
					sha256(new Uint8Array(await readFile(join(dir, "icons.png")))),
				);
				const mismatch = await handleFontAsset({
					specPath,
					spec: baseSpec(),
				});
				check.ok(
					mismatch.isError === true,
					"two spec sources are refused by the tool",
				);
			});
		},
	},
];
