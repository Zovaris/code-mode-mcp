import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, loadServers, resolveLayers } from "../src/layers.ts";
import { createMcp } from "../src/mcp.ts";
import { createRuntime } from "../src/runtime.ts";

export const tmp = () => mkdtempSync(join(tmpdir(), "code-mode-test-"));

export function writeTree(root: string, files: Record<string, string>) {
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), content);
  }
}

export async function makeRuntime(opts: { home?: string; cwd?: string } = {}) {
  const home = opts.home ?? tmp();
  const { layers, project } = resolveLayers(opts.cwd ?? process.cwd(), home);
  const { mcp, closeAll } = createMcp(loadServers(layers), { version: "test", cacheDir: join(home, ".cache") });
  const rt = await createRuntime({ layers, home, project, config: loadConfig(layers), mcp });
  return { ...rt, home, closeAll };
}

export const result = (text: string) => {
  const m = text.match(/--- result ---\n([\s\S]*)\n\(\d+ms\)$/);
  if (!m) throw new Error(`no result in:\n${text}`);
  try {
    return JSON.parse(m[1] ?? "null");
  } catch {
    return m[1];
  }
};
