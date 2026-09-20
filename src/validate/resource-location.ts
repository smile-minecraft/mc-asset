import type { ValidateFinding } from "./checks.ts";

/**
 * Resource Location Validator (§108.3). Single implementation point
 * for every resource location rule: the single-file `validate` filename
 * check and `validate-pack` scan import from here, never from a
 * second copy of the character sets. Pure and read-only: strings in,
 * findings out. No I/O, no timestamps, no randomness.
 *
 * Conservative sets (frozen): namespace [a-z0-9_.-], path [a-z0-9/._-],
 * all lowercase. Length MUST NOT reject, so no length rule exists here.
 * Uppercase is owned by PACK_CASE_MISMATCH alone: the charset tests run on
 * the lowercased value, so one cause yields one code. Findings always fold
 * in canonical order: namespace, path, case, filename, extension.
 */

export interface ParsedResourceLocation {
	namespace: string;
	path: string;
	hasExplicitNamespace: boolean;
}

/** Missing ":" defaults to minecraft (§95 witness). */
export const RESOURCE_LOCATION_DEFAULT_NAMESPACE = "minecraft";

const NAMESPACE_PATTERN = /^[a-z0-9_.-]+$/;
const PATH_PATTERN = /^[a-z0-9/._-]+$/;
const FILENAME_PATTERN = /^[a-z0-9._-]+$/;
const UPPERCASE_PATTERN = /[A-Z]/;

function basenameOf(value: string): string {
	const slash = value.lastIndexOf("/");
	const backslash = value.lastIndexOf("\\");
	const cut = slash > backslash ? slash : backslash;
	return cut < 0 ? value : value.slice(cut + 1);
}

/**
 * Split "<namespace>:<path>" on the first colon. A missing colon keeps the
 * whole value as the path under the default namespace; extra colons stay in
 * the path, where the path charset rule rejects them as PACK_WRONG_PATH.
 */
export function parseResourceLocation(value: string): ParsedResourceLocation {
	const cut = value.indexOf(":");
	if (cut < 0) {
		return {
			namespace: RESOURCE_LOCATION_DEFAULT_NAMESPACE,
			path: value,
			hasExplicitNamespace: false,
		};
	}
	return {
		namespace: value.slice(0, cut),
		path: value.slice(cut + 1),
		hasExplicitNamespace: true,
	};
}

function lastSegmentOf(path: string): string {
	const cut = path.lastIndexOf("/");
	return cut < 0 ? path : path.slice(cut + 1);
}

function extensionOf(segment: string): string {
	const dot = segment.lastIndexOf(".");
	return dot < 0 ? "" : segment.slice(dot + 1);
}

/**
 * Full location check: namespace, path, case, filename, extension. Each
 * violated rule contributes exactly one finding; a clean location yields an
 * empty list. The extension finding is warning-only (pending-source fact);
 * every other finding is an error.
 */
export function validateResourceLocation(value: string): ValidateFinding[] {
	const parsed = parseResourceLocation(value);
	const findings: ValidateFinding[] = [];
	const namespace = parsed.namespace;
	if (namespace === "" || !NAMESPACE_PATTERN.test(namespace.toLowerCase())) {
		findings.push({
			code: "PACK_NAMESPACE_PROBLEM",
			level: "error",
			message: `invalid namespace "${namespace}" in "${value}"; expected [a-z0-9_.-].`,
		});
	}
	const path = parsed.path;
	if (
		path === "" ||
		path.startsWith("/") ||
		path.endsWith("/") ||
		path.includes("//") ||
		!PATH_PATTERN.test(path.toLowerCase())
	) {
		findings.push({
			code: "PACK_WRONG_PATH",
			level: "error",
			message: `invalid path "${path}" in "${value}"; expected [a-z0-9/._-] with no leading, trailing, or doubled "/".`,
		});
	}
	if (UPPERCASE_PATTERN.test(value)) {
		findings.push({
			code: "PACK_CASE_MISMATCH",
			level: "error",
			message: `resource location "${value}" must be all lowercase.`,
		});
	}
	const segment = lastSegmentOf(path);
	if (segment === "" || !FILENAME_PATTERN.test(segment.toLowerCase())) {
		findings.push({
			code: "PACK_INVALID_FILENAME",
			level: "error",
			message: `invalid filename "${segment}" in "${value}"; expected [a-z0-9._-].`,
		});
	}
	if (extensionOf(segment) !== "png") {
		findings.push({
			code: "PENDING_SOURCE_PNG_ONLY",
			level: "warning",
			message: `extension of "${segment}" is not .png; texture-png-only is pending an official source, reported as warning only.`,
		});
	}
	return findings;
}

/**
 * Filename-level check for single-file `validate` (§108.6): only what the
 * file itself carries — the stem's case and charset. The stem is the
 * basename before the final dot, so an uppercase extension stays with the
 * existing FILENAME_EXTENSION_NOT_PNG rule instead of double-reporting.
 * An empty stem ("" or ".png") is PACK_INVALID_FILENAME.
 */
export function validateDiskFilename(filename: string): ValidateFinding[] {
	const base = basenameOf(filename);
	const dot = base.lastIndexOf(".");
	const stem = dot < 0 ? base : base.slice(0, dot);
	const findings: ValidateFinding[] = [];
	if (UPPERCASE_PATTERN.test(stem)) {
		findings.push({
			code: "PACK_CASE_MISMATCH",
			level: "error",
			message: `filename stem "${stem}" must be all lowercase; got "${base}".`,
		});
	}
	if (stem === "" || !FILENAME_PATTERN.test(stem.toLowerCase())) {
		findings.push({
			code: "PACK_INVALID_FILENAME",
			level: "error",
			message: `invalid filename stem "${stem}"; expected [a-z0-9._-], got "${base}".`,
		});
	}
	return findings;
}
