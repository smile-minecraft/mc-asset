import { readFile, stat } from "node:fs/promises";
import { McAssetError } from "../core/errors.ts";
import {
	type EntityInspectReport,
	type EntityLayoutSummary,
	inspectEntityLayout,
} from "../entity/inspect.ts";
import { resolveEntityLayoutDocument } from "../entity/layout.ts";
import {
	canonicalEntityLayoutId,
	getEntityLayoutDocument,
} from "../entity/layouts.ts";
import {
	buildEntityTemplate,
	type EntityTemplateRegion,
} from "../entity/template.ts";
import type { EntityLayout } from "../entity/types.ts";
import {
	type EntityValidateReport,
	validateEntityTexture,
} from "../entity/validate.ts";
import { decodeImage } from "../io/decode.ts";
import { encodePng } from "../io/png.ts";
import { serializeMcpx } from "../mcpx/index.ts";
import {
	emitArtifact,
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { errorEnvelope, successEnvelope } from "./envelope.ts";
import { exitCodeForMcAssetError } from "./exit.ts";
import {
	type ExtensionlessOutputTarget,
	planOutputTargetsKeepingExtension,
	writePlannedTargets,
} from "./safe-output.ts";

export type EntityMode = "template" | "inspect" | "validate";

export interface EntityCliOptions {
	layout?: string | undefined;
	output?: string | undefined;
	source?: string | undefined;
	stdout?: boolean | undefined;
	fill?: boolean | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
}

/** A builtin id/alias, a layout .json path, or an inline MCP document. */
export type EntityLayoutRef =
	| { readonly kind: "name"; readonly value: string }
	| { readonly kind: "inline"; readonly value: unknown };

export interface EntityRequest {
	readonly mode: EntityMode;
	readonly layout: EntityLayoutRef;
	readonly inputPath?: string | undefined;
	readonly fill?: boolean | undefined;
	readonly outputPngPath?: string | undefined;
	readonly outputMcpxPath?: string | undefined;
	readonly stdout?: boolean | undefined;
	readonly force?: boolean | undefined;
	readonly mkdir?: boolean | undefined;
	/** CLI true: at least one output is required. MCP false: artifacts embed. */
	readonly requireOutput: boolean;
}

export interface EntityTemplateReport {
	readonly command: "entity";
	readonly mode: "template";
	readonly layout: EntityLayoutSummary;
	readonly fill: boolean;
	readonly regions: readonly EntityTemplateRegion[];
	readonly output?: string | undefined;
	readonly source?: string | undefined;
}

export type EntityResult =
	| EntityInspectReport
	| EntityTemplateReport
	| EntityValidateReport;

export interface EntityOutcome {
	readonly result: EntityResult;
	/** validate with verdict "fail": the CLI exits 3, MCP returns the report. */
	readonly failed: boolean;
	/** PNG bytes for --stdout or an MCP embed. */
	readonly png?: Uint8Array | undefined;
	/** mcpx text for an MCP embed. */
	readonly mcpxText?: string | undefined;
}

const MAX_LAYOUT_BYTES = 1024 * 1024;
const MAX_TEXTURE_BYTES = 64 * 1024 * 1024;

type RequestField = Exclude<
	keyof EntityRequest,
	"mode" | "layout" | "requireOutput"
>;

/** Request fields each mode refuses; any of them present is INVALID_ARGUMENT. */
const REFUSED_FIELDS: Readonly<Record<EntityMode, readonly RequestField[]>> = {
	inspect: [
		"inputPath",
		"fill",
		"outputPngPath",
		"outputMcpxPath",
		"stdout",
		"force",
		"mkdir",
	],
	template: ["inputPath"],
	validate: [
		"fill",
		"outputPngPath",
		"outputMcpxPath",
		"stdout",
		"force",
		"mkdir",
	],
};

function isGiven(value: unknown): boolean {
	if (value === undefined || value === false || value === "") return false;
	return true;
}

function checkRefused(request: EntityRequest): void {
	for (const field of REFUSED_FIELDS[request.mode]) {
		if (isGiven(request[field])) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				`${field} is not accepted by ${request.mode}.`,
				{ field, mode: request.mode },
			);
		}
	}
}

async function statOrUndefined(path: string) {
	try {
		return await stat(path);
	} catch {
		return undefined;
	}
}

interface LoadedLayout {
	readonly layout: EntityLayout;
	/** The layout file path, which outputs must never alias. */
	readonly sourcePath?: string | undefined;
}

async function loadEntityLayout(ref: EntityLayoutRef): Promise<LoadedLayout> {
	if (ref.kind === "inline") {
		return { layout: resolveEntityLayoutDocument(ref.value) };
	}
	const builtin = canonicalEntityLayoutId(ref.value);
	if (builtin !== undefined) {
		return {
			layout: resolveEntityLayoutDocument(getEntityLayoutDocument(builtin)),
		};
	}
	const path = ref.value;
	const info = await statOrUndefined(path);
	if (info === undefined) {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Cannot read entity layout: ${path}. Use a builtin id (player_wide, steve, player_slim, alex) or a layout .json file.`,
			{ path },
		);
	}
	if (!info.isFile()) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Entity layout path is not a file: ${path}.`,
			{ path },
		);
	}
	if (info.size > MAX_LAYOUT_BYTES) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			`Entity layout exceeds ${MAX_LAYOUT_BYTES} bytes: ${path}.`,
			{ path, limit: MAX_LAYOUT_BYTES, actual: info.size },
		);
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(
			new Uint8Array(await readFile(path)),
		);
	} catch {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Cannot read entity layout: ${path}.`,
			{ path },
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(text) as unknown;
	} catch {
		throw new McAssetError(
			"ENTITY_LAYOUT_INVALID",
			`Entity layout is not valid JSON: ${path}.`,
			{ reason: "invalid-json", path },
		);
	}
	return { layout: resolveEntityLayoutDocument(value), sourcePath: path };
}

interface LoadedTexture {
	readonly width: number;
	readonly height: number;
	readonly pixels: Uint8Array;
}

async function loadTexture(path: string): Promise<LoadedTexture> {
	const info = await statOrUndefined(path);
	if (info === undefined) {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Cannot read texture: ${path}.`,
			{
				path,
			},
		);
	}
	if (!info.isFile()) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Texture path is not a file: ${path}.`,
			{ path },
		);
	}
	if (info.size > MAX_TEXTURE_BYTES) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			`Texture exceeds ${MAX_TEXTURE_BYTES} bytes: ${path}.`,
			{ path, limit: MAX_TEXTURE_BYTES, actual: info.size },
		);
	}
	const decoded = await decodeImage(new Uint8Array(await readFile(path)));
	return {
		width: decoded.width,
		height: decoded.height,
		pixels: decoded.pixels,
	};
}

function assertPngPath(path: string): void {
	if (!path.toLowerCase().endsWith(".png")) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`PNG output path must end with .png: ${path}.`,
			{ path },
		);
	}
}

function assertMcpxPath(path: string): void {
	if (!path.toLowerCase().endsWith(".mcpx")) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Source output path must end with .mcpx: ${path}.`,
			{ path },
		);
	}
}

function templateTargets(request: EntityRequest): ExtensionlessOutputTarget[] {
	const targets: ExtensionlessOutputTarget[] = [];
	if (request.outputPngPath !== undefined) {
		assertPngPath(request.outputPngPath);
		targets.push({
			path: request.outputPngPath,
			allowOverwrite: request.force === true,
		});
	}
	if (request.outputMcpxPath !== undefined) {
		assertMcpxPath(request.outputMcpxPath);
		targets.push({
			path: request.outputMcpxPath,
			allowOverwrite: request.force === true,
		});
	}
	return targets;
}

async function runTemplate(
	request: EntityRequest,
	layout: EntityLayout,
	sourcePath: string | undefined,
): Promise<EntityOutcome> {
	const stdout = request.stdout === true;
	if (request.outputPngPath !== undefined && stdout) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			"Use only one of the PNG output path or stdout.",
		);
	}
	if (
		request.requireOutput &&
		request.outputPngPath === undefined &&
		request.outputMcpxPath === undefined &&
		!stdout
	) {
		throw new McAssetError(
			"OUTPUT_REQUIRED",
			"template needs a PNG output, an .mcpx source output, or stdout.",
		);
	}
	const targets = templateTargets(request);
	// Path phase: every target is checked before any canvas is built.
	const planned = await planOutputTargetsKeepingExtension(targets, {
		inputs: sourcePath === undefined ? [] : [sourcePath],
		mkdir: request.mkdir === true,
		// Keep the extension whitelist out of the shared guard: .mcpx is not
		// part of its frozen target set, and both extensions are checked above.
	});
	const fill = request.fill !== false;
	const template = buildEntityTemplate(layout, { fill });
	const png = encodePng(template.canvas);
	const mcpxText = serializeMcpx(template.canvas);
	const payloads = new Map<string, Uint8Array | string>();
	if (request.outputPngPath !== undefined) {
		payloads.set(request.outputPngPath, png);
	}
	if (request.outputMcpxPath !== undefined) {
		payloads.set(request.outputMcpxPath, mcpxText);
	}
	const written = new Set(
		planned.length === 0
			? []
			: await writePlannedTargets(planned, payloads, {
					mkdir: request.mkdir === true,
				}),
	);
	const output =
		request.outputPngPath !== undefined && written.has(request.outputPngPath)
			? request.outputPngPath
			: undefined;
	const source =
		request.outputMcpxPath !== undefined && written.has(request.outputMcpxPath)
			? request.outputMcpxPath
			: undefined;
	const embed = !request.requireOutput;
	return {
		result: {
			command: "entity",
			mode: "template",
			layout: {
				id: layout.id,
				texture: { ...layout.texture },
				partCount: layout.parts.length,
				faceCount: layout.faces.length,
				mappedPixels: layout.mappedPixels,
				totalPixels: layout.totalPixels,
				unmappedPixels: layout.unmappedPixels,
			},
			fill,
			regions: template.regions,
			...(output === undefined ? {} : { output }),
			...(source === undefined ? {} : { source }),
		},
		failed: false,
		png:
			stdout || (embed && request.outputPngPath === undefined)
				? png
				: undefined,
		mcpxText:
			embed && request.outputMcpxPath === undefined ? mcpxText : undefined,
	};
}

async function runValidate(
	request: EntityRequest,
	layout: EntityLayout,
): Promise<EntityOutcome> {
	if (request.inputPath === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"validate needs a texture path.",
			{ field: "inputPath" },
		);
	}
	const texture = await loadTexture(request.inputPath);
	const report = validateEntityTexture(layout, texture);
	return { result: report, failed: report.verdict === "fail" };
}

/** Shared request core behind the CLI command and the MCP tool. */
export async function runEntityRequest(
	request: EntityRequest,
): Promise<EntityOutcome> {
	checkRefused(request);
	const loaded = await loadEntityLayout(request.layout);
	if (request.mode === "inspect") {
		return { result: inspectEntityLayout(loaded.layout), failed: false };
	}
	if (request.mode === "template") {
		return runTemplate(request, loaded.layout, loaded.sourcePath);
	}
	return runValidate(request, loaded.layout);
}

function stripCodePrefix(message: string): string {
	return message.replace(/^\[[A-Z0-9_]+\] /, "");
}

function toErrorEnvelope(error: unknown): {
	code: "INTERNAL_ERROR" | McAssetError["code"];
	message: string;
	details: unknown;
} {
	if (error instanceof McAssetError) {
		return {
			code: error.code,
			message: stripCodePrefix(error.message),
			details: error.details,
		};
	}
	if (error instanceof Error) {
		return {
			code: "INTERNAL_ERROR",
			message: error.message,
			details: undefined,
		};
	}
	return { code: "INTERNAL_ERROR", message: String(error), details: undefined };
}

function formatValidateReport(report: EntityValidateReport): string {
	const lines = [
		`verdict: ${report.verdict}`,
		`layout: ${report.layout.id}`,
		`texture: ${report.texture.width}x${report.texture.height}`,
		`mapped: ${report.coverage.mappedPixels}/${report.coverage.totalPixels}`,
	];
	for (const finding of report.findings) {
		lines.push(`${finding.level} [${finding.code}] ${finding.message}`);
	}
	return lines.join("\n");
}

function humanLine(result: EntityResult): string {
	if (result.mode === "inspect") {
		return `ok entity inspect layout=${result.layout.id} parts=${result.layout.partCount} faces=${result.layout.faceCount} mapped=${result.layout.mappedPixels}/${result.layout.totalPixels}`;
	}
	if (result.mode === "template") {
		const output =
			result.output === undefined ? "" : ` output=${result.output}`;
		const source =
			result.source === undefined ? "" : ` source=${result.source}`;
		return `ok entity template layout=${result.layout.id} regions=${result.regions.length}${output}${source}`;
	}
	const warnings = result.findings.filter(
		(finding) => finding.level === "warning",
	).length;
	return `ok entity validate layout=${result.layout.id} verdict=${result.verdict} warnings=${warnings}`;
}

/**
 * CLI entry: load the layout, run the shared request core, and emit the
 * artifact, envelope, and exit code. A failed texture verdict exits 3 with
 * the report attached to the error envelope.
 */
export async function runEntity(
	mode: EntityMode,
	input: string | undefined,
	options: EntityCliOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({
		json: globalJson,
		stdoutArtifact: options.stdout === true,
	});
	try {
		const outcome = await runEntityRequest({
			mode,
			layout: { kind: "name", value: options.layout ?? "player_wide" },
			inputPath: mode === "validate" ? input : undefined,
			fill: options.fill,
			outputPngPath: options.output,
			outputMcpxPath: options.source,
			stdout: options.stdout,
			force: options.force,
			mkdir: options.mkdir,
			requireOutput: true,
		});
		if (outcome.png !== undefined) {
			emitArtifact(outcome.png, streams, route);
		}
		if (outcome.failed) {
			const result = outcome.result;
			if (globalJson) {
				emitEnvelope(
					errorEnvelope(
						"VALIDATION_FAILED",
						`entity texture failed validation for layout "${result.layout.id}".`,
						undefined,
						result,
					),
					streams,
					route,
				);
			} else if (result.mode === "validate") {
				emitLog(formatValidateReport(result), streams, route);
			} else {
				emitLog("verdict: fail", streams, route);
			}
			return 3;
		}
		if (globalJson) {
			emitEnvelope(successEnvelope(outcome.result), streams, route);
		} else if (outcome.result.mode === "validate") {
			emitLog(formatValidateReport(outcome.result), streams, route);
		} else {
			emitLog(humanLine(outcome.result), streams, route);
		}
		return 0;
	} catch (error) {
		const shaped = toErrorEnvelope(error);
		if (globalJson) {
			emitEnvelope(
				errorEnvelope(shaped.code, shaped.message, shaped.details),
				streams,
				route,
			);
		} else {
			emitLog(`error [${shaped.code}] ${shaped.message}`, streams, route);
		}
		if (error instanceof McAssetError) {
			return exitCodeForMcAssetError(error);
		}
		return 1;
	}
}
