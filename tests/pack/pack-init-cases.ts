import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { McAssetError } from "../../src/core/errors.ts";
import { decodePng } from "../../src/io/png.ts";
import { handlePackAsset } from "../../src/mcp/handlers.ts";
import {
	initializePackProject,
	type PackInitRequest,
} from "../../src/pack/index.ts";
import { loadPackProject } from "../../src/pack/load.ts";
import { checkPackMcmeta } from "../../src/validate/pack-mcmeta.ts";
import {
	compareCodeUnits,
	EXPECTED_ROOT_METADATA,
	expectedInitDirectories,
	expectedProjectDocument,
	ICON_COLORS,
	ICON_PROBES,
	ICON_SIZE,
	INIT_FILES,
} from "./pack-expectations.ts";

/**
 * Resource-pack project cases: what `pack init` must leave behind and how a
 * project document is read back. Expectations live in
 * `pack-expectations.ts`, so the shipped constants cannot move the target
 * with them. Every expectation runs through the shared engine, so the CLI
 * path and the MCP handler observe the same files.
 */

interface PackCase {
	name: string;
	run(): void | Promise<void>;
}

/** A refused call: the code, the message, and the structured details. */
interface Refusal {
	code: string;
	message: string;
	details: Record<string, unknown> | null;
}

interface ToolResult {
	isError?: boolean;
	content: { type: string; text?: string }[];
}

async function captureRefusal(
	body: () => unknown | Promise<unknown>,
): Promise<Refusal | null> {
	try {
		await body();
		return null;
	} catch (error) {
		const failure = error as McAssetError;
		return {
			code: failure.code ?? "UNKNOWN",
			message: failure.message ?? String(error),
			details:
				typeof failure.details === "object" && failure.details !== null
					? (failure.details as Record<string, unknown>)
					: null,
		};
	}
}

/** Assert a refusal carries the code and field path a caller localizes on. */
function assertRefusal(
	refusal: Refusal | null,
	code: string,
	field?: string,
): Refusal {
	assert.ok(refusal !== null, `expected a ${code} refusal`);
	const actual = refusal as Refusal;
	assert.equal(actual.code, code, actual.message);
	if (field !== undefined) {
		assert.equal(actual.details?.field, field, `${code} names the field path`);
	}
	return actual;
}

/** Parse JSON without throwing, so a wrong payload fails as an assertion. */
function jsonOrNull(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

function handlerBody(result: ToolResult): Record<string, unknown> {
	const text = result.content[0]?.text ?? "{}";
	return jsonOrNull(text) as Record<string, unknown>;
}

/** Scratch project directory that always exists and is removed afterwards. */
async function withProjectDir(
	prefix: string,
	body: (dir: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	try {
		await body(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Files below a directory, relative and in byte order; absent means empty. */
async function listFiles(root: string, current = root): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(current, { withFileTypes: true })) {
		const full = join(current, entry.name);
		if (entry.isDirectory()) {
			found.push(...(await listFiles(root, full)));
		} else {
			found.push(relative(root, full));
		}
	}
	return found.sort(compareCodeUnits);
}

/** Same list, but a directory a refused call never created reads as empty. */
async function listFilesIfPresent(root: string): Promise<string[]> {
	try {
		return await listFiles(root);
	} catch {
		return [];
	}
}

/** Directory entries of a path that may not exist yet. */
async function readdirIfPresent(path: string): Promise<string[]> {
	try {
		return await readdir(path);
	} catch {
		return [];
	}
}

/** Same list for directories, so a missing root fails as an assertion. */
async function listDirectoriesIfPresent(root: string): Promise<string[]> {
	try {
		return await listDirectories(root);
	} catch {
		return [];
	}
}

/** Read a file a call may not have written; a missing one reads as empty. */
async function readTextIfPresent(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return "";
	}
}

async function readBinaryIfPresent(path: string): Promise<Uint8Array> {
	try {
		return new Uint8Array(await readFile(path));
	} catch {
		return new Uint8Array(0);
	}
}

/**
 * Read one written JSON document. A document that was never written fails on
 * the assertion here instead of on a filesystem error.
 */
async function readJsonAt(path: string): Promise<Record<string, unknown>> {
	const parsed = jsonOrNull(await readTextIfPresent(path)) as unknown;
	assert.ok(
		typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
		`${path} is written as a JSON object`,
	);
	return parsed as Record<string, unknown>;
}

/** Directories below a directory, relative, in byte order, without the root. */
async function listDirectories(
	root: string,
	current = root,
): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(current, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const full = join(current, entry.name);
		found.push(relative(root, full));
		found.push(...(await listDirectories(root, full)));
	}
	return found.sort(compareCodeUnits);
}

function initRequest(
	overrides: Partial<PackInitRequest> = {},
): PackInitRequest {
	return {
		projectDir: "",
		namespace: "aurelian",
		minecraftVersion: "1.21.9",
		...overrides,
	};
}

/** Alpha-aware hex, matching how the analyzer reports a decoded pixel. */
function pixelHex(
	red: number,
	green: number,
	blue: number,
	alpha: number,
): string {
	const byte = (value: number): string =>
		value.toString(16).padStart(2, "0").toUpperCase();
	const opaque = alpha === 255;
	return `#${byte(red)}${byte(green)}${byte(blue)}${opaque ? "" : byte(alpha)}`;
}

export const PACK_CASES: PackCase[] = [
	{
		name: "pack init writes the project file, the root metadata, the icon, and the skeleton directories",
		async run() {
			await withProjectDir("mc-asset-pack-", async (dir) => {
				const projectDir = join(dir, "aurelian-forge");
				const result = await initializePackProject(initRequest({ projectDir }));
				assert.equal(result.projectDir, resolve(projectDir));
				assert.deepEqual(
					result.files,
					[...INIT_FILES],
					"the three written files in byte order",
				);
				assert.deepEqual(
					result.directories,
					[...expectedInitDirectories("aurelian", true)],
					"the skeleton directories in byte order",
				);
				assert.deepEqual(
					await listFilesIfPresent(projectDir),
					[...INIT_FILES],
					"nothing beyond the planned files lands on disk",
				);
				assert.deepEqual(
					await listDirectoriesIfPresent(projectDir),
					[...expectedInitDirectories("aurelian", true)],
					"no unplanned directory is left behind",
				);
			});
		},
	},
	{
		name: "pack init writes the project document with the pinned format, the default style, and the documented directories",
		async run() {
			await withProjectDir("mc-asset-pack-", async (dir) => {
				const projectDir = join(dir, "aurelian-forge");
				await initializePackProject(initRequest({ projectDir }));
				assert.deepEqual(
					await readJsonAt(join(projectDir, "mc-asset.pack.json")),
					expectedProjectDocument({}),
				);
			});
		},
	},
	{
		name: "pack init records the requested style, name, and description, and takes the name from the directory when it is omitted",
		async run() {
			await withProjectDir("mc-asset-pack-", async (dir) => {
				const styled = join(dir, "aurelian-forge");
				await initializePackProject(
					initRequest({
						projectDir: styled,
						style: "soft",
						name: "aurelian-forge",
						description: "aurelian-forge pack",
					}),
				);
				assert.deepEqual(
					await readJsonAt(join(styled, "mc-asset.pack.json")),
					expectedProjectDocument({
						description: "aurelian-forge pack",
						style: "soft",
					}),
				);
				const derived = join(dir, "ember-lantern");
				await initializePackProject(
					initRequest({ projectDir: derived, minecraftVersion: "26.3" }),
				);
				assert.deepEqual(
					await readJsonAt(join(derived, "mc-asset.pack.json")),
					expectedProjectDocument({
						description: "ember-lantern",
						minecraftVersion: "26.3",
						name: "ember-lantern",
						resourcePackVersion: "97.1",
					}),
				);
			});
		},
	},
	{
		name: "pack init writes a resource-pack version that overrides the release version and keeps the release version in the document",
		async run() {
			await withProjectDir("mc-asset-pack-", async (dir) => {
				const projectDir = join(dir, "aurelian-forge");
				const result = await initializePackProject(
					initRequest({ projectDir, resourcePackVersion: "46" }),
				);
				assert.equal(result.packFormat, "46.0");
				assert.deepEqual(
					await readJsonAt(join(projectDir, "mc-asset.pack.json")),
					expectedProjectDocument({
						minecraftVersion: "1.21.9",
						resourcePackVersion: "46.0",
					}),
				);
			});
		},
	},
	{
		name: "the generated root metadata passes the pack.mcmeta structure checker with no findings on every target version",
		async run() {
			await withProjectDir("mc-asset-pack-", async (dir) => {
				for (const target of EXPECTED_ROOT_METADATA) {
					const projectDir = join(dir, `${target.minecraftVersion}-pack`);
					await initializePackProject(
						initRequest({
							projectDir,
							name: "aurelian-forge",
							minecraftVersion: target.minecraftVersion,
						}),
					);
					const document = await readJsonAt(
						join(projectDir, "pack", "pack.mcmeta"),
					);
					const root = new Set(
						await readdirIfPresent(join(projectDir, "pack")),
					);
					const checked = checkPackMcmeta({
						doc: document,
						packFormat: target.packFormat,
						rootDirectories: root,
					});
					assert.deepEqual(
						checked.findings,
						[],
						`${target.minecraftVersion} metadata carries no finding`,
					);
					assert.deepEqual(
						checked.skipped,
						[],
						`${target.minecraftVersion} metadata skips nothing`,
					);
				}
			});
		},
	},
	{
		name: "the generated root metadata pins the new-style range from 1.21.9 on and writes the single legacy major below it",
		async run() {
			await withProjectDir("mc-asset-pack-", async (dir) => {
				for (const target of EXPECTED_ROOT_METADATA) {
					const projectDir = join(dir, `${target.minecraftVersion}-shape`);
					await initializePackProject(
						initRequest({
							projectDir,
							name: "aurelian-forge",
							minecraftVersion: target.minecraftVersion,
						}),
					);
					const document = await readJsonAt(
						join(projectDir, "pack", "pack.mcmeta"),
					);
					assert.deepEqual(
						document.pack,
						target.pack,
						`${target.minecraftVersion} pack section`,
					);
				}
			});
		},
	},
	{
		name: "the skeleton adds the items directory only from resource pack format 46.0",
		async run() {
			await withProjectDir("mc-asset-pack-", async (dir) => {
				const older = join(dir, "older-pack");
				await initializePackProject(
					initRequest({ projectDir: older, minecraftVersion: "1.20.4" }),
				);
				assert.deepEqual(
					await listDirectoriesIfPresent(older),
					[...expectedInitDirectories("aurelian", false)],
					"1.20.4 has no items directory",
				);
				const newer = join(dir, "newer-pack");
				await initializePackProject(
					initRequest({ projectDir: newer, minecraftVersion: "1.21.4" }),
				);
				assert.deepEqual(
					await listDirectoriesIfPresent(newer),
					[...expectedInitDirectories("aurelian", true)],
					"1.21.4 carries the items directory",
				);
			});
		},
	},
	{
		name: "the placeholder icon is a 64x64 PNG painted with the original motif, byte-identical across runs",
		async run() {
			await withProjectDir("mc-asset-pack-", async (dir) => {
				const first = join(dir, "first-pack");
				const second = join(dir, "second-pack");
				await initializePackProject(initRequest({ projectDir: first }));
				await initializePackProject(initRequest({ projectDir: second }));
				const bytes = await readBinaryIfPresent(
					join(first, "pack", "pack.png"),
				);
				assert.ok(bytes.length > 0, "the icon file holds PNG bytes");
				const again = await readBinaryIfPresent(
					join(second, "pack", "pack.png"),
				);
				assert.deepEqual(
					Buffer.from(bytes).toString("hex"),
					Buffer.from(again).toString("hex"),
					"the same request paints the same bytes",
				);
				const decoded = decodePng(new Uint8Array(bytes));
				assert.equal(decoded.canvas.width, ICON_SIZE);
				assert.equal(decoded.canvas.height, ICON_SIZE);
				const layer = decoded.canvas.layers[0];
				assert.ok(layer !== undefined, "the icon decodes into one layer");
				const colors = new Set<string>();
				for (let y = 0; y < ICON_SIZE; y += 1) {
					for (let x = 0; x < ICON_SIZE; x += 1) {
						const offset = (y * ICON_SIZE + x) * 4;
						const hex = pixelHex(
							layer.pixels[offset] as number,
							layer.pixels[offset + 1] as number,
							layer.pixels[offset + 2] as number,
							layer.pixels[offset + 3] as number,
						);
						colors.add(hex);
						const probe = ICON_PROBES.find(
							(entry) => entry.x === x && entry.y === y,
						);
						if (probe !== undefined) {
							assert.equal(hex, probe.hex, `icon pixel ${x},${y}`);
						}
					}
				}
				assert.deepEqual(
					[...colors].sort(compareCodeUnits),
					[...ICON_COLORS],
					"the icon paints exactly the frozen palette",
				);
			});
		},
	},
	{
		name: "an unknown Minecraft version is refused before the first byte",
		async run() {
			await withProjectDir("mc-asset-pack-", async (dir) => {
				const projectDir = join(dir, "unknown-pack");
				const refusal = await captureRefusal(() =>
					initializePackProject(
						initRequest({ projectDir, minecraftVersion: "1.99" }),
					),
				);
				assertRefusal(refusal, "INVALID_ARGUMENT");
				assert.equal(
					(refusal as Refusal).details?.minecraftVersion,
					"1.99",
					"the refusal echoes the version it refused",
				);
				assert.deepEqual(await listFilesIfPresent(projectDir), []);
			});
		},
	},
	{
		name: "a namespace outside the allowed character set is refused before the first byte",
		async run() {
			await withProjectDir("mc-asset-pack-", async (dir) => {
				for (const namespace of [
					"Aurelian",
					"aurelian/forge",
					"aurelian:forge",
				]) {
					const projectDir = join(dir, `ns-${namespace.replace(/\W/g, "_")}`);
					const refusal = await captureRefusal(() =>
						initializePackProject(initRequest({ projectDir, namespace })),
					);
					assertRefusal(refusal, "INVALID_ARGUMENT", "namespace");
				}
				assert.deepEqual(await listFilesIfPresent(dir), []);
			});
		},
	},
	{
		name: "the minecraft namespace needs the explicit opt-in",
		async run() {
			await withProjectDir("mc-asset-pack-", async (dir) => {
				const guarded = join(dir, "guarded-pack");
				const refusal = await captureRefusal(() =>
					initializePackProject(
						initRequest({ projectDir: guarded, namespace: "minecraft" }),
					),
				);
				assertRefusal(refusal, "PACK_PROJECT_INVALID", "namespace");
				assert.deepEqual(await listFilesIfPresent(guarded), []);
				const allowed = join(dir, "allowed-pack");
				await initializePackProject(
					initRequest({
						projectDir: allowed,
						name: "aurelian-forge",
						namespace: "minecraft",
						allowMinecraftNamespace: true,
					}),
				);
				assert.deepEqual(
					await readJsonAt(join(allowed, "mc-asset.pack.json")),
					expectedProjectDocument({
						allowMinecraftNamespace: true,
						namespace: "minecraft",
					}),
				);
			});
		},
	},
	{
		name: "an existing target refuses the whole batch and lists every conflict",
		async run() {
			await withProjectDir("mc-asset-pack-", async (dir) => {
				const projectDir = join(dir, "busy-pack");
				await mkdir(join(projectDir, "pack"), { recursive: true });
				await mkdir(join(projectDir, "recipes"));
				await writeFile(
					join(projectDir, "pack", "pack.mcmeta"),
					'{"pack":{"description":"kept"}}\n',
					"utf8",
				);
				const refusal = await captureRefusal(() =>
					initializePackProject(initRequest({ projectDir })),
				);
				const actual = assertRefusal(refusal, "PACK_INIT_CONFLICT");
				assert.deepEqual(
					actual.details?.conflicts,
					["pack", "pack/pack.mcmeta", "recipes"],
					"every planned path that already exists is listed in byte order",
				);
				assert.deepEqual(
					await listFilesIfPresent(projectDir),
					["pack/pack.mcmeta"],
					"a refused batch writes nothing and keeps what was there",
				);
				assert.equal(
					await readFile(join(projectDir, "pack", "pack.mcmeta"), "utf8"),
					'{"pack":{"description":"kept"}}\n',
					"the existing file is untouched",
				);
			});
		},
	},
	{
		name: "a symbolic link project directory is refused and the link target stays empty",
		async run() {
			await withProjectDir("mc-asset-pack-", async (dir) => {
				const real = join(dir, "real-pack");
				const link = join(dir, "linked-pack");
				await mkdir(real);
				await symlink(real, link, "dir");
				const refusal = await captureRefusal(() =>
					initializePackProject(initRequest({ projectDir: link })),
				);
				const actual = assertRefusal(refusal, "FILESYSTEM_ERROR");
				assert.equal(actual.details?.reason, "project-dir-is-symlink");
				assert.deepEqual(await listFilesIfPresent(real), []);
			});
		},
	},
	{
		name: "a symbolic link inside the skeleton is refused instead of written through",
		async run() {
			await withProjectDir("mc-asset-pack-", async (dir) => {
				const elsewhere = join(dir, "elsewhere");
				const projectDir = join(dir, "aurelian-forge");
				await mkdir(elsewhere);
				await mkdir(join(projectDir, "pack", "assets", "aurelian"), {
					recursive: true,
				});
				await symlink(elsewhere, join(projectDir, "recipes"), "dir");
				const refusal = await captureRefusal(() =>
					initializePackProject(initRequest({ projectDir })),
				);
				const actual = assertRefusal(refusal, "FILESYSTEM_ERROR");
				assert.equal(actual.details?.reason, "target-is-symlink");
				assert.deepEqual(await listFilesIfPresent(elsewhere), []);
			});
		},
	},
	{
		name: "the project document is read back strictly, naming the field it rejected",
		async run() {
			await withProjectDir("mc-asset-pack-", async (dir) => {
				const projectDir = join(dir, "read-back-pack");
				await initializePackProject(
					initRequest({ projectDir, name: "aurelian-forge" }),
				);
				const projectPath = join(projectDir, "mc-asset.pack.json");
				const loaded = await loadPackProject(projectPath);
				assert.equal(loaded.formatVersion, 1);
				assert.equal(loaded.name, "aurelian-forge");
				assert.equal(loaded.namespace, "aurelian");
				assert.equal(loaded.minecraftVersion, "1.21.9");
				assert.equal(loaded.style, "vanilla");
				assert.equal(loaded.outputDir, "pack");
				assert.equal(loaded.recipeDir, "recipes");
				assert.equal(loaded.allowMinecraftNamespace, false);
				assert.equal(loaded.vanillaSource, null);

				const wrongNamespace = join(dir, "wrong-namespace.json");
				await writeFile(
					wrongNamespace,
					`${JSON.stringify({ ...expectedProjectDocument({}), namespace: "Aurelian" })}\n`,
					"utf8",
				);
				assertRefusal(
					await captureRefusal(() => loadPackProject(wrongNamespace)),
					"PACK_PROJECT_INVALID",
					"namespace",
				);

				const unknownField = join(dir, "unknown-field.json");
				await writeFile(
					unknownField,
					`${JSON.stringify({ ...expectedProjectDocument({}), extra: 1 })}\n`,
					"utf8",
				);
				const unknownRefusal = assertRefusal(
					await captureRefusal(() => loadPackProject(unknownField)),
					"PACK_PROJECT_INVALID",
					"extra",
				);
				assert.equal(
					(unknownRefusal as Refusal).details?.path,
					unknownField,
					"the refusal names the document it read",
				);

				const escaping = join(dir, "escaping.json");
				await writeFile(
					escaping,
					`${JSON.stringify({ ...expectedProjectDocument({}), outputDir: "../elsewhere" })}\n`,
					"utf8",
				);
				assertRefusal(
					await captureRefusal(() => loadPackProject(escaping)),
					"PACK_PROJECT_INVALID",
					"outputDir",
				);

				const newer = join(dir, "newer.json");
				await writeFile(
					newer,
					`${JSON.stringify({ ...expectedProjectDocument({}), formatVersion: 2 })}\n`,
					"utf8",
				);
				assertRefusal(
					await captureRefusal(() => loadPackProject(newer)),
					"PACK_PROJECT_UNSUPPORTED_VERSION",
					"formatVersion",
				);

				assertRefusal(
					await captureRefusal(() =>
						loadPackProject(join(dir, "absent.pack.json")),
					),
					"PACK_PROJECT_NOT_FOUND",
				);
			});
		},
	},
	{
		name: "a directory name that cannot become an identifier is refused until the name is explicit",
		async run() {
			await withProjectDir("mc-asset-pack-", async (dir) => {
				const projectDir = join(dir, "1.20.4-pack");
				const refusal = await captureRefusal(() =>
					initializePackProject(initRequest({ projectDir })),
				);
				const actual = assertRefusal(refusal, "PACK_PROJECT_INVALID", "name");
				assert.equal(
					actual.details?.path,
					join(resolve(projectDir), "mc-asset.pack.json"),
					"the refusal names the document it would have written",
				);
				assert.deepEqual(
					await listFilesIfPresent(projectDir),
					[],
					"a refused name writes nothing",
				);
				await initializePackProject(
					initRequest({ projectDir, name: "aurelian-forge" }),
				);
				assert.deepEqual(
					await readJsonAt(join(projectDir, "mc-asset.pack.json")),
					expectedProjectDocument({}),
				);
			});
		},
	},
	{
		name: "mcp pack_asset init writes the same skeleton as the shared engine",
		async run() {
			await withProjectDir("mc-asset-pack-", async (dir) => {
				const projectDir = join(dir, "mcp-pack");
				const result = await handlePackAsset({
					mode: "init",
					projectDir,
					name: "aurelian-forge",
					namespace: "aurelian",
					minecraftVersion: "26.3",
					style: "fairy-flat",
				});
				assert.notEqual(
					result.isError,
					true,
					`init reports a failure: ${handlerBody(result as ToolResult)}`,
				);
				const body = handlerBody(result as ToolResult);
				assert.equal(body.mode, "init");
				assert.equal(body.projectDir, resolve(projectDir));
				assert.equal(body.packFormat, "97.1");
				assert.deepEqual(body.files, [...INIT_FILES]);
				assert.deepEqual(
					await listFilesIfPresent(projectDir),
					[...INIT_FILES],
					"the handler wrote exactly the planned files",
				);
				assert.deepEqual(
					await readJsonAt(join(projectDir, "mc-asset.pack.json")),
					expectedProjectDocument({
						minecraftVersion: "26.3",
						resourcePackVersion: "97.1",
						style: "fairy-flat",
					}),
				);
			});
		},
	},
	{
		name: "mcp pack_asset init reports a refusal with its code and details",
		async run() {
			await withProjectDir("mc-asset-pack-", async (dir) => {
				const projectDir = join(dir, "busy-mcp-pack");
				await mkdir(join(projectDir, "pack"), { recursive: true });
				await writeFile(
					join(projectDir, "pack", "pack.mcmeta"),
					'{"pack":{"description":"kept"}}\n',
					"utf8",
				);
				const result = await handlePackAsset({
					mode: "init",
					projectDir,
					namespace: "aurelian",
					minecraftVersion: "1.21.9",
				});
				assert.equal(result.isError, true, "an occupied target is refused");
				const body = handlerBody(result as ToolResult);
				assert.equal(body.code, "PACK_INIT_CONFLICT");
				assert.deepEqual(body.details, {
					conflicts: ["pack", "pack/pack.mcmeta"],
					minecraftVersion: "1.21.9",
					path: resolve(projectDir),
				});
			});
		},
	},
];
