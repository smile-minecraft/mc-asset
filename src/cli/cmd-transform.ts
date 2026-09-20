import { McAssetError } from "../core/errors.ts";
import {
	crop,
	flipHorizontal,
	flipVertical,
	pad,
	type ResizeMode,
	resize,
	rotate90,
	rotate180,
	rotate270,
	translate,
} from "../core/transform.ts";
import type { Rect, RGBA } from "../core/types.ts";
import { encodePng } from "../io/png.ts";
import {
	assertMinecraftOutputPath,
	type CommandResult,
	emitCommandFailure,
	emitCommandSuccess,
	ensureMcpxText,
	preflightArtifactTargets,
	resolveArtifactTargets,
	resolveInputPath,
	type WarningNote,
	writeArtifactPayloads,
} from "./artifacts.ts";
import { loadEditableCanvas, resolveCommandSelection } from "./canvas-input.ts";
import { emitArtifact, type OutputStreams, routeStreams } from "./channels.ts";
import { parseProfile } from "./profiles.ts";

export interface TransformOptions {
	flip?: string | undefined;
	rotate?: string | undefined;
	crop?: string | undefined;
	pad?: string | undefined;
	padColor?: string | undefined;
	resize?: string | undefined;
	resizeMode?: string | undefined;
	translate?: string | undefined;
	output?: string | undefined;
	stdout?: boolean | undefined;
	source?: string | undefined;
	force?: boolean | undefined;
	mkdir?: boolean | undefined;
	inPlace?: boolean | undefined;
	input?: string | undefined;
	profile?: string | undefined;
	selection?: string | undefined;
}

function parseDecimalInteger(text: string, what: string): number {
	if (!/^-?\d+$/.test(text)) {
		throw new McAssetError(
			"INVALID_COORDINATE",
			`${what} must be an integer, without rounding.`,
			{ value: text },
		);
	}
	return Number.parseInt(text, 10);
}

function splitParts(raw: string, count: number, what: string): string[] {
	const parts = raw.split(",");
	if (parts.length !== count) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`${what} needs ${count} comma-separated integers.`,
			{ value: raw },
		);
	}
	return parts;
}

function parseCropRect(raw: string): Rect {
	const parts = splitParts(raw, 4, "--crop");
	const rect: Rect = {
		x: parseDecimalInteger(parts[0] as string, "Crop x"),
		y: parseDecimalInteger(parts[1] as string, "Crop y"),
		width: parseDecimalInteger(parts[2] as string, "Crop width"),
		height: parseDecimalInteger(parts[3] as string, "Crop height"),
	};
	if (rect.width < 1 || rect.height < 1) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"Crop width and height must be at least 1.",
			{ value: raw },
		);
	}
	return rect;
}

function parsePadAmounts(raw: string): {
	left: number;
	top: number;
	right: number;
	bottom: number;
} {
	const parts = splitParts(raw, 4, "--pad");
	return {
		left: parseDecimalInteger(parts[0] as string, "Pad left"),
		top: parseDecimalInteger(parts[1] as string, "Pad top"),
		right: parseDecimalInteger(parts[2] as string, "Pad right"),
		bottom: parseDecimalInteger(parts[3] as string, "Pad bottom"),
	};
}

function parsePadColor(raw: string): RGBA {
	if (raw === "transparent") {
		return { r: 0, g: 0, b: 0, a: 0 };
	}
	const match = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(raw);
	if (match === null || match[1] === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"--pad-color must be transparent, #RRGGBB, or #RRGGBBAA.",
			{ value: raw },
		);
	}
	const digits = match[1];
	const byte = (index: number): number =>
		Number.parseInt(digits.slice(index, index + 2), 16);
	return {
		r: byte(0),
		g: byte(2),
		b: byte(4),
		a: digits.length === 8 ? byte(6) : 255,
	};
}

function parseResizeSize(raw: string): { width: number; height: number } {
	const match = /^(\d+)x(\d+)$/i.exec(raw.trim());
	if (match === null || match[1] === undefined || match[2] === undefined) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"--resize must look like WxH with positive integers.",
			{ value: raw },
		);
	}
	return {
		width: Number.parseInt(match[1], 10),
		height: Number.parseInt(match[2], 10),
	};
}

function parseResizeMode(raw: string | undefined): ResizeMode | undefined {
	if (raw === undefined || raw === "") {
		return undefined;
	}
	if (raw !== "nearest" && raw !== "box" && raw !== "pixel-aware") {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"--resize-mode must be nearest, box, or pixel-aware.",
			{ value: raw },
		);
	}
	return raw;
}

function parseTranslate(raw: string): { dx: number; dy: number } {
	const parts = splitParts(raw, 2, "--translate");
	return {
		dx: parseDecimalInteger(parts[0] as string, "Translate dx"),
		dy: parseDecimalInteger(parts[1] as string, "Translate dy"),
	};
}

/**
 * Single-geometry entry: exactly one of --flip/--rotate/--crop/--pad/
 * --resize/--translate runs per invocation; two or more is
 * ARGUMENT_CONFLICT and zero is INVALID_ARGUMENT. --selection never
 * combines with geometry. Input is PNG or .mcpx; anything else fails in
 * the shared loader as UNSUPPORTED_IMAGE_FORMAT.
 */
export async function runTransform(
	input: string | undefined,
	options: TransformOptions,
	globalJson: boolean,
	streams: OutputStreams,
): Promise<number> {
	const route = routeStreams({
		json: globalJson,
		stdoutArtifact: options.stdout === true,
	});
	try {
		const profile = parseProfile(options.profile);
		const inputPath = resolveInputPath(input, options.input, "transform");
		const geometries = [
			options.flip,
			options.rotate,
			options.crop,
			options.pad,
			options.resize,
			options.translate,
		].filter((flag) => flag !== undefined && flag !== "");
		if (
			options.selection !== undefined &&
			options.selection !== "" &&
			geometries.length > 0
		) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				"--selection cannot be combined with geometry operations.",
			);
		}
		if (geometries.length === 0) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"transform needs exactly one geometry flag: --flip, --rotate, --crop, --pad, --resize, or --translate.",
			);
		}
		if (geometries.length > 1) {
			throw new McAssetError(
				"ARGUMENT_CONFLICT",
				"transform takes exactly one geometry operation per invocation; run them in separate calls.",
			);
		}
		if (
			options.resizeMode !== undefined &&
			options.resizeMode !== "" &&
			(options.resize === undefined || options.resize === "")
		) {
			throw new McAssetError(
				"INVALID_ARGUMENT",
				"--resize-mode needs --resize.",
			);
		}
		if (
			options.padColor !== undefined &&
			options.padColor !== "" &&
			(options.pad === undefined || options.pad === "")
		) {
			throw new McAssetError("INVALID_ARGUMENT", "--pad-color needs --pad.");
		}
		// --in-place rewrites the input in its own kind: .mcpx inputs
		// re-serialize as .mcpx, raster inputs re-encode as PNG. The helper
		// picks the kind from the command label, so the label follows the
		// input here; the reported command stays "transform".
		const inPlaceKind =
			options.inPlace === true && inputPath.toLowerCase().endsWith(".mcpx")
				? "build"
				: "import";
		const targets = resolveArtifactTargets({
			command: inPlaceKind,
			output: options.output,
			stdout: options.stdout,
			source: options.source,
			force: options.force,
			inPlace: options.inPlace,
			inputPath,
		});
		if (options.output !== undefined && options.output !== "") {
			assertMinecraftOutputPath(profile, options.output);
		}
		const loaded = await loadEditableCanvas(inputPath);
		const canvas = loaded.canvas;
		const warnings: WarningNote[] = loaded.warnings;
		// Resolve the selection for its validation side effects only:
		// any provided value already conflicted above, so reaching here
		// with a selection means there was no geometry, which the count
		// check already rejected. The call keeps the seam uniform.
		resolveCommandSelection(canvas, options.selection, true);
		let detail = "";
		if (options.flip !== undefined && options.flip !== "") {
			if (options.flip !== "h" && options.flip !== "v") {
				throw new McAssetError("INVALID_ARGUMENT", "--flip must be h or v.", {
					value: options.flip,
				});
			}
			if (options.flip === "h") {
				flipHorizontal(canvas);
			} else {
				flipVertical(canvas);
			}
			detail = `flip:${options.flip}`;
		} else if (options.rotate !== undefined && options.rotate !== "") {
			if (
				options.rotate !== "90" &&
				options.rotate !== "180" &&
				options.rotate !== "270"
			) {
				throw new McAssetError(
					"INVALID_ARGUMENT",
					"--rotate must be 90, 180, or 270.",
					{ value: options.rotate },
				);
			}
			if (options.rotate === "90") {
				rotate90(canvas);
			} else if (options.rotate === "180") {
				rotate180(canvas);
			} else {
				rotate270(canvas);
			}
			detail = `rotate:${options.rotate}`;
		} else if (options.crop !== undefined && options.crop !== "") {
			crop(canvas, parseCropRect(options.crop));
			detail = `crop:${options.crop}`;
		} else if (options.pad !== undefined && options.pad !== "") {
			const amounts = parsePadAmounts(options.pad);
			if (options.padColor !== undefined && options.padColor !== "") {
				pad(canvas, { ...amounts, color: parsePadColor(options.padColor) });
			} else {
				pad(canvas, amounts);
			}
			detail = `pad:${options.pad}`;
		} else if (options.resize !== undefined && options.resize !== "") {
			const size = parseResizeSize(options.resize);
			resize(
				canvas,
				size.width,
				size.height,
				parseResizeMode(options.resizeMode),
			);
			detail = `resize:${options.resize}`;
		} else {
			const delta = parseTranslate(options.translate as string);
			translate(canvas, delta.dx, delta.dy);
			detail = `translate:${options.translate}`;
		}
		let pngBytes: Uint8Array | undefined;
		if (targets.pngStdout || targets.pngFiles.length > 0) {
			pngBytes = encodePng(canvas);
		}
		let mcpxText: string | undefined;
		if (targets.mcpxFiles.length > 0) {
			mcpxText = ensureMcpxText(canvas, (warning) => {
				warnings.push({ code: warning.code, message: warning.message });
			});
		}
		// File-target preflight runs before any stdout artifact byte, so a
		// conflict keeps stdout empty.
		await preflightArtifactTargets(targets, {
			inputPath,
			inPlace: options.inPlace,
			mkdir: options.mkdir,
		});
		if (pngBytes !== undefined && targets.pngStdout) {
			emitArtifact(pngBytes, streams, route);
		}
		await writeArtifactPayloads(
			[
				...(targets.pngFiles.length > 0 && pngBytes !== undefined
					? [{ targets: targets.pngFiles, data: pngBytes }]
					: []),
				...(targets.mcpxFiles.length > 0 && mcpxText !== undefined
					? [{ targets: targets.mcpxFiles, data: mcpxText }]
					: []),
			],
			options.mkdir,
		);
		const result: CommandResult = {
			command: "transform",
			profile,
			applied: 0,
			operations: [],
			warnings,
			details: { geometry: detail },
			...(targets.pngFiles[0] !== undefined
				? { output: targets.pngFiles[0].path }
				: {}),
			...(targets.mcpxFiles[0] !== undefined
				? { source: targets.mcpxFiles[0].path }
				: {}),
			...(targets.pngStdout ? { stdout: true as const } : {}),
		};
		emitCommandSuccess(streams, route, globalJson, result);
		return 0;
	} catch (error) {
		return emitCommandFailure(streams, route, globalJson, error);
	}
}
