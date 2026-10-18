import { deflateRawSync } from "node:zlib";
import { crc32 } from "./png-chunks.ts";

/**
 * Deterministic zip writer for pack delivery. Entries sort by UTF-8 byte
 * order, timestamps fix to DOS date 0x0021 and time 0x0000, payloads use
 * raw deflate at fixed level 6, non-ASCII names set the UTF-8 flag, and
 * no data descriptors are written, so the same inputs yield identical
 * bytes on every run. Only `node:zlib` compresses.
 */

export interface ZipWriteEntry {
	readonly name: string;
	readonly data: Uint8Array;
}

const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021;
const COMPRESSION_DEFLATE = 8;
const ZIP_VERSION = 20;

function hasNonAscii(text: string): boolean {
	for (let i = 0; i < text.length; i += 1) {
		if ((text.charCodeAt(i) as number) > 127) {
			return true;
		}
	}
	return false;
}

/** Serialize entries into deterministic zip bytes. */
export function writeZip(entries: readonly ZipWriteEntry[]): Uint8Array {
	const sorted = [...entries].sort((a, b) =>
		Buffer.from(a.name, "utf8").compare(Buffer.from(b.name, "utf8")),
	);

	const localChunks: Uint8Array[] = [];
	const centralChunks: Uint8Array[] = [];
	let currentOffset = 0;

	for (const entry of sorted) {
		const nameBytes = new TextEncoder().encode(entry.name);
		const compressed = deflateRawSync(entry.data, { level: 6 });
		const flags = hasNonAscii(entry.name) ? 0x0800 : 0;
		const entryCrc = crc32(entry.data, 0, entry.data.length);

		// Local file header (30 bytes)
		const local = new DataView(new ArrayBuffer(30));
		local.setUint32(0, 0x04034b50, true);
		local.setUint16(4, ZIP_VERSION, true);
		local.setUint16(6, flags, true);
		local.setUint16(8, COMPRESSION_DEFLATE, true);
		local.setUint16(10, DOS_TIME, true);
		local.setUint16(12, DOS_DATE, true);
		local.setUint32(14, entryCrc, true);
		local.setUint32(18, compressed.length, true);
		local.setUint32(22, entry.data.length, true);
		local.setUint16(26, nameBytes.length, true);
		local.setUint16(28, 0, true);

		localChunks.push(new Uint8Array(local.buffer), nameBytes, compressed);

		// Central directory header (46 bytes)
		const central = new DataView(new ArrayBuffer(46));
		central.setUint32(0, 0x02014b50, true);
		central.setUint16(4, ZIP_VERSION, true); // version made by
		central.setUint16(6, ZIP_VERSION, true); // version needed
		central.setUint16(8, flags, true);
		central.setUint16(10, COMPRESSION_DEFLATE, true);
		central.setUint16(12, DOS_TIME, true);
		central.setUint16(14, DOS_DATE, true);
		central.setUint32(16, entryCrc, true);
		central.setUint32(20, compressed.length, true);
		central.setUint32(24, entry.data.length, true);
		central.setUint16(28, nameBytes.length, true);
		central.setUint16(30, 0, true); // extra length
		central.setUint16(32, 0, true); // comment length
		central.setUint16(34, 0, true); // disk start
		central.setUint16(36, 0, true); // internal attrs
		central.setUint32(38, 0, true); // external attrs
		central.setUint32(42, currentOffset, true);

		centralChunks.push(new Uint8Array(central.buffer), nameBytes);

		currentOffset += 30 + nameBytes.length + compressed.length;
	}

	const centralDirStart = currentOffset;
	let centralDirSize = 0;
	for (const chunk of centralChunks) {
		centralDirSize += chunk.length;
	}

	// End of central directory record (22 bytes)
	const eocd = new DataView(new ArrayBuffer(22));
	eocd.setUint32(0, 0x06054b50, true);
	eocd.setUint16(4, 0, true); // disk number
	eocd.setUint16(6, 0, true); // start disk
	eocd.setUint16(8, sorted.length, true); // entries on this disk
	eocd.setUint16(10, sorted.length, true); // total entries
	eocd.setUint32(12, centralDirSize, true);
	eocd.setUint32(16, centralDirStart, true);
	eocd.setUint16(20, 0, true); // comment length

	const allChunks = [
		...localChunks,
		...centralChunks,
		new Uint8Array(eocd.buffer),
	];
	const totalLength = allChunks.reduce((acc, c) => acc + c.length, 0);
	const result = new Uint8Array(totalLength);
	let at = 0;
	for (const chunk of allChunks) {
		result.set(chunk, at);
		at += chunk.length;
	}

	return result;
}
