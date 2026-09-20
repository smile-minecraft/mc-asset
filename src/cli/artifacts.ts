import { readFile, realpath, stat } from "node:fs/promises";
import {
	basename,
	dirname,
	join as joinPath,
	resolve as resolvePath,
} from "node:path";
import process from "node:process";
import { applyOperations, type BatchReport } from "../core/batch.ts";
import { createAuthoringPalette } from "../core/canvas.ts";
import { McAssetError } from "../core/errors.ts";
import type { PixelCanvas } from "../core/types.ts";
import {
	assignSymbols,
	collectCanvasColors,
	type McpxWarning,
	serializeMcpx,
} from "../mcpx/index.ts";
import {
	emitEnvelope,
	emitLog,
	type OutputStreams,
	type StreamRoute,
} from "./channels.ts";
import { errorEnvelope, successEnvelope } from "./envelope.ts";
import { exitCodeForMcAssetError } from "./exit.ts";
import { type AtomicWriteSeams, atomicWriteFile } from "./filesystem.ts";
import { parseOperationsJson } from "./operations-json.ts";

/**
 * Shared write-command pipeline (§57/§58/§98): stdin intake, batch apply,
 * palette assignment before serialize, guarded multi-target writes, and
 * one success/failure emission shape for import, render, and build.
 */

export type WriteCommandName =
	| "import"
	| "render"
	| "build"
	| "transform"
	| "quantize"
	| "cleanup"
	| "recolor";

export interface WarningNote {
	code: string;
	message: string;
}

export interface CommandResult {
	command: WriteCommandName;
	profile: string;
	applied: number;
	operations: BatchReport["operations"];
	warnings: WarningNote[];
	output?: string | undefined;
	source?: string | undefined;
	stdout?: true | undefined;
	/** Command-specific report fields (quantize colors, cleanup counts, ...). */
	details?: Record<string, unknown> | undefined;
}

function stripCodePrefix(message: string): string {
	return message.replace(/^\[[A-Z0-9_]+\] /, "");
}

/**
 * Atomic-batch failure wrapper: carries the §103 rollback summary so the
 * failure envelope can attach it as `result` while the error code stays
 * the original cause (never TRANSACTION_FAILED on this path).
 */
export class BatchFailedError extends McAssetError {
	readonly batchResult: { applied: number; rolledBack: boolean };

	constructor(cause: McAssetError) {
		super(cause.code, stripCodePrefix(cause.message), cause.details);
		this.batchResult = { applied: 0, rolledBack: true };
	}
}

/** Stdin is consumed as raw bytes; nothing is ever staged in a temp file. */
export async function readStdinBytes(): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of process.stdin) {
		const bytes =
			chunk instanceof Uint8Array
				? chunk
				: new TextEncoder().encode(String(chunk));
		chunks.push(bytes);
		total += bytes.length;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const bytes of chunks) {
		out.set(bytes, offset);
		offset += bytes.length;
	}
	return out;
}

export function decodeUtf8(bytes: Uint8Array): string {
	return new TextDecoder("utf-8").decode(bytes);
}

export async function readInputFile(
	path: string,
	what: string,
): Promise<Uint8Array> {
	try {
		return new Uint8Array(await readFile(path));
	} catch {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Cannot read ${what}: ${path}.`,
			{
				path,
			},
		);
	}
}

export async function readInputText(
	path: string,
	what: string,
): Promise<string> {
	return decodeUtf8(await readInputFile(path, what));
}

export async function readOperationsText(ref: string): Promise<string> {
	if (ref === "-") {
		return decodeUtf8(await readStdinBytes());
	}
	return readInputText(ref, "operations file");
}

/** Positional input unified with --input; passing two different paths is a conflict. */
export function resolveInputPath(
	positional: string | undefined,
	inputOpt: string | undefined,
	what: string,
): string {
	const pos =
		positional === undefined || positional === "" ? undefined : positional;
	const opt = inputOpt === undefined || inputOpt === "" ? undefined : inputOpt;
	if (pos === undefined && opt === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`${what} needs a file path argument.`,
		);
	}
	if (pos !== undefined && opt !== undefined && pos !== opt) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			"Positional input and --input disagree; pass one.",
		);
	}
	return (pos ?? opt) as string;
}

/** Sole-layer canvases (import, render, single-layer build) back a missing layerId. */
export function defaultLayerFor(canvas: PixelCanvas): string | undefined {
	if (canvas.layers.length === 1) {
		return (canvas.layers[0] as { id: string }).id;
	}
	return undefined;
}

export function applyBatchText(
	canvas: PixelCanvas,
	text: string,
	defaultLayerId: string | undefined,
): BatchReport {
	const operations = parseOperationsJson(text, defaultLayerId);
	try {
		return applyOperations(canvas, operations);
	} catch (error) {
		if (error instanceof McAssetError) {
			throw new BatchFailedError(error);
		}
		throw error;
	}
}

/**
 * Assign fresh symbols for colors the canvas uses but its palette does not
 * name yet, attach the completed palette, then serialize. Existing symbols
 * keep their assignment verbatim; overflow reports MCPX_PALETTE_OVERFLOW.
 */
export function ensureMcpxText(
	canvas: PixelCanvas,
	onWarning: (warning: McpxWarning) => void,
): string {
	const existing = (canvas.palette?.entries ?? []).map((entry) => ({
		...entry,
	}));
	const assigned = assignSymbols(existing, collectCanvasColors(canvas));
	canvas.palette = createAuthoringPalette(assigned);
	return serializeMcpx(canvas, { onWarning });
}

export interface ArtifactRequest {
	command: WriteCommandName;
	output?: string | undefined;
	stdout?: boolean | undefined;
	source?: string | undefined;
	force?: boolean | undefined;
	inPlace?: boolean | undefined;
	inputPath?: string | undefined;
}

export interface FileTarget {
	path: string;
	force: boolean;
}

export interface ResolvedArtifacts {
	pngStdout: boolean;
	pngFiles: FileTarget[];
	mcpxFiles: FileTarget[];
}

/**
 * Output resolution across the two artifacts (PNG bytes, .mcpx source).
 * --output/--stdout carry PNG; --source carries .mcpx; --in-place rewrites
 * the file input (PNG for import/render, .mcpx for build) and implies
 * force for that target only. No target at all is OUTPUT_REQUIRED.
 *
 * Same-path and relative/absolute/dot-segment aliases are refused here as
 * ARGUMENT_CONFLICT unless the target comes from an explicit --in-place.
 * Case-only and Unicode NFC/NFD equivalences fold into the same identity
 * (see foldIdentity), so they are refused here too. Symlink aliases need
 * the filesystem, so the async preflight below re-checks with canonical
 * keys; the sync check here is never weaker than a no-op (it only throws
 * on provably identical normalized paths).
 */
export function resolveArtifactTargets(
	request: ArtifactRequest,
): ResolvedArtifacts {
	if (request.force === true && request.inPlace === true) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			"--force and --in-place must not be combined.",
		);
	}
	if (
		request.inPlace === true &&
		(request.inputPath === undefined || request.inputPath === "")
	) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"--in-place needs a file input; stdin input cannot be rewritten in place.",
		);
	}
	const pngFiles: FileTarget[] = [];
	const mcpxFiles: FileTarget[] = [];
	if (request.output !== undefined && request.output !== "") {
		pngFiles.push({ path: request.output, force: request.force === true });
	}
	if (request.source !== undefined && request.source !== "") {
		mcpxFiles.push({ path: request.source, force: request.force === true });
	}
	if (request.inPlace === true) {
		const target = request.inputPath as string;
		if (request.command === "build") {
			mcpxFiles.push({ path: target, force: true });
		} else {
			pngFiles.push({ path: target, force: true });
		}
	}
	const pngStdout = request.stdout === true;
	if (!pngStdout && pngFiles.length === 0 && mcpxFiles.length === 0) {
		throw new McAssetError(
			"OUTPUT_REQUIRED",
			"One of --output, --stdout, --source, or --in-place is required.",
		);
	}
	assertNoNormalizedAlias(request.inputPath, request.inPlace, [
		...pngFiles,
		...mcpxFiles,
	]);
	assertNoNormalizedDuplicate([...pngFiles, ...mcpxFiles]);
	return { pngStdout, pngFiles, mcpxFiles };
}

/** Normalized (symlink-blind) identity: catches literal, absolute, and dot-segment aliases. */
function normalizedKey(path: string): string {
	return foldIdentity(resolvePath(path));
}

/**
 * Cross-platform target identity. The full normalized absolute path is
 * folded with Unicode NFC plus en-US case folding, so `case.png` vs
 * `CASE.png` and NFC vs NFD spellings compare equal on every platform.
 * This is deliberately conservative: on a case-sensitive filesystem two
 * confusingly equivalent names are refused rather than risking one
 * artifact silently overwriting the other on a case-insensitive or
 * normalization-insensitive volume (macOS defaults). Safety here never
 * depends on detecting the volume's actual sensitivity.
 */
function foldIdentity(value: string): string {
	return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function assertNoNormalizedAlias(
	inputPath: string | undefined,
	inPlace: boolean | undefined,
	targets: FileTarget[],
): void {
	if (inPlace === true || inputPath === undefined || inputPath === "") {
		return;
	}
	const inputKey = normalizedKey(inputPath);
	for (const target of targets) {
		if (normalizedKey(target.path) === inputKey) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				`Output aliases the input: ${target.path}. Pass --in-place to rewrite it.`,
			);
		}
	}
}

function assertNoNormalizedDuplicate(targets: FileTarget[]): void {
	const seen = new Map<string, string>();
	for (const target of targets) {
		const key = normalizedKey(target.path);
		const prior = seen.get(key);
		if (prior !== undefined) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				`Duplicate output target: ${target.path} aliases ${prior}; each target may be written once.`,
			);
		}
		seen.set(key, target.path);
	}
}

/** Minecraft profiles export PNG only (§34); the gate covers explicit --output paths. */
export function assertMinecraftOutputPath(profile: string, path: string): void {
	if (
		(profile === "minecraft:item" ||
			profile === "minecraft:block" ||
			profile === "minecraft:gui" ||
			profile === "minecraft:particle") &&
		!path.toLowerCase().endsWith(".png")
	) {
		throw new McAssetError(
			"UNSUPPORTED_MINECRAFT_TEXTURE_FORMAT",
			`Profile ${profile} exports PNG only; refusing ${path}.`,
			{ path, profile },
		);
	}
}

async function targetExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export interface ArtifactPayload {
	targets: FileTarget[];
	data: Uint8Array | string;
}

/**
 * Canonical identity without requiring the target to exist: the target
 * itself when it resolves, otherwise the nearest existing ancestor with
 * the missing segments re-appended. A failed resolve never skips the
 * check; it falls back to the normalized absolute path. Every form is
 * folded (see foldIdentity) so case and Unicode equivalences match.
 */
async function canonicalKey(path: string): Promise<string> {
	try {
		return foldIdentity(await realpath(path));
	} catch {
		// Target (or an ancestor) is missing: anchor on what does exist.
	}
	const absolute = resolvePath(path);
	let dir = dirname(absolute);
	const below: string[] = [basename(absolute)];
	for (;;) {
		try {
			const realDir = await realpath(dir);
			return foldIdentity(joinPath(realDir, ...below));
		} catch {
			const parent = dirname(dir);
			if (parent === dir) {
				return foldIdentity(absolute);
			}
			below.unshift(basename(dir));
			dir = parent;
		}
	}
}

export interface PreflightOptions {
	inputPath?: string | undefined;
	inPlace?: boolean | undefined;
	mkdir?: boolean | undefined;
}

async function preflightTargetsExistence(
	targets: FileTarget[],
	mkdir: boolean | undefined,
): Promise<void> {
	for (const target of targets) {
		if (target.path === "") {
			throw new McAssetError("INVALID_ARGUMENT", "Output path is empty.");
		}
		if (!target.force && (await targetExists(target.path))) {
			throw new McAssetError(
				"OUTPUT_EXISTS",
				`Output exists: ${target.path}. Pass --force to overwrite.`,
			);
		}
		const parent = dirname(target.path);
		if (!(await targetExists(parent)) && mkdir !== true) {
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Parent directory is missing: ${parent}. Pass --mkdir to create it.`,
			);
		}
	}
}

/**
 * Full preflight for the command layer: symlink-aware alias/duplicate
 * checks plus the union existence/parent gate. Callers MUST run this
 * before emitting any stdout artifact bytes, so a conflicting file
 * target keeps stdout at zero bytes. Checks that fail here throw the
 * same codes the write phase would (ARGUMENT_CONFLICT, OUTPUT_EXISTS,
 * FILESYSTEM_ERROR); races between this preflight and the writes stay
 * best-effort (TOCTOU) and are re-checked per file on the write path.
 */
export async function preflightArtifactTargets(
	resolved: ResolvedArtifacts,
	options: PreflightOptions = {},
): Promise<void> {
	const all = [...resolved.pngFiles, ...resolved.mcpxFiles];
	const keys = await Promise.all(
		all.map((target) => canonicalKey(target.path)),
	);
	if (
		options.inPlace !== true &&
		options.inputPath !== undefined &&
		options.inputPath !== ""
	) {
		const inputKey = await canonicalKey(options.inputPath);
		for (let index = 0; index < all.length; index += 1) {
			if (keys[index] === inputKey) {
				throw new McAssetError(
					"ARGUMENT_CONFLICT",
					`Output aliases the input: ${(all[index] as FileTarget).path}. Pass --in-place to rewrite it.`,
				);
			}
		}
	}
	const seen = new Map<string, string>();
	for (let index = 0; index < all.length; index += 1) {
		const key = keys[index] as string;
		const prior = seen.get(key);
		const label = (all[index] as FileTarget).path;
		if (prior !== undefined) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				`Duplicate output target: ${label} aliases ${prior}; each target may be written once.`,
			);
		}
		seen.set(key, label);
	}
	await preflightTargetsExistence(all, options.mkdir);
}

/** Failure details carry the per-file atomic outcome (never all-or-nothing). */
function withCompleted(
	error: unknown,
	completed: string[],
	failedTarget: string,
): McAssetError {
	const done = [...completed];
	if (error instanceof McAssetError) {
		const extra =
			typeof error.details === "object" &&
			error.details !== null &&
			!Array.isArray(error.details)
				? { ...(error.details as Record<string, unknown>) }
				: {};
		return new McAssetError(
			error.code,
			error.message.replace(/^\[[A-Z0-9_]+\] /, ""),
			{ ...extra, completed: done, failedTarget },
		);
	}
	return new McAssetError(
		"FILESYSTEM_ERROR",
		`Cannot write output: ${failedTarget}.`,
		{ completed: done, failedTarget },
	);
}

/**
 * Guarded writes: every non-force target is existence-checked before the
 * first byte lands anywhere, so an OUTPUT_EXISTS refusal writes nothing.
 * The atomic rename and --mkdir handling stay inside atomicWriteFile.
 */
export async function writeFileTargets(
	targets: FileTarget[],
	data: Uint8Array | string,
	mkdir: boolean | undefined,
): Promise<void> {
	await writeArtifactPayloads([{ targets, data }], mkdir);
}

/**
 * Guarded multi-artifact writes (§98.2/§98.4): targets across PNG and .mcpx
 * are existence-checked as one union before the first byte lands anywhere,
 * so refusing one artifact never leaves the other behind. Callers MUST pass
 * every file target of the command through this single call.
 *
 * Once writes start the semantics are per-file atomic, explicitly NOT
 * all-or-nothing: a later target that fails leaves earlier commits in
 * place, and the thrown error reports them in `details.completed` with
 * the failing path in `details.failedTarget`.
 */
export async function writeArtifactPayloads(
	payloads: ArtifactPayload[],
	mkdir: boolean | undefined,
	seams: AtomicWriteSeams = {},
): Promise<void> {
	const all = payloads.flatMap((payload) => payload.targets);
	await preflightTargetsExistence(all, mkdir);
	const completed: string[] = [];
	try {
		for (const payload of payloads) {
			for (const target of payload.targets) {
				if (target.path === "") {
					throw new McAssetError("INVALID_ARGUMENT", "Output path is empty.");
				}
				await atomicWriteFile(
					target.path,
					payload.data,
					{
						force: target.force,
						mkdir,
					},
					undefined,
					seams,
				);
				completed.push(target.path);
			}
		}
	} catch (error) {
		const failed = payloads
			.flatMap((payload) => payload.targets)
			.map((target) => target.path)
			.find((path) => !completed.includes(path));
		throw withCompleted(error, completed, failed ?? "(unknown target)");
	}
}

export function emitCommandSuccess(
	streams: OutputStreams,
	route: StreamRoute,
	globalJson: boolean,
	result: CommandResult,
): void {
	if (globalJson) {
		// Command-specific fields ride flat beside the frozen V0.1 keys so
		// agents read result.colors / result.detected without unwrapping.
		// V0.1 callers pass no details and emit exactly the old shape.
		const { details, ...rest } = result;
		emitEnvelope(successEnvelope({ ...rest, ...details }), streams, route);
		return;
	}
	const parts = [
		`ok ${result.command} profile=${result.profile} applied=${result.applied}`,
	];
	if (result.output !== undefined) {
		parts.push(`output=${result.output}`);
	}
	if (result.source !== undefined) {
		parts.push(`source=${result.source}`);
	}
	if (result.stdout === true) {
		parts.push("stdout=true");
	}
	emitLog(parts.join(" "), streams, route);
	for (const warning of result.warnings) {
		emitLog(`warning [${warning.code}] ${warning.message}`, streams, route);
	}
}

export function emitCommandFailure(
	streams: OutputStreams,
	route: StreamRoute,
	globalJson: boolean,
	error: unknown,
): number {
	let code: McAssetError["code"] | "INTERNAL_ERROR" = "INTERNAL_ERROR";
	let message = "Unknown failure.";
	let details: unknown;
	let result: unknown;
	let exitCode = 1;
	if (error instanceof BatchFailedError) {
		code = error.code;
		message = stripCodePrefix(error.message);
		details = error.details;
		result = error.batchResult;
		exitCode = exitCodeForMcAssetError(error);
	} else if (error instanceof McAssetError) {
		code = error.code;
		message = stripCodePrefix(error.message);
		details = error.details;
		exitCode = exitCodeForMcAssetError(error);
	} else if (error instanceof Error) {
		message = error.message;
	} else {
		message = String(error);
	}
	if (globalJson) {
		emitEnvelope(errorEnvelope(code, message, details, result), streams, route);
	} else {
		emitLog(`error [${code}] ${message}`, streams, route);
	}
	return exitCode;
}
