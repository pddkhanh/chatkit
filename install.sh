#!/usr/bin/env bash
# chatkit installer: checks what it needs, installs the Node dependencies and
# puts `chatkit` on your PATH. Safe to run again.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '%s\n' "$*"; }
need() { say "✗ $1"; say "  $2"; exit 1; }

[[ "$(uname)" == "Darwin" ]] || say "! chatkit is built and tested on macOS; the live services use launchd."

command -v node >/dev/null || need "Node.js is not installed." "Install Node 22 or newer: brew install node"
major="$(node -p 'process.versions.node.split(".")[0]')"
(( major >= 22 )) || need "Node $major is too old." "Install Node 22 or newer: brew install node"
say "✓ Node $(node -v)"

if command -v go >/dev/null; then
  say "✓ Go $(go version | awk '{print $3}') (needed for WhatsApp)"
else
  say "- Go is not installed. Only WhatsApp needs it: brew install go"
fi
if ! xcode-select -p >/dev/null 2>&1; then
  say "- Xcode command line tools are missing. WhatsApp needs them: xcode-select --install"
fi

say "Installing dependencies…"
npm install --no-audit --no-fund

if npm link >/dev/null 2>&1; then
  say "✓ \`chatkit\` is on your PATH"
else
  say "! Could not put chatkit on your PATH. Use: node $(pwd)/bin/chatkit.js"
fi

say ""
say "Next: chatkit setup"
