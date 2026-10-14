"""Tests for core/nvidia.py, the NVIDIA proxy behind /api/chat/nvidia.

Key parsing, the validation vectors shared with tests/unit/nvidia-proxy.test.mjs, Retry-After, the key
pool, the failover router, the stream guards and the rate limiter. Upstream calls go to
httpx.MockTransport and cooldowns use a fake clock, so no test waits and none reaches NVIDIA.
"""

from __future__ import annotations

import json
import threading
import unittest
from collections.abc import Callable, Iterable, Iterator
from datetime import UTC, datetime
from email.utils import format_datetime
from pathlib import Path
from typing import Any
from unittest import mock

import httpx

from core import nvidia
from core.config import DEFAULT_NVIDIA_RATE_LIMIT_PER_MINUTE

VECTORS: list[dict[str, Any]] = json.loads(
    (Path(__file__).with_name("test_fixtures") / "nvidia_validation.json").read_text(encoding="utf-8")
)["vectors"]
DEFAULT_MODEL: str = nvidia.CATALOG["defaultModel"]
BODY = {"model": DEFAULT_MODEL, "messages": [{"role": "user", "content": "Hi"}], "max_tokens": 16, "stream": True}
SSE = [b'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', b"data: [DONE]\n\n"]
SECRET_BODY = b"UPSTREAM-SECRET-BODY"
WALL_CLOCK = 1_700_000_000.0
TRANSIENT = nvidia.PROXY["cooldownMs"]["transient"] / 1000


def key(n: int) -> str:
    """A valid-format key built at runtime, so no key-shaped literal exists in the repository.

    A call, not ``"t" * 63``: CPython folds constant expressions, which would put a key-shaped
    string into the .pyc files that a local ``gitleaks dir`` scans.
    """
    return "nvapi-" + str(n).rjust(64, "t")


def expand(value: Any) -> Any:
    """Expands the ``{"$repeat": [text, n]}`` placeholders of the shared vectors."""
    if isinstance(value, list):
        return [expand(item) for item in value]
    if isinstance(value, dict):
        if list(value) == ["$repeat"]:
            text, times = value["$repeat"]
            return text * times
        return {name: expand(item) for name, item in value.items()}
    return value


class FakeClock:
    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now


class Body(httpx.SyncByteStream):
    """An upstream body that records whether it was read and whether it was closed."""

    def __init__(self, chunks: Iterable[bytes], error: Exception | None = None) -> None:
        self.chunks = chunks
        self.error = error
        self.read = False
        self.closed = False

    def __iter__(self) -> Iterator[bytes]:
        self.read = True
        yield from self.chunks
        if self.error is not None:
            raise self.error

    def close(self) -> None:
        self.closed = True


Answer = Callable[[httpx.Request], httpx.Response]


def sse(chunks: list[bytes] | None = None, error: Exception | None = None) -> Answer:
    return lambda request: event_stream(Body(list(SSE if chunks is None else chunks), error))


def event_stream(body: Body) -> httpx.Response:
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=body)


class Refusal:
    """An upstream answer whose body must stay unread; ``untouched`` checks every body it served."""

    def __init__(self, status: int, headers: dict[str, str] | None = None, content_type: str = "application/json"):
        self.status = status
        self.headers = {"content-type": content_type, **(headers or {})}
        self.bodies: list[Body] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = Body([SECRET_BODY])
        self.bodies.append(body)
        return httpx.Response(self.status, headers=self.headers, stream=body)

    @property
    def untouched(self) -> bool:
        return bool(self.bodies) and all(body.closed and not body.read for body in self.bodies)


def fail(exc: Exception) -> Answer:
    def respond(request: httpx.Request) -> httpx.Response:
        raise exc

    return respond


def stalled() -> Answer:
    """A 200 event stream whose first read times out."""
    return sse([], httpx.ReadTimeout("read timed out"))


class Upstream:
    """MockTransport handler that plays the answers in order (the last one repeats)."""

    def __init__(self, *answers: Answer) -> None:
        self.answers = answers
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.answers[min(len(self.requests), len(self.answers)) - 1](request)

    @property
    def keys(self) -> list[str]:
        return [request.headers["authorization"].removeprefix("Bearer ") for request in self.requests]


def make_router(upstream: Upstream, size: int = 2, clock: FakeClock | None = None) -> nvidia.NvidiaRouter:
    return nvidia.NvidiaRouter(
        [key(i + 1) for i in range(size)],
        transport=httpx.MockTransport(upstream),
        clock=clock or FakeClock(),
        wall_clock=lambda: WALL_CLOCK,
    )


def read_all(stream: nvidia.UpstreamStream) -> bytes:
    try:
        return stream.first + b"".join(stream.rest())
    finally:
        stream.close()


class ParseKeysTests(unittest.TestCase):
    def test_valid_keys_with_any_separator(self) -> None:
        raw = [f"{key(1)},{key(2)} {key(3)}\n{key(4)}\t", key(5)]
        self.assertEqual(nvidia.parse_keys(raw), ([key(n) for n in range(1, 6)], 0))

    def test_duplicates_are_dropped(self) -> None:
        self.assertEqual(nvidia.parse_keys([key(1), key(1), key(2)])[0], [key(1), key(2)])

    def test_malformed_entries_are_counted_not_kept(self) -> None:
        escaped = "nvapi-" + "".join("a\\_" for _ in range(32))
        raw = [key(1), key(1)[:-1], key(2).replace("nvapi-", "nvapx-"), escaped, key(3) + "x"]
        self.assertEqual(nvidia.parse_keys(raw), ([key(1)], 4))

    def test_empty_input(self) -> None:
        self.assertEqual(nvidia.parse_keys([]), ([], 0))
        self.assertEqual(nvidia.parse_keys([" ", ""]), ([], 0))


class ValidationTests(unittest.TestCase):
    def test_shared_vectors(self) -> None:
        self.assertGreaterEqual(len(VECTORS), 30)
        for vector in VECTORS:
            with self.subTest(vector["name"]):
                body = expand(vector["body"])
                expect = vector["expect"]
                if "upstream" in expect:
                    self.assertEqual(nvidia.validate_chat_request(body), expand(expect["upstream"]))
                else:
                    with self.assertRaises(nvidia.NvidiaValidationError) as ctx:
                        nvidia.validate_chat_request(body)
                    self.assertEqual(ctx.exception.error, expect["error"])
                    self.assertEqual(ctx.exception.details, {"field": expect["field"]} if "field" in expect else {})

    def test_max_tokens_is_always_an_integer(self) -> None:
        body = nvidia.validate_chat_request({**BODY, "max_tokens": 64.0})
        self.assertIs(type(body["max_tokens"]), int)

    def test_no_catalog_extra_overrides_the_validated_fields(self) -> None:
        for model in nvidia.CATALOG["models"]:
            with self.subTest(model["id"]):
                body = nvidia.validate_chat_request(
                    {"model": model["id"], "messages": BODY["messages"], "max_tokens": 10**6, "stream": False}
                )
                self.assertEqual(body["model"], model["id"])
                self.assertIs(body["stream"], True)
                self.assertEqual(body["max_tokens"], model["maxOutputTokens"])
                expected = {*model.get("upstream", {}), "model", "messages", "max_tokens", "stream"}
                self.assertEqual(set(body), expected)


class RetryAfterTests(unittest.TestCase):
    def test_seconds_and_http_dates(self) -> None:
        self.assertEqual(nvidia.parse_retry_after("12", WALL_CLOCK), 12.0)
        later = format_datetime(datetime.fromtimestamp(WALL_CLOCK + 50, UTC), usegmt=True)
        earlier = format_datetime(datetime.fromtimestamp(WALL_CLOCK - 50, UTC), usegmt=True)
        self.assertEqual(nvidia.parse_retry_after(later, WALL_CLOCK), 50.0)
        self.assertEqual(nvidia.parse_retry_after(earlier, WALL_CLOCK), 0.0)

    def test_garbage_is_none(self) -> None:
        for value in (None, "", "soon", "1.5", "-3", "2026-10-14", "Wed, 99 Oct 2026 10:00:00 GMT", "١٢"):
            with self.subTest(value=value):
                self.assertIsNone(nvidia.parse_retry_after(value, WALL_CLOCK))

    def test_cooldown_is_clamped_to_1_to_300_seconds(self) -> None:
        in_42 = format_datetime(datetime.fromtimestamp(WALL_CLOCK + 42, UTC), usegmt=True)
        cases = {"0": 1.0, "9999": 300.0, "9" * 5000: 300.0, in_42: 42.0, "later": 20.0}
        for value, expected in cases.items():
            with self.subTest(value=value[:20]):
                clock = FakeClock()
                router = make_router(Upstream(Refusal(429, {"retry-after": value})), size=1, clock=clock)
                with self.assertRaises(nvidia.NvidiaRouterError), self.assertLogs("core.nvidia", "WARNING"):
                    router.open_stream(BODY)
                self.assertEqual(router.pool.cooling_until(), [clock.now + expected])


class KeyPoolTests(unittest.TestCase):
    def test_round_robin_skips_cooling_keys(self) -> None:
        clock = FakeClock()
        pool = nvidia.KeyPool(3, clock)
        self.assertEqual(pool.order(), [0, 1, 2])
        pool.cool(1, 10)
        self.assertEqual(pool.order(), [2, 0])
        self.assertEqual(pool.order(), [2, 0])
        clock.now += 10
        self.assertEqual(pool.order(), [0, 1, 2])

    def test_cooldowns_only_grow_and_retry_after_is_clamped(self) -> None:
        clock = FakeClock()
        pool = nvidia.KeyPool(2, clock)
        pool.cool(0, 100)
        pool.cool(0, 5)
        self.assertEqual(pool.cooling_until()[0], clock.now + 100)
        pool.cool(1, 3600)
        self.assertEqual(pool.retry_after(), 100)
        clock.now += 99.5
        self.assertEqual(pool.retry_after(), 1)
        pool.cool(0, 1800)
        self.assertEqual(pool.retry_after(), nvidia.RETRY_AFTER_MAX_SECONDS)

    def test_concurrent_use_keeps_the_rotation_consistent(self) -> None:
        pool = nvidia.KeyPool(4)
        starts: list[int] = []
        lock = threading.Lock()

        def work() -> None:
            for _ in range(250):
                first = pool.order()[0]
                with lock:
                    starts.append(first)

        threads = [threading.Thread(target=work) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)
        self.assertEqual(len(starts), 2000)
        self.assertEqual({index: starts.count(index) for index in range(4)}, dict.fromkeys(range(4), 500))


class RouterTests(unittest.TestCase):
    def test_success_sends_bearer_to_fixed_url(self) -> None:
        upstream = Upstream(sse())
        stream = make_router(upstream).open_stream(BODY)
        self.assertEqual(read_all(stream), b"".join(SSE))
        [request] = upstream.requests
        self.assertEqual(str(request.url), nvidia.UPSTREAM_URL)
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.headers["authorization"], f"Bearer {key(1)}")
        self.assertEqual(request.headers["accept"], "text/event-stream")
        self.assertEqual(json.loads(request.content), BODY)
        self.assertNotIn(b"nvapi-", request.content)

    def test_payload_stays_valid_json_with_lone_surrogates(self) -> None:
        upstream = Upstream(sse())
        body = nvidia.validate_chat_request(
            {"model": DEFAULT_MODEL, "messages": [{"role": "user", "content": "\ud800"}]}
        )
        read_all(make_router(upstream).open_stream(body))
        self.assertEqual(json.loads(upstream.requests[0].content)["messages"][0]["content"], "\ud800")

    def test_429_fails_over_and_cools_for_retry_after(self) -> None:
        clock = FakeClock()
        limited = Refusal(429, {"retry-after": "12"})
        upstream = Upstream(limited, sse())
        router = make_router(upstream, clock=clock)
        with self.assertLogs("core.nvidia", "WARNING"):
            self.assertEqual(read_all(router.open_stream(BODY)), b"".join(SSE))
        self.assertEqual(upstream.keys, [key(1), key(2)])
        self.assertEqual(router.pool.cooling_until(), [clock.now + 12, 0.0])
        self.assertTrue(limited.untouched)

    def test_5xx_408_redirects_and_network_errors_fail_over(self) -> None:
        clock = FakeClock()
        answers = [
            Refusal(500),
            Refusal(502),
            Refusal(503),
            Refusal(408),
            Refusal(307, {"location": "https://elsewhere.example/"}),
            fail(httpx.ConnectError("connection refused")),
        ]
        upstream = Upstream(*answers, sse())
        router = make_router(upstream, size=7, clock=clock)
        with self.assertLogs("core.nvidia", "WARNING"):
            self.assertEqual(read_all(router.open_stream(BODY)), b"".join(SSE))
        self.assertEqual(len(upstream.requests), 7)
        self.assertEqual(router.pool.cooling_until(), [clock.now + TRANSIENT] * 6 + [0.0])
        self.assertTrue(all(answer.untouched for answer in answers if isinstance(answer, Refusal)))

    def test_read_timeout_before_first_byte_fails_over(self) -> None:
        clock = FakeClock()
        router = make_router(Upstream(stalled(), sse()), clock=clock)
        with self.assertLogs("core.nvidia", "WARNING") as logs:
            self.assertEqual(read_all(router.open_stream(BODY)), b"".join(SSE))
        self.assertIn("no first byte in time", logs.output[0])
        self.assertEqual(router.pool.cooling_until()[0], clock.now + TRANSIENT)

    def test_empty_200_fails_over(self) -> None:
        upstream = Upstream(sse([]), sse([b"", *SSE]))
        with self.assertLogs("core.nvidia", "WARNING") as logs:
            self.assertEqual(read_all(make_router(upstream).open_stream(BODY)), b"".join(SSE))
        self.assertIn("empty stream", logs.output[0])

    def test_401_403_park_key_for_auth_cooldown(self) -> None:
        for status in (401, 403):
            with self.subTest(status=status):
                clock = FakeClock()
                upstream = Upstream(sse(), Refusal(status), sse())
                router = make_router(upstream, clock=clock)
                with self.assertLogs("core.nvidia", "WARNING"):
                    for _ in range(4):
                        read_all(router.open_stream(BODY))
                # Request 2 starts at key 2, which is rejected; requests 3 and 4 skip it.
                self.assertEqual(upstream.keys, [key(1), key(2), key(1), key(1), key(1)])
                self.assertEqual(router.pool.cooling_until(), [0.0, clock.now + 1800])

    def test_all_failed_raises_503_with_retry_after(self) -> None:
        router = make_router(Upstream(Refusal(429, {"retry-after": "12"}), Refusal(429, {"retry-after": "7"})))
        with self.assertRaises(nvidia.NvidiaRouterError) as ctx, self.assertLogs("core.nvidia", "WARNING"):
            router.open_stream(BODY)
        self.assertEqual((ctx.exception.status, ctx.exception.error), (503, "all_keys_exhausted"))
        self.assertEqual(ctx.exception.headers, {"Retry-After": "7"})

    def test_all_cooling_raises_503_without_request(self) -> None:
        clock = FakeClock()
        upstream = Upstream(Refusal(429, {"retry-after": "30"}))
        router = make_router(upstream, clock=clock)
        with self.assertRaises(nvidia.NvidiaRouterError), self.assertLogs("core.nvidia", "WARNING"):
            router.open_stream(BODY)
        clock.now += 10.5
        with self.assertRaises(nvidia.NvidiaRouterError) as ctx:
            router.open_stream(BODY)
        self.assertEqual(ctx.exception.headers, {"Retry-After": "20"})
        self.assertEqual(len(upstream.requests), 2)

    def test_all_timeouts_raise_504(self) -> None:
        router = make_router(Upstream(fail(httpx.ConnectTimeout("connect timed out")), stalled()))
        with self.assertRaises(nvidia.NvidiaRouterError) as ctx, self.assertLogs("core.nvidia", "WARNING"):
            router.open_stream(BODY)
        self.assertEqual(
            (ctx.exception.status, ctx.exception.error, ctx.exception.headers), (504, "upstream_timeout", {})
        )

    def test_4xx_not_retried_and_body_not_echoed(self) -> None:
        cases = [
            (Refusal(400), "upstream_rejected"),
            (Refusal(404), "model_unavailable"),
            (Refusal(422), "upstream_rejected"),
            (Refusal(200), "upstream_rejected"),
        ]
        for refusal, error in cases:
            with self.subTest(status=refusal.status, error=error):
                upstream = Upstream(refusal, sse())
                router = make_router(upstream)
                with (
                    self.assertRaises(nvidia.NvidiaRouterError) as ctx,
                    self.assertLogs("core.nvidia", "WARNING") as logs,
                ):
                    router.open_stream(BODY)
                self.assertEqual((ctx.exception.status, ctx.exception.error), (502, error))
                self.assertEqual(len(upstream.requests), 1)
                self.assertTrue(refusal.untouched)
                self.assertNotIn(SECRET_BODY.decode(), str(ctx.exception) + "\n".join(logs.output))
                self.assertEqual(router.pool.cooling_until(), [0.0, 0.0])

    def test_round_robin_across_requests(self) -> None:
        upstream = Upstream(sse())
        router = make_router(upstream, size=3)
        for _ in range(4):
            read_all(router.open_stream(BODY))
        self.assertEqual(upstream.keys, [key(1), key(2), key(3), key(1)])

    def test_deadline_stops_failover(self) -> None:
        clock = FakeClock()

        def slow_429(request: httpx.Request) -> httpx.Response:
            clock.now += 10  # the failover budget is 25 s
            return Refusal(429)(request)

        upstream = Upstream(slow_429)
        router = make_router(upstream, size=5, clock=clock)
        with self.assertRaises(nvidia.NvidiaRouterError) as ctx, self.assertLogs("core.nvidia", "WARNING"):
            router.open_stream(BODY)
        self.assertEqual(len(upstream.requests), 3)
        self.assertEqual((ctx.exception.status, ctx.exception.headers), (503, {"Retry-After": "1"}))

    def test_keys_never_logged(self) -> None:
        answers = [
            Refusal(429),
            Refusal(401),
            Refusal(500),
            fail(httpx.ConnectError("refused")),
            stalled(),
            Refusal(404),
        ]
        router = make_router(Upstream(*answers), size=6)
        with self.assertRaises(nvidia.NvidiaRouterError), self.assertLogs("core.nvidia", "WARNING") as logs:
            router.open_stream(BODY)
        self.assertEqual(len(logs.output), 6)
        self.assertIn("nvidia: key 1/6 rate limited (429), cooling 20 s", logs.output[0])
        self.assertIn("nvidia: key 6/6 got 404, not retried", logs.output[5])
        self.assertNotIn("nvapi-", "\n".join(logs.output))


class UpstreamStreamTests(unittest.TestCase):
    def open(self, answer: Answer, clock: FakeClock | None = None) -> nvidia.UpstreamStream:
        return make_router(Upstream(answer), clock=clock).open_stream(BODY)

    def test_read_timeout_ends_with_stream_timeout(self) -> None:
        stream = self.open(sse([b"data: 1\n\n", b"data: 2\n\n"], httpx.ReadTimeout("idle")))
        self.assertEqual(read_all(stream), b"data: 1\n\ndata: 2\n\n")
        self.assertEqual(stream.error_code, "stream_timeout")

    def test_read_error_ends_with_upstream_interrupted(self) -> None:
        stream = self.open(sse([b"data: 1\n\n"], httpx.ReadError("connection reset")))
        self.assertEqual(read_all(stream), b"data: 1\n\n")
        self.assertEqual(stream.error_code, "upstream_interrupted")

    def test_size_cap_ends_with_stream_too_large(self) -> None:
        with mock.patch.dict(nvidia.PROXY, {"maxStreamBytes": 16}):
            stream = self.open(sse([b"data: 1\n\n", b"data: 22222222\n\n", b"data: 3\n\n"]))
            self.assertEqual(read_all(stream), b"data: 1\n\n")
        self.assertEqual(stream.error_code, "stream_too_large")

    def test_stream_deadline_ends_with_stream_timeout(self) -> None:
        clock = FakeClock()

        def chunks() -> Iterator[bytes]:
            yield b"data: 1\n\n"
            clock.now += nvidia.PROXY["streamMaxMs"] / 1000 + 1
            yield b"data: 2\n\n"

        stream = self.open(lambda request: event_stream(Body(chunks())), clock)
        self.assertEqual(read_all(stream), b"data: 1\n\n")
        self.assertEqual(stream.error_code, "stream_timeout")

    def test_complete_stream_has_no_error_and_close_releases_the_upstream(self) -> None:
        body = Body(list(SSE))
        stream = self.open(lambda request: event_stream(body))
        self.assertEqual(read_all(stream), b"".join(SSE))
        self.assertIsNone(stream.error_code)
        self.assertTrue(body.closed)

    def test_sse_error_event(self) -> None:
        self.assertEqual(nvidia.sse_error("stream_timeout"), b'\n\ndata: {"error":{"code":"stream_timeout"}}\n\n')


class RateLimiterTests(unittest.TestCase):
    def test_fixed_window_per_key(self) -> None:
        clock = FakeClock()
        limiter = nvidia.RateLimiter(2, 60, clock)
        self.assertIsNone(limiter.hit("a"))
        clock.now += 15
        self.assertIsNone(limiter.hit("a"))
        self.assertEqual(limiter.hit("a"), 45)
        self.assertIsNone(limiter.hit("b"))
        clock.now += 45
        self.assertIsNone(limiter.hit("a"))

    def test_full_table_forgets_expired_then_oldest_windows(self) -> None:
        clock = FakeClock()
        limiter = nvidia.RateLimiter(1, 1, clock, max_entries=2)
        self.assertIsNone(limiter.hit("a"))
        self.assertIsNotNone(limiter.hit("a"))
        self.assertIsNone(limiter.hit("b"))
        self.assertIsNone(limiter.hit("c"))
        self.assertIsNone(limiter.hit("a"), "the dropped address starts a new window")


class CatalogTests(unittest.TestCase):
    def test_catalog_shape(self) -> None:
        ids = [model["id"] for model in nvidia.CATALOG["models"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertIn(DEFAULT_MODEL, ids)
        for model_id in ids:
            self.assertRegex(model_id, r"^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$")
        self.assertTrue(all(isinstance(value, int) and value > 0 for value in nvidia.LIMITS.values()))
        self.assertEqual(nvidia.UPSTREAM_URL, "https://integrate.api.nvidia.com/v1/chat/completions")

    def test_rate_limit_default_matches_the_catalog(self) -> None:
        self.assertEqual(DEFAULT_NVIDIA_RATE_LIMIT_PER_MINUTE, nvidia.PROXY["rateLimitPerMinute"])

    def test_public_catalog_has_no_upstream_extras_or_keys(self) -> None:
        body = nvidia.public_catalog(True)
        self.assertEqual(list(body), ["configured", "version", "defaultModel", "limits", "models"])
        self.assertEqual([model["id"] for model in body["models"]], [model["id"] for model in nvidia.CATALOG["models"]])
        self.assertTrue(all(list(model) == list(nvidia.PUBLIC_MODEL_FIELDS) for model in body["models"]))
        self.assertFalse(nvidia.public_catalog(False)["configured"])


class BuildRouterTests(unittest.TestCase):
    def test_no_valid_key_means_no_router(self) -> None:
        self.assertIsNone(nvidia.build_router([]))
        with self.assertLogs("core.nvidia", "WARNING") as logs:
            self.assertIsNone(nvidia.build_router(["not-a-key"]))
        self.assertNotIn("not-a-key", "\n".join(logs.output))

    def test_router_logs_counts_only(self) -> None:
        with self.assertLogs("core.nvidia", "INFO") as logs:
            router = nvidia.build_router([key(1), f"{key(2)}, broken"])
        self.assertIsNotNone(router)
        self.assertEqual(router.pool.size if router else 0, 2)
        text = "\n".join(logs.output)
        self.assertIn("2 keys", text)
        self.assertIn("ignored 1 malformed", text)
        self.assertNotIn("nvapi-", text)
        self.assertNotIn("broken", text)


if __name__ == "__main__":
    unittest.main()
