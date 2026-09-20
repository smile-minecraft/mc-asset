import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION } from "../index.ts";
import { MCP_TOOLS } from "./tools.ts";

export const MCP_SERVER_NAME = "mc-asset";

/**
 * Build the stdio MCP server: it hangs the frozen tool surface directly
 * off Core (no reimplemented image logic). Handlers are placeholders in
 * this step: every call answers with an error naming the tool, and the
 * real Core wiring lands in the next step.
 */
export function createMcpServer(): McpServer {
	const server = new McpServer({ name: MCP_SERVER_NAME, version: VERSION });
	for (const tool of MCP_TOOLS) {
		const toolName = tool.name;
		server.registerTool(
			toolName,
			{
				description: tool.description,
				inputSchema: tool.inputSchema,
			},
			async () => ({
				content: [
					{
						type: "text" as const,
						text: `Tool '${toolName}' is not implemented yet: the handler lands in the next step.`,
					},
				],
				isError: true,
			}),
		);
	}
	return server;
}

/**
 * Serve MCP over stdio: stdout carries only MCP JSON-RPC, diagnostics go
 * to stderr, and the process ends when stdin closes. Uses only node:
 * imports on this path, so the bundled dist runs under plain Node.
 */
export async function runMcpServer(): Promise<number> {
	try {
		const server = createMcpServer();
		await server.connect(new StdioServerTransport());
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(
			`error [INTERNAL_ERROR] mcp server failed: ${message}\n`,
		);
		return 1;
	}
}
