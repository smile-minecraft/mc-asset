import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { McAssetError } from "../core/errors.ts";
import { canonicalKey, isInside, lexicalKey } from "./safe-output.ts";

export const OPTIMIZE_DIR_LIMITS = {
	maxPngFiles: 4096,
	maxTotalSourceBytes: 268435456, // 256 MiB
	maxTotalDecodedPixels: 16777216, // 16,777,216 pixels
} as const;

export interface ScannedPngEntry {
	/** Relative path from scanned directory root using POSIX-style separators. */
	readonly relativePath: string;
	/** Full path on disk. */
	readonly fullPath: string;
	/** Injected or known file size in bytes. */
	readonly size?: number | undefined;
}

export interface OptimizeDirSeams {
	/** Injected scanner returning synthesized entries (for 4096/4097 boundary testing). */
	readonly scanEntries?: (
		dir: string,
		recursive: boolean,
	) => Promise<readonly ScannedPngEntry[]>;
	/** Injected stat returning file size (for 256 MiB boundary testing). */
	readonly statFile?: (path: string) => Promise<{ readonly size: number }>;
	/** Injected dimension extractor (for 16,777,216 decoded pixel boundary testing). */
	readonly getPixelDimensions?: (
		path: string,
		bytes: Uint8Array,
	) => { readonly width: number; readonly height: number };
}

/**
 * Ensures source directory and output directory do not alias or contain each other.
 */
export async function assertDisjointDirectories(
	sourceDir: string,
	outputDir: string,
): Promise<void> {
	const srcCanon = await canonicalKey(sourceDir);
	const dstCanon = await canonicalKey(outputDir);
	const srcLex = lexicalKey(sourceDir);
	const dstLex = lexicalKey(outputDir);

	if (srcCanon === dstCanon || srcLex === dstLex) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			`Source and output directories resolve to the same path: ${outputDir}.`,
			{ source: sourceDir, output: outputDir },
		);
	}
	if (isInside(srcCanon, dstCanon) || isInside(srcLex, dstLex)) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			`Output directory is inside the source directory: ${outputDir}.`,
			{ source: sourceDir, output: outputDir },
		);
	}
	if (isInside(dstCanon, srcCanon) || isInside(dstLex, srcLex)) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			`Source directory is inside the output directory: ${sourceDir}.`,
			{ source: sourceDir, output: outputDir },
		);
	}
}

/**
 * Validates that total source bytes do not exceed the 256 MiB budget.
 */
export function checkSourceBytesLimit(totalBytes: number): void {
	if (totalBytes > OPTIMIZE_DIR_LIMITS.maxTotalSourceBytes) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			`Total input bytes exceed 256 MiB limit: ${totalBytes}.`,
			{ limit: OPTIMIZE_DIR_LIMITS.maxTotalSourceBytes, actual: totalBytes },
		);
	}
}

/**
 * Validates that total decoded pixels do not exceed the 16,777,216 pixel budget.
 */
export function checkDecodedPixelsLimit(totalPixels: number): void {
	if (totalPixels > OPTIMIZE_DIR_LIMITS.maxTotalDecodedPixels) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			`Total decoded pixels exceed 16777216 limit: ${totalPixels}.`,
			{
				limit: OPTIMIZE_DIR_LIMITS.maxTotalDecodedPixels,
				actual: totalPixels,
			},
		);
	}
}

/**
 * Scans a directory for PNG files without following symbolic links.
 * Rejects on any symbolic link or read failure in the scan scope.
 * Skips non-PNG regular files. Empty directory or no PNGs throws INVALID_ARGUMENT.
 * Exceeding 4096 PNGs throws RESOURCE_LIMIT_EXCEEDED.
 * Results are sorted strictly by UTF-8 bytes of relative path.
 */
export async function scanPngDirectory(
	dir: string,
	recursive: boolean,
	seams?: OptimizeDirSeams,
): Promise<readonly ScannedPngEntry[]> {
	let rootLstat: Awaited<ReturnType<typeof lstat>>;
	try {
		rootLstat = await lstat(dir);
	} catch {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Cannot read directory: ${dir}.`,
			{ path: dir },
		);
	}

	if (rootLstat.isSymbolicLink()) {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Symbolic links are not supported: ${dir}.`,
			{ reason: "symlink-not-supported", path: dir },
		);
	}

	if (!rootLstat.isDirectory()) {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Input path is not a directory: ${dir}.`,
			{ reason: "not-a-directory", path: dir },
		);
	}

	if (seams?.scanEntries !== undefined) {
		const injected = await seams.scanEntries(dir, recursive);
		if (injected.length === 0) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				`No PNG files found in directory: ${dir}.`,
				{ path: dir },
			);
		}
		if (injected.length > OPTIMIZE_DIR_LIMITS.maxPngFiles) {
			throw new McAssetError(
				"RESOURCE_LIMIT_EXCEEDED",
				`Directory contains ${injected.length} PNG files, exceeding the limit of ${OPTIMIZE_DIR_LIMITS.maxPngFiles}.`,
				{ limit: OPTIMIZE_DIR_LIMITS.maxPngFiles, actual: injected.length },
			);
		}
		const sorted = [...injected];
		sorted.sort((a, b) =>
			Buffer.from(a.relativePath, "utf8").compare(
				Buffer.from(b.relativePath, "utf8"),
			),
		);
		return sorted;
	}

	const entries: ScannedPngEntry[] = [];

	async function walk(
		currentDir: string,
		currentRelative: string,
	): Promise<void> {
		let dirEntries: Dirent<string>[];
		try {
			dirEntries = await readdir(currentDir, {
				withFileTypes: true,
				encoding: "utf8",
			});
		} catch {
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Cannot read directory: ${currentDir}.`,
				{ path: currentDir },
			);
		}

		for (const entry of dirEntries) {
			const entryName = String(entry.name);
			const entryPath = join(currentDir, entryName);
			const relPath =
				currentRelative === "" ? entryName : `${currentRelative}/${entryName}`;

			// Reject any symbolic link in scan scope
			if (entry.isSymbolicLink()) {
				throw new McAssetError(
					"FILESYSTEM_ERROR",
					`Symbolic links are not supported: ${entryPath}.`,
					{ reason: "symlink-not-supported", path: entryPath },
				);
			}

			if (entry.isDirectory()) {
				if (recursive) {
					await walk(entryPath, relPath);
				}
				continue;
			}

			if (entry.isFile()) {
				if (extname(entryName).toLowerCase() === ".png") {
					entries.push({
						relativePath: relPath,
						fullPath: entryPath,
					});
				}
				continue;
			}

			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Unsupported directory entry: ${entryPath}.`,
				{ path: entryPath },
			);
		}
	}

	await walk(dir, "");

	if (entries.length === 0) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`No PNG files found in directory: ${dir}.`,
			{ path: dir },
		);
	}

	if (entries.length > OPTIMIZE_DIR_LIMITS.maxPngFiles) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			`Directory contains ${entries.length} PNG files, exceeding the limit of ${OPTIMIZE_DIR_LIMITS.maxPngFiles}.`,
			{ limit: OPTIMIZE_DIR_LIMITS.maxPngFiles, actual: entries.length },
		);
	}

	entries.sort((a, b) =>
		Buffer.from(a.relativePath, "utf8").compare(
			Buffer.from(b.relativePath, "utf8"),
		),
	);

	return entries;
}
