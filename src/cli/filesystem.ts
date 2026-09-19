import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import process from "node:process";
import { McAssetError } from "../core/errors.ts";

export interface AtomicWriteOptions {
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
}

export type RawWriteFile = (
	path: string,
	data: string | Uint8Array,
) => Promise<void>;

const defaultWriteFile: RawWriteFile = (path, data) => writeFile(path, data);

let tempCounter = 0;

function nextTempPath(dir: string, base: string): string {
	tempCounter += 1;
	const pid = typeof process.pid === "number" ? process.pid : 0;
	return `${dir}/.tmp-${pid}-${tempCounter}-${base}`;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Atomic file output per section 98.4: pre-check OUTPUT_EXISTS (not one
 * byte written on refusal), optional --mkdir for parents, same-directory
 * temp plus rename, temp cleanup on every failure path.
 */
export async function atomicWriteFile(
	targetPath: string,
	data: string | Uint8Array,
	options: AtomicWriteOptions,
	writeFileFn: RawWriteFile = defaultWriteFile,
): Promise<void> {
	if (targetPath === "") {
		throw new McAssetError("INVALID_ARGUMENT", "Output path is empty.");
	}
	if ((await pathExists(targetPath)) && options.force !== true) {
		throw new McAssetError(
			"OUTPUT_EXISTS",
			`Output exists: ${targetPath}. Pass --force to overwrite.`,
		);
	}
	const parent = dirname(targetPath);
	if (!(await pathExists(parent))) {
		if (options.mkdir !== true) {
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Parent directory is missing: ${parent}. Pass --mkdir to create it.`,
			);
		}
		try {
			await mkdir(parent, { recursive: true });
		} catch {
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Cannot create parent directory: ${parent}.`,
			);
		}
	}
	const tempPath = nextTempPath(parent, basename(targetPath));
	try {
		await writeFileFn(tempPath, data);
		await rename(tempPath, targetPath);
	} catch (error) {
		try {
			await unlink(tempPath);
		} catch {
			// Temp cleanup is best-effort; the original failure decides the code.
		}
		if (error instanceof McAssetError) {
			throw error;
		}
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Cannot write output: ${targetPath}.`,
		);
	}
}
