import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ModelMode, runModel } from "../../src/cli/cmd-model.ts";
import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../src/core/canvas.ts";
import { decodePng, encodePng } from "../../src/io/png.ts";
import { handleModelAsset } from "../../src/mcp/handlers-model-optimize.ts";
import { exportBbmodel, importBbmodel } from "../../src/model/bbmodel/index.ts";
import { captureStreams } from "../cli/optimize-model-cases.ts";
import {
	assertError,
	type CaseCheck,
	type ModelCase,
} from "./json-document-cases.ts";

const REAL_FIXTURE = fileURLToPath(
	new URL("./fixtures/bbmodel/seed_analyzer_journal.bbmodel", import.meta.url),
);
const SYNTHETIC_FIXTURE = fileURLToPath(
	new URL("./fixtures/bbmodel/synthetic.bbmodel", import.meta.url),
);
const MODEL_LIMIT = 1_048_576;
const TEXTURE_RELATIVE = "assets/minecraft/textures/block/fixture.png";
const REAL_TEXTURE_RELATIVE =
	"assets/agricraft/textures/block/seed_analyzer_pane.png";

function realFixtureText(): string {
	return readFileSync(REAL_FIXTURE, "utf8");
}

function syntheticFixtureText(): string {
	return readFileSync(SYNTHETIC_FIXTURE, "utf8");
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`expected an object, received ${typeof value}`);
	}
	return value as JsonObject;
}

function asArray(value: unknown): readonly unknown[] {
	if (!Array.isArray(value)) {
		throw new Error(`expected an array, received ${typeof value}`);
	}
	return value;
}

function str(source: JsonObject, key: string): string {
	const value = source[key];
	if (typeof value !== "string") throw new Error(`expected string ${key}`);
	return value;
}

interface CliRun {
	readonly code: number;
	readonly body: JsonObject;
}

async function cliModel(
	mode: ModelMode,
	input: string,
	options: Parameters<typeof runModel>[2],
): Promise<CliRun> {
	const capture = captureStreams();
	const code = await runModel(mode, input, options, true, capture.streams);
	const text = Buffer.from(capture.stdout()).toString("utf8").trim();
	return { code, body: text === "" ? {} : asObject(JSON.parse(text)) };
}

function cliResult(check: CaseCheck, run: CliRun): JsonObject {
	check.equal(run.code, 0, `exit ${run.code}`);
	return asObject(run.body.result);
}

function cliErrorCode(run: CliRun): string {
	const error = run.body.error;
	return typeof error === "object" && error !== null
		? str(error as JsonObject, "code")
		: "";
}

async function withTemp(body: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "bbmodel-"));
	try {
		await body(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function listing(path: string): Promise<string[]> {
	try {
		return (await readdir(path)).sort();
	} catch {
		return [];
	}
}

function embeddedPng(text: string): Uint8Array {
	const document = asObject(JSON.parse(text));
	const source = str(asArray(document.textures)[0] as JsonObject, "source");
	const payload = source.slice(source.indexOf(",") + 1);
	return new Uint8Array(Buffer.from(payload, "base64"));
}

function pixelsOf(png: Uint8Array): {
	width: number;
	height: number;
	pixels: number[];
} {
	const decoded = decodePng(png);
	const layer = decoded.canvas.layers[0];
	if (layer === undefined) throw new Error("decoded PNG has no layer");
	return {
		width: decoded.canvas.width,
		height: decoded.canvas.height,
		pixels: Array.from(layer.pixels),
	};
}

function mcpBody(
	result: Awaited<ReturnType<typeof handleModelAsset>>,
): JsonObject {
	const content = result.content[0];
	if (content === undefined || content.type !== "text") {
		throw new Error("MCP result has no text block");
	}
	return asObject(JSON.parse(content.text));
}

/** Replace the run-specific roots so two runs can be compared field by field. */
function normalized(value: unknown, roots: readonly string[]): string {
	let text = JSON.stringify(value);
	for (const root of roots) text = text.split(root).join("<root>");
	return text;
}

/** The acceptance fields of one element: extents, rotation, face UV and texture. */
function elementShape(element: JsonObject): JsonObject {
	const faces = asObject(element.faces);
	const shape: JsonObject = {};
	for (const direction of Object.keys(faces).sort()) {
		const face = asObject(faces[direction]);
		shape[direction] = { uv: face.uv, texture: face.texture };
	}
	return {
		name: element.name,
		from: element.from,
		to: element.to,
		rotation: element.rotation,
		faces: shape,
	};
}

function elementShapes(model: JsonObject): JsonObject[] {
	return asArray(model.elements).map((element) =>
		elementShape(asObject(element)),
	);
}

function largeNoisePng(size: number): Uint8Array {
	const canvas = createCanvas(size, size);
	const layer = addLayer(canvas, { id: "base" });
	const pixels = new Uint8Array(size * size * 4);
	let state = 123_456_789;
	for (let index = 0; index < pixels.length; index += 4) {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		pixels[index] = state & 255;
		pixels[index + 1] = (state >>> 8) & 255;
		pixels[index + 2] = (state >>> 16) & 255;
		pixels[index + 3] = 255;
	}
	replaceLayerPixels(canvas, layer.id, pixels);
	return encodePng(canvas);
}

export const BBMODEL_CASES: ModelCase[] = [
	{
		name: "bbmodel: the real Blockbench save imports, validates clean, and keeps its texture bytes and rotation",
		async run(check) {
			await withTemp(async (root) => {
				const modelPath = join(root, "model.json");
				const textureRoot = join(root, "pack");
				const run = await cliModel("import-bbmodel", REAL_FIXTURE, {
					output: modelPath,
					textures: textureRoot,
					mkdir: true,
				});
				const result = cliResult(check, run);
				check.equal(result.mode, "import-bbmodel");
				check.equal(result.formatVersion, "3.6");
				check.deepEqual(result.resolution, { width: 16, height: 16 });
				check.equal(result.elementCount, 1);
				check.equal(result.textureCount, 1);

				const model = asObject(JSON.parse(await readFile(modelPath, "utf8")));
				check.equal(model.texture_size, undefined);
				check.deepEqual(model.textures, {
					"4": "agricraft:block/seed_analyzer_pane",
				});
				const element = asObject(asArray(model.elements)[0]);
				check.equal(element.name, "book");
				check.deepEqual(element.from, [11.5, 4, 6.5]);
				check.deepEqual(element.to, [15.5, 5, 11.5]);
				check.deepEqual(element.rotation, {
					origin: [19, 12, 14],
					axis: "y",
					angle: 22.5,
				});
				const faces = asObject(element.faces);
				const east = asObject(faces.east);
				check.equal(east.texture, "#4");
				check.equal(east.rotation, 90);
				check.deepEqual(east.uv, [11, 0, 12, 5]);
				check.deepEqual(asObject(faces.north).uv, [11, 5, 15, 6]);
				check.deepEqual(asObject(asObject(model.display).gui), {
					rotation: [45, 135, 0],
					translation: [-0.25, 2, 0],
					scale: [0.75, 0.75, 0.75],
				});

				const validated = await cliModel("validate", modelPath, {
					resourcePackVersion: "97.1",
				});
				const report = asObject(cliResult(check, validated));
				check.equal(report.verdict, "pass");
				check.deepEqual(
					asArray(report.findings).filter(
						(finding) => asObject(finding).level === "error",
					),
					[],
				);

				const texturePath = join(textureRoot, REAL_TEXTURE_RELATIVE);
				const written = new Uint8Array(await readFile(texturePath));
				const embedded = embeddedPng(realFixtureText());
				check.equal(
					Buffer.compare(Buffer.from(written), Buffer.from(embedded)),
					0,
					"the written PNG differs from the embedded texture bytes",
				);
				check.equal(written.length, embedded.length);
				check.deepEqual(pixelsOf(written).pixels, pixelsOf(embedded).pixels);
				check.equal(
					str(asArray(result.textures)[0] as JsonObject, "output"),
					texturePath,
				);
			});
		},
	},
	{
		name: "bbmodel: the real Blockbench save roundtrips through export with the same elements and texture",
		async run(check) {
			await withTemp(async (root) => {
				const firstPath = join(root, "first.json");
				const textureRoot = join(root, "pack");
				cliResult(
					check,
					await cliModel("import-bbmodel", REAL_FIXTURE, {
						output: firstPath,
						textures: textureRoot,
						mkdir: true,
					}),
				);
				const projectPath = join(root, "roundtrip.bbmodel");
				const exported = await cliModel("export-bbmodel", firstPath, {
					output: projectPath,
					texture: [`4=${join(textureRoot, REAL_TEXTURE_RELATIVE)}`],
				});
				const exportResult = cliResult(check, exported);
				check.equal(exportResult.elementCount, 1);
				check.equal(exportResult.textureCount, 1);

				const secondPath = join(root, "second.json");
				cliResult(
					check,
					await cliModel("import-bbmodel", projectPath, {
						output: secondPath,
						textures: join(root, "pack2"),
						mkdir: true,
					}),
				);
				const first = asObject(JSON.parse(await readFile(firstPath, "utf8")));
				const second = asObject(JSON.parse(await readFile(secondPath, "utf8")));
				check.deepEqual(elementShapes(second), elementShapes(first));
				check.deepEqual(second.textures, first.textures);
				check.deepEqual(second.display, first.display);
			});
		},
	},
	{
		name: "bbmodel: the synthetic fixture imports, validates clean, and writes the embedded texture pixels",
		async run(check) {
			await withTemp(async (root) => {
				const modelPath = join(root, "model.json");
				const textureRoot = join(root, "pack");
				const run = await cliModel("import-bbmodel", SYNTHETIC_FIXTURE, {
					output: modelPath,
					textures: textureRoot,
					mkdir: true,
				});
				const result = cliResult(check, run);
				check.equal(result.mode, "import-bbmodel");
				check.equal(result.formatVersion, "5.0");
				check.deepEqual(result.resolution, { width: 48, height: 32 });
				check.equal(result.elementCount, 2);
				check.equal(result.textureCount, 1);

				const modelText = await readFile(modelPath, "utf8");
				const model = asObject(JSON.parse(modelText));
				check.deepEqual(model.texture_size, [48, 32]);
				check.deepEqual(model.textures, { all: "block/fixture" });
				check.deepEqual(model.display, {
					gui: {
						rotation: [30, 45, 0],
						translation: [1, 2, 3],
						scale: [1.5, 1.5, 1.5],
					},
				});
				const rotated = asObject(asArray(model.elements)[0]);
				check.deepEqual(rotated.rotation, {
					origin: [8, 6, 4],
					axis: "y",
					angle: 22.5,
				});

				const validated = await cliModel("validate", modelPath, {
					resourcePackVersion: "97.1",
				});
				const report = asObject(cliResult(check, validated));
				check.equal(report.verdict, "pass");
				check.deepEqual(
					asArray(report.findings).filter(
						(finding) => asObject(finding).level === "error",
					),
					[],
				);

				const texturePath = join(textureRoot, TEXTURE_RELATIVE);
				const written = new Uint8Array(await readFile(texturePath));
				const original = embeddedPng(syntheticFixtureText());
				const originalPixels = pixelsOf(original);
				const writtenPixels = pixelsOf(written);
				check.equal(writtenPixels.width, originalPixels.width);
				check.equal(writtenPixels.height, originalPixels.height);
				check.deepEqual(writtenPixels.pixels, originalPixels.pixels);
				check.equal(
					str(asArray(result.textures)[0] as JsonObject, "output"),
					texturePath,
				);
			});
		},
	},
	{
		name: "bbmodel: the synthetic project exports then imports with the same from, to, rotation, face UV and texture assignment",
		async run(check) {
			await withTemp(async (root) => {
				const modelPath = join(root, "first.json");
				const textureRoot = join(root, "pack");
				const first = await cliModel("import-bbmodel", SYNTHETIC_FIXTURE, {
					output: modelPath,
					textures: textureRoot,
					mkdir: true,
				});
				cliResult(check, first);
				const texturePath = join(textureRoot, TEXTURE_RELATIVE);
				const projectPath = join(root, "roundtrip.bbmodel");
				const exported = await cliModel("export-bbmodel", modelPath, {
					output: projectPath,
					texture: [`all=${texturePath}`],
				});
				const exportResult = cliResult(check, exported);
				check.equal(exportResult.formatVersion, "5.0");
				check.equal(exportResult.elementCount, 2);
				check.equal(exportResult.textureCount, 1);

				const project = asObject(
					JSON.parse(await readFile(projectPath, "utf8")),
				);
				check.deepEqual(project.meta, {
					format_version: "5.0",
					model_format: "java_block",
					box_uv: false,
				});
				const projectTextures = asArray(project.textures);
				check.equal(projectTextures.length, 1);
				check.ok(
					str(projectTextures[0] as JsonObject, "source").startsWith(
						"data:image/png;base64,",
					),
					"texture is embedded as a PNG data URL",
				);

				const backPath = join(root, "second.json");
				const back = await cliModel("import-bbmodel", projectPath, {
					output: backPath,
					textures: join(root, "pack2"),
					mkdir: true,
				});
				cliResult(check, back);
				const original = asObject(
					JSON.parse(await readFile(modelPath, "utf8")),
				);
				const roundtripped = asObject(
					JSON.parse(await readFile(backPath, "utf8")),
				);
				check.deepEqual(elementShapes(roundtripped), elementShapes(original));
				check.deepEqual(roundtripped.textures, original.textures);
				check.deepEqual(roundtripped.display, original.display);
				check.equal(
					await readFile(backPath, "utf8"),
					await readFile(modelPath, "utf8"),
				);
			});
		},
	},
	{
		name: "bbmodel: box UV expands to Blockbench's six-face layout",
		run(check) {
			const text = JSON.stringify({
				meta: {
					format_version: "5.0",
					model_format: "java_block",
					box_uv: true,
				},
				resolution: { width: 16, height: 16 },
				textures: [{ id: "all", name: "all", folder: "block" }],
				elements: [
					{
						from: [0, 0, 0],
						to: [16, 16, 16],
						box_uv: true,
						faces: {
							north: { texture: 0 },
							east: { texture: 0 },
							south: { texture: 0 },
							west: { texture: 0 },
							up: { texture: 0 },
							down: { texture: 0 },
						},
					},
				],
			});
			const result = importBbmodel(text);
			const element = (result.spec.elements ?? [])[0];
			check.ok(element !== undefined, "one element");
			const faces = (element as { faces: JsonObject }).faces;
			const uv = (direction: string): unknown => asObject(faces[direction]).uv;
			check.deepEqual(uv("east"), [0, 16, 16, 32]);
			check.deepEqual(uv("west"), [32, 16, 48, 32]);
			check.deepEqual(uv("up"), [32, 16, 16, 0]);
			check.deepEqual(uv("down"), [48, 0, 32, 16]);
			check.deepEqual(uv("south"), [48, 16, 64, 32]);
			check.deepEqual(uv("north"), [16, 16, 32, 32]);
		},
	},
	{
		name: "bbmodel: a non-Java project, a newer version, and a damaged texture fail nothing is written",
		async run(check) {
			await withTemp(async (root) => {
				const cases: {
					readonly name: string;
					readonly code: string;
					readonly exit: number;
					mutate(document: JsonObject): void;
				}[] = [
					{
						name: "free-model",
						code: "BBMODEL_UNSUPPORTED_FORMAT",
						exit: 2,
						mutate(document) {
							asObject(document.meta).model_format = "free";
						},
					},
					{
						name: "no-meta",
						code: "BBMODEL_UNSUPPORTED_FORMAT",
						exit: 2,
						mutate(document) {
							delete document.meta;
						},
					},
					{
						name: "newer-version",
						code: "BBMODEL_UNSUPPORTED_VERSION",
						exit: 5,
						mutate(document) {
							asObject(document.meta).format_version = "6.0";
						},
					},
					{
						name: "corrupt-base64",
						code: "BBMODEL_INVALID_TEXTURE",
						exit: 2,
						mutate(document) {
							asObject(asArray(document.textures)[0]).source =
								"data:image/png;base64,!!!!";
						},
					},
					{
						name: "not-a-png",
						code: "BBMODEL_INVALID_TEXTURE",
						exit: 2,
						mutate(document) {
							asObject(asArray(document.textures)[0]).source =
								"data:image/png;base64,aGVsbG8=";
						},
					},
					{
						name: "unreadable-utf8",
						code: "BBMODEL_INVALID_DOCUMENT",
						exit: 2,
						mutate() {
							// Handled by writing invalid UTF-8 bytes below.
						},
					},
				];
				for (const entry of cases) {
					const document = asObject(JSON.parse(syntheticFixtureText()));
					entry.mutate(document);
					const input = join(root, `${entry.name}.bbmodel`);
					const bytes =
						entry.name === "unreadable-utf8"
							? new Uint8Array([0xff, 0xfe, 0xfd])
							: new TextEncoder().encode(JSON.stringify(document));
					await writeFile(input, bytes);
					const output = join(root, `${entry.name}-out`);
					const run = await cliModel("import-bbmodel", input, {
						output: join(output, "model.json"),
						textures: join(output, "pack"),
						mkdir: true,
					});
					check.equal(run.code, entry.exit, `${entry.name} exit`);
					check.equal(cliErrorCode(run), entry.code, `${entry.name} code`);
					check.deepEqual(await listing(output), [], `${entry.name} wrote`);
				}
			});
		},
	},
	{
		name: "bbmodel: an input over the file byte limit is refused before writing",
		async run(check) {
			await withTemp(async (root) => {
				const oversized = JSON.stringify({
					meta: { format_version: "5.0", model_format: "java_block" },
					elements: [],
					textures: [],
					note: "a".repeat(MODEL_LIMIT),
				});
				check.ok(oversized.length > MODEL_LIMIT, "fixture exceeds the limit");
				const input = join(root, "oversized.bbmodel");
				await writeFile(input, oversized);
				const output = join(root, "out");
				const run = await cliModel("import-bbmodel", input, {
					output: join(output, "model.json"),
					textures: join(output, "pack"),
					mkdir: true,
				});
				check.equal(run.code, 5);
				check.equal(cliErrorCode(run), "RESOURCE_LIMIT_EXCEEDED");
				check.deepEqual(await listing(output), []);

				assertError(check, () => importBbmodel(oversized), [
					"RESOURCE_LIMIT_EXCEEDED",
				]);
			});
		},
	},
	{
		name: "bbmodel: generated output over the file byte limit is refused before writing",
		async run(check) {
			await withTemp(async (root) => {
				const png = largeNoisePng(540);
				check.ok(png.length < MODEL_LIMIT, "input PNG is under its own limit");
				check.ok(
					Math.ceil(png.length / 3) * 4 > MODEL_LIMIT,
					"base64 form exceeds the output limit",
				);
				const texturePath = join(root, "noise.png");
				await writeFile(texturePath, png);
				const modelPath = join(root, "model.json");
				await writeFile(
					modelPath,
					JSON.stringify({
						textures: { all: "test:block/noise" },
						elements: [
							{
								from: [0, 0, 0],
								to: [16, 16, 16],
								faces: { north: { texture: "#all" } },
							},
						],
					}),
				);
				const output = join(root, "out");
				const run = await cliModel("export-bbmodel", modelPath, {
					output: join(output, "model.bbmodel"),
					texture: [`all=${texturePath}`],
					mkdir: true,
				});
				check.equal(run.code, 5);
				check.equal(cliErrorCode(run), "RESOURCE_LIMIT_EXCEEDED");
				check.deepEqual(await listing(output), []);
			});
		},
	},
	{
		name: "bbmodel: import requires a texture directory when the project embeds PNGs",
		async run(check) {
			await withTemp(async (root) => {
				const run = await cliModel("import-bbmodel", SYNTHETIC_FIXTURE, {
					output: join(root, "model.json"),
				});
				check.equal(cliErrorCode(run), "OUTPUT_REQUIRED");
				check.deepEqual(await listing(root), []);
			});
		},
	},
	{
		name: "bbmodel: export reports a missing texture, an unknown variable, and a wrong extension",
		async run(check) {
			await withTemp(async (root) => {
				const modelPath = join(root, "model.json");
				await writeFile(
					modelPath,
					JSON.stringify({
						textures: { all: "test:block/noise" },
						elements: [
							{
								from: [0, 0, 0],
								to: [16, 16, 16],
								faces: { north: { texture: "#all" } },
							},
						],
					}),
				);
				const missing = await cliModel("export-bbmodel", modelPath, {
					output: join(root, "missing.bbmodel"),
				});
				check.equal(cliErrorCode(missing), "BBMODEL_MISSING_TEXTURE");

				const directPath = join(root, "direct.json");
				await writeFile(
					directPath,
					JSON.stringify({
						elements: [
							{
								from: [0, 0, 0],
								to: [16, 16, 16],
								faces: { north: { texture: "test:block/direct" } },
							},
						],
					}),
				);
				const directMissing = await cliModel("export-bbmodel", directPath, {
					output: join(root, "direct.bbmodel"),
				});
				check.equal(
					cliErrorCode(directMissing),
					"BBMODEL_MISSING_TEXTURE",
					"a face sprite named directly without a PNG",
				);

				const pngPath = join(root, "texture.png");
				await writeFile(pngPath, embeddedPng(syntheticFixtureText()));
				const unknown = await cliModel("export-bbmodel", modelPath, {
					output: join(root, "unknown.bbmodel"),
					texture: [`other=${pngPath}`],
				});
				check.equal(cliErrorCode(unknown), "BBMODEL_INVALID_TEXTURE");

				const aliasPath = join(root, "alias.json");
				await writeFile(
					aliasPath,
					JSON.stringify({
						textures: { alias: "#base", base: "test:block/noise" },
						elements: [
							{
								from: [0, 0, 0],
								to: [16, 16, 16],
								faces: { north: { texture: "#alias" } },
							},
						],
					}),
				);
				const aliasTexture = await cliModel("export-bbmodel", aliasPath, {
					output: join(root, "alias.bbmodel"),
					texture: [`alias=${pngPath}`, `base=${pngPath}`],
				});
				check.equal(
					cliErrorCode(aliasTexture),
					"BBMODEL_INVALID_TEXTURE",
					"a PNG supplied for an alias",
				);

				const extension = await cliModel("export-bbmodel", modelPath, {
					output: join(root, "model.txt"),
					texture: [`all=${pngPath}`],
				});
				check.equal(cliErrorCode(extension), "INVALID_ARGUMENT");
				check.deepEqual(
					(await listing(root)).filter((name) => name.endsWith(".bbmodel")),
					[],
				);
			});
		},
	},
	{
		name: "bbmodel: the CLI and the MCP tool write the same model, texture, and project bytes",
		async run(check) {
			await withTemp(async (root) => {
				const cliRoot = join(root, "cli");
				const mcpRoot = join(root, "mcp");
				const cliRun = await cliModel("import-bbmodel", SYNTHETIC_FIXTURE, {
					output: join(cliRoot, "model.json"),
					textures: join(cliRoot, "pack"),
					mkdir: true,
				});
				const cliResultBody = cliResult(check, cliRun);
				await mkdir(join(mcpRoot, "pack", "assets/minecraft/textures/block"), {
					recursive: true,
				});
				const mcpRun = await handleModelAsset({
					mode: "import-bbmodel",
					inputPath: SYNTHETIC_FIXTURE,
					outputPath: join(mcpRoot, "model.json"),
					textureOutputDir: join(mcpRoot, "pack"),
				});
				check.ok(mcpRun.isError !== true, "MCP import reported an error");
				const mcpResult = mcpBody(mcpRun);
				check.equal(
					normalized(cliResultBody, [cliRoot]),
					normalized(mcpResult, [mcpRoot]),
				);
				check.equal(
					await readFile(join(cliRoot, "model.json"), "utf8"),
					await readFile(join(mcpRoot, "model.json"), "utf8"),
				);
				check.ok(
					Buffer.from(
						await readFile(join(cliRoot, "pack", TEXTURE_RELATIVE)),
					).equals(
						Buffer.from(
							await readFile(join(mcpRoot, "pack", TEXTURE_RELATIVE)),
						),
					),
					"texture bytes differ between the CLI and the tool",
				);

				const cliProject = join(cliRoot, "model.bbmodel");
				const cliExport = await cliModel(
					"export-bbmodel",
					join(cliRoot, "model.json"),
					{
						output: cliProject,
						texture: [`all=${join(cliRoot, "pack", TEXTURE_RELATIVE)}`],
					},
				);
				const cliExportBody = cliResult(check, cliExport);
				const mcpProject = join(mcpRoot, "model.bbmodel");
				const mcpExport = await handleModelAsset({
					mode: "export-bbmodel",
					inputPath: join(mcpRoot, "model.json"),
					outputPath: mcpProject,
					texturePaths: { all: join(mcpRoot, "pack", TEXTURE_RELATIVE) },
				});
				check.ok(mcpExport.isError !== true, "MCP export reported an error");
				check.equal(
					normalized(cliExportBody, [cliRoot]),
					normalized(mcpBody(mcpExport), [mcpRoot]),
				);
				check.equal(
					await readFile(cliProject, "utf8"),
					await readFile(mcpProject, "utf8"),
				);
			});
		},
	},
	{
		name: "bbmodel: MCP without output paths embeds the model text and texture bytes",
		async run(check) {
			const run = await handleModelAsset({
				mode: "import-bbmodel",
				inputPath: SYNTHETIC_FIXTURE,
			});
			check.ok(run.isError !== true, "MCP import reported an error");
			const result = mcpBody(run);
			check.equal(typeof result.modelText, "string");
			const texture = asArray(result.textures)[0] as JsonObject;
			const encoded = str(texture, "pngBase64");
			const embedded = embeddedPng(syntheticFixtureText());
			check.ok(
				Buffer.from(encoded, "base64").equals(Buffer.from(embedded)),
				"embedded texture bytes differ from the project",
			);
			check.deepEqual(
				pixelsOf(new Uint8Array(Buffer.from(encoded, "base64"))).pixels,
				pixelsOf(embedded).pixels,
			);
		},
	},
	{
		name: "bbmodel: a textures-only model keeps its variables through export and import",
		run(check) {
			const exported = exportBbmodel(
				JSON.stringify({
					parent: "minecraft:block/block",
					textures: { all: "test:block/fixture" },
				}),
				new Map([["all", embeddedPng(syntheticFixtureText())]]),
			);
			const reimported = importBbmodel(exported.text);
			check.deepEqual(reimported.spec.textures, {
				all: "test:block/fixture",
			});
			check.equal(reimported.spec.elements, undefined);
			check.equal(reimported.spec.parent, "minecraft:block/block");
		},
	},
	{
		name: "bbmodel: unsupported element shapes and face indices are rejected with a document error",
		run(check) {
			const base = {
				meta: { format_version: "5.0", model_format: "java_block" },
				textures: [{ id: "all", name: "all" }],
			};
			const cases: unknown[] = [
				{
					...base,
					elements: [
						{
							type: "mesh",
							from: [0, 0, 0],
							to: [1, 1, 1],
							faces: {},
						},
					],
				},
				{
					...base,
					elements: [
						{
							from: [0, 0, 0],
							to: [1, 1, 1],
							faces: { middle: { texture: 0 } },
						},
					],
				},
				{
					...base,
					elements: [
						{
							from: [0, 0, 0],
							to: [1, 1, 1],
							faces: { north: { texture: 4 } },
						},
					],
				},
			];
			for (const document of cases) {
				assertError(check, () => importBbmodel(JSON.stringify(document)), [
					"BBMODEL_INVALID_DOCUMENT",
				]);
			}
			// Editor-only placeholders are skipped before the element type is checked.
			const placeholder = importBbmodel(
				JSON.stringify({
					...base,
					elements: [
						{
							type: "mesh",
							export: false,
							from: [0, 0, 0],
							to: [1, 1, 1],
							faces: {},
						},
						{
							from: [0, 0, 0],
							to: [1, 1, 1],
							faces: { north: { texture: 0 } },
						},
					],
				}),
			);
			check.equal(placeholder.spec.elements?.length, 1);
			const compressed = assertError(
				check,
				() => importBbmodel("<lz>compressed-bytes"),
				["BBMODEL_INVALID_DOCUMENT"],
			);
			check.equal(
				(compressed.details as { reason?: unknown }).reason,
				"compressed",
			);
		},
	},
	{
		name: "bbmodel: a face that names a sprite directly becomes its own texture variable",
		run(check) {
			const png = embeddedPng(syntheticFixtureText());
			const exported = exportBbmodel(
				JSON.stringify({
					textures: { base: "test:block/fixture" },
					elements: [
						{
							from: [0, 0, 0],
							to: [16, 16, 16],
							rotation: { origin: [8, 8, 8], axis: "y", angle: 22.5 },
							faces: {
								north: { texture: "test:block/ruby", uv: [0, 0, 8, 8] },
								south: { texture: "#base", uv: [8, 8, 16, 16] },
							},
						},
					],
				}),
				new Map([
					["test:block/ruby", png],
					["base", png],
				]),
			);
			const project = asObject(JSON.parse(exported.text));
			const textures = asArray(project.textures).map(asObject);
			check.deepEqual(
				textures.map((texture) => texture.id),
				["base", "ruby"],
			);
			check.equal(textures[1]?.name, "ruby");
			check.equal(textures[1]?.namespace, "test");
			check.equal(textures[1]?.folder, "block");
			const projectFaces = asObject(
				asObject(asArray(project.elements)[0]).faces,
			);
			check.equal(asObject(projectFaces.north).texture, 1);
			check.equal(asObject(projectFaces.south).texture, 0);

			const back = importBbmodel(exported.text);
			check.deepEqual(back.spec.textures, {
				base: "test:block/fixture",
				ruby: "test:block/ruby",
			});
			const imported = asObject((back.spec.elements ?? [])[0]);
			check.deepEqual(imported.from, [0, 0, 0]);
			check.deepEqual(imported.to, [16, 16, 16]);
			check.deepEqual(imported.rotation, {
				origin: [8, 8, 8],
				axis: "y",
				angle: 22.5,
			});
			check.deepEqual(asObject(imported.faces).north, {
				texture: "#ruby",
				uv: [0, 0, 8, 8],
			});
			check.deepEqual(asObject(imported.faces).south, {
				texture: "#base",
				uv: [8, 8, 16, 16],
			});
		},
	},
	{
		name: "bbmodel: a texture alias chain exports as an alias entry and re-imports intact",
		run(check) {
			const png = embeddedPng(syntheticFixtureText());
			const exported = exportBbmodel(
				JSON.stringify({
					textures: { alias: "#base", base: "test:block/fixture" },
					elements: [
						{
							from: [0, 0, 0],
							to: [4, 4, 4],
							faces: { up: { texture: "#alias", uv: [0, 0, 4, 4] } },
						},
					],
				}),
				new Map([["base", png]]),
			);
			const project = asObject(JSON.parse(exported.text));
			const textures = asArray(project.textures).map(asObject);
			check.deepEqual(
				textures.map((texture) => texture.id),
				["alias", "base"],
			);
			check.equal(textures[0]?.name, "#base");
			check.equal(textures[0]?.source, undefined);
			check.ok(
				str(textures[1] as JsonObject, "source").startsWith(
					"data:image/png;base64,",
				),
				"the base texture embeds its PNG",
			);
			const back = importBbmodel(exported.text);
			check.deepEqual(back.spec.textures, {
				alias: "#base",
				base: "test:block/fixture",
			});
			check.deepEqual(
				asObject(asObject((back.spec.elements ?? [])[0]).faces).up,
				{ texture: "#alias", uv: [0, 0, 4, 4] },
			);
		},
	},
];
