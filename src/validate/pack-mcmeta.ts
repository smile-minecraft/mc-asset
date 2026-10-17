import type { ValidateFindingLevel } from "./checks.ts";
import type { PackCoverageSkip } from "./pack.ts";

/**
 * pack.mcmeta structure checker. Pure: it reads one already-parsed
 * pack.mcmeta document plus the facts the scan collected, and never
 * touches the filesystem. Every rule mirrors one documented game
 * behaviour, so a finding only appears where the game itself reacts.
 *
 * Errors, the game refuses to load the pack:
 * - no description. A missing or non-object pack section counts too,
 *   because then the required description cannot be read at all.
 * - only one end of min_format/max_format declared.
 * - a negative min_format or max_format value, in the pack section or in
 *   one overlay entry.
 * - min above max, in the pack section or in one overlay entry.
 * - supported_formats present while min_format is 65.0 or later.
 * - supported_formats disagreeing with the min_format/max_format majors
 *   while the pack still covers resource pack formats below 65.
 * - a retained legacy pack_format outside the min_format..max_format major span.
 * - an overlay directory using characters outside a-z, A-Z, 0-9, "_", "-", ".".
 * - an overlay formats field that contradicts the old-format rule: an
 *   overlay reaching below 65.0 forces formats on every overlay entry,
 *   and when no overlay reaches below 65.0 the field must be absent.
 *
 * Warnings, the game still loads the pack but something looks wrong:
 * - an overlay directory the pack root does not hold.
 * - an overlay entry that declares no version field at all.
 * - a scan target outside the range the pack declares.
 *
 * Two values are read as written and never accused, because the game
 * accepts them: a max_format beyond every known version (9999,
 * 2147483647) and uppercase or dots inside an overlay directory name.
 * A value the accepted syntax does not cover, such as a string or a
 * ragged array, is also left alone: the scan reports the defect it can
 * prove and stays quiet about the ones it cannot.
 *
 * Format values accept an integer, a one-element array, or a two-element
 * array holding a major and a minor. An integer min_format is that major
 * at minor 0; an integer max_format, like a one-element array, covers
 * every minor of that major, which is why 2147483647 needs no special
 * case here. The old and new resource pack formats split at 65.
 *
 * Coverage: an overlay whose version range covers the scan target has its
 * contents left uninterpreted, so it records one skip beside the matching
 * PACK_COVERAGE_SKIPPED warning. An overlay directory the pack root does
 * not hold records the warning alone, because there is nothing to leave
 * uninterpreted. Without a resolved target no overlay is effective, so
 * nothing is skipped.
 */

/** Finding codes this module can produce, coverage skips included. */
export type PackMcmetaFindingCode =
	| "PACK_MCMETA_INVALID"
	| "PACK_MCMETA_SUSPICIOUS"
	| "PACK_COVERAGE_SKIPPED";

export interface PackMcmetaInput {
	/** Parsed pack.mcmeta document; never a raw file or a parse error. */
	doc: unknown;
	/** Effective scan target as dotted major.minor, or undefined. */
	packFormat: string | undefined;
	/** Top-level directory names in the pack root; overlays live there. */
	rootDirectories: ReadonlySet<string>;
}

export interface PackMcmetaFinding {
	code: PackMcmetaFindingCode;
	level: ValidateFindingLevel;
	message: string;
}

export interface PackMcmetaCheckResult {
	findings: PackMcmetaFinding[];
	skipped: PackCoverageSkip[];
}

/** The old and new resource pack formats split at 65. */
const OLD_FORMAT_CEILING = 64;

/** Overlay directory names accept exactly these characters, per the game. */
const OVERLAY_DIRECTORY_PATTERN = /^[-_a-zA-Z0-9.]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One format value in the shape the game accepts. An absent minor means
 * the value named a major alone: as a lower bound it starts at minor 0,
 * as an upper bound it covers every minor of that major.
 */
interface FormatParts {
	major: number;
	minor: number | undefined;
}

/** Both ends of a usable declared range. */
interface DeclaredRange {
	min: FormatParts;
	max: FormatParts;
}

/** One overlay entry that passed the shape gate, with its verdicts so far. */
interface OverlayEntry {
	raw: Record<string, unknown>;
	directory: string;
	min: FormatParts | undefined;
	broken: boolean;
}

/**
 * Read one format value in the shape the game accepts: an integer, a
 * one-element array, or a two-element array holding a major and a minor.
 * An accepted shape with any component below zero returns "negative"; any
 * other shape returns undefined and is left alone, because the scan only
 * reports the defects it can prove.
 */
function parseFormatValue(
	value: unknown,
): FormatParts | "negative" | undefined {
	if (typeof value === "number") {
		if (!Number.isInteger(value)) {
			return undefined;
		}
		return value < 0 ? "negative" : { major: value, minor: undefined };
	}
	if (Array.isArray(value)) {
		if (value.length !== 1 && value.length !== 2) {
			return undefined;
		}
		const [major, minor] = value;
		if (typeof major !== "number" || !Number.isInteger(major)) {
			return undefined;
		}
		if (value.length === 1) {
			return major < 0 ? "negative" : { major, minor: undefined };
		}
		if (typeof minor !== "number" || !Number.isInteger(minor)) {
			return undefined;
		}
		return major < 0 || minor < 0 ? "negative" : { major, minor };
	}
	return undefined;
}

function isParts(
	value: FormatParts | "negative" | undefined,
): value is FormatParts {
	return value !== undefined && value !== "negative";
}

/**
 * Read the effective scan target, a dotted major.minor string. Any other
 * shape reads as undefined and raises no target warning.
 */
function parseTargetFormat(
	value: string | undefined,
): { major: number; minor: number } | undefined {
	if (value === undefined) {
		return undefined;
	}
	const dot = value.indexOf(".");
	const majorText = dot < 0 ? value : value.slice(0, dot);
	const minorText = dot < 0 ? "0" : value.slice(dot + 1);
	if (!/^\d+$/.test(majorText) || !/^\d+$/.test(minorText)) {
		return undefined;
	}
	return { major: Number(majorText), minor: Number(minorText) };
}

/** Is the target below the declared lower bound? */
function isBelowTarget(
	target: { major: number; minor: number },
	min: FormatParts,
): boolean {
	const minMinor = min.minor ?? 0;
	return (
		target.major < min.major ||
		(target.major === min.major && target.minor < minMinor)
	);
}

/**
 * Is the target above the declared upper bound? A single-integer upper
 * bound covers every minor of its major, so only the majors compare.
 */
function isAboveTarget(
	target: { major: number; minor: number },
	max: FormatParts,
): boolean {
	if (max.minor === undefined) {
		return target.major > max.major;
	}
	return (
		target.major > max.major ||
		(target.major === max.major && target.minor > max.minor)
	);
}

/** min above max leaves the range empty; a major-only max compares majors. */
function isReversed(min: FormatParts, max: FormatParts): boolean {
	const minMinor = min.minor ?? 0;
	if (max.minor === undefined) {
		return min.major > max.major;
	}
	return (
		min.major > max.major || (min.major === max.major && minMinor > max.minor)
	);
}

/**
 * Read the pack section's declared range. Half a range, a negative end,
 * or an inverted range each report once and leave no usable range, so no
 * downstream check repeats the same defect under a second code.
 */
function readDeclaredRange(
	pack: Record<string, unknown>,
	error: (message: string) => void,
): DeclaredRange | undefined {
	const minParsed = parseFormatValue(pack.min_format);
	const maxParsed = parseFormatValue(pack.max_format);
	if (minParsed === "negative") {
		error(
			`"pack.mcmeta" declares a negative "min_format"; version values cannot be negative.`,
		);
	}
	if (maxParsed === "negative") {
		error(
			`"pack.mcmeta" declares a negative "max_format"; version values cannot be negative.`,
		);
	}
	const min = isParts(minParsed) ? minParsed : undefined;
	const max = isParts(maxParsed) ? maxParsed : undefined;
	if (min !== undefined && pack.max_format === undefined) {
		error(
			`"pack.mcmeta" declares "min_format" without "max_format"; both ends of a range belong together.`,
		);
	}
	if (max !== undefined && pack.min_format === undefined) {
		error(
			`"pack.mcmeta" declares "max_format" without "min_format"; both ends of a range belong together.`,
		);
	}
	if (min === undefined || max === undefined) {
		return undefined;
	}
	if (isReversed(min, max)) {
		error(
			`"pack.mcmeta" declares "min_format" above "max_format"; the range covers no version.`,
		);
		return undefined;
	}
	return { min, max };
}

/**
 * The legacy supported_formats field: refused from 65 on, and while old
 * formats are covered it must repeat the declared majors, ending at
 * max_format or at 64.
 */
function checkSupportedFormats(
	pack: Record<string, unknown>,
	range: DeclaredRange,
	error: (message: string) => void,
): void {
	const supported = pack.supported_formats;
	if (supported === undefined) {
		return;
	}
	if (range.min.major > OLD_FORMAT_CEILING) {
		error(
			`"pack.mcmeta" declares "supported_formats" although "min_format" is 65 or later; the legacy field is refused from 65 on.`,
		);
		return;
	}
	if (!isRecord(supported)) {
		return;
	}
	const inclusive = parseFormatValue(supported.min_inclusive);
	if (isParts(inclusive) && inclusive.major !== range.min.major) {
		error(
			`"pack.mcmeta" repeats "supported_formats.min_inclusive" as ${inclusive.major} while "min_format" declares major ${range.min.major}; the legacy field must repeat the declared major.`,
		);
	}
	const exclusive = parseFormatValue(supported.max_inclusive);
	if (
		isParts(exclusive) &&
		exclusive.major !== range.max.major &&
		exclusive.major !== OLD_FORMAT_CEILING
	) {
		error(
			`"pack.mcmeta" repeats "supported_formats.max_inclusive" as ${exclusive.major}; it must repeat "max_format" (${range.max.major}) or stop at 64.`,
		);
	}
}

/** A retained legacy pack_format must stay inside the declared majors. */
function checkRetainedPackFormat(
	pack: Record<string, unknown>,
	range: DeclaredRange,
	error: (message: string) => void,
): void {
	const legacy = parseFormatValue(pack.pack_format);
	if (!isParts(legacy)) {
		return;
	}
	if (legacy.major < range.min.major || legacy.major > range.max.major) {
		error(
			`"pack.mcmeta" retains "pack_format" ${legacy.major} outside the declared range ${range.min.major}..${range.max.major}.`,
		);
	}
}

/** The major an overlay entry reaches down to, the legacy field included. */
function overlayMinMajor(entry: OverlayEntry): number | undefined {
	if (entry.min !== undefined) {
		return entry.min.major;
	}
	const formats = entry.raw.formats;
	if (!isRecord(formats)) {
		return undefined;
	}
	const inclusive = parseFormatValue(formats.min_inclusive);
	return isParts(inclusive) ? inclusive.major : undefined;
}

/**
 * The range that decides whether an overlay applies to the scan target:
 * the modern min_format/max_format when both read, otherwise the legacy
 * formats bounds. Without a readable range the entry applies to no
 * version the scan can name, so no skip is recorded.
 */
function overlayTargetRange(entry: OverlayEntry): DeclaredRange | undefined {
	const minParsed = parseFormatValue(entry.raw.min_format);
	const maxParsed = parseFormatValue(entry.raw.max_format);
	if (
		isParts(minParsed) &&
		isParts(maxParsed) &&
		!isReversed(minParsed, maxParsed)
	) {
		return { min: minParsed, max: maxParsed };
	}
	const formats = entry.raw.formats;
	if (!isRecord(formats)) {
		return undefined;
	}
	const inclusive = parseFormatValue(formats.min_inclusive);
	const exclusive = parseFormatValue(formats.max_inclusive);
	if (
		isParts(inclusive) &&
		isParts(exclusive) &&
		!isReversed(inclusive, exclusive)
	) {
		return { min: inclusive, max: exclusive };
	}
	return undefined;
}

/**
 * Overlay entries: directory names, per-entry ranges, the legacy formats
 * rule across the whole block, and the coverage skip for every entry that
 * applies to the scan target. An entry that already carries an error
 * keeps to itself, so one defect never drags a second code or a skip
 * along, and a declared directory the pack root does not hold warns
 * without a skip because there is nothing to leave uninterpreted.
 */
function checkOverlays(
	input: PackMcmetaInput,
	skipped: PackCoverageSkip[],
	error: (message: string) => void,
	warn: (message: string) => void,
	noteCoverage: (message: string) => void,
): void {
	if (!isRecord(input.doc)) {
		return;
	}
	const overlays = input.doc.overlays;
	if (!isRecord(overlays) || !Array.isArray(overlays.entries)) {
		return;
	}
	const entries: OverlayEntry[] = [];
	for (const raw of overlays.entries) {
		if (!isRecord(raw)) {
			continue;
		}
		const directory = raw.directory;
		if (typeof directory !== "string") {
			continue;
		}
		const minParsed = parseFormatValue(raw.min_format);
		const maxParsed = parseFormatValue(raw.max_format);
		const min = isParts(minParsed) ? minParsed : undefined;
		const max = isParts(maxParsed) ? maxParsed : undefined;
		let broken = false;
		if (!OVERLAY_DIRECTORY_PATTERN.test(directory)) {
			error(
				`overlay "${directory}" uses characters outside [-_a-zA-Z0-9.]; the game refuses the entry.`,
			);
			broken = true;
		}
		if (minParsed === "negative") {
			error(
				`overlay "${directory}" declares a negative "min_format"; version values cannot be negative.`,
			);
			broken = true;
		}
		if (maxParsed === "negative") {
			error(
				`overlay "${directory}" declares a negative "max_format"; version values cannot be negative.`,
			);
			broken = true;
		}
		if (min !== undefined && max !== undefined && isReversed(min, max)) {
			error(
				`overlay "${directory}" declares "min_format" above "max_format"; the entry covers no version.`,
			);
			broken = true;
		}
		entries.push({ raw, directory, min, broken });
	}
	// The legacy formats field follows the whole block: one entry reaching
	// below 65.0 forces the field on every entry, and with no such entry
	// the field must stay absent.
	const reachesOldFormats = entries.some((entry) => {
		if (entry.broken) {
			return false;
		}
		const major = overlayMinMajor(entry);
		return major !== undefined && major <= OLD_FORMAT_CEILING;
	});
	for (const entry of entries) {
		if (entry.broken) {
			continue;
		}
		const hasFormats = entry.raw.formats !== undefined;
		if (reachesOldFormats && !hasFormats) {
			error(
				`overlay "${entry.directory}" declares no "formats" although an entry reaches resource pack formats below 65; every entry must carry the legacy range.`,
			);
			entry.broken = true;
		} else if (!reachesOldFormats && hasFormats) {
			error(
				`overlay "${entry.directory}" declares "formats" although no entry reaches resource pack formats below 65; the legacy field must be absent.`,
			);
			entry.broken = true;
		}
	}
	const targetText = input.packFormat;
	const target = parseTargetFormat(targetText);
	const seenSkips = new Set<string>();
	for (const entry of entries) {
		if (entry.broken) {
			continue;
		}
		const raw = entry.raw;
		if (
			raw.min_format === undefined &&
			raw.max_format === undefined &&
			raw.formats === undefined
		) {
			warn(
				`overlay "${entry.directory}" declares none of min_format, max_format, or formats; the entry applies to no version.`,
			);
		}
		if (!input.rootDirectories.has(entry.directory)) {
			warn(
				`overlay "${entry.directory}" is declared by "pack.mcmeta" but the pack root holds no such directory.`,
			);
			continue;
		}
		if (target === undefined || targetText === undefined) {
			continue;
		}
		const range = overlayTargetRange(entry);
		if (range === undefined) {
			continue;
		}
		if (isBelowTarget(target, range.min) || isAboveTarget(target, range.max)) {
			continue;
		}
		if (seenSkips.has(entry.directory)) {
			continue;
		}
		seenSkips.add(entry.directory);
		skipped.push({
			kind: "overlay",
			reason: "overlay-not-interpreted",
			target: entry.directory,
		});
		noteCoverage(
			`overlay "${entry.directory}" applies to scan target ${targetText} but is not interpreted; coverage recorded as skipped.`,
		);
	}
}

/**
 * Check one parsed pack.mcmeta: the description, the declared pack range,
 * the legacy majors, every overlay entry name and range, the overlay
 * formats rule, and the coverage of each overlay the scan leaves
 * uninterpreted. Pure over its input; findings and skips come back for
 * the scan to merge.
 */
export function checkPackMcmeta(input: PackMcmetaInput): PackMcmetaCheckResult {
	const findings: PackMcmetaFinding[] = [];
	const skipped: PackCoverageSkip[] = [];
	const error = (message: string): void => {
		findings.push({ code: "PACK_MCMETA_INVALID", level: "error", message });
	};
	const warn = (message: string): void => {
		findings.push({
			code: "PACK_MCMETA_SUSPICIOUS",
			level: "warning",
			message,
		});
	};
	const noteCoverage = (message: string): void => {
		findings.push({ code: "PACK_COVERAGE_SKIPPED", level: "warning", message });
	};
	const doc = isRecord(input.doc) ? input.doc : undefined;
	const pack = doc !== undefined && isRecord(doc.pack) ? doc.pack : undefined;
	if (pack === undefined) {
		error(
			`"pack.mcmeta" has no pack section; the required "pack.description" cannot be read.`,
		);
	} else if (pack.description === undefined || pack.description === null) {
		error(
			`"pack.mcmeta" declares no "pack.description"; the game refuses a pack without one.`,
		);
	}
	if (pack !== undefined) {
		const range = readDeclaredRange(pack, error);
		if (range !== undefined) {
			checkSupportedFormats(pack, range, error);
			checkRetainedPackFormat(pack, range, error);
			const targetText = input.packFormat;
			const target = parseTargetFormat(targetText);
			if (
				target !== undefined &&
				targetText !== undefined &&
				(isBelowTarget(target, range.min) || isAboveTarget(target, range.max))
			) {
				warn(
					`scan target "${targetText}" sits outside the ${range.min.major}..${range.max.major} range declared by "pack.mcmeta".`,
				);
			}
		}
	}
	checkOverlays(input, skipped, error, warn, noteCoverage);
	return { findings, skipped };
}
