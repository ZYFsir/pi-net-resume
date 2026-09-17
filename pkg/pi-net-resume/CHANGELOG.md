# Changelog

All notable changes to this project are documented here.
This project follows [Semantic Versioning](https://semver.org/).

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
