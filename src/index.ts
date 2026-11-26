#!/usr/bin/env node
// code-mode-mcp: one MCP tool, `run_script`, that runs model-written JavaScript against a small
// API (files, grep, shell, other MCP servers). Many tool calls become one script; only the
// returned value reaches the model. Works with any MCP client. No sandbox: local use only.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { loadConfig, loadServers, resolveLayers } from "./layers.ts";
import { createMcp } from "./mcp.ts";
import { createRuntime, scriptSig } from "./runtime.ts";

const VERSION: string = pkg.version;

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

// A script can leave a promise floating; once its run is cancelled that promise rejects. Log it, never crash.
process.on("unhandledRejection", (e) => console.error(`code-mode: unhandled rejection: ${e}`));

const { layers, home, project } = resolveLayers();
const config = loadConfig(layers);
const serverCfgs = loadServers(layers);
const { mcp, closeAll } = createMcp(serverCfgs, { version: VERSION });
const rt = await createRuntime({ layers, home, project, config, mcp });

const cli = process.argv[2];
if (cli === "eval" || cli === "run" || cli === "scripts") {
  // code-mode-mcp eval '<js>' | code-mode-mcp run <script> ['{"json":"args"}'] | code-mode-mcp scripts
  let text: string;
  let failed = false;
  if (cli === "scripts") {
    text = [...rt.loadScripts().values()].map((s) => `${scriptSig(s)}\n    ${s.file}`).join("\n") || "(no saved scripts)";
  } else {
    const body = cli === "run" ? `return await scripts.run(${JSON.stringify(process.argv[3])}, args);` : (process.argv[3] ?? "return 1");
    const r = await rt.run(body, cli === "run" ? 600_000 : 120_000, cli === "run" ? JSON.parse(process.argv[4] ?? "{}") : {});
    text = r.text;
    failed = r.isError;
  }
  console.log(text);
  await closeAll();
  process.exit(failed ? 1 : 0);
}

const servers = Object.keys(serverCfgs);
const MCP_LIST = servers.length ? servers.join(", ") : "(none configured)";
const startupScripts = [...rt.loadScripts().values()].map(scriptSig);
// Kept short on purpose: it is paid in every session. Full signatures live behind help() and mcp.docs().
const shortDoc = (d: string) => {
  const [sig, what] = d.split(" // ");
  return `${(sig ?? "").split("(")[0]}${what ? ` (${(what.split(/[;:(]/)[0] ?? "").trim()})` : ""}`;
};

const DESCRIPTION = `Runs JS (async function body, \`return\` the result) in ONE call; only the returned value enters your context. DEFAULT for anything needing 2+ steps: several files/searches, loops, filter/group/count, combining git, files and MCP. Use direct tools only for one read, one edit shown as a diff, or one standalone call. Return only the answer, never raw dumps.
API (all async): fs.read(p,{offset,limit}) fs.write fs.edit(p,old,new) fs.glob(pat) fs.exists; grep(re,{path,glob,filesOnly}) -> [{file,line,text}]; sh(cmd,{cwd,timeout}) -> {code,stdout,stderr}; mcp.<server>.<tool>(args); mcp.docs(server,"kw") -> tool signatures; scripts.run(name,args); help("kw") -> helper/script signatures; config; args; console.log; sleep; path; require.
MCP servers: ${MCP_LIST}.${rt.helperDocs.length ? `\nHelpers: ${rt.helperDocs.map(shortDoc).join("; ")}.` : ""}${startupScripts.length ? `\nSaved scripts (run_script({script,args})): ${startupScripts.map(shortDoc).join("; ")}.` : ""}
Repeated action or user asks to save one -> save_script; keep specifics in args/config.`;

const INSTRUCTIONS = `Prefer run_script over chains of separate file, search, shell or MCP tool calls: 2+ steps go in ONE script that returns only the answer. MCP servers reachable through it: ${MCP_LIST}.`;

const server = new McpServer({ name: "code-mode", version: VERSION }, { instructions: INSTRUCTIONS });

server.registerTool(
  "run_script",
  {
    description: DESCRIPTION,
    // Clients that support it load this tool upfront instead of behind a tool search; others ignore it.
    _meta: { "anthropic/alwaysLoad": true },
    inputSchema: {
      code: z.string().optional().describe("Body of an async JS function. Use `return` for the result."),
      script: z.string().optional().describe("Name of a saved script to run instead of code"),
      args: z.record(z.string(), z.any()).optional().describe("Arguments for the saved script (also `args` inside code)"),
      timeout_ms: z.number().int().positive().max(600_000).optional().describe("Default 120000. On timeout the script is cancelled and its processes killed."),
    },
  },
  async ({ code, script, args, timeout_ms }) => {
    if (!code === !script) return { content: [{ type: "text", text: "pass exactly one of code or script" }], isError: true };
    const body = script ? `return await scripts.run(${JSON.stringify(script)}, args);` : (code ?? "");
    const { text, isError } = await rt.run(body, timeout_ms ?? 120_000, args ?? {});
    return { content: [{ type: "text", text }], isError };
  },
);

server.registerTool(
  "save_script",
  {
    description:
      "Save a run_script action by name to reuse with run_script({script,args}). Generic: specifics from args or config, never hardcoded. scope global (default) or project (.code-mode/).",
    inputSchema: {
      name: z.string().describe("kebab or camel case, e.g. stack-status"),
      description: z.string().describe("One line: what it does and returns"),
      params: z
        .array(z.object({ name: z.string(), type: z.string(), optional: z.boolean().optional(), description: z.string().optional() }))
        .optional(),
      code: z.string().describe("Async function body; reads `args`; uses `return`"),
      scope: z.enum(["global", "project"]).optional(),
      overwrite: z.boolean().optional(),
    },
  },
  async (o) => {
    try {
      return { content: [{ type: "text", text: `saved ${rt.saveScript(o)}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true };
    }
  },
);

await server.connect(new StdioServerTransport());
