import { addLayer, createCanvas, replaceLayerPixels } from "./canvas.ts";
import { McAssetError } from "./errors.ts";
import {
	FONT_ADVANCE,
	FONT_HEIGHT,
	FONT_WIDTH,
	glyphFor,
} from "./pixel-font.ts";
import type { PixelCanvas, RGBA } from "./types.ts";

/**
 * Contact-sheet layout: a grid of scaled images, each with a label band
 * below it. Labels use the original 5x7 pixel font; every page stays
 * within 1024x1024 and paging splits the input order across pages.
 */

export type ContactSheetBackground = "dark" | "light";
export type ContactSheetPairMode = "none" | "sequential";

export interface ContactSheetOptions {
	readonly inputs: readonly PixelCanvas[];
	readonly names: readonly string[];
	readonly columns?: number | undefined;
	readonly scale?: number | undefined;
	readonly background?: ContactSheetBackground | undefined;
	readonly pairMode?: ContactSheetPairMode | undefined;
}

export interface ContactSheetPage {
	readonly canvas: PixelCanvas;
	readonly labelFallbacks: number;
}

export interface ContactSheetReport {
	readonly pages: readonly ContactSheetPage[];
	readonly pageCount: number;
	readonly labelFallbacks: number;
}

const DARK_BG: RGBA = { r: 0x37, g: 0x37, b: 0x37, a: 255 };
const DARK_FG: RGBA = { r: 0xc6, g: 0xc6, b: 0xc6, a: 255 };
const LIGHT_BG: RGBA = { r: 0xc6, g: 0xc6, b: 0xc6, a: 255 };
const LIGHT_FG: RGBA = { r: 0x37, g: 0x37, b: 0x37, a: 255 };

const MAX_PAGE_DIMENSION = 1024;
const DEFAULT_COLUMNS = 8;
const DEFAULT_SCALE = 2;
const LABEL_HEIGHT_UNSCALED = 8;

interface CellItem {
	readonly leftCanvas: PixelCanvas;
	readonly rightCanvas?: PixelCanvas | undefined;
	readonly label: string;
}

function stripExtension(filename: string): string {
	const lastSlash = Math.max(
		filename.lastIndexOf("/"),
		filename.lastIndexOf("\\"),
	);
	const base = lastSlash >= 0 ? filename.slice(lastSlash + 1) : filename;
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(0, dot) : base;
}

/** Paint an integer-scaled pixel block onto target pixels buffer. */
function paintBlock(
	pixels: Uint8Array,
	canvasWidth: number,
	canvasHeight: number,
	startX: number,
	startY: number,
	size: number,
	color: RGBA,
): void {
	if (color.a === 0) {
		return;
	}
	for (let dy = 0; dy < size; dy += 1) {
		const y = startY + dy;
		if (y < 0 || y >= canvasHeight) continue;
		for (let dx = 0; dx < size; dx += 1) {
			const x = startX + dx;
			if (x < 0 || x >= canvasWidth) continue;
			const offset = (y * canvasWidth + x) * 4;
			if (color.a === 255) {
				pixels[offset] = color.r;
				pixels[offset + 1] = color.g;
				pixels[offset + 2] = color.b;
				pixels[offset + 3] = 255;
			} else {
				const srcA = color.a;
				const invA = 255 - srcA;
				const dstR = pixels[offset] as number;
				const dstG = pixels[offset + 1] as number;
				const dstB = pixels[offset + 2] as number;
				pixels[offset] = Math.round((color.r * srcA + dstR * invA) / 255);
				pixels[offset + 1] = Math.round((color.g * srcA + dstG * invA) / 255);
				pixels[offset + 2] = Math.round((color.b * srcA + dstB * invA) / 255);
				pixels[offset + 3] = 255;
			}
		}
	}
}

/** Composite a scaled canvas onto the sheet buffer at (cellX, cellY). */
function drawScaledCanvas(
	targetPixels: Uint8Array,
	targetWidth: number,
	targetHeight: number,
	source: PixelCanvas,
	startX: number,
	startY: number,
	scale: number,
): void {
	const sourcePixels = source.layers[0]?.pixels;
	if (sourcePixels === undefined) {
		return;
	}
	for (let sy = 0; sy < source.height; sy += 1) {
		for (let sx = 0; sx < source.width; sx += 1) {
			const sOffset = (sy * source.width + sx) * 4;
			const r = sourcePixels[sOffset] as number;
			const g = sourcePixels[sOffset + 1] as number;
			const b = sourcePixels[sOffset + 2] as number;
			const a = sourcePixels[sOffset + 3] as number;
			paintBlock(
				targetPixels,
				targetWidth,
				targetHeight,
				startX + sx * scale,
				startY + sy * scale,
				scale,
				{ r, g, b, a },
			);
		}
	}
}

/** Draw a single glyph with pixel font, recording fallbacks. */
function drawGlyph(
	targetPixels: Uint8Array,
	targetWidth: number,
	targetHeight: number,
	char: string,
	startX: number,
	startY: number,
	scale: number,
	fgColor: RGBA,
): boolean {
	const { rows, fallback } = glyphFor(char);
	for (let r = 0; r < FONT_HEIGHT; r += 1) {
		const rowByte = rows[r] as number;
		for (let c = 0; c < FONT_WIDTH; c += 1) {
			const bit = (rowByte >> (4 - c)) & 1;
			if (bit === 1) {
				paintBlock(
					targetPixels,
					targetWidth,
					targetHeight,
					startX + c * scale,
					startY + r * scale,
					scale,
					fgColor,
				);
			}
		}
	}
	return fallback;
}

/** Build contact-sheet pages from in-memory canvases. */
export function buildContactSheet(
	options: ContactSheetOptions,
): ContactSheetReport {
	const { inputs, names } = options;
	if (inputs.length === 0) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"contact-sheet requires at least one input.",
		);
	}
	if (inputs.length > 256) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			"contact-sheet accepts at most 256 inputs.",
		);
	}
	const columns = options.columns ?? DEFAULT_COLUMNS;
	if (!Number.isInteger(columns) || columns < 1 || columns > 16) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`columns must be an integer between 1 and 16, got ${columns}.`,
			{ columns },
		);
	}
	const scale = options.scale ?? DEFAULT_SCALE;
	if (!Number.isInteger(scale) || scale < 1) {
		throw new McAssetError(
			"INVALID_ARGUMENT",
			`scale must be a positive integer, got ${scale}.`,
			{ scale },
		);
	}
	const isLight = options.background === "light";
	const bgColor = isLight ? LIGHT_BG : DARK_BG;
	const fgColor = isLight ? LIGHT_FG : DARK_FG;
	const pairMode = options.pairMode ?? "none";

	// Group inputs into cells
	const cells: CellItem[] = [];
	if (pairMode === "sequential") {
		for (let i = 0; i < inputs.length; i += 2) {
			const left = inputs[i] as PixelCanvas;
			const right = inputs[i + 1];
			const leftStem = stripExtension(names[i] ?? "");
			const rightStem =
				right !== undefined ? stripExtension(names[i + 1] ?? "") : "";
			const label =
				right !== undefined ? `${leftStem} / ${rightStem}` : leftStem;
			cells.push({
				leftCanvas: left,
				rightCanvas: right,
				label,
			});
		}
	} else {
		for (let i = 0; i < inputs.length; i += 1) {
			cells.push({
				leftCanvas: inputs[i] as PixelCanvas,
				label: stripExtension(names[i] ?? ""),
			});
		}
	}

	// Determine max dimensions across all inputs
	let maxImageWidth = 1;
	let maxImageHeight = 1;
	for (const input of inputs) {
		if (input.width > maxImageWidth) maxImageWidth = input.width;
		if (input.height > maxImageHeight) maxImageHeight = input.height;
	}

	const cellImageWidth =
		pairMode === "sequential"
			? maxImageWidth * 2 * scale
			: maxImageWidth * scale;
	const cellImageHeight = maxImageHeight * scale;
	const labelBandHeight = LABEL_HEIGHT_UNSCALED * scale;
	const cellWidth = cellImageWidth;
	const cellHeight = cellImageHeight + labelBandHeight;

	const colsPerPage = Math.max(
		1,
		Math.min(columns, Math.floor(MAX_PAGE_DIMENSION / cellWidth)),
	);
	const rowsPerPage = Math.max(1, Math.floor(MAX_PAGE_DIMENSION / cellHeight));
	const maxCellsPerPage = colsPerPage * rowsPerPage;

	const pages: ContactSheetPage[] = [];
	let totalLabelFallbacks = 0;

	for (let offset = 0; offset < cells.length; offset += maxCellsPerPage) {
		const chunk = cells.slice(offset, offset + maxCellsPerPage);
		const pageCols = Math.min(chunk.length, colsPerPage);
		const pageRows = Math.ceil(chunk.length / pageCols);
		const canvasWidth = pageCols * cellWidth;
		const canvasHeight = pageRows * cellHeight;

		const pageCanvas = createCanvas(canvasWidth, canvasHeight);
		const layer = addLayer(pageCanvas, { id: "base" });
		const pixels = new Uint8Array(canvasWidth * canvasHeight * 4);
		// Fill background
		for (let p = 0; p < canvasWidth * canvasHeight; p += 1) {
			pixels[p * 4] = bgColor.r;
			pixels[p * 4 + 1] = bgColor.g;
			pixels[p * 4 + 2] = bgColor.b;
			pixels[p * 4 + 3] = bgColor.a;
		}

		let pageFallbacks = 0;

		for (let idx = 0; idx < chunk.length; idx += 1) {
			const cell = chunk[idx] as CellItem;
			const col = idx % pageCols;
			const row = Math.floor(idx / pageCols);
			const cellX = col * cellWidth;
			const cellY = row * cellHeight;

			// Draw image(s)
			if (cell.rightCanvas !== undefined) {
				drawScaledCanvas(
					pixels,
					canvasWidth,
					canvasHeight,
					cell.leftCanvas,
					cellX,
					cellY,
					scale,
				);
				drawScaledCanvas(
					pixels,
					canvasWidth,
					canvasHeight,
					cell.rightCanvas,
					cellX + maxImageWidth * scale,
					cellY,
					scale,
				);
			} else {
				drawScaledCanvas(
					pixels,
					canvasWidth,
					canvasHeight,
					cell.leftCanvas,
					cellX,
					cellY,
					scale,
				);
			}

			// Count fallbacks over the whole stem before truncation
			for (let c = 0; c < cell.label.length; c += 1) {
				const { fallback } = glyphFor(cell.label[c] as string);
				if (fallback) {
					pageFallbacks += 1;
				}
			}

			// Render label
			const labelY = cellY + cellImageHeight;
			const maxChars = Math.floor(cellWidth / (FONT_ADVANCE * scale));
			let labelText = cell.label;
			if (labelText.length > maxChars) {
				if (maxChars >= 3) {
					labelText = `${labelText.slice(0, maxChars - 3)}...`;
				} else {
					labelText = "...".slice(0, maxChars);
				}
			}

			for (let c = 0; c < labelText.length; c += 1) {
				const char = labelText[c] as string;
				const charX = cellX + c * FONT_ADVANCE * scale;
				drawGlyph(
					pixels,
					canvasWidth,
					canvasHeight,
					char,
					charX,
					labelY,
					scale,
					fgColor,
				);
			}
		}

		replaceLayerPixels(pageCanvas, layer.id, pixels);
		pages.push({ canvas: pageCanvas, labelFallbacks: pageFallbacks });
		totalLabelFallbacks += pageFallbacks;
	}

	return {
		pages,
		pageCount: pages.length,
		labelFallbacks: totalLabelFallbacks,
	};
}
