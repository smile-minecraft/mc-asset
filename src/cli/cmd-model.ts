import { Buffer } from "node:buffer";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import type { z } from "zod";
import { exitCodeForError, McAssetError } from "../core/errors.ts";
import {
	modelBindingSchema,
	modelOperationSchema,
	modelSpecSchema,
} from "../mcp/schema.ts";
import { exportBbmodel, importBbmodel } from "../model/bbmodel/index.ts";
import {
	assertBindingOutputTarget,
	type BlockstateBindingSpec,
	buildBlockstate,
	buildItemDefinition,
	type ItemBindingSpec,
} from "../model/binding.ts";
import { createFsModelContext } from "../model/context.ts";
import {
	applyModelOperations,
	createModelDocument,
	type ModelEditResult,
	type ModelOperation,
} from "../model/edit.ts";
import { checkedOperationCount } from "../model/edit-support.ts";
import { exportModelDocument } from "../model/export.ts";
import {
	ISOMETRIC_DIRECTIONS,
	type IsometricDirection,
} from "../model/geometry/index.ts";
import {
	inspectModel,
	type ModelCoverage,
	type ModelInspectReport,
	type ModelValidateReport,
	validateModel,
} from "../model/inspect.ts";
import { MODEL_LIMITS } from "../model/limits.ts";
import {
	PREVIEW_DISPLAY_SLOTS,
	type PreviewDisplaySlot,
	parseTintColor,
	type RgbTint,
} from "../model/preview/display.ts";
import {
	type ModelPreviewReport,
	type ModelPreviewSize,
	type ModelPreviewView,
	renderModelPreview,
} from "../model/preview/render.ts";
import type { ModelSpec } from "../model/types.ts";
import { type ModelRules, resolveModelRules } from "../model/versions.ts";
import { normalizePackFormat } from "../profiles/versions.ts";
import { readStdinBytes } from "./artifacts.ts";
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
	type PlannedTarget,
	planOutputTargets,
	planOutputTargetsKeepingExtension,
	writePlannedTargets,
} from "./safe-output.ts";
import {
	type ResolvedVersionTarget,
	resolveVersionTarget,
} from "./version-options.ts";

export type ModelMode =
	| "inspect"
	| "validate"
	| "create"
	| "apply"
	| "export"
	| "preview"
	| "import-bbmodel"
	| "export-bbmodel";

export interface ModelCliOptions {
	pack?: string | undefined;
	vanilla?: string | undefined;
	dependency?: string[] | undefined;
	minecraftVersion?: string | undefined;
	resourcePackVersion?: string | undefined;
	spec?: string | undefined; // path or "-"
	operations?: string | undefined; // path or "-"
	binding?: string | undefined; // path or "-"
	size?: string | undefined;
	/** three-view (default) or isometric. */
	view?: string | undefined;
	/** Isometric camera direction; only with view=isometric. */
	viewDirection?: string | undefined;
	/** Display slot to simulate; mutually exclusive with view. */
	display?: string | undefined;
	/** Apply the fixed per-face shade factors selected by gui_light. */
	lighting?: boolean | undefined;
	/** #rrggbb colour for every face that declares tintindex. */
	tint?: string | undefined;
	/** Inline JSON object mapping a tintindex to a #rrggbb colour. */
	tints?: string | undefined;
	output?: string | undefined;
	stdout?: boolean | undefined;
	itemOutput?: string | undefined;
	blockstateOutput?: string | undefined;
	/** import-bbmodel: root directory for embedded PNGs. */
	textures?: string | undefined;
	/** export-bbmodel: repeated key=path pairs, one per texture variable. */
	texture?: string[] | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
}

/** A JSON document: a file path ("-" reads stdin) from the CLI, the value itself from MCP. */
export type DocumentRef =
	| { readonly path: string }
	| { readonly inline: unknown };

/** Result shared by create, apply and export; the CLI envelope and MCP return the same shape. */
export interface ModelEditOutput {
	readonly command: "model";
	readonly mode: "create" | "apply" | "export";
	readonly version: {
		readonly packFormat?: string;
		readonly minecraftVersion?: string;
		readonly rules: string;
		readonly rulesReason: string;
	};
	readonly applied?: number;
	readonly changed: boolean;
	readonly warnings: readonly {
		readonly code: string;
		readonly level: "warning";
		readonly message: string;
		readonly pointer: string;
	}[];
	readonly preservedUnknown: readonly string[];
	/** Written paths; absent entries mean the artifact was embedded or not requested. */
	readonly output?: string;
	readonly itemOutput?: string;
	readonly blockstateOutput?: string;
	/** MCP without a path: the text itself. */
	readonly modelText?: string;
	readonly itemText?: string;
	readonly blockstateText?: string;
}

export type ModelResult =
	| ModelInspectReport
	| ModelValidateReport
	| ModelEditOutput
	| ModelImportBbmodelOutput
	| ModelExportBbmodelOutput
	| ModelPreviewReport;

/** A conversion note that keeps the result usable; .bbmodel warnings carry no pointer. */
export interface BbmodelExchangeWarning {
	readonly code: string;
	readonly level: "warning";
	readonly message: string;
}

/** One texture variable of an imported project, with the file written or the bytes embedded. */
export interface ImportedBbmodelTexture {
	readonly key: string;
	readonly sprite: string;
	readonly relativePath?: string;
	readonly output?: string;
	readonly pngBase64?: string;
	readonly width?: number;
	readonly height?: number;
}

export interface ModelImportBbmodelOutput {
	readonly command: "model";
	readonly mode: "import-bbmodel";
	readonly formatVersion: string;
	readonly resolution: { readonly width: number; readonly height: number };
	readonly packFormat?: string;
	readonly elementCount: number;
	readonly textureCount: number;
	readonly warnings: readonly BbmodelExchangeWarning[];
	readonly output?: string;
	readonly modelText?: string;
	readonly textures: readonly ImportedBbmodelTexture[];
}

export interface ModelExportBbmodelOutput {
	readonly command: "model";
	readonly mode: "export-bbmodel";
	readonly formatVersion: string;
	readonly elementCount: number;
	readonly textureCount: number;
	readonly warnings: readonly BbmodelExchangeWarning[];
	readonly output?: string;
	readonly bbmodelText?: string;
}

export interface ModelRequest {
	readonly mode: ModelMode;
	readonly inputPath?: string | undefined;
	readonly spec?: DocumentRef | undefined;
	readonly operations?: DocumentRef | undefined;
	readonly binding?: DocumentRef | undefined;
	readonly packPath?: string | undefined;
	readonly vanillaPath?: string | undefined;
	readonly dependencyPaths?: readonly string[] | undefined;
	readonly minecraftVersion?: string | undefined;
	readonly resourcePackVersion?: string | undefined;
	readonly size?: number | undefined;
	/** three-view (default) or isometric; the shared preview parser validates it. */
	readonly view?: string | undefined;
	readonly viewDirection?: string | undefined;
	/** Display slot to simulate; mutually exclusive with view. */
	readonly display?: string | undefined;
	/** Apply the fixed per-face shade factors selected by gui_light. */
	readonly lighting?: boolean | undefined;
	/** #rrggbb colour for every face that declares tintindex. */
	readonly tint?: string | undefined;
	/** Colour per tintindex, already parsed from the CLI's inline JSON. */
	readonly tints?: Readonly<Record<string, string>> | undefined;
	readonly outputPath?: string | undefined;
	readonly itemOutputPath?: string | undefined;
	readonly blockstateOutputPath?: string | undefined;
	/** import-bbmodel: root directory for embedded PNGs. */
	readonly textureOutputDir?: string | undefined;
	/** export-bbmodel: Java texture variable to PNG path. */
	readonly texturePaths?: Readonly<Record<string, string>> | undefined;
	readonly stdout?: boolean | undefined;
	readonly force?: boolean | undefined;
	readonly mkdir?: boolean | undefined;
	/** CLI true: an output is mandatory. MCP false: results are embedded instead. */
	readonly requireOutput: boolean;
}

export interface ModelOutcome {
	readonly result: ModelResult;
	/** validate with verdict "fail": the CLI exits 3, MCP returns the report as a normal result. */
	readonly failed: boolean;
	/** CLI create and apply with --stdout: the model JSON text. */
	readonly artifact?: Uint8Array | undefined;
}

type BindingDocument = z.infer<typeof modelBindingSchema>;

type RequestField = Exclude<
	keyof ModelRequest,
	"mode" | "requireOutput" | "force" | "mkdir"
>;

/** Request fields each mode refuses; any of them present is INVALID_ARGUMENT naming field and mode. */
const REFUSED_FIELDS: Readonly<Record<ModelMode, readonly RequestField[]>> = {
	inspect: [
		"spec",
		"operations",
		"binding",
		"size",
		"view",
		"viewDirection",
		"display",
		"lighting",
		"tint",
		"tints",
		"outputPath",
		"itemOutputPath",
		"blockstateOutputPath",
		"textureOutputDir",
		"texturePaths",
		"stdout",
	],
	validate: [
		"spec",
		"operations",
		"binding",
		"size",
		"view",
		"viewDirection",
		"display",
		"lighting",
		"tint",
		"tints",
		"outputPath",
		"itemOutputPath",
		"blockstateOutputPath",
		"textureOutputDir",
		"texturePaths",
		"stdout",
	],
	create: [
		"inputPath",
		"operations",
		"binding",
		"size",
		"view",
		"viewDirection",
		"display",
		"lighting",
		"tint",
		"tints",
		"packPath",
		"vanillaPath",
		"dependencyPaths",
		"itemOutputPath",
		"blockstateOutputPath",
		"textureOutputDir",
		"texturePaths",
	],
	apply: [
		"spec",
		"binding",
		"size",
		"view",
		"viewDirection",
		"display",
		"lighting",
		"tint",
		"tints",
		"packPath",
		"vanillaPath",
		"dependencyPaths",
		"itemOutputPath",
		"blockstateOutputPath",
		"textureOutputDir",
		"texturePaths",
	],
	export: [
		"spec",
		"operations",
		"size",
		"view",
		"viewDirection",
		"display",
		"lighting",
		"tint",
		"tints",
		"vanillaPath",
		"dependencyPaths",
		"textureOutputDir",
		"texturePaths",
		"stdout",
	],
	preview: [
		"spec",
		"operations",
		"binding",
		"itemOutputPath",
		"blockstateOutputPath",
		"textureOutputDir",
		"texturePaths",
	],
	"import-bbmodel": [
		"spec",
		"operations",
		"binding",
		"size",
		"display",
		"lighting",
		"tint",
		"tints",
		"packPath",
		"vanillaPath",
		"dependencyPaths",
		"itemOutputPath",
		"blockstateOutputPath",
		"texturePaths",
	],
	"export-bbmodel": [
		"spec",
		"operations",
		"binding",
		"size",
		"display",
		"lighting",
		"tint",
		"tints",
		"packPath",
		"vanillaPath",
		"dependencyPaths",
		"itemOutputPath",
		"blockstateOutputPath",
		"textureOutputDir",
		"minecraftVersion",
		"resourcePackVersion",
	],
};

const MODEL_LAYOUT = /^assets\/([a-z0-9_.-]+)\/models\/(.+)\.json$/;

interface ModelLocation {
	readonly namespace: string;
	readonly path: string;
}

function stripCodePrefix(message: string): string {
	return message.replace(/^\[[A-Z_]+\] /, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGiven(value: unknown): boolean {
	if (value === undefined || value === false) return false;
	if (Array.isArray(value)) return value.length > 0;
	return true;
}

function isStdinRef(ref: DocumentRef | undefined): boolean {
	return ref !== undefined && "path" in ref && ref.path === "-";
}

function checkRefused(request: ModelRequest): void {
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

function checkSingleStdin(request: ModelRequest): void {
	const count = [request.spec, request.operations, request.binding].filter(
		isStdinRef,
	).length;
	if (count > 1) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			"Only one of --spec, --operations, or --binding may read stdin (-).",
		);
	}
}

/** Every file path the command reads. Outputs must never alias one of them. */
function sourcePathsOf(request: ModelRequest): string[] {
	const paths: string[] = [];
	if (request.inputPath !== undefined) paths.push(request.inputPath);
	for (const ref of [request.spec, request.operations, request.binding]) {
		if (ref !== undefined && "path" in ref && ref.path !== "-") {
			paths.push(ref.path);
		}
	}
	if (request.texturePaths !== undefined) {
		paths.push(...Object.values(request.texturePaths));
	}
	return paths;
}

function requireInput(request: ModelRequest, label = "model"): string {
	if (request.inputPath === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`${request.mode} needs a ${label} file.`,
			{ field: "inputPath" },
		);
	}
	return request.inputPath;
}

function versionFlags(request: ModelRequest): {
	minecraftVersion?: string | undefined;
	resourcePackVersion?: string | undefined;
} {
	return {
		minecraftVersion: request.minecraftVersion,
		resourcePackVersion: request.resourcePackVersion,
	};
}

async function statOrUndefined(path: string) {
	try {
		return await stat(path);
	} catch {
		return undefined;
	}
}

async function requireDirectory(path: string, label: string): Promise<string> {
	const info = await statOrUndefined(path);
	if (info === undefined || !info.isDirectory()) {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`${label} root is not a directory: ${path}.`,
		);
	}
	return path;
}

async function realpathOf(path: string, label: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Cannot read ${label.toLowerCase()} path: ${path}.`,
		);
	}
}

function parseModelLocation(rel: string): ModelLocation | undefined {
	const match = MODEL_LAYOUT.exec(rel);
	if (match === null) return undefined;
	const namespace = match[1] ?? "";
	const path = match[2] ?? "";
	const segments = path.split("/");
	if (
		namespace === "." ||
		namespace === ".." ||
		!/^[a-z0-9/._-]+$/.test(path) ||
		segments.some(
			(segment) => segment === "" || segment === "." || segment === "..",
		)
	) {
		return undefined;
	}
	return { namespace, path };
}

/** The model id of a file under <pack>/assets/<ns>/models/, or INVALID_ARGUMENT. */
async function modelLocationOf(
	packRoot: string,
	modelPath: string,
): Promise<ModelLocation & { readonly id: string }> {
	const packReal = await realpathOf(packRoot, "Pack");
	const fileReal = await realpathOf(modelPath, "Model");
	const location = parseModelLocation(
		relative(packReal, fileReal).split(sep).join("/"),
	);
	if (location === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Model file must be under assets/<namespace>/models/ inside the pack: ${modelPath}.`,
			{ reason: "outside-models", path: modelPath },
		);
	}
	return {
		...location,
		id: `${location.namespace}:${location.path}`,
	};
}

function displayPath(modelPath: string, packRoot: string | undefined): string {
	return packRoot === undefined
		? modelPath
		: relative(resolve(packRoot), resolve(modelPath)).split(sep).join("/");
}

/** Dotted pack format from a pack.mcmeta value; malformed values fall through to the next key. */
function dottedFormat(value: unknown): string | undefined {
	if (typeof value === "number") {
		return Number.isInteger(value) && value >= 1 ? `${value}.0` : undefined;
	}
	if (Array.isArray(value)) {
		const [major, minor] = value as unknown[];
		if (
			value.length === 2 &&
			typeof major === "number" &&
			typeof minor === "number" &&
			Number.isInteger(major) &&
			Number.isInteger(minor) &&
			major >= 1 &&
			minor >= 0
		) {
			return `${major}.${minor}`;
		}
		return undefined;
	}
	if (typeof value === "string") {
		try {
			return normalizePackFormat(value);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * Pack format from <pack>/pack.mcmeta, resolved max_format, then min_format,
 * then pack_format (the same order validate-pack uses). Missing or unreadable
 * means undetermined: no default is applied.
 */
async function packFormatFromMcmeta(
	packRoot: string,
): Promise<string | undefined> {
	let doc: unknown;
	try {
		doc = JSON.parse(await readFile(join(packRoot, "pack.mcmeta"), "utf8"));
	} catch {
		return undefined;
	}
	const pack = isRecord(doc) && isRecord(doc.pack) ? doc.pack : undefined;
	if (pack === undefined) return undefined;
	for (const key of ["max_format", "min_format", "pack_format"]) {
		const dotted = dottedFormat(pack[key]);
		if (dotted !== undefined) return dotted;
	}
	return undefined;
}

async function readBoundedFile(
	path: string,
	label: string,
): Promise<Uint8Array> {
	const info = await statOrUndefined(path);
	if (info === undefined) {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Cannot read ${label.toLowerCase()} file: ${path}.`,
		);
	}
	if (!info.isFile()) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`${label} path is not a file: ${path}.`,
		);
	}
	if (info.size > MODEL_LIMITS.maxFileBytes) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			`${label} file exceeds ${MODEL_LIMITS.maxFileBytes} bytes: ${path}.`,
			{ limit: MODEL_LIMITS.maxFileBytes, actual: info.size },
		);
	}
	try {
		return new Uint8Array(await readFile(path));
	} catch {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Cannot read ${label.toLowerCase()} file: ${path}.`,
		);
	}
}

function decodeUtf8(
	bytes: Uint8Array,
	label: string,
	code:
		| "MODEL_INVALID_JSON"
		| "BBMODEL_INVALID_DOCUMENT" = "MODEL_INVALID_JSON",
): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new McAssetError(code, `${label} is not valid UTF-8.`, {
			reason: "encoding",
		});
	}
}

async function readModelText(path: string): Promise<string> {
	return decodeUtf8(await readBoundedFile(path, "Model"), "Model");
}

async function readBbmodelText(path: string): Promise<string> {
	return decodeUtf8(
		await readBoundedFile(path, "Project"),
		"Project",
		"BBMODEL_INVALID_DOCUMENT",
	);
}

/** Loads a JSON document from a path, stdin ("-"), or the inline value. */
async function loadDocument(ref: DocumentRef, label: string): Promise<unknown> {
	if ("inline" in ref) return ref.inline;
	let bytes: Uint8Array;
	if (ref.path === "-") {
		bytes = await readStdinBytes();
		if (bytes.byteLength > MODEL_LIMITS.maxFileBytes) {
			throw new McAssetError(
				"RESOURCE_LIMIT_EXCEEDED",
				`${label} from stdin exceeds ${MODEL_LIMITS.maxFileBytes} bytes.`,
				{ limit: MODEL_LIMITS.maxFileBytes, actual: bytes.byteLength },
			);
		}
	} else {
		bytes = await readBoundedFile(ref.path, label);
	}
	try {
		return JSON.parse(decodeUtf8(bytes, label)) as unknown;
	} catch (error) {
		if (error instanceof McAssetError) throw error;
		throw new McAssetError(
			"MODEL_INVALID_JSON",
			`${label} is not valid JSON.`,
			{ reason: "syntax" },
		);
	}
}

function issuesOf(error: z.ZodError): { path: string; message: string }[] {
	return error.issues.slice(0, 20).map((issue) => ({
		path: issue.path.join("/"),
		message: issue.message,
	}));
}

function parseSpec(value: unknown): ModelSpec {
	const parsed = modelSpecSchema.safeParse(value);
	if (!parsed.success) {
		throw new McAssetError(
			"MODEL_INVALID_OPERATION",
			"The spec is not a valid model description.",
			{ reason: "invalid-spec", issues: issuesOf(parsed.error) },
		);
	}
	return parsed.data as ModelSpec;
}

function parseOperations(value: unknown): ModelOperation[] {
	if (!Array.isArray(value)) {
		throw new McAssetError(
			"MODEL_INVALID_OPERATION",
			"Operations must be a JSON array.",
			{ reason: "not-array" },
		);
	}
	checkedOperationCount(value.length);
	if (value.length === 0) {
		throw new McAssetError(
			"MODEL_INVALID_OPERATION",
			"At least one operation is required.",
			{ reason: "empty" },
		);
	}
	const parsed = modelOperationSchema.array().safeParse(value);
	if (!parsed.success) {
		throw new McAssetError(
			"MODEL_INVALID_OPERATION",
			"An operation is not valid.",
			{ reason: "invalid-operation", issues: issuesOf(parsed.error) },
		);
	}
	return parsed.data as ModelOperation[];
}

function parseBinding(value: unknown): BindingDocument {
	const parsed = modelBindingSchema.safeParse(value);
	if (!parsed.success) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"The binding document is not valid.",
			{ reason: "invalid-binding", issues: issuesOf(parsed.error) },
		);
	}
	return parsed.data;
}

/** create and apply take one --output or --stdout; CLI requires one of them. */
function outputChoice(request: ModelRequest): {
	readonly path: string | undefined;
	readonly stdout: boolean;
} {
	const stdout = request.stdout === true;
	if (request.outputPath !== undefined && stdout) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			"Use only one of --output or --stdout.",
		);
	}
	if (request.outputPath === undefined && !stdout && request.requireOutput) {
		throw new McAssetError(
			"OUTPUT_REQUIRED",
			"One of --output or --stdout is required.",
		);
	}
	return { path: request.outputPath, stdout };
}

async function runPreview(request: ModelRequest): Promise<ModelOutcome> {
	const modelPath = requireInput(request);
	const size = previewSize(request);
	const display = previewDisplay(request);
	const view = previewView(request);
	const tint = previewTint(request);
	const packRoot =
		request.packPath === undefined
			? undefined
			: await requireDirectory(request.packPath, "Pack");
	const vanillaRoot =
		request.vanillaPath === undefined
			? undefined
			: await requireDirectory(request.vanillaPath, "Vanilla");
	const dependencyRoots: string[] = [];
	for (const dependency of request.dependencyPaths ?? []) {
		dependencyRoots.push(await requireDirectory(dependency, "Dependency"));
	}
	const target = resolveVersionTarget(versionFlags(request));
	const packFormat =
		target.packFormat ??
		(packRoot === undefined ? undefined : await packFormatFromMcmeta(packRoot));
	const modelId =
		packRoot === undefined
			? undefined
			: (await modelLocationOf(packRoot, modelPath)).id;
	const context =
		packRoot === undefined &&
		vanillaRoot === undefined &&
		dependencyRoots.length === 0
			? undefined
			: await createFsModelContext({
					...(packRoot === undefined ? {} : { packRoot }),
					...(dependencyRoots.length === 0 ? {} : { dependencyRoots }),
					...(vanillaRoot === undefined ? {} : { vanillaRoot }),
				});
	// Path phase: every output is checked before anything is computed.
	const output = outputChoice(request);
	const planned = await planTargets(
		request,
		modelPreviewTargets(output.path, request.force === true),
	);
	const text = await readModelText(modelPath);
	const rendered = await renderModelPreview(text, {
		path: displayPath(modelPath, packRoot),
		...(modelId === undefined ? {} : { modelId }),
		...(packFormat === undefined ? {} : { packFormat }),
		...(target.minecraftVersion === undefined
			? {}
			: { minecraftVersion: target.minecraftVersion }),
		...(context === undefined ? {} : { context }),
		size,
		...(view === undefined ? {} : { view }),
		...(display === undefined ? {} : { display }),
		...(request.lighting === true ? { lighting: true } : {}),
		...(tint.tint === undefined ? {} : { tint: tint.tint }),
		...(tint.tints === undefined ? {} : { tints: tint.tints }),
	});
	// The PNG and the report are computed before anything is written.
	const payloads = new Map<string, Uint8Array>();
	if (output.path !== undefined) payloads.set(output.path, rendered.png);
	const written = await writePlannedTargets(planned, payloads, {
		mkdir: request.mkdir === true,
	});
	return {
		result: {
			...rendered.report,
			...(output.path !== undefined && written.includes(output.path)
				? { output: output.path }
				: {}),
		},
		failed: false,
		artifact: output.stdout ? rendered.png : undefined,
	};
}

/** The CLI accepts only 64, 128, or 256; the MCP schema enforces the same. */
function previewSize(request: ModelRequest): ModelPreviewSize {
	const value = request.size ?? 64;
	if (value === 64 || value === 128 || value === 256) return value;
	throw new McAssetError(
		"INVALID_ARGUMENT",
		`preview size must be one of 64, 128, or 256: ${String(value)}.`,
		{ field: "size", size: value },
	);
}

/**
 * Parse the preview view. A missing or explicit `three-view` keeps the
 * existing report and PNG bytes; an isometric view takes a camera direction
 * that defaults to south-east. A direction without the isometric view is
 * refused rather than silently ignored.
 */
function previewView(request: ModelRequest): ModelPreviewView | undefined {
	if (request.view === undefined || request.view === "three-view") {
		if (request.viewDirection !== undefined) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"viewDirection requires view isometric.",
				{ field: "viewDirection" },
			);
		}
		return undefined;
	}
	if (request.view !== "isometric") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`view must be three-view or isometric: ${String(request.view)}.`,
			{ field: "view", view: request.view },
		);
	}
	const direction = request.viewDirection ?? "south-east";
	if (!(ISOMETRIC_DIRECTIONS as readonly string[]).includes(direction)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`viewDirection must be one of ${ISOMETRIC_DIRECTIONS.join(", ")}: ${String(direction)}.`,
			{ field: "viewDirection", viewDirection: direction },
		);
	}
	return { kind: "isometric", direction: direction as IsometricDirection };
}

/** Display slots the preview can simulate; the game only has these six + the unused on_shelf. */
function previewDisplay(request: ModelRequest): PreviewDisplaySlot | undefined {
	if (request.display === undefined) return undefined;
	if (!(PREVIEW_DISPLAY_SLOTS as readonly string[]).includes(request.display)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`display must be one of ${PREVIEW_DISPLAY_SLOTS.join(", ")}: ${String(request.display)}.`,
			{ field: "display", display: request.display },
		);
	}
	if (request.view !== undefined || request.viewDirection !== undefined) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			"display cannot be combined with view or viewDirection.",
			{ field: "display", mode: "preview" },
		);
	}
	return request.display as PreviewDisplaySlot;
}

/** Parse the CLI's inline `--tints` JSON object; the MCP passes the object itself. */
function parseTintsDocument(raw: string): Readonly<Record<string, string>> {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"--tints expects a JSON object mapping a tintindex to a #RRGGBB colour.",
			{ field: "tints" },
		);
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"--tints expects a JSON object mapping a tintindex to a #RRGGBB colour.",
			{ field: "tints" },
		);
	}
	const result: Record<string, string> = {};
	const seen = new Set<number>();
	for (const [key, rawValue] of Object.entries(value)) {
		if (!/^\d+$/.test(key)) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				`--tints keys must be non-negative integers: ${key}.`,
				{ field: "tints", key },
			);
		}
		const index = Number(key);
		if (!Number.isSafeInteger(index)) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				`--tints key is too large: ${key}.`,
				{ field: "tints", key },
			);
		}
		if (seen.has(index)) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				`--tints names tintindex ${index} twice.`,
				{ field: "tints", index },
			);
		}
		seen.add(index);
		if (typeof rawValue !== "string") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				`--tints[${key}] must be a #RRGGBB colour.`,
				{ field: "tints", key },
			);
		}
		result[String(index)] = rawValue;
	}
	return result;
}

/** Parse the tint colour strings; shared by the CLI and the MCP tool. */
function previewTint(request: ModelRequest): {
	readonly tint?: RgbTint;
	readonly tints?: Record<string, RgbTint>;
} {
	if (request.tint !== undefined && request.tints !== undefined) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			"Use only one of tint or tints.",
			{ field: "tints", mode: "preview" },
		);
	}
	const parseColour = (value: string, field: string): RgbTint => {
		const color = parseTintColor(value);
		if (color === undefined) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				`${field} expects a #RRGGBB colour: ${value}.`,
				{ field },
			);
		}
		return color;
	};
	if (request.tint !== undefined) {
		return { tint: parseColour(request.tint, "tint") };
	}
	if (request.tints === undefined) return {};
	const tints: Record<string, RgbTint> = {};
	for (const [key, value] of Object.entries(request.tints)) {
		tints[key] = parseColour(value, `tints[${key}]`);
	}
	return { tints };
}

function modelTargets(
	path: string | undefined,
	force: boolean,
): OutputTarget[] {
	return path === undefined
		? []
		: [{ path, extension: ".json", allowOverwrite: force }];
}

function modelPreviewTargets(
	path: string | undefined,
	force: boolean,
): OutputTarget[] {
	return path === undefined
		? []
		: [{ path, extension: ".png", allowOverwrite: force }];
}

/** Path phase: every output is checked before any document is computed. */
async function planTargets(
	request: ModelRequest,
	targets: readonly OutputTarget[],
	allowedRoot?: string,
): Promise<readonly PlannedTarget[]> {
	return planOutputTargets(targets, {
		inputs: sourcePathsOf(request),
		mkdir: request.mkdir === true,
		...(allowedRoot === undefined ? {} : { allowedRoot }),
	});
}

function checkBindingOutputs(
	binding: BindingDocument | undefined,
	outputs: {
		readonly item: string | undefined;
		readonly blockstate: string | undefined;
		readonly anyOutput: boolean;
	},
): void {
	if (outputs.item !== undefined && binding?.item === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"An item output needs binding.item.",
			{ field: "itemOutputPath" },
		);
	}
	if (outputs.blockstate !== undefined && binding?.blockstate === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"A blockstate output needs binding.blockstate.",
			{ field: "blockstateOutputPath" },
		);
	}
	if (!outputs.anyOutput) return;
	if (binding?.item !== undefined && outputs.item === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"binding.item needs an item output path.",
			{ field: "itemOutputPath" },
		);
	}
	if (binding?.blockstate !== undefined && outputs.blockstate === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"binding.blockstate needs a blockstate output path.",
			{ field: "blockstateOutputPath" },
		);
	}
}

/** Checks that need the pack root: the model output sits under assets/<namespace>/models/, and item and blockstate outputs match their ids. Runs after the path phase. */
function assertExportLayout(
	packRoot: string | undefined,
	binding: BindingDocument | undefined,
	outputs: {
		readonly model: string | undefined;
		readonly item: string | undefined;
		readonly blockstate: string | undefined;
	},
): void {
	const packOption = packRoot === undefined ? {} : { packPath: packRoot };
	if (packRoot !== undefined && outputs.model !== undefined) {
		const rel = relative(resolve(packRoot), resolve(outputs.model));
		if (parseModelLocation(rel.split(sep).join("/")) === undefined) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				`Model output must be under assets/<namespace>/models/ inside the pack: ${outputs.model}.`,
				{ path: outputs.model },
			);
		}
	}
	if (binding?.item !== undefined && outputs.item !== undefined) {
		assertBindingOutputTarget(outputs.item, {
			...packOption,
			kind: "item",
			id: binding.item.itemId,
			force: false,
		});
	}
	if (binding?.blockstate !== undefined && outputs.blockstate !== undefined) {
		assertBindingOutputTarget(outputs.blockstate, {
			...packOption,
			kind: "blockstate",
			id: binding.blockstate.blockId,
			force: false,
		});
	}
}

function versionBody(
	target: ResolvedVersionTarget,
	rules: ModelRules,
): ModelEditOutput["version"] {
	return {
		...(target.packFormat === undefined
			? {}
			: { packFormat: target.packFormat }),
		...(target.minecraftVersion === undefined
			? {}
			: { minecraftVersion: target.minecraftVersion }),
		rules: rules.status,
		rulesReason: rules.reason,
	};
}

interface EditArtifact {
	readonly kind: "model" | "item" | "blockstate";
	readonly text: string;
	readonly path: string | undefined;
}

interface EditRun {
	readonly request: ModelRequest;
	readonly mode: "create" | "apply" | "export";
	readonly target: ResolvedVersionTarget;
	readonly rules: ModelRules;
	readonly edit: ModelEditResult;
	readonly applied?: number | undefined;
	readonly artifacts: readonly EditArtifact[];
	readonly planned: readonly PlannedTarget[];
	readonly stdoutBytes?: Uint8Array | undefined;
}

/**
 * Write phase and result. Written artifacts are reported by path; without a
 * path an MCP call embeds the text. The CLI never embeds: it requires outputs.
 */
async function completeEdit(run: EditRun): Promise<ModelOutcome> {
	const payloads = new Map<string, string>();
	for (const artifact of run.artifacts) {
		if (artifact.path !== undefined) payloads.set(artifact.path, artifact.text);
	}
	const written = new Set(
		run.planned.length === 0
			? []
			: await writePlannedTargets(run.planned, payloads, {
					mkdir: run.request.mkdir === true,
				}),
	);
	const embed = run.request.requireOutput !== true;
	const find = (kind: EditArtifact["kind"]): EditArtifact | undefined =>
		run.artifacts.find((artifact) => artifact.kind === kind);
	const writtenPath = (kind: EditArtifact["kind"]): string | undefined => {
		const path = find(kind)?.path;
		return path !== undefined && written.has(path) ? path : undefined;
	};
	const embeddedText = (kind: EditArtifact["kind"]): string | undefined => {
		const artifact = find(kind);
		return embed && artifact !== undefined && artifact.path === undefined
			? artifact.text
			: undefined;
	};
	const output = writtenPath("model");
	const itemOutput = writtenPath("item");
	const blockstateOutput = writtenPath("blockstate");
	const modelText = embeddedText("model");
	const itemText = embeddedText("item");
	const blockstateText = embeddedText("blockstate");
	const result: ModelEditOutput = {
		command: "model",
		mode: run.mode,
		version: versionBody(run.target, run.rules),
		...(run.applied === undefined ? {} : { applied: run.applied }),
		changed: run.edit.changed,
		warnings: run.edit.warnings.map((warning) => ({
			code: warning.code,
			level: "warning" as const,
			message: warning.message,
			pointer: warning.pointer,
		})),
		preservedUnknown: [...run.edit.preservedUnknown],
		...(output === undefined ? {} : { output }),
		...(itemOutput === undefined ? {} : { itemOutput }),
		...(blockstateOutput === undefined ? {} : { blockstateOutput }),
		...(modelText === undefined ? {} : { modelText }),
		...(itemText === undefined ? {} : { itemText }),
		...(blockstateText === undefined ? {} : { blockstateText }),
	};
	return { result, failed: false, artifact: run.stdoutBytes };
}

async function runAnalysis(request: ModelRequest): Promise<ModelOutcome> {
	const modelPath = requireInput(request);
	const packRoot =
		request.packPath === undefined
			? undefined
			: await requireDirectory(request.packPath, "Pack");
	const vanillaRoot =
		request.vanillaPath === undefined
			? undefined
			: await requireDirectory(request.vanillaPath, "Vanilla");
	const dependencyRoots: string[] = [];
	for (const dependency of request.dependencyPaths ?? []) {
		dependencyRoots.push(await requireDirectory(dependency, "Dependency"));
	}
	const modelId =
		packRoot === undefined
			? undefined
			: (await modelLocationOf(packRoot, modelPath)).id;
	const target = resolveVersionTarget(versionFlags(request));
	const packFormat =
		target.packFormat ??
		(packRoot === undefined ? undefined : await packFormatFromMcmeta(packRoot));
	const context =
		packRoot === undefined &&
		vanillaRoot === undefined &&
		dependencyRoots.length === 0
			? undefined
			: await createFsModelContext({
					...(packRoot === undefined ? {} : { packRoot }),
					...(dependencyRoots.length === 0 ? {} : { dependencyRoots }),
					...(vanillaRoot === undefined ? {} : { vanillaRoot }),
				});
	const text = await readModelText(modelPath);
	const options = {
		path: displayPath(modelPath, packRoot),
		packFormat,
		minecraftVersion: target.minecraftVersion,
		modelId,
		context,
	};
	if (request.mode === "inspect") {
		return { result: await inspectModel(text, options), failed: false };
	}
	const report = await validateModel(text, options);
	return { result: report, failed: report.verdict === "fail" };
}

async function runCreate(request: ModelRequest): Promise<ModelOutcome> {
	if (request.spec === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"create needs a spec document.",
			{
				field: "spec",
			},
		);
	}
	const output = outputChoice(request);
	const target = resolveVersionTarget(versionFlags(request));
	const rules = resolveModelRules(target.packFormat);
	const planned = await planTargets(
		request,
		modelTargets(output.path, request.force === true),
	);
	const spec = parseSpec(await loadDocument(request.spec, "Spec"));
	const edit = createModelDocument(spec, rules);
	return completeEdit({
		request,
		mode: "create",
		target,
		rules,
		edit,
		artifacts: [{ kind: "model", text: edit.text, path: output.path }],
		planned,
		stdoutBytes: output.stdout
			? new TextEncoder().encode(edit.text)
			: undefined,
	});
}

async function runApply(request: ModelRequest): Promise<ModelOutcome> {
	const modelPath = requireInput(request);
	if (request.operations === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"apply needs an operations document.",
			{ field: "operations" },
		);
	}
	const output = outputChoice(request);
	const target = resolveVersionTarget(versionFlags(request));
	const rules = resolveModelRules(target.packFormat);
	const planned = await planTargets(
		request,
		modelTargets(output.path, request.force === true),
	);
	const operations = parseOperations(
		await loadDocument(request.operations, "Operations"),
	);
	const edit = applyModelOperations(
		await readModelText(modelPath),
		operations,
		rules,
	);
	return completeEdit({
		request,
		mode: "apply",
		target,
		rules,
		edit,
		applied: edit.applied,
		artifacts: [{ kind: "model", text: edit.text, path: output.path }],
		planned,
		stdoutBytes: output.stdout
			? new TextEncoder().encode(edit.text)
			: undefined,
	});
}

async function runExport(request: ModelRequest): Promise<ModelOutcome> {
	const modelPath = requireInput(request);
	const packRoot =
		request.packPath === undefined
			? undefined
			: await requireDirectory(request.packPath, "Pack");
	if (packRoot !== undefined) await modelLocationOf(packRoot, modelPath);
	const outputs = {
		model: request.outputPath,
		item: request.itemOutputPath,
		blockstate: request.blockstateOutputPath,
	};
	const anyOutput =
		outputs.model !== undefined ||
		outputs.item !== undefined ||
		outputs.blockstate !== undefined;
	if (request.requireOutput && !anyOutput) {
		throw new McAssetError(
			"OUTPUT_REQUIRED",
			"export needs --output, --item-output, or --blockstate-output.",
		);
	}
	const binding =
		request.binding === undefined
			? undefined
			: parseBinding(await loadDocument(request.binding, "Binding"));
	checkBindingOutputs(binding, {
		item: outputs.item,
		blockstate: outputs.blockstate,
		anyOutput,
	});
	const target = resolveVersionTarget(versionFlags(request));
	const rules = resolveModelRules(target.packFormat);
	const force = request.force === true;
	const targets: OutputTarget[] = [
		...modelTargets(outputs.model, force),
		...(outputs.item === undefined
			? []
			: [
					{
						path: outputs.item,
						extension: ".json" as const,
						allowOverwrite: false,
						createOnly: true,
					},
				]),
		...(outputs.blockstate === undefined
			? []
			: [
					{
						path: outputs.blockstate,
						extension: ".json" as const,
						allowOverwrite: false,
						createOnly: true,
					},
				]),
	];
	const planned = await planTargets(request, targets, packRoot);
	assertExportLayout(packRoot, binding, outputs);
	const edit = exportModelDocument(await readModelText(modelPath), rules);
	const artifacts: EditArtifact[] = [
		{ kind: "model", text: edit.text, path: outputs.model },
	];
	if (binding?.item !== undefined) {
		artifacts.push({
			kind: "item",
			text: buildItemDefinition(binding.item as ItemBindingSpec, rules).text,
			path: outputs.item,
		});
	}
	if (binding?.blockstate !== undefined) {
		artifacts.push({
			kind: "blockstate",
			text: buildBlockstate(binding.blockstate as BlockstateBindingSpec, rules)
				.text,
			path: outputs.blockstate,
		});
	}
	return completeEdit({
		request,
		mode: "export",
		target,
		rules,
		edit,
		artifacts,
		planned,
	});
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) return false;
	for (const [index, value] of left.entries()) {
		if (value !== right[index]) return false;
	}
	return true;
}

function exchangeWarnings(
	warnings: readonly { code: string; message: string }[],
): BbmodelExchangeWarning[] {
	return warnings.map((warning) => ({
		code: warning.code,
		level: "warning" as const,
		message: warning.message,
	}));
}

/** import-bbmodel: project text in, Java model JSON plus one PNG per embedded texture out. */
async function runImportBbmodel(request: ModelRequest): Promise<ModelOutcome> {
	const inputPath = requireInput(request, "project");
	const output = outputChoice(request);
	const target = resolveVersionTarget(versionFlags(request));
	const projectText = await readBbmodelText(inputPath);
	const imported = importBbmodel(
		projectText,
		target.packFormat === undefined ? {} : { packFormat: target.packFormat },
	);
	const warnings = [...imported.warnings];
	const embedded = imported.textures.filter(
		(texture) => texture.png !== undefined,
	);
	const textureRoot = request.textureOutputDir;
	const placeable = embedded.filter(
		(texture) => texture.relativePath !== undefined,
	);
	if (
		request.requireOutput &&
		placeable.length > 0 &&
		textureRoot === undefined
	) {
		throw new McAssetError(
			"OUTPUT_REQUIRED",
			"A project with embedded textures needs --textures <dir>.",
		);
	}

	interface TextureWrite {
		readonly path: string;
		readonly png: Uint8Array;
		readonly keys: string[];
	}
	const writes: TextureWrite[] = [];
	const writeByPath = new Map<string, TextureWrite>();
	const writtenPathByKey = new Map<string, string>();
	if (textureRoot !== undefined) {
		for (const texture of embedded) {
			if (texture.relativePath === undefined) {
				warnings.push({
					code: "BBMODEL_TEXTURE_UNPLACED",
					message: `Texture ${texture.key} is an alias with embedded data; it has no PNG path.`,
				});
				continue;
			}
			const path = join(textureRoot, texture.relativePath);
			const existing = writeByPath.get(path);
			if (existing === undefined) {
				const write: TextureWrite = {
					path,
					png: texture.png as Uint8Array,
					keys: [texture.key],
				};
				writeByPath.set(path, write);
				writes.push(write);
			} else if (bytesEqual(existing.png, texture.png as Uint8Array)) {
				existing.keys.push(texture.key);
			} else {
				throw new McAssetError(
					"ARGUMENT_CONFLICT",
					`Two embedded textures map to ${texture.relativePath} with different bytes.`,
					{ path: texture.relativePath },
				);
			}
		}
		for (const write of writes) {
			for (const key of write.keys) writtenPathByKey.set(key, write.path);
		}
	}

	const planned = await planTargets(
		request,
		output.path === undefined
			? []
			: [
					{
						path: output.path,
						extension: ".json" as const,
						allowOverwrite: request.force === true,
					},
				],
	);
	const plannedTextures =
		textureRoot === undefined
			? []
			: await planOutputTargets(
					writes.map((write) => ({
						path: write.path,
						extension: ".png" as const,
						allowOverwrite: request.force === true,
					})),
					{
						inputs: sourcePathsOf(request),
						mkdir: request.mkdir === true,
						allowedRoot: textureRoot,
					},
				);
	const payloads = new Map<string, string | Uint8Array>();
	if (output.path !== undefined) payloads.set(output.path, imported.modelText);
	for (const write of writes) payloads.set(write.path, write.png);
	const written = new Set<string>();
	for (const path of await writePlannedTargets(planned, payloads, {
		mkdir: request.mkdir === true,
	})) {
		written.add(path);
	}
	for (const path of await writePlannedTargets(plannedTextures, payloads, {
		mkdir: request.mkdir === true,
	})) {
		written.add(path);
	}

	const embed = request.requireOutput !== true && output.path === undefined;
	const elementCount = imported.spec.elements?.length ?? 0;
	const result: ModelImportBbmodelOutput = {
		command: "model",
		mode: "import-bbmodel",
		formatVersion: imported.formatVersion,
		resolution: imported.resolution,
		...(imported.packFormat === undefined
			? {}
			: { packFormat: imported.packFormat }),
		elementCount,
		textureCount: imported.textures.length,
		warnings: exchangeWarnings(warnings),
		...(output.path !== undefined && written.has(output.path)
			? { output: output.path }
			: {}),
		...(embed ? { modelText: imported.modelText } : {}),
		textures: imported.textures.map((texture) => {
			const texturePath = writtenPathByKey.get(texture.key);
			return {
				key: texture.key,
				sprite: texture.sprite,
				...(texture.relativePath === undefined
					? {}
					: { relativePath: texture.relativePath }),
				...(texture.width === undefined ? {} : { width: texture.width }),
				...(texture.height === undefined ? {} : { height: texture.height }),
				...(texturePath !== undefined && written.has(texturePath)
					? { output: texturePath }
					: {}),
				...(embed && textureRoot === undefined && texture.png !== undefined
					? { pngBase64: Buffer.from(texture.png).toString("base64") }
					: {}),
			};
		}),
	};
	return {
		result,
		failed: false,
		artifact: output.stdout
			? new TextEncoder().encode(imported.modelText)
			: undefined,
	};
}

/** export-bbmodel: Java model JSON plus explicit texture PNGs in, one .bbmodel out. */
async function runExportBbmodel(request: ModelRequest): Promise<ModelOutcome> {
	const inputPath = requireInput(request);
	const output = outputChoice(request);
	if (
		output.path !== undefined &&
		extname(output.path).toLowerCase() !== ".bbmodel"
	) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Output path must end with .bbmodel: ${output.path}.`,
			{ field: "outputPath", path: output.path },
		);
	}
	const texturePaths = request.texturePaths ?? {};
	const planned = await planOutputTargetsKeepingExtension(
		output.path === undefined
			? []
			: [{ path: output.path, allowOverwrite: request.force === true }],
		{
			inputs: sourcePathsOf(request),
			mkdir: request.mkdir === true,
		},
	);
	const textureBytes = new Map<string, Uint8Array>();
	for (const [key, path] of Object.entries(texturePaths)) {
		textureBytes.set(key, await readBoundedFile(path, "Texture"));
	}
	const exported = exportBbmodel(await readModelText(inputPath), textureBytes);
	const written =
		planned.length === 0 || output.path === undefined
			? []
			: await writePlannedTargets(
					planned,
					new Map([[output.path, exported.text]]),
					{ mkdir: request.mkdir === true },
				);
	const embed = request.requireOutput !== true && output.path === undefined;
	const result: ModelExportBbmodelOutput = {
		command: "model",
		mode: "export-bbmodel",
		formatVersion: exported.formatVersion,
		elementCount: exported.elementCount,
		textureCount: exported.textureCount,
		warnings: exchangeWarnings(exported.warnings),
		...(output.path !== undefined && written.includes(output.path)
			? { output: output.path }
			: {}),
		...(embed ? { bbmodelText: exported.text } : {}),
	};
	return {
		result,
		failed: false,
		artifact: output.stdout
			? new TextEncoder().encode(exported.text)
			: undefined,
	};
}

/**
 * Shared model pipeline for the CLI and the MCP tool. Order: refused fields,
 * then the mode's required inputs, then output rules, then paths (planOutputTargets),
 * then reading and computing, then the write phase.
 */
export async function runModelRequest(
	request: ModelRequest,
): Promise<ModelOutcome> {
	checkRefused(request);
	checkSingleStdin(request);
	switch (request.mode) {
		case "inspect":
		case "validate":
			return runAnalysis(request);
		case "create":
			return runCreate(request);
		case "apply":
			return runApply(request);
		case "export":
			return runExport(request);
		case "preview":
			return runPreview(request);
		case "import-bbmodel":
			return runImportBbmodel(request);
		case "export-bbmodel":
			return runExportBbmodel(request);
	}
}

function coverageLine(coverage: ModelCoverage): string {
	if (coverage.status === "complete") return "coverage: complete";
	return `coverage: partial (${coverage.skipped.length} skipped)`;
}

function reportLines(
	report: ModelInspectReport | ModelValidateReport | ModelPreviewReport,
): string[] {
	if (report.mode === "preview") {
		return [
			`command: ${report.command}`,
			`mode: ${report.mode}`,
			`path: ${report.path}`,
			`size: ${String(report.size)}`,
			...(report.view === undefined
				? []
				: [`view: ${report.view.kind} (${report.view.direction})`]),
			...(report.display === undefined
				? []
				: [`display: ${report.display.slot}`]),
			...(report.lighting === undefined
				? []
				: [`lighting: ${report.lighting.mode}`]),
			...(report.tint === undefined
				? []
				: [`tint: ${String(report.tint.appliedFaces)} face(s)`]),
			coverageLine(report.coverage),
		];
	}
	const lines = [
		`command: ${report.command}`,
		`mode: ${report.mode}`,
		`path: ${report.path}`,
		`target: ${report.target}`,
		`verdict: ${report.verdict}`,
		coverageLine(report.coverage),
	];
	for (const finding of report.findings) {
		lines.push(
			`${finding.level} [${finding.code}] ${finding.pointer}: ${finding.message}`,
		);
	}
	for (const skip of report.coverage.skipped) {
		lines.push(`skip [${skip.kind}] ${skip.target}: ${skip.reason}`);
	}
	return lines;
}

function editLines(result: ModelEditOutput): string[] {
	const lines = [`ok model ${result.mode} changed=${String(result.changed)}`];
	if (result.output !== undefined) lines.push(`output=${result.output}`);
	if (result.itemOutput !== undefined) {
		lines.push(`itemOutput=${result.itemOutput}`);
	}
	if (result.blockstateOutput !== undefined) {
		lines.push(`blockstateOutput=${result.blockstateOutput}`);
	}
	for (const warning of result.warnings) {
		lines.push(`warning [${warning.code}] ${warning.message}`);
	}
	return lines;
}

function bbmodelLines(
	result: ModelImportBbmodelOutput | ModelExportBbmodelOutput,
): string[] {
	const lines = [
		`ok model ${result.mode} elements=${String(result.elementCount)} textures=${String(result.textureCount)}`,
	];
	if (result.output !== undefined) lines.push(`output=${result.output}`);
	if (result.mode === "import-bbmodel") {
		for (const texture of result.textures) {
			if (texture.output !== undefined) lines.push(`texture=${texture.output}`);
		}
	}
	for (const warning of result.warnings) {
		lines.push(`warning [${warning.code}] ${warning.message}`);
	}
	return lines;
}

function textureOption(
	values: readonly string[] | undefined,
): Readonly<Record<string, string>> | undefined {
	if (values === undefined || values.length === 0) return undefined;
	const paths: Record<string, string> = {};
	for (const value of values) {
		const separator = value.indexOf("=");
		const key = separator < 0 ? "" : value.slice(0, separator);
		const path = separator < 0 ? "" : value.slice(separator + 1);
		if (key === "" || path === "") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				`--texture expects <key>=<png path>: ${value}.`,
				{ field: "texture" },
			);
		}
		if (Object.hasOwn(paths, key)) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				`Two --texture entries name ${key}.`,
				{ key },
			);
		}
		paths[key] = path;
	}
	return paths;
}

function failureSummary(
	report: ModelInspectReport | ModelValidateReport,
): string {
	let errors = 0;
	let warnings = 0;
	for (const finding of report.findings) {
		if (finding.level === "error") errors += 1;
		else warnings += 1;
	}
	return `validation failed: ${errors} error(s), ${warnings} warning(s).`;
}

function fileRef(value: string | undefined): DocumentRef | undefined {
	return value === undefined ? undefined : { path: value };
}

export async function runModel(
	mode: ModelMode,
	input: string | undefined,
	options: ModelCliOptions,
	json: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({
		json,
		stdoutArtifact: options.stdout === true,
	});
	try {
		const outcome = await runModelRequest({
			mode,
			inputPath: input,
			spec: fileRef(options.spec),
			operations: fileRef(options.operations),
			binding: fileRef(options.binding),
			packPath: options.pack,
			vanillaPath: options.vanilla,
			dependencyPaths: options.dependency,
			minecraftVersion: options.minecraftVersion,
			resourcePackVersion: options.resourcePackVersion,
			outputPath: options.output,
			itemOutputPath: options.itemOutput,
			blockstateOutputPath: options.blockstateOutput,
			textureOutputDir: options.textures,
			texturePaths: textureOption(options.texture),
			size: options.size === undefined ? undefined : Number(options.size),
			view: options.view,
			viewDirection: options.viewDirection,
			display: options.display,
			lighting: options.lighting,
			tint: options.tint,
			tints:
				options.tints === undefined
					? undefined
					: parseTintsDocument(options.tints),
			stdout: options.stdout,
			force: options.force,
			mkdir: options.mkdir,
			requireOutput: true,
		});
		if (outcome.artifact !== undefined) {
			emitArtifact(outcome.artifact, streams, route);
		}
		if (outcome.failed && "verdict" in outcome.result) {
			const report = outcome.result;
			const message = failureSummary(report);
			if (json) {
				emitEnvelope(
					errorEnvelope("VALIDATION_FAILED", message, undefined, report),
					streams,
					route,
				);
			} else {
				emitLog(
					`${reportLines(report).join("\n")}\nerror [VALIDATION_FAILED] ${message}`,
					streams,
					route,
				);
			}
			return exitCodeForError("VALIDATION_FAILED");
		}
		if (json) {
			emitEnvelope(successEnvelope(outcome.result), streams, route);
		} else if ("mode" in outcome.result && outcome.result.mode === "preview") {
			emitLog(reportLines(outcome.result).join("\n"), streams, route);
		} else if (
			outcome.result.mode === "import-bbmodel" ||
			outcome.result.mode === "export-bbmodel"
		) {
			emitLog(bbmodelLines(outcome.result).join("\n"), streams, route);
		} else if ("verdict" in outcome.result) {
			emitLog(reportLines(outcome.result).join("\n"), streams, route);
		} else {
			emitLog(editLines(outcome.result).join("\n"), streams, route);
		}
		return 0;
	} catch (error) {
		if (error instanceof McAssetError) {
			const message = stripCodePrefix(error.message);
			if (json) {
				emitEnvelope(
					errorEnvelope(error.code, message, error.details),
					streams,
					route,
				);
			} else {
				emitLog(`error [${error.code}] ${message}`, streams, route);
			}
			return exitCodeForMcAssetError(error);
		}
		const message = error instanceof Error ? error.message : String(error);
		if (json) {
			emitEnvelope(errorEnvelope("INTERNAL_ERROR", message), streams, route);
		} else {
			emitLog(`error [INTERNAL_ERROR] ${message}`, streams, route);
		}
		return 1;
	}
}
