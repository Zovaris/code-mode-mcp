// Local stack status: which configured ports answer, which container holds each, and how to
// start what's missing. Everything specific comes from config.stack:
//   { "root": "~/code", "services": [{ "port": 5432, "name": "postgres", "cwd": "infra",
//     "start": "make up", "optional": false }], "runtimeHint": "open Docker Desktop" }
import net from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";

const portOpen = (port, host = "127.0.0.1", timeout = 800) =>
  new Promise((done) => {
    const s = net.connect({ port, host });
    const end = (ok) => { s.destroy(); done(ok); };
    s.setTimeout(timeout, () => end(false));
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
  });

const expandHome = (p) => (p ?? "").replace(/^~(?=\/|$)/, homedir());

export const docs = {
  stackStatus: `stackStatus({all?: boolean}) -> {docker, up: [{port, name, container, status}], down: [{port, name, fix}], unhealthy, otherContainers} // ports from config.stack.services; all: include optional ones`,
  containerLogs: `containerLogs(name: string, {since?: "15m", errors?: true, limit?: 40}) -> string[] // recent docker log lines, only errors/warnings by default`,
};

export default ({ sh, config }) => ({
  async stackStatus({ all = false } = {}) {
    const cfg = config.stack ?? {};
    const services = (cfg.services ?? []).filter((s) => all || !s.optional);
    if (!services.length) return { error: "no services: add config.stack.services to config.json" };

    const ps = await sh(`docker ps --format '{{json .}}'`, { timeout: 15000 });
    const docker = ps.code === 0 ? "ok" : `unreachable${cfg.runtimeHint ? `: ${cfg.runtimeHint}` : ""} (${ps.stderr.trim().split("\n").pop()})`;
    const containers = ps.code === 0 ? ps.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const byPort = (port) => containers.find((c) => new RegExp(`:${port}->`).test(c.Ports));

    const checked = await Promise.all(services.map(async (s) => ({ ...s, open: await portOpen(s.port, s.host), c: byPort(s.port) })));
    const root = expandHome(cfg.root ?? ".");
    const up = checked.filter((s) => s.open).map((s) => ({
      port: s.port, name: s.name, container: s.c?.Names ?? "(host process)", status: s.c?.Status ?? "listening",
    }));
    const down = checked.filter((s) => !s.open).map((s) => ({
      port: s.port, name: s.name,
      fix: s.start ? (s.cwd ? `cd ${resolve(root, expandHome(s.cwd))} && ${s.start}` : s.start) : undefined,
    }));
    const known = new Set(checked.map((s) => s.c?.Names).filter(Boolean));
    return {
      docker, up, down,
      unhealthy: containers.filter((c) => /unhealthy|Restarting/i.test(c.Status)).map((c) => c.Names),
      otherContainers: containers.filter((c) => !known.has(c.Names)).map((c) => `${c.Names} (${c.Status})`),
    };
  },

  async containerLogs(name, { since = "15m", errors = true, limit = 40 } = {}) {
    const r = await sh(`docker logs --since ${since} ${JSON.stringify(name)} 2>&1`, { timeout: 20000 });
    let lines = r.stdout.split("\n").filter(Boolean);
    if (errors) lines = lines.filter((l) => /\b(ERROR|WARN|FATAL|Exception|panic|error)\b/.test(l));
    return lines.slice(-limit).map((l) => l.slice(0, 300));
  },
});
