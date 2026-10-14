import { type JsonNode, jsonPointer } from "./json-document.ts";
import type {
	ModelCoverageSkip,
	ModelFinding,
	ModelStructureCode,
	ModelStructureResult,
} from "./structure.ts";
import type { ModelRules } from "./versions.ts";

function member(node: JsonNode, key: string): JsonNode | undefined {
	return node.type === "object"
		? node.members.find((entry) => entry.key === key)?.value
		: undefined;
}

const VALID_ROTATIONS = new Set<number>([0, 90, 180, 270]);

/**
 * Validates the structure and field values of a parsed blockstate document.
 * Checks x/y/z rotation values, version-gated z rotation,
 * boolean uvlock type, weight placement, and structure limits.
 */
export function validateBlockstateStructure(
	root: JsonNode,
	rules: ModelRules,
	rel: string,
): ModelStructureResult {
	const findings: ModelFinding[] = [];
	const skipped: ModelCoverageSkip[] = [];

	const report = (
		code: ModelStructureCode,
		level: "error" | "warning",
		pointerSegments: readonly (string | number)[],
		message: string,
	): void => {
		findings.push({
			code,
			level,
			pointer: jsonPointer(pointerSegments),
			message,
		});
	};

	if (root.type !== "object") {
		report(
			"MODEL_INVALID_STRUCTURE",
			"error",
			[],
			"Blockstate root must be an object.",
		);
		return { findings, skipped: [] };
	}

	const variantsNode = member(root, "variants");
	const multipartNode = member(root, "multipart");

	const checkEntry = (
		entry: Extract<JsonNode, { type: "object" }>,
		basePointer: readonly (string | number)[],
		inArray: boolean,
	): void => {
		const x = member(entry, "x");
		if (x !== undefined) {
			if (x.type !== "number" || !VALID_ROTATIONS.has(x.value)) {
				report(
					"MODEL_INVALID_ROTATION",
					"error",
					[...basePointer, "x"],
					`Rotation angle for x must be 0, 90, 180, or 270 (received ${x.type === "number" ? x.raw : "non-number"}).`,
				);
			}
		}

		const y = member(entry, "y");
		if (y !== undefined) {
			if (y.type !== "number" || !VALID_ROTATIONS.has(y.value)) {
				report(
					"MODEL_INVALID_ROTATION",
					"error",
					[...basePointer, "y"],
					`Rotation angle for y must be 0, 90, 180, or 270 (received ${y.type === "number" ? y.raw : "non-number"}).`,
				);
			}
		}

		const z = member(entry, "z");
		if (z !== undefined) {
			if (z.type !== "number" || !VALID_ROTATIONS.has(z.value)) {
				report(
					"MODEL_INVALID_ROTATION",
					"error",
					[...basePointer, "z"],
					`Rotation angle for z must be 0, 90, 180, or 270 (received ${z.type === "number" ? z.raw : "non-number"}).`,
				);
			} else if (rules.has("blockstateZRotation") === false) {
				report(
					"MODEL_VERSION_FEATURE",
					"error",
					[...basePointer, "z"],
					'Rotation on "z" axis requires pack format 75.0 or higher.',
				);
			} else if (rules.has("blockstateZRotation") === undefined) {
				skipped.push({
					kind: "model-version-rules",
					target: `${rel}#${jsonPointer([...basePointer, "z"])}`,
					reason: "feature-version-unknown",
					detail: "blockstateZRotation",
				});
			}
		}

		const uvlock = member(entry, "uvlock");
		if (uvlock !== undefined && uvlock.type !== "boolean") {
			report(
				"MODEL_INVALID_STRUCTURE",
				"error",
				[...basePointer, "uvlock"],
				'"uvlock" must be a boolean.',
			);
		}

		const weight = member(entry, "weight");
		if (weight !== undefined) {
			if (!inArray) {
				report(
					"MODEL_INVALID_STRUCTURE",
					"error",
					[...basePointer, "weight"],
					'"weight" is only allowed inside an array of alternatives.',
				);
			} else if (
				weight.type !== "number" ||
				weight.value < 1 ||
				!Number.isInteger(weight.value)
			) {
				report(
					"MODEL_INVALID_STRUCTURE",
					"error",
					[...basePointer, "weight"],
					'"weight" must be a positive integer.',
				);
			}
		}
	};

	if (variantsNode !== undefined) {
		if (variantsNode.type !== "object") {
			report(
				"MODEL_INVALID_STRUCTURE",
				"error",
				["variants"],
				'"variants" must be an object.',
			);
		} else {
			for (const entry of variantsNode.members) {
				const { key, value } = entry;
				if (key !== "") {
					const parts = key.split(",");
					const valid = parts.every((part) =>
						/^[a-z0-9_]+=[a-z0-9_]+$/.test(part),
					);
					if (!valid) {
						report(
							"MODEL_INVALID_STRUCTURE",
							"error",
							["variants", key],
							`Invalid variant key format "${key}".`,
						);
					}
				}

				if (value.type === "object") {
					checkEntry(value, ["variants", key], false);
				} else if (value.type === "array") {
					for (const [idx, item] of value.items.entries()) {
						if (item.type === "object") {
							checkEntry(item, ["variants", key, idx], true);
						} else {
							report(
								"MODEL_INVALID_STRUCTURE",
								"error",
								["variants", key, idx],
								"Variant entry must be an object.",
							);
						}
					}
				} else {
					report(
						"MODEL_INVALID_STRUCTURE",
						"error",
						["variants", key],
						"Variant entry must be an object or an array of objects.",
					);
				}
			}
		}
	}

	if (multipartNode !== undefined) {
		if (multipartNode.type !== "array") {
			report(
				"MODEL_INVALID_STRUCTURE",
				"error",
				["multipart"],
				'"multipart" must be an array.',
			);
		} else {
			for (const [idx, item] of multipartNode.items.entries()) {
				if (item.type !== "object") {
					report(
						"MODEL_INVALID_STRUCTURE",
						"error",
						["multipart", idx],
						"Multipart part must be an object.",
					);
					continue;
				}

				const when = member(item, "when");
				if (when !== undefined && when.type !== "object") {
					report(
						"MODEL_INVALID_STRUCTURE",
						"error",
						["multipart", idx, "when"],
						'"when" must be an object.',
					);
				}

				const apply = member(item, "apply");
				if (apply === undefined) {
					report(
						"MODEL_INVALID_STRUCTURE",
						"error",
						["multipart", idx],
						'Multipart part must specify "apply".',
					);
				} else if (apply.type === "object") {
					checkEntry(apply, ["multipart", idx, "apply"], false);
				} else if (apply.type === "array") {
					for (const [subIdx, subItem] of apply.items.entries()) {
						if (subItem.type === "object") {
							checkEntry(subItem, ["multipart", idx, "apply", subIdx], true);
						} else {
							report(
								"MODEL_INVALID_STRUCTURE",
								"error",
								["multipart", idx, "apply", subIdx],
								"Multipart apply entry must be an object.",
							);
						}
					}
				} else {
					report(
						"MODEL_INVALID_STRUCTURE",
						"error",
						["multipart", idx, "apply"],
						'"apply" must be an object or an array of objects.',
					);
				}
			}
		}
	}

	return {
		findings,
		skipped,
	};
}
