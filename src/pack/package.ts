import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { atomicWriteFile } from "../cli/filesystem.ts";
import { McAssetError } from "../core/errors.ts";
import { writeZip, type ZipWriteEntry } from "../io/zip-write.ts";

/**
 * Reproducible pack delivery: the output directory becomes a zip whose
 * root is pack.mcmeta. Project documents, recipe directories, lock files,
 * dot segments, and __MACOSX entries never ship; everything else sorts
 * by UTF-8 byte order with fixed timestamps.
 */

export interface PackPackageInput {
	readonly projectPath: string;
	readonly outputPath: string;
	readonly force?: boolean | undefined;
	readonly mkdir?: boolean | undefined;
}

export interface PackPackageReport {
	readonly outputPath: string;
	readonly fileCount: number;
	readonly totalBytes: number;
}

const EXCLUDED_BASENAMES = new Set([
	"mc-asset.pack.json",
	"mc-asset.lock.json",
	"recipes",
	"__MACOSX",
]);

function shouldExclude(name: string): boolean {
	if (name.startsWith(".") || EXCLUDED_BASENAMES.has(name)) {
		return true;
	}
	return false;
}

/** Collect all packageable files under the pack root directory. */
function collectPackFiles(packDir: string): ZipWriteEntry[] {
	const entries: ZipWriteEntry[] = [];

	function walk(currentDir: string): void {
		const names = readdirSync(currentDir).sort();
		for (const name of names) {
			if (shouldExclude(name)) {
				continue;
			}
			const fullPath = join(currentDir, name);
			const st = statSync(fullPath);
			if (st.isDirectory()) {
				walk(fullPath);
			} else if (st.isFile()) {
				const rel = relative(packDir, fullPath).replace(/\\/g, "/");
				const data = new Uint8Array(readFileSync(fullPath));
				entries.push({ name: rel, data });
			}
		}
	}

	walk(packDir);
	return entries;
}

/** Package a built pack directory into a reproducible zip. */
export async function packageResourcePack(
	input: PackPackageInput,
): Promise<PackPackageReport> {
	const resolvedProject = resolve(input.projectPath);
	if (!existsSync(resolvedProject)) {
		throw new McAssetError(
			"PACK_PROJECT_NOT_FOUND",
			`Project document not found: ${input.projectPath}.`,
			{ projectPath: input.projectPath, outputPath: input.outputPath },
		);
	}

	let outputDir = "pack";
	try {
		const text = readFileSync(resolvedProject, "utf8");
		const parsed = JSON.parse(text) as { outputDir?: string };
		if (typeof parsed.outputDir === "string" && parsed.outputDir !== "") {
			outputDir = parsed.outputDir;
		}
	} catch {
		// Fall back to default pack directory
	}

	const packDir = resolve(dirname(resolvedProject), outputDir);
	if (!existsSync(packDir) || !statSync(packDir).isDirectory()) {
		throw new McAssetError(
			"PACK_PROJECT_NOT_FOUND",
			`Pack directory not found: ${packDir}.`,
			{ projectPath: input.projectPath, outputPath: input.outputPath },
		);
	}

	const entries = collectPackFiles(packDir);
	if (entries.length === 0) {
		throw new McAssetError(
			"PACK_PROJECT_NOT_FOUND",
			`Pack directory contains no packageable assets: ${packDir}.`,
			{ projectPath: input.projectPath, outputPath: input.outputPath },
		);
	}

	const zipBytes = writeZip(entries);

	await atomicWriteFile(resolve(input.outputPath), zipBytes, {
		force: input.force === true,
		mkdir: input.mkdir === true,
	});

	return {
		outputPath: input.outputPath,
		fileCount: entries.length,
		totalBytes: zipBytes.length,
	};
}
