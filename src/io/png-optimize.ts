import { McAssetError } from "../core/errors.ts";
import {
	DEFLATE_ENGINE_ID,
	type DeflateStrategy,
	isExactZlibStream,
} from "./deflate.ts";
import { decodePng, flattenCanvas } from "./png.ts";
import {
	assemblePng,
	compressScanlines,
	encodeIhdr,
	type PngChunk,
	type PngFilterStrategy,
} from "./png-chunks.ts";
import {
	analyzePixels,
	buildModeEncoding,
	type ModeEncoding,
	type ModeUnavailableReason,
	PNG_COLOR_MODE_ORDER,
	type PngColorMode,
} from "./png-modes.ts";
import {
	type AncillaryPolicy,
	type PngSourcePlan,
	planPngSource,
} from "./png-source.ts";

export type OptimizeMode = "auto" | PngColorMode;

/**
 * optimized  auto mode found a strictly smaller file.
 * unchanged  auto mode found nothing strictly smaller; bytes are the source verbatim.
 * converted  a forced mode ran; bytes are that encoding even when larger than the source.
 */
export type OptimizeStatus = "optimized" | "unchanged" | "converted";

export interface OptimizePngOptions {
	/** Default "auto". */
	readonly mode?: OptimizeMode;
	/** Default "preserve". */
	readonly ancillary?: AncillaryPolicy;
}

export interface OptimizeCandidateReport {
	readonly mode: PngColorMode;
	readonly applicable: boolean;
	readonly unavailableReason?: ModeUnavailableReason;
	/** Full file size including preserved chunks; absent when not applicable or not evaluated. */
	readonly bytes?: number;
	readonly bitDepth?: 1 | 2 | 4 | 8;
	readonly colorType?: 0 | 2 | 3 | 4 | 6;
	readonly paletteSize?: number;
	readonly filter?: PngFilterStrategy;
	readonly strategy?: DeflateStrategy;
	/** True for exactly the candidate whose bytes became the output (never true when unchanged). */
	readonly selected: boolean;
}

export interface OptimizePngReport {
	readonly status: OptimizeStatus;
	readonly mode: OptimizeMode;
	readonly ancillary: AncillaryPolicy;
	readonly engine: string; // DEFLATE_ENGINE_ID
	readonly effort: "maximum";
	readonly source: {
		readonly bytes: number;
		readonly width: number;
		readonly height: number;
		readonly bitDepth: 1 | 2 | 4 | 8;
		readonly colorType: 0 | 2 | 3 | 4 | 6;
		readonly interlaced: boolean;
	};
	readonly result: {
		readonly bytes: number;
		readonly mode: PngColorMode | "source";
		readonly bitDepth: 1 | 2 | 4 | 8;
		readonly colorType: 0 | 2 | 3 | 4 | 6;
		readonly paletteSize: number;
	};
	readonly savedBytes: number;
	readonly savedPermille: number;
	readonly candidates: readonly OptimizeCandidateReport[];
	readonly preservedChunks: readonly string[];
	readonly strippedChunks: readonly string[];
	/** True when the source was Adam7 interlaced and the output is not. */
	readonly interlaceRemoved: boolean;
	readonly warnings: readonly {
		readonly code: string;
		readonly message: string;
	}[];
}

export interface OptimizePngResult {
	readonly bytes: Uint8Array;
	readonly report: OptimizePngReport;
}

interface EncodedCandidate {
	readonly bytes: Uint8Array;
	readonly encoding: ModeEncoding;
	readonly filter: PngFilterStrategy;
	readonly strategy: DeflateStrategy;
}

interface DecodedSource {
	readonly pixels: Uint8Array;
	readonly warnings: readonly {
		readonly code: string;
		readonly message: string;
	}[];
}

interface SourceImageInfo {
	readonly width: number;
	readonly height: number;
	readonly bitDepth: 1 | 2 | 4 | 8;
	readonly colorType: 0 | 2 | 3 | 4 | 6;
	readonly interlaced: boolean;
}

const ADAM7_PASSES = [
	[0, 0, 8, 8],
	[4, 0, 8, 8],
	[0, 4, 4, 8],
	[2, 0, 4, 4],
	[0, 2, 2, 4],
	[1, 0, 2, 2],
	[0, 1, 1, 2],
] as const;

function expectedScanlineLength(info: SourceImageInfo): number {
	const channels =
		info.colorType === 0 || info.colorType === 3
			? 1
			: info.colorType === 2
				? 3
				: info.colorType === 4
					? 2
					: 4;
	const bitsPerPixel = channels * info.bitDepth;
	if (!info.interlaced)
		return info.height * (Math.ceil((info.width * bitsPerPixel) / 8) + 1);

	let length = 0;
	for (const [startX, startY, stepX, stepY] of ADAM7_PASSES) {
		const width = Math.max(0, Math.ceil((info.width - startX) / stepX));
		const height = Math.max(0, Math.ceil((info.height - startY) / stepY));
		if (width > 0 && height > 0)
			length += height * (Math.ceil((width * bitsPerPixel) / 8) + 1);
	}
	return length;
}

function verifyImageData(input: Uint8Array, info: SourceImageInfo): void {
	let offset = 8;
	const compressedParts: Uint8Array[] = [];
	let compressedLength = 0;
	while (offset + 12 <= input.length) {
		const length =
			(input[offset] as number) * 0x1000000 +
			((input[offset + 1] as number) << 16) +
			((input[offset + 2] as number) << 8) +
			(input[offset + 3] as number);
		if (length > input.length - offset - 12) break;
		const type = String.fromCharCode(
			input[offset + 4] as number,
			input[offset + 5] as number,
			input[offset + 6] as number,
			input[offset + 7] as number,
		);
		if (type === "IDAT") {
			compressedLength += length;
			compressedParts.push(input.subarray(offset + 8, offset + 8 + length));
		}
		offset += length + 12;
	}
	if (compressedLength === 0) throw new Error("PNG image data is empty.");
	const compressed = new Uint8Array(compressedLength);
	let compressedOffset = 0;
	for (const part of compressedParts) {
		compressed.set(part, compressedOffset);
		compressedOffset += part.length;
	}
	if (!isExactZlibStream(compressed, expectedScanlineLength(info)))
		throw new Error("PNG image data length or zlib stream is invalid.");
}

function decodeSource(input: Uint8Array, info: SourceImageInfo): DecodedSource {
	try {
		const decoded = decodePng(input);
		const pixels = flattenCanvas(decoded.canvas);
		verifyImageData(input, info);
		return {
			pixels,
			warnings: decoded.warnings,
		};
	} catch (error) {
		if (
			error instanceof McAssetError &&
			(error.code === "INVALID_DIMENSION" ||
				error.code === "RESOURCE_LIMIT_EXCEEDED")
		)
			throw error;
		throw new McAssetError(
			"UNSUPPORTED_IMAGE_FORMAT",
			"PNG pixels could not be decoded.",
			{ reason: "decode-failed" },
		);
	}
}

function buildChunks(
	plan: PngSourcePlan,
	encoding: ModeEncoding,
	compressed: ReturnType<typeof compressScanlines>,
): PngChunk[] {
	const chunks: PngChunk[] = [
		{
			type: "IHDR",
			data: encodeIhdr(
				plan.info.width,
				plan.info.height,
				encoding.bitDepth,
				encoding.colorType,
			),
		},
	];
	for (const chunk of plan.preserved)
		if (chunk.segment === "before-plte")
			chunks.push({ type: chunk.type, data: chunk.data });
	if (encoding.plte !== undefined)
		chunks.push({ type: "PLTE", data: encoding.plte });
	if (encoding.trns !== undefined)
		chunks.push({ type: "tRNS", data: encoding.trns });
	for (const chunk of plan.preserved)
		if (chunk.segment === "after-plte")
			chunks.push({ type: chunk.type, data: chunk.data });
	chunks.push({ type: "IDAT", data: compressed.idat });
	for (const chunk of plan.preserved)
		if (chunk.segment === "after-idat")
			chunks.push({ type: chunk.type, data: chunk.data });
	chunks.push({ type: "IEND", data: new Uint8Array(0) });
	return chunks;
}

function encodeCandidate(
	plan: PngSourcePlan,
	pixels: Uint8Array,
	mode: PngColorMode,
	analysis: ReturnType<typeof analyzePixels>,
): EncodedCandidate | undefined {
	const result = buildModeEncoding(mode, pixels, analysis);
	if (!result.ok) return undefined;
	const encoding = result.encoding;
	const compressed = compressScanlines(
		encoding.raw,
		encoding.rowBytes,
		plan.info.height,
		encoding.bytesPerPixel,
		encoding.bitDepth,
		encoding.colorType,
		"maximum",
	);
	return {
		bytes: assemblePng(buildChunks(plan, encoding, compressed)),
		encoding,
		filter: compressed.trial.filter,
		strategy: compressed.trial.strategy,
	};
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1)
		if (left[index] !== right[index]) return false;
	return true;
}

function sourcePaletteSize(input: Uint8Array, plan: PngSourcePlan): number {
	if (plan.info.colorType !== 3) return 0;
	let offset = 8;
	while (offset + 12 <= input.length) {
		const length =
			(input[offset] as number) * 0x1000000 +
			((input[offset + 1] as number) << 16) +
			((input[offset + 2] as number) << 8) +
			(input[offset + 3] as number);
		const type = String.fromCharCode(
			input[offset + 4] as number,
			input[offset + 5] as number,
			input[offset + 6] as number,
			input[offset + 7] as number,
		);
		if (type === "PLTE") return length / 3;
		offset += length + 12;
	}
	return 0;
}

function unavailableReport(
	mode: PngColorMode,
	reason: ModeUnavailableReason,
): OptimizeCandidateReport {
	return {
		mode,
		applicable: false,
		unavailableReason: reason,
		selected: false,
	};
}

function candidateReport(
	mode: PngColorMode,
	candidate: EncodedCandidate,
	selected: boolean,
): OptimizeCandidateReport {
	return {
		mode,
		applicable: true,
		bytes: candidate.bytes.length,
		bitDepth: candidate.encoding.bitDepth,
		colorType: candidate.encoding.colorType,
		paletteSize: candidate.encoding.paletteSize,
		filter: candidate.filter,
		strategy: candidate.strategy,
		selected,
	};
}

function unavailableReason(
	mode: PngColorMode,
	analysis: ReturnType<typeof analyzePixels>,
): ModeUnavailableReason | undefined {
	if (mode === "rgb" && !analysis.opaque) return "not-opaque";
	if (mode === "grayscale" && !analysis.opaque) return "not-opaque";
	if ((mode === "grayscale" || mode === "grayscale-alpha") && !analysis.gray)
		return "not-gray";
	if (mode === "indexed" && analysis.distinctColors > 256)
		return "more-than-256-colors";
	return undefined;
}

function samePixelsOrThrow(expected: Uint8Array, actual: Uint8Array): void {
	if (equalBytes(expected, actual)) return;
	throw new McAssetError(
		"INTERNAL_ERROR",
		"PNG optimizer self-check found changed pixels.",
		{ stage: "self-check" },
	);
}

/**
 * Synchronous, pure, and deterministic. Flow: planPngSource -> decodePng(source) -> analyzePixels
 * -> candidates in PNG_COLOR_MODE_ORDER -> pick (rules in the spec) -> self-check: decodePng(output)
 * must equal decodePng(source) byte for byte, else throw INTERNAL_ERROR and return nothing.
 * Throws OPTIMIZE_MODE_NOT_EXACT when a forced mode cannot represent the pixels exactly.
 * The input buffer is never written.
 */
export function optimizePng(
	input: Uint8Array,
	options?: OptimizePngOptions,
): OptimizePngResult {
	const mode = options?.mode ?? "auto";
	const ancillary = options?.ancillary ?? "preserve";
	const plan = planPngSource(input, ancillary);
	const decoded = decodeSource(input, plan.info);
	const pixels = decoded.pixels;
	const analysis = analyzePixels(pixels, plan.info.width, plan.info.height);
	const modes = mode === "auto" ? PNG_COLOR_MODE_ORDER : [mode];
	const candidates: OptimizeCandidateReport[] = [];
	let best:
		| { readonly mode: PngColorMode; readonly candidate: EncodedCandidate }
		| undefined;

	for (const candidateMode of modes) {
		const reason = unavailableReason(candidateMode, analysis);
		if (reason !== undefined) {
			if (mode !== "auto") {
				const details: Record<string, unknown> = { mode, reason };
				if (reason === "more-than-256-colors")
					details.distinctColors = analysis.distinctColors;
				throw new McAssetError(
					"OPTIMIZE_MODE_NOT_EXACT",
					`Mode ${mode} cannot exactly represent these pixels.`,
					details,
				);
			}
			candidates.push(unavailableReport(candidateMode, reason));
			continue;
		}

		const candidate = encodeCandidate(plan, pixels, candidateMode, analysis);
		if (candidate === undefined) {
			if (mode !== "auto") {
				throw new McAssetError(
					"OPTIMIZE_MODE_NOT_EXACT",
					`Mode ${mode} cannot exactly represent these pixels.`,
					{
						mode,
						reason: "more-than-256-colors",
						distinctColors: analysis.distinctColors,
					},
				);
			}
			candidates.push(unavailableReport(candidateMode, "more-than-256-colors"));
			continue;
		}
		const selected = mode !== "auto";
		candidates.push(candidateReport(candidateMode, candidate, selected));
		if (mode !== "auto") {
			best = { mode: candidateMode, candidate };
		} else if (
			best === undefined ||
			candidate.bytes.length < best.candidate.bytes.length
		) {
			best = { mode: candidateMode, candidate };
			const bestIndex = candidates.length - 1;
			for (let index = 0; index < bestIndex; index += 1) {
				const earlier = candidates[index] as OptimizeCandidateReport;
				if (earlier.selected)
					candidates[index] = { ...earlier, selected: false };
			}
			candidates[bestIndex] = {
				...(candidates[bestIndex] as OptimizeCandidateReport),
				selected: true,
			};
		}
	}

	if (
		best !== undefined &&
		best.candidate.bytes.length >= input.length &&
		mode === "auto"
	) {
		best = undefined;
		for (let index = 0; index < candidates.length; index += 1) {
			const candidate = candidates[index] as OptimizeCandidateReport;
			if (candidate.selected)
				candidates[index] = { ...candidate, selected: false };
		}
	}

	const output = best?.candidate.bytes ?? input.slice();
	const status: OptimizeStatus =
		mode === "auto"
			? best === undefined
				? "unchanged"
				: "optimized"
			: "converted";
	const resultMode = best?.mode ?? "source";
	const resultBitDepth =
		best?.candidate.encoding.bitDepth ?? plan.info.bitDepth;
	const resultColorType =
		best?.candidate.encoding.colorType ?? plan.info.colorType;
	const resultPaletteSize =
		best?.candidate.encoding.paletteSize ?? sourcePaletteSize(input, plan);
	const checked = decodeSource(output, {
		width: plan.info.width,
		height: plan.info.height,
		bitDepth: resultBitDepth,
		colorType: resultColorType,
		// A kept source is still laid out as the source was; every candidate is non-interlaced.
		interlaced: best === undefined ? plan.info.interlaced : false,
	});
	samePixelsOrThrow(pixels, checked.pixels);

	const savedBytes = input.length - output.length;
	const report: OptimizePngReport = {
		status,
		mode,
		ancillary,
		engine: DEFLATE_ENGINE_ID,
		effort: "maximum",
		source: {
			bytes: input.length,
			width: plan.info.width,
			height: plan.info.height,
			bitDepth: plan.info.bitDepth,
			colorType: plan.info.colorType,
			interlaced: plan.info.interlaced,
		},
		result: {
			bytes: output.length,
			mode: resultMode,
			bitDepth: resultBitDepth,
			colorType: resultColorType,
			paletteSize: resultPaletteSize,
		},
		savedBytes,
		savedPermille: Math.trunc((savedBytes * 1000) / input.length),
		candidates,
		preservedChunks: plan.preserved.map((chunk) => chunk.type),
		strippedChunks: [...plan.stripped],
		interlaceRemoved: plan.info.interlaced && best !== undefined,
		warnings: decoded.warnings,
	};
	return { bytes: output, report };
}
