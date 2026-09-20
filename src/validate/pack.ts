import { readdir, readFile } from "node:fs/promises";
import { McAssetError } from "../core/errors.ts";
import {
	checkAnimationFrameIndices,
	deriveAnimationGeometry,
	extractAnimationSection,
} from "../core/mcmeta.ts";
import { decodePng } from "../io/png.ts";
import {
	ITEM_ATLAS_PLACEMENT_FACT,
	ITEMS_ATLAS_FACT,
	resolveVersionedFact,
} from "../profiles/versions.ts";
import {
	atlasCoverageFor,
	parseAtlasDefinitions,
	requiredAtlasForModel,
} from "./atlas.ts";
import type { ValidateFindingLevel } from "./checks.ts";
import {
	parseResourceLocation,
	validateDiskFilename,
	validateResourceLocation,
} from "./resource-location.ts";

/**
 * validate-pack scan engine (V0.5 starter). Read-only end to end: the
 * pack tree is enumerated and parsed, never written. One bad file never
 * stops the scan; every defect becomes a finding and an error-level
 * finding fails the verdict.
 *
 * Starter coverage (the full matrix lives in the step handoff): model JSON
 * `parent` and `textures` references, texture PNG decode and dimensions,
 * sibling `.png.mcmeta` animation geometry, disk filename and namespace
 * checks through the shared resource-location engine. Atlas sources
 * (`assets/<namespace>/atlases/*.json`) distinguish "texture exists but
 * never entered the required atlas" (PACK_TEXTURE_NOT_IN_ATLAS, error)
 * from "texture file missing" (PACK_MISSING_TEXTURE): the atlas verdicts
 * only run while the items/split facts resolve for the effective
 * packFormat, and an undefined or partially understood atlas always skips
 * instead of accusing. The root pack.mcmeta parses for INVALID_JSON and,
 * with no version flag, lends its pack.pack_format as the scan target
 * (read-only, no default).
 */

export interface PackFinding {
	code: string;
	level: ValidateFindingLevel;
	message: string;
	path?: string | undefined;
}

export interface PackReport {
	command: "validate-pack";
	path: string;
	target: string;
	verdict: "pass" | "fail";
	findings: PackFinding[];
}

export interface PackScanOptions {
	packFormat?: number | undefined;
	target?: string | undefined;
}

/** Guard before any parsing starts: an absurd tree is exit 5, not a verdict. */
const MAX_PACK_FILES = 50000;

/** Canonical finding order inside one file (v05-design §42 table order). */
const FINDING_ORDER: Readonly<Record<string, number>> = {
	PACK_INVALID_JSON: 0,
	PACK_INVALID_FILENAME: 1,
	PACK_NAMESPACE_PROBLEM: 2,
	PACK_CASE_MISMATCH: 3,
	PACK_WRONG_PATH: 4,
	PENDING_SOURCE_PNG_ONLY: 5,
	PACK_INVALID_IMAGE_DATA: 6,
	PACK_INVALID_IMAGE_DIMENSION: 7,
	PACK_INVALID_ANIMATION_SHEET: 8,
	PACK_BROKEN_REFERENCE: 9,
	PACK_MISSING_TEXTURE: 10,
	PACK_MISSING_ASSET: 11,
	PACK_ORPHAN_TEXTURE: 12,
	PACK_VERSION_UNDETERMINED: 13,
	PACK_TEXTURE_NOT_IN_ATLAS: 14,
};

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
	"png",
	"webp",
	"jpg",
	"jpeg",
]);

const encoder = new TextEncoder();

/** Frozen PACK_VERSION_UNDETERMINED wording: no default is ever applied. */
const VERSION_UNDETERMINED_MESSAGE =
	"no version flag was given and pack.mcmeta carries no usable pack.pack_format; version-dependent checks were skipped with no default applied.";

/** Byte-lexicographic string order, identical on every runtime. */
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

function orderOf(code: string): number {
	return FINDING_ORDER[code] ?? 999;
}

function basenameOf(rel: string): string {
	const cut = rel.lastIndexOf("/");
	return cut < 0 ? rel : rel.slice(cut + 1);
}

function extensionOf(filename: string): string {
	const dot = filename.lastIndexOf(".");
	return dot < 0 ? "" : filename.slice(dot + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read-only pack.pack_format lookup over an already-parsed pack.mcmeta.
 * Only a positive integer counts; anything else (missing key, dotted
 * label, other shapes) leaves the version undetermined.
 */
function packFormatFromMcmeta(doc: unknown): number | undefined {
	if (!isRecord(doc)) {
		return undefined;
	}
	const pack = doc.pack;
	if (!isRecord(pack)) {
		return undefined;
	}
	const format = pack.pack_format;
	if (typeof format !== "number" || !Number.isInteger(format) || format < 1) {
		return undefined;
	}
	return format;
}

async function collectPackFiles(packRoot: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(dirRel: string): Promise<void> {
		const entries = (await readdir(`${packRoot}/${dirRel}`)).sort(compareBytes);
		for (const entry of entries) {
			const rel = dirRel === "" ? entry : `${dirRel}/${entry}`;
			let children: string[] | undefined;
			try {
				children = (await readdir(`${packRoot}/${rel}`)).sort(compareBytes);
			} catch {
				children = undefined;
			}
			if (children !== undefined) {
				await walk(rel);
			} else {
				out.push(rel);
			}
		}
	}
	try {
		await walk("assets");
	} catch {
		throw new McAssetError(
			"FILESYSTEM_ERROR",
			`Cannot read pack root: ${packRoot}.`,
			{ path: packRoot },
		);
	}
	// The root pack.mcmeta joins the scan when present; anything else at
	// the root (pack.png and friends) stays out of the starter's scope.
	try {
		const probe = await readFile(`${packRoot}/pack.mcmeta`);
		void probe;
		out.push("pack.mcmeta");
	} catch {
		// No pack.mcmeta: version-dependent checks simply stay skipped.
	}
	out.sort(compareBytes);
	if (out.length > MAX_PACK_FILES) {
		throw new McAssetError(
			"RESOURCE_LIMIT_EXCEEDED",
			`Pack holds ${out.length} files, above the scan limit of ${MAX_PACK_FILES}.`,
			{ files: out.length, limit: MAX_PACK_FILES },
		);
	}
	return out;
}

/** Split assets/<namespace>/<rest>; anything else has no namespace. */
function splitNamespace(
	rel: string,
): { namespace: string; rest: string } | undefined {
	if (!rel.startsWith("assets/")) {
		return undefined;
	}
	const inner = rel.slice("assets/".length);
	const cut = inner.indexOf("/");
	if (cut < 0) {
		return undefined;
	}
	return {
		namespace: inner.slice(0, cut),
		rest: inner.slice(cut + 1),
	};
}

function push(
	findings: PackFinding[],
	code: string,
	level: ValidateFindingLevel,
	message: string,
	path: string | undefined,
): void {
	if (path === undefined) {
		findings.push({ code, level, message });
	} else {
		findings.push({ code, level, message, path });
	}
}

/**
 * Reference strings go through the shared resource-location engine, minus
 * the extension rule: references omit extensions by convention, so only
 * real files on disk may warn about them (caller decision).
 */
function referenceLocationProblems(value: string): PackFinding[] {
	return validateResourceLocation(value).filter(
		(finding) => finding.code !== "PENDING_SOURCE_PNG_ONLY",
	);
}

function resolveTextureRel(value: string): string {
	const parsed = parseResourceLocation(value);
	const leaf =
		extensionOf(parsed.path) === "" ? `${parsed.path}.png` : parsed.path;
	return `assets/${parsed.namespace}/textures/${leaf}`;
}

function resolveParentRel(value: string): string {
	const parsed = parseResourceLocation(value);
	const leaf =
		parsed.path.endsWith(".json") === true
			? parsed.path
			: `${parsed.path}.json`;
	return `assets/${parsed.namespace}/models/${leaf}`;
}

interface ScanState {
	findings: PackFinding[];
	docs: Map<string, unknown>;
	dims: Map<string, { width: number; height: number }>;
	errorFiles: Set<string>;
	referencedTextures: Set<string>;
	modelRels: string[];
	atlasRefs: Array<{
		modelRel: string;
		field: string;
		value: string;
		target: string;
	}>;
}

/** Per-file checks that need no cross-file view. Order matches FINDING_ORDER. */
async function checkSingleFile(
	rel: string,
	bytes: Uint8Array,
	state: ScanState,
): Promise<void> {
	const base = basenameOf(rel);
	const lowerBase = base.toLowerCase();
	const isJson = lowerBase.endsWith(".json") || lowerBase.endsWith(".mcmeta");
	if (isJson) {
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			push(
				state.findings,
				"PACK_INVALID_JSON",
				"error",
				`"${rel}" is not valid UTF-8 JSON.`,
				rel,
			);
			state.errorFiles.add(rel);
			return await checkDiskName(rel, state);
		}
		try {
			state.docs.set(rel, JSON.parse(text) as unknown);
		} catch {
			push(
				state.findings,
				"PACK_INVALID_JSON",
				"error",
				`"${rel}" is not valid JSON.`,
				rel,
			);
			state.errorFiles.add(rel);
		}
		await checkDiskName(rel, state);
		return;
	}
	await checkDiskName(rel, state);
	const split = splitNamespace(rel);
	if (split === undefined) {
		return;
	}
	const ext = extensionOf(base);
	if (
		split.rest.startsWith("textures/") &&
		ext !== "png" &&
		IMAGE_EXTENSIONS.has(ext.toLowerCase())
	) {
		push(
			state.findings,
			"PENDING_SOURCE_PNG_ONLY",
			"warning",
			`extension of "${rel}" is not .png; texture-png-only is pending an official source, reported as warning only.`,
			rel,
		);
		return;
	}
	if (ext !== "png") {
		return;
	}
	let decoded: { width: number; height: number };
	try {
		const result = decodePng(bytes);
		decoded = {
			width: result.canvas.width,
			height: result.canvas.height,
		};
	} catch (error) {
		if (error instanceof McAssetError) {
			if (error.code === "RESOURCE_LIMIT_EXCEEDED") {
				throw error;
			}
			if (error.code === "INVALID_DIMENSION") {
				push(
					state.findings,
					"PACK_INVALID_IMAGE_DIMENSION",
					"error",
					`"${rel}" has out-of-range image dimensions.`,
					rel,
				);
				state.errorFiles.add(rel);
				return;
			}
			push(
				state.findings,
				"PACK_INVALID_IMAGE_DATA",
				"error",
				`"${rel}" cannot be decoded as a PNG image.`,
				rel,
			);
			state.errorFiles.add(rel);
			return;
		}
		throw error;
	}
	state.dims.set(rel, decoded);
}

/** Disk filename, namespace, and layout checks shared by every file. */
async function checkDiskName(rel: string, state: ScanState): Promise<void> {
	const base = basenameOf(rel);
	for (const finding of validateDiskFilename(base)) {
		push(state.findings, finding.code, finding.level, finding.message, rel);
		state.errorFiles.add(rel);
	}
	const split = splitNamespace(rel);
	if (split === undefined) {
		if (rel.startsWith("assets/")) {
			push(
				state.findings,
				"PACK_NAMESPACE_PROBLEM",
				"error",
				`"${rel}" sits directly under assets/ with no namespace directory.`,
				rel,
			);
			state.errorFiles.add(rel);
		}
		return;
	}
	if (split.namespace === "" || split.rest === "") {
		push(
			state.findings,
			"PACK_NAMESPACE_PROBLEM",
			"error",
			`"${rel}" has a missing namespace or path.`,
			rel,
		);
		state.errorFiles.add(rel);
		return;
	}
	const namespaceProbe = validateResourceLocation(
		`${split.namespace}:dummy.png`,
	);
	for (const finding of namespaceProbe) {
		if (
			finding.code === "PACK_NAMESPACE_PROBLEM" ||
			finding.code === "PACK_CASE_MISMATCH"
		) {
			push(state.findings, finding.code, finding.level, finding.message, rel);
			state.errorFiles.add(rel);
		}
	}
	const pathProbe = validateResourceLocation(
		`${split.namespace}:${split.rest}`,
	);
	for (const finding of pathProbe) {
		if (finding.code === "PACK_WRONG_PATH") {
			push(state.findings, finding.code, finding.level, finding.message, rel);
			state.errorFiles.add(rel);
		}
	}
	// Layout rule with an official source: textures live under textures/.
	// Other asset kinds have no frozen layout, so only image files outside
	// textures/ are wrong paths here.
	const ext = extensionOf(base).toLowerCase();
	if (
		IMAGE_EXTENSIONS.has(ext) &&
		!split.rest.startsWith("textures/") &&
		!split.rest.startsWith("atlases/")
	) {
		push(
			state.findings,
			"PACK_WRONG_PATH",
			"error",
			`"${rel}" is an image outside textures/; textures live under assets/<namespace>/textures/.`,
			rel,
		);
		state.errorFiles.add(rel);
	}
}

/** Sibling .png.mcmeta animation geometry over an already-decoded sheet. */
function checkAnimationSheet(rel: string, state: ScanState): void {
	const dims = state.dims.get(rel);
	const doc = state.docs.get(`${rel}.mcmeta`);
	if (dims === undefined || doc === undefined || !isRecord(doc)) {
		return;
	}
	const animation = (doc as Record<string, unknown>).animation;
	if (animation === undefined || !isRecord(animation)) {
		return;
	}
	try {
		const info = extractAnimationSection(doc);
		const geometry = deriveAnimationGeometry(dims.width, dims.height, info);
		checkAnimationFrameIndices(info, geometry.frameCount);
	} catch (error) {
		if (error instanceof McAssetError) {
			push(
				state.findings,
				"PACK_INVALID_ANIMATION_SHEET",
				"error",
				`"${rel}" with "${rel}.mcmeta" cannot form a legal animation: ${error.message.replace(/^\[[A-Z_]+\] /, "")}`,
				rel,
			);
			state.errorFiles.add(rel);
			return;
		}
		throw error;
	}
}

/** Model parent and textures references; missing targets stay distinct. */
function checkModelReferences(
	rel: string,
	knownFiles: Set<string>,
	lowerIndex: Map<string, string>,
	state: ScanState,
): void {
	const doc = state.docs.get(rel);
	if (doc === undefined || !isRecord(doc)) {
		return;
	}
	const parent = doc.parent;
	if (parent !== undefined) {
		checkParentReference(rel, parent, knownFiles, lowerIndex, state);
	}
	const textures = doc.textures;
	if (textures === undefined) {
		return;
	}
	if (!isRecord(textures)) {
		push(
			state.findings,
			"PACK_BROKEN_REFERENCE",
			"error",
			`"${rel}" has a "textures" section that is not an object.`,
			rel,
		);
		state.errorFiles.add(rel);
		return;
	}
	const keys = Object.keys(textures).sort(compareBytes);
	for (const key of keys) {
		checkTextureReference(
			rel,
			`textures.${key}`,
			textures[key],
			knownFiles,
			lowerIndex,
			state,
		);
	}
}

function checkParentReference(
	rel: string,
	value: unknown,
	knownFiles: Set<string>,
	lowerIndex: Map<string, string>,
	state: ScanState,
): void {
	if (typeof value !== "string" || value.trim() === "") {
		push(
			state.findings,
			"PACK_BROKEN_REFERENCE",
			"error",
			`"${rel}" has a "parent" reference that is not a usable resource location.`,
			rel,
		);
		state.errorFiles.add(rel);
		return;
	}
	if (value.toLowerCase().endsWith(".png")) {
		push(
			state.findings,
			"PACK_BROKEN_REFERENCE",
			"error",
			`"${rel}" points its parent at an image ("${value}"); parents must be models.`,
			rel,
		);
		state.errorFiles.add(rel);
		return;
	}
	const problems = referenceLocationProblems(value);
	if (problems.length > 0) {
		for (const finding of problems) {
			push(state.findings, finding.code, finding.level, finding.message, rel);
			state.errorFiles.add(rel);
		}
		return;
	}
	const target = resolveParentRel(value);
	if (knownFiles.has(target)) {
		return;
	}
	const folded = lowerIndex.get(target.toLowerCase());
	if (folded !== undefined) {
		push(
			state.findings,
			"PACK_CASE_MISMATCH",
			"error",
			`parent "${value}" in "${rel}" differs from "${folded}" by case only.`,
			rel,
		);
		state.errorFiles.add(rel);
		return;
	}
	push(
		state.findings,
		"PACK_MISSING_ASSET",
		"error",
		`parent "${value}" in "${rel}" has no model at "${target}".`,
		rel,
	);
	state.errorFiles.add(rel);
}

function checkTextureReference(
	rel: string,
	field: string,
	value: unknown,
	knownFiles: Set<string>,
	lowerIndex: Map<string, string>,
	state: ScanState,
): void {
	if (typeof value !== "string" || value.trim() === "") {
		push(
			state.findings,
			"PACK_BROKEN_REFERENCE",
			"error",
			`"${rel}" has a "${field}" reference that is not a usable resource location.`,
			rel,
		);
		state.errorFiles.add(rel);
		return;
	}
	if (value.toLowerCase().endsWith(".json")) {
		push(
			state.findings,
			"PACK_BROKEN_REFERENCE",
			"error",
			`"${rel}" points "${field}" at a JSON document ("${value}"); textures must be images.`,
			rel,
		);
		state.errorFiles.add(rel);
		return;
	}
	const problems = referenceLocationProblems(value);
	if (problems.length > 0) {
		for (const finding of problems) {
			push(state.findings, finding.code, finding.level, finding.message, rel);
			state.errorFiles.add(rel);
		}
		return;
	}
	const target = resolveTextureRel(value);
	if (knownFiles.has(target)) {
		state.referencedTextures.add(target);
		state.atlasRefs.push({ modelRel: rel, field, value, target });
		return;
	}
	const folded = lowerIndex.get(target.toLowerCase());
	if (folded !== undefined) {
		push(
			state.findings,
			"PACK_CASE_MISMATCH",
			"error",
			`"${field}" "${value}" in "${rel}" differs from "${folded}" by case only.`,
			rel,
		);
		state.errorFiles.add(rel);
		state.referencedTextures.add(folded);
		return;
	}
	push(
		state.findings,
		"PACK_MISSING_TEXTURE",
		"error",
		`"${field}" "${value}" in "${rel}" has no texture at "${target}".`,
		rel,
	);
	state.errorFiles.add(rel);
}

/**
 * Atlas verdicts over texture references that resolved to real files.
 * Missing files already carry PACK_MISSING_TEXTURE and never reach this
 * pass, so the two §53 errors stay mutually exclusive. The required atlas
 * names and the version gate both come from the items/split facts: below
 * the split, or with no determinable version, every verdict skips. Item
 * models share one required atlas (the items value), which is exactly the
 * same-atlas constraint; block models take the blocks value. An undefined
 * or partially understood atlas answers `unknown` and skips, never
 * accuses, and a defective texture file never drags a second code along.
 */
function checkAtlasCoverage(
	state: ScanState,
	options: PackScanOptions | undefined,
	mcmetaDoc: unknown,
): void {
	const packFormat = options?.packFormat ?? packFormatFromMcmeta(mcmetaDoc);
	if (packFormat === undefined) {
		return;
	}
	const itemsAtlas = resolveVersionedFact(ITEMS_ATLAS_FACT, packFormat);
	const placement = resolveVersionedFact(ITEM_ATLAS_PLACEMENT_FACT, packFormat);
	if (itemsAtlas === undefined || placement === undefined) {
		return;
	}
	if (placement.itemSameAtlas !== true) {
		return;
	}
	const parsed = parseAtlasDefinitions(state.docs);
	for (const ref of state.atlasRefs) {
		if (state.errorFiles.has(ref.target)) {
			continue;
		}
		const required = requiredAtlasForModel(ref.modelRel, {
			itemAtlas: itemsAtlas.atlas,
			blockAtlas: placement.blockAtlas,
		});
		if (required === undefined) {
			continue;
		}
		if (atlasCoverageFor(parsed, required, ref.target) !== "not-covered") {
			continue;
		}
		push(
			state.findings,
			"PACK_TEXTURE_NOT_IN_ATLAS",
			"error",
			`"${ref.field}" "${ref.value}" in "${ref.modelRel}" resolves to "${ref.target}" which is not stitched into the "${required}" atlas.`,
			ref.modelRel,
		);
		state.errorFiles.add(ref.modelRel);
	}
}

/**
 * Scan one pack root. Findings sort by relative-path bytes, then the fixed
 * per-file check order, then message; reruns over the same tree are
 * byte-identical and the input tree is never written.
 */
export async function scanPack(
	packRoot: string,
	options?: PackScanOptions,
): Promise<PackReport> {
	const rels = await collectPackFiles(packRoot);
	const knownFiles = new Set(rels);
	const lowerIndex = new Map<string, string>();
	for (const rel of rels) {
		const folded = rel.toLowerCase();
		if (!lowerIndex.has(folded)) {
			lowerIndex.set(folded, rel);
		}
	}
	const state: ScanState = {
		findings: [],
		docs: new Map(),
		dims: new Map(),
		errorFiles: new Set(),
		referencedTextures: new Set(),
		modelRels: [],
		atlasRefs: [],
	};
	for (const rel of rels) {
		if (rel === "pack.mcmeta") {
			continue;
		}
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(await readFile(`${packRoot}/${rel}`));
		} catch {
			throw new McAssetError(
				"FILESYSTEM_ERROR",
				`Cannot read pack file: ${rel}.`,
				{ path: rel },
			);
		}
		await checkSingleFile(rel, bytes, state);
		if (
			rel.startsWith("assets/") &&
			rel.toLowerCase().endsWith(".json") &&
			rel.toLowerCase().includes("/models/")
		) {
			state.modelRels.push(rel);
		}
	}
	// The root pack.mcmeta parses for INVALID_JSON and, with no version
	// flag, lends its pack.pack_format as the scan target. The file is
	// only read, never written; an unusable value keeps the version
	// undetermined with no default applied.
	let mcmetaDoc: unknown;
	if (knownFiles.has("pack.mcmeta")) {
		try {
			const bytes = new Uint8Array(await readFile(`${packRoot}/pack.mcmeta`));
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			mcmetaDoc = JSON.parse(text) as unknown;
		} catch {
			push(
				state.findings,
				"PACK_INVALID_JSON",
				"error",
				`"pack.mcmeta" is not valid JSON.`,
				"pack.mcmeta",
			);
			state.errorFiles.add("pack.mcmeta");
		}
		await checkDiskName("pack.mcmeta", state);
	}
	for (const rel of rels) {
		checkAnimationSheet(rel, state);
	}
	for (const rel of state.modelRels) {
		checkModelReferences(rel, knownFiles, lowerIndex, state);
	}
	checkAtlasCoverage(state, options, mcmetaDoc);
	// Orphan is warning-only over lowercase-.png textures that decoded
	// cleanly, and it skips files that already carry an error, so one
	// defect never drags a second code along.
	for (const rel of rels) {
		if (!rel.startsWith("assets/")) {
			continue;
		}
		if (extensionOf(basenameOf(rel)) !== "png") {
			continue;
		}
		const split = splitNamespace(rel);
		if (split === undefined || !split.rest.startsWith("textures/")) {
			continue;
		}
		if (!state.dims.has(rel) || state.errorFiles.has(rel)) {
			continue;
		}
		if (state.referencedTextures.has(rel)) {
			continue;
		}
		push(
			state.findings,
			"PACK_ORPHAN_TEXTURE",
			"warning",
			`"${rel}" is never referenced by any model.`,
			rel,
		);
	}
	// Version target: an explicit flag always wins. With no flag the engine
	// reads pack.pack_format from the root pack.mcmeta; a missing or
	// unusable value warns once and skips version-dependent checks with
	// no default version ever applied.
	let effectiveTarget = options?.target ?? "default (engine defaults)";
	if (options?.packFormat === undefined) {
		const fromMcmeta = packFormatFromMcmeta(mcmetaDoc);
		if (fromMcmeta !== undefined) {
			effectiveTarget = `pack.mcmeta packFormat ${fromMcmeta}`;
		} else {
			push(
				state.findings,
				"PACK_VERSION_UNDETERMINED",
				"warning",
				VERSION_UNDETERMINED_MESSAGE,
				undefined,
			);
		}
	}
	const findings = [...state.findings].sort((a, b) => {
		const pa = a.path ?? "";
		const pb = b.path ?? "";
		const byPath = compareBytes(pa, pb);
		if (byPath !== 0) {
			return byPath;
		}
		const byCheck = orderOf(a.code) - orderOf(b.code);
		if (byCheck !== 0) {
			return byCheck;
		}
		return compareBytes(a.message, b.message);
	});
	const verdict = findings.some((finding) => finding.level === "error")
		? "fail"
		: "pass";
	return {
		command: "validate-pack",
		path: packRoot,
		target: effectiveTarget,
		verdict,
		findings,
	};
}
