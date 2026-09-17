#!/usr/bin/env bash
# Publish the pi-net-resume package to npm, with the checks that matter done
# before anything leaves the machine.
#
#   ./publish-package.sh              # verify only (default): no publish
#   ./publish-package.sh --publish    # verify, then npm publish
#   ./publish-package.sh --publish --dry-run
#
# Verify (and optionally publish) the pi-net-resume package, with the checks that
# matter done before anything leaves the machine.
#
#   ./publish-package.sh              # verify only (default): no publish
#   ./publish-package.sh --publish    # verify, then npm publish
#   ./publish-package.sh --publish --dry-run
#
# pkg/pi-net-resume/ is the single source of truth for the extension: it is both
# what npm publishes and what the tests import.  There used to be a second copy
# under pi-net-resume/ that this script "synced", which silently overwrote
# whichever copy you had just edited -- it destroyed a session's worth of work
# once.  If you find yourself wanting to add a sync step, delete a copy instead.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$REPO_DIR/pkg/pi-net-resume"
DO_PUBLISH=0
DRY_RUN=0

for arg in "$@"; do
    case "$arg" in
        --publish) DO_PUBLISH=1 ;;
        --dry-run) DRY_RUN=1 ;;
        -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

echo "== 1/6 package files present =="
for required in index.ts config.example.json pi-resume-run.sh README.md package.json LICENSE; do
    if [[ ! -f "$PKG_DIR/$required" ]]; then
        echo "  FAIL: missing $PKG_DIR/$required" >&2
        exit 1
    fi
done
echo "  ok: all required files in $(realpath --relative-to="$REPO_DIR" "$PKG_DIR")"

echo
echo "== 2/6 tests (must pass before anything ships) =="
python3 "$REPO_DIR/tests/test_wifi_fastlink.py" >/dev/null
echo "  wifi-fastlink: OK"
node --experimental-strip-types "$REPO_DIR/tests/test_net_resume.mjs" | tail -1

echo
echo "== 3/6 package.json sanity =="
python3 - "$PKG_DIR/package.json" <<'PY'
import json, re, sys

path = sys.argv[1]
pkg = json.load(open(path, encoding="utf-8"))
problems = []

if "pi-package" not in pkg.get("keywords", []):
    problems.append("missing the 'pi-package' keyword -> will not appear in the gallery")
if not re.fullmatch(r"\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?", pkg.get("version", "")):
    problems.append(f"version is not semver: {pkg.get('version')!r}")
pi = pkg.get("pi") or {}
if not pi.get("extensions"):
    problems.append("pi.extensions is empty -> nothing would load")
if not pkg.get("files"):
    problems.append("no 'files' whitelist -> the tarball would include everything")
if pkg.get("dependencies"):
    # pi core packages must be peers, not deps
    for name in pkg["dependencies"]:
        if name.startswith("@earendil-works/") or name == "typebox":
            problems.append(f"{name} must be in peerDependencies, not dependencies")

joined = json.dumps(pkg)
if "REPLACE_ME" in joined:
    problems.append("package.json still contains a REPLACE_ME placeholder (repository/homepage/bugs)")

if problems:
    print("  FAIL:")
    for problem in problems:
        print(f"    - {problem}")
    raise SystemExit(1)
print(f"  ok: {pkg['name']}@{pkg['version']}, {len(pkg.get('files', []))} entries in the files whitelist")
PY

echo
echo "== 4/6 the extension actually loads through jiti (how pi loads it) =="
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/load.mjs" <<'JS'
import { createJiti } from "jiti";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = process.argv[2];
const agent = mkdtempSync(join(tmpdir(), "publish-check-"));
process.env.PI_CODING_AGENT_DIR = agent;
delete process.env.PI_NET_RESUME_CONFIG;
// a config at the documented path must be picked up
writeFileSync(join(agent, "pi-net-resume.json"), JSON.stringify({ maxAutoResumes: 5, notify: false, logFile: "" }));

const mod = await createJiti(import.meta.url).import(target);
if (typeof mod.default !== "function") throw new Error("no default export function");

const commands = new Map(), notifications = [];
mod.default({
  on() {}, appendEntry() {},
  registerCommand: (n, o) => commands.set(n, o),
  exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
  sendUserMessage() {},
});
const ctx = { model: { baseUrl: "http://127.0.0.1:1/v1" }, isIdle: () => true,
  ui: { setStatus() {}, notify: (m) => notifications.push(m) } };
await commands.get("pi-net-resume").handler("", ctx);

const status = notifications.at(-1) ?? "";
if (!status.includes("0/5")) throw new Error(`config at <agent dir>/pi-net-resume.json was not read:\n${status}`);
if (!status.includes("pi-net-resume.json")) throw new Error(`config path not reported:\n${status}`);
console.log("  ok: loads, registers /net-resume, and reads the documented config path");
JS
# Fetch jiti the same way pi's own install does.  A failure here must be loud:
# without it the load check below cannot run, and a silent skip would turn this
# gate into a no-op that still reports success (e.g. on a runner with no network).
if ! (cd "$TMP" && npm install --silent --no-save jiti >/dev/null 2>&1); then
    echo "  FAIL: could not install jiti (needed to load the extension the way pi does)"
    exit 1
fi
node "$TMP/load.mjs" "$PKG_DIR/index.ts"

echo
echo "== 5/6 tarball contents =="
(cd "$PKG_DIR" && npm pack --dry-run 2>&1 | sed -n '/Tarball Contents/,/Tarball Details/p' | grep notice | sed 's/^npm notice /  /')
(cd "$PKG_DIR" && npm pack --dry-run 2>&1 | grep -qE "\.(json|ts|sh|md)$" ) || { echo "  FAIL: empty tarball"; exit 1; }
# Match files in the tarball listing, not the substring anywhere: "package.json"
# contains ".pi" as part of its name and must not trip the check.
TARBALL_FILES="$(cd "$PKG_DIR" && npm pack --dry-run 2>&1 | sed -n '/Tarball Contents/,/Tarball Details/p' | grep notice | sed 's/^npm notice //' | awk 'NF>1 && $1 ~ /B$/ {print $2}' | grep -v '^npm$' || true)"
if [[ -z "$TARBALL_FILES" ]]; then
    echo "  FAIL: could not read the tarball listing"; exit 1
fi
for forbidden in tests wifi-fastlink node_modules .pi/ .pi/extensions; do
    if grep -qE "(^|/)$forbidden|^$forbidden" <<<"$TARBALL_FILES"; then
        echo "  FAIL: tarball contains '$forbidden'"; exit 1
    fi
done
echo "  ok: no tests/, wifi-fastlink/, node_modules/ or .pi/ leakage"

echo
# A git install loads the *clone root*, and pi has no subdirectory syntax.  If the
# root manifest does not point at the extension, `pi install git:...` succeeds
# while loading nothing -- a silent failure worth guarding against.
if [[ -f "$REPO_DIR/package.json" ]]; then
    echo "== 5b/6 repo-root shim resolves for git installs =="
    python3 - "$REPO_DIR" <<'PY'
import json, os, sys

root = sys.argv[1]
manifest = json.load(open(os.path.join(root, "package.json"), encoding="utf-8"))
entries = (manifest.get("pi") or {}).get("extensions") or []
if not entries:
    print("  FAIL: repo-root package.json has no pi.extensions; "
          "`pi install git:...` would load nothing")
    raise SystemExit(1)
for rel in entries:
    # glob-free paths only, which is what a shim should use
    target = os.path.join(root, rel)
    if not os.path.isfile(target):
        print(f"  FAIL: repo-root pi.extensions entry does not resolve: {rel}")
        raise SystemExit(1)
    print(f"  ok: git install would load {rel}")
PY
else
    echo "== 5b/6 repo-root shim =="
    echo "  skipped (no package.json at the repo root)"
fi

echo
echo "== 6/6 publish =="
if (( DO_PUBLISH )); then
    if [[ -z "${NPM_TOKEN:-}" ]] && ! npm whoami >/dev/null 2>&1; then
        echo "  not logged in: run 'npm login' (or set NPM_TOKEN) first" >&2
        exit 1
    fi
    ARGS=()
    (( DRY_RUN )) && ARGS+=(--dry-run)
    (cd "$PKG_DIR" && npm publish "${ARGS[@]}")
else
    echo "  skipped (verify-only). Re-run with --publish to actually publish."
fi
