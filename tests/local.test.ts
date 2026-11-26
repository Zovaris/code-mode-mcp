import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fs, grep, sh } from "../src/local.ts";
import { tmp, writeTree } from "./helpers.ts";

const root = tmp();
const prev = process.cwd();
beforeAll(() => {
  writeTree(root, {
    "a.txt": "hello world\nsecond line\nthird",
    "src/b.ts": "export const x = 1; // TODO fix\n",
    "src/c.ts": "// TODO one\n// todo two\n",
    "node_modules/pkg/index.ts": "TODO ignored",
  });
  process.chdir(root);
});
afterAll(() => process.chdir(prev));

describe("fs", () => {
  test("read with offset and limit", async () => {
    expect(await fs.read("a.txt", { offset: 2, limit: 1 })).toBe("second line");
  });
  test("write creates parent folders", async () => {
    await fs.write("deep/new/file.txt", "x");
    expect(await fs.read("deep/new/file.txt")).toBe("x");
  });
  test("edit refuses ambiguous matches unless all", async () => {
    await fs.write("e.txt", "a a a");
    await expect(fs.edit("e.txt", "a", "b")).rejects.toThrow(/3 matches/);
    expect(await fs.edit("e.txt", "a", "b", { all: true })).toBe(3);
    expect(await fs.read("e.txt")).toBe("b b b");
  });
  test("glob skips node_modules", async () => {
    expect(await fs.glob("**/*.ts")).toEqual(["src/b.ts", "src/c.ts"]);
  });
});

describe("grep", () => {
  test("returns file, line and text relative to cwd", async () => {
    const hits = await grep("TODO", { path: "src" });
    expect(hits).toContainEqual({ file: "src/b.ts", line: 1, text: "export const x = 1; // TODO fix" });
    expect(hits.length).toBe(2);
  });
  test("ignoreCase and filesOnly", async () => {
    const files = await grep("todo two", { ignoreCase: true, filesOnly: true });
    expect(files).toEqual(["src/c.ts"]);
  });
  test("names the file when searching a single file", async () => {
    const [hit] = (await grep("second", { path: "a.txt" })) as { file: string }[];
    expect(hit?.file).toBe("a.txt");
  });
  test("no matches is an empty list, a bad path is an error", async () => {
    expect(await grep("nothing-matches-this")).toEqual([]);
    await expect(grep("x", { path: "missing-dir" })).rejects.toThrow(/grep/);
  });
});

describe("sh", () => {
  test("captures code, stdout and stderr", async () => {
    expect(await sh("echo out; echo err >&2; exit 3")).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
  });
  test("check throws on non-zero exit", async () => {
    await expect(sh("exit 2", { check: true })).rejects.toThrow(/exit 2/);
  });
  test("timeout kills the process and its children", async () => {
    const t0 = Date.now();
    const r = await sh("sleep 5 & sleep 5; echo done", { timeout: 200 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.stdout).not.toContain("done");
    expect(r.stderr).toContain("killed after 200ms");
  });
});
