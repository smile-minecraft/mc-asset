import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { McAssetError } from "../core/errors.ts";
import { parseResourceLocation } from "../validate/resource-location.ts";
import { MODEL_LIMITS } from "./limits.ts";
import type { FaceRotation } from "./types.ts";
import { MODEL_FEATURE_SINCE, type ModelRules } from "./versions.ts";

export interface ItemBindingSpec {
	readonly itemId: string; // "namespace:path" the definition file is named after
	readonly modelId: string; // "namespace:path" of a model under models/
	readonly handAnimationOnSwap?: boolean;
	readonly oversizedInGui?: boolean;
	readonly swapAnimationScale?: number;
}

export interface BlockstateEntrySpec {
	readonly model: string;
	readonly x?: FaceRotation;
	readonly y?: FaceRotation;
	/** Needs rule blockstateZRotation. */
	readonly z?: FaceRotation;
	readonly uvlock?: boolean;
	/** Only inside an array of alternatives. */
	readonly weight?: number;
}

export interface BlockstateBindingSpec {
	readonly blockId: string;
	/** Key: "" or "name=value,name=value" (names sorted by the tool). */
	readonly variants?: Readonly<
		Record<string, BlockstateEntrySpec | readonly BlockstateEntrySpec[]>
	>;
	readonly multipart?: readonly {
		/** Simple conditions only; OR/AND trees are out of scope. Values may be "a|b". */
		readonly when?: Readonly<Record<string, string | boolean>>;
		readonly apply: BlockstateEntrySpec | readonly BlockstateEntrySpec[];
	}[];
}

export interface BindingText {
	readonly text: string;
}

export interface BindingOutputTargetOptions {
	readonly packPath?: string;
	readonly kind?: "item" | "blockstate";
	readonly id?: string;
	readonly force?: boolean;
}

const encoder = new TextEncoder();

function compareBytes(a: string, b: string): number {
	const ab = encoder.encode(a);
	const bb = encoder.encode(b);
	const end = ab.length < bb.length ? ab.length : bb.length;
	for (let i = 0; i < end; i += 1) {
		const x = ab[i] as number;
		const y = bb[i] as number;
		if (x !== y) {
			return x - y;
		}
	}
	return ab.length - bb.length;
}

const VALID_ROTATIONS = new Set<number>([0, 90, 180, 270]);

function formatEntry(
	entry: BlockstateEntrySpec,
	inArray: boolean,
	rules: ModelRules,
): Record<string, unknown> {
	if (!inArray && entry.weight !== undefined) {
		throw new McAssetError(
			"MODEL_INVALID_STRUCTURE",
			"Weight is only allowed inside an array of alternative models.",
		);
	}
	if (
		entry.weight !== undefined &&
		(!Number.isInteger(entry.weight) || entry.weight < 1)
	) {
		throw new McAssetError(
			"MODEL_INVALID_STRUCTURE",
			"Weight must be a positive integer.",
		);
	}

	if (entry.x !== undefined && !VALID_ROTATIONS.has(entry.x)) {
		throw new McAssetError(
			"MODEL_INVALID_STRUCTURE",
			`Rotation angle for x must be 0, 90, 180, or 270 (received ${entry.x}).`,
		);
	}
	if (entry.y !== undefined && !VALID_ROTATIONS.has(entry.y)) {
		throw new McAssetError(
			"MODEL_INVALID_STRUCTURE",
			`Rotation angle for y must be 0, 90, 180, or 270 (received ${entry.y}).`,
		);
	}
	if (entry.z !== undefined) {
		if (!VALID_ROTATIONS.has(entry.z)) {
			throw new McAssetError(
				"MODEL_INVALID_STRUCTURE",
				`Rotation angle for z must be 0, 90, 180, or 270 (received ${entry.z}).`,
			);
		}
		if (rules.has("blockstateZRotation") !== true) {
			throw new McAssetError(
				"MODEL_UNSUPPORTED_VERSION",
				`z rotation in blockstates requires pack format ${MODEL_FEATURE_SINCE.blockstateZRotation} or higher.`,
				{
					feature: "blockstateZRotation",
					since: MODEL_FEATURE_SINCE.blockstateZRotation,
					target: rules.packFormat ?? "unspecified",
				},
			);
		}
	}

	const formatted: Record<string, unknown> = {
		model: entry.model,
	};
	if (entry.x !== undefined) {
		formatted.x = entry.x;
	}
	if (entry.y !== undefined) {
		formatted.y = entry.y;
	}
	if (entry.z !== undefined) {
		formatted.z = entry.z;
	}
	if (entry.uvlock !== undefined) {
		formatted.uvlock = entry.uvlock;
	}
	if (entry.weight !== undefined) {
		formatted.weight = entry.weight;
	}
	return formatted;
}

/** Needs rule itemDefinitions (pack format >= 46.0), else MODEL_UNSUPPORTED_VERSION. */
export function buildItemDefinition(
	spec: ItemBindingSpec,
	rules: ModelRules,
): BindingText {
	if (rules.has("itemDefinitions") !== true) {
		throw new McAssetError(
			"MODEL_UNSUPPORTED_VERSION",
			`Item definitions require pack format ${MODEL_FEATURE_SINCE.itemDefinitions} or higher; place model at assets/<namespace>/models/item/<item>.json for legacy versions.`,
			{
				feature: "itemDefinitions",
				since: MODEL_FEATURE_SINCE.itemDefinitions,
				target: rules.packFormat ?? "unspecified",
				reason: "item-definitions-require-46.0",
			},
		);
	}

	if (
		spec.oversizedInGui !== undefined &&
		rules.has("oversizedInGui") !== true
	) {
		throw new McAssetError(
			"MODEL_UNSUPPORTED_VERSION",
			`oversized_in_gui requires pack format ${MODEL_FEATURE_SINCE.oversizedInGui} or higher.`,
			{
				feature: "oversizedInGui",
				since: MODEL_FEATURE_SINCE.oversizedInGui,
				target: rules.packFormat ?? "unspecified",
			},
		);
	}

	if (
		spec.swapAnimationScale !== undefined &&
		rules.has("swapAnimationScale") !== true
	) {
		throw new McAssetError(
			"MODEL_UNSUPPORTED_VERSION",
			`swap_animation_scale requires pack format ${MODEL_FEATURE_SINCE.swapAnimationScale} or higher.`,
			{
				feature: "swapAnimationScale",
				since: MODEL_FEATURE_SINCE.swapAnimationScale,
				target: rules.packFormat ?? "unspecified",
			},
		);
	}

	const doc: Record<string, unknown> = {
		model: {
			type: "minecraft:model",
			model: spec.modelId,
		},
	};
	if (spec.handAnimationOnSwap !== undefined) {
		doc.hand_animation_on_swap = spec.handAnimationOnSwap;
	}
	if (spec.oversizedInGui !== undefined) {
		doc.oversized_in_gui = spec.oversizedInGui;
	}
	if (spec.swapAnimationScale !== undefined) {
		doc.swap_animation_scale = spec.swapAnimationScale;
	}

	return {
		text: `${JSON.stringify(doc, null, 2)}\n`,
	};
}

/** Exactly one of variants / multipart must be present. */
export function buildBlockstate(
	spec: BlockstateBindingSpec,
	rules: ModelRules,
): BindingText {
	const hasVariants = spec.variants !== undefined;
	const hasMultipart = spec.multipart !== undefined;
	if ((hasVariants && hasMultipart) || (!hasVariants && !hasMultipart)) {
		throw new McAssetError(
			"MODEL_INVALID_STRUCTURE",
			"Exactly one of 'variants' or 'multipart' must be provided in BlockstateBindingSpec.",
		);
	}

	if (hasVariants && spec.variants !== undefined) {
		const rawKeys = Object.keys(spec.variants);
		if (rawKeys.length > MODEL_LIMITS.maxVariants) {
			throw new McAssetError(
				"RESOURCE_LIMIT_EXCEEDED",
				`Blockstate variant keys exceed limit of ${MODEL_LIMITS.maxVariants}.`,
				{ limit: MODEL_LIMITS.maxVariants, actual: rawKeys.length },
			);
		}

		// Normalize and validate keys
		const normalizedEntries: Array<{
			key: string;
			value: BlockstateEntrySpec | readonly BlockstateEntrySpec[];
		}> = [];

		for (const key of rawKeys) {
			let sortedKey = key;
			if (key !== "") {
				const parts = key.split(",");
				for (const part of parts) {
					if (!/^[a-z0-9_]+=[a-z0-9_]+$/.test(part)) {
						throw new McAssetError(
							"MODEL_INVALID_STRUCTURE",
							`Invalid variant key format "${key}". Each property pair must match ^[a-z0-9_]+=[a-z0-9_]+$.`,
						);
					}
				}
				sortedKey = parts.sort(compareBytes).join(",");
			}
			const entryValue = spec.variants[key];
			if (entryValue !== undefined) {
				normalizedEntries.push({ key: sortedKey, value: entryValue });
			}
		}

		normalizedEntries.sort((a, b) => compareBytes(a.key, b.key));

		const variantsDoc: Record<string, unknown> = {};
		for (const { key, value } of normalizedEntries) {
			if (Array.isArray(value)) {
				variantsDoc[key] = value.map((item) => formatEntry(item, true, rules));
			} else {
				variantsDoc[key] = formatEntry(
					value as BlockstateEntrySpec,
					false,
					rules,
				);
			}
		}

		return {
			text: `${JSON.stringify({ variants: variantsDoc }, null, 2)}\n`,
		};
	}

	if (hasMultipart && spec.multipart !== undefined) {
		if (spec.multipart.length > MODEL_LIMITS.maxMultipartParts) {
			throw new McAssetError(
				"RESOURCE_LIMIT_EXCEEDED",
				`Blockstate multipart items exceed limit of ${MODEL_LIMITS.maxMultipartParts}.`,
				{
					limit: MODEL_LIMITS.maxMultipartParts,
					actual: spec.multipart.length,
				},
			);
		}

		const multipartDoc = spec.multipart.map((part) => {
			const formattedPart: Record<string, unknown> = {};
			if (part.when !== undefined) {
				const whenDoc: Record<string, string> = {};
				const whenKeys = Object.keys(part.when).sort(compareBytes);
				for (const k of whenKeys) {
					const v = part.when[k];
					whenDoc[k] =
						typeof v === "boolean" ? (v ? "true" : "false") : String(v);
				}
				formattedPart.when = whenDoc;
			}
			if (Array.isArray(part.apply)) {
				formattedPart.apply = part.apply.map((item) =>
					formatEntry(item, true, rules),
				);
			} else {
				formattedPart.apply = formatEntry(
					part.apply as BlockstateEntrySpec,
					false,
					rules,
				);
			}
			return formattedPart;
		});

		return {
			text: `${JSON.stringify({ multipart: multipartDoc }, null, 2)}\n`,
		};
	}

	throw new McAssetError(
		"MODEL_INVALID_STRUCTURE",
		"Unexpected blockstate specification.",
	);
}

/**
 * Asserts that the binding output target path is valid and does not overwrite an existing file.
 * Binding files NEVER overwrite existing files, even with force: true.
 * Throws OUTPUT_EXISTS or INVALID_ARGUMENT.
 */
export function assertBindingOutputTarget(
	targetPath: string,
	options?: BindingOutputTargetOptions,
): void {
	if (options?.packPath !== undefined) {
		const input = targetPath.replace(/\\/g, "/");
		const packPath = resolve(options.packPath.replace(/\\/g, "/"));
		const target = resolve(input);
		const rel = relative(packPath, target).split(sep).join("/");
		const invalid: (message: string) => never = (message) => {
			throw new McAssetError("INVALID_ARGUMENT", message, {
				path: targetPath,
				packPath: options.packPath,
			});
		};
		if (
			input.split("/").includes("..") ||
			rel === ".." ||
			rel.startsWith("../") ||
			isAbsolute(rel)
		) {
			invalid(
				"Target path must remain inside the pack without parent traversal.",
			);
		}
		const validLocation = (namespace: string, path: string): boolean =>
			/^[a-z0-9_.-]+$/.test(namespace) &&
			namespace !== "." &&
			namespace !== ".." &&
			/^[a-z0-9/._-]+$/.test(path) &&
			path
				.split("/")
				.every(
					(segment) => segment !== "" && segment !== "." && segment !== "..",
				);
		const layout =
			/^assets\/([^/]+)\/(models|items|blockstates)\/(.+)\.json$/.exec(rel);
		if (
			layout === null ||
			!validLocation(layout[1] as string, layout[3] as string)
		) {
			invalid("Target path does not match a valid model or binding layout.");
		}
		const folder =
			options.kind === "item"
				? "items"
				: options.kind === "blockstate"
					? "blockstates"
					: "models";
		if (layout[2] !== folder) {
			invalid(`Target path must be under assets/<namespace>/${folder}/.`);
		}
		if (options.kind !== undefined) {
			if (options.id === undefined)
				invalid("Binding target requires a resource id.");
			const parsed = parseResourceLocation(options.id);
			if (!validLocation(parsed.namespace, parsed.path))
				invalid("Binding id is not a valid resource location.");
			const expected = `assets/${parsed.namespace}/${folder}/${parsed.path}.json`;
			if (rel !== expected)
				invalid(`Target path does not match expected layout "${expected}".`);
		}
	}

	if (existsSync(targetPath)) {
		throw new McAssetError(
			"OUTPUT_EXISTS",
			`Output file already exists and will not be overwritten: "${targetPath}".`,
			{ path: targetPath },
		);
	}
}
