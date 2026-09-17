#!/usr/bin/env bash
# Undo ./install.sh (leaves logs and your config files in place).
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PKG="npm:pi-net-resume"
EXT_DEST="$AGENT_DIR/extensions/pi-net-resume"
CONFIG="$AGENT_DIR/pi-net-resume.json"
BIN="$HOME/.local/bin/pi-resume-run.sh"

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

run() {
    if (( DRY_RUN )); then echo "  [dry-run] $*"; else "$@"; fi
}

echo "== removing wifi-fastlink =="
if (( DRY_RUN )); then
    echo "  [dry-run] $SRC_DIR/wifi-fastlink/install.sh --uninstall"
else
    "$SRC_DIR/wifi-fastlink/install.sh" --uninstall
fi

echo
echo "== removing pi-net-resume extension =="
# Preferred path: let pi remove the package it installed.
if command -v pi >/dev/null 2>&1 && (( ! DRY_RUN )); then
    pi remove "$PKG" 2>/dev/null || echo "  $PKG was not installed via pi (nothing to remove)"
else
    echo "  [dry-run] pi remove $PKG"
fi
# A manual/legacy copy may still exist from an older install.
if [[ -f "$EXT_DEST/index.ts" ]]; then
    run rm -f "$EXT_DEST/index.ts" "$EXT_DEST/README.md" "$EXT_DEST/config.example.json"
    echo "  removed a manually installed copy from $EXT_DEST"
fi
if [[ -d "$EXT_DEST" ]] && [[ -z "$(ls -A "$EXT_DEST" 2>/dev/null)" ]]; then
    run rmdir "$EXT_DEST"
fi

if [[ -f "$CONFIG" ]]; then
    echo "  kept your config: $CONFIG (delete it manually if you want)"
fi
if [[ -f "$EXT_DEST/config.json" ]]; then
    echo "  kept your legacy config: $EXT_DEST/config.json"
fi

echo
echo "== removing pi-resume-run.sh =="
run rm -f "$BIN"

echo
echo "== retry tuning =="
LATEST=$(ls -1t "$AGENT_DIR"/settings.json.bak.* 2>/dev/null | head -1 || true)
if [[ -n "${LATEST:-}" ]]; then
    echo "  a settings backup exists: $LATEST"
    echo "  restore it with:  cp '$LATEST' '$AGENT_DIR/settings.json'"
else
    echo "  nothing to do"
fi

echo
echo "Done."
