import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { merge, resolveLayers } from "../src/layers.ts";
import { makeRuntime, result, tmp, writeTree } from "./helpers.ts";

const echoServer = join(import.meta.dir, "fixtures/echo-server.ts");
const home = tmp();
const project = tmp();
const prev = process.cwd();

beforeAll(() => {
  writeTree(home, {
    "config.json": JSON.stringify({ team: "global", nested: { a: 1, b: 1 } }),
    "servers.json": JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [echoServer] } } }),
    "lib/greet.js": `export const docs = { greet: "greet(name) -> string // says hi" };
export default ({ config }) => ({ greet: (n) => \`hi \${n} from \${config.team}\` });`,
    "scripts/double.js": "// @description Doubles n\n// @param n number value\n\nreturn args.n * 2;\n",
  });
  writeTree(project, {
    ".code-mode/config.json": JSON.stringify({ team: "project", nested: { b: 2 } }),
    ".code-mode/scripts/double.js": "// @description Triples n (project override)\n// @param n number\n\nreturn args.n * 3;\n",
    "sub/dir/.keep": "",
  });
  process.chdir(join(project, "sub/dir"));
});
afterAll(() => process.chdir(prev));

describe("layers", () => {
  test("deep merge: objects merge, arrays and scalars replace", () => {
    expect(merge({ a: { x: 1, y: [1] } }, { a: { y: [2] } })).toEqual({ a: { x: 1, y: [2] } });
  });
  test("project layer is found walking up and wins", async () => {
    expect(resolveLayers(process.cwd(), home).layers.map((l) => l.scope)).toEqual(["global", "project"]);
    const rt = await makeRuntime({ home });
    expect(result((await rt.run("return config", 5000)).text)).toEqual({ team: "project", nested: { a: 1, b: 2 } });
    expect(result((await rt.run("return scripts.double({ n: 2 })", 5000)).text)).toBe(6);
    await rt.closeAll();
  });
});

describe("run", () => {
  test("returns only the result, plus logs", async () => {
    const rt = await makeRuntime({ home });
    const r = await rt.run('console.log("step", 1); return { ok: true }', 5000);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("--- logs ---\nstep 1");
    expect(result(r.text)).toEqual({ ok: true });
  });
  test("errors are reported, not thrown", async () => {
    const rt = await makeRuntime({ home });
    const r = await rt.run('throw new Error("nope")', 5000);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("nope");
  });
  test("helpers read config and are listed by help()", async () => {
    const rt = await makeRuntime({ home });
    expect(result((await rt.run('return greet("ana")', 5000)).text)).toBe("hi ana from project");
    expect(result((await rt.run('return help("greet")', 5000)).text)).toBe("greet(name) -> string // says hi");
  });
  test("output is truncated", async () => {
    const rt = await makeRuntime({ home });
    const r = await rt.run('return "x".repeat(50000)', 5000);
    expect(r.text).toContain("truncated");
  });
});

describe("timeout", () => {
  test("cancels the script and kills its processes", async () => {
    const rt = await makeRuntime({ home });
    const marker = join(tmp(), "should-not-exist");
    const t0 = Date.now();
    const r = await rt.run(`await sh("sleep 1; touch ${marker}"); return "finished"`, 200);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("timeout after 200ms");
    await Bun.sleep(1300);
    expect(existsSync(marker)).toBe(false);
  });
  test("later API calls of a cancelled script throw", async () => {
    const rt = await makeRuntime({ home });
    const marker = join(tmp(), "after-timeout");
    await rt.run(`while (true) { await sleep(50); } `, 150);
    const r = await rt.run(`(async () => { await sleep(300); await fs.write(${JSON.stringify(marker)}, "x"); })().catch(() => {}); return 1`, 5000);
    expect(result(r.text)).toBe(1);
    await Bun.sleep(500);
    expect(existsSync(marker)).toBe(false);
  });
  test("background processes are killed when the script returns", async () => {
    const rt = await makeRuntime({ home });
    const marker = join(tmp(), "background");
    await rt.run(`sh("sleep 0.5; touch ${marker}"); return "early"`, 5000);
    await Bun.sleep(900);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("saved scripts", () => {
  test("save_script writes a header and the script runs", async () => {
    const rt = await makeRuntime({ home });
    const file = rt.saveScript({
      name: "add",
      description: "Adds a and b",
      params: [{ name: "a", type: "number" }, { name: "b", type: "number", optional: true }],
      code: "return args.a + (args.b ?? 0);",
    });
    expect(readFileSync(file, "utf8")).toStartWith("// @description Adds a and b\n// @param a number\n// @param b number?");
    expect(result((await rt.run('return scripts.run("add", { a: 2, b: 3 })', 5000)).text)).toBe(5);
    expect(() => rt.saveScript({ name: "add", description: "x", code: "return 1" })).toThrow(/exists/);
    expect(() => rt.saveScript({ name: "bad name", description: "x", code: "return 1" })).toThrow(/invalid name/);
    expect(() => rt.saveScript({ name: "broken", description: "x", code: "return (" })).toThrow();
  });
});

describe("mcp proxy", () => {
  test("calls tools on a stdio server and unwraps JSON", async () => {
    const rt = await makeRuntime({ home });
    const r = await rt.run('return mcp.echo.echo({ text: "ab", times: 2 })', 15000);
    expect(result(r.text)).toEqual({ echoed: "abab" });
    await rt.closeAll();
  });
  test("docs gives signatures; tool errors become script errors", async () => {
    const rt = await makeRuntime({ home });
    expect(result((await rt.run('return mcp.docs("echo", "echo")', 15000)).text)).toBe("echo(text: string, times?: number) // Echo text back.");
    const r = await rt.run('return mcp.echo.fail()', 15000);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("boom");
    expect((await rt.run('return mcp.nope.x()', 5000)).text).toContain('unknown MCP server "nope"');
    await rt.closeAll();
  });
});
