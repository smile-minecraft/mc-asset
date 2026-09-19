#!/usr/bin/env node
// Release build helper (runs under plain Node; Bun is only the bundler).
// Contract for downstream packaging consumers:
//   - dist/index.js      library bundle (keeps the existing CI dist check).
//   - dist/mc-asset.js   CLI bundle, Node-runnable, directly executable.
//   - bin/mc-asset.js    committed launcher handing off to dist/mc-asset.js.
// Re-run with `bun run build` (or `node scripts/build.mjs` with Bun on PATH).
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHEBANG = "#!/usr/bin/env node\n";

function runBuild(args) {
	const result = spawnSync("bun", ["build", ...args], {
		cwd: ROOT,
		stdio: "inherit",
	});
	if ((result.status ?? 1) !== 0) {
		process.exit(result.status ?? 1);
	}
}

function addShebang(path) {
	const text = readFileSync(path, "utf-8");
	if (!text.startsWith(SHEBANG)) {
		writeFileSync(path, SHEBANG + text);
	}
	chmodSync(path, 0o755);
}

runBuild(["src/index.ts", "--outdir", "dist", "--target", "node", "--format", "esm"]);
runBuild([
	"src/cli/index.ts",
	"--outfile",
	"dist/mc-asset.js",
	"--target",
	"node",
	"--format",
	"esm",
]);
addShebang(join(ROOT, "dist", "mc-asset.js"));
