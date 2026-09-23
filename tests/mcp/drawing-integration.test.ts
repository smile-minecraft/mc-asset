import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Drawing primitives over the generic batch tool: ellipse, polygonFill,
 * and strokeMask travel through `apply_asset_operations` with the frozen
 * input shape (no new tool, no schema change). Success paths assert the
 * shared per-operation report; failure paths assert the frozen shape
 * error codes; the feedback path asserts the diff summary tracks the
 * new write scopes.
 *
 * Fixture: tests/cli/fixtures/sword.mcpx (self-made 4x4 pattern).
 */

const FIXTURES = "tests/cli/fixtures";
const SWORD_MCPX = join(FIXTURES, "sword.mcpx");

let client: Client | undefined;

afterEach(async () => {
	if (client !== undefined) {
		const current = client;
		client = undefined;
		await current.close().catch(() => undefined);
	}
});

async function connect(): Promise<Client> {
	const transport = new StdioClientTransport({
		command: "bun",
		args: ["src/cli/index.ts", "mcp"],
	});
	const next = new Client({ name: "mc-asset-drawing-test", version: "0.0.0" });
	await next.connect(transport);
	client = next;
	return next;
}

interface ToolCall {
	isError: boolean;
	text: string;
	json: Record<string, unknown> | undefined;
}

async function callTool(
	connected: Client,
	name: string,
	args: Record<string, unknown>,
): Promise<ToolCall> {
	const result = await connected.callTool({ name, arguments: args });
	const blocks = result.content as Array<{ type: string; text?: string }>;
	const text = blocks[0]?.text ?? "";
	let json: Record<string, unknown> | undefined;
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		json = undefined;
	}
	return { isError: result.isError === true, text, json };
}

describe("mcp drawing primitives over stdio", () => {
	test("apply_asset_operations runs ellipse polygonFill and strokeMask", async () => {
		const connected = await connect();
		const result = await callTool(connected, "apply_asset_operations", {
			sourcePath: SWORD_MCPX,
			operations: [
				{
					type: "ellipse",
					layerId: "base",
					rect: { x: 0, y: 0, width: 4, height: 4 },
					color: "#FF0000FF",
					mode: "outline",
				},
				{
					type: "polygonFill",
					layerId: "base",
					points: [
						[0, 0],
						[3, 0],
						[0, 3],
					],
					color: "#00FF00FF",
				},
				{
					type: "strokeMask",
					layerId: "base",
					source: "alpha:base",
					color: "#0000FFFF",
				},
			],
		});
		expect(result.isError).toBe(false);
		expect(result.json?.applied).toBe(3);
		const operations = result.json?.operations as
			| Array<{ status: string }>
			| undefined;
		expect(operations?.length).toBe(3);
		expect(operations?.every((entry) => entry.status === "applied")).toBe(true);
		expect(typeof result.json?.pngBase64).toBe("string");
		expect(typeof result.json?.mcpxText).toBe("string");
	}, 30_000);

	test("apply_asset_operations reports a self-intersecting polygon", async () => {
		const connected = await connect();
		const result = await callTool(connected, "apply_asset_operations", {
			sourcePath: SWORD_MCPX,
			operations: [
				{
					type: "polygonFill",
					layerId: "base",
					points: [
						[0, 0],
						[3, 3],
						[0, 3],
						[3, 0],
					],
					color: "#00FF00FF",
				},
			],
		});
		expect(result.isError).toBe(true);
		expect(result.json?.code).toBe("SELF_INTERSECTING_POLYGON");
	}, 30_000);

	test("apply_asset_operations refuses an oversized polygon before serializing", async () => {
		const connected = await connect();
		const points: Array<[number, number]> = [];
		for (let i = 0; i < 4097; i += 1) {
			points.push([i % 4, ((i / 4) | 0) % 4]);
		}
		const result = await callTool(connected, "apply_asset_operations", {
			sourcePath: SWORD_MCPX,
			operations: [
				{
					type: "polygonFill",
					layerId: "base",
					points,
					color: "#00FF00FF",
				},
			],
		});
		expect(result.isError).toBe(true);
		expect(result.json?.code).toBe("RESOURCE_LIMIT_EXCEEDED");
		const details = result.json?.details as
			| { path?: unknown; count?: unknown; limit?: unknown }
			| undefined;
		expect(details?.path).toBe("operations[0].points");
		expect(details?.count).toBe(4097);
		expect(details?.limit).toBe(4096);
	}, 30_000);

	test("apply with feedback summary tracks the new shape write scopes", async () => {
		const connected = await connect();
		const result = await callTool(connected, "apply_asset_operations", {
			sourcePath: SWORD_MCPX,
			operations: [
				{
					type: "ellipse",
					layerId: "base",
					rect: { x: 0, y: 0, width: 4, height: 2 },
					color: "#FF0000FF",
					mode: "fill",
					selection: "rect:0,0,4,2",
				},
			],
			feedback: { image: "none", diff: "summary" },
		});
		expect(result.isError).toBe(false);
		const feedback = result.json?.feedback as
			| {
					imageIncluded: boolean;
					diff?: { outsideSelectionUnchanged: boolean };
			  }
			| undefined;
		expect(feedback?.imageIncluded).toBe(false);
		expect(feedback?.diff?.outsideSelectionUnchanged).toBe(true);
	}, 30_000);
});
