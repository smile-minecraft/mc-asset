import type { Stats } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { McAssetError } from "../core/errors.ts";
import { type AtomicWriteSeams, atomicWriteFile } from "./filesystem.ts";

/** One output a command wants to create or replace. */
export interface OutputTarget {
	readonly path: string;
	/** Extension the path must carry (case-insensitive). */
	readonly extension: ".png" | ".json" | ".mcmeta";
	/** --force semantics: an existing file may be replaced. */
	readonly allowOverwrite: boolean;
	/** Binding files: an existing file is always refused, --force or not. */
	readonly createOnly?: boolean;
}

/** An output whose path keeps whatever extension the caller chose. */
export type ExtensionlessOutputTarget = Omit<OutputTarget, "extension">;

export interface OutputGuardOptions {
	/** Every input path of the command (never writable, even with --force). */
	readonly inputs: readonly string[];
	readonly mkdir: boolean;
	/** When set, every target must resolve inside this directory (--pack for model export). */
	readonly allowedRoot?: string;
}

export interface PlannedTarget {
	readonly path: string;
	readonly canonicalKey: string;
	readonly existed: boolean;
	readonly parentMissing: boolean;
	readonly allowOverwrite: boolean;
	readonly createOnly: boolean;
}

/** details of a failed write phase; the failing code is kept, OUTPUT_EXISTS fails before any byte. */
export interface PartialWriteDetails {
	readonly completed: readonly string[];
	readonly failedTarget: string;
	readonly notStarted: readonly string[];
}

function foldKey(path: string): string {
	return path.normalize("NFC").toLocaleLowerCase("en-US");
}

/** Alias comparison without symlink resolution: absolute, NFC, en-US lower case. */
export function lexicalKey(path: string): string {
	return foldKey(resolve(path));
}

/**
 * Alias comparison with symlink resolution: realpath of the nearest existing
 * ancestor plus the remaining segments. A missing or dangling path still gets a
 * key, so every check can run before anything is written.
 */
export async function canonicalKey(path: string): Promise<string> {
	const absolute = resolve(path);
	let current = absolute;
	const rest: string[] = [];
	for (;;) {
		try {
			return foldKey(join(await realpath(current), ...rest));
		} catch {
			const parent = dirname(current);
			if (parent === current) return foldKey(absolute);
			rest.unshift(basename(current));
			current = parent;
		}
	}
}

async function statOrUndefined(path: string): Promise<Stats | undefined> {
	try {
		return await stat(path);
	} catch {
		return undefined;
	}
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
	try {
		return await lstat(path);
	} catch {
		return undefined;
	}
}

/** Path shape (step 1): non-empty, no NUL byte, extension matches case-insensitively. */
function shapeProblem(
	target: ExtensionlessOutputTarget & { readonly extension?: string },
): string | undefined {
	if (target.path === "") return "Output path is empty.";
	if (target.path.includes("\0")) return "Output path contains a NUL byte.";
	if (
		target.extension !== undefined &&
		extname(target.path).toLowerCase() !== target.extension
	) {
		return `Output path must end with ${target.extension}: ${target.path}.`;
	}
	return undefined;
}

export function isInside(root: string, key: string): boolean {
	const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
	return key === root || key.startsWith(prefix);
}

function conflict(message: string): McAssetError {
	return new McAssetError("ARGUMENT_CONFLICT", message);
}

/**
 * Read-only preflight over every target before the first byte is written.
 * Each target runs these checks in order: path is non-empty with no NUL and
 * the right extension; no alias of an input or another target; not a
 * directory; not a symlink (dangling included); an existing file needs
 * overwrite permission and is never replaced for create-only targets; the
 * parent is a directory, not a symlink, and exists or `mkdir` is set; the
 * realpath-normalized path is not an alias of an input or another target; and
 * it stays inside `allowedRoot` when one is given. The first failure stops the
 * whole plan. Nothing is created here, not even parents.
 */
export async function planOutputTargets(
	targets: readonly OutputTarget[],
	options: OutputGuardOptions,
): Promise<readonly PlannedTarget[]> {
	return planTargets(targets, options);
}

/**
 * Same preflight as planOutputTargets, minus the extension whitelist, for
 * commands that always accepted any output extension. Every other check
 * (aliases, directories, symlinks, existing files, parents) is unchanged.
 */
export async function planOutputTargetsKeepingExtension(
	targets: readonly ExtensionlessOutputTarget[],
	options: OutputGuardOptions,
): Promise<readonly PlannedTarget[]> {
	return planTargets(targets, options);
}

async function planTargets(
	targets: readonly (ExtensionlessOutputTarget & {
		readonly extension?: OutputTarget["extension"];
	})[],
	options: OutputGuardOptions,
): Promise<readonly PlannedTarget[]> {
	const inputKeys = options.inputs.map((input) => lexicalKey(input));
	const inputCanonical = await Promise.all(
		options.inputs.map((input) => canonicalKey(input)),
	);
	const problems = targets.map((target) => shapeProblem(target));
	const targetKeys = targets.map((target, index) =>
		problems[index] === undefined ? lexicalKey(target.path) : undefined,
	);
	const targetCanonical = await Promise.all(
		targets.map((target, index) =>
			problems[index] === undefined ? canonicalKey(target.path) : undefined,
		),
	);
	const rootKey =
		options.allowedRoot === undefined
			? undefined
			: await canonicalKey(options.allowedRoot);
	const plan: PlannedTarget[] = [];
	for (const [index, target] of targets.entries()) {
		const problem = problems[index];
		if (problem !== undefined) {
			throw new McAssetError("INVALID_ARGUMENT", problem, {
				path: target.path,
			});
		}
		const key = targetKeys[index] as string;
		const canonical = targetCanonical[index] as string;

		if (inputKeys.includes(key)) {
			throw conflict(`Output aliases the input: ${target.path}.`);
		}
		for (const [other, otherKey] of targetKeys.entries()) {
			if (other !== index && otherKey === key) {
				throw conflict(`Two outputs resolve to the same file: ${target.path}.`);
			}
		}

		const existing = await lstatOrUndefined(target.path);
		if (existing?.isDirectory()) {
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Output is a directory: ${target.path}.`,
				{ reason: "target-is-directory", path: target.path },
			);
		}
		if (existing?.isSymbolicLink()) {
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Output is a symbolic link: ${target.path}.`,
				{ reason: "target-is-symlink", path: target.path },
			);
		}
		if (
			existing !== undefined &&
			(target.createOnly === true || !target.allowOverwrite)
		) {
			throw new McAssetError(
				"OUTPUT_EXISTS",
				target.createOnly === true
					? `Output already exists and is never overwritten: ${target.path}.`
					: `Output exists: ${target.path}. Pass --force to overwrite.`,
				{ path: target.path },
			);
		}

		const parent = dirname(target.path);
		const parentStat = await statOrUndefined(parent);
		if (parentStat !== undefined && !parentStat.isDirectory()) {
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Parent path is not a directory: ${parent}.`,
				{ reason: "parent-is-not-directory", path: parent },
			);
		}
		if ((await lstatOrUndefined(parent))?.isSymbolicLink() === true) {
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Parent directory is a symbolic link: ${parent}.`,
				{ reason: "parent-is-symlink", path: parent },
			);
		}
		const parentMissing = parentStat === undefined;
		if (parentMissing && !options.mkdir) {
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Parent directory is missing: ${parent}. Pass --mkdir to create it.`,
				{ reason: "parent-missing", path: parent },
			);
		}

		if (inputCanonical.includes(canonical)) {
			throw conflict(`Output aliases the input: ${target.path}.`);
		}
		for (const [other, otherCanonical] of targetCanonical.entries()) {
			if (other !== index && otherCanonical === canonical) {
				throw conflict(`Two outputs resolve to the same file: ${target.path}.`);
			}
		}

		if (rootKey !== undefined && !isInside(rootKey, canonical)) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				`Output is outside the allowed directory: ${target.path}.`,
				{
					reason: "outside-allowed-root",
					path: target.path,
					allowedRoot: options.allowedRoot,
				},
			);
		}

		plan.push({
			path: target.path,
			canonicalKey: canonical,
			existed: existing !== undefined,
			parentMissing,
			allowOverwrite: target.allowOverwrite,
			createOnly: target.createOnly ?? false,
		});
	}
	return plan;
}

function stripCodePrefix(message: string): string {
	return message.replace(/^\[[A-Z0-9_]+\] /, "");
}

/**
 * Writes every planned target in plan order through the atomic helper. A
 * failure keeps the original code and attaches PartialWriteDetails: the targets
 * already written stay on disk and are listed in `completed`.
 */
export async function writePlannedTargets(
	plan: readonly PlannedTarget[],
	payloads: ReadonlyMap<string, Uint8Array | string>,
	options: { readonly mkdir: boolean },
	seams: AtomicWriteSeams = {},
): Promise<readonly string[]> {
	for (const target of plan) {
		if (!payloads.has(target.path)) {
			throw new McAssetError(
				"INTERNAL_ERROR",
				`No payload for output: ${target.path}.`,
			);
		}
	}
	const completed: string[] = [];
	for (const [index, target] of plan.entries()) {
		const data = payloads.get(target.path) as string | Uint8Array;
		try {
			await atomicWriteFile(
				target.path,
				data,
				{
					force: target.allowOverwrite && !target.createOnly,
					mkdir: options.mkdir,
				},
				undefined,
				seams,
			);
		} catch (error) {
			const cause = error instanceof McAssetError ? error : undefined;
			const details: PartialWriteDetails = {
				completed: [...completed],
				failedTarget: target.path,
				notStarted: plan.slice(index + 1).map((next) => next.path),
			};
			throw new McAssetError(
				cause?.code ?? "FILESYSTEM_ERROR",
				cause === undefined
					? `Cannot write output: ${target.path}.`
					: stripCodePrefix(cause.message),
				details,
			);
		}
		completed.push(target.path);
	}
	return completed;
}
