/**
 * The public `pack build` resource budgets (see `docs/cli-surface.md`).
 *
 * Planning reads every source before the first write, so the same three
 * budgets bound a dry run and a real build: planned outputs, source file
 * bytes, and decoded source pixels. Generator-backed steps read their own
 * inputs, so they are charged against the same budgets as recipe sources.
 */
export const PACK_BUILD_MAX_OUTPUTS = 4096;
export const PACK_BUILD_MAX_SOURCE_BYTES = 268435456; // 256 MiB
export const PACK_BUILD_MAX_DECODED_PIXELS = 16777216; // 16,777,216 pixels
