import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFile } from "../cli/filesystem.ts";
import { McAssetError } from "../core/errors.ts";
import {
	assertZipEntryBudget,
	inflateZipEntry,
	parseZipArchive,
} from "../io/zip-read.ts";

/**
 * Client jar extraction: copy `assets/` entries out of a caller-specified
 * jar into an output directory. Path traversal and absolute entries
 * refuse with PACK_ARCHIVE_INVALID before any byte is written.
 */

export interface ExtractOptions {
	readonly jarPath: string;
	readonly outputDir: string;
	readonly force?: boolean | undefined;
	readonly mkdir?: boolean | undefined;
}

export interface ExtractReport {
	readonly fileCount: number;
	readonly totalBytes: number;
}

/** Entry budget for one extraction run. */
export const EXTRACT_ENTRY_LIMIT = 100000;

/** Decompressed byte budget for one extraction run (256 MiB). */
export const EXTRACT_BYTES_LIMIT = 268435456;

/** Extract a jar; traversal and unsafe entries refuse before any write. */
export async function extractVanillaJar(
	options: ExtractOptions,
): Promise<ExtractReport> {
	const jarPath = options.jarPath;
	let jarBytes: Uint8Array;
	try {
		jarBytes = new Uint8Array(await readFile(jarPath));
	} catch {
		throw new McAssetError(
			"PACK_ARCHIVE_INVALID",
			`Cannot read client jar: ${jarPath}.`,
			{ jarPath },
		);
	}
	const archive = parseZipArchive(jarBytes);
	assertZipEntryBudget(archive.entries.length, EXTRACT_ENTRY_LIMIT);
	const wanted = archive.entries.filter((entry) =>
		entry.name.startsWith("assets/"),
	);
	let totalBytes = 0;
	const payloads = new Map<string, Uint8Array>();
	for (const entry of wanted) {
		if (entry.name.endsWith("/")) {
			continue;
		}
		const payload = inflateZipEntry(archive, entry);
		totalBytes += payload.length;
		if (totalBytes > EXTRACT_BYTES_LIMIT) {
			throw new McAssetError(
				"RESOURCE_LIMIT_EXCEEDED",
				`Extracted bytes exceed the limit of ${EXTRACT_BYTES_LIMIT}.`,
				{ limit: EXTRACT_BYTES_LIMIT, actual: totalBytes },
			);
		}
		payloads.set(entry.name, payload);
	}
	const outputDir = resolve(options.outputDir);
	try {
		const outputStat = await lstat(outputDir);
		if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Output directory is not a usable directory: ${options.outputDir}.`,
				{ outputDir: options.outputDir },
			);
		}
	} catch (error) {
		if (error instanceof McAssetError) {
			throw error;
		}
		if (options.mkdir !== true) {
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Output directory does not exist: ${options.outputDir}.`,
				{ outputDir: options.outputDir },
			);
		}
		await mkdir(outputDir, { recursive: true });
	}
	for (const [name, payload] of payloads) {
		const target = resolve(outputDir, ...name.split("/"));
		const relative = target.slice(outputDir.length + 1);
		if (relative === "" || target !== join(outputDir, ...relative.split("/"))) {
			throw new McAssetError(
				"PACK_ARCHIVE_INVALID",
				`Zip entry escapes the output directory: ${name}.`,
				{ entry: name },
			);
		}
		const parent = dirname(target);
		try {
			const parentStat = await lstat(parent);
			if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
				throw new McAssetError(
					"FILESYSTEM_ERROR",
					`Parent path is not a directory: ${parent}.`,
					{ path: parent },
				);
			}
		} catch (error) {
			if (error instanceof McAssetError) {
				throw error;
			}
			if (options.mkdir !== true) {
				throw new McAssetError(
					"FILESYSTEM_ERROR",
					`Parent directory does not exist: ${parent}.`,
					{ path: parent },
				);
			}
			await mkdir(parent, { recursive: true });
		}
		try {
			const existing = await lstat(target);
			if (existing.isSymbolicLink() || existing.isDirectory()) {
				throw new McAssetError(
					"FILESYSTEM_ERROR",
					`Refusing to write through a symlink or directory: ${target}.`,
					{ path: target },
				);
			}
			if (existing.isFile() && options.force !== true) {
				throw new McAssetError(
					"OUTPUT_EXISTS",
					`Output already exists: ${target}.`,
					{ path: target },
				);
			}
		} catch (error) {
			if (error instanceof McAssetError) {
				throw error;
			}
		}
		await atomicWriteFile(target, payload, { mkdir: true });
	}
	return { fileCount: payloads.size, totalBytes };
}
