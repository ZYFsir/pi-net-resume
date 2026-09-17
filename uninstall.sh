#!/usr/bin/env bash
# Undo ./install.sh (leaves logs and your config files in place).
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
EXT_DEST="$AGENT_DIR/extensions/pi-net-resume"
BIN="$HOME/.local/bin/pi-resume-run.sh"

echo "== removing wifi-fastlink =="
"$SRC_DIR/wifi-fastlink/install.sh" --uninstall

echo
echo "== removing pi-net-resume extension =="
rm -f "$EXT_DEST/index.ts" "$EXT_DEST/README.md"
rm -f "$EXT_DEST/config.example.json"
if [[ -d "$EXT_DEST" ]] && [[ -z "$(ls -A "$EXT_DEST" 2>/dev/null)" ]]; then
    rmdir "$EXT_DEST"
fi
echo "  kept your config: $EXT_DEST/config.json (delete it manually if you want)"

echo
echo "== removing pi-resume-run.sh =="
rm -f "$BIN"

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
