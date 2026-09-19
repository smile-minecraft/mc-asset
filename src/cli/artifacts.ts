import { readFile, stat } from "node:fs/promises";
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
import { atomicWriteFile } from "./filesystem.ts";
import { parseOperationsJson } from "./operations-json.ts";

/**
 * Shared write-command pipeline (§57/§58/§98): stdin intake, batch apply,
 * palette assignment before serialize, guarded multi-target writes, and
 * one success/failure emission shape for import, render, and build.
 */

export type WriteCommandName = "import" | "render" | "build";

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
	return { pngStdout, pngFiles, mcpxFiles };
}

/** Minecraft profiles export PNG only (§34); the gate covers explicit --output paths. */
export function assertMinecraftOutputPath(profile: string, path: string): void {
	if (
		(profile === "minecraft:item" || profile === "minecraft:block") &&
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
 */
export async function writeArtifactPayloads(
	payloads: ArtifactPayload[],
	mkdir: boolean | undefined,
): Promise<void> {
	for (const payload of payloads) {
		for (const target of payload.targets) {
			if (target.path === "") {
				throw new McAssetError("INVALID_ARGUMENT", "Output path is empty.");
			}
			if (!target.force && (await targetExists(target.path))) {
				throw new McAssetError(
					"OUTPUT_EXISTS",
					`Output exists: ${target.path}. Pass --force to overwrite.`,
				);
			}
		}
	}
	for (const payload of payloads) {
		for (const target of payload.targets) {
			await atomicWriteFile(target.path, payload.data, {
				force: target.force,
				mkdir,
			});
		}
	}
}

export function emitCommandSuccess(
	streams: OutputStreams,
	route: StreamRoute,
	globalJson: boolean,
	result: CommandResult,
): void {
	if (globalJson) {
		emitEnvelope(successEnvelope(result), streams, route);
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
