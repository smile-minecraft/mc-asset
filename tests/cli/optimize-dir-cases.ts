import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OptimizeCliOptions } from "../../src/cli/cmd-optimize.ts";
import { decodePng, flattenCanvas } from "../../src/io/png.ts";
import { handleOptimizeAsset } from "../../src/mcp/handlers-model-optimize.ts";
import { PNG_VECTORS } from "../io/png-cases.ts";
import { type CliResult, stdoutText } from "./optimize-model-cases.ts";

export interface OptimizeDirSurface {
	optimize(
		inputs: readonly string[],
		options: OptimizeCliOptions,
	): Promise<CliResult>;
}

export const optimizeDirCases: {
	name: string;
	run(surface: OptimizeDirSurface): Promise<void>;
}[] = [];

function add(
	name: string,
	body: (root: string, surface: OptimizeDirSurface) => Promise<void>,
): void {
	optimizeDirCases.push({
		name,
		async run(surface) {
			const root = await mkdtemp(join(tmpdir(), "opt-dir-"));
			try {
				await body(root, surface);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	});
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("expected object in JSON");
	}
	return value as JsonObject;
}

function parseEnvelope(
	result: CliResult,
	stream?: "stdout" | "stderr",
): JsonObject {
	let raw = "";
	if (stream === "stdout") {
		raw = stdoutText(result);
	} else if (stream === "stderr") {
		raw = result.stderr;
	} else {
		raw = stdoutText(result).trim();
		if (raw === "") raw = result.stderr;
	}
	const text = raw
		.trim()
		.split("\n")
		.filter((line) => line.trim() !== "")
		.pop();
	if (text === undefined) {
		throw new Error("no envelope on stdout or stderr");
	}
	return asObject(JSON.parse(text));
}

function parseError(
	result: CliResult,
	stream?: "stdout" | "stderr",
): {
	code: string;
	details: JsonObject;
} {
	const envelope = parseEnvelope(result, stream);
	const error = asObject(envelope.error);
	return {
		code: String(error.code),
		details: asObject(error.details ?? {}),
	};
}

function report(result: CliResult): JsonObject {
	return asObject(parseEnvelope(result).result);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

function samplePngBytes(): Uint8Array {
	return Buffer.from(PNG_VECTORS.V_PATTERN_2X2, "base64");
}

// 1. Nested directories with identical base filenames
add(
	"directory scan preserves nested paths with identical filenames",
	async (root, surface) => {
		const inDir = join(root, "input");
		await mkdir(join(inDir, "weapons"), { recursive: true });
		await mkdir(join(inDir, "tools"), { recursive: true });
		await writeFile(join(inDir, "weapons", "sword.png"), samplePngBytes());
		await writeFile(join(inDir, "tools", "sword.png"), samplePngBytes());

		const result = await surface.optimize([], {
			inputDir: inDir,
			recursive: true,
			dryRun: true,
		});
		if (result.code !== 0)
			throw new Error(`exit ${result.code}: ${result.stderr}`);

		const body = report(result);
		const files = (body.files as JsonObject[]).map((f) => String(f.input));
		if (files.length !== 2)
			throw new Error(`expected 2 files, got ${files.length}`);
		if (
			!files.some(
				(f) =>
					f.includes("weapons/sword.png") || f.includes("weapons\\sword.png"),
			)
		) {
			throw new Error("missing weapons/sword.png");
		}
		if (
			!files.some(
				(f) => f.includes("tools/sword.png") || f.includes("tools\\sword.png"),
			)
		) {
			throw new Error("missing tools/sword.png");
		}
	},
);

// 2. Consistent UTF-8 byte sorting regardless of creation order
add(
	"directory scan sorts strictly by UTF-8 bytes of relative path",
	async (root, surface) => {
		const inDir = join(root, "input");
		await mkdir(join(inDir, "nested"), { recursive: true });
		// Create out of order
		await writeFile(join(inDir, "z.png"), samplePngBytes());
		await writeFile(join(inDir, "b.png"), samplePngBytes());
		await writeFile(join(inDir, "nested", "c.png"), samplePngBytes());
		await writeFile(join(inDir, "a.png"), samplePngBytes());

		const result = await surface.optimize([], {
			inputDir: inDir,
			recursive: true,
			dryRun: true,
		});
		if (result.code !== 0)
			throw new Error(`exit ${result.code}: ${result.stderr}`);

		const body = report(result);
		const files = (body.files as JsonObject[]).map((f) => String(f.input));
		const baseNames = files.map((f) => f.split(/[/\\]/).pop());
		if (
			baseNames[0] !== "a.png" ||
			baseNames[1] !== "b.png" ||
			baseNames[2] !== "c.png" ||
			baseNames[3] !== "z.png"
		) {
			throw new Error(`unexpected sort order: ${baseNames.join(", ")}`);
		}
	},
);

// 3. Case-folding alias between source and output rejected
add(
	"case folding alias between source and output directory is rejected",
	async (root, surface) => {
		const inDir = join(root, "assets");
		await mkdir(inDir);
		await writeFile(join(inDir, "test.png"), samplePngBytes());

		const result = await surface.optimize([], {
			inputDir: inDir,
			outputDir: join(root, "ASSETS"),
		});
		const err = parseError(result);
		if (err.code !== "ARGUMENT_CONFLICT") {
			throw new Error(`expected ARGUMENT_CONFLICT, got ${err.code}`);
		}
	},
);

// 4. Output directory inside source directory rejected
add(
	"output directory inside source directory is rejected",
	async (root, surface) => {
		const inDir = join(root, "assets");
		await mkdir(inDir);
		await writeFile(join(inDir, "test.png"), samplePngBytes());

		const result = await surface.optimize([], {
			inputDir: inDir,
			outputDir: join(inDir, "output"),
		});
		const err = parseError(result);
		if (err.code !== "ARGUMENT_CONFLICT") {
			throw new Error(`expected ARGUMENT_CONFLICT, got ${err.code}`);
		}
	},
);

// 5. Source directory inside output directory rejected
add(
	"source directory inside output directory is rejected",
	async (root, surface) => {
		const outDir = join(root, "bundle");
		const inDir = join(outDir, "sub");
		await mkdir(inDir, { recursive: true });
		await writeFile(join(inDir, "test.png"), samplePngBytes());

		const result = await surface.optimize([], {
			inputDir: inDir,
			outputDir: outDir,
		});
		const err = parseError(result);
		if (err.code !== "ARGUMENT_CONFLICT") {
			throw new Error(`expected ARGUMENT_CONFLICT, got ${err.code}`);
		}
	},
);

// 6. Symbolic link inside scan rejected
add("symbolic link in directory scan is rejected", async (root, surface) => {
	const inDir = join(root, "input");
	await mkdir(inDir);
	const target = join(root, "external.png");
	await writeFile(target, samplePngBytes());
	await symlink(target, join(inDir, "link.png"));

	const result = await surface.optimize([], {
		inputDir: inDir,
		dryRun: true,
	});
	const err = parseError(result);
	if (err.code !== "FILESYSTEM_ERROR") {
		throw new Error(`expected FILESYSTEM_ERROR, got ${err.code}`);
	}
	if (err.details.reason !== "symlink-not-supported") {
		throw new Error(
			`expected reason symlink-not-supported, got ${String(err.details.reason)}`,
		);
	}
});

// 7. Corrupted PNG terminates batch with zero writes
add(
	"corrupted PNG stops batch without writing any output",
	async (root, surface) => {
		const inDir = join(root, "input");
		const outDir = join(root, "output");
		await mkdir(inDir);
		await mkdir(outDir);
		await writeFile(join(inDir, "01-good.png"), samplePngBytes());
		await writeFile(
			join(inDir, "02-bad.png"),
			samplePngBytes().subarray(0, 15),
		);

		const result = await surface.optimize([], {
			inputDir: inDir,
			outputDir: outDir,
		});
		const err = parseError(result);
		if (err.code !== "UNSUPPORTED_IMAGE_FORMAT") {
			throw new Error(`expected UNSUPPORTED_IMAGE_FORMAT, got ${err.code}`);
		}
		const written = await readdir(outDir);
		if (written.length !== 0) {
			throw new Error(
				`output directory should be empty, found: ${written.join(", ")}`,
			);
		}
	},
);

// 8. Non-PNG regular files ignored
add(
	"non-PNG regular files in directory are silently skipped",
	async (root, surface) => {
		const inDir = join(root, "input");
		await mkdir(inDir);
		await writeFile(join(inDir, "notes.txt"), "some notes");
		await writeFile(join(inDir, "pack.mcmeta"), "{}");
		await writeFile(join(inDir, "image.png"), samplePngBytes());

		const result = await surface.optimize([], {
			inputDir: inDir,
			dryRun: true,
		});
		if (result.code !== 0)
			throw new Error(`exit ${result.code}: ${result.stderr}`);
		const body = report(result);
		const files = body.files as JsonObject[];
		if (files.length !== 1)
			throw new Error(`expected 1 file, got ${files.length}`);
		if (!String(files[0]?.input).endsWith("image.png")) {
			throw new Error("expected image.png in report");
		}
	},
);

// 9. No PNG files in directory throws INVALID_ARGUMENT
add(
	"directory with no PNG files throws INVALID_ARGUMENT",
	async (root, surface) => {
		const inDir = join(root, "input");
		await mkdir(inDir);
		await writeFile(join(inDir, "notes.txt"), "text only");

		const result = await surface.optimize([], {
			inputDir: inDir,
			dryRun: true,
		});
		const err = parseError(result);
		if (err.code !== "INVALID_ARGUMENT") {
			throw new Error(`expected INVALID_ARGUMENT, got ${err.code}`);
		}
	},
);

// 10. Empty directory throws INVALID_ARGUMENT
add("empty directory throws INVALID_ARGUMENT", async (root, surface) => {
	const inDir = join(root, "empty");
	await mkdir(inDir);

	const result = await surface.optimize([], {
		inputDir: inDir,
		dryRun: true,
	});
	const err = parseError(result);
	if (err.code !== "INVALID_ARGUMENT") {
		throw new Error(`expected INVALID_ARGUMENT, got ${err.code}`);
	}
});

// 11. 4096 / 4097 boundary via injected scanEntries
add(
	"4096 PNG files accepted and 4097 PNG files rejected via seam",
	async (root, surface) => {
		const inDir = join(root, "input");
		await mkdir(inDir);
		await writeFile(join(inDir, "real.png"), samplePngBytes());

		// 4096 entries accepted
		const accepted = await surface.optimize([], {
			inputDir: inDir,
			dryRun: true,
			seams: {
				scanEntries: async () =>
					Array.from({ length: 4096 }, (_, i) => ({
						relativePath: `p${String(i).padStart(4, "0")}.png`,
						fullPath: join(inDir, "real.png"),
					})),
			},
		});
		if (accepted.code !== 0)
			throw new Error(
				`expected exit 0 for 4096, got ${accepted.code}: ${accepted.stderr}`,
			);

		// 4097 entries rejected
		const rejected = await surface.optimize([], {
			inputDir: inDir,
			dryRun: true,
			seams: {
				scanEntries: async () =>
					Array.from({ length: 4097 }, (_, i) => ({
						relativePath: `p${String(i).padStart(4, "0")}.png`,
						fullPath: join(inDir, "real.png"),
					})),
			},
		});
		const err = parseError(rejected);
		if (err.code !== "RESOURCE_LIMIT_EXCEEDED") {
			throw new Error(
				`expected RESOURCE_LIMIT_EXCEEDED for 4097, got ${err.code}`,
			);
		}
		if (err.details.limit !== 4096 || err.details.actual !== 4097) {
			throw new Error("expected limit 4096 and actual 4097");
		}
	},
);

// 12. 256 MiB budget boundary via injected statFile
add(
	"256 MiB source budget boundary enforced via seam",
	async (root, surface) => {
		const inDir = join(root, "input");
		await mkdir(inDir);
		await writeFile(join(inDir, "f1.png"), samplePngBytes());
		await writeFile(join(inDir, "f2.png"), samplePngBytes());
		await writeFile(join(inDir, "f3.png"), samplePngBytes());

		// 3 files at 90 MiB each (94371840 <= 128 MiB single file limit), total 270 MiB > 256 MiB
		const rejected = await surface.optimize([], {
			inputDir: inDir,
			dryRun: true,
			seams: {
				statFile: async () => ({ size: 94371840 }),
			},
		});
		const err = parseError(rejected);
		if (err.code !== "RESOURCE_LIMIT_EXCEEDED") {
			throw new Error(
				`expected RESOURCE_LIMIT_EXCEEDED for >256MiB, got ${err.code}`,
			);
		}
		if (err.details.limit !== 268435456) {
			throw new Error(
				`expected limit 268435456, got ${String(err.details.limit)}`,
			);
		}
	},
);

// 13. 16,777,216 decoded pixels budget boundary via injected getPixelDimensions
add(
	"16,777,216 pixel budget boundary enforced via seam",
	async (root, surface) => {
		const inDir = join(root, "input");
		await mkdir(inDir);
		await writeFile(join(inDir, "real.png"), samplePngBytes());

		const rejected = await surface.optimize([], {
			inputDir: inDir,
			dryRun: true,
			seams: {
				getPixelDimensions: () => ({ width: 4096, height: 4097 }), // 16,781,312 > 16,777,216
			},
		});
		const err = parseError(rejected);
		if (err.code !== "RESOURCE_LIMIT_EXCEEDED") {
			throw new Error(
				`expected RESOURCE_LIMIT_EXCEEDED for >16M pixels, got ${err.code}`,
			);
		}
		if (err.details.limit !== 16777216) {
			throw new Error(
				`expected limit 16777216, got ${String(err.details.limit)}`,
			);
		}
	},
);

// 14. dry-run zero writes
add(
	"dry-run reports full summary without creating output directory or files",
	async (root, surface) => {
		const inDir = join(root, "input");
		const outDir = join(root, "output");
		await mkdir(inDir);
		await writeFile(join(inDir, "sample.png"), samplePngBytes());

		const result = await surface.optimize([], {
			inputDir: inDir,
			dryRun: true,
		});
		if (result.code !== 0)
			throw new Error(`exit ${result.code}: ${result.stderr}`);
		if (await pathExists(outDir)) {
			throw new Error("dry-run should not create output directory");
		}
		const body = report(result);
		if (body.dryRun !== true)
			throw new Error("expected dryRun: true in report");
		const files = body.files as JsonObject[];
		if (files.length !== 1) throw new Error("expected 1 file in report");
		if (files[0]?.output !== null)
			throw new Error("expected null output path in dry-run");
	},
);

// 15. Conflict on second target prevents writing first target
add(
	"conflict on later target aborts write before any file is created",
	async (root, surface) => {
		const inDir = join(root, "input");
		const outDir = join(root, "output");
		await mkdir(inDir);
		await mkdir(outDir);
		await writeFile(join(inDir, "a.png"), samplePngBytes());
		await writeFile(join(inDir, "b.png"), samplePngBytes());

		// Pre-create b.png in output without force
		await writeFile(join(outDir, "b.png"), "existing b");

		const result = await surface.optimize([], {
			inputDir: inDir,
			outputDir: outDir,
		});
		const err = parseError(result);
		if (err.code !== "OUTPUT_EXISTS") {
			throw new Error(`expected OUTPUT_EXISTS, got ${err.code}`);
		}
		if (await pathExists(join(outDir, "a.png"))) {
			throw new Error(
				"a.png should not have been written because b.png conflicted",
			);
		}
	},
);

// 16. In-flight write failure reports completed, failedTarget, notStarted
add(
	"partial write failure attaches completed, failedTarget, notStarted details",
	async (root, surface) => {
		const inDir = join(root, "input");
		const outDir = join(root, "output");
		await mkdir(inDir);
		await mkdir(outDir);
		await writeFile(join(inDir, "a.png"), samplePngBytes());
		await writeFile(join(inDir, "b.png"), samplePngBytes());
		await writeFile(join(inDir, "c.png"), samplePngBytes());

		const result = await surface.optimize([], {
			inputDir: inDir,
			outputDir: outDir,
			atomicSeams: {
				writeExclusive: async (path, data) => {
					if (path.includes("b.png")) {
						throw new Error("simulated disk error on b.png");
					}
					await writeFile(path, data);
				},
			},
		});
		const err = parseError(result);
		if (err.code !== "FILESYSTEM_ERROR") {
			throw new Error(`expected FILESYSTEM_ERROR, got ${err.code}`);
		}
		const completed = err.details.completed as string[];
		const failedTarget = err.details.failedTarget as string;
		const notStarted = err.details.notStarted as string[];
		if (completed.length !== 1 || !completed[0]?.endsWith("a.png")) {
			throw new Error(`unexpected completed: ${JSON.stringify(completed)}`);
		}
		if (!failedTarget.endsWith("b.png")) {
			throw new Error(`unexpected failedTarget: ${failedTarget}`);
		}
		if (notStarted.length !== 1 || !notStarted[0]?.endsWith("c.png")) {
			throw new Error(`unexpected notStarted: ${JSON.stringify(notStarted)}`);
		}
	},
);

// 17. CLI and MCP argument conflict validations
add(
	"CLI and MCP directory mode argument constraints",
	async (root, surface) => {
		const inDir = join(root, "input");
		await mkdir(inDir);
		const png = join(inDir, "sample.png");
		await writeFile(png, samplePngBytes());

		// CLI: positional inputs and inputDir conflict
		const conflictResult = await surface.optimize([png], { inputDir: inDir });
		if (parseError(conflictResult).code !== "ARGUMENT_CONFLICT") {
			throw new Error("expected ARGUMENT_CONFLICT for positional + inputDir");
		}

		// CLI: inputDir with --output conflicts
		const outputConflict = await surface.optimize([], {
			inputDir: inDir,
			output: join(root, "out.png"),
		});
		if (parseError(outputConflict).code !== "ARGUMENT_CONFLICT") {
			throw new Error("expected ARGUMENT_CONFLICT for inputDir + output");
		}

		// CLI: inputDir with --stdout conflicts
		const stdoutConflict = await surface.optimize([], {
			inputDir: inDir,
			stdout: true,
		});
		if (parseError(stdoutConflict).code !== "ARGUMENT_CONFLICT") {
			throw new Error("expected ARGUMENT_CONFLICT for inputDir + stdout");
		}

		// CLI: --recursive without inputDir conflicts
		const recursiveConflict = await surface.optimize([png], {
			recursive: true,
			dryRun: true,
		});
		if (parseError(recursiveConflict).code !== "ARGUMENT_CONFLICT") {
			throw new Error(
				"expected ARGUMENT_CONFLICT for --recursive without inputDir",
			);
		}

		// MCP: inputPaths + inputDir conflict
		const mcpConflict = await handleOptimizeAsset({
			inputPaths: [png],
			inputDir: inDir,
		});
		const conflictText =
			mcpConflict.content[0]?.type === "text"
				? mcpConflict.content[0].text
				: "";
		if (
			mcpConflict.isError !== true ||
			!conflictText.includes("ARGUMENT_CONFLICT")
		) {
			throw new Error(
				"expected MCP ARGUMENT_CONFLICT for inputPaths + inputDir",
			);
		}

		// MCP: neither inputPaths nor inputDir
		const mcpMissing = await handleOptimizeAsset({});
		const missingText =
			mcpMissing.content[0]?.type === "text" ? mcpMissing.content[0].text : "";
		if (
			mcpMissing.isError !== true ||
			!missingText.includes("INVALID_ARGUMENT")
		) {
			throw new Error("expected MCP INVALID_ARGUMENT when neither is provided");
		}

		// MCP: inputDir with outputPath conflict
		const mcpOutputConflict = await handleOptimizeAsset({
			inputDir: inDir,
			outputPath: join(root, "out.png"),
		});
		const outputConflictText =
			mcpOutputConflict.content[0]?.type === "text"
				? mcpOutputConflict.content[0].text
				: "";
		if (
			mcpOutputConflict.isError !== true ||
			!outputConflictText.includes("ARGUMENT_CONFLICT")
		) {
			throw new Error(
				"expected MCP ARGUMENT_CONFLICT for inputDir + outputPath",
			);
		}

		// MCP: inputDir without outputDir or dryRun
		const mcpNoDest = await handleOptimizeAsset({
			inputDir: inDir,
		});
		const noDestText =
			mcpNoDest.content[0]?.type === "text" ? mcpNoDest.content[0].text : "";
		if (
			mcpNoDest.isError !== true ||
			!noDestText.includes("INVALID_ARGUMENT")
		) {
			throw new Error(
				"expected MCP INVALID_ARGUMENT for inputDir without outputDir/dryRun",
			);
		}
	},
);

// 18. End-to-end directory optimization correctness (RED TEST for Coder)
add(
	"directory optimize preserves relative structure and decodes identical pixels",
	async (root, surface) => {
		const inDir = join(root, "input");
		const outDir = join(root, "output");
		await mkdir(join(inDir, "blocks"), { recursive: true });
		await mkdir(join(inDir, "items"), { recursive: true });

		const stone = join(inDir, "blocks", "stone.png");
		const sword = join(inDir, "items", "sword.png");
		await writeFile(stone, samplePngBytes());
		await writeFile(sword, samplePngBytes());

		const result = await surface.optimize([], {
			inputDir: inDir,
			outputDir: outDir,
			recursive: true,
			mkdir: true,
		});
		if (result.code !== 0)
			throw new Error(`exit ${result.code}: ${result.stderr}`);

		// Assert output files exist at preserved relative paths
		const outStone = join(outDir, "blocks", "stone.png");
		const outSword = join(outDir, "items", "sword.png");
		const stoneExists = await pathExists(outStone);
		if (!stoneExists) {
			throw new Error(`expected output file to exist: ${outStone}`);
		}
		const swordExists = await pathExists(outSword);
		if (!swordExists) {
			throw new Error(`expected output file to exist: ${outSword}`);
		}

		// Assert decoded pixels match source exactly
		const srcDecoded = decodePng(await readFile(stone));
		const outDecoded = decodePng(await readFile(outStone));
		if (
			srcDecoded.canvas.width !== outDecoded.canvas.width ||
			srcDecoded.canvas.height !== outDecoded.canvas.height
		) {
			throw new Error("dimensions mismatch");
		}
		const srcPixels = flattenCanvas(srcDecoded.canvas);
		const outPixels = flattenCanvas(outDecoded.canvas);
		if (Buffer.compare(Buffer.from(srcPixels), Buffer.from(outPixels)) !== 0) {
			throw new Error("pixel data mismatch between source and output");
		}

		// Assert totals
		const body = report(result);
		const totals = asObject(body.totals);
		if (totals.files !== 2) {
			throw new Error(
				`expected totals.files to be 2, got ${String(totals.files)}`,
			);
		}
	},
);
