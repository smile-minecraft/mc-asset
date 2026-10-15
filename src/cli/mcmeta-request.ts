import { McAssetError } from "../core/errors.ts";
import type { McmetaAnimationFrame, NineSliceBorder } from "../core/mcmeta.ts";
import {
	generateAnimationMcmeta,
	generateGuiMcmeta,
} from "../core/mcmeta-generate.ts";
import { decodePng } from "../io/png.ts";
import { readInputFile } from "./artifacts.ts";
import {
	type McmetaGenerateWarning,
	mcmetaVersionStatus,
} from "./mcmeta-version.ts";
import {
	type PlannedTarget,
	planOutputTargets,
	writePlannedTargets,
} from "./safe-output.ts";
import {
	formatVersionTarget,
	resolveVersionTarget,
	versionReportShape,
} from "./version-options.ts";

/**
 * Request shared by `mcmeta animation|gui` and the `mcmeta_asset` tool.
 * Values are already typed here; the CLI converts its option strings with
 * the parse helpers in core/mcmeta-generate.ts first. A field that belongs
 * to the other mode is INVALID_ARGUMENT, even when it holds `false`.
 */
export interface McmetaRequest {
	mode: "animation" | "gui";
	inputPath: string;
	frameSize?: string | undefined;
	frametime?: number | undefined;
	frames?: ReadonlyArray<number | McmetaAnimationFrame> | undefined;
	interpolate?: boolean | undefined;
	type?: string | undefined;
	border?: number | NineSliceBorder | undefined;
	stretchInner?: boolean | undefined;
	minecraftVersion?: string | undefined;
	resourcePackVersion?: string | undefined;
}

export interface PreparedMcmeta {
	text: string;
	versionChecked: boolean;
	warnings: McmetaGenerateWarning[];
	sheetWidth: number;
	sheetHeight: number;
	version: ReturnType<typeof versionReportShape>;
	target: string;
}

const ANIMATION_ONLY = ["frameSize", "frametime", "frames", "interpolate"];
const GUI_ONLY = ["type", "border", "stretchInner"];

function assertApplicableFields(request: McmetaRequest): void {
	const foreign = request.mode === "animation" ? GUI_ONLY : ANIMATION_ONLY;
	const record = request as unknown as Record<string, unknown>;
	const given = foreign.filter((name) => record[name] !== undefined);
	if (given.length > 0) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`mcmeta ${request.mode} does not take ${given.join(", ")}.`,
			{ mode: request.mode, fields: given },
		);
	}
}

/** Validate the request, read the PNG (never written), and generate the text. */
export async function prepareMcmeta(
	request: McmetaRequest,
): Promise<PreparedMcmeta> {
	assertApplicableFields(request);
	const target = resolveVersionTarget({
		minecraftVersion: request.minecraftVersion,
		resourcePackVersion: request.resourcePackVersion,
	});
	const { canvas } = decodePng(
		await readInputFile(request.inputPath, "png input"),
	);
	const sheet = { sheetWidth: canvas.width, sheetHeight: canvas.height };
	const generated =
		request.mode === "animation"
			? generateAnimationMcmeta({
					...sheet,
					frameSize: request.frameSize ?? "",
					frametime: request.frametime,
					frames: request.frames,
					interpolate: request.interpolate,
				})
			: generateGuiMcmeta({
					...sheet,
					type: request.type ?? "",
					border: request.border,
					stretchInner: request.stretchInner,
				});
	return {
		...generated,
		...mcmetaVersionStatus(target.packFormat, request),
		...sheet,
		version: versionReportShape(target),
		target: formatVersionTarget(target),
	};
}

/**
 * Read-only preflight of the single `.mcmeta` target: exact extension, not
 * an alias of the PNG, not a directory or symlink, no silent overwrite
 * (OUTPUT_EXISTS unless `force`, which replaces the whole file), parent
 * must exist unless `mkdir`. Nothing is created here.
 */
export async function planMcmetaOutput(options: {
	output: string;
	inputPath: string;
	force: boolean;
	mkdir: boolean;
}): Promise<readonly PlannedTarget[]> {
	return planOutputTargets(
		[
			{
				path: options.output,
				extension: ".mcmeta",
				allowOverwrite: options.force,
			},
		],
		{ inputs: [options.inputPath], mkdir: options.mkdir },
	);
}

export async function writeMcmetaOutput(
	plan: readonly PlannedTarget[],
	text: string,
	mkdir: boolean,
): Promise<void> {
	const payloads = new Map<string, string>();
	for (const target of plan) payloads.set(target.path, text);
	await writePlannedTargets(plan, payloads, { mkdir });
}
