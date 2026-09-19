import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * analyze intake spawn coverage: PNG/JPEG/WebP report the frozen V0.1
 * fields plus the three V0.2 groups, stay read-only, and rerun
 * byte-identical. Fixture provenance: see tests/io/decode-cases.ts
 * (self-made 8x8 pattern, jpeg-js q90, cwebp lossless-exact and lossy
 * q80; no Mojang assets).
 */

const FIXTURES = "tests/cli/fixtures";
const PNG = join(FIXTURES, "px-8x8.png");
const JPG = join(FIXTURES, "px-8x8.jpg");
const WEBP_LOSSLESS = join(FIXTURES, "px-lossless.webp");
const WEBP_LOSSY = join(FIXTURES, "px-lossy-q80.webp");
const SWORD_MCPX = join(FIXTURES, "sword.mcpx");

interface SpawnResult {
	code: number;
	stdout: Uint8Array;
	stderr: string;
}

function combinedText(stdout: Uint8Array, stderr: string): string {
	return Buffer.from(stdout).toString("utf-8") + stderr;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function runCli(args: string[]): Promise<SpawnResult> {
	const proc = Bun.spawn(["bun", "src/cli/index.ts", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout: new Uint8Array(stdout), stderr };
}

interface AnalyzeResultShape {
	dimensions: { width: number; height: number };
	totalPixels: number;
	colorCount: number;
	alpha: Record<string, unknown>;
	dominantColors: unknown[];
	profile: Record<string, unknown>;
	warnings: unknown[];
	paletteCharacteristics: {
		colorCount: number;
		alphaLevels: number;
		roles: Array<{ role: string; count: number }>;
		transparentPixels: number;
		partialAlphaPixels: number;
	};
	pixelArtCharacteristics: {
		resolution: { width: number; height: number };
		aspect: string;
		isolatedPixels: number;
		semiTransparentPixels: number;
		paletteSize: number;
		tileFriendly: boolean;
	};
	recommended: {
		quantize: { colors: number };
		cleanup: { classes: string[] };
		resize: { mode: string };
	};
	version: Record<string, unknown>;
	target: string;
}

function readResult(stdout: string): AnalyzeResultShape {
	const envelope = JSON.parse(stdout) as {
		success: boolean;
		result: AnalyzeResultShape;
	};
	expect(envelope.success).toBe(true);
	return envelope.result;
}

function checkFrozenShape(result: AnalyzeResultShape): void {
	for (const key of [
		"dimensions",
		"totalPixels",
		"colorCount",
		"alpha",
		"dominantColors",
		"profile",
		"warnings",
		"paletteCharacteristics",
		"pixelArtCharacteristics",
		"recommended",
		"version",
		"target",
	]) {
		expect(result).toHaveProperty(key);
	}
	expect(result.dimensions).toEqual({ width: 8, height: 8 });
	expect(result.totalPixels).toBe(64);
	expect(typeof result.colorCount).toBe("number");
	expect(result.pixelArtCharacteristics.resolution).toEqual({
		width: 8,
		height: 8,
	});
	expect(result.pixelArtCharacteristics.aspect).toBe("1:1");
	expect(typeof result.pixelArtCharacteristics.tileFriendly).toBe("boolean");
	expect(typeof result.recommended.quantize.colors).toBe("number");
	expect(Array.isArray(result.recommended.cleanup.classes)).toBe(true);
	const text = JSON.stringify(result).toLowerCase();
	expect(text).toContain("predicted");
	expect(text.includes("effective")).toBe(false);
}

describe("analyze intake via spawn", () => {
	test("png reports frozen fields plus the three new groups", async () => {
		const { stdout, code } = await runCli(["analyze", PNG, "--json"]);
		expect(code).toBe(0);
		checkFrozenShape(readResult(Buffer.from(stdout).toString("utf-8")));
	}, 30_000);

	test("jpeg intake succeeds with the extended shape", async () => {
		const { stdout, stderr, code } = await runCli(["analyze", JPG, "--json"]);
		expect(code).toBe(0);
		expect(stderr).not.toContain('"success":true');
		checkFrozenShape(readResult(Buffer.from(stdout).toString("utf-8")));
	}, 30_000);

	test("webp intake succeeds for lossless and lossy", async () => {
		for (const input of [WEBP_LOSSLESS, WEBP_LOSSY]) {
			const { stdout, code } = await runCli(["analyze", input, "--json"]);
			expect(code).toBe(0);
			checkFrozenShape(readResult(Buffer.from(stdout).toString("utf-8")));
		}
	}, 60_000);

	test("human output appends palette, pixel-art, and recommended lines", async () => {
		const { stdout, code } = await runCli(["analyze", PNG]);
		expect(code).toBe(0);
		const text = Buffer.from(stdout).toString("utf-8");
		expect(text).toContain("dimensions: 8x8");
		expect(text).toContain("profile: ");
		expect(text).toMatch(/palette: colorCount=\d+ alphaLevels=\d+/);
		expect(text).toMatch(/pixel-art: 8x8 aspect=1:1 isolated=\d+/);
		expect(text).toMatch(
			/recommended: quantize\.colors=\d+ cleanup=\S+ resize=\S+/,
		);
		const profileAt = text.indexOf("profile: ");
		const paletteAt = text.indexOf("palette: ");
		const pixelArtAt = text.indexOf("pixel-art: ");
		const recommendedAt = text.indexOf("recommended: ");
		expect(paletteAt).toBeGreaterThan(profileAt);
		expect(pixelArtAt).toBeGreaterThan(paletteAt);
		expect(recommendedAt).toBeGreaterThan(pixelArtAt);
	}, 30_000);

	test(".mcpx input is rejected as unsupported with exit 5", async () => {
		const { stdout, stderr, code } = await runCli([
			"analyze",
			SWORD_MCPX,
			"--json",
		]);
		expect(code).toBe(5);
		const envelope = JSON.parse(Buffer.from(stdout).toString("utf-8")) as {
			success: boolean;
			error: { code: string };
		};
		expect(envelope.success).toBe(false);
		expect(envelope.error.code).toBe("UNSUPPORTED_IMAGE_FORMAT");
		expect(combinedText(stdout, stderr)).toContain("UNSUPPORTED_IMAGE_FORMAT");
	}, 30_000);

	test("non-image bytes are unsupported with exit 5", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-anlz-"));
		try {
			const input = join(dir, "note.txt");
			await writeFile(input, "not an image");
			const { stdout, code } = await runCli(["analyze", input, "--json"]);
			expect(code).toBe(5);
			const envelope = JSON.parse(Buffer.from(stdout).toString("utf-8")) as {
				success: boolean;
				error: { code: string };
			};
			expect(envelope.success).toBe(false);
			expect(envelope.error.code).toBe("UNSUPPORTED_IMAGE_FORMAT");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("inputs stay read-only across all three formats", async () => {
		for (const input of [PNG, JPG, WEBP_LOSSLESS, WEBP_LOSSY]) {
			const before = sha256(new Uint8Array(await readFile(input)));
			const { code } = await runCli(["analyze", input, "--json"]);
			expect(code).toBe(0);
			expect(sha256(new Uint8Array(await readFile(input)))).toBe(before);
		}
	}, 60_000);

	test("reruns are byte-identical", async () => {
		const first = await runCli(["analyze", PNG, "--json"]);
		const second = await runCli(["analyze", PNG, "--json"]);
		expect(first.code).toBe(0);
		expect(second.code).toBe(0);
		expect(Buffer.from(second.stdout).equals(Buffer.from(first.stdout))).toBe(
			true,
		);
	}, 60_000);
});
