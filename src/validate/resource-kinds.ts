/**
 * Classification of the top-level entries under `assets/<namespace>/`.
 *
 * Every entry falls into exactly one of three classes:
 *
 * - checked: the pack scan reads these and resolves their references.
 * - inert: the content cannot name a texture or a model, so leaving it
 *   unread loses nothing.
 * - uninterpreted: everything else. This is the default. A type that is
 *   not listed explicitly lowers coverage, because a scan that did not
 *   read a file must not report a complete result for it.
 *
 * Only add an entry to the inert list with a reason a primary source
 * supports. When unsure, leave the type uninterpreted.
 */

export type ResourceKindClass = "checked" | "inert" | "uninterpreted";

/**
 * Directories (and the namespace-level `sounds.json`) whose references the
 * pack scan resolves. `shaders` stays out: its include rules differ between
 * releases (`#moj_import` before 26.3, `#include` from 26.3 on), so the scan
 * has no single rule it can prove.
 */
const CHECKED_KINDS: ReadonlySet<string> = new Set([
	"textures",
	"models",
	"blockstates",
	"items",
	"atlases",
	"equipment",
	"particles",
	"font",
	"post_effect",
	"waypoint_style",
	"sounds.json",
]);

/**
 * Directories whose content cannot reference a texture or a model.
 * `lang` holds translation key/value strings only, and `sounds` holds Ogg
 * Vorbis audio (the client's FileToIdConverter("sounds", ".ogg") feeds
 * JOrbisAudioStream, never a JSON model); the sound files themselves are
 * checked through `sounds.json` references.
 */
const INERT_KINDS: ReadonlySet<string> = new Set(["lang", "sounds"]);

export function classifyResourceKind(kind: string): ResourceKindClass {
	if (CHECKED_KINDS.has(kind)) {
		return "checked";
	}
	if (INERT_KINDS.has(kind)) {
		return "inert";
	}
	return "uninterpreted";
}

export interface UninterpretedResource {
	/** Directory or file name directly under the namespace (or `assets`). */
	kind: string;
	/** Stable path of the unread entry, e.g. `assets/ns/particles`. */
	target: string;
}

/**
 * Collect the uninterpreted entries from the pack's file list. Entries
 * come from files, so an empty directory contributes nothing. Each
 * distinct (namespace, kind) is reported once; a file placed directly
 * under a namespace (or under `assets`) is reported under its own name.
 */
export function findUninterpretedResources(
	rels: readonly string[],
): UninterpretedResource[] {
	const found = new Map<string, UninterpretedResource>();
	for (const rel of rels) {
		const parts = rel.split("/");
		if (parts[0] !== "assets") {
			continue;
		}
		let kind: string;
		let target: string;
		if (parts.length === 2) {
			// A file directly under `assets/`.
			kind = parts[1] as string;
			target = rel;
		} else {
			kind = parts[2] as string;
			target = `assets/${parts[1]}/${kind}`;
			if (parts.length === 3) {
				target = rel;
			}
		}
		if (classifyResourceKind(kind) !== "uninterpreted") {
			continue;
		}
		found.set(target, { kind, target });
	}
	return [...found.values()];
}
