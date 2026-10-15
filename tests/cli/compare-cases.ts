import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { comparePngCanvases } from "../../src/analyze/compare.ts";
import {
	type CompareCliOptions,
	runCompare,
} from "../../src/cli/cmd-compare.ts";
import {
	addLayer,
	createCanvas,
	replaceLayerPixels,
} from "../../src/core/canvas.ts";
import { decodePng, encodePng } from "../../src/io/png.ts";
import { handleCompareAssets } from "../../src/mcp/handlers.ts";
import { captureQuantizeStreams } from "./quantize-palette-cases.ts";

function canvas(width: number, height: number, bytes?: number[], id = "base") {
	const c = createCanvas(width, height);
	const l = addLayer(c, { id });
	if (bytes) replaceLayerPixels(c, l.id, Uint8Array.from(bytes));
	return c;
}
function required<T>(value: T | undefined): T {
	assert.ok(value !== undefined);
	return value;
}
const bounds = (x: number, y: number, width = 1, height = 1) => ({
	x,
	y,
	width,
	height,
});
async function cli(
	before: string,
	after: string,
	options: CompareCliOptions = {},
) {
	const capture = captureQuantizeStreams();
	const code = await runCompare(before, after, options, true, capture.streams);
	return { code, out: capture.stdout(), err: capture.stderrText() };
}
async function fixture(
	body: (root: string, before: string, after: string) => Promise<void>,
) {
	const root = await mkdtemp(join(tmpdir(), "compare-png-"));
	const before = join(root, "before.png");
	const after = join(root, "other-name.png");
	const a = PNG.sync.write({
		width: 2,
		height: 1,
		gamma: 0,
		data: Buffer.from([0, 0, 0, 255, 10, 20, 30, 0]),
	} as PNG);
	const b = PNG.sync.write({
		width: 2,
		height: 1,
		gamma: 0,
		data: Buffer.from([255, 0, 0, 255, 40, 20, 30, 0]),
	} as PNG);
	try {
		await writeFile(before, a);
		await writeFile(after, b);
		await body(root, before, after);
		assert.deepEqual(new Uint8Array(await readFile(before)), new Uint8Array(a));
		assert.deepEqual(new Uint8Array(await readFile(after)), new Uint8Array(b));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
export const COMPARE_CASES = [
	{
		name: "compare image limits reject before stdout bytes while report-only accepts large PNG",
		async run() {
			await fixture(async (root, a, b) => {
				const large = join(root, "large.png");
				await writeFile(large, encodePng(canvas(1025, 1)));
				assert.equal((await cli(large, large)).code, 0);
				const refused = await cli(large, large, { stdout: true });
				assert.notEqual(refused.code, 0);
				assert.equal(refused.out.length, 0);
				assert.match(refused.err, /RESOURCE_LIMIT_EXCEEDED/);
				for (const scale of [0, 17, 1.5])
					assert.throws(
						() => comparePngCanvases(canvas(1, 1), canvas(1, 1), false, scale),
						/INVALID_ARGUMENT/,
					);
				const m = await handleCompareAssets({
					beforePath: a,
					afterPath: b,
					image: "diff",
					outputPath: a,
					force: true,
				});
				assert.equal(m.isError, true);
			});
		},
	},
	{
		name: "compare identical PNG reports null bounds",
		run() {
			const a = canvas(2, 2);
			assert.deepEqual(comparePngCanvases(a, a).report, {
				width: 2,
				height: 2,
				totalPixels: 4,
				rawChangedPixels: 0,
				visibleChangedPixels: 0,
				rawBounds: null,
				visibleBounds: null,
			});
		},
	},
	{
		name: "compare corner pixel ignores source layer ids",
		run() {
			const a = canvas(2, 2, undefined, "before");
			const b = canvas(
				2,
				2,
				[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 4, 5, 255],
				"after",
			);
			const r = comparePngCanvases(a, b).report;
			assert.equal(r.rawChangedPixels, 1);
			assert.equal(r.visibleChangedPixels, 1);
			assert.deepEqual(r.rawBounds, bounds(1, 1));
			assert.deepEqual(r.visibleBounds, bounds(1, 1));
		},
	},
	{
		name: "compare multiple points form inclusive pixel rectangle",
		run() {
			const a = canvas(3, 2);
			const b = canvas(3, 2);
			required(b.layers[0]).pixels.set([9, 8, 7, 255], 4);
			required(b.layers[0]).pixels.set([1, 2, 3, 255], 20);
			const r = comparePngCanvases(a, b).report;
			assert.equal(r.rawChangedPixels, 2);
			assert.deepEqual(r.rawBounds, bounds(1, 0, 2, 2));
		},
	},
	{
		name: "compare alpha-only change is visible",
		run() {
			const r = comparePngCanvases(
				canvas(1, 1, [7, 8, 9, 1]),
				canvas(1, 1, [7, 8, 9, 2]),
			).report;
			assert.equal(r.rawChangedPixels, 1);
			assert.equal(r.visibleChangedPixels, 1);
		},
	},
	{
		name: "compare hidden RGB is raw-only",
		run() {
			const r = comparePngCanvases(
				canvas(1, 1, [7, 8, 9, 0]),
				canvas(1, 1, [70, 8, 9, 0]),
			).report;
			assert.equal(r.rawChangedPixels, 1);
			assert.equal(r.visibleChangedPixels, 0);
			assert.deepEqual(r.rawBounds, bounds(0, 0));
			assert.equal(r.visibleBounds, null);
		},
	},
	{
		name: "compare diagnostic exact magenta cyan and transparent with nearest scale",
		run() {
			const a = canvas(3, 1, [0, 0, 0, 255, 1, 2, 3, 0, 8, 9, 10, 255]);
			const b = canvas(3, 1, [3, 0, 0, 255, 4, 2, 3, 0, 8, 9, 10, 255]);
			const base = comparePngCanvases(a, b, true);
			assert.deepEqual(
				Array.from(required(required(base.image).layers[0]).pixels),
				[255, 0, 255, 255, 0, 255, 255, 255, 0, 0, 0, 0],
			);
			const scaled = comparePngCanvases(a, b, true, 2);
			assert.deepEqual(scaled.report, base.report);
			assert.equal(required(scaled.image).width, 6);
			assert.equal(required(scaled.image).height, 2);
			const row = [
				255, 0, 255, 255, 255, 0, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255,
				0, 0, 0, 0, 0, 0, 0, 0,
			];
			assert.deepEqual(
				Array.from(required(required(scaled.image).layers[0]).pixels),
				[...row, ...row],
			);
		},
	},
	{
		name: "compare validates dimensions scale and image budget",
		run() {
			assert.throws(
				() => comparePngCanvases(canvas(1, 1), canvas(2, 1)),
				/INVALID_ARGUMENT/,
			);
			for (const scale of [0, 17, 1.5, Number.NaN])
				assert.throws(
					() => comparePngCanvases(canvas(1, 1), canvas(1, 1), false, scale),
					/INVALID_ARGUMENT/,
				);
			const large = canvas(1025, 1);
			assert.equal(comparePngCanvases(large, large).report.totalPixels, 1025);
			assert.throws(
				() => comparePngCanvases(large, large, true),
				/RESOURCE_LIMIT_EXCEEDED/,
			);
			const edge = canvas(64, 1);
			assert.equal(
				required(comparePngCanvases(edge, edge, true, 16).image).width,
				1024,
			);
			assert.throws(
				() => comparePngCanvases(canvas(65, 1), canvas(65, 1), true, 16),
				/RESOURCE_LIMIT_EXCEEDED/,
			);
		},
	},
	{
		name: "compare CLI MCP reports agree and report-only writes nothing",
		async run() {
			await fixture(async (root, a, b) => {
				const c = await cli(a, b);
				assert.equal(c.code, 0);
				const m = await handleCompareAssets({ beforePath: a, afterPath: b });
				const text = required(m.content[0]);
				assert.equal(text.type, "text");
				const report = JSON.parse(text.type === "text" ? text.text : "null");
				assert.deepEqual(
					JSON.parse(Buffer.from(c.out).toString()).result,
					report,
				);
				assert.equal(report.rawChangedPixels, 2);
				assert.equal(report.visibleChangedPixels, 1);
				assert.deepEqual((await readdir(root)).sort(), [
					"before.png",
					"other-name.png",
				]);
			});
		},
	},
	{
		name: "compare MCP image is a standard block without duplicate base64",
		async run() {
			await fixture(async (_root, a, b) => {
				const m = await handleCompareAssets({
					beforePath: a,
					afterPath: b,
					image: "diff",
					scale: 2,
				});
				assert.equal(m.content.length, 2);
				const image = required(m.content[1]);
				assert.equal(image.type, "image");
				if (image.type !== "image") throw new Error("image block missing");
				assert.equal(image.mimeType, "image/png");
				const decoded = decodePng(Buffer.from(image.data, "base64")).canvas;
				assert.equal(decoded.width, 4);
				assert.deepEqual(
					Array.from(required(decoded.layers[0]).pixels.slice(0, 4)),
					[255, 0, 255, 255],
				);
				assert.ok(!JSON.stringify(m.content[0]).includes(image.data));
			});
		},
	},
	{
		name: "compare output safety refuses aliases links exists and missing parents",
		async run() {
			await fixture(async (root, a, b) => {
				const existing = join(root, "existing.png");
				await writeFile(existing, "sentinel");
				const link = join(root, "link.png");
				await symlink(a, link);
				const parent = join(root, "linked");
				await symlink(root, parent);
				for (const output of [
					a,
					b,
					join(root, ".", "before.png"),
					link,
					existing,
					join(parent, "new.png"),
					join(root, "missing", "new.png"),
					join(root, "wrong.json"),
				]) {
					const r = await cli(a, b, { output });
					assert.notEqual(r.code, 0, output);
					assert.equal(await readFile(existing, "utf8"), "sentinel");
				}
				for (const output of [a, b, link, join(parent, "new.png")])
					assert.notEqual((await cli(a, b, { output, force: true })).code, 0);
				assert.equal(
					(await cli(a, b, { output: existing, force: true })).code,
					0,
				);
				assert.equal(
					(
						await cli(a, b, {
							output: join(root, "created", "new.png"),
							mkdir: true,
						})
					).code,
					0,
				);
			});
		},
	},
	{
		name: "compare stdout failures emit zero artifact bytes",
		async run() {
			await fixture(async (root, a, b) => {
				for (const options of [
					{ stdout: true, output: join(root, "out.png") },
					{ stdout: true, scale: "0" },
					{ stdout: true, scale: "17" },
				]) {
					const r = await cli(a, b, options);
					assert.notEqual(r.code, 0);
					assert.equal(r.out.length, 0);
				}
				const wrong = join(root, "wrong.png");
				await writeFile(wrong, encodePng(canvas(1, 1)));
				const r = await cli(a, wrong, { stdout: true });
				assert.notEqual(r.code, 0);
				assert.equal(r.out.length, 0);
			});
		},
	},
	{
		name: "compare MCP rejects output without image and outputless write flags",
		async run() {
			await fixture(async (root, a, b) => {
				for (const flags of [
					{ outputPath: join(root, "new.png") },
					{ force: true },
					{ mkdir: true },
				]) {
					const r = await handleCompareAssets({
						beforePath: a,
						afterPath: b,
						...flags,
					});
					assert.equal(r.isError, true);
				}
			});
		},
	},
];
