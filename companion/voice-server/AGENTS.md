# AGENTS.md: local voice server

The root [AGENTS.md](../../AGENTS.md) applies; this file lists what differs here.

- **One Python file**, `server.py`, for Python 3.11 or newer, run as `python3 -I server.py`. It is not
  packaged. At import time it uses the standard library only; faster-whisper is imported when speech
  input is first used, and Piper (GPL) is only ever started as a separate program, never imported.
- **Tests** use a fake recognizer and a fake Piper program, so they need no models and no installed
  packages. From the repository root:
  `python3 -I -B -m unittest discover -s companion/voice-server -v`
- **Lint** with the ruff version that `.github/workflows/ci.yml` pins, from this folder:
  `ruff check --no-cache . && ruff format --check --no-cache .` (rules in `pyproject.toml`).
- **Allowlist.** `allowlist.json` must stay byte-identical to `api/_lib/voice-allowlist.json`
  (`node scripts/companion-license-check.mjs` checks it, with the licences of `requirements.txt`).
  Change both files together.
- **Privacy.** Audio, texts and transcripts are never stored or logged; a log line holds method,
  path, status, size and duration only. The server listens on loopback.
