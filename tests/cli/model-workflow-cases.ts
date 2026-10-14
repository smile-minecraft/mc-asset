import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runModel } from "../../src/cli/cmd-model.ts";
import { runValidatePack } from "../../src/cli/cmd-validate-pack.ts";
import { captureStreams } from "./optimize-model-cases.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const VERSION = { resourcePackVersion: "75" } as const;

/** Files written by one create, apply, export run. */
export const MODEL_WORKFLOW_FILES = {
	created: "work/created.json",
	applied: "pack/assets/mypack/models/block/ruby.json",
	item: "pack/assets/mypack/items/ruby.json",
	blockstate: "pack/assets/mypack/blockstates/ruby.json",
	texture: "pack/assets/mypack/textures/block/ruby.png",
} as const;

const SPEC = {
	textures: { all: "mypack:block/placeholder" },
	elements: [
		{
			from: [0, 0, 0],
			to: [16, 16, 16],
			faces: {
				down: { texture: "#all" },
				up: { texture: "#all" },
				north: { texture: "#all", uv: [0, 0, 16, 16] },
				south: { texture: "#all" },
				west: { texture: "#all" },
				east: { texture: "#all" },
			},
		},
	],
};

const OPERATIONS = [
	{ op: "set_texture", name: "all", value: "mypack:block/ruby" },
	{ op: "update_face", element: 0, face: "up", changes: { rotation: 90 } },
];

const BINDING = {
	item: { itemId: "mypack:ruby", modelId: "mypack:block/ruby" },
	blockstate: {
		blockId: "mypack:ruby",
		variants: { "": { model: "mypack:block/ruby" } },
	},
};

/** Outcome of the whole flow, including the final pack report. */
export interface ModelWorkflowOutcome {
	readonly exitCodes: Readonly<Record<string, number>>;
	readonly packVerdict: string;
	readonly packFindings: readonly { code: string; level: string }[];
	readonly files: Readonly<Record<string, string>>;
	/** Raw stdout of every step, shown when a step fails. */
	readonly outputs: Readonly<Record<string, string>>;
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(value));
}

async function run(
	invoke: (capture: ReturnType<typeof captureStreams>) => Promise<number>,
): Promise<{ code: number; stdout: string }> {
	const capture = captureStreams();
	const code = await invoke(capture);
	return { code, stdout: Buffer.from(capture.stdout()).toString("utf8") };
}

/**
 * Drives model create, apply and export into a fresh pack, then runs the
 * whole-pack check and returns the exit codes plus the written model text.
 */
export async function runModelWorkflow(
	root: string,
): Promise<ModelWorkflowOutcome> {
	const path = (name: string) => join(root, name);
	await writeJson(path("spec.json"), SPEC);
	await writeJson(path("operations.json"), OPERATIONS);
	await writeJson(path("binding.json"), BINDING);
	const exitCodes: Record<string, number> = {};
	const outputs: Record<string, string> = {};
	const step = async (
		name: string,
		invoke: (capture: ReturnType<typeof captureStreams>) => Promise<number>,
	): Promise<{ code: number; stdout: string }> => {
		const result = await run(invoke);
		exitCodes[name] = result.code;
		outputs[name] = result.stdout;
		return result;
	};

	await step("create", (c) =>
		runModel(
			"create",
			undefined,
			{
				spec: path("spec.json"),
				output: path(MODEL_WORKFLOW_FILES.created),
				mkdir: true,
				...VERSION,
			},
			true,
			c.streams,
		),
	);
	await step("apply", (c) =>
		runModel(
			"apply",
			path(MODEL_WORKFLOW_FILES.created),
			{
				operations: path("operations.json"),
				output: path(MODEL_WORKFLOW_FILES.applied),
				mkdir: true,
				...VERSION,
			},
			true,
			c.streams,
		),
	);
	await mkdir(dirname(path(MODEL_WORKFLOW_FILES.texture)), { recursive: true });
	await copyFile(
		join(FIXTURES, "px-8x8.png"),
		path(MODEL_WORKFLOW_FILES.texture),
	);
	await step("export", (c) =>
		runModel(
			"export",
			path(MODEL_WORKFLOW_FILES.applied),
			{
				binding: path("binding.json"),
				pack: path("pack"),
				itemOutput: path(MODEL_WORKFLOW_FILES.item),
				blockstateOutput: path(MODEL_WORKFLOW_FILES.blockstate),
				mkdir: true,
				...VERSION,
			},
			true,
			c.streams,
		),
	);
	await step("validate", (c) =>
		runModel(
			"validate",
			path(MODEL_WORKFLOW_FILES.applied),
			{ pack: path("pack"), ...VERSION },
			true,
			c.streams,
		),
	);
	const pack = await step("validatePack", (c) =>
		runValidatePack(path("pack"), VERSION, true, c.streams),
	);
	const report = (
		JSON.parse(pack.stdout || '{"result":{}}') as {
			result: {
				verdict?: string;
				findings?: { code: string; level: string }[];
			};
		}
	).result;

	const files: Record<string, string> = {};
	for (const name of ["created", "applied", "item", "blockstate"] as const) {
		files[name] = await readFile(
			path(MODEL_WORKFLOW_FILES[name]),
			"utf8",
		).catch(() => "");
	}
	return {
		exitCodes,
		packVerdict: report.verdict ?? "missing",
		packFindings: report.findings ?? [],
		files,
		outputs,
	};
}

/** The flow in a throwaway directory; callers assert on the outcome. */
export async function withModelWorkflow(
	check: (outcome: ModelWorkflowOutcome) => void,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "model-workflow-"));
	try {
		check(await runModelWorkflow(root));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/** Assertions shared by the Bun and Node entries. */
export function assertModelWorkflow(outcome: ModelWorkflowOutcome): void {
	for (const [step, code] of Object.entries(outcome.exitCodes)) {
		if (code !== 0) {
			throw new Error(`${step} exited ${code}: ${outcome.outputs[step]}`);
		}
	}
	if (outcome.packVerdict === "fail") throw new Error("pack verdict fail");
	// Without a vanilla tree the atlas sources are unknown, so the only
	// expected findings are coverage warnings; anything else is a defect.
	const unexpected = outcome.packFindings.filter(
		(finding) =>
			finding.code !== "PACK_COVERAGE_SKIPPED" || finding.level !== "warning",
	);
	if (unexpected.length > 0) {
		throw new Error(`pack findings: ${outcome.outputs.validatePack}`);
	}
	const model = JSON.parse(outcome.files.applied ?? "") as {
		textures: { all: string };
		elements: { faces: { up: { rotation: number } } }[];
	};
	if (model.textures.all !== "mypack:block/ruby") throw new Error("texture");
	if (model.elements[0]?.faces.up.rotation !== 90) throw new Error("rotation");
	if (!(outcome.files.item ?? "").includes("mypack:block/ruby")) {
		throw new Error("item definition does not reference the model");
	}
	if (!(outcome.files.blockstate ?? "").includes("mypack:block/ruby")) {
		throw new Error("blockstate does not reference the model");
	}
}
