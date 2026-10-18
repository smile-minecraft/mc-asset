import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../src/core/canvas.ts";
import { encodePng } from "../../src/io/png.ts";
import {
	assertZipEntryBudget,
	inflateZipEntry,
	parseZipArchive,
} from "../../src/io/zip-read.ts";
import { catalogVanillaTextures } from "../../src/pack/catalog.ts";

interface CatalogCase {
	name: string;
	run(): void | Promise<void>;
}

/** Refusal carrier: code plus structured details. */
interface Refusal {
	code?: string;
	details?: Record<string, unknown> | undefined;
}

async function refusalOf(
	body: () => unknown | Promise<unknown>,
): Promise<Refusal> {
	try {
		await body();
	} catch (error) {
		return error as Refusal;
	}
	assert.fail("expected a refusal but the call succeeded");
}

function makePng(
	width: number,
	height: number,
	pixel: (x: number, y: number) => [number, number, number, number],
): Uint8Array {
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: "base" });
	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			pixels.set(pixel(x, y), (y * width + x) * 4);
		}
	}
	replaceLayerPixels(canvas, layer.id, pixels);
	return encodePng(canvas);
}

const TRANSPARENT: [number, number, number, number] = [0, 0, 0, 0];
const RED: [number, number, number, number] = [200, 30, 30, 255];
const BLUE: [number, number, number, number] = [30, 60, 200, 255];

async function withVanillaTree(
	body: (vanillaDir: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "mc-asset-catalog-"));
	const vanillaDir = join(dir, "vanilla");
	try {
		await mkdir(join(vanillaDir, "assets", "game", "textures", "item"), {
			recursive: true,
		});
		await mkdir(join(vanillaDir, "assets", "game", "textures", "block"), {
			recursive: true,
		});
		// Two 4x4 textures with identical opaque masks (red vs blue bodies).
		await writeFile(
			join(vanillaDir, "assets", "game", "textures", "item", "ruby.png"),
			makePng(4, 4, (x, y) => (x === 0 && y === 0 ? TRANSPARENT : RED)),
		);
		await writeFile(
			join(vanillaDir, "assets", "game", "textures", "item", "sapphire.png"),
			makePng(4, 4, (x, y) => (x === 0 && y === 0 ? TRANSPARENT : BLUE)),
		);
		// One animated texture: same-size mcmeta sidecar marks it animated.
		await writeFile(
			join(vanillaDir, "assets", "game", "textures", "block", "lava.png"),
			makePng(8, 8, () => RED),
		);
		await writeFile(
			join(
				vanillaDir,
				"assets",
				"game",
				"textures",
				"block",
				"lava.png.mcmeta",
			),
			'{"animation":{}}',
			"utf8",
		);
		await body(vanillaDir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Build a minimal zip in memory: entries with stored or deflated data. */
function buildTestZip(
	entries: { name: string; data: Uint8Array; method: 0 | 8 }[],
): Uint8Array {
	const chunks: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	const crcOf = (data: Uint8Array): number => {
		void data;
		return 0;
	};
	for (const entry of entries) {
		const nameBytes = new TextEncoder().encode(entry.name);
		const payload =
			entry.method === 8 ? deflateRawSync(entry.data) : entry.data;
		const local = new DataView(new ArrayBuffer(30));
		local.setUint32(0, 0x04034b50, true);
		local.setUint16(4, 20, true);
		local.setUint16(6, 0, true);
		local.setUint16(8, entry.method, true);
		local.setUint16(10, 0, true);
		local.setUint16(12, 0, true);
		local.setUint32(14, crcOf(entry.data), true);
		local.setUint32(18, payload.length, true);
		local.setUint32(22, entry.data.length, true);
		local.setUint16(26, nameBytes.length, true);
		local.setUint16(28, 0, true);
		chunks.push(new Uint8Array(local.buffer), nameBytes, payload);
		const header = new DataView(new ArrayBuffer(46));
		header.setUint32(0, 0x02014b50, true);
		header.setUint16(4, 20, true);
		header.setUint16(6, 20, true);
		header.setUint16(8, 0, true);
		header.setUint16(10, entry.method, true);
		header.setUint16(12, 0, true);
		header.setUint16(14, 0, true);
		header.setUint32(16, crcOf(entry.data), true);
		header.setUint32(20, payload.length, true);
		header.setUint32(24, entry.data.length, true);
		header.setUint16(28, nameBytes.length, true);
		header.setUint16(30, 0, true);
		header.setUint16(32, 0, true);
		header.setUint16(34, 0, true);
		header.setUint16(36, 0, true);
		header.setUint32(38, 0, true);
		header.setUint32(42, offset, true);
		central.push(new Uint8Array(header.buffer), nameBytes);
		offset += 30 + nameBytes.length + payload.length;
	}
	const centralStart = offset;
	let centralSize = 0;
	for (const part of central) {
		chunks.push(part);
		centralSize += part.length;
	}
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, entries.length, true);
	end.setUint16(10, entries.length, true);
	end.setUint32(12, centralSize, true);
	end.setUint32(16, centralStart, true);
	chunks.push(new Uint8Array(end.buffer));
	const total = chunks.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of chunks) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

void createHash;
void readdir;
void readFile;

export const CATALOG_CASES: CatalogCase[] = [
	{
		name: "catalog lists textures with category, size, animation, and mask families",
		async run() {
			await withVanillaTree(async (vanillaDir) => {
				const report = await catalogVanillaTextures({
					vanillaPath: vanillaDir,
					includeFamilies: true,
				});
				assert.equal(report.total, 3);
				assert.equal(report.entries.length, 3);
				const ruby = report.entries.find((e) =>
					e.path.endsWith("item/ruby.png"),
				);
				assert.ok(ruby);
				assert.equal(ruby?.category, "item");
				assert.equal(ruby?.width, 4);
				assert.equal(ruby?.height, 4);
				assert.equal(ruby?.animated, false);
				const sapphire = report.entries.find((e) =>
					e.path.endsWith("item/sapphire.png"),
				);
				assert.ok(sapphire);
				assert.equal(sapphire?.family, ruby?.family);
				const lava = report.entries.find((e) =>
					e.path.endsWith("block/lava.png"),
				);
				assert.ok(lava);
				assert.equal(lava?.animated, true);
				assert.notEqual(lava?.family, ruby?.family);
				assert.ok(report.families);
				assert.equal(report.families?.length, 2);
			});
		},
	},
	{
		name: "catalog supports category filter and pagination",
		async run() {
			await withVanillaTree(async (vanillaDir) => {
				const first = await catalogVanillaTextures({
					vanillaPath: vanillaDir,
					category: "item",
					page: 1,
					pageSize: 1,
				});
				assert.equal(first.total, 2);
				assert.equal(first.entries.length, 1);
				const second = await catalogVanillaTextures({
					vanillaPath: vanillaDir,
					category: "item",
					page: 2,
					pageSize: 1,
				});
				assert.equal(second.total, 2);
				assert.equal(second.entries.length, 1);
				assert.notEqual(second.entries[0]?.path, first.entries[0]?.path);
			});
		},
	},
	{
		name: "catalog refuses a vanilla tree without assets",
		async run() {
			const dir = await mkdtemp(join(tmpdir(), "mc-asset-catalog-empty-"));
			try {
				const refusal = await refusalOf(async () => {
					await catalogVanillaTextures({ vanillaPath: dir });
				});
				assert.equal(refusal.code, "PACK_CATALOG_INVALID");
				assert.equal(
					(refusal.details as { assetsPath?: string } | undefined)?.assetsPath,
					join(dir, "assets"),
				);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	},
	{
		name: "zip extract keeps assets entries and round-trips stored and deflated",
		async run() {
			const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
			const stored = new Uint8Array([9, 9, 9, 9]);
			const zip = buildTestZip([
				{
					name: "assets/game/textures/item/ruby.png",
					data: payload,
					method: 8,
				},
				{
					name: "assets/game/textures/item/plain.png",
					data: stored,
					method: 0,
				},
				{ name: "outside.txt", data: stored, method: 0 },
			]);
			const archive = parseZipArchive(zip);
			const names = archive.entries.map((e) => e.name);
			assert.ok(names.includes("assets/game/textures/item/ruby.png"));
			assert.ok(names.includes("assets/game/textures/item/plain.png"));
			const ruby = archive.entries.find(
				(e) => e.name === "assets/game/textures/item/ruby.png",
			);
			assert.ok(ruby);
			assert.deepEqual(
				Array.from(inflateZipEntry(archive, ruby as { name: string } as never)),
				Array.from(payload),
			);
			const plain = archive.entries.find(
				(e) => e.name === "assets/game/textures/item/plain.png",
			);
			assert.ok(plain);
			assert.deepEqual(
				Array.from(
					inflateZipEntry(archive, plain as { name: string } as never),
				),
				Array.from(stored),
			);
		},
	},
	{
		name: "zip with traversal entry is refused with PACK_ARCHIVE_INVALID",
		async run() {
			const zip = buildTestZip([
				{ name: "../evil.png", data: new Uint8Array([1]), method: 0 },
			]);
			const refusal = await refusalOf(async () => {
				parseZipArchive(zip);
			});
			assert.equal(refusal.code, "PACK_ARCHIVE_INVALID");
			assert.equal(
				(refusal.details as { entry?: string } | undefined)?.entry,
				"../evil.png",
			);
		},
	},
	{
		name: "zip with absolute entry is refused with PACK_ARCHIVE_INVALID",
		async run() {
			const zip = buildTestZip([
				{ name: "/abs/evil.png", data: new Uint8Array([1]), method: 0 },
			]);
			const refusal = await refusalOf(async () => {
				parseZipArchive(zip);
			});
			assert.equal(refusal.code, "PACK_ARCHIVE_INVALID");
			assert.equal(
				(refusal.details as { entry?: string } | undefined)?.entry,
				"/abs/evil.png",
			);
		},
	},
	{
		name: "zip with corrupted central directory is refused with PACK_ARCHIVE_INVALID",
		async run() {
			const zip = buildTestZip([
				{
					name: "assets/game/textures/item/ruby.png",
					data: new Uint8Array([1, 2]),
					method: 0,
				},
			]);
			const damaged = zip.slice(0, zip.length - 10);
			const refusal = await refusalOf(async () => {
				parseZipArchive(damaged);
			});
			assert.equal(refusal.code, "PACK_ARCHIVE_INVALID");
			assert.equal(
				(refusal.details as { reason?: string } | undefined)?.reason,
				"central-directory",
			);
		},
	},
	{
		name: "zip with too many entries is refused with RESOURCE_LIMIT_EXCEEDED",
		async run() {
			const refusal = await refusalOf(async () => {
				assertZipEntryBudget(100001, 100000);
			});
			assert.equal(refusal.code, "RESOURCE_LIMIT_EXCEEDED");
			assert.match(
				String(
					(refusal.details as { message?: string } | undefined)?.message ??
						(refusal as { message?: string }).message ??
						"",
				),
				/100001/,
			);
		},
	},
];
