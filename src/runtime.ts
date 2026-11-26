import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as pathMod from "node:path";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { killAll, type RunCtx, runCtx } from "./context.ts";
import { findUp, type Layer } from "./layers.ts";
import { fs, grep, sh, sleep } from "./local.ts";

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

export function fmt(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

// ---------- saved scripts: <layer>/scripts/<name>.js ----------
// Plain function bodies (same as run_script code) with a comment header:
//   // @description What it does
//   // @param name type? what it is      ("?" after the type = optional)
export type Param = { name: string; type: string; optional: boolean; description: string };
export type Script = { name: string; description: string; params: Param[]; body: string; scope: string; file: string };
const NAME_RE = /^[a-zA-Z][\w-]*$/;

export function parseScript(file: string, scope: string): Script {
  const text = readFileSync(file, "utf8");
  const params: Param[] = [];
  let description = "";
  for (const line of text.split("\n")) {
    const d = line.match(/^\/\/\s*@description\s+(.*)$/);
    if (d) description = (d[1] ?? "").trim();
    const p = line.match(/^\/\/\s*@param\s+(\w+)\s+(\S+?)(\?)?(?:\s+(.*))?$/);
    if (p) params.push({ name: p[1] ?? "", type: p[2] ?? "any", optional: !!p[3], description: (p[4] ?? "").trim() });
  }
  return { name: pathMod.basename(file, ".js"), description, params, body: text, scope, file };
}

export const scriptSig = (s: Script) =>
  `${s.name}(${s.params.length ? `{${s.params.map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`).join(", ")}}` : ""}) // ${s.description}${s.scope === "project" ? " [project]" : ""}`;

export type SaveInput = {
  name: string;
  description: string;
  params?: Partial<Param>[];
  code: string;
  scope?: "global" | "project";
  overwrite?: boolean;
};

export type RuntimeOpts = {
  layers: Layer[];
  home: string;
  project?: string;
  config: Record<string, any>;
  mcp: any;
  maxOutput?: number;
};

export async function createRuntime(o: RuntimeOpts) {
  const maxOutput = o.maxOutput ?? Number(process.env.CODE_MODE_MAX_OUTPUT ?? 20000);
  const req = createRequire(join(process.cwd(), "noop.js"));

  function loadScripts(): Map<string, Script> {
    const out = new Map<string, Script>();
    for (const { scope, dir } of o.layers) {
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

  function saveScript(s: SaveInput): string {
    if (!NAME_RE.test(s.name)) throw new Error(`invalid name "${s.name}": letters, digits, - and _`);
    new AsyncFunction("args", s.code); // syntax check
    let base = o.home;
    if (s.scope === "project") {
      const git = findUp(".git");
      base = o.project ?? join(git ? pathMod.dirname(git) : process.cwd(), ".code-mode");
    }
    const dir = join(base, "scripts");
    const file = join(dir, `${s.name}.js`);
    if (existsSync(file) && !s.overwrite) throw new Error(`script "${s.name}" exists at ${file}; pass overwrite: true to replace it`);
    const header = [
      `// @description ${s.description.replace(/\n/g, " ")}`,
      ...(s.params ?? []).map(
        (p) => `// @param ${p.name} ${p.type ?? "any"}${p.optional ? "?" : ""}${p.description ? ` ${p.description}` : ""}`,
      ),
    ].join("\n");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${header}\n\n${s.code.trim()}\n`);
    return file;
  }

  // ---------- helpers: <layer>/lib/*.js ----------
  // `export default ({ fs, sh, grep, mcp, path, config }) => ({ fnName: async (...) => ... })`
  // and optionally `export const docs = { fnName: "fnName(args) -> result // what it does" }`.
  const helpers: Record<string, unknown> = {};
  const helperDocMap = new Map<string, string>();
  for (const { dir } of o.layers) {
    const lib = join(dir, "lib");
    if (!existsSync(lib)) continue;
    for (const f of readdirSync(lib).filter((f) => /\.m?js$/.test(f)).sort()) {
      try {
        const mod = await import(pathToFileURL(join(lib, f)).href);
        const made =
          typeof mod.default === "function"
            ? await mod.default({ fs, sh, grep, mcp: o.mcp, path: pathMod, config: o.config })
            : mod.default;
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

  function buildApi(log: (...a: unknown[]) => void) {
    const console = { log, info: log, warn: log, error: log, debug: log };
    const api: Record<string, unknown> = {
      ...helpers,
      fs, sh, grep, sleep, console,
      mcp: o.mcp,
      config: o.config,
      cwd: process.cwd(),
      path: pathMod,
      require: req,
      help: (kw = "") => {
        const k = String(kw).toLowerCase();
        const scripts = [...loadScripts().values()].map((s) => `scripts.run("${s.name}", ${scriptSig(s).replace(/^[^(]+/, "")}`);
        return [...helperDocs, ...scripts].filter((d) => d.toLowerCase().includes(k)).join("\n");
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
      get: (t: any, k: string | symbol) =>
        typeof k !== "string" || k === "then" ? undefined : k in t ? t[k] : (args?: Record<string, unknown>) => scriptsApi.run(k, args),
    });
    return api;
  }

  // Runs a script body. On timeout or when the script returns, the run's signal aborts: pending
  // API calls reject, later ones throw, and every process it spawned is killed. Nothing keeps
  // running in the background after the result is returned.
  async function run(code: string, timeoutMs: number, args: Record<string, unknown> = {}) {
    const logs: string[] = [];
    const ac = new AbortController();
    const ctx: RunCtx = { signal: ac.signal, procs: new Set() };
    const t0 = performance.now();
    let result: unknown;
    let error: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    await runCtx.run(ctx, async () => {
      const api = buildApi((...a: unknown[]) => {
        if (!ac.signal.aborted) logs.push(a.map(fmt).join(" "));
      });
      try {
        const fn = new AsyncFunction(...Object.keys(api), "args", code);
        const pending = fn(...Object.values(api), args);
        pending.catch(() => {}); // after a timeout its rejection is expected and must not crash the server
        result = await Promise.race([
          pending,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              const e = new Error(`timeout after ${timeoutMs}ms; script cancelled and its processes killed`);
              ac.abort(e);
              reject(e);
            }, timeoutMs);
          }),
        ]);
      } catch (e: any) {
        error = e?.stack?.split("\n").slice(0, 4).join("\n") ?? String(e);
      } finally {
        clearTimeout(timer);
        if (!ac.signal.aborted) ac.abort(new Error("script already returned; background work cancelled"));
        killAll(ctx);
      }
    });

    const ms = Math.round(performance.now() - t0);
    let out = "";
    if (logs.length) out += `--- logs ---\n${logs.join("\n")}\n`;
    if (error) out += `--- error ---\n${error}\n`;
    else out += `--- result ---\n${result === undefined ? "(undefined)" : fmt(result)}\n`;
    if (out.length > maxOutput) out = `${out.slice(0, maxOutput)}\n…[truncated ${out.length - maxOutput} chars; return less]`;
    return { text: `${out}(${ms}ms)`, isError: !!error };
  }

  return { run, loadScripts, saveScript, helperDocs };
}
