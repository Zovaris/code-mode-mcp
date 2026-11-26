<div align="center">

# code-mode-mcp

**Let the model write one script instead of making twenty tool calls.**

An MCP server that runs model-written JavaScript against your files, shell and other MCP servers in a single call. Only the returned value goes back into the context.

[![CI](https://github.com/Zovaris/code-mode-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Zovaris/code-mode-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@zovaris/code-mode-mcp)](https://www.npmjs.com/package/@zovaris/code-mode-mcp)
![License](https://img.shields.io/badge/license-MIT-green)
![MCP](https://img.shields.io/badge/protocol-MCP-blue)

[Quick start](#quick-start) · [How it works](#how-it-works) · [Script API](#script-api) · [Configuration](#configuration) · [CLI](#cli)

</div>

---

## Why

Agents chain tool calls: read a file, grep, read three more, call an API, filter. Every intermediate result fills up the context and every step costs a round trip. Code Mode turns that chain into one program:

```js
// one run_script call
const files = await fs.glob("src/**/*.ts");
const hits = await Promise.all(files.map(async (f) => ({ f, n: (await fs.read(f)).split("TODO").length - 1 })));
return hits.filter((h) => h.n).sort((a, b) => b.n - a.n).slice(0, 5);
```

The model gets back only the top five. The idea is known as "Code Mode". This server brings it to any MCP client: Claude, Cursor, Codex, OpenCode, VS Code, Windsurf or your own agent.

## Features

- **Two tools.** `run_script` runs code or a saved script. `save_script` saves a reusable action.
- **MCP proxy.** Calls any other MCP server as `mcp.<server>.<tool>(args)`, over stdio or HTTP.
- **Helpers and saved scripts.** Your own functions, loaded from a folder and listed for the model automatically.
- **Layered config.** A global layer plus a per-project layer. Nothing company-specific lives in the code.
- **Secrets out of files.** Use `${env:VAR}` and `${cmd:...}` in server env and headers.
- **Runs anywhere.** `npx` with Node 20+, or a standalone binary with no runtime at all.
- **Never left running.** A script that times out or returns is cancelled, and every process it started is killed.

> [!WARNING]
> There is no sandbox. Scripts run with your user's permissions and without permission prompts. Use it locally only.

## Quick start

**With npx** (Node 20+). Add this to your MCP client config:

```json
{ "mcpServers": { "code-mode": { "command": "npx", "args": ["-y", "@zovaris/code-mode-mcp"] } } }
```

**As a binary** (macOS and Linux, no runtime needed):

```bash
curl -fsSL https://raw.githubusercontent.com/Zovaris/code-mode-mcp/main/install.sh | sh
```

This installs `~/.local/bin/code-mode-mcp` (checksum verified) and creates `~/.config/code-mode/servers.json`. Then register it:

```json
{ "mcpServers": { "code-mode": { "command": "/Users/you/.local/bin/code-mode-mcp" } } }
```

<details>
<summary>Where that config goes, per client</summary>

| Client | How |
| --- | --- |
| Claude Code | `claude mcp add -s user code-mode -- npx -y @zovaris/code-mode-mcp` |
| Claude Desktop | `claude_desktop_config.json` → `mcpServers` |
| Cursor | `~/.cursor/mcp.json` → `mcpServers` |
| VS Code | `.vscode/mcp.json` → `servers` |
| Codex CLI | `~/.codex/config.toml` → `[mcp_servers.code-mode]` with `command` and `args` |
| OpenCode | `opencode.json` → `mcp.code-mode` with `"type": "local"` and `command` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` → `mcpServers` |

</details>

## How it works

```
model ──run_script({code})──▶ code-mode-mcp ──▶ fs / grep / sh
                                  │
                                  └──────▶ mcp.<server>.<tool>() ──▶ other MCP servers
model ◀──── returned value only ──┘
```

1. At startup, code-mode reads the layers and connects proxied servers lazily, on first use.
2. The tool description lists the API, your helpers and your saved scripts in a short form.
3. The script runs as an async function body. Logs and the return value come back, truncated to `CODE_MODE_MAX_OUTPUT`.

## Tools

| Tool | Input | Does |
| --- | --- | --- |
| `run_script` | `{code}` or `{script, args}`, optional `timeout_ms` | Runs a JS body or a saved script |
| `save_script` | `{name, description, params?, code, scope?, overwrite?}` | Saves to `scripts/<name>.js` in the global or project layer |

## Script API

Every call is async, so `await` it. The working directory is the client's project folder.

| Global | Does |
| --- | --- |
| `fs.read(path, {offset, limit})` `fs.write` `fs.edit(path, old, new, {all})` `fs.exists` `fs.glob(pattern)` | Files |
| `grep(regex, {path, glob, ignoreCase, filesOnly, limit})` | ripgrep (falls back to `grep -r`) → `[{file, line, text}]` |
| `sh(cmd, {cwd, timeout, check})` | `bash -c` → `{code, stdout, stderr}` |
| `mcp.<server>.<tool>(args)` `mcp.call` `mcp.tools` `mcp.servers()` | Proxied MCP servers |
| `mcp.docs(server, filter)` | One-line tool signatures, cached in `~/.cache/code-mode/` |
| `scripts.run(name, args)` `scripts.<name>(args)` `scripts.list()` | Saved scripts |
| `help(keyword)` | Signatures of helpers and scripts |
| `config` `args` `console.log` `sleep(ms)` `path` `require` | Utilities |

`run_script` stops at `timeout_ms` (120 s by default). When a script times out or returns, pending calls reject, later calls throw, and its shell processes, including their children, are killed.

## Configuration

Everything specific to you is data, kept in a layer folder:

| File | Holds |
| --- | --- |
| `servers.json` | MCP servers to proxy, in the same shape as `mcpServers` |
| `config.json` | Your settings, exposed to helpers and scripts as `config` |
| `lib/*.js` | Helpers: adapters that turn MCP or shell calls into plain functions |
| `scripts/*.js` | Saved actions: function bodies with a comment header |

There are two layers. The global one is `~/.config/code-mode/` (or `$CODE_MODE_HOME`). The project one is `.code-mode/`, found by walking up from the cwd. The project layer wins: `config.json` deep-merges, and servers, helpers and scripts are overridden by name.

### Proxied servers

```json
{
  "mcpServers": {
    "local-tool": { "command": "my-mcp", "args": ["serve"] },
    "tracker": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${env:TRACKER_API_KEY}" }
    },
    "oauth-server": { "command": "npx", "args": ["-y", "mcp-remote", "https://mcp.example.com/mcp"] }
  }
}
```

### Helpers

```js
// lib/code-host.js
export const docs = { myPRs: "myPRs({state?}) -> [{repo, number, title, url}] // my PRs" };
export default ({ mcp, sh, fs, grep, config }) => ({
  myPRs: async ({ state = "open" } = {}) => { /* reads config.codeHost */ },
});
```

### Saved scripts

```js
// scripts/issue-prs.js
// @description My issues with the PRs that mention each
// @param states string[]? issue states

const issues = await myIssues({ states: args.states ?? config.issues.activeStates });
return Promise.all(issues.map(async (i) => ({ id: i.id, prs: await prsMentioning(i.id) })));
```

Working examples live in [`examples/`](examples/). Copy what you want into a layer folder:

| File | Gives |
| --- | --- |
| `lib/git.js` | `changedFiles`, `recentCommits` |
| `lib/issues.js` | `myIssues` (issue tracker over MCP; set `config.issues.server`) |
| `lib/code-host.js` | `myPRs`, `prsMentioning` (code host over MCP; set `config.codeHost`) |
| `lib/stack.js` | `stackStatus`, `containerLogs` (local services and Docker) |
| `scripts/todos.js` | TODO/FIXME comments grouped by file |
| `scripts/review-prep.js` | What changed on the branch, its commits and new TODOs |
| `scripts/issue-prs.js` | Your issues with the PRs that mention each |
| `scripts/stack-status.js` | Which local services are up, and how to start the rest |

## CLI

```bash
code-mode-mcp --version
code-mode-mcp scripts                            # list saved scripts
code-mode-mcp run todos '{"limit":5}'            # run a saved script
code-mode-mcp eval 'return (await fs.glob("**/*.ts")).length'
```

| Env | Default |
| --- | --- |
| `CODE_MODE_HOME` | `~/.config/code-mode` |
| `CODE_MODE_MAX_OUTPUT` | `20000` characters |

## Development

```bash
bun install
bun run dev         # run from source
bun test
bun run typecheck
bun run build       # dist/index.js for Node
bun run build:bin   # bin/code-mode-mcp standalone binary
```

Releases: bump `version` in `package.json` and push a `vX.Y.Z` tag. The release workflow tests, publishes to npm and attaches binaries for macOS and Linux (arm64 and x64) with `SHA256SUMS`.

## License

[MIT](LICENSE)
