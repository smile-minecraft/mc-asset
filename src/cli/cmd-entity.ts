import { readFile, stat } from "node:fs/promises";
import { McAssetError } from "../core/errors.ts";
import {
	type EntityFaceReport,
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
	type EntityPreviewReport,
	type EntityPreviewSize,
	renderEntityPreview,
} from "../entity/preview.ts";
import {
	buildEntityTemplate,
	type EntityTemplateRegion,
} from "../entity/template.ts";
import type { EntityLayer, EntityLayout } from "../entity/types.ts";
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
	type OutputTarget,
	planOutputTargets,
	writePlannedTargets,
} from "./safe-output.ts";

export type EntityMode = "template" | "inspect" | "validate" | "preview";

export interface EntityCliOptions {
	layout?: string | undefined;
	output?: string | undefined;
	source?: string | undefined;
	stdout?: boolean | undefined;
	fill?: boolean | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
	/** preview panel edge size; absent means 128. */
	size?: string | undefined;
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
	/** preview panel edge size (64, 128, or 256); absent means 128. */
	readonly size?: number | undefined;
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
	| EntityValidateReport
	| EntityPreviewReport;

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
		"size",
	],
	template: ["inputPath", "size"],
	validate: [
		"fill",
		"outputPngPath",
		"outputMcpxPath",
		"stdout",
		"force",
		"mkdir",
		"size",
	],
	preview: ["fill", "outputMcpxPath"],
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

function templateTargets(request: EntityRequest): OutputTarget[] {
	const targets: OutputTarget[] = [];
	if (request.outputPngPath !== undefined) {
		targets.push({
			path: request.outputPngPath,
			extension: ".png",
			allowOverwrite: request.force === true,
		});
	}
	if (request.outputMcpxPath !== undefined) {
		targets.push({
			path: request.outputMcpxPath,
			extension: ".mcpx",
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
	const planned = await planOutputTargets(targets, {
		inputs: sourcePath === undefined ? [] : [sourcePath],
		mkdir: request.mkdir === true,
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

/**
 * preview: load the texture, refuse a size mismatch before any pixel work,
 * then write the four-view PNG (or return it inline for MCP). The size is
 * validated by the renderer so the CLI and MCP share one message.
 */
async function runPreview(
	request: EntityRequest,
	layout: EntityLayout,
): Promise<EntityOutcome> {
	if (request.inputPath === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"preview needs a texture path.",
			{ field: "inputPath" },
		);
	}
	const stdout = request.stdout === true;
	if (request.outputPngPath !== undefined && stdout) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			"Use only one of the PNG output path or stdout.",
		);
	}
	if (request.requireOutput && request.outputPngPath === undefined && !stdout) {
		throw new McAssetError(
			"OUTPUT_REQUIRED",
			"preview needs a PNG output or stdout.",
		);
	}
	const targets: OutputTarget[] =
		request.outputPngPath === undefined
			? []
			: [
					{
						path: request.outputPngPath,
						extension: ".png",
						allowOverwrite: request.force === true,
					},
				];
	// Path phase: the output is checked before the texture is read.
	const planned = await planOutputTargets(targets, {
		inputs: [request.inputPath],
		mkdir: request.mkdir === true,
	});
	const texture = await loadTexture(request.inputPath);
	const size = (request.size ?? 128) as EntityPreviewSize;
	const rendered = renderEntityPreview(layout, texture, {
		texturePath: request.inputPath,
		size,
	});
	const payloads = new Map<string, Uint8Array>();
	if (request.outputPngPath !== undefined) {
		payloads.set(request.outputPngPath, rendered.png);
	}
	const written =
		planned.length === 0
			? []
			: await writePlannedTargets(planned, payloads, {
					mkdir: request.mkdir === true,
				});
	const output =
		request.outputPngPath !== undefined &&
		written.includes(request.outputPngPath)
			? request.outputPngPath
			: undefined;
	const embed = !request.requireOutput;
	return {
		result: {
			...rendered.report,
			...(output === undefined ? {} : { output }),
		},
		failed: false,
		png:
			stdout || (embed && request.outputPngPath === undefined)
				? rendered.png
				: undefined,
	};
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
	if (request.mode === "preview") {
		return runPreview(request, loaded.layout);
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
		const coordinates =
			finding.code === "ENTITY_UNMAPPED_PIXEL"
				? ` positions: ${finding.positions
						.map((position) => `${position.x},${position.y}`)
						.join(" ")}${
						finding.truncated
							? ` (+${finding.count - finding.positions.length} more)`
							: ""
					}`
				: "";
		lines.push(
			`${finding.level} [${finding.code}] ${finding.message}${coordinates}`,
		);
	}
	return lines.join("\n");
}

function formatFaceLine(
	partId: string,
	layer: EntityLayer,
	face: EntityFaceReport,
): string {
	const { rect } = face;
	return `${partId}.${face.face} ${rect.x},${rect.y},${rect.width},${rect.height} uv=${face.uv.join(",")} mirror=${face.mirror} layer=${layer}`;
}

function formatInspectReport(report: EntityInspectReport): string {
	const lines = [
		`layout: ${report.layout.id}`,
		`texture: ${report.layout.texture.width}x${report.layout.texture.height}`,
		`parts: ${report.layout.partCount} faces: ${report.layout.faceCount} mapped: ${report.layout.mappedPixels}/${report.layout.totalPixels} unmapped: ${report.layout.unmappedPixels}`,
	];
	for (const part of report.parts) {
		for (const face of part.faces) {
			lines.push(formatFaceLine(part.id, part.layer, face));
		}
	}
	return lines.join("\n");
}

function formatTemplateLine(result: EntityTemplateReport): string {
	const output = result.output === undefined ? "" : ` output=${result.output}`;
	const source = result.source === undefined ? "" : ` source=${result.source}`;
	return `ok entity template layout=${result.layout.id} regions=${result.regions.length}${output}${source}`;
}

function formatPreviewLine(result: EntityPreviewReport): string {
	const parts = [
		`ok entity preview layout=${result.layout.id}`,
		`texture=${result.texture.width}x${result.texture.height}`,
		`size=${result.size}`,
	];
	if (result.output !== undefined) parts.push(`output=${result.output}`);
	if (result.coverage.status !== "complete") {
		parts.push(
			`clipped=${result.coverage.skipped
				.map((entry) => entry.target)
				.join(",")}`,
		);
	}
	return parts.join(" ");
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
			inputPath: mode === "validate" || mode === "preview" ? input : undefined,
			fill: options.fill,
			outputPngPath: options.output,
			outputMcpxPath: options.source,
			stdout: options.stdout,
			force: options.force,
			mkdir: options.mkdir,
			size: options.size === undefined ? undefined : Number(options.size),
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
		} else if (outcome.result.mode === "inspect") {
			emitLog(formatInspectReport(outcome.result), streams, route);
		} else if (outcome.result.mode === "preview") {
			emitLog(formatPreviewLine(outcome.result), streams, route);
		} else {
			emitLog(formatTemplateLine(outcome.result), streams, route);
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
