import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePixelizeAsset } from "../../src/mcp/handlers.ts";

/**
 * MCP output-guard messages must not carry CLI-only flag hints: the MCP
 * surface has no --force/--mkdir flags, so those sentences are unactionable
 * there. Codes and the {"code","message"} shape stay frozen; only the hint
 * clauses go. The CLI keeps its hints (see tests/cli/cli.test.ts).
 */

const PNG_8X8 = join("tests", "cli", "fixtures", "px-8x8.png");

function messageOf(result: {
	content: Array<{ type: string; text?: string }>;
}): { code: unknown; message: string } {
	const text = result.content[0]?.text ?? "{}";
	const json = JSON.parse(text) as { code?: unknown; message?: unknown };
	return { code: json.code, message: String(json.message ?? "") };
}

describe("mcp output-guard messages carry no CLI flag hints", () => {
	test("OUTPUT_EXISTS mentions no --force/--mkdir flag", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcp-msg-"));
		try {
			const existing = join(dir, "taken.png");
			await writeFile(existing, "taken", "utf-8");
			const result = await handlePixelizeAsset({
				inputPath: PNG_8X8,
				size: "16",
				outputPngPath: existing,
			});
			expect(result.isError).toBe(true);
			const { code, message } = messageOf(result);
			expect(code).toBe("OUTPUT_EXISTS");
			expect(message).not.toContain("--force");
			expect(message).not.toContain("--mkdir");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("FILESYSTEM_ERROR for a missing parent mentions no --mkdir/--force flag", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mc-asset-mcp-msg-"));
		try {
			const missing = join(dir, "no-such-dir", "out.png");
			const result = await handlePixelizeAsset({
				inputPath: PNG_8X8,
				size: "16",
				outputPngPath: missing,
			});
			expect(result.isError).toBe(true);
			const { code, message } = messageOf(result);
			expect(code).toBe("FILESYSTEM_ERROR");
			expect(message).not.toContain("--mkdir");
			expect(message).not.toContain("--force");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
