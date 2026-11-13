import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { McAssetError } from "../core/errors.ts";
import { decodePng } from "../io/png.ts";
import { lintStyle } from "../style/lint.ts";
import { resolveStyle } from "../style/load.ts";
import { scanPack } from "../validate/pack.ts";
import { parseLockText } from "./lock.ts";

/**
 * Whole-pack check summary: pack validation plus per-texture style
 * measurement, grouped findings, and an error-first fix list.
 */

export interface PackCheckInput {
	readonly projectPath: string;
	readonly vanillaPath?: string | undefined;
}

export interface PackCheckGroup {
	readonly code: string;
	readonly count: number;
}

export interface PackCheckFix {
	readonly code: string;
	readonly level: string;
	readonly count: number;
	readonly samplePaths: readonly string[];
	readonly suggestion: string;
}

export interface PackCheckSummary {
	readonly verdict: string;
	readonly groups: readonly PackCheckGroup[];
	readonly fixList: readonly PackCheckFix[];
	readonly textureCount: number;
}

interface RawFinding {
	readonly code: string;
	readonly level: string;
	readonly path?: string | undefined;
	readonly message?: string | undefined;
	readonly suggestion?: string | undefined;
}

const CATEGORY_SUFFIXES: readonly [string, string][] = [
	["_sword.png", "sword"],
	["_pickaxe.png", "pickaxe"],
	["_axe.png", "axe"],
	["_shovel.png", "shovel"],
	["_hoe.png", "hoe"],
	["_ingot.png", "ingot"],
];

function inferCategoryFromFilename(filename: string): string {
	const lower = filename.toLowerCase();
	for (const [suffix, cat] of CATEGORY_SUFFIXES) {
		if (lower.endsWith(suffix)) {
			return cat;
		}
	}
	return "generic";
}

/**
 * Lock kinds a recipe generator writes as a PNG texture. A generated armor
 * sheet, icon atlas, particle sprite, or entity template is judged by its
 * generator, not by the hand-painted sprite rules of the style presets, and
 * the client binds some of these families from its renderers rather than from
 * a document inside the pack, so the scan can never observe a reference.
 * The lock is what tells them apart from a hand-drawn file: a texture the
 * lock does not name under one of these kinds keeps exactly the findings the
 * check reported before generator steps existed, and so does a project with
 * no lock at all.
 */
const GENERATED_TEXTURE_KINDS: ReadonlySet<string> = new Set([
	"entityTemplate",
	"equipmentTexture",
	"fontAtlas",
	"particleTexture",
]);

/**
 * Pack-relative paths of the textures a recipe generator wrote, read from the
 * lock document. An absent, unreadable, or unparsable lock suppresses
 * nothing: the lock belongs to the build, and a check that cannot read it
 * still reports what the pack holds, byte for byte as before.
 */
function lockGeneratedTextures(
	projectDir: string,
	packDir: string,
): ReadonlySet<string> {
	const generated = new Set<string>();
	const lockPath = join(projectDir, "mc-asset.lock.json");
	if (!existsSync(lockPath)) {
		return generated;
	}
	try {
		const lock = parseLockText(readFileSync(lockPath, "utf8"));
		for (const [path, entry] of Object.entries(lock.outputs)) {
			if (!GENERATED_TEXTURE_KINDS.has(entry.kind)) {
				continue;
			}
			const rel = relative(packDir, resolve(projectDir, path)).replace(
				/\\/g,
				"/",
			);
			if (rel !== "" && rel !== ".." && !rel.startsWith("../")) {
				generated.add(rel);
			}
		}
	} catch {
		return new Set();
	}
	return generated;
}

/** Check a pack project and summarize what to fix first. */
export async function checkResourcePack(
	input: PackCheckInput,
): Promise<PackCheckSummary> {
	const resolvedProject = resolve(input.projectPath);
	const projectDir = dirname(resolvedProject);
	const findings: RawFinding[] = [];

	let outputDir = "pack";
	let styleName = "vanilla";
	let vanillaSource: string | undefined;

	if (!existsSync(resolvedProject)) {
		findings.push({
			code: "PACK_PROJECT_NOT_FOUND",
			level: "error",
			path: input.projectPath,
			message: `Project document not found: ${input.projectPath}.`,
			suggestion: "Create mc-asset.pack.json with pack init.",
		});
	} else {
		try {
			const projectText = readFileSync(resolvedProject, "utf8");
			const projectDoc = JSON.parse(projectText) as {
				outputDir?: string;
				style?: string;
				vanillaSource?: { path?: string } | null;
			};
			if (
				typeof projectDoc.outputDir === "string" &&
				projectDoc.outputDir !== ""
			) {
				outputDir = projectDoc.outputDir;
			}
			if (typeof projectDoc.style === "string" && projectDoc.style !== "") {
				styleName = projectDoc.style;
			}
			if (
				projectDoc.vanillaSource &&
				typeof projectDoc.vanillaSource.path === "string"
			) {
				vanillaSource = projectDoc.vanillaSource.path;
			}
		} catch {
			findings.push({
				code: "PACK_PROJECT_INVALID",
				level: "error",
				path: input.projectPath,
				message: `Project document is not valid JSON: ${input.projectPath}.`,
				suggestion: "Ensure mc-asset.pack.json is valid JSON.",
			});
		}
	}

	const packDir = resolve(projectDir, outputDir);
	const generatedTextures = lockGeneratedTextures(projectDir, packDir);
	const mcmetaPath = join(packDir, "pack.mcmeta");
	if (!existsSync(mcmetaPath)) {
		findings.push({
			code: "PACK_MCMETA_INVALID",
			level: "error",
			path: mcmetaPath,
			message: `Pack root metadata pack.mcmeta is missing in ${packDir}.`,
			suggestion: "Generate pack.mcmeta or initialize the project skeleton.",
		});
	}

	if (existsSync(packDir)) {
		const vanilla =
			input.vanillaPath ??
			(vanillaSource !== undefined
				? resolve(projectDir, vanillaSource)
				: undefined);
		try {
			const scanResult = await scanPack(packDir, { vanillaPath: vanilla });
			for (const f of scanResult.findings) {
				if (
					f.code === "PACK_ORPHAN_TEXTURE" &&
					f.path !== undefined &&
					generatedTextures.has(f.path)
				) {
					continue;
				}
				findings.push({
					code: f.code,
					level: f.level,
					path: f.path,
					message: f.message,
					suggestion: `Fix pack finding: ${f.code}.`,
				});
			}
		} catch (error) {
			if (error instanceof McAssetError) {
				findings.push({
					code: error.code,
					level: "error",
					path: packDir,
					message: error.message,
					suggestion: "Ensure pack directory structure is valid.",
				});
			}
		}
	}

	let textureCount = 0;
	let resolvedStyleObj: Awaited<ReturnType<typeof resolveStyle>> | undefined;
	try {
		resolvedStyleObj = await resolveStyle(styleName, { baseDir: projectDir });
	} catch (error) {
		if (!(error instanceof McAssetError)) {
			throw error;
		}
		findings.push({
			code: error.code,
			level: "error",
			path: resolvedProject,
			message: `${error.message} style "${styleName}" resolved against ${projectDir}`,
			suggestion: `Fix the project style "${styleName}" (resolved against ${projectDir}) or use a builtin preset id.`,
		});
	}

	// Scan PNG textures in pack/assets
	const assetsDir = join(packDir, "assets");
	if (existsSync(assetsDir) && resolvedStyleObj !== undefined) {
		function walkTextures(current: string): void {
			let entries: string[] = [];
			try {
				entries = readdirSync(current).sort();
			} catch {
				return;
			}
			for (const name of entries) {
				const full = join(current, name);
				try {
					const st = statSync(full);
					if (st.isDirectory()) {
						walkTextures(full);
					} else if (st.isFile() && name.toLowerCase().endsWith(".png")) {
						textureCount += 1;
						const rel = relative(packDir, full).replace(/\\/g, "/");
						if (generatedTextures.has(rel)) {
							continue;
						}
						const bytes = readFileSync(full);
						const decoded = decodePng(new Uint8Array(bytes));
						const category = inferCategoryFromFilename(name);
						const lintReport = lintStyle({
							canvas: decoded.canvas,
							path: rel,
							style: resolvedStyleObj as never,
							category,
							firstFrameOnly: true,
						});
						for (const f of lintReport.findings) {
							findings.push({
								code: f.code,
								level: f.level,
								path: rel,
								message: f.message,
								suggestion: f.suggestion,
							});
						}
					}
				} catch {
					// Ignore unreadable individual files
				}
			}
		}
		walkTextures(assetsDir);
	}

	// Group findings
	const groupCounts = new Map<string, number>();
	const fixEntries = new Map<
		string,
		{
			level: string;
			count: number;
			samplePaths: string[];
			suggestion: string;
		}
	>();

	for (const f of findings) {
		groupCounts.set(f.code, (groupCounts.get(f.code) ?? 0) + 1);
		const existing = fixEntries.get(f.code);
		if (existing === undefined) {
			fixEntries.set(f.code, {
				level: f.level,
				count: 1,
				samplePaths: f.path ? [f.path] : [],
				suggestion: f.suggestion ?? f.message ?? "",
			});
		} else {
			existing.count += 1;
			if (f.level === "error") {
				existing.level = "error";
			}
			if (
				f.path &&
				!existing.samplePaths.includes(f.path) &&
				existing.samplePaths.length < 3
			) {
				existing.samplePaths.push(f.path);
			}
			if (existing.suggestion === "" && f.suggestion) {
				existing.suggestion = f.suggestion;
			}
		}
	}

	const groups: PackCheckGroup[] = [...groupCounts.entries()]
		.map(([code, count]) => ({ code, count }))
		.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

	const fixList: PackCheckFix[] = [...fixEntries.entries()]
		.map(([code, data]) => ({
			code,
			level: data.level,
			count: data.count,
			samplePaths: data.samplePaths,
			suggestion: data.suggestion,
		}))
		.sort((a, b) => {
			if (a.level !== b.level) {
				return a.level === "error" ? -1 : 1;
			}
			if (a.count !== b.count) {
				return b.count - a.count;
			}
			return a.code.localeCompare(b.code);
		});

	let verdict = "pass";
	if (findings.some((f) => f.level === "error")) {
		verdict = "fail";
	} else if (findings.some((f) => f.level === "warning")) {
		verdict = "pass with warnings";
	}

	return {
		verdict,
		groups,
		fixList,
		textureCount,
	};
}
