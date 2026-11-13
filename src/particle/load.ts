/**
 * Frame intake for the particle generator: one directory of `.png` / `.mcpx`
 * files, or one `.png` / `.mcpx` file. Directory entries are read in UTF-8
 * byte order and every other entry is reported as a warning, never silently
 * dropped. Decoding keeps PNG pixels verbatim and parses `.mcpx` through the
 * editable-source parser; encoding happens later in the pure planner.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { McAssetError } from "../core/errors.ts";
import { decodePng } from "../io/png.ts";
import { parseMcpx } from "../mcpx/index.ts";
import { compareFrameNames, type ParticleFrame } from "./index.ts";

/** A non-fatal intake note, shaped like every other command warning. */
export interface ParticleWarning {
	readonly code: string;
	readonly message: string;
}

/**
 * A decoded frame plus the hash of the exact bytes it was decoded from. The
 * hash travels with the frame so a pack build records the input it actually
 * decoded instead of reading the source file a second time.
 */
export interface LoadedParticleFrame extends ParticleFrame {
	readonly sourceSha256: string;
}

export interface LoadedParticleFrames {
	readonly inputPath: string;
	readonly inputKind: "directory" | "file";
	/** Path of every frame file that was read; never writable, even with force. */
	readonly inputFiles: readonly string[];
	/** Byte-ordered frames. */
	readonly frames: readonly LoadedParticleFrame[];
	/** Total bytes of the frame files that were read. */
	readonly sourceBytes: number;
	/** Width times height over every decoded frame. */
	readonly decodedPixels: number;
	readonly warnings: readonly ParticleWarning[];
}

export interface ParticleFrameLoadOptions {
	/**
	 * Refuse as soon as the decoded frames pass this many pixels. The pack
	 * build passes its public decode budget so a directory of large frames
	 * stops while reading instead of filling memory first.
	 */
	readonly maxDecodedPixels?: number | undefined;
}

function frameFormat(name: string): "png" | "mcpx" | undefined {
	const lower = name.toLowerCase();
	if (lower.endsWith(".png")) {
		return "png";
	}
	if (lower.endsWith(".mcpx")) {
		return "mcpx";
	}
	return undefined;
}

async function readFrameBytes(path: string): Promise<Uint8Array> {
	try {
		return new Uint8Array(await readFile(path));
	} catch {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Cannot read frame input: ${path}.`,
			{
				path,
			},
		);
	}
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function decodeFrame(
	path: string,
	name: string,
): Promise<{
	frame: LoadedParticleFrame;
	warnings: ParticleWarning[];
	sourceBytes: number;
}> {
	const bytes = await readFrameBytes(path);
	const sourceSha256 = sha256Hex(bytes);
	if (frameFormat(name) === "png") {
		const decoded = decodePng(bytes);
		return {
			frame: { name, canvas: decoded.canvas, sourceSha256 },
			warnings: decoded.warnings.map((warning) => ({
				code: warning.code,
				message: `${name}: ${warning.message}`,
			})),
			sourceBytes: bytes.length,
		};
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new McAssetError(
			"MCPX_SYNTAX_ERROR",
			`Frame is not valid UTF-8: ${path}.`,
			{ path },
		);
	}
	return {
		frame: { name, canvas: parseMcpx(text), sourceSha256 },
		warnings: [],
		sourceBytes: bytes.length,
	};
}

function assertDecodedPixels(
	decodedPixels: number,
	maxDecodedPixels: number | undefined,
): void {
	if (maxDecodedPixels !== undefined && decodedPixels > maxDecodedPixels) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			`Particle frames decode to ${decodedPixels} pixels, over the budget of ${maxDecodedPixels}.`,
			{ limit: maxDecodedPixels, actual: decodedPixels },
		);
	}
}

async function loadDirectory(
	inputPath: string,
	options: ParticleFrameLoadOptions,
): Promise<LoadedParticleFrames> {
	let entries: Array<{ name: string; isFile(): boolean }>;
	try {
		entries = await readdir(inputPath, { withFileTypes: true });
	} catch {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Cannot read frames directory: ${inputPath}.`,
			{ path: inputPath },
		);
	}
	const names: string[] = [];
	const ignored: string[] = [];
	for (const entry of entries) {
		if (entry.isFile() && frameFormat(entry.name) !== undefined) {
			names.push(entry.name);
		} else {
			ignored.push(entry.name);
		}
	}
	names.sort(compareFrameNames);
	ignored.sort(compareFrameNames);
	const warnings: ParticleWarning[] = ignored.map((name) => ({
		code: "NON_FRAME_IGNORED",
		message: `Ignoring non-frame entry: ${name}.`,
	}));
	if (names.length === 0) {
		throw new McAssetError(
			"INVALID_ANIMATION_FRAME",
			`Frames directory holds no .png or .mcpx frames: ${inputPath}.`,
			{ path: inputPath, count: 0 },
		);
	}
	const frames: LoadedParticleFrame[] = [];
	const inputFiles: string[] = [];
	let sourceBytes = 0;
	let decodedPixels = 0;
	for (const name of names) {
		const framePath = join(inputPath, name);
		const decoded = await decodeFrame(framePath, name);
		frames.push(decoded.frame);
		inputFiles.push(framePath);
		warnings.push(...decoded.warnings);
		sourceBytes += decoded.sourceBytes;
		decodedPixels += decoded.frame.canvas.width * decoded.frame.canvas.height;
		assertDecodedPixels(decodedPixels, options.maxDecodedPixels);
	}
	return {
		inputPath,
		inputKind: "directory",
		inputFiles,
		frames,
		sourceBytes,
		decodedPixels,
		warnings,
	};
}

/**
 * Load frames from a directory or a single file. A missing path is
 * FILESYSTEM_ERROR; a directory with no frames is INVALID_ANIMATION_FRAME; a
 * single file with another extension is INVALID_ARGUMENT.
 */
export async function loadParticleFrames(
	inputPath: string,
	options: ParticleFrameLoadOptions = {},
): Promise<LoadedParticleFrames> {
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(inputPath);
	} catch {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Cannot read frame input: ${inputPath}.`,
			{
				path: inputPath,
			},
		);
	}
	if (info.isDirectory()) {
		return loadDirectory(inputPath, options);
	}
	if (!info.isFile()) {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Frame input is not a file or directory: ${inputPath}.`,
			{ path: inputPath },
		);
	}
	const name = basename(inputPath);
	if (frameFormat(name) === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Particle input must be a directory, .png, or .mcpx file: ${inputPath}.`,
			{ path: inputPath },
		);
	}
	const decoded = await decodeFrame(inputPath, name);
	const decodedPixels =
		decoded.frame.canvas.width * decoded.frame.canvas.height;
	assertDecodedPixels(decodedPixels, options.maxDecodedPixels);
	return {
		inputPath,
		inputKind: "file",
		inputFiles: [inputPath],
		frames: [decoded.frame],
		sourceBytes: decoded.sourceBytes,
		decodedPixels,
		warnings: decoded.warnings,
	};
}
