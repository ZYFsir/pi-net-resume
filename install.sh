#!/usr/bin/env bash
# Install both halves of the "hotspot drops, work continues" setup.
#
#   ./install.sh                  install / upgrade everything
#   ./install.sh --no-retry-tuning
#                                 do not touch ~/.pi/agent/settings.json
#   ./install.sh --dry-run        show what would happen, change nothing
#
# Nothing here needs sudo.  The only optional privileged step is printed at the
# end (loginctl enable-linger) and is needed only to keep the watcher running
# while nobody is logged in.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
EXT_DEST="$AGENT_DIR/extensions/pi-net-resume"
BIN_DIR="$HOME/.local/bin"
RETRY_TUNING=1
DRY_RUN=0

for arg in "$@"; do
    case "$arg" in
        --no-retry-tuning) RETRY_TUNING=0 ;;
        --dry-run) DRY_RUN=1 ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

run() {
    if (( DRY_RUN )); then
        echo "  [dry-run] $*"
    else
        "$@"
    fi
}

echo "== 1/4 wifi-fastlink (NetworkManager fast reconnect) =="
if (( DRY_RUN )); then
    echo "  [dry-run] $SRC_DIR/wifi-fastlink/install.sh"
else
    "$SRC_DIR/wifi-fastlink/install.sh"
fi

echo
echo "== 2/4 pi-net-resume extension =="
run mkdir -p "$EXT_DEST"
run install -m 0644 "$SRC_DIR/pi-net-resume/index.ts" "$EXT_DEST/index.ts"
run install -m 0644 "$SRC_DIR/pi-net-resume/README.md" "$EXT_DEST/README.md"
if [[ ! -f "$EXT_DEST/config.json" ]]; then
    run install -m 0644 "$SRC_DIR/pi-net-resume/config.example.json" "$EXT_DEST/config.json"
    (( DRY_RUN )) || echo "  wrote default config: $EXT_DEST/config.json"
else
    echo "  keeping existing config: $EXT_DEST/config.json"
fi
echo "  extension installed in $EXT_DEST (auto-discovered by pi)"

echo
echo "== 3/4 pi-resume-run.sh (headless wrapper) =="
run mkdir -p "$BIN_DIR"
run install -m 0755 "$SRC_DIR/pi-net-resume/pi-resume-run.sh" "$BIN_DIR/pi-resume-run.sh"
echo "  installed $BIN_DIR/pi-resume-run.sh"
case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "  note: $BIN_DIR is not on PATH; add it or call the script by full path" ;;
esac

echo
echo "== 4/4 pi retry tuning =="
if (( RETRY_TUNING )); then
    if (( DRY_RUN )); then
        echo "  [dry-run] would raise retry.maxRetries to 6 in $AGENT_DIR/settings.json"
    else
        python3 - "$AGENT_DIR/settings.json" <<'PY'
import json, os, shutil, sys, time

path = sys.argv[1]
if not os.path.exists(path):
    print(f"  {path} does not exist, skipping")
    raise SystemExit(0)

with open(path, encoding="utf-8") as fh:
    original = fh.read()
try:
    settings = json.loads(original)
except json.JSONDecodeError as exc:
    print(f"  {path} is not valid JSON ({exc}), skipping")
    raise SystemExit(0)

retry = settings.get("retry") or {}
if retry.get("maxRetries") == 6:
    print("  retry.maxRetries is already 6, nothing to do")
    raise SystemExit(0)

backup = f"{path}.bak.{time.strftime('%Y%m%d_%H%M%S')}"
shutil.copy2(path, backup)
before = retry.get("maxRetries", 3)
retry["maxRetries"] = 6
retry.setdefault("baseDelayMs", 2000)
settings["retry"] = retry
tmp = f"{path}.tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(settings, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
os.replace(tmp, path)
print(f"  retry.maxRetries: {before} -> 6 (backup: {backup})")
print("  pi now rides out ~2 minutes of outage by itself before the extension takes over")
PY
    fi
else
    echo "  skipped (--no-retry-tuning)"
fi

echo
echo "Done."
echo "  watch the wifi timeline : tail -f ~/.local/state/wifi-fastlink/wifi-fastlink.log"
echo "  watch the resume log    : tail -f ~/.local/state/pi-net-resume/pi-net-resume.log"
echo "  test procedure          : $SRC_DIR/TESTING.md"
