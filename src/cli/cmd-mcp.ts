import { runMcpServer } from "../mcp/server.ts";

/**
 * `mc-asset mcp`: start the stdio MCP server. This command declares no
 * file flags: everything travels through tool calls on stdin/stdout.
 */
export async function runMcp(): Promise<number> {
	return runMcpServer();
}
