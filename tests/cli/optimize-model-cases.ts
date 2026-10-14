import {
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
import type { OutputStreams } from "../../src/cli/channels.ts";
import type { ModelCliOptions, ModelMode } from "../../src/cli/cmd-model.ts";
import type { OptimizeCliOptions } from "../../src/cli/cmd-optimize.ts";
import { PNG_VECTORS } from "../io/png-cases.ts";

/** Result of one command run: the exit code plus captured streams. */
export interface CliResult {
	readonly code: number;
	readonly raw: Uint8Array;
	readonly stderr: string;
}

/** Injected surface: both runtimes drive the same command functions. */
export interface CliSurface {
	optimize(
		inputs: readonly string[],
		options: OptimizeCliOptions,
	): Promise<CliResult>;
	model(
		mode: ModelMode,
		input: string | undefined,
		options: ModelCliOptions,
	): Promise<CliResult>;
}

export const optimizeModelCases: {
	name: string;
	run(surface: CliSurface): Promise<void>;
}[] = [];

function add(
	name: string,
	body: (root: string, surface: CliSurface) => Promise<void>,
): void {
	optimizeModelCases.push({
		name,
		async run(surface) {
			const root = await mkdtemp(join(tmpdir(), "optimize-model-"));
			try {
				await body(root, surface);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	});
}

/** Loose JSON view: the result shapes are specified but not implemented yet. */
type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`expected an object, received ${typeof value}`);
	}
	return value as JsonObject;
}

function asArray(value: unknown): readonly unknown[] {
	if (!Array.isArray(value)) {
		throw new Error(`expected an array, received ${typeof value}`);
	}
	return value as readonly unknown[];
}

function str(source: JsonObject, key: string): string {
	const value = source[key];
	if (typeof value !== "string") {
		throw new Error(`expected string field ${key}`);
	}
	return value;
}

function num(source: JsonObject, key: string): number {
	const value = source[key];
	if (typeof value !== "number") {
		throw new Error(`expected number field ${key}`);
	}
	return value;
}

function obj(source: JsonObject, key: string): JsonObject {
	return asObject(source[key]);
}

function arr(source: JsonObject, key: string): readonly JsonObject[] {
	return asArray(source[key]).map(asObject);
}

export function stdoutText(result: CliResult): string {
	return Buffer.from(result.raw).toString("utf-8");
}

/** With `--stdout` the artifact owns stdout, so the envelope moves to stderr. */
function parseEnvelope(
	result: CliResult,
	stream: "stdout" | "stderr" = "stdout",
): JsonObject {
	const text = (stream === "stdout" ? stdoutText(result) : result.stderr)
		.trim()
		.split("\n")
		.filter((line) => line.trim() !== "")
		.pop();
	if (text === undefined) {
		throw new Error("no envelope on stdout");
	}
	return asObject(JSON.parse(text));
}

function parseError(
	result: CliResult,
	stream: "stdout" | "stderr" = "stdout",
): {
	code: string;
	details: JsonObject;
} {
	const error = asObject(parseEnvelope(result, stream).error);
	return { code: str(error, "code"), details: asObject(error.details ?? {}) };
}

function report(result: CliResult): JsonObject {
	return obj(parseEnvelope(result), "result");
}

async function sourcePng(root: string, name = "source.png"): Promise<string> {
	const path = join(root, name);
	await writeFile(path, Buffer.from(PNG_VECTORS.V_PATTERN_2X2, "base64"));
	return path;
}

async function modelJson(root: string, name = "model.json"): Promise<string> {
	const path = join(root, name);
	await writeFile(
		path,
		JSON.stringify({
			textures: { all: "minecraft:block/stone" },
			elements: [
				{
					from: [0, 0, 0],
					to: [1, 1, 1],
					faces: { north: { texture: "#all" } },
				},
			],
		}),
	);
	return path;
}

function pngBytes(): Buffer {
	return Buffer.from(PNG_VECTORS.V_PATTERN_2X2, "base64");
}

add("optimize dry run reports and writes nothing", async (root, surface) => {
	const input = await sourcePng(root);
	const before = await readdir(root);
	const result = await surface.optimize([input], { dryRun: true });
	if (result.code !== 0)
		throw new Error(`exit ${result.code}: ${result.stderr}`);
	const body = obj(parseEnvelope(result), "result");
	if (str(body, "command") !== "optimize") throw new Error("command");
	if (body.dryRun !== true) throw new Error("dryRun");
	const files = arr(body, "files");
	if (files.length !== 1) throw new Error("files length");
	if (str(files[0] as JsonObject, "input") !== input) throw new Error("input");
	if (files[0]?.output !== null) throw new Error("dry-run output must be null");
	if (num(obj(files[0] as JsonObject, "source"), "bytes") <= 0) {
		throw new Error("source bytes");
	}
	if (num(obj(body, "totals"), "files") !== 1) throw new Error("totals files");
	const after = await readdir(root);
	if (after.join() !== before.join()) throw new Error("dry run wrote files");
});

add("optimize needs exactly one output mode", async (root, surface) => {
	const input = await sourcePng(root);
	const output = join(root, "out.png");
	const missing = await surface.optimize([input], {});
	if (parseError(missing).code !== "OUTPUT_REQUIRED") {
		throw new Error("missing output mode");
	}
	const duplicated = await surface.optimize([input], {
		output,
		stdout: true,
	});
	if (parseError(duplicated, "stderr").code !== "ARGUMENT_CONFLICT") {
		throw new Error("duplicate output modes");
	}
	const dryRunWithOutput = await surface.optimize([input], {
		dryRun: true,
		output,
	});
	if (parseError(dryRunWithOutput).code !== "ARGUMENT_CONFLICT") {
		throw new Error("dry run with output");
	}
	const after = await readdir(root);
	if (after.join() !== ["source.png"].join()) {
		throw new Error("refusal wrote files");
	}
});

add("optimize output requires a single input", async (root, surface) => {
	await sourcePng(root);
	const second = join(root, "second.png");
	await writeFile(second, pngBytes());
	const result = await surface.optimize([join(root, "source.png"), second], {
		stdout: true,
	});
	if (parseError(result, "stderr").code !== "ARGUMENT_CONFLICT") {
		throw new Error("batch with stdout");
	}
});

add(
	"optimize refuses duplicate inputs and non-PNG sources",
	async (root, surface) => {
		const input = await sourcePng(root);
		const text = join(root, "note.txt");
		await writeFile(text, "text");
		const duplicate = await surface.optimize([input, input], { dryRun: true });
		if (parseError(duplicate).code !== "ARGUMENT_CONFLICT") {
			throw new Error("duplicate input");
		}
		const unsupported = await surface.optimize([text], { dryRun: true });
		if (parseError(unsupported).code !== "UNSUPPORTED_IMAGE_FORMAT") {
			throw new Error("non-PNG input");
		}
	},
);

add("optimize stdout writes PNG bytes to stdout", async (root, surface) => {
	const input = await sourcePng(root);
	const result = await surface.optimize([input], { stdout: true });
	if (result.code !== 0)
		throw new Error(`exit ${result.code}: ${result.stderr}`);
	const signature = Array.from(new Uint8Array(result.raw).slice(0, 4));
	if (signature.join() !== [0x89, 0x50, 0x4e, 0x47].join()) {
		throw new Error("stdout is not PNG bytes");
	}
	if (!result.stderr.includes("ok optimize")) {
		throw new Error(`envelope missing from stderr: ${result.stderr}`);
	}
});

add("optimize writes one explicit output atomically", async (root, surface) => {
	const input = await sourcePng(root);
	const output = join(root, "out.png");
	const result = await surface.optimize([input], { output });
	if (result.code !== 0)
		throw new Error(`exit ${result.code}: ${result.stderr}`);
	const body = obj(parseEnvelope(result), "result");
	const files = arr(body, "files");
	if (str(files[0] as JsonObject, "output") !== output) {
		throw new Error("reported output path");
	}
	if ((await readFile(output)).length === 0) throw new Error("empty output");
	const after = await readdir(root);
	if (after.join() !== ["out.png", "source.png"].join()) {
		throw new Error(`unexpected tree: ${after.join()}`);
	}
});

add("optimize refuses existing output without force", async (root, surface) => {
	const input = await sourcePng(root);
	const output = join(root, "out.png");
	await writeFile(output, "old");
	const rejected = await surface.optimize([input], { output });
	if (parseError(rejected).code !== "OUTPUT_EXISTS") {
		throw new Error("existing output");
	}
	if ((await readFile(output, "utf8")) !== "old") {
		throw new Error("output was rewritten");
	}
	const accepted = await surface.optimize([input], { output, force: true });
	if (accepted.code !== 0) throw new Error(`force exit ${accepted.code}`);
	if ((await readFile(output, "utf8")) === "old") {
		throw new Error("force did not overwrite");
	}
});

add(
	"optimize refuses an output that aliases the source",
	async (root, surface) => {
		const input = await sourcePng(root);
		const before = await readFile(input);
		const relative = await surface.optimize(["source.png"], {
			output: "./source.png",
		});
		if (parseError(relative).code !== "ARGUMENT_CONFLICT") {
			throw new Error("relative alias");
		}
		if (Buffer.compare(await readFile(input), before) !== 0) {
			throw new Error("source bytes changed");
		}
		const link = join(root, "link.png");
		await symlink(input, link);
		const viaSymlink = await surface.optimize([input], {
			output: link,
			force: true,
		});
		if (parseError(viaSymlink).code !== "FILESYSTEM_ERROR") {
			throw new Error("symlink output");
		}
		if (parseError(viaSymlink).details.reason !== "target-is-symlink") {
			throw new Error("symlink reason");
		}
		if (Buffer.compare(await readFile(input), before) !== 0) {
			throw new Error("source changed through symlink");
		}
	},
);

add("optimize creates parents only with mkdir", async (root, surface) => {
	const input = await sourcePng(root);
	const missing = join(root, "nested", "out.png");
	const rejected = await surface.optimize([input], { output: missing });
	if (parseError(rejected).code !== "FILESYSTEM_ERROR") {
		throw new Error("missing parent");
	}
	const accepted = await surface.optimize([input], {
		output: missing,
		mkdir: true,
	});
	if (accepted.code !== 0) throw new Error(`mkdir exit ${accepted.code}`);
	if ((await readFile(missing)).length === 0)
		throw new Error("empty created output");
});

add(
	"optimize refuses a batch when one input cannot be computed",
	async (root, surface) => {
		const good = await sourcePng(root);
		const bad = join(root, "bad.png");
		await writeFile(bad, pngBytes().subarray(0, 40));
		const dir = join(root, "out");
		await mkdir(dir);
		const result = await surface.optimize([good, bad], { outputDir: dir });
		const body = obj(parseEnvelope(result), "result");
		if (arr(body, "files").length !== 0) {
			throw new Error("partial results reported");
		}
		if ((await readdir(dir)).length !== 0) throw new Error("batch wrote files");
		if (num(obj(body, "totals"), "sourceBytes") !== 0) {
			throw new Error("totals not zero");
		}
	},
);

add(
	"optimize writes every input into the output directory",
	async (root, surface) => {
		const inputs = await Promise.all(
			[0, 1, 2].map(async (index) => {
				const path = join(root, `s${index}.png`);
				await writeFile(path, pngBytes());
				return path;
			}),
		);
		const dir = join(root, "out");
		await mkdir(dir);
		const result = await surface.optimize(inputs, { outputDir: dir });
		if (result.code !== 0)
			throw new Error(`exit ${result.code}: ${result.stderr}`);
		const body = obj(parseEnvelope(result), "result");
		if (arr(body, "files").length !== 3) throw new Error("files count");
		if (num(obj(body, "totals"), "files") !== 3) throw new Error("totals");
		const after = await readdir(dir);
		if (after.join() !== ["s0.png", "s1.png", "s2.png"].join()) {
			throw new Error(`unexpected outputs: ${after.join()}`);
		}
	},
);

add("model inspect and validate are read-only", async (root, surface) => {
	const file = await modelJson(root);
	const before = await readdir(root);
	const inspect = await surface.model("inspect", file, {});
	if (inspect.code !== 0) throw new Error(`inspect exit ${inspect.code}`);
	if (str(report(inspect), "command") !== "model")
		throw new Error("inspect command");
	const validate = await surface.model("validate", file, {});
	if (validate.code !== 0) throw new Error(`validate exit ${validate.code}`);
	if (str(report(validate), "verdict") !== "pass") throw new Error("verdict");
	// minecraft: references without a vanilla source are warnings, not errors.
	if (arr(report(validate), "findings").some((f) => f.level === "error"))
		throw new Error("error findings");
	const after = await readdir(root);
	if (after.join() !== before.join()) throw new Error("read-only wrote files");
});

add("model validate reports findings with exit 3", async (root, surface) => {
	const file = join(root, "bad.json");
	await writeFile(
		file,
		JSON.stringify({
			elements: [
				{
					from: [0, 0, 0],
					to: [1, 1, 1],
					faces: { north: { texture: "#all", uv: [0, 0, 1] } },
				},
			],
		}),
	);
	const result = await surface.model("validate", file, {});
	if (result.code !== 3) throw new Error(`exit ${result.code}`);
	if (str(report(result), "verdict") !== "fail") throw new Error("verdict");
	const codes = arr(report(result), "findings").map((finding) =>
		str(finding, "code"),
	);
	if (!codes.includes("MODEL_INVALID_UV")) {
		throw new Error(`codes: ${codes.join()}`);
	}
});

add("model inspect requires a file inside the pack", async (root, surface) => {
	const pack = join(root, "pack");
	const nested = join(pack, "assets/minecraft/models/item");
	await mkdir(nested, { recursive: true });
	const file = await modelJson(root, "outside.json");
	const result = await surface.model("inspect", file, { pack });
	if (result.code !== 2) throw new Error(`exit ${result.code}`);
	if (parseError(result).code !== "INVALID_ARGUMENT")
		throw new Error("outside pack");
});

add("model create embeds the model document", async (root, surface) => {
	const spec = join(root, "spec.json");
	await writeFile(
		spec,
		JSON.stringify({ textures: { all: "minecraft:block/stone" } }),
	);
	const result = await surface.model("create", undefined, {
		spec,
		stdout: true,
	});
	if (result.code !== 0)
		throw new Error(`exit ${result.code}: ${result.stderr}`);
	const body = obj(parseEnvelope(result, "stderr"), "result");
	if (str(body, "mode") !== "create") throw new Error("mode");
	if (body.changed !== true) throw new Error("changed");
	const text = stdoutText(result);
	if (
		obj(asObject(JSON.parse(text)), "textures").all !== "minecraft:block/stone"
	) {
		throw new Error("embedded document");
	}
});

add("model create needs exactly one output", async (root, surface) => {
	const spec = join(root, "spec.json");
	await writeFile(spec, "{}");
	const missing = await surface.model("create", undefined, { spec });
	if (parseError(missing).code !== "OUTPUT_REQUIRED") {
		throw new Error("missing output");
	}
	const duplicated = await surface.model("create", undefined, {
		spec,
		output: join(root, "a.json"),
		stdout: true,
	});
	if (parseError(duplicated, "stderr").code !== "ARGUMENT_CONFLICT") {
		throw new Error("duplicate output");
	}
	const conflicting = await surface.model("create", undefined, {
		spec,
		operations: spec,
	});
	if (parseError(conflicting).code !== "INVALID_ARGUMENT") {
		throw new Error("create with operations");
	}
});

add(
	"model create and apply require their document flags",
	async (root, surface) => {
		const result = await surface.model("create", undefined, {});
		if (result.code !== 2) throw new Error(`create exit ${result.code}`);
		if (parseError(result).code !== "INVALID_ARGUMENT") {
			throw new Error("missing spec code");
		}
		const file = await modelJson(root);
		const apply = await surface.model("apply", file, {});
		if (apply.code !== 2) throw new Error(`apply exit ${apply.code}`);
		if (parseError(apply).code !== "INVALID_ARGUMENT") {
			throw new Error("missing operations code");
		}
	},
);

add("model apply writes only an explicit new path", async (root, surface) => {
	const file = await modelJson(root);
	const operations = join(root, "ops.json");
	await writeFile(
		operations,
		JSON.stringify([{ op: "set_parent", parent: "minecraft:block/block" }]),
	);
	const output = join(root, "out.json");
	const result = await surface.model("apply", file, { operations, output });
	if (result.code !== 0)
		throw new Error(`exit ${result.code}: ${result.stderr}`);
	const written = asObject(JSON.parse(await readFile(output, "utf8")));
	if (obj(written, "textures") === undefined)
		throw new Error("written document");
	const existing = await surface.model("apply", file, { operations, output });
	if (parseError(existing).code !== "OUTPUT_EXISTS") {
		throw new Error("overwrite refusal");
	}
});

add("model export needs every binding output", async (root, surface) => {
	const file = await modelJson(root);
	const binding = join(root, "binding.json");
	await writeFile(
		binding,
		JSON.stringify({
			item: { itemId: "minecraft:ruby", modelId: "minecraft:item/ruby" },
		}),
	);
	const missing = await surface.model("export", file, {});
	if (parseError(missing).code !== "OUTPUT_REQUIRED") {
		throw new Error("no output");
	}
	const partial = await surface.model("export", file, {
		binding,
		itemOutput: join(root, "i.json"),
	});
	if (parseError(partial).code !== "MODEL_UNSUPPORTED_VERSION") {
		throw new Error("missing version for binding.item");
	}
});

add(
	"model export refuses binding outputs even with force",
	async (root, surface) => {
		const file = await modelJson(root);
		const binding = join(root, "binding.json");
		await writeFile(
			binding,
			JSON.stringify({
				item: { itemId: "minecraft:ruby", modelId: "minecraft:item/ruby" },
			}),
		);
		const item = join(root, "i.json");
		await writeFile(item, "old");
		const result = await surface.model("export", file, {
			binding,
			itemOutput: item,
			force: true,
		});
		if (result.code !== 4) throw new Error(`exit ${result.code}`);
		if (parseError(result).code !== "OUTPUT_EXISTS") {
			throw new Error("binding overwrite");
		}
		if ((await readFile(item, "utf8")) !== "old") {
			throw new Error("binding file rewritten");
		}
	},
);

add(
	"model export refuses an output outside the pack",
	async (root, surface) => {
		const pack = join(root, "pack");
		const nested = join(pack, "assets/minecraft/models/item");
		await mkdir(nested, { recursive: true });
		const file = join(nested, "ruby.json");
		await writeFile(
			file,
			JSON.stringify({ textures: { all: "minecraft:block/stone" } }),
		);
		const result = await surface.model("export", file, {
			pack,
			output: join(root, "outside.json"),
		});
		if (result.code !== 2) throw new Error(`exit ${result.code}`);
		if (parseError(result).code !== "INVALID_ARGUMENT") {
			throw new Error("outside root code");
		}
		if (parseError(result).details.reason !== "outside-allowed-root") {
			throw new Error("outside root reason");
		}
	},
);

/** Memory stream pair capturing raw stdout and stderr separately. */
export function captureStreams(): {
	streams: OutputStreams;
	stdout(): Uint8Array;
	stderrText(): string;
} {
	const out: Array<string | Uint8Array> = [];
	const err: Array<string | Uint8Array> = [];
	const collect =
		(into: Array<string | Uint8Array>) =>
		(chunk: string | Uint8Array): void => {
			into.push(chunk);
		};
	const join = (chunks: Array<string | Uint8Array>): Uint8Array =>
		new Uint8Array(
			Buffer.concat(
				chunks.map((chunk) =>
					typeof chunk === "string"
						? Buffer.from(chunk, "utf8")
						: Buffer.from(chunk),
				),
			),
		);
	return {
		streams: {
			stdout: { write: collect(out) },
			stderr: { write: collect(err) },
		},
		stdout: () => join(out),
		stderrText: () => Buffer.from(join(err)).toString("utf8"),
	};
}
