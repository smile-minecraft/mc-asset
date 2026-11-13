import { Buffer } from "node:buffer";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { McAssetError } from "../core/errors.ts";
import {
	type FontAtlasPlan,
	type FontGlyphSource,
	type FontPlan,
	type FontSpec,
	parseFontSpec,
	planFont,
} from "../font/index.ts";
import { emitCommandFailure, readInputText } from "./artifacts.ts";
import { loadEditableCanvas } from "./canvas-input.ts";
import {
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { successEnvelope } from "./envelope.ts";
import {
	type OutputTarget,
	planOutputTargets,
	writePlannedTargets,
} from "./safe-output.ts";

/**
 * `font` command and `font_asset` tool: one shared pipeline over
 * `src/font/`. The spec is parsed and every icon is loaded and planned
 * before the first output path is even planned, so a rejected spec, a
 * code-point collision, or an over-tall image writes nothing.
 *
 * The CLI writes all three artifacts and therefore requires a path for
 * each: `--output`, `--table`, and one atlas sink (`--atlas` for a single
 * height/ascent group, `--output-dir` when the spec needs more). The tool
 * writes what it is given a path for and embeds the rest.
 */

export interface FontCliOptions {
	output?: string | undefined;
	atlas?: string | undefined;
	outputDir?: string | undefined;
	table?: string | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
}

/** One decode warning tied to the icon that produced it. */
export interface FontWarning {
	readonly icon: string;
	readonly code: string;
	readonly message: string;
}

/** One bitmap atlas in the run report. */
export interface FontAtlasReport {
	readonly texture: string;
	readonly height: number;
	readonly ascent: number;
	readonly columns: number;
	readonly rows: number;
	readonly icons: number;
	readonly atlasWidth: number;
	readonly atlasHeight: number;
	/** Written path; absent when the atlas was embedded instead. */
	readonly atlas?: string | undefined;
	/** The artifact itself when no path was given. */
	readonly pngBase64?: string | undefined;
}

/** The run report shared by the CLI envelope and the MCP result. */
export interface FontReport {
	readonly command: "font";
	readonly font: string;
	readonly icons: number;
	/** One entry per distinct `(height, ascent)` pair, smallest height first. */
	readonly atlases: readonly FontAtlasReport[];
	readonly space?:
		| {
				readonly character: string;
				readonly codePoint: number;
				readonly advance: number;
		  }
		| undefined;
	readonly reference?: string | undefined;
	readonly warnings: readonly FontWarning[];
	/** Written path; absent means the text was embedded instead. */
	readonly output?: string | undefined;
	readonly table?: string | undefined;
	/** MCP without an output path: the artifact itself. */
	readonly definitionText?: string | undefined;
	readonly tableText?: string | undefined;
}

export interface FontRequest {
	/** Spec document path; exactly one of specPath and spec is set. */
	readonly specPath?: string | undefined;
	/** Inline spec document; exactly one of specPath and spec is set. */
	readonly spec?: unknown;
	readonly outputPath?: string | undefined;
	/** One atlas path; refused when the spec needs more than one atlas. */
	readonly atlasPath?: string | undefined;
	/** Directory receiving one atlas PNG per height/ascent group. */
	readonly atlasDirPath?: string | undefined;
	readonly tablePath?: string | undefined;
	readonly force?: boolean | undefined;
	readonly mkdir?: boolean | undefined;
	/** CLI true: the definition, an atlas sink, and the table path are all mandatory. */
	readonly requireArtifactPaths: boolean;
}

export interface FontOutcome {
	readonly result: FontReport;
}

/** Bad JSON is FONT_INVALID naming the file, never INTERNAL_ERROR. */
function parseFontSpecText(text: string, path: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new McAssetError("FONT_INVALID", `"${path}" is not valid JSON.`, {
			path,
		});
	}
}

function definedPath(value: string | undefined): string | undefined {
	return value === undefined || value === "" ? undefined : value;
}

/** The artifact paths, normalized once. */
interface FontPaths {
	readonly output?: string | undefined;
	readonly atlas?: string | undefined;
	readonly atlasDir?: string | undefined;
	readonly table?: string | undefined;
}

function fontPaths(request: FontRequest): FontPaths {
	return {
		output: definedPath(request.outputPath),
		atlas: definedPath(request.atlasPath),
		atlasDir: definedPath(request.atlasDirPath),
		table: definedPath(request.tablePath),
	};
}

/** The CLI writes every artifact, so a missing path is refused up front. */
function checkArtifactPaths(paths: FontPaths): void {
	if (paths.output === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"font needs --output (the font definition path).",
		);
	}
	if (paths.table === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"font needs --table (the icon-to-character table path).",
		);
	}
	if (paths.atlas === undefined && paths.atlasDir === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"font needs --atlas (one atlas .png) or --output-dir (one .png per height/ascent group).",
		);
	}
}

/** The file name a texture location ends with: `example:font/icons.png` -> `icons.png`. */
function textureFileName(texture: string): string {
	const path = texture.slice(texture.indexOf(":") + 1);
	return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Output path of every atlas, in group order. A single atlas path covers
 * one group; a directory covers any number, each file named from its
 * texture location.
 */
function atlasOutputPaths(
	paths: FontPaths,
	plan: FontPlan,
): readonly (string | undefined)[] {
	return plan.atlases.map((atlas) => {
		if (paths.atlas !== undefined) {
			return paths.atlas;
		}
		if (paths.atlasDir !== undefined) {
			return join(paths.atlasDir, textureFileName(atlas.texture));
		}
		return undefined;
	});
}

/** Output targets in a fixed order: definition, atlases, table. */
function outputTargets(
	paths: FontPaths,
	atlasPaths: readonly (string | undefined)[],
	force: boolean,
): readonly OutputTarget[] {
	const targets: OutputTarget[] = [];
	if (paths.output !== undefined) {
		targets.push({
			path: paths.output,
			extension: ".json",
			allowOverwrite: force,
		});
	}
	for (const atlasPath of atlasPaths) {
		if (atlasPath !== undefined) {
			targets.push({
				path: atlasPath,
				extension: ".png",
				allowOverwrite: force,
			});
		}
	}
	if (paths.table !== undefined) {
		targets.push({
			path: paths.table,
			extension: ".json",
			allowOverwrite: force,
		});
	}
	return targets;
}

function atlasReport(
	atlas: FontAtlasPlan,
	path: string | undefined,
	embed: boolean,
): FontAtlasReport {
	const fields = {
		texture: atlas.texture,
		height: atlas.height,
		ascent: atlas.ascent,
		columns: atlas.columns,
		rows: atlas.rows,
		icons: atlas.cells.length,
		atlasWidth: atlas.atlasWidth,
		atlasHeight: atlas.atlasHeight,
	};
	if (path !== undefined) {
		return { ...fields, atlas: path };
	}
	if (!embed) {
		throw new McAssetError(
			"INTERNAL_ERROR",
			`No output path for the atlas "${atlas.texture}".`,
		);
	}
	return {
		...fields,
		pngBase64: Buffer.from(atlas.atlas.png).toString("base64"),
	};
}

function reportOf(
	paths: FontPaths,
	atlasPaths: readonly (string | undefined)[],
	spec: FontSpec,
	plan: FontPlan,
	warnings: readonly FontWarning[],
	embed: boolean,
): FontReport {
	return {
		command: "font",
		font: plan.font,
		icons: plan.glyphs.length,
		atlases: plan.atlases.map((atlas, index) =>
			atlasReport(atlas, atlasPaths[index], embed),
		),
		...(spec.space === undefined
			? {}
			: {
					space: {
						character: String.fromCodePoint(spec.space.codePoint),
						codePoint: spec.space.codePoint,
						advance: spec.space.advance,
					},
				}),
		...(spec.reference === undefined ? {} : { reference: spec.reference }),
		warnings,
		...(paths.output !== undefined
			? { output: paths.output }
			: embed
				? { definitionText: plan.definitionText }
				: {}),
		...(paths.table !== undefined
			? { table: paths.table }
			: embed
				? { tableText: plan.tableText }
				: {}),
	};
}

export async function runFontRequest(
	request: FontRequest,
): Promise<FontOutcome> {
	const specPath = definedPath(request.specPath);
	const paths = fontPaths(request);
	if ((specPath === undefined) === (request.spec === undefined)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"font needs exactly one of a spec path and an inline spec.",
		);
	}
	if (request.requireArtifactPaths) {
		checkArtifactPaths(paths);
	}
	if (paths.atlas !== undefined && paths.atlasDir !== undefined) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			"font takes one atlas sink: pass the atlas path (--atlas / atlasPath) or the atlas directory (--output-dir / atlasDirPath), not both.",
		);
	}
	const rawSpec =
		specPath === undefined
			? request.spec
			: parseFontSpecText(await readInputText(specPath, "font spec"), specPath);
	const spec = parseFontSpec(rawSpec, {
		baseDir:
			specPath === undefined ? process.cwd() : dirname(resolve(specPath)),
		source: specPath ?? "<inline spec>",
	});
	const warnings: FontWarning[] = [];
	const sources: FontGlyphSource[] = [];
	for (const icon of spec.icons) {
		const loaded = await loadEditableCanvas(icon.path);
		for (const warning of loaded.warnings) {
			warnings.push({
				icon: icon.name,
				code: warning.code,
				message: warning.message,
			});
		}
		sources.push({ name: icon.name, canvas: loaded.canvas });
	}
	const plan = planFont(spec, sources);
	if (paths.atlas !== undefined && plan.atlases.length > 1) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			`The spec produces ${plan.atlases.length} bitmap atlases, one per height/ascent group, so a single atlas path cannot hold them all. Pass the atlas directory instead (--output-dir on the CLI, atlasDirPath on the tool).`,
			{ atlases: plan.atlases.map((atlas) => atlas.texture) },
		);
	}
	const atlasPaths = atlasOutputPaths(paths, plan);
	const planned = await planOutputTargets(
		outputTargets(paths, atlasPaths, request.force === true),
		{
			inputs: [
				...(specPath === undefined ? [] : [specPath]),
				...spec.icons.map((icon) => icon.path),
			],
			mkdir: request.mkdir === true,
		},
	);
	const payloads = new Map<string, string | Uint8Array>();
	if (paths.output !== undefined) {
		payloads.set(paths.output, plan.definitionText);
	}
	for (const [index, atlas] of plan.atlases.entries()) {
		const path = atlasPaths[index];
		if (path !== undefined) {
			payloads.set(path, atlas.atlas.png);
		}
	}
	if (paths.table !== undefined) {
		payloads.set(paths.table, plan.tableText);
	}
	await writePlannedTargets(planned, payloads, {
		mkdir: request.mkdir === true,
	});
	return {
		result: reportOf(
			paths,
			atlasPaths,
			spec,
			plan,
			warnings,
			!request.requireArtifactPaths,
		),
	};
}

function reportLine(report: FontReport): string {
	const parts = [
		`ok font ${report.font} icons=${report.icons} groups=${report.atlases.length}`,
	];
	for (const atlas of report.atlases) {
		const where = atlas.atlas === undefined ? "" : `@${atlas.atlas}`;
		parts.push(`atlas=${atlas.atlasWidth}x${atlas.atlasHeight}${where}`);
	}
	if (report.output !== undefined) {
		parts.push(`output=${report.output}`);
	}
	if (report.table !== undefined) {
		parts.push(`table=${report.table}`);
	}
	return parts.join(" ");
}

/**
 * CLI wiring: every artifact path is required, and the run never embeds
 * artifacts in the envelope.
 */
export async function runFont(
	specPath: string | undefined,
	options: FontCliOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({ json: globalJson, stdoutArtifact: false });
	try {
		const outcome = await runFontRequest({
			...(definedPath(specPath) === undefined ? {} : { specPath }),
			...(definedPath(options.output) === undefined
				? {}
				: { outputPath: options.output }),
			...(definedPath(options.atlas) === undefined
				? {}
				: { atlasPath: options.atlas }),
			...(definedPath(options.outputDir) === undefined
				? {}
				: { atlasDirPath: options.outputDir }),
			...(definedPath(options.table) === undefined
				? {}
				: { tablePath: options.table }),
			...(options.force === undefined ? {} : { force: options.force }),
			...(options.mkdir === undefined ? {} : { mkdir: options.mkdir }),
			requireArtifactPaths: true,
		});
		if (globalJson) {
			emitEnvelope(successEnvelope(outcome.result), streams, route);
		} else {
			emitLog(reportLine(outcome.result), streams, route);
			for (const warning of outcome.result.warnings) {
				emitLog(
					`warning [${warning.code}] ${warning.icon}: ${warning.message}`,
					streams,
					route,
				);
			}
		}
		return 0;
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}
