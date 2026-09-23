#!/usr/bin/env bash
# Build the extension and package it as a VSIX in build/.
#
#   ./build.sh                 build + package
#   ./build.sh --check         also run typecheck and the unit tests first
#   ./build.sh --install [...] then install the VSIX with the `code` CLI; any
#                              extra arguments are passed to `code`, e.g.
#                              ./build.sh --install --profile "Flexnet"
#
# The VSIX itself is profile-agnostic; which VS Code profile it lands in is
# decided at install time (Extensions view → "Install from VSIX…", or the
# --profile flag of `code --install-extension`).
set -euo pipefail
cd "$(dirname "$0")"

check=0
install=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) check=1; shift ;;
    --install) install=1; shift; break ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ -d node_modules ]] || npm ci
if [[ $check -eq 1 ]]; then
  npm run typecheck
  npm test
fi
npm run package

name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")
vsix="build/${name}-${version}.vsix"
echo
echo "VSIX: $PWD/$vsix"

if [[ $install -eq 1 ]]; then
  if ! command -v code >/dev/null 2>&1; then
    echo "The 'code' CLI is not on PATH (VS Code: Shell Command: Install 'code' command in PATH)." >&2
    exit 1
  fi
  code --install-extension "$vsix" "$@"
else
  echo "Install with: code --install-extension $vsix   (add --profile <name> to target a profile)"
fi
