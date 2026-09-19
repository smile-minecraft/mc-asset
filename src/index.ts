// Toolchain skeleton only. No business logic lives here yet.
import packageJson from "../package.json";

/** Single version source: package.json. The release build inlines this. */
export const VERSION: string = packageJson.version;

export function main(): void {
	// Intentionally empty: later tasks add PixelCanvas / mcpx / PNG / CLI.
}

export * from "./core/index.ts";
