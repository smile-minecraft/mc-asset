import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const BUNDLE = join(ROOT, "dist", "mc-asset.js");
const LIB_BUNDLE = join(ROOT, "dist", "index.js");
const GRID_FIXTURE = join(ROOT, "tests", "cli", "fixtures", "tiny.grid");

interface PackageJson {
	version: string;
	bin?: Record<string, string>;
}

function readPackage(): PackageJson {
	return JSON.parse(
		readFileSync(join(ROOT, "package.json"), "utf-8"),
	) as PackageJson;
}

interface NodeRun {
	status: number;
	stdout: string;
	stderr: string;
}

function runNode(args: string[], cwd: string): NodeRun {
	const result = spawnSync("node", args, { cwd, encoding: "utf-8" });
	return {
		status: result.status ?? -1,
		stdout: typeof result.stdout === "string" ? result.stdout : "",
		stderr: typeof result.stderr === "string" ? result.stderr : "",
	};
}

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "mc-asset-release-"));
}

function removeDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

function listSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...listSourceFiles(full));
		} else {
			out.push(full);
		}
	}
	return out;
}

beforeAll(() => {
	const built = spawnSync("bun", ["run", "build"], {
		cwd: ROOT,
		encoding: "utf-8",
	});
	expect(built.status ?? -1).toBe(0);
}, 60_000);

describe("release entry", () => {
	test("package.json exposes the mc-asset bin launcher", () => {
		const pkg = readPackage();
		expect(pkg.bin?.["mc-asset"]).toBeDefined();
		const launcher = join(ROOT, pkg.bin?.["mc-asset"] ?? "");
		expect(existsSync(launcher)).toBe(true);
	});

	test("build emits a CLI bundle that is not an empty module", () => {
		expect(existsSync(BUNDLE)).toBe(true);
		const text = readFileSync(BUNDLE, "utf-8");
		expect(text.length).toBeGreaterThan(50_000);
		for (const command of ["render", "analyze", "validate"]) {
			expect(text).toContain(command);
		}
	});

	test("node bundle --version matches package.json outside the repo", () => {
		const pkg = readPackage();
		const dir = makeTempDir();
		try {
			const run = runNode([BUNDLE, "--version"], dir);
			expect(run.status).toBe(0);
			expect(run.stdout.trim()).toBe(pkg.version);
		} finally {
			removeDir(dir);
		}
	});

	test("node bundle --help works from an arbitrary cwd", () => {
		const dir = makeTempDir();
		try {
			const run = runNode([BUNDLE, "--help"], dir);
			expect(run.status).toBe(0);
			const output = run.stdout + run.stderr;
			for (const command of ["render", "analyze", "validate"]) {
				expect(output).toContain(command);
			}
		} finally {
			removeDir(dir);
		}
	});

	test("library bundle VERSION matches the single package.json source", () => {
		const pkg = readPackage();
		const indexSource = readFileSync(join(ROOT, "src", "index.ts"), "utf-8");
		expect(indexSource).toContain("package.json");
		expect(indexSource).not.toContain('VERSION = "');
		const dir = makeTempDir();
		try {
			const run = runNode(
				[
					"-e",
					"import(process.argv[1]).then((m) => { process.stdout.write(String(m.VERSION)); })",
					LIB_BUNDLE,
				],
				dir,
			);
			expect(run.status).toBe(0);
			expect(run.stdout).toBe(pkg.version);
		} finally {
			removeDir(dir);
		}
	});

	test("src stays free of Bun-only APIs so the bundle runs under Node", () => {
		const offenders: string[] = [];
		for (const file of listSourceFiles(join(ROOT, "src"))) {
			const text = readFileSync(file, "utf-8");
			if (/Bun\./.test(text)) {
				offenders.push(file);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("render then analyze then validate runs under plain node", () => {
		const dir = makeTempDir();
		try {
			const grid = join(dir, "tiny.grid");
			writeFileSync(grid, readFileSync(GRID_FIXTURE, "utf-8"));
			const png = join(dir, "tiny.png");

			const rendered = runNode([BUNDLE, "render", grid, "--output", png], dir);
			expect(rendered.status).toBe(0);
			const bytes = readFileSync(png);
			expect([...bytes.subarray(0, 8)]).toEqual([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
			]);
			expect(statSync(png).size).toBeGreaterThan(8);

			const analyzed = runNode([BUNDLE, "analyze", png], dir);
			expect(analyzed.status).toBe(0);
			expect(analyzed.stdout + analyzed.stderr).toContain("dimensions");

			const validated = runNode([BUNDLE, "validate", png], dir);
			expect(validated.status).toBe(0);
			expect(validated.stdout + validated.stderr).toContain("verdict");
		} finally {
			removeDir(dir);
		}
	});
});
