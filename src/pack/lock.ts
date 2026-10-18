/**
 * Resource-pack build plan and lock document types.
 *
 * Full parsing, validation, serialization, and comparison for `mc-asset.lock.json`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McAssetError } from "../core/errors.ts";
import {
	canonicalDocumentText,
	isJsonObject,
	isRelativeProjectPath,
} from "./document.ts";
import { compareCodeUnits } from "./skeleton.ts";

/** A lock entry for one planned output. */
export interface LockEntry {
	readonly targetId: string;
	readonly recipeId: string;
	readonly kind: "texture" | "model" | "itemDefinition" | "mcmeta";
	readonly category?: string | undefined;
	readonly inputHash: string;
	readonly outputHash: string;
}

/** A parsed lock document. */
export interface LockDocument {
	readonly formatVersion: number;
	readonly tool: { readonly name: string; readonly version: string };
	readonly project: { readonly namespace: string; readonly style: string };
	readonly outputs: Readonly<Record<string, LockEntry>>;
}

let cachedToolVersion: string | undefined;

/** Resolve tool version safely across Node and Bun without JSON import assertions. */
export function getToolVersion(): string {
	if (cachedToolVersion !== undefined) {
		return cachedToolVersion;
	}
	try {
		const dir = dirname(fileURLToPath(import.meta.url));
		const pkgPath = join(dir, "../../package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
			version?: string;
		};
		cachedToolVersion = pkg.version ?? "0.4.0";
	} catch {
		cachedToolVersion = "0.4.0";
	}
	return cachedToolVersion;
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** Parse a lock document text in strict mode. */
export function parseLockText(text: string): LockDocument {
	if (typeof text !== "string") {
		throw new McAssetError(
			"PACK_LOCK_INVALID",
			"Lockfile content must be a string.",
			{ reason: "parse" },
		);
	}
	let json: unknown;
	try {
		json = JSON.parse(text) as unknown;
	} catch {
		throw new McAssetError("PACK_LOCK_INVALID", "Cannot parse lockfile JSON.", {
			reason: "parse",
		});
	}
	if (!isJsonObject(json)) {
		throw new McAssetError(
			"PACK_LOCK_INVALID",
			"Lockfile root must be an object.",
			{ reason: "field" },
		);
	}

	const formatVersion = json.formatVersion;
	if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion)) {
		throw new McAssetError(
			"PACK_LOCK_INVALID",
			"formatVersion must be an integer.",
			{ reason: "field" },
		);
	}
	if (formatVersion > 1) {
		throw new McAssetError(
			"PACK_LOCK_UNSUPPORTED_VERSION",
			`Unsupported lockfile formatVersion: ${formatVersion}`,
			{ formatVersion },
		);
	}
	if (formatVersion < 1) {
		throw new McAssetError(
			"PACK_LOCK_INVALID",
			`Unsupported lockfile formatVersion: ${formatVersion}`,
			{ reason: "field" },
		);
	}

	const tool = json.tool;
	if (
		!isJsonObject(tool) ||
		typeof tool.name !== "string" ||
		typeof tool.version !== "string"
	) {
		throw new McAssetError(
			"PACK_LOCK_INVALID",
			"tool must be an object with name and version.",
			{ reason: "field" },
		);
	}

	const project = json.project;
	if (
		!isJsonObject(project) ||
		typeof project.namespace !== "string" ||
		typeof project.style !== "string"
	) {
		throw new McAssetError(
			"PACK_LOCK_INVALID",
			"project must be an object with namespace and style.",
			{ reason: "field" },
		);
	}

	const rawOutputs = json.outputs;
	if (!isJsonObject(rawOutputs)) {
		throw new McAssetError("PACK_LOCK_INVALID", "outputs must be an object.", {
			reason: "field",
		});
	}

	const outputs: Record<string, LockEntry> = {};
	for (const [key, rawEntry] of Object.entries(rawOutputs)) {
		if (!isRelativeProjectPath(key)) {
			throw new McAssetError(
				"PACK_LOCK_INVALID",
				`Invalid output path key in lockfile: ${key}`,
				{ reason: "entry", path: key },
			);
		}
		if (!isJsonObject(rawEntry)) {
			throw new McAssetError(
				"PACK_LOCK_INVALID",
				`Lock entry for ${key} must be an object.`,
				{ reason: "entry", path: key },
			);
		}
		const { targetId, recipeId, kind, category, inputHash, outputHash } =
			rawEntry;
		if (typeof targetId !== "string" || targetId === "") {
			throw new McAssetError(
				"PACK_LOCK_INVALID",
				`Invalid targetId for ${key}.`,
				{ reason: "entry", path: key },
			);
		}
		if (typeof recipeId !== "string" || recipeId === "") {
			throw new McAssetError(
				"PACK_LOCK_INVALID",
				`Invalid recipeId for ${key}.`,
				{ reason: "entry", path: key },
			);
		}
		if (
			kind !== "texture" &&
			kind !== "model" &&
			kind !== "itemDefinition" &&
			kind !== "mcmeta"
		) {
			throw new McAssetError(
				"PACK_LOCK_INVALID",
				`Invalid kind for ${key}: ${String(kind)}.`,
				{ reason: "entry", path: key },
			);
		}
		if (category !== undefined && typeof category !== "string") {
			throw new McAssetError(
				"PACK_LOCK_INVALID",
				`Invalid category for ${key}.`,
				{ reason: "entry", path: key },
			);
		}
		if (typeof inputHash !== "string" || !SHA256_HEX_PATTERN.test(inputHash)) {
			throw new McAssetError(
				"PACK_LOCK_INVALID",
				`Invalid inputHash for ${key}: ${String(inputHash)}.`,
				{ reason: "hash", path: key },
			);
		}
		if (
			typeof outputHash !== "string" ||
			!SHA256_HEX_PATTERN.test(outputHash)
		) {
			throw new McAssetError(
				"PACK_LOCK_INVALID",
				`Invalid outputHash for ${key}: ${String(outputHash)}.`,
				{ reason: "hash", path: key },
			);
		}
		outputs[key] = {
			targetId,
			recipeId,
			kind,
			...(category !== undefined ? { category } : {}),
			inputHash,
			outputHash,
		};
	}

	return {
		formatVersion,
		tool: { name: tool.name as string, version: tool.version as string },
		project: {
			namespace: project.namespace as string,
			style: project.style as string,
		},
		outputs,
	};
}

/** Serialize a lock document to canonical JSON text. */
export function serializeLockText(document: LockDocument): string {
	return canonicalDocumentText(document);
}

/** Compare two lock entries by their output path. */
export function compareLockPaths(a: string, b: string): number {
	return compareCodeUnits(a, b);
}

export type { McAssetError };
