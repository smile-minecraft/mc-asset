/** Bounded JSON access shared by the .bbmodel importer and exporter. */

import { McAssetError } from "../../core/errors.ts";
import { MODEL_LIMITS } from "../limits.ts";

const encoder = new TextEncoder();

export function byteLength(value: string): number {
	return encoder.encode(value).length;
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function invalidDocument(
	reason: string,
	details: Record<string, unknown> = {},
): never {
	throw new McAssetError(
		"BBMODEL_INVALID_DOCUMENT",
		`Invalid .bbmodel document: ${reason}.`,
		{ reason, ...details },
	);
}

export function unsupportedFormat(
	modelFormat: unknown,
	details: Record<string, unknown> = {},
): never {
	throw new McAssetError(
		"BBMODEL_UNSUPPORTED_FORMAT",
		`Not a Java Block/Item (.bbmodel) project: model_format is ${JSON.stringify(modelFormat)}.`,
		{ reason: "model-format", modelFormat, ...details },
	);
}

/** The file byte limit applies to the .bbmodel text exactly as it does to model JSON. */
export function checkFileBytes(text: string, label: string): void {
	const actual = byteLength(text);
	if (actual > MODEL_LIMITS.maxFileBytes) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			`${label} exceeds ${MODEL_LIMITS.maxFileBytes} bytes.`,
			{ limit: MODEL_LIMITS.maxFileBytes, actual },
		);
	}
}

export function checkStringBytes(value: string, label: string): void {
	const actual = byteLength(value);
	if (actual > MODEL_LIMITS.maxStringBytes) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			`${label} exceeds ${MODEL_LIMITS.maxStringBytes} bytes.`,
			{ limit: MODEL_LIMITS.maxStringBytes, actual },
		);
	}
}

/** Parse .bbmodel text: JSON.parse, one byte limit, and an object root. */
export function parseBbmodelDocument(text: string): Record<string, unknown> {
	checkFileBytes(text, "The .bbmodel file");
	if (text.startsWith("<lz>")) {
		invalidDocument("compressed projects are not supported", {
			reason: "compressed",
		});
	}
	let value: unknown;
	try {
		value = JSON.parse(text) as unknown;
	} catch {
		invalidDocument("not valid JSON", { reason: "syntax" });
	}
	if (!isObject(value)) invalidDocument("root is not an object");
	return value;
}

export function objectField(
	source: Record<string, unknown>,
	key: string,
	context: string,
): Record<string, unknown> | undefined {
	const value = source[key];
	if (value === undefined) return undefined;
	if (!isObject(value)) invalidDocument(`${context}.${key} is not an object`);
	return value;
}

export function arrayField(
	source: Record<string, unknown>,
	key: string,
	context: string,
): readonly unknown[] | undefined {
	const value = source[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value))
		invalidDocument(`${context}.${key} is not an array`);
	return value;
}

export function stringField(
	source: Record<string, unknown>,
	key: string,
	context: string,
): string | undefined {
	const value = source[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string")
		invalidDocument(`${context}.${key} is not a string`);
	return value;
}

export function numberField(
	source: Record<string, unknown>,
	key: string,
	context: string,
): number | undefined {
	const value = source[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		invalidDocument(`${context}.${key} is not a finite number`);
	}
	return value;
}

export function booleanField(
	source: Record<string, unknown>,
	key: string,
	context: string,
): boolean | undefined {
	const value = source[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean")
		invalidDocument(`${context}.${key} is not a boolean`);
	return value;
}

/** A fixed-length tuple of finite numbers; the context names the field for details. */
export function numberTuple(
	value: unknown,
	length: number,
	context: string,
): number[] {
	if (!Array.isArray(value) || value.length !== length) {
		invalidDocument(`${context} must be an array of ${length} numbers`);
	}
	const numbers: number[] = [];
	for (const [index, item] of value.entries()) {
		if (typeof item !== "number" || !Number.isFinite(item)) {
			invalidDocument(`${context}[${index}] is not a finite number`);
		}
		numbers.push(item);
	}
	return numbers;
}
