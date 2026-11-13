/**
 * Frame intake for the particle generator: one directory of `.png` / `.mcpx`
 * files, or one `.png` / `.mcpx` file. Directory entries are read in UTF-8
 * byte order and every other entry is reported as a warning, never silently
 * dropped. Decoding keeps PNG pixels verbatim and parses `.mcpx` through the
 * editable-source parser; encoding happens later in the pure planner.
 */

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

export interface LoadedParticleFrames {
	readonly inputPath: string;
	readonly inputKind: "directory" | "file";
	/** Byte-ordered frames. */
	readonly frames: readonly ParticleFrame[];
	readonly warnings: readonly ParticleWarning[];
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

async function decodeFrame(
	path: string,
	name: string,
): Promise<{ frame: ParticleFrame; warnings: ParticleWarning[] }> {
	if (frameFormat(name) === "png") {
		const decoded = decodePng(await readFrameBytes(path));
		return {
			frame: { name, canvas: decoded.canvas },
			warnings: decoded.warnings.map((warning) => ({
				code: warning.code,
				message: `${name}: ${warning.message}`,
			})),
		};
	}
	const bytes = await readFrameBytes(path);
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
		frame: { name, canvas: parseMcpx(text) },
		warnings: [],
	};
}

async function loadDirectory(inputPath: string): Promise<LoadedParticleFrames> {
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
	const frames: ParticleFrame[] = [];
	for (const name of names) {
		const decoded = await decodeFrame(join(inputPath, name), name);
		frames.push(decoded.frame);
		warnings.push(...decoded.warnings);
	}
	return { inputPath, inputKind: "directory", frames, warnings };
}

/**
 * Load frames from a directory or a single file. A missing path is
 * FILESYSTEM_ERROR; a directory with no frames is INVALID_ANIMATION_FRAME; a
 * single file with another extension is INVALID_ARGUMENT.
 */
export async function loadParticleFrames(
	inputPath: string,
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
		return loadDirectory(inputPath);
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
	return {
		inputPath,
		inputKind: "file",
		frames: [decoded.frame],
		warnings: decoded.warnings,
	};
}
