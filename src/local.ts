import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { glob as tinyglob } from "tinyglobby";
import { checkCancelled, currentSignal, killTree, track } from "./context.ts";

export const abs = (p: string) => resolve(process.cwd(), p.replace(/^~(?=\/|$)/, homedir()));

export type ShResult = { code: number; stdout: string; stderr: string };

function collect(cmd: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<ShResult> {
  checkCancelled();
  return new Promise((done, fail) => {
    const p = spawn(cmd, args, { cwd: opts.cwd ?? process.cwd(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    track(p);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    p.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    p.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(p);
    }, opts.timeout ?? 120_000);
    p.once("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    p.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) stderr += `\n[killed after ${opts.timeout ?? 120_000}ms]`;
      done({ code: code ?? 137, stdout, stderr });
    });
  });
}

export async function sh(cmd: string, opts: { cwd?: string; timeout?: number; check?: boolean } = {}): Promise<ShResult> {
  const r = await collect("/bin/bash", ["-c", cmd], { cwd: opts.cwd ? abs(opts.cwd) : undefined, timeout: opts.timeout });
  if (opts.check && r.code !== 0) throw new Error(`sh exit ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`);
  return r;
}

export const sleep = (ms: number) =>
  new Promise<void>((done, fail) => {
    checkCancelled();
    const signal = currentSignal();
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      fail(signal.reason);
    }, { once: true });
  });

export const fs = {
  async read(path: string, opts: { offset?: number; limit?: number } = {}) {
    checkCancelled();
    const text = await readFile(abs(path), "utf8");
    if (opts.offset === undefined && opts.limit === undefined) return text;
    const start = Math.max(0, (opts.offset ?? 1) - 1);
    return text.split("\n").slice(start, opts.limit ? start + opts.limit : undefined).join("\n");
  },
  async write(path: string, content: string) {
    checkCancelled();
    const p = abs(path);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content);
    return true;
  },
  async edit(path: string, oldStr: string, newStr: string, opts: { all?: boolean } = {}) {
    checkCancelled();
    const p = abs(path);
    const text = await readFile(p, "utf8");
    const n = text.split(oldStr).length - 1;
    if (n === 0) throw new Error(`edit: text not found in ${path}`);
    if (n > 1 && !opts.all) throw new Error(`edit: ${n} matches in ${path}; pass {all:true}`);
    await writeFile(p, opts.all ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr));
    return n;
  },
  async exists(path: string) {
    return existsSync(abs(path));
  },
  async glob(pattern: string, opts: { cwd?: string; limit?: number } = {}) {
    checkCancelled();
    const files = await tinyglob(pattern, {
      cwd: opts.cwd ? abs(opts.cwd) : process.cwd(),
      onlyFiles: true,
      dot: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });
    return files.sort().slice(0, opts.limit ?? 1000);
  },
};

// ripgrep when available (fast, honors .gitignore); otherwise plain grep -r, so grep() never silently returns [].
let rgAvailable: boolean | undefined;
export const hasRipgrep = () => (rgAvailable ??= spawnSync("rg", ["--version"]).status === 0);

export type GrepOpts = { path?: string; glob?: string; ignoreCase?: boolean; limit?: number; filesOnly?: boolean };
export type GrepHit = { file: string; line: number; text: string };

export async function grep(pattern: string, opts: GrepOpts = {}): Promise<GrepHit[] | string[]> {
  const target = opts.path ? abs(opts.path) : ".";
  let cmd: string;
  let args: string[];
  if (hasRipgrep()) {
    cmd = "rg";
    args = ["--no-heading", "--with-filename", "--color=never", opts.filesOnly ? "-l" : "-n"];
    if (opts.ignoreCase) args.push("-i");
    if (opts.glob) args.push("-g", opts.glob);
    args.push("-e", pattern, target);
  } else {
    cmd = "grep";
    args = ["-rHE", "--exclude-dir=node_modules", "--exclude-dir=.git", opts.filesOnly ? "-l" : "-n"];
    if (opts.ignoreCase) args.push("-i");
    if (opts.glob) args.push(`--include=${opts.glob}`);
    args.push("-e", pattern, target);
  }
  const r = await collect(cmd, args);
  // Both exit 1 when nothing matches; 2 means a real error (bad regex, missing path).
  if (r.code > 1) throw new Error(`grep: ${r.stderr.trim() || `exit ${r.code}`}`);
  const lines = r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => l.replace(/^\.\//, "").replace(`${process.cwd()}/`, ""))
    .slice(0, opts.limit ?? 500);
  if (opts.filesOnly) return lines;
  return lines.map((l) => {
    const m = l.match(/^(.*?):(\d+):(.*)$/);
    return m ? { file: m[1] ?? "", line: Number(m[2]), text: m[3] ?? "" } : { file: "", line: 0, text: l };
  });
}
