/**
 * Integer color math for the palette library: the strict `#RRGGBB` form,
 * the §8.2 integer HSL pair, and the §3.4 channel conversion that moves a
 * color to a new lightness and saturation while keeping its hue. Every
 * operation truncates integer divisions toward zero and never touches a
 * floating-point transcendental, so Bun and Node agree byte for byte.
 */

export interface RgbColor {
	readonly r: number;
	readonly g: number;
	readonly b: number;
}

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

/** Whether a value is the `#RRGGBB` shape a ramp role accepts. */
export function isHexColor(value: unknown): value is string {
	return typeof value === "string" && HEX_COLOR.test(value);
}

/** Parse a validated `#RRGGBB` string into channels. */
export function parseHexColor(value: string): RgbColor {
	return {
		r: Number.parseInt(value.slice(1, 3), 16),
		g: Number.parseInt(value.slice(3, 5), 16),
		b: Number.parseInt(value.slice(5, 7), 16),
	};
}

const HEX_DIGITS = "0123456789ABCDEF";

/** Uppercase `#RRGGBB`; the only form the ramp constants and files use. */
export function formatHexColor(color: RgbColor): string {
	const byte = (value: number): string =>
		`${HEX_DIGITS[(value >> 4) & 15]}${HEX_DIGITS[value & 15]}`;
	return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`;
}

/** Truncating integer division; negative quotients round toward zero. */
export function truncatedDiv(dividend: number, divisor: number): number {
	return Math.trunc(dividend / divisor);
}

/** Clamp a channel or lightness into `0..255`. */
export function clamp255(value: number): number {
	if (value < 0) return 0;
	if (value > 255) return 255;
	return value;
}

export interface Hsl255 {
	/** HSL lightness `(max + min) / 2`, 0..255. */
	readonly lightness: number;
	/** HSL saturation, 0..255. */
	readonly saturation: number;
	/** `max - min`, the divisor of the §3.4 channel conversion. */
	readonly delta: number;
}

/** §8.2 integer HSL: only the lightness, saturation, and delta are needed. */
export function hsl255(color: RgbColor): Hsl255 {
	const max = Math.max(color.r, color.g, color.b);
	const min = Math.min(color.r, color.g, color.b);
	const delta = max - min;
	const lightness = truncatedDiv(max + min, 2);
	const saturation =
		delta === 0
			? 0
			: Math.min(
					255,
					truncatedDiv(delta * 255, 255 - Math.abs(2 * lightness - 255)),
				);
	return { lightness, saturation, delta };
}

/**
 * §3.4 rule 8: the completion conversion. `source` supplies the hue through
 * its channels, `targetLightness`/`targetSaturation` the new HSL pair. A
 * neutral source (delta 0) has no hue to keep, so every channel becomes the
 * target lightness.
 */
export function withLightnessSaturation(
	source: RgbColor,
	targetLightness: number,
	targetSaturation: number,
): RgbColor {
	const { lightness, delta } = hsl255(source);
	if (delta === 0) {
		return {
			r: targetLightness,
			g: targetLightness,
			b: targetLightness,
		};
	}
	const targetDelta = truncatedDiv(
		targetSaturation * (255 - Math.abs(2 * targetLightness - 255)),
		255,
	);
	const channel = (value: number): number =>
		clamp255(
			targetLightness + truncatedDiv((value - lightness) * targetDelta, delta),
		);
	return {
		r: channel(source.r),
		g: channel(source.g),
		b: channel(source.b),
	};
}
