#!/usr/bin/env sh
# Installs the code-mode-mcp binary from the latest GitHub release. No Bun or Node needed.
#   curl -fsSL https://raw.githubusercontent.com/sthbryan/code-mode-mcp/main/install.sh | sh
# Env: VERSION=v1.0.0 (default latest), BIN_DIR=~/.local/bin
set -eu

REPO="sthbryan/code-mode-mcp"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
VERSION="${VERSION:-latest}"
CONFIG_DIR="${CODE_MODE_HOME:-$HOME/.config/code-mode}"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "unsupported OS: $(uname -s); use: npx -y @sthbryan/code-mode-mcp" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

asset="code-mode-mcp-$os-$arch"
if [ "$VERSION" = latest ]; then base="https://github.com/$REPO/releases/latest/download"
else base="https://github.com/$REPO/releases/download/$VERSION"; fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "downloading $asset ($VERSION)"
curl -fsSL "$base/$asset" -o "$tmp/$asset"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
(cd "$tmp" && grep " $asset\$" SHA256SUMS | shasum -a 256 -c - >/dev/null) || { echo "checksum mismatch" >&2; exit 1; }

mkdir -p "$BIN_DIR"
# Remove first: overwriting a signed binary in place makes macOS kill it on launch.
rm -f "$BIN_DIR/code-mode-mcp"
install -m 755 "$tmp/$asset" "$BIN_DIR/code-mode-mcp"
echo "installed $BIN_DIR/code-mode-mcp $("$BIN_DIR/code-mode-mcp" --version)"

if [ ! -f "$CONFIG_DIR/servers.json" ]; then
  mkdir -p "$CONFIG_DIR"
  echo '{ "mcpServers": {} }' > "$CONFIG_DIR/servers.json"
  echo "created $CONFIG_DIR/servers.json (add MCP servers to proxy)"
fi

case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "note: $BIN_DIR is not in PATH" ;; esac
cat <<MSG

Add it to your MCP client as a stdio server:
  { "mcpServers": { "code-mode": { "command": "$BIN_DIR/code-mode-mcp" } } }
MSG
