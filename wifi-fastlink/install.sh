#!/usr/bin/env bash
# Install wifi-fastlink as a *user* systemd service (no sudo required).
#
#   ./install.sh              install / upgrade and (re)start
#   ./install.sh --uninstall  stop and remove
#
# Optional, if you want the watcher to keep running when nobody is logged in:
#   sudo loginctl enable-linger "$USER"
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="$HOME/.local/share/wifi-fastlink"
CONF_DIR="$HOME/.config/wifi-fastlink"
CONF_FILE="$CONF_DIR/config.json"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/wifi-fastlink.service"
STATE_DIR="$HOME/.local/state/wifi-fastlink"

if [[ "${1:-}" == "--uninstall" ]]; then
    systemctl --user disable --now wifi-fastlink.service 2>/dev/null || true
    rm -f "$UNIT_FILE"
    systemctl --user daemon-reload || true
    echo "wifi-fastlink removed (logs kept in $STATE_DIR, config kept in $CONF_FILE)"
    exit 0
fi

command -v nmcli >/dev/null || { echo "nmcli not found - is NetworkManager installed?" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 not found" >&2; exit 1; }

mkdir -p "$DEST_DIR" "$CONF_DIR" "$UNIT_DIR" "$STATE_DIR"
install -m 0755 "$SRC_DIR/wifi_fastlink.py" "$DEST_DIR/wifi_fastlink.py"
[[ -f "$SRC_DIR/README.md" ]] && install -m 0644 "$SRC_DIR/README.md" "$DEST_DIR/README.md"

# Write a config on first install, pre-filling the SSID we are on right now.
if [[ ! -f "$CONF_FILE" ]]; then
    install -m 0644 "$SRC_DIR/config.example.json" "$CONF_FILE"
    python3 - "$CONF_FILE" <<'PY'
import json, os, subprocess, sys

path = sys.argv[1]
config = json.load(open(path, encoding="utf-8"))
config.pop("_comment", None)
try:
    env = dict(os.environ, LC_ALL="C", LANG="C")
    out = subprocess.run(
        ["nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "dev", "status"],
        capture_output=True, text=True, env=env, timeout=10,
    ).stdout
    for line in out.splitlines():
        parts = line.split(":")
        if len(parts) >= 4 and parts[1] == "wifi" and parts[2] == "connected" and parts[3]:
            config["targets"] = [parts[3]]
            print(f"  detected current Wi-Fi network: {parts[3]}")
            break
    else:
        print("  no active Wi-Fi connection; targets left empty (auto-learn on first run)")
except Exception as exc:  # pragma: no cover - install-time convenience only
    print(f"  could not detect the current SSID ({exc}); edit {path} manually")
json.dump(config, open(path, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
open(path, "a", encoding="utf-8").write("\n")
PY
else
    echo "  keeping existing config: $CONF_FILE"
fi

PYTHON_BIN="$(command -v python3)"
install -m 0644 "$SRC_DIR/wifi-fastlink.service" "$UNIT_FILE"
# Render the interpreter path instead of hardcoding /usr/bin/python3, which does
# not exist on every distro (some ship /usr/local/bin/python3 or a pyenv shim).
sed -i "s|@PYTHON@|$PYTHON_BIN|" "$UNIT_FILE"
systemctl --user daemon-reload
# `enable --now` only *starts* the unit; on an upgrade it leaves the old process
# (with the old code) running, so restart explicitly.  This is a no-op first time.
systemctl --user enable wifi-fastlink.service
systemctl --user restart wifi-fastlink.service

echo
echo "wifi-fastlink installed."
echo "  config : $CONF_FILE"
echo "  unit   : $UNIT_FILE"
echo "  logs   : journalctl --user -u wifi-fastlink -f"
echo "           $STATE_DIR/wifi-fastlink.log"
echo
systemctl --user --no-pager --lines=5 status wifi-fastlink.service || true
if ! loginctl show-user "$USER" -p Linger --value 2>/dev/null | grep -q yes; then
    echo
    echo "note: linger is off, so this service runs only while you are logged in."
    echo "      for always-on behaviour:  sudo loginctl enable-linger $USER"
fi
