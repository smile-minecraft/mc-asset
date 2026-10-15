import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { McAssetError } from "../core/errors.ts";
import { DEFLATE_ENGINE_ID } from "../io/deflate.ts";
import {
	type OptimizeCandidateReport,
	type OptimizeMode,
	type OptimizePngReport,
	optimizePng,
} from "../io/png-optimize.ts";
import { type AncillaryPolicy, PNG_SOURCE_LIMITS } from "../io/png-source.ts";
import { OPTIMIZE_MODES } from "../mcp/schema.ts";
import {
	emitArtifact,
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { errorEnvelope, successEnvelope } from "./envelope.ts";
import { exitCodeForMcAssetError } from "./exit.ts";
import type { AtomicWriteSeams } from "./filesystem.ts";
import {
	assertDisjointDirectories,
	checkDecodedPixelsLimit,
	checkSourceBytesLimit,
	type OptimizeDirSeams,
	scanPngDirectory,
} from "./optimize-dir.ts";
import {
	canonicalKey,
	type OutputTarget,
	type PlannedTarget,
	planOutputTargets,
	writePlannedTargets,
} from "./safe-output.ts";

export interface OptimizeCliOptions {
	inputDir?: string | undefined;
	recursive?: boolean | undefined;
	output?: string | undefined;
	outputDir?: string | undefined;
	stdout?: boolean | undefined;
	dryRun?: boolean | undefined;
	mode?: string | undefined;
	ancillary?: string | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
	seams?: OptimizeDirSeams | undefined;
	atomicSeams?: AtomicWriteSeams | undefined;
}

/** Most explicit inputs one call accepts; more is RESOURCE_LIMIT_EXCEEDED. */
const MAX_INPUTS = 256;

export interface OptimizeCandidate {
	readonly mode: string;
	readonly applicable: boolean;
	readonly unavailableReason?: string;
	readonly bytes?: number;
	readonly selected: boolean;
}

export interface OptimizeFileResult {
	readonly input: string;
	/** null for dry runs, stdout and embedded results. */
	readonly output: string | null;
	readonly status: "optimized" | "unchanged" | "converted";
	readonly source: {
		readonly bytes: number;
		readonly width: number;
		readonly height: number;
		readonly bitDepth: number;
		readonly colorType: number;
		readonly interlaced: boolean;
	};
	readonly result: {
		readonly bytes: number;
		readonly mode: string;
		readonly bitDepth: number;
		readonly colorType: number;
		readonly paletteSize: number;
	};
	readonly savedBytes: number;
	readonly savedPermille: number;
	readonly candidates: readonly OptimizeCandidate[];
	readonly preservedChunks: readonly string[];
	readonly strippedChunks: readonly string[];
	readonly interlaceRemoved: boolean;
	readonly warnings: readonly {
		readonly code: string;
		readonly message: string;
	}[];
}

export interface OptimizeTotals {
	readonly files: number;
	readonly sourceBytes: number;
	readonly resultBytes: number;
	readonly savedBytes: number;
	readonly optimized: number;
	readonly unchanged: number;
	readonly converted: number;
}

/** Shared result of the CLI (--json envelope) and the MCP tool. */
export interface OptimizeResult {
	readonly command: "optimize";
	readonly dryRun: boolean;
	readonly mode: string;
	readonly ancillary: string;
	readonly engine: string;
	readonly files: readonly OptimizeFileResult[];
	readonly totals: OptimizeTotals;
	/** MCP only, single input without outputPath/outputDir/dryRun: the PNG bytes. */
	readonly pngBase64?: string;
}

/** Where the optimized bytes go. Exactly one destination per request. */
export type OptimizeDestination =
	| { readonly kind: "dry-run" }
	| { readonly kind: "stdout" }
	| { readonly kind: "embed" }
	| { readonly kind: "file"; readonly output: string }
	| { readonly kind: "dir"; readonly dir: string };

export interface OptimizeRequest {
	readonly inputs?: readonly string[] | undefined;
	readonly inputDir?: string | undefined;
	readonly recursive?: boolean | undefined;
	readonly mode?: string | undefined;
	readonly ancillary?: string | undefined;
	readonly destination: OptimizeDestination;
	readonly force: boolean;
	readonly mkdir: boolean;
	readonly seams?: OptimizeDirSeams | undefined;
	readonly atomicSeams?: AtomicWriteSeams | undefined;
}

export interface OptimizeOutcome {
	readonly result: OptimizeResult;
	/** Single-input bytes for the stdout and embed destinations. */
	readonly artifact?: Uint8Array | undefined;
}

interface ComputedInput {
	readonly input: string;
	readonly bytes: Uint8Array;
	readonly report: OptimizePngReport;
}

/**
 * A batch input failed while computing. Nothing is written; the details carry
 * the failing input and what was processed before it.
 */
export class OptimizeBatchError extends McAssetError {}

function stripCodePrefix(message: string): string {
	return message.replace(/^\[[A-Z_]+\] /, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestedMode(raw: string | undefined): OptimizeMode {
	const mode = raw ?? "auto";
	if (!(OPTIMIZE_MODES as readonly string[]).includes(mode)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Unknown optimize mode "${mode}". Use one of ${OPTIMIZE_MODES.join(", ")}.`,
		);
	}
	return mode as OptimizeMode;
}

function requestedAncillary(raw: string | undefined): AncillaryPolicy {
	const policy = raw ?? "preserve";
	if (policy !== "preserve" && policy !== "strip") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Unknown ancillary policy "${policy}". Use preserve or strip.`,
		);
	}
	return policy;
}

function checkArity(destination: OptimizeDestination, count: number): void {
	if (count === 1) return;
	if (destination.kind === "embed") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Several inputs need outputDir, or dryRun set to true.",
		);
	}
	if (destination.kind === "file" || destination.kind === "stdout") {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			"A single output takes exactly one input.",
		);
	}
}

async function checkDistinctInputs(inputs: readonly string[]): Promise<void> {
	const keys = await Promise.all(inputs.map((input) => canonicalKey(input)));
	const seen = new Set<string>();
	for (const [index, key] of keys.entries()) {
		if (seen.has(key)) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				`Input is listed twice: ${inputs[index] ?? ""}.`,
			);
		}
		seen.add(key);
	}
}

function outputTargets(
	destination: OptimizeDestination,
	inputs: readonly string[],
	force: boolean,
): OutputTarget[] {
	if (destination.kind === "file") {
		return [
			{ path: destination.output, extension: ".png", allowOverwrite: force },
		];
	}
	if (destination.kind === "dir") {
		return inputs.map((input) => ({
			path: join(destination.dir, basename(input)),
			extension: ".png",
			allowOverwrite: force,
		}));
	}
	return [];
}

async function readInput(input: string): Promise<Uint8Array> {
	let size: number;
	try {
		size = (await stat(input)).size;
	} catch {
		throw new McAssetError("FILESYSTEM_ERROR", `Cannot read input: ${input}.`);
	}
	if (size > PNG_SOURCE_LIMITS.maxInputBytes) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			`Input exceeds ${PNG_SOURCE_LIMITS.maxInputBytes} bytes: ${input}.`,
			{ limit: PNG_SOURCE_LIMITS.maxInputBytes, actual: size },
		);
	}
	try {
		return new Uint8Array(await readFile(input));
	} catch {
		throw new McAssetError("FILESYSTEM_ERROR", `Cannot read input: ${input}.`);
	}
}

function batchFailure(
	error: unknown,
	input: string,
	processed: readonly string[],
	notProcessed: readonly string[],
): OptimizeBatchError {
	const cause = error instanceof McAssetError ? error : undefined;
	const causeDetails: Record<string, unknown> =
		cause !== undefined && isRecord(cause.details) ? cause.details : {};
	const message =
		cause === undefined
			? error instanceof Error
				? error.message
				: String(error)
			: stripCodePrefix(cause.message);
	return new OptimizeBatchError(cause?.code ?? "INTERNAL_ERROR", message, {
		...causeDetails,
		input,
		processed,
		notProcessed,
	});
}

/** Computes every input in memory. The first failure stops the batch. */
async function computeInputs(
	inputs: readonly string[],
	mode: OptimizeMode,
	ancillary: AncillaryPolicy,
): Promise<ComputedInput[]> {
	const done: ComputedInput[] = [];
	for (const [index, input] of inputs.entries()) {
		try {
			const optimized = optimizePng(await readInput(input), {
				mode,
				ancillary,
			});
			done.push({
				input,
				bytes: optimized.bytes,
				report: optimized.report,
			});
		} catch (error) {
			throw batchFailure(
				error,
				input,
				done.map((item) => item.input),
				inputs.slice(index + 1),
			);
		}
	}
	return done;
}

function toCandidate(candidate: OptimizeCandidateReport): OptimizeCandidate {
	const applicable = candidate.unavailableReason === undefined;
	return {
		mode: candidate.mode,
		applicable,
		...(candidate.unavailableReason === undefined
			? {}
			: { unavailableReason: candidate.unavailableReason }),
		...(candidate.bytes === undefined ? {} : { bytes: candidate.bytes }),
		selected: candidate.selected,
	};
}

function fileResultOf(
	item: ComputedInput,
	output: string | null,
): OptimizeFileResult {
	const report = item.report;
	return {
		input: item.input,
		output,
		status: report.status,
		source: {
			bytes: report.source.bytes,
			width: report.source.width,
			height: report.source.height,
			bitDepth: report.source.bitDepth,
			colorType: report.source.colorType,
			interlaced: report.source.interlaced,
		},
		result: {
			bytes: report.result.bytes,
			mode: report.result.mode,
			bitDepth: report.result.bitDepth,
			colorType: report.result.colorType,
			paletteSize: report.result.paletteSize,
		},
		savedBytes: report.savedBytes,
		savedPermille: report.savedPermille,
		candidates: report.candidates.map(toCandidate),
		preservedChunks: [...report.preservedChunks],
		strippedChunks: [...report.strippedChunks],
		interlaceRemoved: report.interlaceRemoved,
		warnings: report.warnings.map((warning) => ({
			code: warning.code,
			message: warning.message,
		})),
	};
}

function sumOf(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

function totalsOf(files: readonly OptimizeFileResult[]): OptimizeTotals {
	const countOf = (status: OptimizeFileResult["status"]): number =>
		files.filter((file) => file.status === status).length;
	return {
		files: files.length,
		sourceBytes: sumOf(files.map((file) => file.source.bytes)),
		resultBytes: sumOf(files.map((file) => file.result.bytes)),
		savedBytes: sumOf(files.map((file) => file.savedBytes)),
		optimized: countOf("optimized"),
		unchanged: countOf("unchanged"),
		converted: countOf("converted"),
	};
}

/** The result a batch failure reports: nothing was written, so no file is listed. */
function emptyResult(request: OptimizeRequest): OptimizeResult {
	return {
		command: "optimize",
		dryRun: request.destination.kind === "dry-run",
		mode: requestedMode(request.mode),
		ancillary: requestedAncillary(request.ancillary),
		engine: DEFLATE_ENGINE_ID,
		files: [],
		totals: totalsOf([]),
	};
}

/**
 * Shared optimize pipeline for the CLI and the MCP tool. Phases: path checks
 * (planOutputTargets, read-only), in-memory computation of every input, then
 * the write phase. Nothing is written unless every input computed.
 */
export async function runOptimizeRequest(
	request: OptimizeRequest,
): Promise<OptimizeOutcome> {
	const mode = requestedMode(request.mode);
	const ancillary = requestedAncillary(request.ancillary);
	const { inputs, inputDir, destination } = request;

	if (inputs !== undefined && inputs.length > 0 && inputDir !== undefined) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			"Give inputs or inputDir, not both.",
		);
	}
	if ((inputs === undefined || inputs.length === 0) && inputDir === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"optimize needs at least one input or --input-dir.",
		);
	}
	if (inputDir === undefined && request.recursive === true) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			"--recursive requires inputDir.",
		);
	}

	if (inputDir !== undefined) {
		if (destination.kind === "file" || destination.kind === "stdout") {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				"Directory mode does not accept single-file output or stdout.",
			);
		}
		if (destination.kind === "embed") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"Directory mode requires outputDir, or dryRun set to true.",
			);
		}
		if (destination.kind === "dir") {
			await assertDisjointDirectories(inputDir, destination.dir);
		}

		const entries = await scanPngDirectory(
			inputDir,
			request.recursive ?? false,
			request.seams,
		);

		let totalBytes = 0;
		for (const entry of entries) {
			let size: number;
			if (entry.size !== undefined) {
				size = entry.size;
			} else if (request.seams?.statFile !== undefined) {
				const s = await request.seams.statFile(entry.fullPath);
				size = s.size;
			} else {
				try {
					size = (await stat(entry.fullPath)).size;
				} catch {
					throw new McAssetError(
						"FILESYSTEM_ERROR",
						`Cannot read input: ${entry.fullPath}.`,
					);
				}
			}
			if (size > PNG_SOURCE_LIMITS.maxInputBytes) {
				throw new McAssetError(
					"RESOURCE_LIMIT_EXCEEDED",
					`Input exceeds ${PNG_SOURCE_LIMITS.maxInputBytes} bytes: ${entry.fullPath}.`,
					{ limit: PNG_SOURCE_LIMITS.maxInputBytes, actual: size },
				);
			}
			totalBytes += size;
			checkSourceBytesLimit(totalBytes);
		}

		let totalDecodedPixels = 0;
		const computed: ComputedInput[] = [];
		for (const [index, entry] of entries.entries()) {
			try {
				const bytes = await readInput(entry.fullPath);
				if (request.seams?.getPixelDimensions !== undefined) {
					const dims = request.seams.getPixelDimensions(entry.fullPath, bytes);
					totalDecodedPixels += dims.width * dims.height;
					checkDecodedPixelsLimit(totalDecodedPixels);
				}
				const optimized = optimizePng(bytes, {
					mode,
					ancillary,
				});
				if (request.seams?.getPixelDimensions === undefined) {
					totalDecodedPixels +=
						optimized.report.source.width * optimized.report.source.height;
					checkDecodedPixelsLimit(totalDecodedPixels);
				}
				computed.push({
					input: entry.fullPath,
					bytes: optimized.bytes,
					report: optimized.report,
				});
			} catch (error) {
				throw batchFailure(
					error,
					entry.fullPath,
					computed.map((item) => item.input),
					entries.slice(index + 1).map((e) => e.fullPath),
				);
			}
		}

		let planned: readonly PlannedTarget[] = [];
		if (destination.kind === "dir") {
			const targets: OutputTarget[] = entries.map((entry) => ({
				path: join(destination.dir, entry.relativePath),
				extension: ".png",
				allowOverwrite: request.force,
			}));
			const inputPaths = entries.map((e) => e.fullPath);
			planned = await planOutputTargets(targets, {
				inputs: inputPaths,
				mkdir: request.mkdir,
			});
		}

		if (destination.kind === "dry-run") {
			const files = computed.map((item) => fileResultOf(item, null));
			return {
				result: {
					command: "optimize",
					dryRun: true,
					mode,
					ancillary,
					engine: computed[0]?.report.engine ?? DEFLATE_ENGINE_ID,
					files,
					totals: totalsOf(files),
				},
			};
		}

		const payloads = new Map<string, Uint8Array>();
		const files = computed.map((item, index) => {
			const target: PlannedTarget | undefined = planned[index];
			if (target !== undefined) payloads.set(target.path, item.bytes);
			return fileResultOf(item, target?.path ?? null);
		});
		await writePlannedTargets(
			planned,
			payloads,
			{ mkdir: request.mkdir },
			request.atomicSeams,
		);

		return {
			result: {
				command: "optimize",
				dryRun: false,
				mode,
				ancillary,
				engine: computed[0]?.report.engine ?? DEFLATE_ENGINE_ID,
				files,
				totals: totalsOf(files),
			},
		};
	}

	const explicitInputs = inputs ?? [];
	if (explicitInputs.length > MAX_INPUTS) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			`optimize takes at most ${MAX_INPUTS} inputs.`,
			{ limit: MAX_INPUTS, actual: explicitInputs.length },
		);
	}
	checkArity(destination, explicitInputs.length);
	await checkDistinctInputs(explicitInputs);
	const planned = await planOutputTargets(
		outputTargets(destination, explicitInputs, request.force),
		{ inputs: explicitInputs, mkdir: request.mkdir },
	);
	const computed = await computeInputs(explicitInputs, mode, ancillary);

	const payloads = new Map<string, Uint8Array>();
	const files = computed.map((item, index) => {
		const target: PlannedTarget | undefined = planned[index];
		if (target !== undefined) payloads.set(target.path, item.bytes);
		return fileResultOf(item, target?.path ?? null);
	});
	if (planned.length > 0) {
		await writePlannedTargets(
			planned,
			payloads,
			{ mkdir: request.mkdir },
			request.atomicSeams,
		);
	}

	const single = computed[0];
	const artifact =
		destination.kind === "stdout" || destination.kind === "embed"
			? single?.bytes
			: undefined;
	return {
		result: {
			command: "optimize",
			dryRun: destination.kind === "dry-run",
			mode,
			ancillary,
			engine: single?.report.engine ?? DEFLATE_ENGINE_ID,
			files,
			totals: totalsOf(files),
		},
		artifact,
	};
}

function cliDestination(options: OptimizeCliOptions): OptimizeDestination {
	if (options.inputDir !== undefined) {
		if (options.output !== undefined || options.stdout === true) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				"Directory mode does not accept --output or --stdout. Use --output-dir or --dry-run.",
			);
		}
		if (options.outputDir === undefined && options.dryRun !== true) {
			throw new McAssetError(
				"OUTPUT_REQUIRED",
				"Directory mode requires --output-dir or --dry-run.",
			);
		}
		if (options.outputDir !== undefined && options.dryRun === true) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				"Use only one of --output-dir or --dry-run.",
			);
		}
		if (options.outputDir !== undefined) {
			return { kind: "dir", dir: options.outputDir };
		}
		return { kind: "dry-run" };
	}

	const chosen = [
		options.output !== undefined,
		options.outputDir !== undefined,
		options.stdout === true,
		options.dryRun === true,
	].filter(Boolean).length;
	if (chosen === 0) {
		throw new McAssetError(
			"OUTPUT_REQUIRED",
			"One of --output, --output-dir, --stdout, or --dry-run is required.",
		);
	}
	if (chosen > 1) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			"Use only one of --output, --output-dir, --stdout, or --dry-run.",
		);
	}
	if (options.output !== undefined) {
		return { kind: "file", output: options.output };
	}
	if (options.outputDir !== undefined) {
		return { kind: "dir", dir: options.outputDir };
	}
	if (options.stdout === true) return { kind: "stdout" };
	return { kind: "dry-run" };
}

function describeFile(file: OptimizeFileResult): string {
	return `ok optimize input=${file.input} output=${file.output ?? "-"} status=${file.status} source=${file.source.bytes} result=${file.result.bytes} mode=${file.result.mode}`;
}

export async function runOptimize(
	inputs: readonly string[],
	options: OptimizeCliOptions,
	json: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({
		json,
		stdoutArtifact: options.stdout === true,
	});
	let request: OptimizeRequest | undefined;
	try {
		if (inputs.length > 0 && options.inputDir !== undefined) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				"Give positional inputs or --input-dir, not both.",
			);
		}
		if (inputs.length === 0 && options.inputDir === undefined) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"optimize needs at least one input or --input-dir.",
			);
		}
		if (options.inputDir === undefined && options.recursive === true) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				"--recursive requires --input-dir.",
			);
		}

		request = {
			inputs: inputs.length > 0 ? inputs : undefined,
			inputDir: options.inputDir,
			recursive: options.recursive === true,
			mode: options.mode,
			ancillary: options.ancillary,
			destination: cliDestination(options),
			force: options.force === true,
			mkdir: options.mkdir === true,
			seams: options.seams,
			atomicSeams: options.atomicSeams,
		};
		const outcome = await runOptimizeRequest(request);
		if (outcome.artifact !== undefined) {
			emitArtifact(outcome.artifact, streams, route);
		}
		for (const file of outcome.result.files) {
			emitLog(describeFile(file), streams, route);
			for (const warning of file.warnings) {
				emitLog(`warning [${warning.code}] ${warning.message}`, streams, route);
			}
		}
		if (json) {
			emitEnvelope(successEnvelope(outcome.result), streams, route);
		}
		return 0;
	} catch (error) {
		if (error instanceof McAssetError) {
			const message = stripCodePrefix(error.message);
			if (json) {
				const summary =
					error instanceof OptimizeBatchError && request !== undefined
						? emptyResult(request)
						: undefined;
				emitEnvelope(
					errorEnvelope(error.code, message, error.details, summary),
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
