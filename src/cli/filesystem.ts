import { randomBytes } from "node:crypto";
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

/** Exclusive temp creation (O_EXCL): a pre-existing temp is never truncated. */
const defaultWriteFile: RawWriteFile = (path, data) =>
	writeFile(path, data, { flag: "wx" });

export interface AtomicWriteSeams {
	writeExclusive?: RawWriteFile | undefined;
	renameFile?:
		| ((oldPath: string, newPath: string) => Promise<void>)
		| undefined;
	unlinkFile?: ((path: string) => Promise<void>) | undefined;
	randomSuffix?: (() => string) | undefined;
}

let tempCounter = 0;

function defaultRandomSuffix(): string {
	return randomBytes(8).toString("hex");
}

function nextTempPath(dir: string, base: string, suffix: string): string {
	tempCounter += 1;
	const pid = typeof process.pid === "number" ? process.pid : 0;
	return `${dir}/.tmp-${pid}-${tempCounter}-${suffix}-${base}`;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function isExistsError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: unknown }).code === "EEXIST"
	);
}

const MAX_TEMP_ATTEMPTS = 5;

/**
 * Atomic file output per section 98.4: pre-check OUTPUT_EXISTS (not one
 * byte written on refusal), optional --mkdir for parents, same-directory
 * temp plus rename, temp cleanup on every failure path.
 *
 * The temp file is created exclusively (O_EXCL via the `wx` flag), so two
 * writers racing on one target never share a temp; the loser retries with
 * a fresh name. The name carries pid, a counter, and a cryptographic
 * suffix, so it is never determined by a fixed counter alone. Cleanup is
 * ownership-bound: a temp is only ever unlinked when this call created it
 * (successful exclusive create, later rename failure). A collided name
 * (EEXIST) belongs to someone else and is never unlinked. Concurrent
 * writers to one target are last-writer-wins at the rename; the union
 * preflight in artifacts.ts is best-effort against that race (TOCTOU).
 */
export async function atomicWriteFile(
	targetPath: string,
	data: string | Uint8Array,
	options: AtomicWriteOptions,
	writeFileFn: RawWriteFile = defaultWriteFile,
	seams: AtomicWriteSeams = {},
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
	const writeExclusive = seams.writeExclusive ?? writeFileFn;
	const renameFile = seams.renameFile ?? rename;
	const unlinkFile = seams.unlinkFile ?? unlink;
	const randomSuffix = seams.randomSuffix ?? defaultRandomSuffix;
	let tempPath = "";
	for (let attempt = 1; attempt <= MAX_TEMP_ATTEMPTS; attempt += 1) {
		tempPath = nextTempPath(parent, basename(targetPath), randomSuffix());
		try {
			await writeExclusive(tempPath, data);
			break;
		} catch (error) {
			if (isExistsError(error)) {
				// The name is taken by someone else (a concurrent writer or a
				// leftover): this call created nothing, so it must unlink
				// nothing. Retry with a fresh name, or fail on exhaustion.
				if (attempt < MAX_TEMP_ATTEMPTS) {
					continue;
				}
				throw new McAssetError(
					"FILESYSTEM_ERROR",
					`Cannot write output: ${targetPath}.`,
				);
			}
			// Any other exclusive-create failure stages nothing foreign: a
			// pre-existing file would have surfaced as EEXIST under O_EXCL,
			// so the path is either absent or a partial of our own making.
			// Best-effort removal keeps failed writes residue-free.
			try {
				await unlinkFile(tempPath);
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
	try {
		await renameFile(tempPath, targetPath);
	} catch (error) {
		try {
			await unlinkFile(tempPath);
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
