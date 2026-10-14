import { readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { z } from "zod";
import { exitCodeForError, McAssetError } from "../core/errors.ts";
import {
	modelBindingSchema,
	modelOperationSchema,
	modelSpecSchema,
} from "../mcp/schema.ts";
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
	inspectModel,
	type ModelCoverage,
	type ModelInspectReport,
	type ModelValidateReport,
	validateModel,
} from "../model/inspect.ts";
import { MODEL_LIMITS } from "../model/limits.ts";
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
	writePlannedTargets,
} from "./safe-output.ts";
import {
	type ResolvedVersionTarget,
	resolveVersionTarget,
} from "./version-options.ts";

export type ModelMode = "inspect" | "validate" | "create" | "apply" | "export";

export interface ModelCliOptions {
	pack?: string | undefined;
	vanilla?: string | undefined;
	dependency?: string[] | undefined;
	minecraftVersion?: string | undefined;
	resourcePackVersion?: string | undefined;
	spec?: string | undefined; // path or "-"
	operations?: string | undefined; // path or "-"
	binding?: string | undefined; // path or "-"
	output?: string | undefined;
	stdout?: boolean | undefined;
	itemOutput?: string | undefined;
	blockstateOutput?: string | undefined;
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
	| ModelEditOutput;

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
	readonly outputPath?: string | undefined;
	readonly itemOutputPath?: string | undefined;
	readonly blockstateOutputPath?: string | undefined;
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
		"outputPath",
		"itemOutputPath",
		"blockstateOutputPath",
		"stdout",
	],
	validate: [
		"spec",
		"operations",
		"binding",
		"outputPath",
		"itemOutputPath",
		"blockstateOutputPath",
		"stdout",
	],
	create: [
		"inputPath",
		"operations",
		"binding",
		"packPath",
		"vanillaPath",
		"dependencyPaths",
		"itemOutputPath",
		"blockstateOutputPath",
	],
	apply: [
		"spec",
		"binding",
		"packPath",
		"vanillaPath",
		"dependencyPaths",
		"itemOutputPath",
		"blockstateOutputPath",
	],
	export: ["spec", "operations", "vanillaPath", "dependencyPaths", "stdout"],
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
	return paths;
}

function requireInput(request: ModelRequest): string {
	if (request.inputPath === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`${request.mode} needs a model file.`,
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

function decodeUtf8(bytes: Uint8Array, label: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new McAssetError(
			"MODEL_INVALID_JSON",
			`${label} is not valid UTF-8.`,
			{ reason: "encoding" },
		);
	}
}

async function readModelText(path: string): Promise<string> {
	return decodeUtf8(await readBoundedFile(path, "Model"), "Model");
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

function modelTargets(
	path: string | undefined,
	force: boolean,
): OutputTarget[] {
	return path === undefined
		? []
		: [{ path, extension: ".json", allowOverwrite: force }];
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
	}
}

function coverageLine(coverage: ModelCoverage): string {
	if (coverage.status === "complete") return "coverage: complete";
	return `coverage: partial (${coverage.skipped.length} skipped)`;
}

function reportLines(
	report: ModelInspectReport | ModelValidateReport,
): string[] {
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
