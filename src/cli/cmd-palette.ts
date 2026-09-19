import { McAssetError } from "../core/errors.ts";
import { extractPalette, inspectPalette } from "../core/palette.ts";
import { flattenCanvas } from "../io/png.ts";
import { emitCommandFailure, resolveInputPath } from "./artifacts.ts";
import { loadEditableCanvas } from "./canvas-input.ts";
import {
	emitEnvelope,
	emitLog,
	type OutputStreams,
	routeStreams,
} from "./channels.ts";
import { successEnvelope } from "./envelope.ts";
import { parseProfile } from "./profiles.ts";

export interface PaletteOptions {
	output?: string | undefined;
	stdout?: boolean | undefined;
	source?: string | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
	inPlace?: boolean | undefined;
	input?: string | undefined;
	profile?: string | undefined;
}

function rejectFileFlags(options: PaletteOptions, command: string): void {
	if (
		(options.output !== undefined && options.output !== "") ||
		options.stdout === true ||
		(options.source !== undefined && options.source !== "") ||
		options.force === true ||
		options.mkdir === true ||
		options.inPlace === true ||
		(options.input !== undefined && options.input !== "")
	) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`${command} produces a report only and takes no file flags.`,
		);
	}
}

function toHex(color: { r: number; g: number; b: number; a: number }): string {
	const byte = (value: number): string => value.toString(16).padStart(2, "0");
	return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}${byte(color.a)}`.toUpperCase();
}

/**
 * Read-only palette reports: `palette extract` returns the distinct colors
 * as an authoring palette, `palette inspect` returns the frozen
 * characteristic shape. Both refuse every file flag as INVALID_ARGUMENT
 * and never write artifact files.
 */
export async function runPalette(
	mode: string,
	image: string | undefined,
	options: PaletteOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({ json: globalJson, stdoutArtifact: false });
	try {
		if (mode !== "extract" && mode !== "inspect") {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"palette takes extract or inspect.",
				{ mode },
			);
		}
		const profile = parseProfile(options.profile);
		rejectFileFlags(options, `palette ${mode}`);
		const inputPath = resolveInputPath(image, undefined, `palette ${mode}`);
		const loaded = await loadEditableCanvas(inputPath);
		const pixels = flattenCanvas(loaded.canvas);
		if (mode === "extract") {
			const palette = extractPalette(pixels);
			const result = {
				command: "palette",
				mode: "extract",
				profile,
				colorCount: palette.entries.length,
				entries: palette.entries.map((entry) => ({
					id: entry.id,
					color: toHex(entry.color),
					...(entry.role !== undefined ? { role: entry.role } : {}),
				})),
			};
			if (globalJson) {
				emitEnvelope(successEnvelope(result), streams, route);
			} else {
				emitLog(
					`ok palette extract profile=${profile} colors=${result.colorCount}`,
					streams,
					route,
				);
				for (const entry of result.entries) {
					emitLog(`color ${entry.id} ${entry.color}`, streams, route);
				}
			}
			return 0;
		}
		const report = inspectPalette(pixels, loaded.canvas.palette);
		const result = {
			command: "palette",
			mode: "inspect",
			profile,
			...report,
		};
		if (globalJson) {
			emitEnvelope(successEnvelope(result), streams, route);
		} else {
			emitLog(
				`ok palette inspect profile=${profile} colors=${report.colorCount} transparent=${report.transparentPixels}`,
				streams,
				route,
			);
		}
		return 0;
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}
