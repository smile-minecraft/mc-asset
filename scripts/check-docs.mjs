#!/usr/bin/env node
// Documentation gate. Pure Node: only node: builtins. Scans the root
// Markdown / text files (README*, AGENTS.md, llms*.txt) and everything
// under docs/, and fails when:
//   - a link points at a heading anchor that does not exist (in-page,
//     relative, or a github.com/.../blob/main/... URL of this repository);
//   - a relative or same-repository link points at a missing file;
//   - a release version (vX.Y.Z, or the current package.json version)
//     appears outside CHANGELOG.md. Release history belongs there.
// Anchors follow GitHub's heading slugs: lowercase, punctuation dropped,
// spaces to hyphens, "-1", "-2", ... for repeated headings.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_URLS = [
	"https://github.com/smile-minecraft/mc-asset/blob/main/",
	"https://github.com/smile-minecraft/mc-asset/tree/main/",
	"https://raw.githubusercontent.com/smile-minecraft/mc-asset/main/",
];
const VERSION = JSON.parse(
	readFileSync(join(ROOT, "package.json"), "utf8"),
).version;

function collectFiles() {
	const files = readdirSync(ROOT)
		.filter((name) => /\.(md|txt)$/.test(name) && name !== "CHANGELOG.md")
		.map((name) => join(ROOT, name));
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) {
				walk(path);
			} else if (/\.(md|txt)$/.test(name)) {
				files.push(path);
			}
		}
	};
	walk(join(ROOT, "docs"));
	return files.sort();
}

/** Blank fenced code blocks so their contents never count as headings or links. */
function withoutFences(text) {
	return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, (block) =>
		block.replace(/[^\n]/g, ""),
	);
}

function slug(heading) {
	return heading
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\p{M}\p{Pc}\- ]/gu, "")
		.replace(/ /g, "-");
}

const anchorCache = new Map();
function anchorsOf(path) {
	if (!anchorCache.has(path)) {
		const seen = new Map();
		const ids = new Set();
		const text = withoutFences(readFileSync(path, "utf8"));
		for (const match of text.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm)) {
			const base = slug(match[1]);
			const count = seen.get(base) ?? 0;
			seen.set(base, count + 1);
			ids.add(count === 0 ? base : `${base}-${count}`);
		}
		anchorCache.set(path, ids);
	}
	return anchorCache.get(path);
}

function lineOf(text, index) {
	return text.slice(0, index).split("\n").length;
}

const problems = [];
for (const file of collectFiles()) {
	const raw = readFileSync(file, "utf8");
	const rel = relative(ROOT, file);

	for (const match of raw.matchAll(/\bv\d+\.\d+\.\d+\b|\b\d+\.\d+\.\d+\b/g)) {
		if (match[0].startsWith("v") || match[0] === VERSION) {
			problems.push(
				`${rel}:${lineOf(raw, match.index)}: release version "${match[0]}" belongs in CHANGELOG.md`,
			);
		}
	}

	const text = withoutFences(raw).replace(/`[^`\n]*`/g, (span) =>
		" ".repeat(span.length),
	);
	for (const match of text.matchAll(
		/\]\(<?([^)\s>]+)>?(?:[ \t]+"[^"]*")?\)/g,
	)) {
		let target = match[1];
		const where = `${rel}:${lineOf(text, match.index)}`;
		const repoUrl = REPO_URLS.find((prefix) => target.startsWith(prefix));
		let targetPath = file;
		if (repoUrl !== undefined) {
			target = target.slice(repoUrl.length);
			const [pathPart] = target.split("#");
			targetPath = join(ROOT, decodeURIComponent(pathPart));
		} else if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
			continue;
		} else if (!target.startsWith("#")) {
			const [pathPart] = target.split("#");
			targetPath = resolve(dirname(file), decodeURIComponent(pathPart));
		}
		if (!existsSync(targetPath)) {
			problems.push(`${where}: missing file ${match[1]}`);
			continue;
		}
		const hash = target.indexOf("#");
		if (hash === -1 || extname(targetPath) !== ".md") {
			continue;
		}
		const anchor = decodeURIComponent(target.slice(hash + 1));
		if (!anchorsOf(targetPath).has(anchor)) {
			problems.push(`${where}: missing anchor #${anchor} in ${relative(ROOT, targetPath)}`);
		}
	}
}

if (problems.length > 0) {
	for (const problem of problems) {
		console.error(problem);
	}
	console.error(`docs check failed: ${problems.length} problem(s)`);
	process.exit(1);
}
console.log("docs check passed");
