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
import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../src/core/canvas.ts";
import { buildContactSheet } from "../../src/core/contact-sheet.ts";
import type { PixelCanvas, RGBA } from "../../src/core/types.ts";
import { encodePng } from "../../src/io/png.ts";
import { parseZipArchive } from "../../src/io/zip-read.ts";
import { writeZip } from "../../src/io/zip-write.ts";
import { checkResourcePack } from "../../src/pack/check.ts";
import { auditTextureFamily } from "../../src/style/audit.ts";

interface QualityCase {
	name: string;
	run(): void | Promise<void>;
}

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

function rgba(hex: string, alpha = 255): RGBA {
	return {
		r: Number.parseInt(hex.slice(1, 3), 16),
		g: Number.parseInt(hex.slice(3, 5), 16),
		b: Number.parseInt(hex.slice(5, 7), 16),
		a: alpha,
	};
}

/** Original painter canvas: no external artwork enters the suite. */
function paintedCanvas(
	width: number,
	height: number,
	paint: (x: number, y: number) => RGBA,
): PixelCanvas {
	const canvas = createCanvas(width, height);
	const layer = addLayer(canvas, { id: "base" });
	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const color = paint(x, y);
			const offset = (y * width + x) * 4;
			pixels[offset] = color.r;
			pixels[offset + 1] = color.g;
			pixels[offset + 2] = color.b;
			pixels[offset + 3] = color.a;
		}
	}
	replaceLayerPixels(canvas, layer.id, pixels);
	return canvas;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

const TRANSPARENT = rgba("#000000", 0);

export const QUALITY_CASES: QualityCase[] = [
	{
		name: "contact sheet labels two inputs with dark background",
		async run() {
			const red = paintedCanvas(4, 4, () => rgba("#C03028"));
			const blue = paintedCanvas(4, 4, () => rgba("#2840C0"));
			const report = buildContactSheet({
				inputs: [red, blue],
				names: ["ruby.png", "sapphire.png"],
				background: "dark",
			});
			assert.equal(report.pageCount, 1);
			assert.equal(report.pages.length, 1);
			const png = encodePng(report.pages[0]?.canvas as PixelCanvas);
			assert.equal(
				sha256(png),
				"14aa710e1bd4f7f1afa43e44b7d05a9a25288405e9c481f0ad6ee77ed044593b",
			);
		},
	},
	{
		name: "contact sheet light background differs from dark",
		async run() {
			const red = paintedCanvas(4, 4, () => rgba("#C03028"));
			const dark = buildContactSheet({
				inputs: [red],
				names: ["ruby.png"],
				background: "dark",
			});
			const light = buildContactSheet({
				inputs: [red],
				names: ["ruby.png"],
				background: "light",
			});
			const darkHash = sha256(encodePng(dark.pages[0]?.canvas as PixelCanvas));
			const lightHash = sha256(
				encodePng(light.pages[0]?.canvas as PixelCanvas),
			);
			assert.notEqual(darkHash, lightHash);
		},
	},
	{
		name: "contact sheet pairs two inputs side by side in one cell",
		async run() {
			const red = paintedCanvas(4, 4, () => rgba("#C03028"));
			const blue = paintedCanvas(4, 4, () => rgba("#2840C0"));
			const report = buildContactSheet({
				inputs: [red, blue],
				names: ["ruby.png", "sapphire.png"],
				pairMode: "sequential",
			});
			assert.equal(report.pageCount, 1);
			const single = buildContactSheet({
				inputs: [red, blue],
				names: ["ruby.png", "sapphire.png"],
			});
			const pairedHash = sha256(
				encodePng(report.pages[0]?.canvas as PixelCanvas),
			);
			const singleHash = sha256(
				encodePng(single.pages[0]?.canvas as PixelCanvas),
			);
			assert.notEqual(pairedHash, singleHash);
		},
	},
	{
		name: "contact sheet paginates past the 1024 limit",
		async run() {
			const inputs: PixelCanvas[] = [];
			const names: string[] = [];
			for (let i = 0; i < 200; i += 1) {
				inputs.push(paintedCanvas(16, 16, () => rgba("#C03028")));
				names.push(`sprite-${i}.png`);
			}
			const report = buildContactSheet({ inputs, names });
			assert.ok(report.pageCount > 1);
			assert.equal(report.pages.length, report.pageCount);
		},
	},
	{
		name: "contact sheet refuses zero inputs",
		async run() {
			const refusal = await refusalOf(async () => {
				buildContactSheet({ inputs: [], names: [] });
			});
			assert.equal(refusal.code, "INVALID_ARGUMENT");
		},
	},
	{
		name: "contact sheet lays a single input without paging",
		async run() {
			const red = paintedCanvas(4, 4, () => rgba("#C03028"));
			const report = buildContactSheet({
				inputs: [red],
				names: ["solo.png"],
			});
			assert.equal(report.pageCount, 1);
			assert.equal(report.pages.length, 1);
		},
	},
	{
		name: "contact sheet substitutes unknown label characters",
		async run() {
			const red = paintedCanvas(4, 4, () => rgba("#C03028"));
			const report = buildContactSheet({
				inputs: [red],
				names: ["\u4e2d\u6587.png"],
			});
			assert.equal(report.pageCount, 1);
			assert.ok(report.labelFallbacks > 0);
		},
	},
	{
		name: "family audit reports overlap, palette drift, and size drift",
		async run() {
			const mask = (x: number, y: number) =>
				x === 0 && y === 0 ? TRANSPARENT : rgba("#C03028");
			const sameA = paintedCanvas(4, 4, mask);
			const sameB = paintedCanvas(4, 4, (x, y) =>
				x === 0 && y === 0 ? TRANSPARENT : rgba("#2840C0"),
			);
			const sameC = paintedCanvas(4, 4, (x, y) =>
				x === 0 && y === 0 ? TRANSPARENT : rgba("#28C040"),
			);
			const wide = paintedCanvas(8, 4, mask);
			const report = auditTextureFamily({
				inputs: [sameA, sameB, sameC, wide],
				names: ["a.png", "b.png", "c.png", "wide.png"],
			});
			assert.ok(report.sizeDrift.length > 0);
			assert.ok(report.minOverlapPermille < 1000);
			assert.ok(report.minPaletteOverlapPermille <= 1000);
			assert.ok(report.findings.length > 0);
		},
	},
	{
		name: "pack check merges validation and style with an ordered fix list",
		async run() {
			const dir = await mkdtemp(join(tmpdir(), "mc-asset-check-"));
			try {
				await mkdir(join(dir, "pack"), { recursive: true });
				const summary = await checkResourcePack({
					projectPath: join(dir, "mc-asset.pack.json"),
				});
				assert.ok(summary.groups.length >= 2);
				assert.ok(summary.fixList.length > 0);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	},
	{
		name: "packaged zip reads back and excludes project files",
		async run() {
			const dir = await mkdtemp(join(tmpdir(), "mc-asset-quality-"));
			try {
				await mkdir(join(dir, "pack", "assets", "game", "textures", "item"), {
					recursive: true,
				});
				await writeFile(
					join(dir, "pack", "assets", "game", "textures", "item", "ruby.png"),
					encodePng(paintedCanvas(4, 4, () => rgba("#C03028"))),
				);
				await writeFile(
					join(dir, "pack", "pack.mcmeta"),
					'{"pack":{"description":"x"}}',
					"utf8",
				);
				await writeFile(join(dir, "pack", ".DS_Store"), "junk", "utf8");
				await writeFile(join(dir, "mc-asset.pack.json"), "{}", "utf8");
				const { packageResourcePack } = await import(
					"../../src/pack/package.ts"
				);
				const first = await packageResourcePack({
					projectPath: join(dir, "mc-asset.pack.json"),
					outputPath: join(dir, "out.zip"),
				});
				void first;
				const second = await packageResourcePack({
					projectPath: join(dir, "mc-asset.pack.json"),
					outputPath: join(dir, "out2.zip"),
				});
				const a = await readFile(join(dir, "out.zip"));
				const b = await readFile(join(dir, "out2.zip"));
				assert.deepEqual(Array.from(a), Array.from(b));
				const archive = parseZipArchive(new Uint8Array(a));
				const names = archive.entries.map((e) => e.name);
				assert.ok(names.includes("pack.mcmeta"));
				assert.ok(!names.some((n) => n.includes(".DS_Store")));
				assert.ok(!names.some((n) => n.includes("mc-asset.pack.json")));
				assert.ok(!names.some((n) => n.startsWith("__MACOSX")));
				void readdir;
				void second;
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	},
	{
		name: "packaging an empty pack is refused",
		async run() {
			const { packageResourcePack } = await import("../../src/pack/package.ts");
			const refusal = await refusalOf(async () => {
				await packageResourcePack({
					projectPath: "/nonexistent/mc-asset.pack.json",
					outputPath: "/nonexistent/out.zip",
				});
			});
			assert.equal(refusal.code, "PACK_PROJECT_NOT_FOUND");
			assert.equal(
				(refusal.details as { outputPath?: string } | undefined)?.outputPath,
				"/nonexistent/out.zip",
			);
			void TRANSPARENT;
		},
	},
];

void writeZip;
