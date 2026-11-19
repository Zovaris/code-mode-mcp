// Local Abaco stack status, from the port map in ~/Documents/Codes/LOCAL-SETUP.md.
import net from "node:net";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const CODES = `${homedir()}/Documents/Codes`;
const SERVICES = [
  { port: 5432, name: "shared-postgres", repo: "integration", up: "make infra-up" },
  { port: 6379, name: "shared-redis", repo: "integration", up: "make infra-up" },
  { port: 8000, name: "fpe product-directory", repo: "fpe-api/fpe-platform-local", up: "make up-shared" },
  { port: 8001, name: "fpe credit-facility", repo: "fpe-api/fpe-platform-local", up: "make up-shared" },
  { port: 8002, name: "fpe product-agreement", repo: "fpe-api/fpe-platform-local", up: "make up-shared" },
  { port: 8003, name: "loan-repayment", repo: "payment-engine", up: "make up-shared" },
  { port: 8004, name: "core-banking", repo: "integration", up: "make up-shared" },
  { port: 8005, name: "collections-rail", repo: "integration", up: "make up-collections-rail", optional: true },
  { port: 8080, name: "debt-servicing api", repo: "abaco-debt-servicing", up: "make up-shared" },
  { port: 3000, name: "debt-servicing web", repo: "abaco-debt-servicing", up: "bun run --cwd apps/web dev", optional: true },
  { port: 8010, name: "laravel api", repo: "api", up: "docker start abaco_db abaco_redis abaco_api", optional: true },
  { port: 3307, name: "laravel mysql", repo: "api", up: "docker start abaco_db", optional: true },
];

const portOpen = (port, timeout = 800) =>
  new Promise((done) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    const end = (ok) => { s.destroy(); done(ok); };
    s.setTimeout(timeout, () => end(false));
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
  });

export const docs = {
  localStack: `localStack({all?: boolean}) -> {docker, up: [{port, name, container, status}], down: [{port, name, fix}], otherContainers} // local Abaco stack: which ports/services are up and the command to start what's missing (all: include optional ones)`,
  stackLogs: `stackLogs(container: string, {since?: "15m", errors?: true, limit?: 40}) -> string[] // recent log lines of a container, only errors/warnings by default`,
};

export default ({ sh }) => ({
  async localStack({ all = false } = {}) {
    const sock = `${homedir()}/.kiri/run/docker.sock`;
    const ps = await sh(`docker ps --format '{{json .}}'`, { timeout: 15000 });
    const docker = ps.code === 0 ? "ok" : existsSync(sock) ? `error: ${ps.stderr.trim().split("\n").pop()}` : "down: open Kiri.app";
    const containers = ps.code === 0 ? ps.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const byPort = (port) => containers.find((c) => new RegExp(`:${port}->`).test(c.Ports));

    const services = all ? SERVICES : SERVICES.filter((s) => !s.optional);
    const checked = await Promise.all(services.map(async (s) => ({ ...s, open: await portOpen(s.port), c: byPort(s.port) })));

    const up = checked.filter((s) => s.open).map((s) => ({
      port: s.port,
      name: s.name,
      container: s.c?.Names ?? "(host process)",
      status: s.c?.Status ?? "listening",
    }));
    const down = checked.filter((s) => !s.open).map((s) => ({
      port: s.port,
      name: s.name,
      fix: `cd ${CODES}/${s.repo} && ${s.up}`,
    }));
    const known = new Set(checked.map((s) => s.c?.Names).filter(Boolean));
    const otherContainers = containers.filter((c) => !known.has(c.Names)).map((c) => `${c.Names} (${c.Status})`);
    const unhealthy = containers.filter((c) => /unhealthy|Restarting/i.test(c.Status)).map((c) => c.Names);
    return { docker, up, down, unhealthy, otherContainers };
  },

  async stackLogs(container, { since = "15m", errors = true, limit = 40 } = {}) {
    const r = await sh(`docker logs --since ${since} ${JSON.stringify(container)} 2>&1`, { timeout: 20000 });
    let lines = r.stdout.split("\n").filter(Boolean);
    if (errors) lines = lines.filter((l) => /\b(ERROR|WARN|FATAL|Exception|panic|error)\b/.test(l));
    return lines.slice(-limit).map((l) => l.slice(0, 300));
  },
});
