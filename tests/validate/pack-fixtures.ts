import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { addLayer, createCanvas, setPixel } from "../../src/core/canvas.ts";
import { encodePng } from "../../src/io/png.ts";

/** Pack fixture builders: every pack is assembled on disk, never committed. */

export function makePngBytes(): Uint8Array {
	const canvas = createCanvas(2, 2);
	const layer = addLayer(canvas, { id: "base" });
	setPixel(canvas, layer.id, 0, 0, { r: 255, g: 0, b: 0, a: 255 });
	setPixel(canvas, layer.id, 1, 0, { r: 0, g: 255, b: 0, a: 255 });
	setPixel(canvas, layer.id, 0, 1, { r: 0, g: 0, b: 255, a: 255 });
	setPixel(canvas, layer.id, 1, 1, { r: 255, g: 255, b: 0, a: 255 });
	return encodePng(canvas);
}

/**
 * Minimal PNG header bytes carrying an out-of-range IHDR size without any
 * pixel payload. The engine reads IHDR before decoding pixels, so these
 * bytes deterministically surface the dimension finding instead of a
 * decode failure.
 */
export function makeBadDimensionPngBytes(
	width: number,
	height: number,
): Uint8Array {
	const out = Buffer.alloc(8 + 4 + 4 + 13 + 4);
	let at = 0;
	for (const byte of [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
		out[at] = byte;
		at += 1;
	}
	out.writeUInt32BE(13, at);
	at += 4;
	out.write("IHDR", at, "ascii");
	at += 4;
	out.writeUInt32BE(width, at);
	at += 4;
	out.writeUInt32BE(height, at);
	at += 4;
	// Bit depth 8, color type 6 (RGBA), compression/filter/interlace zeros.
	out[at] = 8;
	out[at + 1] = 6;
	out[at + 2] = 0;
	out[at + 3] = 0;
	out[at + 4] = 0;
	return new Uint8Array(out);
}

export async function writePackFile(
	packRoot: string,
	rel: string,
	content: string | Uint8Array,
): Promise<void> {
	const full = join(packRoot, rel);
	await mkdir(dirname(full), { recursive: true });
	await writeFile(full, content);
}

export function modelJson(body: unknown): string {
	return JSON.stringify(body);
}

/** Atlas definition file body: the engine only reads `sources`. */
export function atlasJson(sources: unknown): string {
	return JSON.stringify({ sources });
}

/** Clean baseline: one model referencing one texture. */
export async function writeCleanBaseline(packRoot: string): Promise<void> {
	await writePackFile(
		packRoot,
		"assets/minecraft/models/item/sword.json",
		modelJson({ textures: { layer0: "minecraft:item/sword" } }),
	);
	await writePackFile(
		packRoot,
		"assets/minecraft/textures/item/sword.png",
		makePngBytes(),
	);
}

/** Clean model plus the parent model it points at. */
export async function writeModelWithParent(packRoot: string): Promise<void> {
	await writePackFile(
		packRoot,
		"assets/minecraft/models/item/sword.json",
		modelJson({ parent: "minecraft:item/generated" }),
	);
	await writePackFile(
		packRoot,
		"assets/minecraft/models/item/generated.json",
		modelJson({ textures: {} }),
	);
}
