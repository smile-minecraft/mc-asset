import { comparePngCanvases } from "../analyze/compare.ts";
import { McAssetError } from "../core/errors.ts";
import { decodePng, encodePng } from "../io/png.ts";
import { readInputFile } from "./artifacts.ts";
import { planOutputTargets, writePlannedTargets } from "./safe-output.ts";

export interface CompareRequest {
	beforePath: string;
	afterPath: string;
	image?: "none" | "diff" | undefined;
	scale?: number | undefined;
	outputPath?: string | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
}

export async function prepareCompare(args: CompareRequest) {
	const image = args.image ?? "none";
	if (image !== "none" && image !== "diff") {
		throw new McAssetError("INVALID_ARGUMENT", "image must be none or diff.");
	}
	if (args.outputPath !== undefined && image !== "diff") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"outputPath requires image=diff.",
		);
	}
	if (args.outputPath === undefined && (args.force || args.mkdir)) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"force and mkdir require an output path.",
		);
	}
	const plan =
		args.outputPath === undefined
			? undefined
			: await planOutputTargets(
					[
						{
							path: args.outputPath,
							extension: ".png",
							allowOverwrite: args.force === true,
						},
					],
					{
						inputs: [args.beforePath, args.afterPath],
						mkdir: args.mkdir === true,
					},
				);
	const before = decodePng(
		await readInputFile(args.beforePath, "before PNG"),
	).canvas;
	const after = decodePng(
		await readInputFile(args.afterPath, "after PNG"),
	).canvas;
	const result = comparePngCanvases(
		before,
		after,
		image === "diff",
		args.scale ?? 1,
	);
	const png = result.image === undefined ? undefined : encodePng(result.image);
	return { report: result.report, png, plan };
}

export async function writeCompare(
	args: CompareRequest,
	prepared: Awaited<ReturnType<typeof prepareCompare>>,
) {
	if (prepared.plan !== undefined && prepared.png !== undefined) {
		await writePlannedTargets(
			prepared.plan,
			new Map([[args.outputPath as string, prepared.png]]),
			{ mkdir: args.mkdir === true },
		);
	}
}
