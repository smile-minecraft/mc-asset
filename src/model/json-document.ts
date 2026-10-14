import { McAssetError } from "../core/errors.ts";
import { MODEL_LIMITS } from "./limits.ts";

export type JsonNode =
	| { readonly type: "null" }
	| { readonly type: "boolean"; readonly value: boolean }
	| { readonly type: "number"; readonly raw: string; readonly value: number }
	| { readonly type: "string"; readonly value: string }
	| { readonly type: "array"; readonly items: readonly JsonNode[] }
	| { readonly type: "object"; readonly members: readonly JsonMember[] };

export interface JsonMember {
	readonly key: string;
	readonly value: JsonNode;
}

const encoder = new TextEncoder();

function invalidJson(text: string, reason: string, offset: number): never {
	throw new McAssetError(
		"MODEL_INVALID_JSON",
		`Invalid model JSON: ${reason}.`,
		{
			reason,
			offset: Math.max(0, Math.min(offset, text.length)),
		},
	);
}

function resourceLimit(message: string, limit: number, actual: number): never {
	throw new McAssetError("RESOURCE_LIMIT_EXCEEDED", message, { limit, actual });
}

function stringBytes(value: string): number {
	return encoder.encode(value).length;
}

function hasLoneSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return true;
		}
	}
	return false;
}

export function parseJsonDocument(text: string): JsonNode {
	const bytes = stringBytes(text);
	if (bytes > MODEL_LIMITS.maxFileBytes) {
		resourceLimit(
			"Model JSON exceeds the file byte limit.",
			MODEL_LIMITS.maxFileBytes,
			bytes,
		);
	}
	if (text.charCodeAt(0) === 0xfeff) invalidJson(text, "bom-not-allowed", 0);

	let offset = 0;
	const whitespace = (): void => {
		while (offset < text.length) {
			const code = text.charCodeAt(offset);
			if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d)
				offset += 1;
			else break;
		}
	};
	const checkStringSize = (value: string, start: number): void => {
		const actual = stringBytes(value);
		if (actual > MODEL_LIMITS.maxStringBytes) {
			resourceLimit(
				"Model JSON string exceeds the byte limit.",
				MODEL_LIMITS.maxStringBytes,
				actual,
			);
		}
		if (hasLoneSurrogate(value)) invalidJson(text, "lone-surrogate", start);
	};
	const parseString = (): string => {
		const start = offset;
		offset += 1;
		let escaped = false;
		while (offset < text.length) {
			const code = text.charCodeAt(offset);
			if (!escaped && code === 0x22) {
				offset += 1;
				const raw = text.slice(start, offset);
				let value: string;
				try {
					value = JSON.parse(raw) as string;
				} catch {
					invalidJson(text, "invalid-string-escape", start);
				}
				checkStringSize(value, start);
				return value;
			}
			if (!escaped && code < 0x20)
				invalidJson(text, "unescaped-control-character", offset);
			if (escaped) escaped = false;
			else if (code === 0x5c) escaped = true;
			offset += 1;
		}
		invalidJson(text, "unterminated-string", start);
	};

	const parseValue = (depth: number): JsonNode => {
		whitespace();
		const start = offset;
		const char = text[offset];
		if (char === "{" || char === "[") {
			if (depth > MODEL_LIMITS.maxJsonDepth)
				invalidJson(text, "depth-limit", start);
			const object = char === "{";
			offset += 1;
			whitespace();
			if (object) {
				const members: JsonMember[] = [];
				const names = new Set<string>();
				if (text[offset] === "}") {
					offset += 1;
					return { type: "object", members };
				}
				while (true) {
					whitespace();
					if (text[offset] !== '"')
						invalidJson(text, "expected-object-key", offset);
					const keyOffset = offset;
					const key = parseString();
					if (names.has(key)) invalidJson(text, "duplicate-key", keyOffset);
					names.add(key);
					whitespace();
					if (text[offset] !== ":") invalidJson(text, "expected-colon", offset);
					offset += 1;
					const value = parseValue(depth + 1);
					members.push({ key, value });
					whitespace();
					if (text[offset] === "}") {
						offset += 1;
						return { type: "object", members };
					}
					if (text[offset] !== ",")
						invalidJson(text, "expected-object-separator", offset);
					offset += 1;
				}
			}
			const items: JsonNode[] = [];
			if (text[offset] === "]") {
				offset += 1;
				return { type: "array", items };
			}
			while (true) {
				items.push(parseValue(depth + 1));
				whitespace();
				if (text[offset] === "]") {
					offset += 1;
					return { type: "array", items };
				}
				if (text[offset] !== ",")
					invalidJson(text, "expected-array-separator", offset);
				offset += 1;
			}
		}
		if (char === '"') return { type: "string", value: parseString() };
		for (const [literal, node] of [
			["true", { type: "boolean", value: true }],
			["false", { type: "boolean", value: false }],
			["null", { type: "null" }],
		] as const) {
			if (text.startsWith(literal, offset)) {
				offset += literal.length;
				return node;
			}
		}
		const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
			text.slice(offset),
		);
		if (match?.[0]) {
			offset += match[0].length;
			return { type: "number", raw: match[0], value: Number(match[0]) };
		}
		invalidJson(text, "expected-value", start);
	};

	whitespace();
	const root = parseValue(1);
	whitespace();
	if (offset !== text.length) invalidJson(text, "trailing-content", offset);
	if (root.type !== "object") invalidJson(text, "root-not-object", 0);
	return root;
}

function serializeNode(node: JsonNode, depth: number): string {
	const indent = "  ".repeat(depth);
	const childIndent = "  ".repeat(depth + 1);
	switch (node.type) {
		case "null":
			return "null";
		case "boolean":
			return node.value ? "true" : "false";
		case "number":
			return node.raw;
		case "string":
			return JSON.stringify(node.value);
		case "array":
			if (node.items.length === 0) return "[]";
			return (
				`[` +
				`\n${node.items.map((item) => `${childIndent}${serializeNode(item, depth + 1)}`).join(",\n")}\n${indent}]`
			);
		case "object":
			if (node.members.length === 0) return "{}";
			return `{\n${node.members.map(({ key, value }) => `${childIndent}${JSON.stringify(key)}: ${serializeNode(value, depth + 1)}`).join(",\n")}\n${indent}}`;
	}
}

export function serializeJsonDocument(node: JsonNode): string {
	return `${serializeNode(node, 0)}\n`;
}

export function jsonPointer(segments: readonly (string | number)[]): string {
	return segments
		.map(
			(segment) =>
				`/${String(segment).replace(/~/g, "~0").replace(/\//g, "~1")}`,
		)
		.join("");
}
