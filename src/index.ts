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

const VERSION = "0.5.0";
const MAX_OUT = Number(process.env.CODE_MODE_MAX_OUTPUT ?? 20000);

// ---------- layers: global (~/.config/code-mode) then project (.code-mode/ up from cwd) ----------
// Each layer may hold servers.json, config.json, lib/*.js and scripts/*.js; the project wins.
const HOME_DIR = process.env.CODE_MODE_HOME ?? join(homedir(), ".config/code-mode");

function findUp(name: string, from = process.cwd()): string | undefined {
  let dir = resolve(from);
  while (true) {
    const p = join(dir, name);
    if (existsSync(p) && p !== HOME_DIR) return p;
    const parent = pathMod.dirname(dir);
    if (parent === dir || dir === homedir()) return undefined;
    dir = parent;
  }
}
const PROJECT_DIR = findUp(".code-mode");
const LAYERS: { scope: "global" | "project"; dir: string }[] = [
  { scope: "global", dir: HOME_DIR },
  ...(PROJECT_DIR ? [{ scope: "project" as const, dir: PROJECT_DIR }] : []),
];

function readJson(file: string): any {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`code-mode: bad JSON ${file}: ${e}`);
    return undefined;
  }
}

function merge(a: any, b: any): any {
  if (b === undefined) return a;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v);
    return out;
  }
  return b;
}

// User settings that helpers and scripts read (ports, org, team…): nothing specific lives in code.
const config: Record<string, any> = LAYERS.reduce((acc, l) => merge(acc, readJson(join(l.dir, "config.json"))), {});

// ---------- MCP proxy ----------
type ServerCfg = { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string; headers?: Record<string, string> };

function loadServers(): Record<string, ServerCfg> {
  return LAYERS.reduce((acc, l) => {
    const raw = readJson(join(l.dir, "servers.json"));
    return { ...acc, ...(raw?.mcpServers ?? raw ?? {}) };
  }, {} as Record<string, ServerCfg>);
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

// ---------- helpers: <layer>/lib/*.js ----------
// `export default ({ fs, sh, grep, mcp, path, config }) => ({ fnName: async (...) => ... })`
// and optionally `export const docs = { fnName: "fnName(args) -> result // what it does" }`.
// Helpers are adapters: they take their specifics from `config`, never hardcode them.
const helpers: Record<string, unknown> = {};
const helperDocMap = new Map<string, string>();
for (const { dir } of LAYERS) {
  const lib = join(dir, "lib");
  if (!existsSync(lib)) continue;
  for (const f of readdirSync(lib).filter((f) => /\.(m?js|ts)$/.test(f)).sort()) {
    try {
      const mod = await import(join(lib, f));
      const made = typeof mod.default === "function" ? await mod.default({ fs, sh, grep, mcp, path: pathMod, config }) : mod.default;
      for (const [k, v] of Object.entries(made ?? {})) {
        helpers[k] = v;
        helperDocMap.set(k, mod.docs?.[k] ?? `${k}(...)`);
      }
    } catch (e) {
      console.error(`code-mode: helper ${join(lib, f)} failed: ${e}`);
    }
  }
}
const helperDocs = [...helperDocMap.values()];

// ---------- saved scripts: <layer>/scripts/<name>.js ----------
// Plain function bodies (same as run_script code) with a comment header:
//   // @description What it does
//   // @param name type? what it is      ("?" after the type = optional)
// The body sees every global plus `args`. Read specifics from args or `config`, never hardcode.
type Param = { name: string; type: string; optional: boolean; description: string };
type Script = { name: string; description: string; params: Param[]; body: string; scope: string; file: string };
const NAME_RE = /^[a-zA-Z][\w-]*$/;

function parseScript(file: string, scope: string): Script {
  const text = readFileSync(file, "utf8");
  const params: Param[] = [];
  let description = "";
  for (const line of text.split("\n")) {
    const d = line.match(/^\/\/\s*@description\s+(.*)$/);
    if (d) description = d[1].trim();
    const p = line.match(/^\/\/\s*@param\s+(\w+)\s+(\S+?)(\?)?(?:\s+(.*))?$/);
    if (p) params.push({ name: p[1], type: p[2], optional: !!p[3], description: (p[4] ?? "").trim() });
  }
  return { name: pathMod.basename(file, ".js"), description, params, body: text, scope, file };
}

function loadScripts(): Map<string, Script> {
  const out = new Map<string, Script>();
  for (const { scope, dir } of LAYERS) {
    const d = join(dir, "scripts");
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((f) => f.endsWith(".js")).sort()) {
      try {
        const s = parseScript(join(d, f), scope);
        out.set(s.name, s);
      } catch (e) {
        console.error(`code-mode: script ${f} failed: ${e}`);
      }
    }
  }
  return out;
}

const scriptSig = (s: Script) =>
  `${s.name}(${s.params.length ? `{${s.params.map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`).join(", ")}}` : ""}) // ${s.description}${s.scope === "project" ? " [project]" : ""}`;

function saveScript(o: { name: string; description: string; params?: Partial<Param>[]; code: string; scope?: "global" | "project"; overwrite?: boolean }) {
  if (!NAME_RE.test(o.name)) throw new Error(`invalid name "${o.name}": letters, digits, - and _`);
  new AsyncFunction("args", o.code); // syntax check
  let base = HOME_DIR;
  if (o.scope === "project") {
    const git = findUp(".git");
    base = PROJECT_DIR ?? join(git ? pathMod.dirname(git) : process.cwd(), ".code-mode");
  }
  const dir = join(base, "scripts");
  const file = join(dir, `${o.name}.js`);
  if (existsSync(file) && !o.overwrite) throw new Error(`script "${o.name}" exists at ${file}; pass overwrite: true to replace it`);
  const header = [
    `// @description ${o.description.replace(/\n/g, " ")}`,
    ...(o.params ?? []).map((p) => `// @param ${p.name} ${p.type ?? "any"}${p.optional ? "?" : ""}${p.description ? " " + p.description : ""}`),
  ].join("\n");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${header}\n\n${o.code.trim()}\n`);
  return file;
}

function buildApi(log: (...a: unknown[]) => void) {
  const sandboxConsole = { log, info: log, warn: log, error: log, debug: log };
  const api: Record<string, unknown> = {
    ...helpers, fs, sh, grep, mcp, config, console: sandboxConsole, cwd: cwd(), path: pathMod, require: req,
    sleep: (ms: number) => Bun.sleep(ms),
    help: (kw = "") => {
      const k = kw.toLowerCase();
      return [...helperDocs, ...[...loadScripts().values()].map((s) => `scripts.run("${s.name}", ${scriptSig(s).replace(/^[^(]+/, "")}`)]
        .filter((d) => d.toLowerCase().includes(k)).join("\n");
    },
  };
  const scriptsApi = {
    list: () => [...loadScripts().values()].map(scriptSig),
    run: (name: string, args: Record<string, unknown> = {}) => {
      const s = loadScripts().get(name);
      if (!s) throw new Error(`unknown script "${name}". Saved: ${[...loadScripts().keys()].join(", ") || "(none)"}`);
      return new AsyncFunction(...Object.keys(api), "args", s.body)(...Object.values(api), args);
    },
  };
  api.scripts = new Proxy(scriptsApi, {
    get: (t: any, k: string) => (k in t ? t[k] : k === "then" ? undefined : (args?: Record<string, unknown>) => scriptsApi.run(k, args)),
  });
  return api;
}

async function run(code: string, timeoutMs: number, args: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const api = buildApi((...a: unknown[]) => logs.push(a.map(fmt).join(" ")));
  const fn = new AsyncFunction(...Object.keys(api), "args", code);
  const t0 = performance.now();
  let result: unknown, error: string | undefined;
  try {
    result = await Promise.race([
      fn(...Object.values(api), args),
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
const startupScripts = [...loadScripts().values()].map(scriptSig);
// Kept short on purpose: it is paid in every session. Full signatures live behind help() and mcp.docs().
const shortDoc = (d: string) => {
  const [sig, what] = d.split(" // ");
  return `${sig.split("(")[0]}${what ? ` (${what.split(/[;:(]/)[0].trim()})` : ""}`;
};
const DESCRIPTION = `Runs JS (async function body, \`return\` the result) in ONE call; only the returned value enters your context. DEFAULT for anything needing 2+ steps: several files/searches, loops, filter/group/count, combining git, files and MCP. Direct tools only for one read, one edit shown as a diff, or one standalone call. Return only the answer, never raw dumps.
API (all async): fs.read(p,{offset,limit}) fs.write fs.edit(p,old,new) fs.glob(pat) fs.exists; grep(re,{path,glob,filesOnly}) -> [{file,line,text}]; sh(cmd,{cwd,timeout}) -> {code,stdout,stderr}; mcp.<server>.<tool>(args); mcp.docs(server,"kw") -> tool signatures; scripts.run(name,args); help("kw") -> helper/script signatures; config; args; console.log; path; require.
MCP servers: ${MCP_LIST}.${helperDocs.length ? `
Helpers: ${helperDocs.map(shortDoc).join("; ")}.` : ""}${startupScripts.length ? `
Saved scripts (run_script({script,args})): ${startupScripts.map(shortDoc).join("; ")}.` : ""}
Repeated action or user asks to save one -> save_script; keep specifics in args/config.`;

const INSTRUCTIONS = `Prefer code-mode run_script over chains of Read/Grep/Glob/Bash/MCP calls: 2+ steps go in ONE script returning only the answer. MCP via it: ${MCP_LIST}.`;

const server = new McpServer({ name: "code-mode", version: VERSION }, { instructions: INSTRUCTIONS });
server.registerTool(
  "run_script",
  {
    description: DESCRIPTION,
    _meta: { "anthropic/alwaysLoad": true }, // skip the ToolSearch round trip in Claude Code
    inputSchema: {
      code: z.string().optional().describe("Body of an async JS function. Use `return` for the result."),
      script: z.string().optional().describe("Name of a saved script to run instead of code"),
      args: z.record(z.string(), z.any()).optional().describe("Arguments for the saved script (also `args` inside code)"),
      timeout_ms: z.number().int().positive().max(600_000).optional().describe("Default 120000"),
    },
  },
  async ({ code, script, args, timeout_ms }) => {
    if (!code === !script) return { content: [{ type: "text", text: "pass exactly one of code or script" }], isError: true };
    const body = script ? `return await scripts.run(${JSON.stringify(script)}, args);` : code!;
    const { text, isError } = await run(body, timeout_ms ?? 120_000, args ?? {});
    return { content: [{ type: "text", text }], isError };
  },
);

server.registerTool(
  "save_script",
  {
    description: `Save a run_script action by name to reuse with run_script({script,args}). Generic: specifics from args or config, never hardcoded. scope global (default) or project (.code-mode/).`,
    inputSchema: {
      name: z.string().describe("kebab or camel case, e.g. stack-status"),
      description: z.string().describe("One line: what it does and returns"),
      params: z.array(z.object({ name: z.string(), type: z.string(), optional: z.boolean().optional(), description: z.string().optional() })).optional(),
      code: z.string().describe("Async function body; reads `args`; uses `return`"),
      scope: z.enum(["global", "project"]).optional(),
      overwrite: z.boolean().optional(),
    },
  },
  async (o) => {
    try {
      const file = saveScript(o);
      return { content: [{ type: "text", text: `saved ${file}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true };
    }
  },
);

if (process.argv.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}
const cli = process.argv[2];
if (cli === "eval" || cli === "run" || cli === "scripts") {
  // code-mode eval '<js>' | code-mode run <script> ['{"json":"args"}'] | code-mode scripts
  let text: string;
  if (cli === "scripts") text = [...loadScripts().values()].map((s) => `${scriptSig(s)}\n    ${s.file}`).join("\n") || "(no saved scripts)";
  else if (cli === "run") text = (await run(`return await scripts.run(${JSON.stringify(process.argv[3])}, args);`, 600_000, JSON.parse(process.argv[4] ?? "{}"))).text;
  else text = (await run(process.argv[3] ?? "return 1", 120_000)).text;
  console.log(text);
  for (const c of clients.values()) (await c).close().catch(() => {});
  process.exit(0);
}
await server.connect(new StdioServerTransport());
