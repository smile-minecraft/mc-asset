import { inflateRawSync } from "node:zlib";
import { McAssetError } from "../core/errors.ts";

/**
 * Minimal zip reader for vanilla client jars. Reads the end of central
 * directory, walks the central directory, and inflates entries with
 * `node:zlib` only. Stored and deflated entries are supported; archives
 * that need anything else fail closed instead of guessing.
 */

export interface ZipEntry {
	readonly name: string;
	readonly compressMethod: number;
	readonly compressedSize: number;
	readonly uncompressedSize: number;
	readonly localHeaderOffset: number;
	readonly encrypted: boolean;
}

export interface ZipArchive {
	readonly entries: readonly ZipEntry[];
	readonly bytes: Uint8Array;
}

function readU16(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
	return (
		(bytes[offset] ?? 0) |
		((bytes[offset + 1] ?? 0) << 8) |
		((bytes[offset + 2] ?? 0) << 16) |
		((bytes[offset + 3] ?? 0) * 0x1000000)
	);
}

function decodeName(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

/** Unsafe entry: absolute path or any `..` segment. */
function isUnsafeName(name: string): boolean {
	if (name.startsWith("/") || name.startsWith("\\")) {
		return true;
	}
	for (const segment of name.split("/")) {
		if (segment === "..") {
			return true;
		}
	}
	return false;
}

/** Locate the end-of-central-directory record by scanning the tail. */
function findEndOfCentralDirectory(bytes: Uint8Array): {
	entryCount: number;
	directoryOffset: number;
} {
	if (bytes.length < 22) {
		throw new McAssetError(
			"PACK_ARCHIVE_INVALID",
			"Zip archive is truncated: missing end of central directory.",
			{ reason: "central-directory" },
		);
	}
	const tailSize = Math.min(bytes.length, 65557 + 22);
	const start = bytes.length - tailSize;
	for (let at = bytes.length - 22; at >= start; at -= 1) {
		if (readU32(bytes, at) !== 0x06054b50) {
			continue;
		}
		const commentLength = readU16(bytes, at + 20);
		if (at + 22 + commentLength !== bytes.length) {
			continue;
		}
		return {
			entryCount: readU16(bytes, at + 10),
			directoryOffset: readU32(bytes, at + 16),
		};
	}
	throw new McAssetError(
		"PACK_ARCHIVE_INVALID",
		"Zip archive has no end of central directory.",
		{ reason: "central-directory" },
	);
}

/** Parse the central directory; damaged records refuse with PACK_ARCHIVE_INVALID. */
export function parseZipArchive(bytes: Uint8Array): ZipArchive {
	const end = findEndOfCentralDirectory(bytes);
	const entries: ZipEntry[] = [];
	let at = end.directoryOffset;
	for (let index = 0; index < end.entryCount; index += 1) {
		if (at + 46 > bytes.length || readU32(bytes, at) !== 0x02014b50) {
			throw new McAssetError(
				"PACK_ARCHIVE_INVALID",
				`Zip central directory entry ${index} is damaged.`,
				{ reason: "central-directory", index },
			);
		}
		const flags = readU16(bytes, at + 8);
		const method = readU16(bytes, at + 10);
		const compressedSize = readU32(bytes, at + 20);
		const uncompressedSize = readU32(bytes, at + 24);
		const nameLength = readU16(bytes, at + 28);
		const extraLength = readU16(bytes, at + 30);
		const commentLength = readU16(bytes, at + 32);
		const localHeaderOffset = readU32(bytes, at + 42);
		const nameStart = at + 46;
		const nameEnd = nameStart + nameLength;
		if (nameEnd + extraLength + commentLength > bytes.length) {
			throw new McAssetError(
				"PACK_ARCHIVE_INVALID",
				`Zip central directory entry ${index} runs past the archive end.`,
				{ reason: "central-directory", index },
			);
		}
		const name = decodeName(bytes.slice(nameStart, nameEnd));
		if (isUnsafeName(name)) {
			throw new McAssetError(
				"PACK_ARCHIVE_INVALID",
				`Zip entry escapes the archive root: ${name}.`,
				{ entry: name },
			);
		}
		entries.push({
			name,
			compressMethod: method,
			compressedSize,
			uncompressedSize,
			localHeaderOffset,
			encrypted: (flags & 0x1) !== 0,
		});
		at = nameEnd + extraLength + commentLength;
	}
	return { entries, bytes };
}

/** Entry-count budget shared by catalog and extraction planning. */
export function assertZipEntryBudget(entryCount: number, limit: number): void {
	if (entryCount > limit) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			`Zip entry count ${entryCount} exceeds the limit of ${limit}.`,
			{ actual: entryCount, limit },
		);
	}
}

/** Inflate one entry; encrypted or unsupported methods refuse. */
export function inflateZipEntry(
	archive: ZipArchive,
	entry: ZipEntry,
): Uint8Array {
	if (entry.encrypted) {
		throw new McAssetError(
			"PACK_ARCHIVE_INVALID",
			`Zip entry is encrypted and cannot be read: ${entry.name}.`,
			{ entry: entry.name },
		);
	}
	if (entry.compressMethod !== 0 && entry.compressMethod !== 8) {
		throw new McAssetError(
			"PACK_ARCHIVE_INVALID",
			`Zip entry uses unsupported compression method ${entry.compressMethod}: ${entry.name}.`,
			{ entry: entry.name },
		);
	}
	const bytes = archive.bytes;
	const at = entry.localHeaderOffset;
	if (at + 30 > bytes.length || readU32(bytes, at) !== 0x04034b50) {
		throw new McAssetError(
			"PACK_ARCHIVE_INVALID",
			`Zip local header for entry is damaged: ${entry.name}.`,
			{ entry: entry.name },
		);
	}
	const nameLength = readU16(bytes, at + 26);
	const extraLength = readU16(bytes, at + 28);
	const dataStart = at + 30 + nameLength + extraLength;
	const dataEnd = dataStart + entry.compressedSize;
	if (dataEnd > bytes.length) {
		throw new McAssetError(
			"PACK_ARCHIVE_INVALID",
			`Zip entry data runs past the archive end: ${entry.name}.`,
			{ entry: entry.name },
		);
	}
	const payload = bytes.slice(dataStart, dataEnd);
	if (entry.compressMethod === 0) {
		return new Uint8Array(payload);
	}
	return new Uint8Array(inflateRawSync(payload));
}
