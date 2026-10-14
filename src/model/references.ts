import { isBuiltinModel } from "../profiles/builtin-models.ts";
import type { ResolutionSource } from "../validate/resource-context.ts";
import type {
	ModelResolutionContext,
	ModelResolutionLayer,
} from "./context.ts";
import type { JsonNode } from "./json-document.ts";

export interface ModelDocument {
	readonly id: string;
	readonly rel: string;
	readonly source: ResolutionSource | "own";
	readonly root: JsonNode;
}

export interface ModelReferenceResolution {
	readonly resourceLocation: string;
	readonly status:
		| "resolved"
		| "missing"
		| "unresolved"
		| "builtin"
		| "case-mismatch";
	readonly source?: ResolutionSource;
	readonly target?: string;
	readonly reason?:
		| "no-resolution-context"
		| "vanilla-not-provided"
		| "not-found";
	readonly layer?: ModelResolutionLayer;
}

interface CaseAwareLayer extends ModelResolutionLayer {
	caseVariant?(rel: string): string | undefined;
}

export function resourceLocationParts(value: string): {
	namespace: string;
	path: string;
} {
	const separator = value.indexOf(":");
	return separator < 0
		? { namespace: "minecraft", path: value }
		: {
				namespace: value.slice(0, separator),
				path: value.slice(separator + 1),
			};
}

export function modelResourcePath(value: string): string {
	const { namespace, path } = resourceLocationParts(value);
	const withoutExtension = path.endsWith(".json") ? path.slice(0, -5) : path;
	return `assets/${namespace}/models/${withoutExtension}.json`;
}

export function textureResourcePath(value: string): string {
	const { namespace, path } = resourceLocationParts(value);
	const leaf = path.slice(path.lastIndexOf("/") + 1);
	const withExtension = leaf.includes(".") ? path : `${path}.png`;
	return `assets/${namespace}/textures/${withExtension}`;
}

export function resolveModelReference(
	context: ModelResolutionContext,
	resourceLocation: string,
): ModelReferenceResolution {
	return resolve(
		context,
		resourceLocation,
		modelResourcePath(resourceLocation),
		"model",
	);
}

export function resolveTextureReference(
	context: ModelResolutionContext,
	resourceLocation: string,
): ModelReferenceResolution {
	return resolve(
		context,
		resourceLocation,
		textureResourcePath(resourceLocation),
		"texture",
	);
}

function resolve(
	context: ModelResolutionContext,
	resourceLocation: string,
	rel: string,
	kind: "model" | "texture",
): ModelReferenceResolution {
	for (const layer of context.layers) {
		if (layer.has(rel))
			return {
				resourceLocation,
				status: "resolved",
				source: layer.source,
				target: rel,
				layer,
			};
	}
	for (const layer of context.layers) {
		const variant = (layer as CaseAwareLayer).caseVariant?.(rel);
		if (variant !== undefined)
			return {
				resourceLocation,
				status: "case-mismatch",
				source: layer.source,
				target: variant,
				layer,
			};
	}
	if (kind === "model" && isBuiltinModel(resourceLocation)) {
		return {
			resourceLocation,
			status: "builtin",
			source: "builtin",
			target: resourceLocation,
		};
	}
	if (context.layers.length === 0) {
		return {
			resourceLocation,
			status: "unresolved",
			reason: "no-resolution-context",
		};
	}
	if (
		resourceLocationParts(resourceLocation).namespace === "minecraft" &&
		!context.hasVanilla
	) {
		return {
			resourceLocation,
			status: "unresolved",
			reason: "vanilla-not-provided",
		};
	}
	return { resourceLocation, status: "missing", reason: "not-found" };
}

export function byteCompare(left: string, right: string): number {
	const encoder = new TextEncoder();
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
		const difference = (a[index] as number) - (b[index] as number);
		if (difference !== 0) return difference;
	}
	return a.length - b.length;
}
