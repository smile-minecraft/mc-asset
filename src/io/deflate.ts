import type { DeflateOptions } from "pako";
import {
	deflate,
	Z_FINISH,
	Z_STREAM_END,
	ZStream,
	zlibInflate,
	zlibInflateEnd,
	zlibInflateInit2,
} from "pako";

export type DeflateStrategy = "default" | "filtered" | "rle";

export const DEFLATE_ENGINE_ID =
	"pako@3.0.2 level=9 memLevel=9 windowBits=15 legacyHash=false";

const FIXED_OPTIONS = {
	level: 9,
	memLevel: 9,
	windowBits: 15,
	legacyHash: false,
} satisfies DeflateOptions;

export function deflateZlib(
	data: Uint8Array,
	strategy: DeflateStrategy,
): Uint8Array {
	const strategyValue =
		strategy === "default" ? 0 : strategy === "filtered" ? 1 : 3;
	return deflate(data, { ...FIXED_OPTIONS, strategy: strategyValue });
}

/**
 * True when `data` is one complete zlib stream (header, blocks and Adler-32 all valid) that
 * inflates to exactly `expectedLength` bytes and leaves no input unread.
 */
export function isExactZlibStream(
	data: Uint8Array,
	expectedLength: number,
): boolean {
	const strm = new ZStream();
	if (zlibInflateInit2(strm, 15) !== 0) return false;
	try {
		strm.input = data;
		strm.next_in = 0;
		strm.avail_in = data.length;
		// One spare byte exposes a stream that inflates past the expected length.
		strm.output = new Uint8Array(expectedLength + 1);
		strm.next_out = 0;
		strm.avail_out = expectedLength + 1;
		const status = zlibInflate(strm, Z_FINISH);
		return (
			status === Z_STREAM_END &&
			strm.total_out === expectedLength &&
			strm.avail_in === 0
		);
	} finally {
		zlibInflateEnd(strm);
	}
}
