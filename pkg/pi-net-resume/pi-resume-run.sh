#!/usr/bin/env bash
# pi-resume-run.sh - run a headless pi task that survives network outages.
#
# The interactive extension (index.ts) covers long-lived pi sessions running in
# a terminal/tmux.  A `pi -p ...` (print mode) process, however, *exits* when the
# provider call fails after its retries, so it needs a wrapper that brings it
# back once the link returns.
#
# Usage:
#   pi-resume-run.sh [pi options...] "<prompt>"
#   PI_RESUME_SESSION_ID=my-task pi-resume-run.sh --model <provider>/<model> "summarise the repo"
#   pi-resume-run.sh --check-online        # probe only, exit 0 when reachable
#
# The LAST argument is the task prompt; everything before it is passed to pi
# unchanged (so options and their values must come first).
#
# Environment:
#   PI_RESUME_SESSION_ID       session id to reuse (default: pi-resume-<timestamp>)
#   PI_RESUME_SESSION_DIR      where the run's session is stored (default:
#                              ~/.local/state/pi-net-resume/sessions)
#   PI_RESUME_CONTINUE_PROMPT  prompt sent after a reconnect (English default)
#   PI_RESUME_MAX_ATTEMPTS     give up after this many relaunches (default 20)
#   PI_RESUME_MAX_WAIT_MIN     give up waiting for the link after N minutes (default 120)
#   PI_RESUME_PROBE_HOST/PORT  TCP probe target.  Default: derived from the
#                              provider pi is configured to use, else the
#                              MODEL_BASE_URL env var, else 1.1.1.1:443.
#
# The session deliberately lives in its own directory instead of the normal
# ~/.pi/agent/sessions store: a headless run must never look like a stray file
# in a live session's project directory (see README.md).
set -uo pipefail

SESSION_ID="${PI_RESUME_SESSION_ID:-pi-resume-$(date +%Y%m%d-%H%M%S)}"
SESSION_DIR="${PI_RESUME_SESSION_DIR:-$HOME/.local/state/pi-net-resume/sessions}"
CONTINUE_PROMPT="${PI_RESUME_CONTINUE_PROMPT:-The network is back (Wi-Fi reconnected). Continue the task from where it was interrupted; do not repeat steps that already completed.}"
MAX_ATTEMPTS="${PI_RESUME_MAX_ATTEMPTS:-20}"
MAX_WAIT_MIN="${PI_RESUME_MAX_WAIT_MIN:-120}"

# Resolve the probe target without hardcoding any provider.  Order:
#   1. explicit PI_RESUME_PROBE_HOST/PORT
#   2. MODEL_BASE_URL / OPENAI_BASE_URL style env vars
#   3. the provider/model pi itself is configured to use (settings + model store)
#   4. a public anycast address, so the check still means "the internet is up"
resolve_probe() {
  local url="${PI_RESUME_PROBE_URL:-}"
  if [[ -z "$url" ]]; then
    url="${MODEL_BASE_URL:-${PI_BASE_URL:-${OPENAI_BASE_URL:-}}}"
  fi
  if [[ -z "$url" && -z "${PI_RESUME_PROBE_HOST:-}" ]]; then
    url="$(python3 - <<'PY' 2>/dev/null
import json, os, sys

def load(path):
    try:
        with open(os.path.expanduser(path), encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None

agent = os.environ.get("PI_CODING_AGENT_DIR") or "~/.pi/agent"
settings = load(os.path.join(agent, "settings.json")) or {}
store = load(os.path.join(agent, "models-store.json")) or {}

provider = settings.get("defaultProvider")
model = settings.get("defaultModel")
if isinstance(store, dict):
    entries = store.get(provider) or {}
    models = entries.get("models") if isinstance(entries, dict) else None
    if isinstance(models, list):
        for entry in models:
            if isinstance(entry, dict) and entry.get("id") == model:
                print(entry.get("baseUrl") or "")
                sys.exit(0)
        for entry in models:
            if isinstance(entry, dict) and entry.get("baseUrl"):
                print(entry["baseUrl"])
                sys.exit(0)
    if isinstance(entries, dict) and entries.get("baseUrl"):
        print(entries["baseUrl"])
PY
)"
  fi
  local host="" port=""
  if [[ -n "$url" ]]; then
    # strip scheme, then path/query
    url="${url#*://}"
    url="${url%%/*}"
    host="${url%%:*}"
    if [[ "$url" == *:* ]]; then port="${url##*:}"; fi
  fi
  [[ -n "$host" ]] || host="1.1.1.1"
  [[ -n "$port" ]] || port="443"
  PROBE_HOST="${PI_RESUME_PROBE_HOST:-$host}"
  PROBE_PORT="${PI_RESUME_PROBE_PORT:-$port}"
}

# A TCP probe without bash's /dev/tcp (portable to any shell with python3).
probe_tcp() {
  python3 - "$PROBE_HOST" "$PROBE_PORT" <<'PY' 2>/dev/null
import socket, sys
host, port = sys.argv[1], int(sys.argv[2])
try:
    with socket.create_connection((host, port), timeout=5):
        raise SystemExit(0)
except OSError:
    raise SystemExit(1)
PY
}

if [[ $# -lt 1 ]]; then
  # print the leading comment block: everything from line 2 up to the first
  # line of actual code, so the range never drifts when the header is edited
  awk 'NR > 1 && /^#/ { print; next } NR > 1 { exit }' "$0"
  exit 2
fi

log() { printf '[pi-resume %s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }

resolve_probe
log "probe target: ${PROBE_HOST}:${PROBE_PORT}"

online() {
  local state
  if command -v nmcli >/dev/null 2>&1; then
    state="$(LC_ALL=C nmcli -t -f STATE general 2>/dev/null | cut -d: -f1)"
    if [[ "$state" == "disconnected" || "$state" == "asleep" ]]; then
      return 1
    fi
  fi
  probe_tcp
}

if [[ "${1:-}" == "--check-online" ]]; then
  if online; then
    echo "online (${PROBE_HOST}:${PROBE_PORT} reachable)"
    exit 0
  fi
  echo "offline (link state or ${PROBE_HOST}:${PROBE_PORT} unreachable)"
  exit 1
fi

wait_for_network() {
  local waited=0
  local limit=$((MAX_WAIT_MIN * 60))
  while ! online; do
    sleep 3
    waited=$((waited + 3))
    if (( waited % 60 == 0 )); then
      log "still offline (${waited}s)"
    fi
    if (( waited >= limit )); then
      log "network did not come back within ${MAX_WAIT_MIN} min"
      return 1
    fi
  done
  log "network is back"
}

attempt=1
PI_ARGS=("${@:1:$(($# - 1))}")   # everything but the last argument
prompt="${!#}"                  # the last argument is the task prompt
mkdir -p "$SESSION_DIR"
while :; do
  output="$(pi -p --session-dir "$SESSION_DIR" --session-id "$SESSION_ID" "${PI_ARGS[@]}" -- "$prompt" 2>&1)"
  rc=$?
  printf '%s\n' "$output"

  if (( rc == 0 )) && ! grep -qiE 'stopReason.*error|fetch failed|ENOTFOUND|EAI_AGAIN|socket hang up' <<<"$output"; then
    exit 0
  fi

  if online; then
    log "pi exited with rc=${rc} while the network is up - not relaunching"
    exit "${rc:-1}"
  fi

  attempt=$((attempt + 1))
  if (( attempt > MAX_ATTEMPTS )); then
    log "giving up after ${MAX_ATTEMPTS} attempts"
    exit 1
  fi
  log "run failed offline (rc=${rc}); waiting to resume (attempt ${attempt}/${MAX_ATTEMPTS})"
  wait_for_network || exit 1
  prompt="$CONTINUE_PROMPT"
done
