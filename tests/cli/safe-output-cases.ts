import assert from "node:assert/strict";
import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isInside,
	type OutputTarget,
	planOutputTargets,
	writePlannedTargets,
} from "../../src/cli/safe-output.ts";

export const safeOutputCases: { name: string; run(): Promise<void> }[] = [];
function add(name: string, body: (root: string) => Promise<void>): void {
	safeOutputCases.push({
		name,
		async run() {
			const root = await mkdtemp(join(tmpdir(), "safe-output-"));
			try {
				await body(root);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	});
}
function target(
	path: string,
	allowOverwrite = false,
	createOnly = false,
): OutputTarget {
	return { path, extension: ".json", allowOverwrite, createOnly };
}
async function reject(
	targets: OutputTarget[],
	inputs: string[],
	code: string,
	reason?: string,
	mkdir = false,
	allowedRoot?: string,
): Promise<void> {
	await assert.rejects(
		planOutputTargets(targets, {
			inputs,
			mkdir,
			...(allowedRoot === undefined ? {} : { allowedRoot }),
		}),
		(error: unknown) => {
			const e = error as {
				code: string;
				details?: { reason?: string };
				message: string;
			};
			assert.equal(e.code, code);
			if (reason) assert.equal(e.details?.reason, reason);
			if (code === "ARGUMENT_CONFLICT" && inputs.length)
				assert.ok(!e.message.includes("--in-place"));
			return true;
		},
	);
}
/** True when `dir` keeps `case-probe` and `CASE-PROBE` apart. */
async function isCaseSensitiveDir(dir: string): Promise<boolean> {
	const probe = join(dir, "case-probe");
	await writeFile(probe, "x");
	try {
		await access(join(dir, "CASE-PROBE"));
		return false;
	} catch {
		return true;
	}
}
for (const path of ["", "bad\0.json", "bad.png"])
	add(`invalid path ${JSON.stringify(path)}`, async () =>
		reject([target(path)], [], "INVALID_ARGUMENT"),
	);
for (const alias of ["same", "relative", "case", "unicode"])
	add(`source alias ${alias}`, async (root) => {
		const input = join(root, alias === "unicode" ? "é.json" : "source.json");
		await writeFile(input, "source");
		const output =
			alias === "case"
				? input.toUpperCase()
				: alias === "unicode"
					? input.normalize("NFD")
					: alias === "relative"
						? join(root, "child", "..", "source.json")
						: input;
		await reject([target(output, true)], [input], "ARGUMENT_CONFLICT");
		assert.equal(await readFile(input, "utf8"), "source");
	});
add("duplicate normalized targets", async (root) =>
	reject(
		[target(join(root, "a.json")), target(join(root, "A.json"))],
		[],
		"ARGUMENT_CONFLICT",
	),
);
add("directory target precedes existing-output rejection", async (root) => {
	const p = join(root, "a.json");
	await mkdir(p);
	await reject([target(p)], [], "FILESYSTEM_ERROR", "target-is-directory");
});
for (const dangling of [false, true])
	for (const force of [false, true])
		add(`symlink target dangling=${dangling} force=${force}`, async (root) => {
			const source = join(root, "source.json");
			if (!dangling) await writeFile(source, "source");
			const p = join(root, "a.json");
			await symlink(source, p);
			await reject(
				[target(p, force)],
				[],
				"FILESYSTEM_ERROR",
				"target-is-symlink",
			);
		});
add("existing output", async (root) => {
	const p = join(root, "a.json");
	await writeFile(p, "old");
	await reject([target(p)], [], "OUTPUT_EXISTS");
	assert.equal(await readFile(p, "utf8"), "old");
});
add("binding cannot overwrite with force", async (root) => {
	const p = join(root, "a.json");
	await writeFile(p, "old");
	await reject([target(p, true, true)], [], "OUTPUT_EXISTS");
});
add("parent is a regular file", async (root) => {
	const p = join(root, "parent");
	await writeFile(p, "old");
	await reject([target(join(p, "a.json"))], [], "FILESYSTEM_ERROR");
});
add("direct parent symlink", async (root) => {
	const p = join(root, "parent");
	await symlink(root, p);
	await reject(
		[target(join(p, "a.json"))],
		[],
		"FILESYSTEM_ERROR",
		"parent-is-symlink",
	);
});
add("missing parent without mkdir", async (root) =>
	reject([target(join(root, "missing", "a.json"))], [], "FILESYSTEM_ERROR"),
);
add("outside allowed root", async (root) => {
	const pack = join(root, "pack");
	await mkdir(pack);
	await reject(
		[target(join(root, "a.json"))],
		[],
		"INVALID_ARGUMENT",
		"outside-allowed-root",
		false,
		pack,
	);
});
add("isInside keeps the filesystem case on the boundary", async () => {
	assert.equal(
		isInside("/tmp/packcli", "/tmp/PACKCLI/particles/spark.json"),
		false,
	);
	assert.equal(
		isInside("/tmp/packcli", "/tmp/packcli/particles/spark.json"),
		true,
	);
	assert.equal(isInside("/tmp/packcli", "/tmp/packcli"), true);
	assert.equal(isInside("/tmp/packcli", "/tmp/packcli-other/a.json"), false);
});
add("ancestor symlink escape", async (root) => {
	const pack = join(root, "pack");
	const outside = join(root, "outside");
	await mkdir(pack);
	await mkdir(join(outside, "nested"), { recursive: true });
	await symlink(outside, join(pack, "link"));
	await reject(
		[target(join(pack, "link", "nested", "a.json"))],
		[],
		"INVALID_ARGUMENT",
		"outside-allowed-root",
		false,
		pack,
	);
});
add(
	"case-distinct external directory behind a symlink is outside the allowed root",
	async (root) => {
		if (!(await isCaseSensitiveDir(root))) return;
		const packcli = join(root, "packcli");
		const PACKCLI = join(root, "PACKCLI");
		await mkdir(join(packcli, "assets"), { recursive: true });
		await mkdir(join(PACKCLI, "particles"), { recursive: true });
		await writeFile(
			join(PACKCLI, "particles", "spark.json"),
			"sentinel-definition",
		);
		await symlink(PACKCLI, join(packcli, "assets", "demo"));
		await reject(
			[
				target(
					join(packcli, "assets", "demo", "particles", "spark.json"),
					true,
				),
			],
			[],
			"INVALID_ARGUMENT",
			"outside-allowed-root",
			false,
			packcli,
		);
		assert.equal(
			await readFile(join(PACKCLI, "particles", "spark.json"), "utf8"),
			"sentinel-definition",
		);
	},
);
add(
	"dangling symlink ancestor is refused before the allowed root check",
	async (root) => {
		const packcli = join(root, "packcli");
		await mkdir(packcli);
		await symlink(join(root, "missing-outside"), join(packcli, "link"));
		await reject(
			[target(join(packcli, "link", "sub", "a.json"), true)],
			[],
			"FILESYSTEM_ERROR",
			"parent-is-symlink",
			true,
			packcli,
		);
	},
);
add("all targets preflight without creating parents", async (root) => {
	const old = join(root, "old.json");
	await writeFile(old, "old");
	await reject(
		[target(join(root, "missing", "new.json")), target(old)],
		[],
		"OUTPUT_EXISTS",
		undefined,
		true,
	);
	assert.deepEqual(await readdir(root), ["old.json"]);
});
add("legal target preserves overwrite policy", async (root) => {
	const p = join(root, "a.json");
	const plan = await planOutputTargets([target(p, true)], {
		inputs: [],
		mkdir: false,
	});
	assert.equal(plan.length, 1);
	assert.equal(plan[0]?.allowOverwrite, true);
	assert.equal(plan[0]?.createOnly, false);
	assert.equal(plan[0]?.existed, false);
	assert.deepEqual(await readdir(root), []);
});
add("mkdir and legal atomic write", async (root) => {
	const p = join(root, "nested", "a.json");
	const plan = await planOutputTargets([target(p)], {
		inputs: [],
		mkdir: true,
	});
	assert.deepEqual(
		await writePlannedTargets(plan, new Map([[p, "new"]]), { mkdir: true }),
		[p],
	);
	assert.equal(await readFile(p, "utf8"), "new");
	assert.deepEqual(await readdir(join(root, "nested")), ["a.json"]);
});
add("same-directory temporary then rename", async (root) => {
	const p = join(root, "a.json");
	const plan = await planOutputTargets([target(p)], {
		inputs: [],
		mkdir: false,
	});
	const calls: string[] = [];
	await writePlannedTargets(
		plan,
		new Map([[p, "new"]]),
		{ mkdir: false },
		{
			async writeExclusive(path) {
				assert.ok(path.startsWith(`${root}/.tmp-`));
				calls.push("write");
			},
			async renameFile(from, to) {
				assert.ok(from.startsWith(`${root}/.tmp-`));
				assert.equal(to, p);
				calls.push("rename");
			},
		},
	);
	assert.deepEqual(calls, ["write", "rename"]);
});
add(
	"third write failure reports completed and notStarted and removes temporary",
	async (root) => {
		const paths = [0, 1, 2, 3].map((n) => join(root, `${n}.json`));
		const plan = await planOutputTargets(
			paths.map((p) => target(p)),
			{ inputs: [], mkdir: false },
		);
		let writes = 0;
		await assert.rejects(
			writePlannedTargets(
				plan,
				new Map(paths.map((p) => [p, "new"])),
				{ mkdir: false },
				{
					async writeExclusive(path, data) {
						writes++;
						await writeFile(path, data, { flag: "wx" });
						if (writes === 3) throw new Error("injected disk failure");
					},
				},
			),
			(error: unknown) => {
				const e = error as { code: string; details: unknown };
				assert.equal(e.code, "FILESYSTEM_ERROR");
				assert.deepEqual(e.details, {
					completed: paths.slice(0, 2),
					failedTarget: paths[2],
					notStarted: paths.slice(3),
				});
				return true;
			},
		);
		assert.deepEqual((await readdir(root)).sort(), ["0.json", "1.json"]);
	},
);
