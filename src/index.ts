#!/usr/bin/env bun
// code-mode: one MCP tool, `run_script`, that runs model-written JavaScript against a small
// API (files, grep, shell, other MCP servers). Many tool calls become one script; only the
// returned value reaches the model. Modeled on Cloudflare Code Mode, OpenCode/pi codemode
// and Claude Code's experimental Code Mode. No sandbox: local use only.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import * as pathMod from "node:path";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
const req = createRequire(join(process.cwd(), "noop.js"));

const VERSION = "0.3.0";
const MAX_OUT = Number(process.env.CODE_MODE_MAX_OUTPUT ?? 20000);
const CONFIG = process.env.CODE_MODE_CONFIG ?? join(homedir(), ".config/code-mode/servers.json");

// ---------- MCP proxy ----------
type ServerCfg = { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string; headers?: Record<string, string> };

function loadServers(): Record<string, ServerCfg> {
  if (!existsSync(CONFIG)) return {};
  try {
    const raw = JSON.parse(readFileSync(CONFIG, "utf8"));
    return raw.mcpServers ?? raw;
  } catch (e) {
    console.error(`code-mode: bad config ${CONFIG}: ${e}`);
    return {};
  }
}

const serverCfgs = loadServers();
const clients = new Map<string, Promise<Client>>();

// Secrets stay out of the config: "${cmd:gh auth token}" runs the command, "${env:VAR}" reads env.
function expand(v: string): string {
  return v
    .replace(/\$\{env:([^}]+)\}/g, (_m, k) => process.env[k] ?? "")
    .replace(/\$\{cmd:([^}]+)\}/g, (_m, cmd) => {
      const p = Bun.spawnSync(["/bin/bash", "-lc", cmd]);
      if (p.exitCode !== 0) throw new Error(`config command failed: ${cmd}: ${p.stderr.toString().trim()}`);
      return p.stdout.toString().trim();
    });
}
const expandAll = (o?: Record<string, string>) => o && Object.fromEntries(Object.entries(o).map(([k, v]) => [k, expand(v)]));

function client(name: string): Promise<Client> {
  const cfg = serverCfgs[name];
  if (!cfg) throw new Error(`unknown MCP server "${name}". Known: ${Object.keys(serverCfgs).join(", ") || "(none)"}`);
  let c = clients.get(name);
  if (!c) {
    c = (async () => {
      const cl = new Client({ name: "code-mode", version: VERSION });
      const transport = cfg.url
        ? new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: expandAll(cfg.headers) } })
        : new StdioClientTransport({
            command: cfg.command!,
            args: cfg.args ?? [],
            env: { ...(process.env as Record<string, string>), ...(expandAll(cfg.env) ?? {}) },
            cwd: cfg.cwd,
            stderr: "ignore",
          });
      await cl.connect(transport);
      return cl;
    })();
    c.catch(() => clients.delete(name));
    clients.set(name, c);
  }
  return c;
}

function unwrap(res: any): any {
  if (res?.structuredContent !== undefined) return res.structuredContent;
  const parts = (res?.content ?? []).map((p: any) => (p.type === "text" ? p.text : p));
  const vals = parts.map((p: any) => {
    if (typeof p !== "string") return p;
    try { return JSON.parse(p); } catch { return p; }
  });
  const out = vals.length === 1 ? vals[0] : vals;
  if (res?.isError) throw new Error(typeof out === "string" ? out : JSON.stringify(out));
  return out;
}

const mcpApi: any = {
  servers: () => Object.keys(serverCfgs),
  async tools(server: string, filter?: string) {
    const { tools } = await (await client(server)).listTools();
    const f = filter?.toLowerCase();
    return tools
      .filter((t) => !f || t.name.toLowerCase().includes(f) || (t.description ?? "").toLowerCase().includes(f))
      .map((t) => ({ name: t.name, description: (t.description ?? "").slice(0, 300), input: t.inputSchema }));
  },
  async call(server: string, tool: string, args: Record<string, unknown> = {}) {
    return unwrap(await (await client(server)).callTool({ name: tool, arguments: args }));
  },
  // Compact TS-like signatures, cached on disk so no connection is needed to read them.
  async docs(server: string, filter?: string, opts: { refresh?: boolean } = {}) {
    const file = join(CACHE_DIR, `${server}.json`);
    let tools: CachedTool[] | undefined;
    if (!opts.refresh && existsSync(file)) tools = JSON.parse(readFileSync(file, "utf8"));
    if (!tools) {
      const res = await (await client(server)).listTools();
      tools = res.tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema }));
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(file, JSON.stringify(tools));
    }
    const f = filter?.toLowerCase();
    return tools
      .filter((t) => !f || t.name.toLowerCase().includes(f) || t.description.toLowerCase().includes(f))
      .map((t) => `${t.name}(${sig(t.inputSchema)}) // ${firstLine(t.description)}`)
      .join("\n");
  },
};

type CachedTool = { name: string; description: string; inputSchema: any };
const CACHE_DIR = join(homedir(), ".cache/code-mode");
const firstLine = (s: string) => s.split(/\n|(?<=\.)\s/)[0].slice(0, 100);

function tsType(s: any): string {
  if (!s) return "any";
  if (s.enum) return s.enum.slice(0, 6).map((v: unknown) => JSON.stringify(v)).join("|") + (s.enum.length > 6 ? "|…" : "");
  if (s.anyOf || s.oneOf) return (s.anyOf ?? s.oneOf).map(tsType).filter((t: string) => t !== "null").join("|");
  const t = Array.isArray(s.type) ? s.type.filter((x: string) => x !== "null")[0] : s.type;
  if (t === "array") return `${tsType(s.items)}[]`;
  if (t === "integer") return "number";
  if (t === "object") return s.properties ? `{${sig(s)}}` : "object";
  return t ?? "any";
}

function sig(schema: any): string {
  const props = schema?.properties ?? {};
  const req = new Set<string>(schema?.required ?? []);
  return Object.entries(props)
    .map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${tsType(v)}`)
    .join(", ");
}
const mcp = new Proxy(mcpApi, {
  get(target, server: string) {
    if (server in target) return target[server];
    if (typeof server !== "string" || server === "then") return undefined;
    return new Proxy({}, { get: (_t, tool: string) => (args?: Record<string, unknown>) => mcpApi.call(server, tool, args) });
  },
});

// ---------- local API ----------
const cwd = () => process.cwd();
const abs = (p: string) => resolve(cwd(), p.replace(/^~(?=\/|$)/, homedir()));

const fs = {
  async read(path: string, opts: { offset?: number; limit?: number } = {}) {
    const text = await Bun.file(abs(path)).text();
    if (opts.offset === undefined && opts.limit === undefined) return text;
    const lines = text.split("\n");
    const start = Math.max(0, (opts.offset ?? 1) - 1);
    return lines.slice(start, opts.limit ? start + opts.limit : undefined).join("\n");
  },
  async write(path: string, content: string) {
    await Bun.write(abs(path), content);
    return true;
  },
  async edit(path: string, oldStr: string, newStr: string, opts: { all?: boolean } = {}) {
    const p = abs(path);
    const text = await Bun.file(p).text();
    const n = text.split(oldStr).length - 1;
    if (n === 0) throw new Error(`edit: text not found in ${path}`);
    if (n > 1 && !opts.all) throw new Error(`edit: ${n} matches in ${path}; pass {all:true}`);
    await Bun.write(p, opts.all ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr));
    return n;
  },
  exists: (path: string) => existsSync(abs(path)),
  async glob(pattern: string, opts: { cwd?: string; limit?: number } = {}) {
    const out: string[] = [];
    const g = new Bun.Glob(pattern);
    for await (const f of g.scan({ cwd: opts.cwd ? abs(opts.cwd) : cwd(), onlyFiles: true })) {
      if (f.includes("node_modules/") || f.startsWith(".git/")) continue;
      out.push(f);
      if (out.length >= (opts.limit ?? 1000)) break;
    }
    return out.sort();
  },
};

async function sh(cmd: string, opts: { cwd?: string; timeout?: number; check?: boolean } = {}) {
  const p = Bun.spawn(["/bin/bash", "-c", cmd], { cwd: opts.cwd ? abs(opts.cwd) : cwd(), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), opts.timeout ?? 120_000);
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  if (opts.check && code !== 0) throw new Error(`sh exit ${code}: ${stderr.trim() || stdout.trim()}`);
  return { code, stdout, stderr };
}

async function grep(pattern: string, opts: { path?: string; glob?: string; ignoreCase?: boolean; limit?: number; filesOnly?: boolean } = {}) {
  const args = ["rg", "--no-heading", "--color=never", opts.filesOnly ? "-l" : "-n"];
  if (opts.ignoreCase) args.push("-i");
  if (opts.glob) args.push("-g", opts.glob);
  args.push("-e", pattern, opts.path ? abs(opts.path) : ".");
  const p = Bun.spawn(args, { cwd: cwd(), stdout: "pipe", stderr: "pipe" });
  const text = await new Response(p.stdout).text();
  await p.exited;
  const lines = text.split("\n").filter(Boolean).slice(0, opts.limit ?? 500);
  if (opts.filesOnly) return lines;
  return lines.map((l) => {
    const m = l.match(/^(.*?):(\d+):(.*)$/);
    return m ? { file: m[1], line: Number(m[2]), text: m[3] } : { file: "", line: 0, text: l };
  });
}

// ---------- runner ----------
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function fmt(v: unknown): string {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}

// ---------- helpers ----------
// Each ~/.config/code-mode/lib/*.js: `export default (ctx) => ({ fnName: async (...) => ... })`
// and optionally `export const docs = { fnName: "fnName(args) -> result // what it does" }`.
const LIB_DIR = process.env.CODE_MODE_LIB ?? join(homedir(), ".config/code-mode/lib");
const helpers: Record<string, unknown> = {};
const helperDocs: string[] = [];
if (existsSync(LIB_DIR)) {
  for (const f of readdirSync(LIB_DIR).filter((f) => /\.(m?js|ts)$/.test(f)).sort()) {
    try {
      const mod = await import(join(LIB_DIR, f));
      const made = typeof mod.default === "function" ? await mod.default({ fs, sh, grep, mcp, path: pathMod }) : mod.default;
      for (const [k, v] of Object.entries(made ?? {})) {
        helpers[k] = v;
        helperDocs.push(mod.docs?.[k] ?? `${k}(...)`);
      }
    } catch (e) {
      console.error(`code-mode: helper ${f} failed: ${e}`);
    }
  }
}

async function run(code: string, timeoutMs: number) {
  const logs: string[] = [];
  const log = (...a: unknown[]) => logs.push(a.map(fmt).join(" "));
  const sandboxConsole = { log, info: log, warn: log, error: log, debug: log };
  const api = { ...helpers, fs, sh, grep, mcp, console: sandboxConsole, cwd: cwd(), path: pathMod, require: req, sleep: (ms: number) => Bun.sleep(ms) };
  const fn = new AsyncFunction(...Object.keys(api), code);
  const t0 = performance.now();
  let result: unknown, error: string | undefined;
  try {
    result = await Promise.race([
      fn(...Object.values(api)),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)),
    ]);
  } catch (e: any) {
    error = e?.stack?.split("\n").slice(0, 4).join("\n") ?? String(e);
  }
  const ms = Math.round(performance.now() - t0);
  let out = "";
  if (logs.length) out += `--- logs ---\n${logs.join("\n")}\n`;
  if (error) out += `--- error ---\n${error}\n`;
  else out += `--- result ---\n${result === undefined ? "(undefined)" : fmt(result)}\n`;
  if (out.length > MAX_OUT) out = out.slice(0, MAX_OUT) + `\n…[truncated ${out.length - MAX_OUT} chars; return less]`;
  return { text: out + `(${ms}ms)`, isError: !!error };
}

// ---------- server ----------
const servers = Object.keys(serverCfgs);
const MCP_LIST = servers.length ? servers.join(", ") : "(none configured)";
const DESCRIPTION = `DEFAULT tool for any task that needs 2+ tool calls. Runs JavaScript (async function body; use \`return\`) that reads files, greps, runs shell and calls MCP servers (${MCP_LIST}) in ONE call. Only the returned value enters your context, so return just the answer (counts, filtered rows, short excerpts), never raw dumps.

Use it instead of chaining Read/Grep/Glob/Bash or MCP tools when you would: read or search several files; loop over files, issues or results; filter, join, group or count data; combine sources (e.g. git + files + Linear); or run independent steps (use Promise.all). This applies even when a direct MCP tool for the same server exists (e.g. mcp__…linear…): call it through mcp.<server> here instead.
Use the direct tools only for a single read, a single edit the user should see as a diff, or one standalone MCP call.

Globals (cwd = ${cwd()}). Every fs/grep/sh/mcp function is async: always \`await\` it.
  fs.read(path, {offset?, limit?}) -> string        // 1-based line offset
  fs.write(path, content) / fs.edit(path, old, new, {all?}) -> count
  fs.exists(path) -> bool ; fs.glob(pattern, {cwd?, limit?}) -> string[]
  grep(regex, {path?, glob?, ignoreCase?, filesOnly?, limit?}) -> [{file,line,text}] | string[]   // ripgrep
  sh(cmd, {cwd?, timeout?, check?}) -> {code, stdout, stderr}   // bash -c
  mcp.docs(server, filter?) -> string   // cached one-line signatures: name(arg: type, opt?: type) // what it does
  mcp.<server>.<tool>(args) or mcp.call(server, tool, args) -> parsed result ; mcp.tools(server, filter?) -> full schemas
  console.log(...) (shown as logs), sleep(ms), path (node:path), require, process.
MCP servers: ${MCP_LIST}. Unsure of a tool's name or args? Call mcp.docs(server, "keyword") first (cheap, cached), not mcp.tools.${helperDocs.length ? `

Helpers (globals; prefer them over raw MCP calls when they fit):
${helperDocs.map((d) => "  " + d).join("\n")}` : ""}`;

const INSTRUCTIONS = `code-mode: prefer the run_script tool over sequences of Read/Grep/Glob/Bash/MCP calls. Any task needing 2+ lookups, loops, filtering, joining or counting goes in ONE run_script call that returns only the final answer. MCP servers reachable from it: ${MCP_LIST} (use them there even if a direct tool for the same service exists).`;

const server = new McpServer({ name: "code-mode", version: VERSION }, { instructions: INSTRUCTIONS });
server.registerTool(
  "run_script",
  {
    description: DESCRIPTION,
    inputSchema: {
      code: z.string().describe("Body of an async JS function. Use `return` for the result."),
      timeout_ms: z.number().int().positive().max(600_000).optional().describe("Default 120000"),
    },
  },
  async ({ code, timeout_ms }) => {
    const { text, isError } = await run(code, timeout_ms ?? 120_000);
    return { content: [{ type: "text", text }], isError };
  },
);

if (process.argv.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}
if (process.argv[2] === "eval") {
  // local test: code-mode eval '<js>'
  const { text } = await run(process.argv[3] ?? "return 1", 120_000);
  console.log(text);
  for (const c of clients.values()) (await c).close().catch(() => {});
  process.exit(0);
}
await server.connect(new StdioServerTransport());
