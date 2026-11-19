# code-mode

An MCP server where Claude writes async JavaScript that reads files, greps, runs shell and calls other MCP servers in a single call; only the returned value reaches the context. Same idea as Cloudflare Code Mode, opencode/pi codemode and Claude Code's experimental Code Mode, but it works on any surface (Desktop included).

Tools:

- `run_script({code})` runs a script; `run_script({script, args})` runs a saved one.
- `save_script({name, description, params, code})` saves an action to reuse later.

No sandbox and no permission prompts: scripts run with your user's rights. Local use only.

## Install

```bash
./install.sh
```

Builds a single binary with Bun, installs it to `~/.local/bin/code-mode` and registers it in Claude Code (`claude mcp add -s user`). Open a new session to pick up a new build.

## Nothing specific in code

code-mode knows nothing about your company, stack or tools. Everything specific is data in a layer folder:

| File | Holds |
| --- | --- |
| `servers.json` | MCP servers to proxy |
| `config.json` | Your settings (ports, org, team…), read by helpers and scripts as `config` |
| `lib/*.js` | Helpers: adapters that turn MCP/shell calls into simple functions, reading specifics from `config` |
| `scripts/*.js` | Saved actions: plain function bodies with a comment header |

Layers: global `~/.config/code-mode/` (or `$CODE_MODE_HOME`), then project `.code-mode/` found walking up from the cwd. The project layer wins: `config.json` deep-merges, servers, helpers and scripts override by name. Moving machines or tools means copying a folder or swapping one adapter file.

## Script API

All functions are async (`await` them). The cwd is the Claude Code project folder.

| Global | Does |
| --- | --- |
| `fs.read(path, {offset, limit})`, `fs.write`, `fs.edit(path, old, new, {all})`, `fs.exists`, `fs.glob(pattern)` | Files |
| `grep(regex, {path, glob, ignoreCase, filesOnly, limit})` | ripgrep, returns `{file, line, text}` |
| `sh(cmd, {cwd, timeout, check})` | `bash -c`, returns `{code, stdout, stderr}` |
| `mcp.docs(server, filter)` | One-line signatures, cached in `~/.cache/code-mode/` (`{refresh: true}` to reload) |
| `mcp.<server>.<tool>(args)`, `mcp.call`, `mcp.tools`, `mcp.servers()` | Other MCP servers |
| `scripts.run(name, args)`, `scripts.<name>(args)`, `scripts.list()` | Saved scripts |
| `config`, `args` | Merged settings; arguments of the current script |
| `console.log`, `sleep`, `path`, `require`, `process` | Utilities |

## Proxied MCP servers

`servers.json`, same shape as Claude Code's `mcpServers` (stdio `command`/`args`/`env`, or `url`/`headers`):

```json
{ "mcpServers": { "engram": { "command": "engram", "args": ["mcp", "--tools=agent"] } } }
```

Remote servers with OAuth go through `mcp-remote`, which opens the browser once and keeps the token:

```json
"linear": { "command": "npx", "args": ["-y", "mcp-remote", "https://mcp.linear.app/mcp"] }
```

Secrets stay out of the file: values in `env` and `headers` expand `${env:VAR}` and `${cmd:gh auth token}`. Servers that only accept approved clients (Slack, Google Workspace) don't work this way; keep using their claude.ai connectors.

## Helpers

Each `lib/*.js` is loaded at startup; its functions become script globals and are listed in the tool description:

```js
export const docs = { myPRs: "myPRs({state?}) -> [{repo, number, title, url}] // my PRs (org from config.codeHost)" };
export default ({ mcp, sh, fs, grep, config }) => ({
  myPRs: async ({ state = "open" } = {}) => { /* uses config.codeHost.org */ },
});
```

Examples in [`examples/lib/`](examples/lib/): `issues.js` (Linear: `myIssues`), `code-host.js` (GitHub: `myPRs`, `prsMentioning`), `stack.js` (`stackStatus`, `containerLogs`). Settings for all three: [`examples/config.example.json`](examples/config.example.json).

## Saved scripts

```js
// @description My issues with the PRs that mention each
// @param states string[]? issue states (default config.issues.activeStates)

const issues = await myIssues({ states: args.states ?? config.issues.activeStates });
return Promise.all(issues.map(async (i) => ({ id: i.id, prs: await prsMentioning(i.id) })));
```

Claude saves them with `save_script` when you ask or when a task repeats, and lists them in the tool description. Examples in [`examples/scripts/`](examples/scripts/).

## CLI

```bash
code-mode scripts                       # list saved scripts
code-mode run stack-status '{"all":true}'
code-mode eval 'return (await fs.glob("src/**/*.ts")).length'
```

## Env

- `CODE_MODE_HOME`: global layer folder (default `~/.config/code-mode`)
- `CODE_MODE_MAX_OUTPUT`: max characters returned (default 20000)
