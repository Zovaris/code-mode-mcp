import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Layers: global (~/.config/code-mode or $CODE_MODE_HOME) then project (.code-mode/ found walking
// up from the cwd). Each may hold servers.json, config.json, lib/*.js and scripts/*.js; project wins.
export type Layer = { scope: "global" | "project"; dir: string };

export const defaultHome = () => process.env.CODE_MODE_HOME ?? join(homedir(), ".config/code-mode");

export function findUp(name: string, from = process.cwd(), skip?: string): string | undefined {
  let dir = resolve(from);
  while (true) {
    const p = join(dir, name);
    if (existsSync(p) && p !== skip) return p;
    const parent = dirname(dir);
    if (parent === dir || dir === homedir()) return undefined;
    dir = parent;
  }
}

export function resolveLayers(cwd = process.cwd(), home = defaultHome()): { layers: Layer[]; home: string; project?: string } {
  const project = findUp(".code-mode", cwd, home);
  return {
    home,
    project,
    layers: [{ scope: "global", dir: home }, ...(project ? [{ scope: "project" as const, dir: project }] : [])],
  };
}

export function readJson(file: string): any {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`code-mode: bad JSON ${file}: ${e}`);
    return undefined;
  }
}

export function merge(a: any, b: any): any {
  if (b === undefined) return a;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v);
    return out;
  }
  return b;
}

export const loadConfig = (layers: Layer[]): Record<string, any> =>
  layers.reduce((acc, l) => merge(acc, readJson(join(l.dir, "config.json"))), {});

export type ServerCfg = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
};

export const loadServers = (layers: Layer[]): Record<string, ServerCfg> =>
  layers.reduce((acc, l) => {
    const raw = readJson(join(l.dir, "servers.json"));
    return { ...acc, ...(raw?.mcpServers ?? raw ?? {}) };
  }, {} as Record<string, ServerCfg>);
