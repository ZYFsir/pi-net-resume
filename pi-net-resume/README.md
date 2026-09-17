# pi-net-resume

Auto-continue a pi session after a network outage.

## Why

pi retries a failed provider request `retry.maxRetries` times (default **3**,
backoff 2s / 4s / 8s — see `getRetrySettings()` / `DEFAULT_RETRY_POLICY` in the
pi bundle). A phone-hotspot outage almost always outlives that, and when the
retries are exhausted pi logs the error and just sits there: nothing will
happen until a human types something. If you are away from the keyboard (or the
SSH session died with the link), the task is silently stuck.

## What it does

| Step | Hook | Action |
| --- | --- | --- |
| 1 | `agent_end` | remember a failure whose assistant message has `stopReason: "error"` and a connectivity-class `errorMessage` |
| 2 | `agent_settled` | pi fires this only when *no* retry / compaction retry / queued continuation is left — i.e. it really gave up |
| 3 | polling | check NetworkManager state, then TCP-probe the model endpoint (`ctx.model.baseUrl`) until it answers |
| 4 | resume | `pi.sendUserMessage("The network is back… continue")` in the same session, which starts a fresh turn |

Because the continuation is a normal user message in the existing session, all
context (including tool results from before the outage) is preserved.

## Guards

* Only connectivity-class errors arm it (`errorPattern`), and quota / rate-limit
  / auth errors explicitly never do (`excludePattern`).
* `armOnlyWhenOffline` (default `true`): if the link is up when pi settles, the
  error was not an outage, so nothing is armed.
* Typing anything cancels a pending auto-resume.
* `stopReason: "aborted"` (Ctrl+C) never auto-resumes.
* Capped by `maxAutoResumes` and `maxWaitMinutes`, throttled by
  `minSecondsBetweenResumes`, and it never fires while pi is busy.
* Disable for one session with `/net-resume off`.

**Known limitation:** pressing `Escape` while pi waits between retries cancels
the retries; pi reports that identically to "retries exhausted", so if the link
is still down this extension may arm and later resume such a cancelled run.
Typing anything, or `/net-resume off`, cancels it.

## Install

```bash
../install.sh                     # installs the watcher and this extension
# or manually:
mkdir -p ~/.pi/agent/extensions/pi-net-resume
cp index.ts ~/.pi/agent/extensions/pi-net-resume/
```

Extensions in `~/.pi/agent/extensions/<name>/index.ts` are auto-discovered; use
`/reload` inside pi, or just start a new pi process. To try it without
installing:

```bash
pi -e ./index.ts
```

## Configure

```bash
cp config.example.json ~/.pi/agent/extensions/pi-net-resume/config.json
```

Most useful keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `continueMessage` | `The network is back… continue` | the prompt injected after a reconnect |
| `armOnlyWhenOffline` | `true` | only arm when the link is actually down |
| `maxAutoResumes` | `20` | hard cap on auto-resumes |
| `minSecondsBetweenResumes` | `15` | throttle between resumes |
| `maxWaitMinutes` | `120` | stop waiting after this long offline |
| `probeIntervalMs` | `3000` | poll cadence while waiting |
| `extraProbeHosts` | `[]` | additional `host:port` probes (taken literally; an IPv6 literal must be bracketed, `[::1]:443`) |
| `checkNetworkManager` | `true` | gate on `nmcli` before TCP probing |
| `notify` | `true` | desktop notification when resuming |
| `logFile` | `~/.local/state/pi-net-resume/pi-net-resume.log` | JSON-lines evidence log |

## Commands

| Command | Effect |
| --- | --- |
| `/net-resume` | status: armed/waiting, resumes used, link state, probe targets, config path |
| `/net-resume now` | force a resume immediately (if the link is up) |
| `/net-resume off` / `on` | disable/enable for this session |

## Verify it works

The JSON-lines log is the evidence trail:

```bash
tail -f ~/.local/state/pi-net-resume/pi-net-resume.log
```

Expected sequence for a real outage:

```
{"event":"network_error","message":"fetch failed"}
{"event":"armed","detail":"NetworkManager reports disconnected"}
{"event":"waiting_for_network", ...}
{"event":"auto_resume","resumeCount":1,"waitedMs":41300,"detail":"api.example.com:443 reachable"}
```

`PI_NET_RESUME_CONFIG=/path/to/config.json` overrides the config location, which
is handy for testing.

## Where the probe target comes from

No provider is hardcoded. The endpoint to probe is resolved in this order and
the first non-empty result wins:

1. **`ctx.model.baseUrl`** — the endpoint pi is actually configured to talk to
   (read from your resolved model, in the live session).
2. **`MODEL_BASE_URL`, `PI_BASE_URL`, `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`** —
   for self-hosted gateways configured through the environment.
3. **`extraProbeHosts`** in the config.
4. Nothing at all (e.g. a purely local `llama.cpp` without a base URL): the
   NetworkManager state alone decides.

Port handling matches what the URL means: `https://…` → 443, `http://…` → 80,
and an explicit `host:port` (or `[ipv6]:port`) is taken literally rather than
being rewritten to 443.

## Portability

| Requirement | Needed for | Without it |
| --- | --- | --- |
| pi (any platform) | everything | — |
| `nmcli` (Linux/NetworkManager) | the cheap "link is down" short-circuit | set `checkNetworkManager: false`; the extension falls back to TCP probing alone |
| `notify-send` | desktop notification | silently skipped |

The extension itself has no hardcoded host, path, or provider, and works on
macOS and Windows in TCP-probe-only mode.

## Headless runs

`pi -p` exits instead of sitting idle, so use the wrapper:

```bash
./pi-resume-run.sh --model <provider>/<model> "run the test suite and fix failures"
```

The **last argument** is the task prompt; everything before it is forwarded to
`pi` unchanged, so options and their values must come first. The wrapper
re-launches `pi -p --session-id <same id>` with a "continue" prompt whenever the
run failed while the link was down.

The probe target is **not hardcoded either**. `PI_RESUME_PROBE_HOST`/`_PORT` win
if set; otherwise `PI_RESUME_PROBE_URL`, then `MODEL_BASE_URL` /
`PI_BASE_URL` / `OPENAI_BASE_URL`, then the provider/model from your pi
`settings.json` + `models-store.json`, and finally `1.1.1.1:443`. Run it once and
it logs which target it picked (`probe target: host:port`).

### Where headless sessions live

The wrapper passes `--session-dir` so its session file goes to
`~/.local/state/pi-net-resume/sessions/`, **not** to
`~/.pi/agent/sessions/<project>/`. Set `PI_RESUME_SESSION_DIR` to move it.

This is deliberate. Reason, from the 2026-09-16 incident:

1. The wrapper used to write its session into the normal project session
directory — the same one the interactive session was using.
2. A cleanup-minded agent then saw "a test session file I just created", and
deleted **the whole project directory**, taking its own live transcript with it.
3. First attempt (`rm -rf ~/.pi/...`) was correctly denied by the permission
policy; the retry with an absolute path and `rm -r` matched no rule and was
approved, so the denial was bypassed by spelling alone.

Paying attention to the second point: a tool that writes into the session store
can cause an unrelated agent to destroy it. Nothing that is not pi itself should
write there, and the wrapper no longer does.
