import type { Stats } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";
import {
	type OutputTarget,
	planOutputTargets,
	writePlannedTargets,
} from "../cli/safe-output.ts";
import { McAssetError } from "../core/errors.ts";
import {
	comparePackFormats,
	normalizePackFormat,
} from "../profiles/versions.ts";
import { checkPackMcmeta } from "../validate/pack-mcmeta.ts";
import {
	canonicalDocumentText,
	formatValue,
	isKnownStyleReference,
	type ProjectDocumentContext,
	projectDocumentFailure,
} from "./document.ts";
import { parsePackProjectText } from "./load.ts";
import {
	buildPlaceholderIcon,
	compareCodeUnits,
	planSkeletonDirectories,
} from "./skeleton.ts";
import {
	PACK_DEFAULT_OUTPUT_DIR,
	PACK_DEFAULT_RECIPE_DIR,
	PACK_DEFAULT_STYLE,
	PACK_DESCRIPTION_MAX_LENGTH,
	PACK_DESCRIPTION_MIN_LENGTH,
	PACK_ICON_FILE_NAME,
	PACK_IDENTIFIER_PATTERN,
	PACK_MINECRAFT_NAMESPACE,
	PACK_NAMESPACE_PATTERN,
	PACK_PROJECT_FILE_NAME,
	PACK_PROJECT_FORMAT_VERSION,
	PACK_ROOT_METADATA_FILE_NAME,
	type PackInitFile,
	type PackInitPlan,
	type PackInitRequest,
	type PackInitResult,
	type PackInitVersion,
	type PackProjectDocument,
} from "./types.ts";
import { releasePackFormat } from "./versions.ts";

/**
 * Project initialization: read the request, plan every path it would create,
 * and only then write the batch. The plan is pure — it holds the documents
 * and the icon bytes before the first byte reaches the disk — so the write
 * step never has to decide anything.
 *
 * The data flow has three stages:
 *
 * 1. resolve the pinned target. The release version maps onto a resource
 *    pack format, and an explicit resource-pack format overrides it.
 * 2. preflight. Every planned path is read first: a symbolic link is
 *    refused outright, because a link is never written through, and a path
 *    that already exists is collected as a conflict. Any conflict refuses
 *    the whole batch with the full list, so nothing is written and the
 *    caller learns every target to clear.
 * 3. write. Directories first, then the files through the shared output
 *    guard, which keeps its alias, parent, and atomic-write semantics.
 */

/**
 * The `min_format`/`max_format` pair is written from resource pack format 65
 * on, when the game introduced the split range; below it the legacy single
 * major carries the target. Both shapes were frozen against the structure
 * checker, so the boundary cannot move silently.
 */
const MODERN_FORMAT_FROM = "65.0";

/**
 * Resolve the pinned target of a request. An unknown release version, and a
 * resource-pack format the normalizer refuses, are `INVALID_ARGUMENT` naming
 * the value they rejected; the release version always stays in the document
 * even when the format was overridden.
 */
export function resolvePackInitVersion(
	request: PackInitRequest,
): PackInitVersion {
	const minecraftVersion = request.minecraftVersion;
	const release = releasePackFormat(minecraftVersion);
	if (release === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Unsupported minecraftVersion "${minecraftVersion}". Supported release versions run from 1.19.3 through 26.3.`,
			{ minecraftVersion },
		);
	}
	const override = request.resourcePackVersion;
	if (override === undefined) {
		return {
			minecraftVersion,
			packFormat: release,
			resourcePackVersion: release,
		};
	}
	let packFormat: string;
	try {
		packFormat = normalizePackFormat(override);
	} catch {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Invalid resourcePackVersion "${override}". Takes N or N.M (for example "46" or "97.1").`,
			{ resourcePackVersion: override, minecraftVersion },
		);
	}
	return { minecraftVersion, packFormat, resourcePackVersion: packFormat };
}

/**
 * Default project name: the target directory name normalized to an
 * identifier. A directory that cannot be normalized is refused instead of
 * silently renamed, so the caller can pass the name it wants.
 */
function projectNameFromDirectory(
	projectDir: string,
	context: ProjectDocumentContext,
): string {
	const directory = basename(projectDir);
	const name = directory
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.slice(0, 64);
	if (!PACK_IDENTIFIER_PATTERN.test(name)) {
		throw projectDocumentFailure(
			"PACK_PROJECT_INVALID",
			context,
			"name",
			`name: the directory name "${directory}" does not normalize to an identifier; pass an explicit name.`,
		);
	}
	return name;
}

/**
 * Root pack.mcmeta document for one pinned target. Two documented shapes:
 * from resource pack format 65 on the range is pinned with a
 * `min_format`/`max_format` pair and the legacy field stays out; below it
 * the single legacy major carries the target.
 */
export function buildRootMetadataDocument(
	description: string,
	packFormat: string,
): Record<string, unknown> {
	const [majorText, minorText] = packFormat.split(".");
	const major = Number(majorText);
	const minor = minorText === undefined ? 0 : Number(minorText);
	const pack: Record<string, unknown> = { description };
	if (comparePackFormats(packFormat, MODERN_FORMAT_FROM) >= 0) {
		pack.min_format = [major, minor];
		pack.max_format = [major, minor];
	} else {
		pack.pack_format = major;
	}
	return { pack };
}

/** Top-level directory names of the pack root, for the metadata checker. */
function packRootDirectoryNames(
	directories: readonly string[],
	outputDir: string,
): ReadonlySet<string> {
	const prefix = `${outputDir}/`;
	const names = new Set<string>();
	for (const entry of directories) {
		if (!entry.startsWith(prefix)) {
			continue;
		}
		const rest = entry.slice(prefix.length);
		if (!rest.includes("/")) {
			names.add(rest);
		}
	}
	return names;
}

/**
 * The generated root metadata must pass the structure checker before it
 * becomes part of the plan; a document with a finding never reaches the
 * disk, so a broken skeleton cannot be written and then discovered.
 */
function assertRootMetadataChecks(
	metadata: Record<string, unknown>,
	version: PackInitVersion,
	directories: readonly string[],
	projectPath: string,
): void {
	const checked = checkPackMcmeta({
		doc: metadata,
		packFormat: version.packFormat,
		rootDirectories: packRootDirectoryNames(
			directories,
			PACK_DEFAULT_OUTPUT_DIR,
		),
	});
	if (checked.findings.length === 0 && checked.skipped.length === 0) {
		return;
	}
	throw new McAssetError(
		"PACK_MCMETA_INVALID",
		`The generated pack.mcmeta for ${version.minecraftVersion} does not pass the structure checker; nothing was written.`,
		{
			path: projectPath,
			field: "pack.description",
			minecraftVersion: version.minecraftVersion,
			findings: checked.findings,
			skipped: checked.skipped,
		},
	);
}

/**
 * The planned document must read back exactly as written: the strict reader
 * is the only reader of this file, so a text the writer can produce but the
 * reader would reject is a planning bug, not something to land on disk.
 */
function assertProjectReadsBack(
	projectText: string,
	projectPath: string,
): void {
	const loaded = parsePackProjectText(projectText, projectPath);
	if (canonicalDocumentText(loaded) !== projectText) {
		throw new McAssetError(
			"INTERNAL_ERROR",
			`The planned project document does not read back as written: ${projectPath}.`,
		);
	}
}

/**
 * Plan the whole batch: the project document, the pack root metadata, the
 * placeholder icon, and the skeleton directories. The root metadata is
 * checked in memory before it becomes part of the plan, so a document with a
 * finding never reaches the disk. Unknown versions and illegal namespaces
 * are refused here, before any path is touched.
 */
export function planPackInit(request: PackInitRequest): PackInitPlan {
	const projectDir = resolvePath(request.projectDir);
	const projectPath = resolvePath(projectDir, PACK_PROJECT_FILE_NAME);
	const version = resolvePackInitVersion(request);
	const context: ProjectDocumentContext = {
		path: projectPath,
		minecraftVersion: version.minecraftVersion,
	};

	const namespace = request.namespace;
	if (!PACK_NAMESPACE_PATTERN.test(namespace)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Invalid namespace "${namespace}": lowercase letters, digits, "_", ".", and "-" only.`,
			{ field: "namespace", namespace },
		);
	}
	const allowMinecraftNamespace = request.allowMinecraftNamespace === true;
	if (namespace === PACK_MINECRAFT_NAMESPACE && !allowMinecraftNamespace) {
		throw projectDocumentFailure(
			"PACK_PROJECT_INVALID",
			context,
			"namespace",
			`namespace: "minecraft" is reserved and overrides the game; set allowMinecraftNamespace to true to use it.`,
		);
	}

	const name = request.name ?? projectNameFromDirectory(projectDir, context);
	if (typeof name !== "string" || !PACK_IDENTIFIER_PATTERN.test(name)) {
		throw projectDocumentFailure(
			"PACK_PROJECT_INVALID",
			context,
			"name",
			`name: expected an identifier, got ${formatValue(name)}.`,
		);
	}
	const description = request.description ?? name;
	if (
		description.length < PACK_DESCRIPTION_MIN_LENGTH ||
		description.length > PACK_DESCRIPTION_MAX_LENGTH
	) {
		throw projectDocumentFailure(
			"PACK_PROJECT_INVALID",
			context,
			"description",
			`description: expected a string of ${PACK_DESCRIPTION_MIN_LENGTH} to ${PACK_DESCRIPTION_MAX_LENGTH} characters, got ${formatValue(request.description)}.`,
		);
	}
	const style = request.style ?? PACK_DEFAULT_STYLE;
	if (!isKnownStyleReference(style)) {
		throw projectDocumentFailure(
			"PACK_PROJECT_INVALID",
			context,
			"style",
			`style: expected a builtin preset id or a .style.json path, got ${formatValue(style)}.`,
		);
	}

	const project: PackProjectDocument = {
		formatVersion: PACK_PROJECT_FORMAT_VERSION,
		name,
		description,
		namespace,
		allowMinecraftNamespace,
		minecraftVersion: version.minecraftVersion,
		resourcePackVersion: version.resourcePackVersion,
		style,
		outputDir: PACK_DEFAULT_OUTPUT_DIR,
		recipeDir: PACK_DEFAULT_RECIPE_DIR,
		vanillaSource: null,
	};
	const directories = planSkeletonDirectories(
		namespace,
		PACK_DEFAULT_OUTPUT_DIR,
		version.packFormat,
	);
	const metadata = buildRootMetadataDocument(description, version.packFormat);
	assertRootMetadataChecks(metadata, version, directories, projectPath);
	const projectText = canonicalDocumentText(project);
	assertProjectReadsBack(projectText, projectPath);

	const files: PackInitFile[] = [
		{
			path: projectPath,
			relativePath: PACK_PROJECT_FILE_NAME,
			data: projectText,
		},
		{
			path: resolvePath(
				projectDir,
				PACK_DEFAULT_OUTPUT_DIR,
				PACK_ROOT_METADATA_FILE_NAME,
			),
			relativePath: `${PACK_DEFAULT_OUTPUT_DIR}/${PACK_ROOT_METADATA_FILE_NAME}`,
			data: canonicalDocumentText(metadata),
		},
		{
			path: resolvePath(
				projectDir,
				PACK_DEFAULT_OUTPUT_DIR,
				PACK_ICON_FILE_NAME,
			),
			relativePath: `${PACK_DEFAULT_OUTPUT_DIR}/${PACK_ICON_FILE_NAME}`,
			data: buildPlaceholderIcon(),
		},
	].sort((left, right) =>
		compareCodeUnits(left.relativePath, right.relativePath),
	);

	return {
		projectDir,
		version,
		project,
		files,
		directories,
	};
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
	try {
		return await lstat(path);
	} catch {
		return undefined;
	}
}

/**
 * Read-only preflight over the project directory and every planned path. A
 * symbolic link is refused before anything is written — the project
 * directory itself under its own reason, a planned path under
 * `target-is-symlink` — and every path that already exists is collected.
 * Any conflict refuses the whole batch with the full list in byte order.
 */
async function preflightPackInit(plan: PackInitPlan): Promise<void> {
	const projectDir = plan.projectDir;
	const existing = await lstatOrUndefined(projectDir);
	if (existing?.isSymbolicLink() === true) {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Project directory is a symbolic link: ${projectDir}.`,
			{ reason: "project-dir-is-symlink", path: projectDir },
		);
	}
	if (existing !== undefined && !existing.isDirectory()) {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Project directory is not a directory: ${projectDir}.`,
			{ reason: "project-dir-not-directory", path: projectDir },
		);
	}
	const conflicts: string[] = [];
	const relativePaths = [
		...plan.directories,
		...plan.files.map((file) => file.relativePath),
	].sort(compareCodeUnits);
	for (const relativePath of relativePaths) {
		const target = resolvePath(projectDir, relativePath);
		const stat = await lstatOrUndefined(target);
		if (stat === undefined) {
			continue;
		}
		if (stat.isSymbolicLink()) {
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Planned target is a symbolic link: ${target}.`,
				{ reason: "target-is-symlink", path: target },
			);
		}
		conflicts.push(relativePath);
	}
	if (conflicts.length > 0) {
		throw new McAssetError(
			"PACK_INIT_CONFLICT",
			`pack init found ${conflicts.length} existing target(s) below ${projectDir}; nothing was written.`,
			{
				conflicts,
				path: projectDir,
				minecraftVersion: plan.version.minecraftVersion,
			},
		);
	}
}

/** Create every planned directory, intermediates included, byte order. */
async function createPlannedDirectories(plan: PackInitPlan): Promise<void> {
	for (const relativePath of plan.directories) {
		const target = resolvePath(plan.projectDir, relativePath);
		try {
			await mkdir(target, { recursive: true });
		} catch {
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Cannot create directory: ${target}.`,
				{ reason: "mkdir-failed", path: target },
			);
		}
	}
}

/** The extension each planned file already carries. */
const PLANNED_FILE_EXTENSIONS: ReadonlyMap<string, OutputTarget["extension"]> =
	new Map([
		[PACK_ICON_FILE_NAME, ".png"],
		[PACK_ROOT_METADATA_FILE_NAME, ".mcmeta"],
		[PACK_PROJECT_FILE_NAME, ".json"],
	]);

/**
 * Write the planned files through the shared output guard: every target is
 * create-only, so a byte that appeared since the preflight is refused as a
 * whole instead of replaced.
 */
async function writePlannedFiles(plan: PackInitPlan): Promise<void> {
	const targets: OutputTarget[] = [];
	const payloads = new Map<string, Uint8Array | string>();
	for (const file of plan.files) {
		const extension = PLANNED_FILE_EXTENSIONS.get(basename(file.path));
		if (extension === undefined) {
			throw new McAssetError(
				"INTERNAL_ERROR",
				`No output extension is registered for: ${file.path}.`,
			);
		}
		targets.push({
			path: file.path,
			extension,
			allowOverwrite: false,
			createOnly: true,
		});
		payloads.set(file.path, file.data);
	}
	const guardPlan = await planOutputTargets(targets, {
		inputs: [],
		mkdir: true,
	});
	await writePlannedTargets(guardPlan, payloads, { mkdir: true });
}

/**
 * Preflight, then write the planned batch. Returns what landed: the absolute
 * project directory and document path, the pinned version, and every
 * relative file and directory the run created.
 */
export async function initializePackProject(
	request: PackInitRequest,
): Promise<PackInitResult> {
	const plan = planPackInit(request);
	await preflightPackInit(plan);
	await createPlannedDirectories(plan);
	await writePlannedFiles(plan);
	const projectPath = resolvePath(plan.projectDir, PACK_PROJECT_FILE_NAME);
	return {
		projectDir: plan.projectDir,
		projectPath,
		minecraftVersion: plan.version.minecraftVersion,
		packFormat: plan.version.packFormat,
		resourcePackVersion: plan.version.resourcePackVersion,
		files: plan.files.map((file: PackInitFile) => file.relativePath),
		directories: plan.directories,
	};
}
