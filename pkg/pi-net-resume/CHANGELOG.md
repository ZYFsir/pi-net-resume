# Changelog

All notable changes to this project are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-09-17

Invisible continuation, adapted from
[pi-invisible-continue](https://github.com/monotykamary/pi-invisible-continue)
(MIT) — the idea, not the dependency.

- `resumeStyle` (new, default `hybrid`): the resumed turn is now started by a
  hidden custom marker that the extension removes in the `context` hook, so the
  model sees no new prompt text at all. `hybrid` still shows a note in the
  transcript for the human; `hidden` shows nothing; `visible` restores the old
  behaviour of sending `continueMessage` as a real user message.
- The failed attempts that led to the resume (one empty assistant message per
  exhausted retry) are now stripped from that request, so the outage is not
  re-served to the model. Guards: an attempt carrying tool calls is kept (its
  results must stay paired) and the context is never emptied.
- Both rewrites happen only on a turn this extension started: a `context` event
  without our marker is returned untouched, so pi's own retries and compaction
  are unaffected.
- Fixed: the deny rule added to this repo's permission config used
  `rm *sessions*`, which blocked any path containing that word — including a
  project's own `sessions/` directory.

## [1.0.0] - 2026-09-16

Initial release.

- Arms on a connectivity-class provider error and resumes the same session once
  the link is back, keeping the full conversation context.
- Refuses to act on quota / rate-limit / auth errors (`excludePattern`), never
  resumes a user-aborted turn, and is cancelled by any interactive input.
- Probe target is derived from `ctx.model.baseUrl` (or `MODEL_BASE_URL` /
  `OPENAI_BASE_URL`), so no provider is hardcoded.
- Configurable via a JSON file; `/net-resume` reports status and supports
  `now` / `on` / `off`.
- Optional headless wrapper (`pi-resume-run.sh`) for `pi -p` runs, which exit
  instead of waiting.
