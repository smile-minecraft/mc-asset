import { readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
	buildLayerIndex,
	type ResolutionSource,
} from "../validate/resource-context.ts";

export interface ModelResolutionLayer {
	readonly source: ResolutionSource;
	has(rel: string): boolean;
	/** Bytes of a pack file, or undefined when the layer lacks it. Never writes. */
	read(rel: string): Promise<Uint8Array | undefined>;
}

export interface ModelResolutionContext {
	readonly layers: readonly ModelResolutionLayer[];
	readonly hasVanilla: boolean;
}

export function createStandaloneContext(): ModelResolutionContext {
	return { layers: [], hasVanilla: false };
}

export interface FsContextRoots {
	readonly packRoot?: string;
	readonly dependencyRoots?: readonly string[];
	readonly vanillaRoot?: string;
}

interface IndexedModelLayer extends ModelResolutionLayer {
	caseVariant(rel: string): string | undefined;
}

async function createLayer(
	root: string,
	source: ResolutionSource,
): Promise<IndexedModelLayer> {
	const index = await buildLayerIndex(root);
	const absoluteRoot = await realpath(root);
	return {
		source,
		has: (rel) => index.files.has(rel),
		caseVariant: (rel) => index.folded.get(rel.toLowerCase()),
		async read(rel) {
			if (!index.files.has(rel)) return undefined;
			const target = resolve(root, rel);
			const fromRoot = relative(root, target);
			if (
				fromRoot === ".." ||
				fromRoot.startsWith(`..${sep}`) ||
				fromRoot.startsWith(sep)
			)
				return undefined;
			try {
				const actualPath = await realpath(target);
				const actualRelative = relative(absoluteRoot, actualPath);
				if (
					actualRelative === ".." ||
					actualRelative.startsWith(`..${sep}`) ||
					actualRelative.startsWith(sep)
				)
					return undefined;
				return new Uint8Array(await readFile(actualPath));
			} catch {
				return undefined;
			}
		},
	};
}

export async function createFsModelContext(
	roots: FsContextRoots,
): Promise<ModelResolutionContext> {
	const layers: ModelResolutionLayer[] = [];
	if (roots.packRoot !== undefined)
		layers.push(await createLayer(roots.packRoot, "current"));
	for (const [index, root] of (roots.dependencyRoots ?? []).entries()) {
		layers.push(await createLayer(root, `dependency:${index}`));
	}
	if (roots.vanillaRoot !== undefined)
		layers.push(await createLayer(roots.vanillaRoot, "vanilla"));
	return { layers, hasVanilla: roots.vanillaRoot !== undefined };
}
