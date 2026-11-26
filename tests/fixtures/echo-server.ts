import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1.0.0" });
server.registerTool("echo", { description: "Echo text back. Second sentence.", inputSchema: { text: z.string(), times: z.number().optional() } }, async ({ text, times }) => ({
  content: [{ type: "text", text: JSON.stringify({ echoed: text.repeat(times ?? 1) }) }],
}));
server.registerTool("fail", { description: "Always fails", inputSchema: {} }, async () => ({
  content: [{ type: "text", text: "boom" }],
  isError: true,
}));
await server.connect(new StdioServerTransport());
