<div align="center">

# code-mode

**Let the model write one script instead of making twenty tool calls.**

An MCP server that runs model-written JavaScript against your files, shell and other MCP servers in a single call. Only the returned value goes back into the context.

[![CI](https://github.com/sthbryan/claude-code-mode/actions/workflows/ci.yml/badge.svg)](https://github.com/sthbryan/claude-code-mode/actions/workflows/ci.yml)
![Runtime](https://img.shields.io/badge/runtime-Bun-black)
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

The model gets back only the top five. The same idea appears elsewhere as "Code Mode". This version runs on any MCP client.

## Features

- **Two tools.** `run_script` runs code or a saved script. `save_script` saves a reusable action.
- **MCP proxy.** Calls any other MCP server as `mcp.<server>.<tool>(args)`, over stdio or HTTP.
- **Helpers and saved scripts.** Your own functions, loaded from a folder and listed for the model automatically.
- **Layered config.** A global layer plus a per-project layer. Nothing company-specific lives in the code.
- **Secrets out of files.** Use `${env:VAR}` and `${cmd:...}` in server env and headers.
- **Single binary.** Compiled with Bun, so there is no runtime to install.

> [!WARNING]
> There is no sandbox. Scripts run with your user's permissions and without permission prompts. Use it locally only.

## Quick start

Requires [Bun](https://bun.sh).

```bash
git clone git@github.com:sthbryan/claude-code-mode.git
cd claude-code-mode
./install.sh
```

The script builds `~/.local/bin/code-mode`, creates `~/.config/code-mode/servers.json` and registers the server in Claude Code at user scope. Open a new session to load it.

For any other MCP client, register the binary as a stdio server:

```json
{ "mcpServers": { "code-mode": { "command": "/Users/you/.local/bin/code-mode" } } }
```

## How it works

```
model ──run_script({code})──▶ code-mode ──▶ fs / grep / sh
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
| `grep(regex, {path, glob, ignoreCase, filesOnly, limit})` | ripgrep → `[{file, line, text}]` |
| `sh(cmd, {cwd, timeout, check})` | `bash -c` → `{code, stdout, stderr}` |
| `mcp.<server>.<tool>(args)` `mcp.call` `mcp.tools` `mcp.servers()` | Proxied MCP servers |
| `mcp.docs(server, filter)` | One-line tool signatures, cached in `~/.cache/code-mode/` |
| `scripts.run(name, args)` `scripts.<name>(args)` `scripts.list()` | Saved scripts |
| `help(keyword)` | Signatures of helpers and scripts |
| `config` `args` `console.log` `sleep` `path` `require` | Utilities |

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

Working examples live in [`examples/`](examples/): issue tracker, code host and local stack adapters, plus two scripts.

## CLI

```bash
code-mode --version
code-mode scripts                                # list saved scripts
code-mode run stack-status '{"all":true}'        # run a saved script
code-mode eval 'return (await fs.glob("**/*.ts")).length'
```

| Env | Default |
| --- | --- |
| `CODE_MODE_HOME` | `~/.config/code-mode` |
| `CODE_MODE_MAX_OUTPUT` | `20000` characters |

## Development

```bash
bun install
bun run dev         # run from source
bun run typecheck
bun run build       # bin/code-mode
```

Releases: bump `version` in `package.json`, then push a `vX.Y.Z` tag. The release workflow publishes binaries for macOS and Linux (arm64 and x64) with checksums.
