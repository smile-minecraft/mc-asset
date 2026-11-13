import packageJson from "../package.json" with { type: "json" };

/**
 * Reject a package.json without a usable version instead of recording a blank
 * or stale one.
 */
export function requirePackageVersion(value: unknown): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error("mc-asset: package.json must declare a non-empty version");
	}
	return value;
}

/**
 * Single version source: package.json. The JSON import is inlined by the
 * bundler, so source runs, `dist/` bundles, and installed builds all report
 * the version that was packaged.
 */
export const VERSION: string = requirePackageVersion(packageJson.version);
