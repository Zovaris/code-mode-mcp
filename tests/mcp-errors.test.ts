import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMcp } from "../src/mcp.ts";
import { tmp } from "./helpers.ts";

describe("mcp errors", () => {
  test("no servers configured says where to add them", async () => {
    const { mcp, closeAll } = createMcp({}, { version: "test", cacheDir: tmp() });
    await expect(mcp.docs("nope")).rejects.toThrow('unknown MCP server "nope". No servers are configured');
    await closeAll();
  });

  test("unknown server lists the configured ones", async () => {
    const { mcp, closeAll } = createMcp({ alpha: { command: "x" } }, { version: "test", cacheDir: tmp() });
    await expect(mcp.docs("beta")).rejects.toThrow('unknown MCP server "beta". Configured: alpha.');
    await closeAll();
  });

  test("a non-string server name explains the call", async () => {
    const { mcp, closeAll } = createMcp({}, { version: "test", cacheDir: tmp() });
    await expect(mcp.docs(undefined as any)).rejects.toThrow("MCP server name must be a string, got undefined");
    await closeAll();
  });

  test("docs cache is not read from a file written under the bare server name", async () => {
    const cacheDir = tmp();
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "alpha.json"), JSON.stringify([{ name: "stale", description: "", inputSchema: {} }]));
    const { mcp, closeAll } = createMcp({ alpha: { command: "code-mode-test-missing-binary" } }, { version: "test", cacheDir });
    await expect(mcp.docs("alpha")).rejects.toThrow();
    await closeAll();
  });
});
