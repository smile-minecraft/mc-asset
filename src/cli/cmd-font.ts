import { Buffer } from "node:buffer";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { McAssetError } from "../core/errors.ts";
import {
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
 */

export interface FontCliOptions {
	output?: string | undefined;
	atlas?: string | undefined;
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

/** The run report shared by the CLI envelope and the MCP result. */
export interface FontReport {
	readonly command: "font";
	readonly font: string;
	readonly texture: string;
	readonly height: number;
	readonly ascent: number;
	readonly columns: number;
	readonly rows: number;
	readonly icons: number;
	readonly atlasWidth: number;
	readonly atlasHeight: number;
	readonly space?:
		| {
				readonly character: string;
				readonly codePoint: number;
				readonly advance: number;
		  }
		| undefined;
	readonly reference?: string | undefined;
	readonly warnings: readonly FontWarning[];
	/** Written paths; absent entries were embedded instead. */
	readonly output?: string | undefined;
	readonly atlas?: string | undefined;
	readonly table?: string | undefined;
	/** MCP without an output path: the artifact itself. */
	readonly definitionText?: string | undefined;
	readonly tableText?: string | undefined;
	readonly pngBase64?: string | undefined;
}

export interface FontRequest {
	/** Spec document path; exactly one of specPath and spec is set. */
	readonly specPath?: string | undefined;
	/** Inline spec document; exactly one of specPath and spec is set. */
	readonly spec?: unknown;
	readonly outputPath?: string | undefined;
	readonly atlasPath?: string | undefined;
	readonly tablePath?: string | undefined;
	readonly force?: boolean | undefined;
	readonly mkdir?: boolean | undefined;
	/** CLI true: the definition output path is mandatory. */
	readonly requireOutput: boolean;
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

/** The three optional outputs, normalized once. */
interface FontPaths {
	readonly output?: string | undefined;
	readonly atlas?: string | undefined;
	readonly table?: string | undefined;
}

function fontPaths(request: FontRequest): FontPaths {
	return {
		output: definedPath(request.outputPath),
		atlas: definedPath(request.atlasPath),
		table: definedPath(request.tablePath),
	};
}

/** Output targets in a fixed order: definition, atlas, table. */
function outputTargets(
	paths: FontPaths,
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
	if (paths.atlas !== undefined) {
		targets.push({
			path: paths.atlas,
			extension: ".png",
			allowOverwrite: force,
		});
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

function reportOf(
	paths: FontPaths,
	spec: FontSpec,
	plan: FontPlan,
	warnings: readonly FontWarning[],
	embed: boolean,
): FontReport {
	return {
		command: "font",
		font: plan.font,
		texture: plan.texture,
		height: plan.height,
		ascent: plan.ascent,
		columns: plan.columns,
		rows: plan.rows,
		icons: plan.glyphs.length,
		atlasWidth: plan.atlas.width,
		atlasHeight: plan.atlas.height,
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
		...(paths.atlas !== undefined
			? { atlas: paths.atlas }
			: embed
				? { pngBase64: Buffer.from(plan.atlas.png).toString("base64") }
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
	if (request.requireOutput && paths.output === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"font needs --output (the font definition path).",
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
	const planned = await planOutputTargets(
		outputTargets(paths, request.force === true),
		{
			inputs: spec.icons.map((icon) => icon.path),
			mkdir: request.mkdir === true,
		},
	);
	const payloads = new Map<string, string | Uint8Array>();
	if (paths.output !== undefined) {
		payloads.set(paths.output, plan.definitionText);
	}
	if (paths.atlas !== undefined) {
		payloads.set(paths.atlas, plan.atlas.png);
	}
	if (paths.table !== undefined) {
		payloads.set(paths.table, plan.tableText);
	}
	await writePlannedTargets(planned, payloads, {
		mkdir: request.mkdir === true,
	});
	return {
		result: reportOf(paths, spec, plan, warnings, !request.requireOutput),
	};
}

function reportLine(report: FontReport): string {
	const parts = [
		`ok font ${report.font} icons=${report.icons} atlas=${report.atlasWidth}x${report.atlasHeight}`,
	];
	if (report.output !== undefined) {
		parts.push(`output=${report.output}`);
	}
	if (report.atlas !== undefined) {
		parts.push(`atlasPath=${report.atlas}`);
	}
	if (report.table !== undefined) {
		parts.push(`table=${report.table}`);
	}
	return parts.join(" ");
}

/**
 * CLI wiring: the definition path is required, the atlas and table paths
 * are optional, and the run never embeds artifacts in the envelope.
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
			...(definedPath(options.table) === undefined
				? {}
				: { tablePath: options.table }),
			...(options.force === undefined ? {} : { force: options.force }),
			...(options.mkdir === undefined ? {} : { mkdir: options.mkdir }),
			requireOutput: true,
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
