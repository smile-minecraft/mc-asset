import { dirname, resolve as resolvePath } from "node:path";
import { McAssetError } from "../core/errors.ts";
import { auditTextureFamily } from "../style/audit.ts";
import { buildPaletteMcpx } from "../style/export-palette.ts";
import { lintStyle } from "../style/lint.ts";
import {
	buildStyleFileText,
	isStyleSource,
	resolveStyle,
} from "../style/load.ts";
import { listStylePresets } from "../style/presets.ts";
import {
	type ResolvedStyle,
	STYLE_FILE_SUFFIX,
	type StyleCreateInput,
	type StyleSummary,
} from "../style/types.ts";
import { emitCommandFailure } from "./artifacts.ts";
import { loadRasterCanvas } from "./canvas-input.ts";
import {
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { successEnvelope } from "./envelope.ts";
import {
	planOutputTargetsKeepingExtension,
	writePlannedTargets,
} from "./safe-output.ts";

/**
 * `style` subcommands: list and show report styles, export-palette writes a
 * family palette as `.mcpx`, and create writes a `.style.json` document.
 * The two writing modes preflight their target before the first byte: the
 * palette refuses an output that aliases the style it read, and create
 * refuses one that aliases the style it extends.
 */

export interface StyleOptions {
	category?: string | undefined;
	family?: string | undefined;
	style?: string | undefined;
	output?: string | undefined;
	id?: string | undefined;
	name?: string | undefined;
	extends?: string | undefined;
	overrides?: Record<string, unknown> | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
	inputs?: readonly string[] | undefined;
	baseline?: string | undefined;
}

export interface StylePaletteWriteRequest {
	readonly style: string;
	readonly family: string;
	readonly outputPath: string;
	readonly force: boolean;
	readonly mkdir: boolean;
	readonly baseDir?: string | undefined;
}

export interface StyleCreateWriteRequest extends StyleCreateInput {
	readonly outputPath: string;
	readonly force: boolean;
	readonly mkdir: boolean;
}

export interface StylePaletteWriteResult {
	readonly style: string;
	readonly family: string;
	readonly output: string;
}

export interface StyleCreateWriteResult {
	readonly id: string;
	readonly output: string;
}

/** Absolute form of a style source, or the empty string for a preset id. */
function styleInputPath(source: string): string {
	return isStyleSource(source) ? resolvePath(source) : "";
}

/** Export targets must carry the `.mcpx` suffix the consumers read. */
export function assertPaletteOutputPath(path: string): void {
	if (!path.toLowerCase().endsWith(".mcpx")) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Palette output must end in .mcpx: ${path}.`,
			{ path },
		);
	}
}

/** Style files are recognized by their suffix, so create requires it too. */
export function assertStyleOutputPath(path: string): void {
	if (!path.toLowerCase().endsWith(STYLE_FILE_SUFFIX)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Style file must end in ${STYLE_FILE_SUFFIX}: ${path}.`,
			{ path },
		);
	}
}

async function writePlannedText(
	path: string,
	text: string,
	inputs: readonly string[],
	force: boolean,
	mkdir: boolean,
): Promise<void> {
	const plan = await planOutputTargetsKeepingExtension(
		[{ path, allowOverwrite: force }],
		{ inputs: inputs.filter((input) => input !== ""), mkdir },
	);
	await writePlannedTargets(plan, new Map([[path, text]]), { mkdir });
}

/**
 * Resolve the style, build the palette text, then write it through the
 * shared output guard. The style source is an input, so it can never be the
 * target.
 */
export async function writeStylePalette(
	request: StylePaletteWriteRequest,
): Promise<StylePaletteWriteResult> {
	assertPaletteOutputPath(request.outputPath);
	if (request.style === "") {
		throw new McAssetError("INVALID_ARGUMENT", "export-palette needs a style.");
	}
	if (request.family === "") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"export-palette needs a family.",
		);
	}
	const style = await resolveStyle(request.style, {
		baseDir: request.baseDir,
	});
	const text = buildPaletteMcpx(style, request.family);
	await writePlannedText(
		request.outputPath,
		text,
		[styleInputPath(request.style)],
		request.force,
		request.mkdir,
	);
	return {
		style: style.id,
		family: request.family,
		output: request.outputPath,
	};
}

/**
 * Validate the requested document, then write it through the shared output
 * guard. A create target may not be the style it extends, so the base file
 * is an input of the same preflight.
 */
export async function writeStyleFile(
	request: StyleCreateWriteRequest,
): Promise<StyleCreateWriteResult> {
	assertStyleOutputPath(request.outputPath);
	if (request.id === "") {
		throw new McAssetError("INVALID_ARGUMENT", "create needs an id.");
	}
	const baseDir = dirname(resolvePath(request.outputPath));
	const text = await buildStyleFileText(
		{
			id: request.id,
			name: request.name,
			extends: request.extends,
			overrides: request.overrides,
		},
		{ baseDir },
	);
	await writePlannedText(
		request.outputPath,
		text,
		[styleInputPath(request.extends ?? "")],
		request.force,
		request.mkdir,
	);
	return { id: request.id, output: request.outputPath };
}

function familyLine(family: string, ramp: Record<string, string>): string {
	return `family ${family} outline=${ramp.outline ?? ""} shadow=${ramp.shadow ?? ""} dark=${ramp.dark ?? ""} base=${ramp.base ?? ""} light=${ramp.light ?? ""} highlight=${ramp.highlight ?? ""}`;
}

/**
 * CLI entry for the `style` group. `list` and `show` report without
 * writing; `export-palette` and `create` require an explicit `--output` and
 * return its path.
 */
export async function runStyle(
	mode: string,
	source: string | undefined,
	options: StyleOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({ json: globalJson, stdoutArtifact: false });
	try {
		if (mode === "list") {
			if (source !== undefined && source !== "") {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					"style list takes no style argument.",
					{ style: source },
				);
			}
			const presets: StyleSummary[] = listStylePresets();
			const result = { command: "style", mode: "list", presets };
			if (globalJson) {
				emitEnvelope(successEnvelope(result), streams, route);
			} else {
				emitLog(`ok style list count=${presets.length}`, streams, route);
				for (const preset of presets) {
					emitLog(`style ${preset.id} ${preset.name}`, streams, route);
				}
			}
			return 0;
		}
		if (mode === "show") {
			if (source === undefined || source === "") {
				throw new McAssetError("INVALID_ARGUMENT", "style show needs a style.");
			}
			const style: ResolvedStyle = await resolveStyle(source);
			const families = Object.keys(style.palettes);
			const result = { command: "style", mode: "show", style };
			if (globalJson) {
				emitEnvelope(successEnvelope(result), streams, route);
			} else {
				emitLog(
					`ok style show id=${style.id} families=${families.length}`,
					streams,
					route,
				);
				for (const family of families) {
					emitLog(
						familyLine(family, style.palettes[family] ?? {}),
						streams,
						route,
					);
				}
			}
			return 0;
		}
		if (mode === "export-palette") {
			if (options.output === undefined || options.output === "") {
				throw new McAssetError(
					"OUTPUT_REQUIRED",
					"style export-palette needs --output <file.mcpx>.",
				);
			}
			const written = await writeStylePalette({
				style: source ?? "",
				family: options.family ?? "",
				outputPath: options.output,
				force: options.force === true,
				mkdir: options.mkdir === true,
			});
			const result = { command: "style", mode: "export-palette", ...written };
			if (globalJson) {
				emitEnvelope(successEnvelope(result), streams, route);
			} else {
				emitLog(
					`ok style export-palette style=${written.style} family=${written.family}`,
					streams,
					route,
				);
				emitLog(`output=${written.output}`, streams, route);
			}
			return 0;
		}
		if (mode === "create") {
			if (options.output === undefined || options.output === "") {
				throw new McAssetError(
					"OUTPUT_REQUIRED",
					"style create needs --output <file.style.json>.",
				);
			}
			const written = await writeStyleFile({
				id: options.id ?? "",
				name: options.name,
				extends: options.extends,
				outputPath: options.output,
				force: options.force === true,
				mkdir: options.mkdir === true,
			});
			const result = { command: "style", mode: "create", ...written };
			if (globalJson) {
				emitEnvelope(successEnvelope(result), streams, route);
			} else {
				emitLog(`ok style create id=${written.id}`, streams, route);
				emitLog(`output=${written.output}`, streams, route);
			}
			return 0;
		}
		if (mode === "lint") {
			if (source === undefined || source === "") {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					"style lint needs an image path.",
				);
			}
			const loaded = await loadRasterCanvas(source);
			const style = await resolveStyle(options.style ?? "vanilla");
			const report = lintStyle({
				canvas: loaded.canvas,
				path: source,
				style,
				category: options.category ?? null,
			});
			const result = { command: "style", ...report };
			if (globalJson) {
				emitEnvelope(successEnvelope(result), streams, route);
			} else {
				emitLog(
					`ok style lint path=${report.path} style=${report.style} category=${report.category ?? "-"} findings=${report.findings.length} verdict=${report.verdict}`,
					streams,
					route,
				);
				for (const finding of report.findings) {
					emitLog(
						`${finding.level} ${finding.code} measured=${finding.measured} threshold=${finding.threshold} ${finding.message}`,
						streams,
						route,
					);
				}
			}
			// An error-level finding is an asset validation failure, the same
			// outcome `validate` reports, so it shares that exit code.
			return report.verdict === "fail" ? 3 : 0;
		}
		if (mode === "audit") {
			const inputPaths = options.inputs ?? [];
			if (inputPaths.length < 2) {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					"style audit requires at least two input image paths.",
				);
			}
			const loadedCanvases = [];
			for (const p of inputPaths) {
				const loaded = await loadRasterCanvas(p);
				loadedCanvases.push(loaded.canvas);
			}
			const report = auditTextureFamily({
				inputs: loadedCanvases,
				names: inputPaths,
				baselinePath: options.baseline,
			});
			const result = { command: "style", mode: "audit", ...report };
			if (globalJson) {
				emitEnvelope(successEnvelope(result), streams, route);
			} else {
				emitLog(
					`ok style audit baseline=${report.baseline} pairs=${report.pairs.length} minOverlap=${report.minOverlapPermille} minPaletteOverlap=${report.minPaletteOverlapPermille}`,
					streams,
					route,
				);
			}
			return report.findings.length > 0 ? 3 : 0;
		}
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"style takes list, show, export-palette, create, lint, or audit.",
			{ mode },
		);
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}
