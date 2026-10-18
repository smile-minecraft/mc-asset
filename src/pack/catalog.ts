import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { McAssetError } from "../core/errors.ts";
import { decodePng } from "../io/png.ts";

/**
 * Vanilla texture catalog: a read-only listing of the PNG files under an
 * `assets/` tree, with category, dimensions, animation flag, and the
 * silhouette family each texture belongs to. Families group textures whose
 * opaque mask is byte-identical; the family representative is the
 * byte-smallest path in the family.
 */

export interface CatalogTextureEntry {
	readonly path: string;
	readonly category: string;
	readonly width: number;
	readonly height: number;
	readonly animated: boolean;
	readonly family: string;
}

export interface CatalogFamilyEntry {
	readonly key: string;
	readonly representative: string;
	readonly members: readonly string[];
}

export interface CatalogOptions {
	readonly vanillaPath: string;
	readonly category?: string | undefined;
	readonly page?: number | undefined;
	readonly pageSize?: number | undefined;
	readonly includeFamilies?: boolean | undefined;
}

export interface CatalogReport {
	readonly total: number;
	readonly page: number;
	readonly pageSize: number;
	readonly entries: readonly CatalogTextureEntry[];
	readonly families?: readonly CatalogFamilyEntry[] | undefined;
}

/** Scan budget shared with the directory walk. */
export const CATALOG_PNG_LIMIT = 100000;

/** Mask family key: `w×h` plus the SHA-256 of the opaque mask bytes. */
export function maskFamilyKey(
	width: number,
	height: number,
	pixels: Uint8Array,
): string {
	const mask = new Uint8Array(width * height);
	for (let i = 0; i < width * height; i += 1) {
		mask[i] = pixels[i * 4 + 3] === 255 ? 1 : 0;
	}
	const digest = createHash("sha256").update(mask).digest("hex");
	return `${width}x${height}:${digest}`;
}

/** Category is the first segment under `textures/`. */
export function categoryForTexturePath(path: string): string {
	const marker = "textures/";
	const at = path.indexOf(marker);
	if (at < 0) {
		return "";
	}
	const rest = path.slice(at + marker.length);
	const cut = rest.indexOf("/");
	return cut < 0 ? "" : rest.slice(0, cut);
}

function compareBytes(a: string, b: string): number {
	return Buffer.from(a, "utf8").compare(Buffer.from(b, "utf8"));
}

/** Walk `assets/` without following symbolic links; byte-ordered results. */
async function walkAssets(assetsDir: string): Promise<string[]> {
	const found: string[] = [];
	async function walk(
		currentDir: string,
		currentRelative: string,
	): Promise<void> {
		let dirEntries: import("node:fs").Dirent<string>[];
		try {
			dirEntries = await readdir(currentDir, {
				withFileTypes: true,
				encoding: "utf8",
			});
		} catch {
			throw new McAssetError(
				"PACK_CATALOG_INVALID",
				`Cannot read vanilla directory: ${currentDir}.`,
				{ vanillaPath: currentDir },
			);
		}
		for (const entry of dirEntries) {
			const entryName = String(entry.name);
			if (entry.isSymbolicLink()) {
				throw new McAssetError(
					"PACK_CATALOG_INVALID",
					`Symbolic links are not supported: ${join(currentDir, entryName)}.`,
					{ path: join(currentDir, entryName) },
				);
			}
			const relPath =
				currentRelative === "" ? entryName : `${currentRelative}/${entryName}`;
			if (entry.isDirectory()) {
				await walk(join(currentDir, entryName), relPath);
				continue;
			}
			if (entry.isFile() && entryName.toLowerCase().endsWith(".png")) {
				found.push(relPath);
			}
		}
	}
	await walk(assetsDir, "");
	found.sort(compareBytes);
	return found;
}

/** Walk a vanilla tree and report its textures with families. */
export async function catalogVanillaTextures(
	options: CatalogOptions,
): Promise<CatalogReport> {
	const vanillaPath = options.vanillaPath;
	let rootStat: Awaited<ReturnType<typeof lstat>>;
	try {
		rootStat = await lstat(vanillaPath);
	} catch {
		throw new McAssetError(
			"PACK_CATALOG_INVALID",
			`Cannot read vanilla tree: ${vanillaPath}.`,
			{ vanillaPath },
		);
	}
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new McAssetError(
			"PACK_CATALOG_INVALID",
			`Vanilla tree is not a readable directory: ${vanillaPath}.`,
			{ vanillaPath },
		);
	}
	const assetsDir = join(vanillaPath, "assets");
	try {
		const assetsStat = await lstat(assetsDir);
		if (!assetsStat.isDirectory() || assetsStat.isSymbolicLink()) {
			throw new Error("not-a-directory");
		}
	} catch {
		throw new McAssetError(
			"PACK_CATALOG_INVALID",
			`Vanilla tree has no assets directory: ${vanillaPath}.`,
			{ vanillaPath, assetsPath: join(vanillaPath, "assets") },
		);
	}
	const relatives = await walkAssets(assetsDir);
	if (relatives.length > CATALOG_PNG_LIMIT) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			`Vanilla tree holds ${relatives.length} PNG files, exceeding the limit of ${CATALOG_PNG_LIMIT}.`,
			{ limit: CATALOG_PNG_LIMIT, actual: relatives.length },
		);
	}
	const textures: CatalogTextureEntry[] = [];
	const familyMembers = new Map<string, string[]>();
	for (const rel of relatives) {
		const fullPath = join(assetsDir, ...rel.split("/"));
		const bytes = await readFile(fullPath);
		const decoded = decodePng(new Uint8Array(bytes));
		const width = decoded.canvas.width;
		const height = decoded.canvas.height;
		const layer = decoded.canvas.layers[0];
		const pixels = layer === undefined ? new Uint8Array(0) : layer.pixels;
		const key = maskFamilyKey(width, height, pixels);
		const displayPath = `assets/${rel}`;
		const category = categoryForTexturePath(displayPath);
		let animated = false;
		try {
			const sidecar = await lstat(`${fullPath}.mcmeta`);
			animated = sidecar.isFile() && !sidecar.isSymbolicLink();
		} catch {
			animated = false;
		}
		if (!animated && width !== 0 && height % width === 0 && height > width) {
			animated = true;
		}
		const entry: CatalogTextureEntry = {
			path: displayPath,
			category,
			width,
			height,
			animated,
			family: key,
		};
		textures.push(entry);
		const members = familyMembers.get(key) ?? [];
		members.push(displayPath);
		familyMembers.set(key, members);
	}
	const filtered =
		options.category === undefined
			? textures
			: textures.filter((entry) => entry.category === options.category);
	const pageSize = options.pageSize ?? 100;
	const page = options.page ?? 1;
	if (!Number.isInteger(page) || page < 1) {
		throw new McAssetError("PACK_CATALOG_INVALID", "Page starts at 1.", {
			page,
		});
	}
	if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
		throw new McAssetError(
			"PACK_CATALOG_INVALID",
			"Page size is 1 to 1000 entries.",
			{ pageSize },
		);
	}
	const start = (page - 1) * pageSize;
	const entries = filtered.slice(start, start + pageSize);
	if (options.includeFamilies === true) {
		const families: CatalogFamilyEntry[] = [...familyMembers.entries()]
			.map(([key, members]) => {
				const sorted = [...members].sort(compareBytes);
				return {
					key,
					representative: sorted[0] ?? "",
					members: sorted,
				};
			})
			.sort((a, b) => compareBytes(a.key, b.key));
		return { total: filtered.length, page, pageSize, entries, families };
	}
	return { total: filtered.length, page, pageSize, entries };
}
