#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Starpi local voice server: dictation and read-aloud on your own machine.

The Starpi app (Settings > Voice > local voice server) and the companion's voice relay talk to it
over the OpenAI-shaped routes they already use for cloud speech:

  GET  /health                   readiness of both engines
  GET  /v1/models                the recognition model and "piper"
  GET  /v1/audio/voices          Piper voices that are installed AND on allowlist.json
  POST /v1/audio/transcriptions  multipart/form-data: file (WAV), model, language, prompt,
                                 glossary, response_format (json | text)  ->  {"text": ...}
  POST /v1/audio/speech          JSON {model, input, voice, response_format: "wav", speed}
                                 ->  audio/wav

Speech input runs faster-whisper (MIT) in this process; the model is loaded once and never
downloaded unless --allow-download is given. Speech output runs Piper's own command line
(piper-tts, GPL-3.0-or-later) as a separate program per request: text on stdin, raw PCM on stdout.
This file never imports Piper, and Piper never opens a port.

The optional `glossary` form field carries the user's own vocabulary, one term per line (for
example "Kubernetes", "pnpm", "focaccia"). Its terms go to Whisper as hotwords ahead of the free
`prompt`, both within a small token budget, so the hints never crowd out the transcript.

Only 127.0.0.1 is bound. A request whose Host header is not this address (or localhost) with this
port gets 421, which keeps rebound DNS names out. Requests from browsers carry an Origin header;
only the origins listed with --allow-origin (and https://www.starpi.app unless
--no-default-origin) get an answer, with CORS headers naming exactly that origin and the
Private Network Access preflight answered. Requests without Origin (the companion, scripts) pass.

Audio, texts and transcripts are never stored and never logged; the log holds method, path,
status, size and duration.

Usage:  python3 -I server.py [--port 8000] [--whisper-model small] [--voices-dir DIR]
        python3 -I server.py --help
"""

from __future__ import annotations

# Standard library only at import time; the speech engines load when first used.

import argparse
import contextlib
import http.server
import io
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
import wave
from collections import deque
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from signal import SIGINT, SIGTERM
from signal import signal as on_signal
from socket import create_connection
from typing import Any, Protocol
from unicodedata import category as char_category
from unicodedata import normalize as unicode_normalize
from urllib.parse import urlsplit

VERSION = "1.0.0"
HOST = "127.0.0.1"
DEFAULT_PORT = 8000
DEFAULT_ORIGINS = ("https://www.starpi.app",)
HERE = Path(__file__).resolve().parent
DEFAULT_ALLOWLIST = HERE / "allowlist.json"

log = logging.getLogger("starpi-voice")


# ==== limits ====


@dataclass(frozen=True)
class Limits:
    """Sizes and times every request is held to. The app records at most 60 s of 16 kHz PCM16
    (1.92 MB) and splits speech below 600 characters, so these leave room without inviting abuse.

    The spelling hints (`prompt`, `glossary`) are cut, never refused: a longer hint loses its
    last terms, not the dictation. The app sends up to 60 terms of 600 characters together, joined
    with ", " and line breaks, which stays below the cut; only the token budget of plan_prompt
    decides what reaches Whisper."""

    audio_bytes: int = 2 * 1024 * 1024
    form_overhead: int = 64 * 1024
    json_bytes: int = 16 * 1024
    form_parts: int = 16
    speak_chars: int = 600
    prompt_chars: int = 1000
    glossary_chars: int = 1000
    glossary_terms: int = 60
    transcript_chars: int = 4000
    field_chars: int = 100
    body_seconds: float = 15.0
    socket_seconds: float = 30.0
    prompt_tokens: int = 120
    connections: int = 32

    @property
    def form_bytes(self) -> int:
        return self.audio_bytes + self.form_overhead


SPEED_RANGE = (0.25, 4.0)
SPEECH_MODELS = frozenset({"piper", "tts-1", "tts-1-hd"})
RETRY_AFTER_S = 5
# Segments Whisper itself rates as probably silence or noise are left out of the transcript.
NO_SPEECH_LIMIT = 0.6


# ==== errors ====


class HttpError(Exception):
    """An answer other than success: a status, a stable snake_case code and a message for logs."""

    def __init__(self, status: int, code: str, message: str, headers: Sequence[tuple[str, str]] = ()) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.headers = tuple(headers)


def bad_request(code: str, message: str) -> HttpError:
    return HttpError(400, code, message)


class EngineFailure(Exception):
    """An engine could not do its work; status is 502 (failed), 503 (not ready) or 504 (too slow)."""

    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


# ==== text checks ====

# C0 controls except tab and line breaks, DEL and the C1 block.
CONTROL_CHARS = re.compile("[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]")
TERM_SEPARATORS = re.compile(r"[\r\n,;]+")


def checked_text(value: Any, name: str, limit: int, *, required: bool = False) -> str | None:
    """A text field: a string of at most `limit` characters that encodes as UTF-8 (JSON can carry
    lone surrogates) and holds no control characters. None when it is absent and not required."""
    if value is None or value == "":
        if required:
            raise bad_request("missing_field", f"{name} is required")
        return None
    if not isinstance(value, str):
        raise bad_request("invalid_field", f"{name} must be a string")
    if len(value) > limit:
        raise bad_request("too_long", f"{name} has more than {limit} characters")
    # A lone surrogate (from a broken JSON escape) cannot be written out as UTF-8.
    if any(0xD800 <= ord(ch) <= 0xDFFF for ch in value):
        raise bad_request("invalid_text", f"{name} is not valid Unicode")
    if CONTROL_CHARS.search(value):
        raise bad_request("invalid_text", f"{name} holds control characters")
    return value


def has_letter_or_digit(text: str) -> bool:
    """True when the text holds something a voice can say: a letter or a digit once compatibility
    forms are folded (NFKC). Punctuation, spaces and invisible characters alone give no audio."""
    folded = unicode_normalize("NFKC", text)
    return any(char_category(c).startswith(("L", "N")) for c in folded)


def split_terms(text: str | None, limit: int) -> list[str]:
    """The terms of a list a person typed: one per line, or separated by commas or semicolons.
    Inner whitespace is collapsed, empty terms and repeats (ignoring case) are dropped, and at
    most `limit` terms are kept, in the order given."""
    seen: set[str] = set()
    terms: list[str] = []
    for raw in TERM_SEPARATORS.split(text or ""):
        term = " ".join(raw.split())
        key = term.casefold()
        if term and key not in seen:
            seen.add(key)
            terms.append(term)
            if len(terms) == limit:
                break
    return terms


def clip_terms(text: str, limit: int) -> str:
    """At most `limit` characters of a term list, cut after the last whole term: a term that
    would cross the limit is dropped with everything after it, never split."""
    if len(text) <= limit:
        return text
    ends = [m.start() for m in TERM_SEPARATORS.finditer(text, 0, limit + 1)]
    return text[: ends[-1]] if ends else ""


# ==== spelling hints ====


@dataclass(frozen=True)
class PromptPlan:
    """What a request hands Whisper besides the audio."""

    initial_prompt: str | None = None
    hotwords: str | None = None


TokenCounter = Callable[[str], int]


def utf8_cost(text: str) -> int:
    """Token estimate without a tokenizer: every UTF-8 byte counts as a token, which a byte-level
    tokenizer never exceeds, so the budget holds either way."""
    return len(text.encode("utf-8"))


def plan_prompt(
    prompt: str | None, glossary: str | None, count: TokenCounter | None, budget: int, max_terms: int
) -> PromptPlan:
    """Spelling hints of one request within `budget` tokens for both fields together.

    The glossary is the user's own vocabulary, so its terms come first: they go to `hotwords` in
    the user's order while they fit. The free `prompt` goes to `initial_prompt` without the terms
    the glossary already carries, piece by piece from its start, and stops at the first piece that
    no longer fits. Whisper shares its decoder window between the hints and the transcript; a
    small budget keeps most of it for what was said. Both fields are measured the way they are
    encoded, with a leading space."""
    cost = count or utf8_cost

    def size(parts: list[str]) -> int:
        return cost(" " + ", ".join(parts)) if parts else 0

    words = split_terms(glossary, max_terms)
    hot: list[str] = []
    for term in words:
        if size([*hot, term]) <= budget:
            hot.append(term)
    left = budget - size(hot)
    known = {term.casefold() for term in words}
    pieces = [p for p in split_terms(prompt, 200) if p.casefold() not in known]
    kept: list[str] = []
    for piece in pieces:
        if size([*kept, piece]) > left:
            break
        kept.append(piece)
    return PromptPlan(initial_prompt=", ".join(kept) or None, hotwords=", ".join(hot) or None)


# ==== voice allowlist ====

VOICE_ID = re.compile(r"[a-z]{2,3}_[A-Z]{2}-[a-z0-9_]+-(?:x_low|low|medium|high)")
LANG_TAG = re.compile(r"[a-z]{2,3}-[A-Z]{2}")
# Licences of the voices' training data that allow any use; anything else (non-commercial,
# no-derivatives, research-only, unknown) keeps a voice off the list.
OPEN_LICENSES = frozenset({"CC0-1.0", "CC-BY-4.0", "MIT", "Apache-2.0", "LicenseRef-public-domain"})


@dataclass(frozen=True)
class AllowedVoice:
    id: str
    label: str
    lang: str
    license: str


def entry_problems(entry: Any, ids: set[str]) -> list[str]:
    """Why an allowlist entry is refused; empty when it is accepted. `ids` holds every id of the
    list, so a fine-tuned voice must name a base that is listed too."""
    if not isinstance(entry, dict):
        return ["not an object"]
    problems: list[str] = []
    if not isinstance(entry.get("id"), str) or not VOICE_ID.fullmatch(entry["id"]):
        problems.append("id")
    label = entry.get("label")
    if not isinstance(label, str) or not 0 < len(label.strip()) <= 60:
        problems.append("label")
    if not isinstance(entry.get("lang"), str) or not LANG_TAG.fullmatch(entry["lang"]):
        problems.append("lang")
    if entry.get("license") not in OPEN_LICENSES:
        problems.append("license")
    card = entry.get("card")
    if not isinstance(card, str) or not card.startswith("https://"):
        problems.append("card")
    base = entry.get("base")
    if base is not None and (base not in ids or base == entry.get("id")):
        problems.append("base")
    return problems


def load_allowlist(path: Path) -> dict[str, AllowedVoice]:
    """The accepted voices of an allowlist file by id; refused entries are logged and skipped."""
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    entries = raw.get("voices") if isinstance(raw, dict) else None
    if not isinstance(entries, list):
        raise ValueError(f"{path}: the file needs a top-level 'voices' array")
    ids = {e["id"] for e in entries if isinstance(e, dict) and isinstance(e.get("id"), str)}
    voices: dict[str, AllowedVoice] = {}
    for entry in entries:
        problems = entry_problems(entry, ids)
        if problems:
            name = entry.get("id") if isinstance(entry, dict) else entry
            log.warning("allowlist: %r refused (%s)", name, ", ".join(problems))
            continue
        voices[entry["id"]] = AllowedVoice(entry["id"], entry["label"].strip(), entry["lang"], entry["license"])
    return voices


# ==== audio ====


def check_wav(data: bytes) -> None:
    """Accepts PCM WAV only (mono or stereo, 16-bit, 8 to 48 kHz, at least one frame). The app
    sends 16 kHz mono; other containers are refused rather than handed to a general decoder."""
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise bad_request("invalid_audio", "file is not a WAV file")
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            channels, width, rate, frames = wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getnframes()
    except (wave.Error, EOFError):
        raise bad_request("invalid_audio", "file is not a PCM WAV file") from None
    if channels not in (1, 2) or width != 2 or not 8000 <= rate <= 48000 or frames == 0:
        raise bad_request("invalid_audio", "WAV must be 16-bit PCM, mono or stereo, 8-48 kHz, not empty")


def wav_from_pcm(pcm: bytes, rate: int) -> bytes:
    """Raw 16-bit mono samples (what Piper writes with --output-raw) in a WAV container."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setparams((1, 2, rate, len(pcm) // 2, "NONE", "not compressed"))
        writer.writeframes(pcm)
    return buffer.getvalue()


# ==== turns ====


class Gate:
    """At most `slots` jobs of one kind run at a time and at most `waiting` more wait for a turn,
    served strictly in order of arrival. A job that waits longer than `wait_s`, or finds the line
    full, gets 429 with Retry-After."""

    def __init__(self, slots: int, waiting: int, wait_s: float, kind: str) -> None:
        self.slots = slots
        self.waiting = waiting
        self.wait_s = wait_s
        self.kind = kind
        self._running = 0
        self._line: deque[object] = deque()
        self._cond = threading.Condition()

    def _busy(self) -> HttpError:
        return HttpError(429, "busy", f"{self.kind} is busy", [("Retry-After", str(RETRY_AFTER_S))])

    @contextlib.contextmanager
    def turn(self) -> Iterator[None]:
        ticket = object()
        with self._cond:
            if (self._line or self._running >= self.slots) and len(self._line) >= self.waiting:
                raise self._busy()
            self._line.append(ticket)
            deadline = time.monotonic() + self.wait_s
            while self._line[0] is not ticket or self._running >= self.slots:
                left = deadline - time.monotonic()
                if left <= 0:
                    self._line.remove(ticket)
                    self._cond.notify_all()
                    raise self._busy()
                self._cond.wait(left)
            self._line.popleft()
            self._running += 1
            self._cond.notify_all()
        try:
            yield
        finally:
            with self._cond:
                self._running -= 1
                self._cond.notify_all()


# ==== engines ====


class Recognizer(Protocol):
    """Speech to text. `counter` measures prompt tokens (None: no tokenizer)."""

    name: str

    @property
    def ready(self) -> bool: ...

    @property
    def counter(self) -> TokenCounter | None: ...

    def transcribe(self, audio: bytes, language: str | None, plan: PromptPlan) -> str: ...


@dataclass(frozen=True)
class InstalledVoice:
    id: str
    model: Path
    config: Path
    rate: int
    length_scale: float


class Speaker(Protocol):
    """Text to speech with installed voices."""

    @property
    def ready(self) -> bool: ...

    def voices(self) -> dict[str, InstalledVoice]: ...

    def speak(self, text: str, voice: InstalledVoice, speed: float) -> bytes: ...


class WhisperRecognizer:
    """faster-whisper, loaded once. Without --allow-download the model must already be in the
    model folder (or the Hugging Face cache); nothing is fetched at run time."""

    def __init__(
        self,
        name: str,
        model_dir: Path | None,
        device: str = "cpu",
        compute_type: str = "int8",
        threads: int = 0,
        allow_download: bool = False,
    ) -> None:
        self.name = name
        self.model_dir = model_dir
        self.allow_download = allow_download
        # Passed to WhisperModel as they are.
        self.runtime = {"device": device, "compute_type": compute_type, "cpu_threads": threads}
        self._model: Any = None

    @property
    def ready(self) -> bool:
        loaded = self._model
        return loaded is not None

    @property
    def counter(self) -> TokenCounter | None:
        hf = getattr(self._model, "hf_tokenizer", None)
        if hf is None:
            return None

        def count(text: str) -> int:
            return len(hf.encode(text, add_special_tokens=False).ids)

        return count

    def load(self) -> None:
        if not self.allow_download:
            os.environ["HF_HUB_OFFLINE"] = "1"
        # Imported here so the tests and --help run without faster-whisper installed.
        from faster_whisper import WhisperModel

        self._model = WhisperModel(
            self.name,
            download_root=str(self.model_dir) if self.model_dir else None,
            local_files_only=not self.allow_download,
            **self.runtime,
        )

    def transcribe(self, audio: bytes, language: str | None, plan: PromptPlan) -> str:
        if self._model is None:
            raise EngineFailure("recognition model not loaded", 503)
        segments, _info = self._model.transcribe(
            io.BytesIO(audio),
            language=language,
            initial_prompt=plan.initial_prompt,
            hotwords=plan.hotwords,
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=False,
            without_timestamps=True,
        )
        parts = [s.text.strip() for s in segments if float(getattr(s, "no_speech_prob", 0.0) or 0.0) <= NO_SPEECH_LIMIT]
        return " ".join(p for p in parts if p)


def nested_number(data: Any, section: str, key: str) -> float | None:
    """data[section][key] when it is a number (not a boolean), else None."""
    part = data.get(section) if isinstance(data, dict) else None
    value = part.get(key) if isinstance(part, dict) else None
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


# Variables a Piper process may see; API keys and other secrets of this environment stay here.
CHILD_ENV_KEYS = ("PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT")


class PiperSpeaker:
    """Piper's command line, one process per request: `<command> --model <voice>.onnx --config
    <voice>.onnx.json --output-raw --length-scale <n>` with the text as one line on stdin and raw
    16-bit mono PCM on stdout. A voice is installed when `<id>.onnx` and `<id>.onnx.json` lie in
    the voices folder. Piper's own messages can quote the text, so they are never logged."""

    def __init__(
        self,
        voices_dir: Path,
        command: Sequence[str],
        timeout_s: float = 60.0,
        max_pcm_bytes: int = 32 * 1024 * 1024,
        cache_s: float = 30.0,
    ) -> None:
        self.voices_dir = voices_dir
        self.command = list(command)
        self.timeout_s = timeout_s
        self.max_pcm_bytes = max_pcm_bytes
        self.cache_s = cache_s
        self.env = {k: os.environ[k] for k in CHILD_ENV_KEYS if k in os.environ}
        self.env.update({"PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1"})
        # The voice listing is read at most every cache_s seconds; the lock keeps two readers from racing.
        self._lock = threading.Lock()
        self._cache: tuple[float, dict[str, InstalledVoice]] | None = None

    @property
    def ready(self) -> bool:
        """A Piper command is set and the voices folder exists (voices may still be missing)."""
        return bool(self.command) and self.voices_dir.is_dir()

    def voices(self) -> dict[str, InstalledVoice]:
        with self._lock:
            if self._cache and time.monotonic() - self._cache[0] < self.cache_s:
                return self._cache[1]
        found: dict[str, InstalledVoice] = {}
        with contextlib.suppress(OSError):
            for config in sorted(self.voices_dir.glob("*.onnx.json")):
                voice = self._read_voice(config)
                if voice:
                    found[voice.id] = voice
        with self._lock:
            self._cache = (time.monotonic(), found)
        return found

    def _read_voice(self, config: Path) -> InstalledVoice | None:
        vid = config.name[: -len(".onnx.json")]
        model = config.with_name(f"{vid}.onnx")
        if not VOICE_ID.fullmatch(vid) or not model.is_file():
            return None
        try:
            if config.stat().st_size > 1024 * 1024:
                raise ValueError("voice config too large")
            data = json.loads(config.read_text(encoding="utf-8"))
        except (OSError, ValueError) as err:
            log.warning("voice %s: config unreadable (%s)", vid, type(err).__name__)
            return None
        rate = nested_number(data, "audio", "sample_rate")
        if rate is None or rate != int(rate) or not 8000 <= rate <= 48000:
            log.warning("voice %s: no usable sample rate", vid)
            return None
        scale = nested_number(data, "inference", "length_scale")
        length_scale = scale if scale is not None and 0.1 <= scale <= 10 else 1.0
        return InstalledVoice(vid, model, config, int(rate), length_scale)

    def speak(self, text: str, voice: InstalledVoice, speed: float) -> bytes:
        argv = [
            *self.command,
            "--model",
            str(voice.model),
            "--config",
            str(voice.config),
            "--output-raw",
            "--length-scale",
            f"{voice.length_scale / speed:.4g}",
        ]
        line = " ".join(text.split()) + "\n"
        try:
            proc = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                env=self.env,
                cwd=str(self.voices_dir),
            )
        except OSError as err:
            raise EngineFailure(f"Piper did not start ({type(err).__name__})", 503) from err
        pcm = self._collect(proc, line.encode("utf-8"))
        if len(pcm) < 2:
            raise EngineFailure("Piper gave no audio")
        return wav_from_pcm(pcm[: len(pcm) - len(pcm) % 2], voice.rate)

    def _collect(self, proc: subprocess.Popen[bytes], data: bytes) -> bytes:
        """Feeds the text, reads at most max_pcm_bytes within timeout_s and waits for a clean
        exit; anything else ends the process and fails."""
        stdin, stdout = proc.stdin, proc.stdout
        if stdin is None or stdout is None:
            raise EngineFailure("Piper pipes missing", 503)
        chunks: list[bytes] = []
        size = 0
        overflow = False

        def read() -> None:
            nonlocal size, overflow
            while chunk := stdout.read(65536):
                size += len(chunk)
                if size > self.max_pcm_bytes:
                    overflow = True
                    proc.kill()
                    return
                chunks.append(chunk)

        reader = threading.Thread(target=read, name="piper-out", daemon=True)
        reader.start()
        try:
            with contextlib.suppress(BrokenPipeError):
                stdin.write(data)
                stdin.close()
            reader.join(self.timeout_s)
            if reader.is_alive():
                raise EngineFailure("Piper took too long", 504)
            code = proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            raise EngineFailure("Piper did not exit", 504) from None
        finally:
            if proc.returncode is None and proc.poll() is None:
                proc.kill()
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass  # The reader thread below still ends; the process is left to the system.
            reader.join(2)
            stdout.close()
        if overflow:
            raise EngineFailure("Piper gave too much audio")
        if code != 0:
            raise EngineFailure(f"Piper failed (exit {code})")
        return b"".join(chunks)


# ==== request parsing ====

TCHARS = r"[!#$%&'*+.^_`|~0-9A-Za-z-]+"
QUOTED = r'"(?:[^"\\\r\n]|\\[^\r\n])*"'
PARAM = re.compile(rf";[ \t]*({TCHARS})=({TCHARS}|{QUOTED})[ \t]*")
MEDIA_TYPE = re.compile(rf"[ \t]*({TCHARS}/{TCHARS})[ \t]*")
HEADER_LINE = re.compile(rf"({TCHARS}):[ \t]*(.*?)[ \t]*")
DISPOSITION = re.compile(rf"[ \t]*({TCHARS})[ \t]*")
# Boundary characters of RFC 2046: a space may occur, but not at the end.
BOUNDARY_CHARS = r"\-0-9A-Za-z'()+_,./:=?"
BOUNDARY = re.compile(rf"[{BOUNDARY_CHARS} ]{{0,69}}[{BOUNDARY_CHARS}]")
DIGITS = re.compile(r"[0-9]{1,12}")


def parse_params(rest: str) -> dict[str, str]:
    """Parameters after a media type or disposition ('; name="x"; filename=y'). Quoted values are
    unescaped; RFC 2231 forms (name*=) and repeated names are refused."""
    params: dict[str, str] = {}
    pos = 0
    while pos < len(rest):
        match = PARAM.match(rest, pos)
        if not match:
            raise ValueError("malformed parameters")
        name, value = match.group(1).lower(), match.group(2)
        if name.endswith("*") or name in params:
            raise ValueError("unsupported or repeated parameter")
        if value.startswith('"'):
            value = re.sub(r"\\(.)", r"\1", value[1:-1])
        params[name] = value
        pos = match.end()
    return params


def parse_media_type(value: str) -> tuple[str, dict[str, str]]:
    match = MEDIA_TYPE.match(value)
    if not match:
        raise ValueError("malformed media type")
    return match.group(1).lower(), parse_params(value[match.end() :])


@dataclass(frozen=True)
class FormField:
    data: bytes
    filename: str | None = None
    content_type: str | None = None


def parse_form(boundary: str, body: bytes, max_parts: int, single: frozenset[str]) -> dict[str, FormField]:
    """A multipart/form-data body as fields by name. Written for what form clients send: no
    preamble, CRLF line ends, one Content-Disposition per part, no nested multipart (a part's
    content is never parsed further). Fields in `single` may occur once; for others the first
    occurrence counts. ValueError for anything malformed or for more than max_parts parts."""
    if not BOUNDARY.fullmatch(boundary):
        raise ValueError("invalid boundary")
    delimiter = b"\r\n--" + boundary.encode("ascii")
    data = b"\r\n" + body
    if data.count(delimiter) > max_parts + 1:
        raise ValueError("too many parts")
    pieces = data.split(delimiter)
    if pieces[0] != b"" or len(pieces) < 2:
        raise ValueError("missing opening delimiter")
    closing = pieces[-1]
    if not closing.startswith(b"--") or closing[2:] not in (b"", b"\r\n"):
        raise ValueError("missing closing delimiter")
    fields: dict[str, FormField] = {}
    for piece in pieces[1:-1]:
        if not piece.startswith(b"\r\n"):
            raise ValueError("malformed delimiter line")
        head, sep, content = piece[2:].partition(b"\r\n\r\n")
        if not sep:
            raise ValueError("part without header end")
        headers: dict[str, str] = {}
        for raw in head.split(b"\r\n") if head else []:
            try:
                line = raw.decode("utf-8")
            except UnicodeDecodeError:
                raise ValueError("part header is not UTF-8") from None
            match = HEADER_LINE.fullmatch(line)
            if not match or "\r" in line or "\n" in line:
                raise ValueError("malformed part header")
            key = match.group(1).lower()
            if key in headers:
                raise ValueError("repeated part header")
            headers[key] = match.group(2)
        disposition = headers.get("content-disposition")
        if disposition is None:
            raise ValueError("part without Content-Disposition")
        kind = DISPOSITION.match(disposition)
        if not kind or kind.group(1).lower() != "form-data":
            raise ValueError("part is not form-data")
        params = parse_params(disposition[kind.end() :])
        name = params.get("name")
        if not name:
            raise ValueError("part without name")
        content_type = None
        if "content-type" in headers:
            content_type, _ = parse_media_type(headers["content-type"])
            if content_type.startswith(("multipart/", "message/")):
                raise ValueError("nested parts are not accepted")
        if name in fields:
            if name in single:
                raise DuplicateField(name)
            continue
        fields[name] = FormField(content, params.get("filename"), content_type)
    return fields


class DuplicateField(ValueError):
    """A field that may occur once in a form occurred again."""

    def __init__(self, field_name: str) -> None:
        self.field_name = field_name
        super().__init__(f"the form repeats {field_name}")


def parse_json_object(body: bytes) -> dict[str, Any]:
    """A JSON object as RFC 8259 has it: UTF-8, no NaN or Infinity, no repeated keys."""

    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for key, value in items:
            if key in out:
                raise ValueError(f"repeated key {key!r}")
            out[key] = value
        return out

    def constant(name: str) -> Any:
        raise ValueError(f"{name} is not JSON")

    try:
        value = json.loads(body.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise bad_request("invalid_json", "body is not a JSON object") from None
    if not isinstance(value, dict):
        raise bad_request("invalid_json", "body is not a JSON object")
    return value


# ==== origins ====

LOOPBACK_NAMES = frozenset({"127.0.0.1", "localhost", "[::1]"})


def normalize_origin(value: str) -> str | None:
    """An origin as browsers send it ("https://app.example"), or None when it is not one: https
    only, or http for a loopback host; no path, query, fragment or credentials."""
    try:
        parts = urlsplit(value.strip())
        port = parts.port
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    if parts.scheme not in ("https", "http") or not host or parts.username or parts.password:
        return None
    if parts.path not in ("", "/") or parts.query or parts.fragment:
        return None
    shown = f"[{host}]" if ":" in host else host
    if parts.scheme == "http" and shown not in LOOPBACK_NAMES:
        return None
    default = 443 if parts.scheme == "https" else 80
    return f"{parts.scheme}://{shown}" + (f":{port}" if port not in (None, default) else "")


# ==== http ====

ROUTES: dict[str, tuple[str, ...]] = {
    "/health": ("GET",),
    "/v1/models": ("GET",),
    "/v1/audio/voices": ("GET",),
    "/v1/audio/transcriptions": ("POST",),
    "/v1/audio/speech": ("POST",),
}
FORM_SINGLE = frozenset({"file", "model", "language", "prompt", "glossary", "response_format"})
CORS_HEADERS = "content-type, accept"
LANGUAGE = re.compile(r"([a-z]{2,3})(?:[-_][A-Za-z]{2,4})?")


@dataclass
class ServerSettings:
    port: int
    origins: frozenset[str]
    allowlist: dict[str, AllowedVoice]
    limits: Limits = field(default_factory=Limits)
    stt_gate: Gate = field(default_factory=lambda: Gate(1, 3, 20.0, "speech input"))
    tts_gate: Gate = field(default_factory=lambda: Gate(2, 4, 20.0, "speech output"))


class VoiceServer(http.server.ThreadingHTTPServer):
    """The HTTP server with its engines. At most `limits.connections` connections are served at
    once; further ones are closed at once instead of each getting a thread."""

    daemon_threads = True

    def __init__(
        self, address: tuple[str, int], settings: ServerSettings, recognizer: Recognizer | None, speaker: Speaker | None
    ) -> None:
        self.settings = settings
        self.recognizer = recognizer
        self.speaker = speaker
        self._connections = threading.BoundedSemaphore(settings.limits.connections)
        super().__init__(address, VoiceHandler)

    @property
    def port(self) -> int:
        return int(self.server_address[1])

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self._connections.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._connections.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._connections.release()

    def handle_error(self, _request: Any, _peer: Any) -> None:
        # A client that hung up is no server error; nothing of the request is printed.
        log.debug("connection ended: %s", type(sys.exc_info()[1]).__name__)


class VoiceHandler(http.server.BaseHTTPRequestHandler):
    server: VoiceServer  # pyright: ignore[reportIncompatibleVariableOverride]
    protocol_version = "HTTP/1.1"
    server_version = f"starpi-voice/{VERSION}"
    sys_version = ""

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(self.server.settings.limits.socket_seconds)
        self._started = time.monotonic()
        self._cors_origin: str | None = None
        self._sent = 0
        self._body_done = False

    # Every method goes through one dispatcher; http.server looks up do_<METHOD>.
    def do_GET(self) -> None:
        self._dispatch()

    def do_POST(self) -> None:
        self._dispatch()

    def do_OPTIONS(self) -> None:
        self._dispatch()

    def do_PUT(self) -> None:
        self._dispatch()

    def do_DELETE(self) -> None:
        self._dispatch()

    def do_PATCH(self) -> None:
        self._dispatch()

    def do_HEAD(self) -> None:
        self._dispatch()

    # --- plumbing ---

    def log_request(self, code: int | str = "-", size: int | str = "-") -> None:
        target = getattr(self, "path", "") or ""
        path = urlsplit(target).path if target.startswith("/") else "-"
        log.info(
            "%s %s %s %d bytes %.0f ms",
            self.command or "-",
            path,
            code,
            self._sent,
            (time.monotonic() - self._started) * 1000,
        )

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 (the base class names it so)
        # http.server's own lines can quote the request line; only their kind is kept.
        log.debug("http.server: %s", format.split(" ", 1)[0])

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        # http.server's own errors (a malformed request line or header block) answer in JSON too.
        self.close_connection = True
        self._answer_error(
            HttpError(code, "bad_request" if code < 500 else "server_error", message or "request refused")
        )

    def _send(self, status: int, body: bytes, content_type: str, headers: Sequence[tuple[str, str]] = ()) -> None:
        fields = [
            ("Content-Type", content_type),
            ("Content-Length", str(len(body))),
            ("Cache-Control", "no-store"),
            ("X-Content-Type-Options", "nosniff"),
            *headers,
        ]
        if self._cors_origin:
            fields += [("Access-Control-Allow-Origin", self._cors_origin), ("Vary", "Origin")]
        if self.close_connection:
            fields.append(("Connection", "close"))
        self.send_response(status)
        for key, val in fields:
            self.send_header(key, val)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        self._sent = len(body)

    def _json(self, status: int, value: Any, headers: Sequence[tuple[str, str]] = ()) -> None:
        self._send(
            status, json.dumps(value, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", headers
        )

    def _answer_error(self, err: HttpError) -> None:
        # A body left unread would be taken for the next request on this connection.
        headers = getattr(self, "headers", None)
        if (
            not self._body_done
            and headers is not None
            and (headers.get("Transfer-Encoding") or headers.get("Content-Length", "0") != "0")
        ):
            self.close_connection = True
        self._json(err.status, {"error": {"code": err.code, "message": str(err)}}, err.headers)

    def _dispatch(self) -> None:
        try:
            self._route()
        except HttpError as err:
            self._answer_error(err)
        except EngineFailure as err:
            log.warning("engine: %s", err)
            self._answer_error(
                HttpError(
                    err.status,
                    "engine_failed"
                    if err.status == 502
                    else "engine_unavailable"
                    if err.status == 503
                    else "engine_timeout",
                    str(err),
                )
            )
        except (ConnectionError, TimeoutError):
            self.close_connection = True
        except Exception as err:  # noqa: BLE001 (one request must never take the server down)
            log.error("internal error: %s", type(err).__name__)
            self.close_connection = True
            self._answer_error(HttpError(500, "internal_error", "internal error"))

    # --- checks before routing ---

    def _single_header(self, name: str) -> str | None:
        values = self.headers.get_all(name) or []
        if len(values) > 1:
            self.close_connection = True
            raise bad_request("repeated_header", f"{name} given more than once")
        return values[0] if values else None

    def _check_host(self) -> None:
        host = self._single_header("Host")
        allowed = {f"{name}:{self.server.port}" for name in LOOPBACK_NAMES}
        if host is None or host.lower() not in allowed:
            self.close_connection = True
            raise HttpError(421, "wrong_host", "this server answers only for its loopback address")

    def _check_origin(self) -> str | None:
        origin = self._single_header("Origin")
        if origin is None:
            return None
        normalized = normalize_origin(origin)
        if normalized is None or normalized not in self.server.settings.origins:
            raise HttpError(403, "origin_not_allowed", "this origin may not use the voice server")
        self._cors_origin = origin
        return origin

    # --- routes ---

    def _route(self) -> None:
        if not self.path.startswith("/"):
            raise bad_request("bad_target", "the request target must be a path")
        self._check_host()
        origin = self._check_origin()
        path = urlsplit(self.path).path
        methods = ROUTES.get(path)
        if self.command == "OPTIONS":
            self._preflight(path, methods, origin)
            return
        if methods is None:
            raise HttpError(404, "not_found", "no such route")
        if self.command not in methods:
            raise HttpError(
                405, "method_not_allowed", "method not allowed", [("Allow", ", ".join((*methods, "OPTIONS")))]
            )
        if self.command == "GET":
            self._discard_body()
        handler = {
            "/health": self._health,
            "/v1/models": self._models,
            "/v1/audio/voices": self._voices,
            "/v1/audio/transcriptions": self._transcribe,
            "/v1/audio/speech": self._speech,
        }[path]
        handler()

    def _preflight(self, path: str, methods: tuple[str, ...] | None, origin: str | None) -> None:
        self._discard_body()
        if methods is None:
            raise HttpError(404, "not_found", "no such route")
        allow = ", ".join((*methods, "OPTIONS"))
        if origin is None:
            self._send(204, b"", "text/plain", [("Allow", allow)])
            return
        wanted = self._single_header("Access-Control-Request-Method")
        if wanted is None or wanted not in methods:
            raise HttpError(405, "method_not_allowed", "method not allowed", [("Allow", allow)])
        headers = [
            ("Access-Control-Allow-Methods", allow),
            ("Access-Control-Allow-Headers", CORS_HEADERS),
            ("Access-Control-Max-Age", "600"),
        ]
        # Private Network Access: a page of a public origin asks before it reaches loopback.
        if (self._single_header("Access-Control-Request-Private-Network") or "").lower() == "true":
            headers.append(("Access-Control-Allow-Private-Network", "true"))
        self._send(204, b"", "text/plain", headers)

    def _health(self) -> None:
        recognizer, speaker = self.server.recognizer, self.server.speaker
        stt = {"ready": bool(recognizer and recognizer.ready), "model": recognizer.name if recognizer else None}
        tts = {"ready": bool(speaker and speaker.ready), "voices": len(self._offered()) if speaker else 0}
        status = "ok" if stt["ready"] and tts["ready"] else "degraded"
        self._json(200, {"status": status, "version": VERSION, "stt": stt, "tts": tts})

    def _models(self) -> None:
        data = []
        if self.server.recognizer:
            data.append({"id": self.server.recognizer.name, "object": "model", "owned_by": "local"})
        if self.server.speaker:
            data.append({"id": "piper", "object": "model", "owned_by": "local"})
        self._json(200, {"object": "list", "data": data})

    def _offered(self) -> dict[str, InstalledVoice]:
        """Installed voices that are on the allowlist."""
        speaker = self.server.speaker
        if speaker is None:
            return {}
        allow = self.server.settings.allowlist
        return {vid: voice for vid, voice in speaker.voices().items() if vid in allow}

    def _voices(self) -> None:
        allow = self.server.settings.allowlist
        voices = [
            {"id": vid, "name": allow[vid].label, "language": allow[vid].lang, "license": allow[vid].license}
            for vid in sorted(self._offered())
        ]
        self._json(200, {"voices": voices})

    # --- bodies ---

    def _discard_body(self) -> None:
        """GET and OPTIONS carry no body; one that is announced is refused so the connection stays
        in step."""
        if self.headers.get("Transfer-Encoding") or (self._single_header("Content-Length") or "0") != "0":
            self.close_connection = True
            raise bad_request("unexpected_body", "this request takes no body")

    def _read_body(self, limit: int) -> bytes:
        if self.headers.get_all("Transfer-Encoding"):
            self.close_connection = True
            raise HttpError(501, "transfer_encoding_unsupported", "send the body with Content-Length")
        length = self._single_header("Content-Length")
        if length is None:
            self.close_connection = True
            raise HttpError(411, "length_required", "Content-Length is required")
        if not DIGITS.fullmatch(length):
            self.close_connection = True
            raise bad_request("bad_length", "Content-Length is not a number")
        size = int(length)
        if size > limit:
            self.close_connection = True
            raise HttpError(413, "too_large", f"the body may have at most {limit} bytes")
        deadline = time.monotonic() + self.server.settings.limits.body_seconds
        chunks: list[bytes] = []
        got = 0
        while got < size:
            left = deadline - time.monotonic()
            if left <= 0:
                self.close_connection = True
                raise HttpError(408, "body_timeout", "the body did not arrive in time")
            self.connection.settimeout(min(left, self.server.settings.limits.socket_seconds))
            try:
                chunk = self.rfile.read1(min(65536, size - got))
            except TimeoutError:
                # A socket file cannot be read again after a timeout; the request ends here.
                self.close_connection = True
                raise HttpError(408, "body_timeout", "the body did not arrive in time") from None
            if not chunk:
                self.close_connection = True
                raise ConnectionError("client closed the connection mid-body")
            chunks.append(chunk)
            got += len(chunk)
        self.connection.settimeout(self.server.settings.limits.socket_seconds)
        self._body_done = True
        return b"".join(chunks)

    def _content_type(self) -> tuple[str, dict[str, str]]:
        value = self._single_header("Content-Type")
        if value is None:
            raise HttpError(415, "unsupported_media_type", "Content-Type is required")
        try:
            return parse_media_type(value)
        except ValueError:
            raise HttpError(415, "unsupported_media_type", "Content-Type is malformed") from None

    # --- speech input ---

    def _transcribe(self) -> None:
        limits = self.server.settings.limits
        media, params = self._content_type()
        if media != "multipart/form-data" or "boundary" not in params:
            raise HttpError(415, "unsupported_media_type", "send multipart/form-data with a file")
        body = self._read_body(limits.form_bytes)
        try:
            form = parse_form(params["boundary"], body, limits.form_parts, FORM_SINGLE)
        except DuplicateField as err:
            raise bad_request("duplicate_field", str(err)) from None
        except ValueError as err:
            raise bad_request("invalid_form", str(err)) from None
        audio = form.get("file")
        if audio is None or not audio.data:
            raise bad_request("missing_field", "file is required")
        if len(audio.data) > limits.audio_bytes:
            raise HttpError(413, "too_large", f"the audio may have at most {limits.audio_bytes} bytes")
        check_wav(audio.data)
        text = {
            name: self._form_text(form, name, limit, clip=clip)
            for name, limit, clip in (
                ("model", limits.field_chars, False),
                ("language", limits.field_chars, False),
                ("response_format", limits.field_chars, False),
                # Spelling hints are cut after their last whole term, never refused (Limits).
                ("prompt", limits.prompt_chars, True),
                ("glossary", limits.glossary_chars, True),
            )
        }
        language = None
        if text["language"]:
            match = LANGUAGE.fullmatch(text["language"])
            if not match:
                raise bad_request("unsupported_language", "language is a code such as en or de")
            language = match.group(1)
        response_format = text["response_format"] or "json"
        if response_format not in ("json", "text"):
            raise bad_request("unsupported_format", "response_format is json or text")
        recognizer = self.server.recognizer
        if recognizer is None or not recognizer.ready:
            raise HttpError(503, "stt_unavailable", "speech input is not running")
        plan = plan_prompt(
            text["prompt"], text["glossary"], recognizer.counter, limits.prompt_tokens, limits.glossary_terms
        )
        with self.server.settings.stt_gate.turn():
            try:
                transcript = recognizer.transcribe(audio.data, language, plan)
            except ValueError:
                raise bad_request("unsupported_language", "the model does not know this language") from None
        transcript = " ".join(transcript.split())[: limits.transcript_chars]
        if response_format == "text":
            self._send(200, transcript.encode("utf-8"), "text/plain; charset=utf-8")
        else:
            self._json(200, {"text": transcript})

    def _form_text(self, form: dict[str, FormField], name: str, limit: int, *, clip: bool = False) -> str | None:
        part = form.get(name)
        if part is None:
            return None
        try:
            value = part.data.decode("utf-8")
        except UnicodeDecodeError:
            raise bad_request("invalid_text", f"{name} is not UTF-8") from None
        return checked_text(clip_terms(value, limit) if clip else value, name, limit)

    # --- speech output ---

    def _speech(self) -> None:
        limits = self.server.settings.limits
        media, _ = self._content_type()
        if media != "application/json":
            raise HttpError(415, "unsupported_media_type", "send application/json")
        request = parse_json_object(self._read_body(limits.json_bytes))
        text = checked_text(request.get("input"), "input", limits.speak_chars, required=True) or ""
        if not has_letter_or_digit(text):
            raise bad_request("nothing_to_speak", "input has no letter or digit")
        model = request.get("model")
        if model is not None and model not in SPEECH_MODELS:
            raise bad_request("unknown_model", "model is piper, tts-1 or tts-1-hd")
        if request.get("response_format", "wav") != "wav":
            raise bad_request("unsupported_format", "response_format is wav")
        speed = request.get("speed", 1)
        if (
            isinstance(speed, bool)
            or not isinstance(speed, (int, float))
            or not SPEED_RANGE[0] <= speed <= SPEED_RANGE[1]
        ):
            raise bad_request("invalid_speed", f"speed is a number from {SPEED_RANGE[0]} to {SPEED_RANGE[1]}")
        voice_id = request.get("voice")
        if not isinstance(voice_id, str) or not voice_id:
            raise bad_request("missing_field", "voice is required")
        speaker = self.server.speaker
        if speaker is None or not speaker.ready:
            raise HttpError(503, "tts_unavailable", "speech output is not running")
        voice = self._offered().get(voice_id)
        if voice is None:
            raise bad_request("unknown_voice", "voice is not installed or not on the allowlist")
        with self.server.settings.tts_gate.turn():
            audio = speaker.speak(text, voice, float(speed))
        self._send(200, audio, "audio/wav")


# ==== command line ====


def default_home() -> Path:
    """Where models and voices live unless told otherwise (STARPI_VOICE_HOME moves it)."""
    if os.environ.get("STARPI_VOICE_HOME"):
        return Path(os.environ["STARPI_VOICE_HOME"]).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "starpi-voice"
    base = os.environ.get("XDG_DATA_HOME")
    return (Path(base) if base and os.path.isabs(base) else Path.home() / ".local" / "share") / "starpi-voice"


def origins_from(args: argparse.Namespace) -> frozenset[str]:
    raw = [] if args.no_default_origin else list(DEFAULT_ORIGINS)
    raw += args.allow_origin or []
    raw += [o for o in os.environ.get("STARPI_VOICE_ORIGINS", "").split(",") if o.strip()]
    origins: set[str] = set()
    for value in raw:
        normalized = normalize_origin(value)
        if normalized is None:
            raise SystemExit(f"not an origin: {value!r} (https://host[:port], or http:// for a loopback host)")
        origins.add(normalized)
    return frozenset(origins)


def build_parser() -> argparse.ArgumentParser:
    home = default_home()
    parser = argparse.ArgumentParser(description="Starpi local voice server (127.0.0.1 only).")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port on 127.0.0.1 (default {DEFAULT_PORT})")
    parser.add_argument(
        "--allow-origin",
        action="append",
        metavar="ORIGIN",
        help="a browser origin that may call the server (repeatable)",
    )
    parser.add_argument("--no-default-origin", action="store_true", help=f"do not allow {DEFAULT_ORIGINS[0]}")
    parser.add_argument(
        "--allowlist",
        type=Path,
        default=DEFAULT_ALLOWLIST,
        help="voice allowlist (default: allowlist.json next to this file)",
    )
    stt = parser.add_argument_group("speech input")
    stt.add_argument("--no-stt", action="store_true", help="do not load a recognition model")
    stt.add_argument("--whisper-model", default="small", help="faster-whisper model name or folder (default small)")
    stt.add_argument(
        "--model-dir", type=Path, default=home / "whisper", help=f"model folder (default {home / 'whisper'})"
    )
    stt.add_argument("--device", default="cpu", help="cpu, cuda or auto (default cpu)")
    stt.add_argument("--compute-type", default="int8", help="CTranslate2 compute type (default int8)")
    stt.add_argument("--threads", type=int, default=0, help="CPU threads, 0 for the library's choice")
    stt.add_argument("--allow-download", action="store_true", help="fetch the model once if it is missing")
    tts = parser.add_argument_group("speech output")
    tts.add_argument("--no-tts", action="store_true", help="do not offer speech output")
    tts.add_argument(
        "--voices-dir", type=Path, default=home / "voices", help=f"Piper voices (default {home / 'voices'})"
    )
    tts.add_argument(
        "--piper-python",
        type=Path,
        default=Path(sys.executable),
        help="Python of the environment that has piper-tts (default: this one)",
    )
    parser.add_argument("--log-level", default="info", choices=("debug", "info", "warning", "error"))
    return parser


def port_taken(port: int) -> bool:
    with contextlib.suppress(OSError), create_connection((HOST, port), timeout=0.3):
        return True
    return False


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=args.log_level.upper(), format="%(asctime)s %(levelname)s %(message)s", stream=sys.stderr)
    if not 1024 <= args.port <= 65535:
        log.error("--port is 1024 to 65535")
        return 2
    if port_taken(args.port):
        log.error("127.0.0.1:%d is in use", args.port)
        return 1
    allowlist = load_allowlist(args.allowlist)
    recognizer = None
    if not args.no_stt:
        recognizer = WhisperRecognizer(
            args.whisper_model, args.model_dir, args.device, args.compute_type, args.threads, args.allow_download
        )
        started = time.monotonic()
        try:
            recognizer.load()
        except ImportError:
            log.error(
                "faster-whisper is not installed: python3 -m pip install -r requirements.txt (or start with --no-stt)"
            )
            return 1
        except Exception as err:  # noqa: BLE001 (any load failure ends the start with a clear line)
            log.error(
                "the recognition model %s did not load (%s); fetch it once with --allow-download",
                args.whisper_model,
                type(err).__name__,
            )
            return 1
        log.info("recognition model %s loaded in %.1f s", args.whisper_model, time.monotonic() - started)
    speaker = None
    if not args.no_tts:
        speaker = PiperSpeaker(args.voices_dir, [str(args.piper_python), "-I", "-m", "piper"])
        installed = speaker.voices()
        offered = sorted(v for v in installed if v in allowlist)
        log.info(
            "voices: %d installed, %d on the allowlist (%s)", len(installed), len(offered), ", ".join(offered) or "none"
        )
    settings = ServerSettings(port=args.port, origins=origins_from(args), allowlist=allowlist)
    server = VoiceServer((HOST, args.port), settings, recognizer, speaker)

    def stop(_signum: int, _frame: Any) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    for signum in (SIGTERM, SIGINT):
        on_signal(signum, stop)
    log.info(
        "Starpi voice server %s listening on http://%s:%d (origins: %s)",
        VERSION,
        HOST,
        args.port,
        ", ".join(sorted(settings.origins)) or "none",
    )
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
