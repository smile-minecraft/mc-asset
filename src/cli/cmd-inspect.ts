import { Buffer } from "node:buffer";
import { inspectStructure, renderInspectView } from "../analyze/inspect.ts";
import { McAssetError } from "../core/errors.ts";
import { emitCommandFailure, resolveInputPath } from "./artifacts.ts";
import { loadEditableCanvas } from "./canvas-input.ts";
import {
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { successEnvelope } from "./envelope.ts";

export interface InspectOptions {
	mode?: string | undefined;
	crop?: string | undefined;
	scale?: string | undefined;
	output?: string | undefined;
	stdout?: boolean | undefined;
	source?: string | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
	inPlace?: boolean | undefined;
	input?: string | undefined;
	profile?: string | undefined;
}

function rejectFileFlags(options: InspectOptions): void {
	if (
		(options.output !== undefined && options.output !== "") ||
		options.stdout === true ||
		(options.source !== undefined && options.source !== "") ||
		options.force === true ||
		options.mkdir === true ||
		options.inPlace === true ||
		(options.input !== undefined && options.input !== "") ||
		(options.profile !== undefined && options.profile !== "")
	) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"inspect produces a report only and takes no file flags.",
		);
	}
}

/**
 * Read-only top-level inspection, distinct from `palette inspect`: mode
 * `structure` reports layers, regions, color usage, and overlaps, while
 * mode `view` renders the composited pixels with crop/scale metadata plus
 * the PNG bytes under `--json`. Raster inputs read as a single base
 * layer. The input is never written.
 */
export async function runInspect(
	input: string | undefined,
	options: InspectOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({ json: globalJson, stdoutArtifact: false });
	try {
		const mode = options.mode ?? "structure";
		if (mode !== "structure" && mode !== "view") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				'inspect mode must be "structure" or "view".',
				{ mode },
			);
		}
		rejectFileFlags(options);
		const hasCrop = options.crop !== undefined && options.crop !== "";
		const hasScale = options.scale !== undefined && options.scale !== "";
		if (mode === "structure" && (hasCrop || hasScale)) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"inspect structure takes no --crop or --scale; use --mode view.",
				{ mode },
			);
		}
		const inputPath = resolveInputPath(input, undefined, "inspect");
		const loaded = await loadEditableCanvas(inputPath);
		const canvas = loaded.canvas;
		if (mode === "structure") {
			const result = {
				command: "inspect",
				...inspectStructure(canvas),
			};
			if (globalJson) {
				emitEnvelope(successEnvelope(result), streams, route);
			} else {
				emitLog(
					`ok inspect mode=structure size=${canvas.width}x${canvas.height} layers=${result.layers.length} regions=${result.regions.length}`,
					streams,
					route,
				);
			}
			return 0;
		}
		const view = renderInspectView(canvas, {
			...(hasCrop ? { crop: options.crop as string } : {}),
			...(hasScale ? { scale: Number(options.scale) } : {}),
		});
		const result = {
			command: "inspect",
			...view.metadata,
			pngBase64: Buffer.from(view.pngBytes).toString("base64"),
		};
		if (globalJson) {
			emitEnvelope(successEnvelope(result), streams, route);
		} else {
			const output = view.metadata.outputDimensions;
			emitLog(
				`ok inspect mode=view size=${output.width}x${output.height} scale=${view.metadata.scale}`,
				streams,
				route,
			);
		}
		return 0;
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}
