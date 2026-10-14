"""NVIDIA NIM proxy behind POST /api/chat/nvidia and GET /api/models/nvidia.

The Python counterpart of the Vercel Functions in ``api/``: the same model allowlist, limits,
validation rules, error codes and failover policy. The allowlist is read from
``nvidia_catalog.json``, a generated copy of ``src/js/models/nvidia-catalog.js``
(``npm run nvidia:sync``). Validation is checked against the vectors in
``test_fixtures/nvidia_validation.json``, which the JavaScript tests run as well.

Each request starts at the next key (round robin) and fails over to the following keys until one
delivers the first byte of a stream; after that byte there is no failover. Keys that fail are parked:
429 for its Retry-After, 401/403 for half an hour, 408/5xx, timeouts, network errors and empty streams
briefly. Upstream bodies are never read or echoed, and log lines name a key by its index only.

One difference to the Vercel Functions: httpx applies one read timeout to every read of a request,
so a key gets up to ``idleTimeoutMs`` (not ``attemptTimeoutMs``) for its first byte, and the failover
budget only keeps new attempts from starting.
"""

from __future__ import annotations

import email.utils
import itertools
import json
import logging
import math
import re
import threading
import time
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

CATALOG: dict[str, Any] = json.loads(Path(__file__).with_name("nvidia_catalog.json").read_text(encoding="utf-8"))
MODELS: dict[str, dict[str, Any]] = {model["id"]: model for model in CATALOG["models"]}
LIMITS: dict[str, int] = CATALOG["limits"]
PROXY: dict[str, Any] = CATALOG["proxy"]
UPSTREAM_URL: str = CATALOG["upstream"]

KEY_PATTERN = re.compile(r"nvapi-[A-Za-z0-9_-]{64}")
PUBLIC_MODEL_FIELDS = ("id", "label", "vendor", "reasoning", "vision", "maxOutputTokens", "defaultMaxTokens")
ROLES = ("system", "user", "assistant")
# Only ASCII whitespace counts as blank, so JavaScript and Python agree on every string.
ASCII_WHITESPACE = " \t\n\v\f\r"
# The only HTTP-date format senders may generate (RFC 9110, IMF-fixdate).
IMF_FIXDATE = re.compile(r"[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT")
RETRY_AFTER_MAX_SECONDS = 300
CONNECT_TIMEOUT_SECONDS = 3.0


class NvidiaValidationError(ValueError):
    """A chat request the proxy refuses with 400 (``invalid_field`` or ``model_not_allowed``)."""

    def __init__(self, error: str, field: str | None = None) -> None:
        super().__init__(error)
        self.error = error
        self.details: dict[str, str] = {"field": field} if field else {}


class NvidiaRouterError(Exception):
    """No key delivered a stream; carries the HTTP status, error code and Retry-After header."""

    def __init__(self, status: HTTPStatus, error: str, retry_after: int | None = None) -> None:
        super().__init__(error)
        self.status = status
        self.error = error
        self.headers: dict[str, str] = {"Retry-After": str(retry_after)} if retry_after else {}


def parse_keys(values: Iterable[str]) -> tuple[list[str], int]:
    """Keys split on commas and whitespace, deduplicated, plus the number of malformed entries.

    Entries that are not ``nvapi-`` and 64 characters (cut off, pasted with Markdown escapes such
    as ``\\_``) are dropped and only counted, so callers can log the number without the text.
    """
    entries = list(dict.fromkeys(entry for value in values for entry in re.split(r"[\s,]+", value) if entry))
    keys = [entry for entry in entries if KEY_PATTERN.fullmatch(entry)]
    return keys, len(entries) - len(keys)


def public_catalog(configured: bool) -> dict[str, Any]:
    """The body of GET /api/models/nvidia: the allowlist without upstream extras, never keys."""
    return {
        "configured": configured,
        "version": CATALOG["version"],
        "defaultModel": CATALOG["defaultModel"],
        "limits": LIMITS,
        "models": [{name: model[name] for name in PUBLIC_MODEL_FIELDS} for model in CATALOG["models"]],
    }


def utf16_length(text: str) -> int:
    """Length in UTF-16 code units, as JavaScript's String#length counts (lone surrogates included)."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def _is_integer(value: Any) -> bool:
    # 1.0 counts as an integer, as it does after JSON.parse in JavaScript; True does not.
    if isinstance(value, bool):
        return False
    return isinstance(value, int) or (isinstance(value, float) and value.is_integer())


def _valid_messages(messages: Any) -> list[dict[str, str]] | None:
    if not isinstance(messages, list) or not 1 <= len(messages) <= LIMITS["maxMessages"]:
        return None
    total = 0
    clean: list[dict[str, str]] = []
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            return None
        role, content = message.get("role"), message.get("content")
        if not isinstance(role, str) or role not in ROLES or (role == "system" and index > 0):
            return None
        if not isinstance(content, str):
            return None
        length = utf16_length(content)
        if length > LIMITS["maxMessageChars"]:
            return None
        total += length
        clean.append({"role": role, "content": content})
    last = clean[-1]
    if total > LIMITS["maxTotalChars"] or last["role"] != "user" or not last["content"].strip(ASCII_WHITESPACE):
        return None
    return clean


def validate_chat_request(data: dict[str, Any]) -> dict[str, Any]:
    """Checks a chat request and returns the upstream body built from the allowed fields only.

    Every other client field (tools, n, stop, stream, message names, ...) is dropped and ``stream``
    is always true. The catalog's fixed ``upstream`` fields come first, so they never override the
    validated ones. Raises NvidiaValidationError.
    """
    model_id = data.get("model")
    if not isinstance(model_id, str):
        raise NvidiaValidationError("invalid_field", "model")
    model = MODELS.get(model_id)
    if model is None:
        raise NvidiaValidationError("model_not_allowed")

    messages = _valid_messages(data.get("messages"))
    if messages is None:
        raise NvidiaValidationError("invalid_field", "messages")

    cap = min(model["maxOutputTokens"], LIMITS["maxOutputTokens"])
    max_tokens = model["defaultMaxTokens"]
    requested = data.get("max_tokens")
    if requested is not None:
        if not _is_integer(requested) or requested < 1:
            raise NvidiaValidationError("invalid_field", "max_tokens")
        max_tokens = requested

    options: dict[str, Any] = {}
    temperature = data.get("temperature")
    if temperature is not None:
        if not _is_number(temperature) or not 0 <= temperature <= 2:
            raise NvidiaValidationError("invalid_field", "temperature")
        options["temperature"] = temperature
    top_p = data.get("top_p")
    if top_p is not None:
        if not _is_number(top_p) or not 0 < top_p <= 1:
            raise NvidiaValidationError("invalid_field", "top_p")
        options["top_p"] = top_p

    return {
        **model.get("upstream", {}),
        "model": model["id"],
        "messages": messages,
        "max_tokens": int(min(max_tokens, cap)),
        "stream": True,
        **options,
    }


def parse_retry_after(value: str | None, now: float) -> float | None:
    """Retry-After in seconds from ``now`` (epoch seconds): delta-seconds or an IMF-fixdate."""
    text = (value or "").strip()
    if re.fullmatch(r"[0-9]+", text):
        return float(text)
    if not IMF_FIXDATE.fullmatch(text):
        return None
    try:
        at = email.utils.parsedate_to_datetime(text).timestamp()
    except (TypeError, ValueError):
        return None
    return max(0.0, at - now)


def sse_error(code: str) -> bytes:
    """The event that ends a failed stream; the blank line first ends any half-written event."""
    return b"\n\ndata: " + json.dumps({"error": {"code": code}}, separators=(",", ":")).encode("utf-8") + b"\n\n"


@dataclass(slots=True)
class _Window:
    start: float
    count: int


class RateLimiter:
    """Fixed-window request counter per client address, in this process only (best effort).

    At ``max_entries`` addresses it forgets expired windows first, then the oldest.
    """

    def __init__(
        self,
        limit: int,
        window_seconds: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
        max_entries: int = 5000,
    ) -> None:
        self._limit = limit
        self._window = window_seconds
        self._clock = clock
        self._max_entries = max_entries
        self._windows: dict[str, _Window] = {}
        self._lock = threading.Lock()

    def hit(self, key: str) -> int | None:
        """Counts one request; returns None when allowed, else the Retry-After in seconds."""
        with self._lock:
            now = self._clock()
            window = self._windows.get(key)
            if window is None or now - window.start >= self._window:
                # Re-inserting keeps the dict in window-start order, so pruning drops the oldest.
                self._windows.pop(key, None)
                if len(self._windows) >= self._max_entries:
                    self._prune(now)
                window = self._windows[key] = _Window(now, 0)
            window.count += 1
            if window.count <= self._limit:
                return None
            return max(1, math.ceil(window.start + self._window - now))

    def _prune(self, now: float) -> None:
        for key in [k for k, w in self._windows.items() if now - w.start >= self._window]:
            del self._windows[key]
        while len(self._windows) >= self._max_entries:
            del self._windows[next(iter(self._windows))]


class KeyPool:
    """Round-robin start positions and per-key cooldowns, shared by the request threads."""

    def __init__(self, size: int, clock: Callable[[], float] = time.monotonic) -> None:
        self.size = size
        self._clock = clock
        self._cursor = itertools.count()
        self._cooling_until = [0.0] * size
        self._lock = threading.Lock()

    def order(self) -> list[int]:
        """Key indexes that are not cooling, starting at the next round-robin position."""
        start = next(self._cursor) % self.size
        rotated = [(start + offset) % self.size for offset in range(self.size)]
        with self._lock:
            now = self._clock()
            return [index for index in rotated if self._cooling_until[index] <= now]

    def is_cooling(self, index: int) -> bool:
        with self._lock:
            return self._cooling_until[index] > self._clock()

    def cool(self, index: int, seconds: float) -> None:
        with self._lock:
            self._cooling_until[index] = max(self._cooling_until[index], self._clock() + seconds)

    def retry_after(self) -> int:
        """Seconds until the first key is usable again, 1 to RETRY_AFTER_MAX_SECONDS."""
        with self._lock:
            wait = min(self._cooling_until) - self._clock()
        return min(RETRY_AFTER_MAX_SECONDS, max(1, math.ceil(wait)))

    def cooling_until(self) -> list[float]:
        with self._lock:
            return list(self._cooling_until)


class UpstreamStream:
    """A committed upstream stream: ``first`` chunk, then ``rest()``; ``close()`` releases it.

    After ``rest()`` ends, ``error_code`` is set when the stream failed (stream_timeout,
    stream_too_large or upstream_interrupted); the server then sends ``sse_error(error_code)``.
    """

    def __init__(
        self,
        first: bytes,
        chunks: Iterator[bytes],
        response: httpx.Response,
        deadline: float,
        clock: Callable[[], float],
    ) -> None:
        self.first = first
        self.error_code: str | None = None
        self._chunks = chunks
        self._response = response
        self._deadline = deadline
        self._clock = clock

    def rest(self) -> Iterator[bytes]:
        size = len(self.first)
        try:
            for chunk in self._chunks:
                if self._clock() > self._deadline:
                    self.error_code = "stream_timeout"
                    return
                size += len(chunk)
                if size > PROXY["maxStreamBytes"]:
                    self.error_code = "stream_too_large"
                    return
                yield chunk
        except httpx.TimeoutException:
            self.error_code = "stream_timeout"
        except httpx.HTTPError:
            self.error_code = "upstream_interrupted"

    def close(self) -> None:
        self._response.close()


@dataclass(slots=True)
class _Retry:
    """An attempt that failed in a way another key may not: park this key and try the next."""

    cooldown_seconds: float
    reason: str
    timeout: bool = False


@dataclass(slots=True)
class _Fatal:
    """An upstream answer that another key would get as well: no failover."""

    error: str
    status: int


def _first_chunk(chunks: Iterator[bytes]) -> bytes | None:
    for chunk in chunks:
        if chunk:
            return chunk
    return None


class NvidiaRouter:
    """Sends a validated chat request with the next usable key and fails over until the first byte."""

    def __init__(
        self,
        keys: list[str],
        *,
        transport: httpx.BaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
    ) -> None:
        if not keys:
            raise ValueError("NvidiaRouter needs at least one key")
        self._keys = list(keys)
        self._clock = clock
        self._wall_clock = wall_clock
        self.pool = KeyPool(len(keys), clock)
        # One client for all request threads; a stream returns its connection when it is closed.
        self._client = httpx.Client(
            timeout=httpx.Timeout(PROXY["idleTimeoutMs"] / 1000, connect=CONNECT_TIMEOUT_SECONDS),
            transport=transport,
        )

    def open_stream(self, body: dict[str, Any]) -> UpstreamStream:
        """Returns the first stream a key delivers; raises NvidiaRouterError (502, 503 or 504)."""
        order = self.pool.order()
        if not order:
            # Every key cools down: answer at once, without an upstream request.
            raise self._exhausted()
        # ensure_ascii keeps lone surrogates as \\u escapes, so the payload is always valid UTF-8.
        payload = json.dumps(body).encode("utf-8")
        started = self._clock()
        deadline = started + PROXY["failoverBudgetMs"] / 1000
        attempts = timeouts = 0
        out_of_time = False
        for index in order:
            # A concurrent request may have parked the key in the meantime.
            if self.pool.is_cooling(index):
                continue
            if deadline - self._clock() <= 0:
                out_of_time = True
                break
            attempts += 1
            outcome = self._attempt(index, payload, started + PROXY["streamMaxMs"] / 1000)
            if isinstance(outcome, UpstreamStream):
                return outcome
            if isinstance(outcome, _Fatal):
                logger.warning("nvidia: key %d/%d got %d, not retried", index + 1, self.pool.size, outcome.status)
                raise NvidiaRouterError(HTTPStatus.BAD_GATEWAY, outcome.error)
            if outcome.timeout:
                timeouts += 1
            self.pool.cool(index, outcome.cooldown_seconds)
            logger.warning(
                "nvidia: key %d/%d %s, cooling %d s",
                index + 1,
                self.pool.size,
                outcome.reason,
                math.ceil(outcome.cooldown_seconds),
            )
        if timeouts == attempts and (attempts or out_of_time):
            raise NvidiaRouterError(HTTPStatus.GATEWAY_TIMEOUT, "upstream_timeout")
        raise self._exhausted()

    def _exhausted(self) -> NvidiaRouterError:
        return NvidiaRouterError(HTTPStatus.SERVICE_UNAVAILABLE, "all_keys_exhausted", self.pool.retry_after())

    def _attempt(self, index: int, payload: bytes, stream_deadline: float) -> UpstreamStream | _Retry | _Fatal:
        cooldown = PROXY["cooldownMs"]
        transient = cooldown["transient"] / 1000
        request = self._client.build_request(
            "POST",
            UPSTREAM_URL,
            content=payload,
            headers={
                "Authorization": f"Bearer {self._keys[index]}",
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
            },
        )
        try:
            response = self._client.send(request, stream=True)
        except httpx.TimeoutException:
            return _Retry(transient, "timed out", timeout=True)
        except httpx.HTTPError:
            return _Retry(transient, "network error")

        status = response.status_code
        content_type = response.headers.get("content-type", "").lower()
        if status == 200 and content_type.startswith("text/event-stream"):
            chunks = response.iter_bytes()
            timed_out = False
            try:
                first = _first_chunk(chunks)
            except httpx.TimeoutException:
                first, timed_out = None, True
            except httpx.HTTPError:
                first = None
            if first:
                return UpstreamStream(first, chunks, response, stream_deadline, self._clock)
            response.close()
            return _Retry(transient, "no first byte in time" if timed_out else "empty stream", timeout=timed_out)

        # Any other answer: close it unread.
        response.close()
        if status == 429:
            retry_after = parse_retry_after(response.headers.get("retry-after"), self._wall_clock())
            seconds = cooldown["rateLimitedDefault"] / 1000 if retry_after is None else retry_after
            return _Retry(
                min(cooldown["rateLimitedMax"] / 1000, max(cooldown["rateLimitedMin"] / 1000, seconds)),
                "rate limited (429)",
            )
        if status in (401, 403):
            return _Retry(cooldown["auth"] / 1000, f"rejected ({status})")
        # Redirects are refused, as fetch(redirect: 'error') does in the Vercel Functions.
        if status == 408 or status >= 500 or 300 <= status < 400:
            return _Retry(transient, f"failed ({status})")
        return _Fatal("model_unavailable" if status == 404 else "upstream_rejected", status)


def build_router(raw_keys: list[str]) -> NvidiaRouter | None:
    """The router for NVIDIA_API_KEYS, or None without a valid key. Logs counts, never keys."""
    keys, invalid = parse_keys(raw_keys)
    if invalid:
        logger.warning("NVIDIA_API_KEYS: ignored %d malformed entries", invalid)
    if not keys:
        return None
    logger.info("NVIDIA key pool: %d keys", len(keys))
    return NvidiaRouter(keys)
