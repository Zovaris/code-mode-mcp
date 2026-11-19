#!/usr/bin/env bash
# Builds code-mode and installs it to ~/.local/bin, then registers it in Claude Code (user scope).
set -euo pipefail

cd "$(dirname "$0")"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
CONFIG="$HOME/.config/code-mode/servers.json"

command -v bun >/dev/null || { echo "bun is required: https://bun.sh" >&2; exit 1; }

bun install --frozen-lockfile >/dev/null
bun build --compile --minify src/index.ts --outfile bin/code-mode >/dev/null

mkdir -p "$BIN_DIR"
# Remove first: overwriting a signed binary in place makes macOS kill it on launch (exit 137).
rm -f "$BIN_DIR/code-mode"
cp bin/code-mode "$BIN_DIR/code-mode"
echo "installed $BIN_DIR/code-mode $("$BIN_DIR/code-mode" --version)"

if [ ! -f "$CONFIG" ]; then
  mkdir -p "$(dirname "$CONFIG")"
  echo '{ "mcpServers": {} }' > "$CONFIG"
  echo "created $CONFIG (add MCP servers to proxy)"
fi

if command -v claude >/dev/null; then
  if claude mcp get code-mode >/dev/null 2>&1; then
    echo "claude: code-mode already registered (open a new session to load the new binary)"
  else
    claude mcp add -s user code-mode "$BIN_DIR/code-mode" >/dev/null && echo "claude: registered code-mode (user scope)"
  fi
fi

case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "note: $BIN_DIR is not in PATH" ;; esac
