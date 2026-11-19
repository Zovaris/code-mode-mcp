# code-mode

An MCP server with one tool, `run_script`: Claude writes async JavaScript that reads files, greps, runs shell and calls other MCP servers in a single call, and only the returned value reaches the context. Same idea as Cloudflare Code Mode, opencode/pi codemode and Claude Code's experimental Code Mode, but it works on any surface (Desktop included).

No sandbox and no permission prompts: the script runs with your user's rights. Local use only.

## Install

```bash
./install.sh
```

Builds a single binary with Bun, installs it to `~/.local/bin/code-mode` and registers it in Claude Code (`claude mcp add -s user`). Open a new session to pick up a new build.

## Script API

All functions are async (`await` them). The cwd is the Claude Code project folder.

| Global | Does |
| --- | --- |
| `fs.read(path, {offset, limit})`, `fs.write`, `fs.edit(path, old, new, {all})`, `fs.exists`, `fs.glob(pattern)` | Files |
| `grep(regex, {path, glob, ignoreCase, filesOnly, limit})` | ripgrep, returns `{file, line, text}` |
| `sh(cmd, {cwd, timeout, check})` | `bash -c`, returns `{code, stdout, stderr}` |
| `mcp.docs(server, filter)` | One-line signatures, cached in `~/.cache/code-mode/` (`{refresh: true}` to reload) |
| `mcp.<server>.<tool>(args)`, `mcp.call`, `mcp.tools`, `mcp.servers()` | Other MCP servers |
| `console.log`, `sleep`, `path`, `require`, `process` | Helpers |

## Proxied MCP servers

`~/.config/code-mode/servers.json`, same shape as Claude Code's `mcpServers` (stdio `command`/`args`/`env`, or `url`/`headers`):

```json
{ "mcpServers": { "engram": { "command": "engram", "args": ["mcp", "--tools=agent"] } } }
```

Remote servers with OAuth go through `mcp-remote`, which opens the browser once and keeps the token:

```json
"linear": { "command": "npx", "args": ["-y", "mcp-remote", "https://mcp.linear.app/mcp"] }
```

Servers that only accept approved clients (Slack, Google Workspace) don't work this way; keep using their claude.ai connectors.

## Helpers

Every file in `~/.config/code-mode/lib/*.js` is loaded at startup and its functions become script globals, listed in the tool description so Claude uses them:

```js
export const docs = { myPRs: "myPRs({state?}) -> [{repo, number, title, url}] // my open PRs" };
export default ({ mcp, sh, fs, grep }) => ({
  async myPRs({ state = "open" } = {}) { /* ... */ },
});
```

Example: [`examples/lib/abaco.js`](examples/lib/abaco.js) (`myIssues`, `myPRs`, `prsForIssue`) and [`examples/lib/local-stack.js`](examples/lib/local-stack.js) (`localStack`, `stackLogs`). Copy them to `~/.config/code-mode/lib/`.

Secrets stay out of the config: values in `env` and `headers` expand `${env:VAR}` and `${cmd:gh auth token}`.

## Try it without Claude

```bash
code-mode eval 'return (await fs.glob("src/**/*.ts")).length'
```

## Env

- `CODE_MODE_CONFIG`: config path
- `CODE_MODE_MAX_OUTPUT`: max characters returned (default 20000)
