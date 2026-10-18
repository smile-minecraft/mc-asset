/**
 * JSON value helpers shared by the style data model and its resolver: the
 * plain-object test that drives strict validation, and the deep copy that
 * keeps resolved styles from sharing module constants.
 */

export type JsonObject = Record<string, unknown>;

/** True for a JSON object: not null and not an array. */
export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep copy of a JSON value; primitives and non-JSON values pass through. */
export function cloneJsonValue<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map((entry) => cloneJsonValue(entry)) as T;
	}
	if (isJsonObject(value)) {
		const out: JsonObject = {};
		for (const [key, entry] of Object.entries(value)) {
			out[key] = cloneJsonValue(entry);
		}
		return out as T;
	}
	return value;
}
