import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";

// Every run_script call runs inside its own context. When the run ends or times out, the
// signal aborts: API calls made after that throw, and every child process it started is killed.
export type RunCtx = { signal: AbortSignal; procs: Set<ChildProcess> };

export const runCtx = new AsyncLocalStorage<RunCtx>();

export function currentSignal(): AbortSignal | undefined {
  return runCtx.getStore()?.signal;
}

export function checkCancelled(): void {
  const signal = currentSignal();
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("cancelled");
}

export function track(p: ChildProcess): void {
  const ctx = runCtx.getStore();
  if (!ctx) return;
  ctx.procs.add(p);
  p.once("exit", () => ctx.procs.delete(p));
}

// Processes are spawned detached so each one leads its own group; killing -pid takes its children too.
export function killTree(p: ChildProcess): void {
  if (p.exitCode !== null || p.signalCode !== null) return;
  try {
    if (p.pid) process.kill(-p.pid, "SIGKILL");
  } catch {
    p.kill("SIGKILL");
  }
}

export function killAll(ctx: RunCtx): void {
  for (const p of ctx.procs) killTree(p);
  ctx.procs.clear();
}
