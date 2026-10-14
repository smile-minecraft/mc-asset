import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED_TOOLS = [
	"analyze_asset",
	"pixelize_asset",
	"render_pixel_asset",
	"apply_asset_operations",
	"recolor_asset",
	"create_variants",
	"validate_asset",
	"import_asset",
	"build_asset",
	"transform_asset",
	"quantize_asset",
	"cleanup_asset",
	"palette_asset",
	"material_asset",
	"tile_asset",
	"generate_asset",
	"preview_asset",
	"animate_asset",
	"validate_pack_asset",
	"scale_gui_asset",
	"inspect_asset",
] as const;

let client: Client | undefined;

afterEach(async () => {
	if (client !== undefined) {
		const current = client;
		client = undefined;
		await current.close().catch(() => undefined);
	}
});

describe("mcp handshake", () => {
	test("initialize succeeds and tools/list exposes the twenty-three tools preserving the original prefix", async () => {
		const transport = new StdioClientTransport({
			command: "bun",
			args: ["src/cli/index.ts", "mcp"],
		});
		client = new Client({ name: "mc-asset-test", version: "0.0.0" });
		await client.connect(transport);
		const listed = await client.listTools();
		const names = listed.tools.map((tool) => tool.name).sort();
		expect(listed.tools.map((tool) => tool.name).slice(0, 21)).toEqual([
			...EXPECTED_TOOLS,
		]);
		expect(names).toEqual(
			[...EXPECTED_TOOLS, "optimize_asset", "model_asset"].sort(),
		);
		expect(listed.tools).toHaveLength(23);
		for (const tool of listed.tools) {
			expect(typeof tool.description).toBe("string");
			expect(tool.description ?? "").not.toBe("");
			const schema = tool.inputSchema as unknown as Record<string, unknown>;
			expect(schema.type).toBe("object");
		}
	}, 30_000);
});
