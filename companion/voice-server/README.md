# Starpi local voice server

Dictation and read-aloud that never leave your machine. One Python file, `server.py`, answers on
`127.0.0.1:8000` with the OpenAI-shaped speech routes the Starpi app and the companion's voice
relay already speak:

| Route | Body | Answer |
| --- | --- | --- |
| `GET /health` | | `{ status, version, stt: { ready, model }, tts: { ready, voices } }` |
| `GET /v1/models` | | `{ object: "list", data: [{ id }] }` |
| `GET /v1/audio/voices` | | `{ voices: [{ id, name, language, license }] }`: installed voices that are on `allowlist.json` |
| `POST /v1/audio/transcriptions` | multipart: `file` (16-bit PCM WAV), `model`, `language`, `prompt`, `glossary`, `response_format` (`json` or `text`) | `{ text }` or plain text |
| `POST /v1/audio/speech` | JSON `{ model, input, voice, response_format: "wav", speed }` | `audio/wav` |

- **Speech input** runs [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (MIT) in the
  server's process. The model is loaded once at start and is never downloaded at run time unless
  you pass `--allow-download`.
- **Speech output** runs [Piper](https://github.com/OHF-Voice/piper1-gpl) (GPL-3.0-or-later) as a
  separate program for each request: the text goes in on stdin, raw PCM comes out on stdout. The
  server never imports Piper and Piper never opens a port.
- **Voices** are offered only when they are installed *and* listed in `allowlist.json`, which is
  the app's own list (`api/_lib/voice-allowlist.json`, kept byte-identical by a test): Piper
  voices whose training data allow any use and that were trained from scratch or from a listed
  voice.

## Install

Python 3.11 or newer.

```sh
python3 -m venv ~/.local/share/starpi-voice/venv
~/.local/share/starpi-voice/venv/bin/python -m pip install -r requirements.txt

# Voices: download the ones you want into the voices folder (ids from allowlist.json).
~/.local/share/starpi-voice/venv/bin/python -m piper.download_voices en_US-ljspeech-medium de_DE-mls-medium \
  --download-dir ~/.local/share/starpi-voice/voices

# First start fetches the Whisper model once; later starts work offline.
~/.local/share/starpi-voice/venv/bin/python -I server.py --allow-download
```

On macOS the default home is `~/Library/Application Support/starpi-voice`; `STARPI_VOICE_HOME`
moves it on every system. `--whisper-model` takes a faster-whisper size (`base`, `small`,
`medium`, `large-v3`, ...) or a folder with a converted model.

Then open Starpi, Settings > Voice, and enter `http://127.0.0.1:8000` as the local voice server.

## Glossary

The app sends your own vocabulary (Settings > Voice > glossary) twice: as the free `prompt`, which
any OpenAI-style server understands, and as the `glossary` field, one term per line:

```text
Kubernetes
pnpm
focaccia
```

The server hands glossary terms to Whisper as hotwords first, in your order, and the rest of the
prompt after them, both within a budget of 120 tokens. Whisper shares its decoder window between
these hints and the transcript, so a short budget keeps long dictations whole. Terms that do not
fit are left out, never the transcript.

Hints are never a reason to refuse a dictation: `prompt` and `glossary` longer than 1,000
characters are cut after their last whole term (the app sends at most 60 terms of 600 characters
together, joined with commas or line breaks, which stays below that).

## Browsers, origins and the private network

Only `127.0.0.1` is bound. Every request must name `127.0.0.1:<port>`, `localhost:<port>` or
`[::1]:<port>` as its `Host` (otherwise 421), so a DNS name rebound to loopback gets nothing.

Browsers send an `Origin` header. The server answers only the origins you allow:

```sh
python -I server.py --allow-origin https://chat.example.org --allow-origin http://localhost:3000
```

`https://www.starpi.app` is allowed unless you pass `--no-default-origin`; `STARPI_VOICE_ORIGINS`
adds a comma-separated list. Answers name exactly the calling origin
(`Access-Control-Allow-Origin`, `Vary: Origin`). Preflights from a public site to loopback carry
`Access-Control-Request-Private-Network: true` and get `Access-Control-Allow-Private-Network:
true`; recent Chrome versions may ask you once to allow access to devices on your network. Any
other origin gets 403 without CORS headers. Clients without an `Origin` (the companion's relay,
scripts) are served as they are.

## Limits and refusals

- Audio: 16-bit PCM WAV, mono or stereo, 8 to 48 kHz, at most 2 MiB (the app records at most 60 s
  of 16 kHz mono). Other formats get 400 rather than a general-purpose decoder.
- Speech input: at most 600 characters, a letter or digit somewhere (punctuation alone gives no
  audio), no control characters, valid Unicode; `speed` from 0.25 to 4; `wav` only.
- Bodies need `Content-Length` (chunked uploads get 501) and must arrive within 15 s. JSON must not
  repeat keys or contain `NaN`; forms may have at most 16 parts, no nested multipart, and each
  known field once.
- One recognition and two syntheses run at a time; a few more wait in order of arrival, at most
  20 s, then 429 with `Retry-After`.
- Errors are `{ "error": { "code", "message" } }` with a stable snake_case `code`.

## Privacy

Audio, texts and transcripts are never stored and never logged. The log holds method, path,
status, size and duration. Piper gets a minimal environment (no API keys of yours) and its own
output is discarded unread.

## Tests

```sh
python3 -I -B -m unittest discover -s companion/voice-server -v
```

The tests use a fake recognizer and a fake Piper program, so no model is needed. With
`STARPI_VOICE_MODELS=<voice home>` (holding `whisper/` and `voices/`) one more test runs against the
real models.

## Licence

`server.py` and its tests are MIT, like the rest of Starpi. faster-whisper is MIT; Piper is
GPL-3.0-or-later and is run as an independent program, never linked or imported. Each voice keeps
the licence named in `allowlist.json`; check its model card before you add one.
