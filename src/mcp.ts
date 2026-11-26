import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { checkCancelled, currentSignal } from "./context.ts";
import type { ServerCfg } from "./layers.ts";

// Secrets stay out of the config: "${cmd:security find-generic-password ...}" runs a command,
// "${env:VAR}" reads the environment.
export function expand(v: string): string {
  return v
    .replace(/\$\{env:([^}]+)\}/g, (_m, k) => process.env[k] ?? "")
    .replace(/\$\{cmd:([^}]+)\}/g, (_m, cmd) => {
      try {
        return execFileSync("/bin/bash", ["-lc", cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      } catch (e: any) {
        throw new Error(`config command failed: ${cmd}: ${String(e?.stderr ?? e).trim()}`);
      }
    });
}
const expandAll = (o?: Record<string, string>) => o && Object.fromEntries(Object.entries(o).map(([k, v]) => [k, expand(v)]));

export function unwrap(res: any): any {
  if (res?.structuredContent !== undefined) return res.structuredContent;
  const vals = (res?.content ?? []).map((p: any) => {
    if (p.type !== "text") return p;
    try {
      return JSON.parse(p.text);
    } catch {
      return p.text;
    }
  });
  const out = vals.length === 1 ? vals[0] : vals;
  if (res?.isError) throw new Error(typeof out === "string" ? out : JSON.stringify(out));
  return out;
}

type CachedTool = { name: string; description: string; inputSchema: any };
const firstLine = (s: string) => (s.split(/\n|(?<=\.)\s/)[0] ?? "").slice(0, 100);

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

export function sig(schema: any): string {
  const props = schema?.properties ?? {};
  const req = new Set<string>(schema?.required ?? []);
  return Object.entries(props)
    .map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${tsType(v)}`)
    .join(", ");
}

export function createMcp(serverCfgs: Record<string, ServerCfg>, opts: { version: string; cacheDir?: string }) {
  const cacheDir = opts.cacheDir ?? join(homedir(), ".cache/code-mode");
  const clients = new Map<string, Promise<Client>>();

  function client(name: string): Promise<Client> {
    const cfg = serverCfgs[name];
    if (!cfg) throw new Error(`unknown MCP server "${name}". Known: ${Object.keys(serverCfgs).join(", ") || "(none)"}`);
    let c = clients.get(name);
    if (!c) {
      c = (async () => {
        const cl = new Client({ name: "code-mode", version: opts.version });
        const transport = cfg.url
          ? new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: expandAll(cfg.headers) } })
          : new StdioClientTransport({
              command: cfg.command ?? "",
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

  const api: Record<string, any> = {
    servers: () => Object.keys(serverCfgs),
    async tools(server: string, filter?: string) {
      checkCancelled();
      const { tools } = await (await client(server)).listTools();
      const f = filter?.toLowerCase();
      return tools
        .filter((t) => !f || t.name.toLowerCase().includes(f) || (t.description ?? "").toLowerCase().includes(f))
        .map((t) => ({ name: t.name, description: (t.description ?? "").slice(0, 300), input: t.inputSchema }));
    },
    async call(server: string, tool: string, args: Record<string, unknown> = {}) {
      checkCancelled();
      const res = await (await client(server)).callTool({ name: tool, arguments: args }, undefined, { signal: currentSignal() });
      return unwrap(res);
    },
    // Compact TS-like signatures, cached on disk so reading them needs no connection.
    async docs(server: string, filter?: string, o: { refresh?: boolean } = {}) {
      const file = join(cacheDir, `${server}.json`);
      let tools: CachedTool[] | undefined;
      if (!o.refresh && existsSync(file)) tools = JSON.parse(readFileSync(file, "utf8"));
      if (!tools) {
        checkCancelled();
        const res = await (await client(server)).listTools();
        tools = res.tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema }));
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(file, JSON.stringify(tools));
      }
      const f = filter?.toLowerCase();
      return tools
        .filter((t) => !f || t.name.toLowerCase().includes(f) || t.description.toLowerCase().includes(f))
        .map((t) => `${t.name}(${sig(t.inputSchema)}) // ${firstLine(t.description)}`)
        .join("\n");
    },
  };

  // mcp.<server>.<tool>(args) and mcp["server-name"].<tool>(args)
  const mcp = new Proxy(api, {
    get(target, server: string | symbol) {
      if (typeof server !== "string" || server === "then") return undefined;
      if (server in target) return target[server];
      return new Proxy({}, {
        get: (_t, tool: string | symbol) =>
          typeof tool === "string" && tool !== "then" ? (args?: Record<string, unknown>) => api.call(server, tool, args) : undefined,
      });
    },
  });

  async function closeAll() {
    await Promise.all([...clients.values()].map(async (c) => (await c).close().catch(() => {})));
    clients.clear();
  }

  return { mcp, closeAll };
}
