/**
 * Deterministic particle definition generation.
 *
 * A particle definition names an ordered list of frame sprites. The game
 * resolves every `textures[]` entry as `assets/<namespace>/textures/particle/
 * <path>.png`: the entry carries no `.png` extension and no `textures/particle/`
 * prefix. This module turns decoded frames into the definition text and the
 * canonical PNG bytes for each sprite, so the CLI, the MCP tool, and a future
 * pack recipe all share one implementation.
 */

import { McAssetError } from "../core/errors.ts";
import type { PixelCanvas } from "../core/types.ts";
import { encodePng } from "../io/png.ts";

/** Directory below `assets/<namespace>/` that holds particle definitions. */
export const PARTICLE_DEFINITION_DIRECTORY = "particles";

/** Sprite directory below `assets/<namespace>/textures/`. */
export const PARTICLE_TEXTURE_DIRECTORY = "particle";

/** Character set of a namespace; mirrors the validate-pack resource-location rules. */
const NAMESPACE_PATTERN = /^[a-z0-9_.-]+$/;

/** Character set of one path segment (the id and the sprite prefix). */
const SEGMENT_PATTERN = /^[a-z0-9._-]+$/;

/** One decoded frame, in the order the caller loaded it. */
export interface ParticleFrame {
	/** Source file name; reported and used for the deterministic sort. */
	readonly name: string;
	readonly canvas: PixelCanvas;
}

/** Everything the generator needs to plan one particle asset. */
export interface ParticlePlanRequest {
	/** Namespace of both the definition and the sprites. */
	readonly namespace: string;
	/** Particle id; the definition lands at `particles/<id>.json`. */
	readonly id: string;
	/** Sprite leaf prefix; defaults to `id`. */
	readonly texturePrefix?: string | undefined;
	/** Frames in playback order. The planner re-sorts them by name bytes. */
	readonly frames: readonly ParticleFrame[];
}

/** One sprite file and the resource location that names it. */
export interface ParticleTextureOutput {
	/** Source frame name. */
	readonly frame: string;
	/** Reference written into `textures[]`, e.g. `demo:spark_0`. */
	readonly texture: string;
	/** Path below `textures/particle/`, without `.png`. */
	readonly leaf: string;
	/** Pack-relative PNG path, e.g. `assets/demo/textures/particle/spark_0.png`. */
	readonly relativePath: string;
	readonly width: number;
	readonly height: number;
	/** Canonical PNG bytes. */
	readonly data: Uint8Array;
}

/** The definition document and its exact serialized text. */
export interface ParticleDefinitionOutput {
	/** Pack-relative path, e.g. `assets/demo/particles/spark.json`. */
	readonly relativePath: string;
	readonly json: { readonly textures: readonly string[] };
	/** Two-space indent plus one trailing newline. */
	readonly text: string;
}

/** One complete, deterministic particle asset plan. */
export interface ParticleAssetPlan {
	readonly namespace: string;
	readonly id: string;
	readonly definition: ParticleDefinitionOutput;
	/** In frame order, one per input frame. */
	readonly textures: readonly ParticleTextureOutput[];
}

/**
 * UTF-8 byte order: code points are first encoded the way the filesystem
 * stores them, so the result never depends on the locale or `readdir` order.
 */
const UTF8 = new TextEncoder();

export function compareFrameNames(left: string, right: string): number {
	const a = UTF8.encode(left);
	const b = UTF8.encode(right);
	const shared = a.length < b.length ? a.length : b.length;
	for (let index = 0; index < shared; index += 1) {
		const delta = (a[index] as number) - (b[index] as number);
		if (delta !== 0) {
			return delta;
		}
	}
	return a.length - b.length;
}

/** Validate a namespace and return it unchanged. */
export function validateParticleNamespace(value: string): string {
	if (!NAMESPACE_PATTERN.test(value)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Invalid particle namespace "${value}"; expected [a-z0-9_.-].`,
			{ field: "namespace", value },
		);
	}
	return value;
}

/** Validate the particle id (one path segment) and return it unchanged. */
export function validateParticleId(value: string): string {
	if (!SEGMENT_PATTERN.test(value)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Invalid particle id "${value}"; expected one lowercase segment [a-z0-9._-].`,
			{ field: "id", value },
		);
	}
	return value;
}

/** Resolve and validate the sprite prefix (default: the particle id). */
export function resolveTexturePrefix(
	prefix: string | undefined,
	id: string,
): string {
	const value = prefix === undefined || prefix === "" ? id : prefix;
	if (!SEGMENT_PATTERN.test(value)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`Invalid texture prefix "${value}"; expected one lowercase segment [a-z0-9._-].`,
			{ field: "texturePrefix", value },
		);
	}
	return value;
}

/** Pack-relative definition path. */
export function particleDefinitionRelativePath(
	namespace: string,
	id: string,
): string {
	return `assets/${namespace}/${PARTICLE_DEFINITION_DIRECTORY}/${id}.json`;
}

/** Pack-relative sprite path. */
export function particleTextureRelativePath(
	namespace: string,
	leaf: string,
): string {
	return `assets/${namespace}/textures/${PARTICLE_TEXTURE_DIRECTORY}/${leaf}.png`;
}

/**
 * Plan one particle asset. The frames are sorted by UTF-8 file-name bytes,
 * so neither `readdir` order nor the caller's input order can change the
 * output. The sprite leaf is `<prefix>_<index>` in that sorted order, the
 * definition references it as `<namespace>:<leaf>`, and the returned PNG
 * bytes come from the canonical encoder.
 */
export function planParticleAsset(
	request: ParticlePlanRequest,
): ParticleAssetPlan {
	const namespace = validateParticleNamespace(request.namespace);
	const id = validateParticleId(request.id);
	const prefix = resolveTexturePrefix(request.texturePrefix, id);
	if (request.frames.length === 0) {
		throw new McAssetError(
			"INVALID_ANIMATION_FRAME",
			"A particle definition needs at least one frame.",
			{ count: 0 },
		);
	}
	const ordered = [...request.frames].sort((left, right) =>
		compareFrameNames(left.name, right.name),
	);
	const textures: ParticleTextureOutput[] = ordered.map((frame, index) => {
		const leaf = `${prefix}_${index}`;
		return {
			frame: frame.name,
			texture: `${namespace}:${leaf}`,
			leaf,
			relativePath: particleTextureRelativePath(namespace, leaf),
			width: frame.canvas.width,
			height: frame.canvas.height,
			data: encodePng(frame.canvas),
		};
	});
	const json = {
		textures: textures.map((texture) => texture.texture),
	};
	return {
		namespace,
		id,
		definition: {
			relativePath: particleDefinitionRelativePath(namespace, id),
			json,
			text: `${JSON.stringify(json, null, 2)}\n`,
		},
		textures,
	};
}
