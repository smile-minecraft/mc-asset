import { McAssetError } from "./errors.ts";
import { parseFrameSize } from "./frameset.ts";
import type { McmetaAnimationFrame, NineSliceBorder } from "./mcmeta.ts";
import {
	checkAnimationFrameIndices,
	deriveAnimationGeometry,
	nineSliceGeometryError,
} from "./mcmeta.ts";

/**
 * Generation of `.mcmeta` text from a PNG's dimensions. Pure and
 * deterministic: no file access, no merging with an existing document.
 *
 * Output contract (fixed so Bun and Node emit identical bytes): compact
 * JSON followed by one "\n". Key order is
 *   animation: width, height, frametime, interpolate (only when true), frames
 *   gui.scaling: type, width, height, border {left, top, right, bottom},
 *                stretch_inner (only when true)
 * `frames` is always written out (all frames in order when none is given).
 * A document carries only the one requested section.
 *
 */

export interface McmetaGenerateResult {
	text: string;
}

export interface GenerateAnimationInput {
	sheetWidth: number;
	sheetHeight: number;
	/** `N` or `WxH`, same grammar as `animate --frame-size`. */
	frameSize: string;
	frametime?: number | undefined;
	/** Bare indices and/or `{ index, time? }` entries; undefined = all frames in order. */
	frames?: ReadonlyArray<number | McmetaAnimationFrame> | undefined;
	/** Expand `frames` from a named timeline shape; conflicts with `frames`. */
	preset?: TimelinePreset | undefined;
	/** Ticks the first frame of a preset expansion rests for. */
	holdTicks?: number | undefined;
	interpolate?: boolean | undefined;
}

/** The three named playback shapes a sheet can be expanded from. */
export type TimelinePreset = "hold-and-sweep" | "ping-pong" | "pulse";

export const TIMELINE_PRESETS: readonly TimelinePreset[] = [
	"hold-and-sweep",
	"ping-pong",
	"pulse",
];

export interface ExpandTimelineInput {
	readonly preset: TimelinePreset;
	/** Physical frame count of the sheet. */
	readonly frameCount: number;
	/** Ticks every plain entry rests for. */
	readonly frametime: number;
	/** Ticks the first frame rests for. */
	readonly holdTicks: number;
}

/** Parse a timeline preset name; anything else is INVALID_ARGUMENT. */
export function parseTimelinePreset(raw: string): TimelinePreset {
	if (!(TIMELINE_PRESETS as ReadonlyArray<string>).includes(raw)) {
		throw invalidArgument(
			`--preset must be hold-and-sweep, ping-pong, or pulse, got "${raw}".`,
			{ preset: raw, supported: [...TIMELINE_PRESETS] },
		);
	}
	return raw as TimelinePreset;
}

/**
 * Expand a named timeline shape into the `frames` list of a document.
 *
 * hold-and-sweep rests the first frame for `holdTicks` and then plays
 * forward; ping-pong plays forward and back without repeating either end;
 * pulse rests both ends for `holdTicks` on the way out and back. Plain
 * entries stay bare indices so the document's frametime applies.
 *
 * The skeleton returns the plain forward list; the three shapes land with the
 * implementation that paints them.
 */
export function expandTimelinePreset(
	input: ExpandTimelineInput,
): Array<number | McmetaAnimationFrame> {
	if (!(TIMELINE_PRESETS as ReadonlyArray<string>).includes(input.preset)) {
		throw invalidArgument(
			`--preset must be hold-and-sweep, ping-pong, or pulse, got "${String(input.preset)}".`,
			{ preset: input.preset, supported: [...TIMELINE_PRESETS] },
		);
	}
	if (!isPositiveInt(input.frameCount)) {
		throw invalidArgument("The frame count must be a positive integer.", {
			frameCount: input.frameCount,
		});
	}
	if (!isPositiveInt(input.frametime)) {
		throw invalidArgument("frametime must be a positive integer.", {
			frametime: input.frametime,
		});
	}
	if (!isPositiveInt(input.holdTicks)) {
		throw invalidArgument("holdTicks must be a positive integer.", {
			holdTicks: input.holdTicks,
		});
	}
	const n = input.frameCount;
	const frames: Array<number | McmetaAnimationFrame> = [];
	if (n === 1) {
		frames.push({ index: 0, time: input.holdTicks });
		return frames;
	}
	switch (input.preset) {
		case "hold-and-sweep": {
			frames.push({ index: 0, time: input.holdTicks });
			for (let i = 1; i < n; i += 1) frames.push(i);
			return frames;
		}
		case "ping-pong": {
			for (let i = 0; i < n; i += 1) frames.push(i);
			for (let i = n - 2; i >= 1; i -= 1) frames.push(i);
			return frames;
		}
		case "pulse": {
			if (n === 2) {
				frames.push(0, 1);
				return frames;
			}
			frames.push({ index: 0, time: input.holdTicks });
			for (let i = 1; i < n; i += 1) frames.push(i);
			frames.push({ index: n - 1, time: input.holdTicks });
			for (let i = n - 2; i >= 1; i -= 1) frames.push(i);
			return frames;
		}
	}
}

export interface GenerateGuiInput {
	sheetWidth: number;
	sheetHeight: number;
	type: string;
	/** `N` for four equal sides, or a full `{ left, top, right, bottom }`. */
	border?: number | NineSliceBorder | undefined;
	stretchInner?: boolean | undefined;
}

function invalidArgument(message: string, details?: unknown): McAssetError {
	return new McAssetError("INVALID_ARGUMENT", message, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInt(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		(value as number) >= 0
	);
}

function isPositiveInt(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		(value as number) > 0
	);
}

/** Parse `--frames`: a JSON array of indices and/or `{index,time}` objects. */
export function parseFramesOption(
	raw: string,
): Array<number | McmetaAnimationFrame> {
	if (typeof raw !== "string" || raw === "") {
		throw invalidArgument(`--frames must be a JSON array, got "${raw}".`, {
			frames: raw,
		});
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw invalidArgument(
			`--frames must be a JSON array of indices and/or {index,time} objects, got "${raw}".`,
			{ frames: raw },
		);
	}
	if (!Array.isArray(parsed)) {
		throw invalidArgument(
			`--frames must be a JSON array of indices and/or {index,time} objects, got "${raw}".`,
			{ frames: raw },
		);
	}
	const out: Array<number | McmetaAnimationFrame> = [];
	for (let position = 0; position < parsed.length; position += 1) {
		const element = parsed[position] as unknown;
		if (typeof element === "number") {
			if (!isNonNegativeInt(element)) {
				throw invalidArgument(
					`--frames entry ${position} must be a non-negative integer, got ${JSON.stringify(element) ?? "missing"}.`,
					{ frames: raw, position, value: element },
				);
			}
			out.push(element);
			continue;
		}
		if (!isRecord(element)) {
			throw invalidArgument(
				`--frames entry ${position} must be an index or an {index,time} object.`,
				{ frames: raw, position, value: element },
			);
		}
		const index = element.index;
		if (!isNonNegativeInt(index)) {
			throw invalidArgument(
				`--frames entry ${position}.index must be a non-negative integer.`,
				{ frames: raw, position, index },
			);
		}
		const time = element.time;
		if (time !== undefined && !isPositiveInt(time)) {
			throw invalidArgument(
				`--frames entry ${position}.time must be a positive integer when present.`,
				{ frames: raw, position, time },
			);
		}
		out.push(time === undefined ? { index } : { index, time });
	}
	return out;
}

/** Parse `--border`: digits mean four equal sides, otherwise a JSON object. */
export function parseBorderOption(raw: string): number | NineSliceBorder {
	if (typeof raw !== "string" || raw === "") {
		throw invalidArgument(
			`--border must be digits or a JSON object, got "${raw}".`,
			{ border: raw },
		);
	}
	if (/^[0-9]+$/.test(raw)) {
		const parsed = Number(raw);
		if (!Number.isSafeInteger(parsed)) {
			throw invalidArgument(
				`--border must be digits or a JSON object, got "${raw}".`,
				{ border: raw },
			);
		}
		return parsed;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw invalidArgument(
			`--border must be digits or a JSON object with left, top, right, bottom, got "${raw}".`,
			{ border: raw },
		);
	}
	if (!isRecord(parsed)) {
		throw invalidArgument(
			`--border must be digits or a JSON object with left, top, right, bottom, got "${raw}".`,
			{ border: raw },
		);
	}
	for (const side of ["left", "top", "right", "bottom"] as const) {
		if (!isNonNegativeInt(parsed[side])) {
			throw invalidArgument(
				`--border.${side} must be a non-negative integer.`,
				{ border: raw, [side]: parsed[side] },
			);
		}
	}
	return {
		left: parsed.left as number,
		top: parsed.top as number,
		right: parsed.right as number,
		bottom: parsed.bottom as number,
	};
}

/** Parse a CLI positive integer such as `--frametime`; `name` labels errors. */
export function parsePositiveIntOption(raw: string, name: string): number {
	if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) {
		throw invalidArgument(`${name} must be a positive integer, got "${raw}".`, {
			[name]: raw,
		});
	}
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw invalidArgument(`${name} must be a positive integer, got "${raw}".`, {
			[name]: raw,
		});
	}
	return parsed;
}

function normalizeBorderInput(
	border: number | NineSliceBorder,
): NineSliceBorder {
	if (typeof border === "number") {
		if (!isNonNegativeInt(border)) {
			throw invalidArgument(
				"nine_slice border must be a non-negative integer or a per-side object.",
				{ border },
			);
		}
		return { left: border, top: border, right: border, bottom: border };
	}
	if (!isRecord(border)) {
		throw invalidArgument(
			"nine_slice border must be a non-negative integer or a per-side object.",
			{ border },
		);
	}
	for (const side of ["left", "top", "right", "bottom"] as const) {
		if (!isNonNegativeInt((border as Record<string, unknown>)[side])) {
			throw invalidArgument(
				`nine_slice border.${side} must be a non-negative integer.`,
				{ border },
			);
		}
	}
	const record = border as Record<string, unknown>;
	return {
		left: record.left as number,
		top: record.top as number,
		right: record.right as number,
		bottom: record.bottom as number,
	};
}

export function generateAnimationMcmeta(
	input: GenerateAnimationInput,
): McmetaGenerateResult {
	const frametime = input.frametime ?? 1;
	if (!isPositiveInt(frametime)) {
		throw invalidArgument("frametime must be a positive integer.", {
			frametime: input.frametime,
		});
	}
	if (
		input.interpolate !== undefined &&
		typeof input.interpolate !== "boolean"
	) {
		throw invalidArgument("interpolate must be a boolean when present.", {
			interpolate: input.interpolate,
		});
	}
	if (input.preset !== undefined && input.frames !== undefined) {
		throw new McAssetError(
			"ARGUMENT_CONFLICT",
			"A timeline preset and an explicit frames list are exclusive.",
			{ preset: input.preset, path: "animation.frames" },
		);
	}
	if (input.frames !== undefined) {
		if (!Array.isArray(input.frames) || input.frames.length === 0) {
			throw invalidArgument("frames must be a non-empty list when present.", {
				frames: input.frames,
			});
		}
		for (let position = 0; position < input.frames.length; position += 1) {
			const entry = input.frames[position] as unknown;
			if (typeof entry === "number") {
				continue;
			}
			if (!isRecord(entry)) {
				throw new McAssetError(
					"INVALID_ANIMATION_FRAME",
					`Animation frame ${position} must be an index or an {index,time} object.`,
					{ path: `animation.frames[${position}]`, frame: entry },
				);
			}
			const time = (entry as Record<string, unknown>).time;
			if (time !== undefined && !isPositiveInt(time)) {
				throw invalidArgument(
					`animation.frames[${position}].time must be a positive integer when present.`,
					{ path: `animation.frames[${position}].time`, time },
				);
			}
		}
	}
	const size = parseFrameSize(input.frameSize);
	const geometry = deriveAnimationGeometry(
		input.sheetWidth,
		input.sheetHeight,
		{
			present: true,
			frames: [],
			hasExplicitFrames: false,
			width: size.width,
			height: size.height,
		},
	);
	const frameCount = geometry.frameCount;
	let frames: Array<number | McmetaAnimationFrame>;
	if (input.preset !== undefined) {
		frames = expandTimelinePreset({
			preset: input.preset,
			frameCount,
			frametime,
			holdTicks: input.holdTicks ?? 100,
		});
	} else if (input.frames === undefined) {
		frames = [];
		for (let index = 0; index < frameCount; index += 1) {
			frames.push(index);
		}
	} else {
		frames = input.frames.map((entry) => {
			if (typeof entry === "number") {
				return entry;
			}
			const record = entry as McmetaAnimationFrame;
			return record.time === undefined
				? { index: record.index }
				: { index: record.index, time: record.time };
		});
		const normalized = frames.map((entry) =>
			typeof entry === "number" ? { index: entry } : { index: entry.index },
		);
		checkAnimationFrameIndices(
			{ present: true, frames: normalized, hasExplicitFrames: true },
			frameCount,
		);
	}
	const animation: Record<string, unknown> = {
		width: size.width,
		height: size.height,
		frametime,
	};
	if (input.interpolate === true) {
		animation.interpolate = true;
	}
	animation.frames = frames;
	return {
		text: `${JSON.stringify({ animation })}\n`,
	};
}

export function generateGuiMcmeta(
	input: GenerateGuiInput,
): McmetaGenerateResult {
	if (
		input.type !== "stretch" &&
		input.type !== "tile" &&
		input.type !== "nine_slice"
	) {
		throw invalidArgument(
			'gui type must be one of "stretch", "tile", "nine_slice".',
			{ type: input.type },
		);
	}
	if (input.type !== "nine_slice") {
		if (input.border !== undefined || input.stretchInner !== undefined) {
			throw invalidArgument(
				`gui ${input.type} does not take border or stretchInner.`,
				{
					type: input.type,
					...(input.border !== undefined ? { border: input.border } : {}),
					...(input.stretchInner !== undefined
						? { stretchInner: input.stretchInner }
						: {}),
				},
			);
		}
		if (
			input.stretchInner !== undefined &&
			typeof input.stretchInner !== "boolean"
		) {
			throw invalidArgument("stretchInner must be a boolean when present.", {
				stretchInner: input.stretchInner,
			});
		}
	} else {
		if (input.border === undefined) {
			throw invalidArgument("nine_slice scaling needs a border.", {
				type: input.type,
			});
		}
		if (
			input.stretchInner !== undefined &&
			typeof input.stretchInner !== "boolean"
		) {
			throw invalidArgument("stretchInner must be a boolean when present.", {
				stretchInner: input.stretchInner,
			});
		}
		const border = normalizeBorderInput(input.border);
		const overflow = nineSliceGeometryError(
			input.sheetWidth,
			input.sheetHeight,
			border,
		);
		if (overflow !== undefined) {
			throw new McAssetError("INVALID_MCMETA", overflow, {
				width: input.sheetWidth,
				height: input.sheetHeight,
				border,
			});
		}
		const scaling: Record<string, unknown> = {
			type: input.type,
			width: input.sheetWidth,
			height: input.sheetHeight,
			border: {
				left: border.left,
				top: border.top,
				right: border.right,
				bottom: border.bottom,
			},
		};
		if (input.stretchInner === true) {
			scaling.stretch_inner = true;
		}
		return {
			text: `${JSON.stringify({ gui: { scaling } })}\n`,
		};
	}
	const scaling: Record<string, unknown> = { type: input.type };
	if (input.type === "tile") {
		scaling.width = input.sheetWidth;
		scaling.height = input.sheetHeight;
	}
	return {
		text: `${JSON.stringify({ gui: { scaling } })}\n`,
	};
}
