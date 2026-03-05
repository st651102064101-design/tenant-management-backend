#!/bin/zsh
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

NPM_BIN="$(ls -1d "$HOME"/.nvm/versions/node/*/bin/npm(N) | tail -n 1)"
if [[ -z "$NPM_BIN" ]]; then
	NPM_BIN="$(command -v npm)"
fi

if [[ -z "$NPM_BIN" ]]; then
	echo "npm not found" >&2
	exit 127
fi

NODE_BIN_DIR="$(dirname "$NPM_BIN")"
export PATH="$NODE_BIN_DIR:$PATH"

cd /Users/kriang/tenant-management-backend || exit 1
"$NPM_BIN" start
