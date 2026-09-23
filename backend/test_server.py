"""Tests for the HTTP API in server.py.

Each test starts the server on 127.0.0.1 with an ephemeral port in a background thread.
Ingestion, query and storage are replaced with fakes, so no external service is contacted.
"""

from __future__ import annotations

import dataclasses
import http.client
import json
import socket
import threading
import unittest
from http.server import ThreadingHTTPServer
from typing import Any
from unittest import mock

import server
from core.config import BrainConfig

ALLOWED_ORIGIN = "https://starpi.app"
TOKEN = "test-token-0123456789abcdef0123456789"
LLM_ENDPOINT = "http://llm.internal.example:8000/v1"


class FakeDB:
    is_live = False

    def list_documents(self) -> list[dict[str, Any]]:
        return [{"id": "doc-1", "title": "Doc"}]


def make_settings(**overrides: Any) -> BrainConfig:
    base = BrainConfig(
        supabase_url="",
        supabase_key="",
        llm_base_url=LLM_ENDPOINT,
        allowed_origins=[ALLOWED_ORIGIN],
        api_token="",
        max_body_bytes=1_048_576,
    )
    return dataclasses.replace(base, **overrides)


class Response:
    def __init__(self, status: int, headers: dict[str, str], raw: bytes) -> None:
        self.status = status
        self.headers = headers
        self.raw = raw

    @property
    def json(self) -> Any:
        return json.loads(self.raw) if self.raw else None


class ServerTestCase(unittest.TestCase):
    settings_overrides: dict[str, Any] = {}

    def setUp(self) -> None:
        self.ingest_calls: list[dict[str, Any]] = []
        self.query_calls: list[str] = []
        for target, value in (
            ("ingest_raw_information", mock.Mock(side_effect=self.fake_ingest)),
            ("query_brain", mock.Mock(side_effect=self.fake_query)),
            ("db", FakeDB()),
        ):
            patcher = mock.patch.object(server, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.start_server(**self.settings_overrides)

    def fake_ingest(self, raw_text: str, source_name: str, source_type: str) -> dict[str, Any]:
        self.ingest_calls.append({"raw_text": raw_text, "source_name": source_name, "source_type": source_type})
        return {"document_id": "doc-1", "status": "success"}

    def fake_query(self, user_query: str) -> dict[str, Any]:
        self.query_calls.append(user_query)
        return {"answer": "42", "sources": []}

    def start_server(self, **overrides: Any) -> None:
        self.httpd = server.create_server("127.0.0.1", 0, make_settings(**overrides))
        thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        self.addCleanup(self.stop_server, thread)
        self.port = self.httpd.server_address[1]

    def stop_server(self, thread: threading.Thread) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        thread.join(timeout=5)

    def request(
        self, method: str, path: str, body: bytes | None = None, headers: dict[str, str] | None = None
    ) -> Response:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            resp = conn.getresponse()
            return Response(resp.status, {k.lower(): v for k, v in resp.getheaders()}, resp.read())
        finally:
            conn.close()

    def raw_request(self, method: str, path: str, headers: dict[str, str], body: bytes = b"") -> Response:
        """Sends exactly the given headers (http.client adds no Content-Length here)."""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.putrequest(method, path)
            for name, value in headers.items():
                conn.putheader(name, value)
            conn.endheaders(body or None)
            resp = conn.getresponse()
            return Response(resp.status, {k.lower(): v for k, v in resp.getheaders()}, resp.read())
        finally:
            conn.close()

    def socket_request(self, raw: bytes) -> Response:
        """Sends ``raw`` bytes on a plain socket, keeps it open and parses the reply."""
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as sock:
            sock.sendall(raw)
            resp = http.client.HTTPResponse(sock)
            resp.begin()
            return Response(resp.status, {k.lower(): v for k, v in resp.getheaders()}, resp.read())

    def post_json(self, path: str, payload: Any, headers: dict[str, str] | None = None) -> Response:
        body = json.dumps(payload).encode("utf-8")
        return self.request("POST", path, body, {"Content-Type": "application/json", **(headers or {})})


class HealthAndRoutingTests(ServerTestCase):
    def test_health_does_not_leak_configuration(self) -> None:
        resp = self.request("GET", "/api/health")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.json, {"status": "healthy", "supabase_live": False})
        self.assertNotIn(b"llm.internal.example", resp.raw)
        self.assertEqual(resp.headers["x-content-type-options"], "nosniff")
        self.assertEqual(resp.headers["cache-control"], "no-store")
        self.assertTrue(resp.headers["content-type"].startswith("application/json"))
        self.assertNotIn("python", resp.headers.get("server", "").lower())

    def test_unknown_path_is_404(self) -> None:
        self.assertEqual(self.request("GET", "/nope").status, 404)
        self.assertEqual(self.request("GET", "/api/health/extra").status, 404)
        resp = self.post_json("/api/brain/unknown", {})
        self.assertEqual(resp.status, 404)
        self.assertEqual(resp.json, {"error": "not_found"})

    def test_wrong_method_is_405(self) -> None:
        resp = self.request("GET", "/api/brain/query")
        self.assertEqual(resp.status, 405)
        self.assertEqual(resp.headers["allow"], "POST, OPTIONS")

    def test_unsupported_method_returns_json(self) -> None:
        resp = self.request("PUT", "/api/health", body=b"{}")
        self.assertEqual(resp.status, 501)
        self.assertEqual(resp.json, {"error": "not_implemented"})

    def test_documents_query_and_ingest(self) -> None:
        docs = self.request("GET", "/api/brain/documents")
        self.assertEqual(docs.status, 200)
        self.assertEqual(docs.json["count"], 1)

        query = self.post_json("/api/brain/query", {"query": "Was ist Starpi?"})
        self.assertEqual(query.status, 200)
        self.assertEqual(query.json["answer"], "42")
        self.assertEqual(self.query_calls, ["Was ist Starpi?"])

        ingest = self.post_json("/api/brain/ingest", {"text": "Notiz", "extra": True})
        self.assertEqual(ingest.status, 200)
        self.assertEqual(self.ingest_calls, [{"raw_text": "Notiz", "source_name": "Web-Upload", "source_type": "text"}])

    def test_handler_exception_returns_generic_500(self) -> None:
        with (
            mock.patch.object(server, "query_brain", side_effect=RuntimeError("secret detail")),
            self.assertLogs("server", "ERROR"),
        ):
            resp = self.post_json("/api/brain/query", {"query": "x"})
        self.assertEqual(resp.status, 500)
        self.assertEqual(resp.json, {"error": "internal_error"})
        self.assertNotIn(b"secret detail", resp.raw)

    def test_requests_are_served_concurrently(self) -> None:
        release = threading.Event()
        entered = threading.Event()

        def slow_query(user_query: str) -> dict[str, Any]:
            entered.set()
            release.wait(5)
            return {"answer": "slow", "sources": []}

        results: list[int] = []
        with mock.patch.object(server, "query_brain", side_effect=slow_query):
            worker = threading.Thread(
                target=lambda: results.append(self.post_json("/api/brain/query", {"query": "x"}).status)
            )
            worker.start()
            try:
                self.assertTrue(entered.wait(5))
                self.assertEqual(self.request("GET", "/api/health").status, 200)
            finally:
                release.set()
                worker.join(5)
        self.assertEqual(results, [200])

    def test_foreign_host_header_is_rejected_without_token(self) -> None:
        resp = self.request("GET", "/api/brain/documents", headers={"Host": "rebind.example:9200"})
        self.assertEqual(resp.status, 403)
        self.assertEqual(resp.json, {"error": "host_not_allowed"})
        self.assertEqual(self.request("GET", "/api/health", headers={"Host": "localhost:9200"}).status, 200)


class BodyValidationTests(ServerTestCase):
    settings_overrides = {"max_body_bytes": 1024}

    def test_oversize_body_is_413(self) -> None:
        resp = self.post_json("/api/brain/query", {"query": "x" * 4000})
        self.assertEqual(resp.status, 413)
        self.assertEqual(resp.json["error"], "payload_too_large")
        declared = self.raw_request(
            "POST", "/api/brain/query", {"Content-Type": "application/json", "Content-Length": "999999999"}
        )
        self.assertEqual(declared.status, 413)
        self.assertEqual(self.query_calls, [])

    def test_content_length_is_validated(self) -> None:
        missing = self.raw_request("POST", "/api/brain/query", {"Content-Type": "application/json"})
        self.assertEqual(missing.status, 411)
        for value in ("-1", "abc", "1_0", "+5", "1e3", "5, 5"):
            with self.subTest(value=value):
                resp = self.raw_request(
                    "POST", "/api/brain/query", {"Content-Type": "application/json", "Content-Length": value}
                )
                self.assertEqual(resp.status, 400)
                self.assertEqual(resp.json["error"], "invalid_content_length")

    def test_huge_content_length_is_413_not_500(self) -> None:
        # 5000 digits is above Python's default int() digit limit (4300), which used to raise.
        for value in ("9" * 5000, "1" + "0" * 30):
            with self.subTest(digits=len(value)):
                resp = self.raw_request(
                    "POST", "/api/brain/query", {"Content-Type": "application/json", "Content-Length": value}
                )
                self.assertEqual(resp.status, 413)
                self.assertEqual(resp.json["error"], "payload_too_large")
        self.assertEqual(self.query_calls, [])

    def test_huge_content_length_on_error_path(self) -> None:
        # Error responses drain small unread bodies; a huge value must not break that path.
        resp = self.raw_request("POST", "/nope", {"Content-Type": "application/json", "Content-Length": "9" * 5000})
        self.assertEqual(resp.status, 404)
        self.assertEqual(resp.json, {"error": "not_found"})

    def test_leading_zeros_are_accepted(self) -> None:
        body = b'{"query": "x"}'
        resp = self.raw_request(
            "POST",
            "/api/brain/query",
            {"Content-Type": "application/json", "Content-Length": "0" * 40 + str(len(body))},
            body,
        )
        self.assertEqual(resp.status, 200)
        self.assertEqual(self.query_calls, ["x"])

    def test_json_content_type_is_required(self) -> None:
        resp = self.request("POST", "/api/brain/query", b'{"query": "x"}', {"Content-Type": "text/plain"})
        self.assertEqual(resp.status, 415)
        ok = self.request(
            "POST", "/api/brain/query", b'{"query": "x"}', {"Content-Type": "application/json; charset=utf-8"}
        )
        self.assertEqual(ok.status, 200)

    def test_invalid_json_and_non_object(self) -> None:
        headers = {"Content-Type": "application/json"}
        cases = {
            b"{": "invalid_json",
            b"": "invalid_json",
            b"\xff\xfe": "invalid_json",
            b"[1, 2]": "json_body_must_be_object",
            b'"text"': "json_body_must_be_object",
        }
        for body, error in cases.items():
            with self.subTest(body=body):
                resp = self.request("POST", "/api/brain/query", body, headers)
                self.assertEqual(resp.status, 400)
                self.assertEqual(resp.json["error"], error)
        self.assertEqual(self.query_calls, [])

    def test_field_types_and_presence(self) -> None:
        cases = [
            ("/api/brain/query", {"query": 123}, "query"),
            ("/api/brain/query", {"query": ["a"]}, "query"),
            ("/api/brain/query", {}, "query"),
            ("/api/brain/query", {"query": "   "}, "query"),
            ("/api/brain/ingest", {"text": {"a": 1}}, "text"),
            ("/api/brain/ingest", {"text": "ok", "source_name": 5}, "source_name"),
            ("/api/brain/ingest", {"text": "ok", "source_type": False}, "source_type"),
        ]
        for path, payload, field in cases:
            with self.subTest(path=path, payload=payload):
                resp = self.post_json(path, payload)
                self.assertEqual(resp.status, 400)
                self.assertEqual(resp.json["error"], "invalid_field")
                self.assertEqual(resp.json["field"], field)
        self.assertEqual(self.query_calls, [])
        self.assertEqual(self.ingest_calls, [])


class TimeoutTests(ServerTestCase):
    def test_handler_has_a_socket_timeout(self) -> None:
        self.assertEqual(server.BrainAPIHandler.timeout, server.REQUEST_TIMEOUT_SECONDS)
        self.assertGreater(server.REQUEST_TIMEOUT_SECONDS, 0)

    def test_stalled_body_is_408(self) -> None:
        head = (
            b"POST /api/brain/query HTTP/1.1\r\nHost: 127.0.0.1\r\n"
            b"Content-Type: application/json\r\nContent-Length: 50\r\n\r\n"
        )
        with mock.patch.object(server.BrainAPIHandler, "timeout", 0.3):
            resp = self.socket_request(head + b'{"query": ')
        self.assertEqual(resp.status, 408)
        self.assertEqual(resp.json, {"error": "request_timeout"})
        self.assertEqual(resp.headers["connection"], "close")
        self.assertEqual(self.query_calls, [])


class ProxyWithoutTokenTests(ServerTestCase):
    def test_forwarded_requests_are_refused_without_token(self) -> None:
        for name in server.PROXY_HEADERS:
            with self.subTest(header=name):
                resp = self.request("GET", "/api/health", headers={name: "203.0.113.7"})
                self.assertEqual(resp.status, 401)
                self.assertEqual(resp.json, {"error": "api_token_required_behind_proxy"})
                self.assertIn("Bearer", resp.headers["www-authenticate"])

    def test_forwarded_brain_requests_never_reach_the_handlers(self) -> None:
        headers = {"X-Forwarded-For": "203.0.113.7", "Host": "127.0.0.1:9200"}
        self.assertEqual(self.post_json("/api/brain/query", {"query": "x"}, headers=headers).status, 401)
        self.assertEqual(self.post_json("/api/brain/ingest", {"text": "x"}, headers=headers).status, 401)
        self.assertEqual(self.request("GET", "/api/brain/documents", headers=headers).status, 401)
        self.assertEqual(self.query_calls, [])
        self.assertEqual(self.ingest_calls, [])

    def test_header_names_are_case_insensitive_and_empty_values_count(self) -> None:
        for headers in ({"x-real-ip": "10.0.0.1"}, {"FORWARDED": "for=10.0.0.1"}, {"X-Forwarded-For": ""}):
            with self.subTest(headers=headers):
                self.assertEqual(self.request("GET", "/api/health", headers=headers).status, 401)

    def test_direct_local_requests_still_work(self) -> None:
        self.assertEqual(self.request("GET", "/api/health").status, 200)
        self.assertEqual(self.post_json("/api/brain/query", {"query": "x"}).status, 200)


class LengthLimitTests(ServerTestCase):
    def test_text_and_query_length_limits(self) -> None:
        too_long_text = self.post_json("/api/brain/ingest", {"text": "a" * (server.MAX_TEXT_CHARS + 1)})
        self.assertEqual(too_long_text.status, 400)
        self.assertEqual(too_long_text.json["field"], "text")
        too_long_query = self.post_json("/api/brain/query", {"query": "q" * (server.MAX_QUERY_CHARS + 1)})
        self.assertEqual(too_long_query.status, 400)
        self.assertEqual(self.post_json("/api/brain/query", {"query": "q" * server.MAX_QUERY_CHARS}).status, 200)


class AuthTests(ServerTestCase):
    settings_overrides = {"api_token": TOKEN}

    def test_brain_endpoints_require_token(self) -> None:
        self.assertEqual(self.request("GET", "/api/brain/documents").status, 401)
        resp = self.post_json("/api/brain/query", {"query": "x"})
        self.assertEqual(resp.status, 401)
        self.assertEqual(resp.json, {"error": "unauthorized"})
        self.assertIn("Bearer", resp.headers["www-authenticate"])
        self.assertEqual(self.query_calls, [])

    def test_wrong_token_or_scheme_is_rejected(self) -> None:
        for value in (f"Bearer {TOKEN}x", "Bearer ", f"Basic {TOKEN}", TOKEN):
            with self.subTest(value=value):
                resp = self.request("GET", "/api/brain/documents", headers={"Authorization": value})
                self.assertEqual(resp.status, 401)

    def test_valid_token_is_accepted(self) -> None:
        auth = {"Authorization": f"Bearer {TOKEN}"}
        self.assertEqual(self.request("GET", "/api/brain/documents", headers=auth).status, 200)
        self.assertEqual(self.post_json("/api/brain/query", {"query": "x"}, headers=auth).status, 200)

    def test_health_and_preflight_need_no_token(self) -> None:
        self.assertEqual(self.request("GET", "/api/health").status, 200)
        preflight = self.request("OPTIONS", "/api/brain/query", headers={"Origin": ALLOWED_ORIGIN})
        self.assertEqual(preflight.status, 204)

    def test_host_header_is_not_restricted_with_token(self) -> None:
        resp = self.request("GET", "/api/health", headers={"Host": "brain.example.com"})
        self.assertEqual(resp.status, 200)

    def test_proxied_requests_work_with_token(self) -> None:
        proxied = {"X-Forwarded-For": "203.0.113.7", "X-Forwarded-Proto": "https", "Host": "brain.example.com"}
        self.assertEqual(self.request("GET", "/api/health", headers=proxied).status, 200)
        self.assertEqual(self.request("GET", "/api/brain/documents", headers=proxied).status, 401)
        auth = {**proxied, "Authorization": f"Bearer {TOKEN}"}
        self.assertEqual(self.request("GET", "/api/brain/documents", headers=auth).status, 200)


class CorsTests(ServerTestCase):
    def test_allowed_origin_is_echoed(self) -> None:
        resp = self.request("GET", "/api/health", headers={"Origin": ALLOWED_ORIGIN})
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers["access-control-allow-origin"], ALLOWED_ORIGIN)
        self.assertIn("Origin", resp.headers["vary"])

    def test_other_origins_get_no_cors_header(self) -> None:
        for origin in ("https://evil.example", "null", "https://starpi.app.evil.example"):
            with self.subTest(origin=origin):
                resp = self.request("GET", "/api/health", headers={"Origin": origin})
                self.assertEqual(resp.status, 403)
                self.assertNotIn("access-control-allow-origin", resp.headers)
        no_origin = self.request("GET", "/api/health")
        self.assertNotIn("access-control-allow-origin", no_origin.headers)
        self.assertIn("Origin", no_origin.headers["vary"])

    def test_preflight_for_allowed_origin(self) -> None:
        resp = self.request(
            "OPTIONS",
            "/api/brain/ingest",
            headers={
                "Origin": ALLOWED_ORIGIN,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization, content-type",
            },
        )
        self.assertEqual(resp.status, 204)
        self.assertEqual(resp.raw, b"")
        self.assertEqual(resp.headers["access-control-allow-origin"], ALLOWED_ORIGIN)
        self.assertIn("POST", resp.headers["access-control-allow-methods"])
        self.assertIn("Authorization", resp.headers["access-control-allow-headers"])
        self.assertNotEqual(resp.headers.get("access-control-allow-origin"), "*")

    def test_preflight_for_other_origin_is_refused(self) -> None:
        resp = self.request("OPTIONS", "/api/brain/ingest", headers={"Origin": "https://evil.example"})
        self.assertEqual(resp.status, 403)
        self.assertNotIn("access-control-allow-origin", resp.headers)
        self.assertNotIn("access-control-allow-methods", resp.headers)

    def test_preflight_for_unknown_path_is_404(self) -> None:
        self.assertEqual(self.request("OPTIONS", "/nope", headers={"Origin": ALLOWED_ORIGIN}).status, 404)


class StartupTests(unittest.TestCase):
    def test_refuses_public_bind_without_token(self) -> None:
        with self.assertRaises(SystemExit) as ctx, self.assertLogs("server", "ERROR"):
            server.run_server(0, "0.0.0.0", settings=make_settings(api_token=""))
        self.assertEqual(ctx.exception.code, 2)

    def test_is_loopback_host(self) -> None:
        for host in ("127.0.0.1", "127.0.0.2", "localhost", "LOCALHOST", "::1", "[::1]"):
            with self.subTest(host=host):
                self.assertTrue(server.is_loopback_host(host))
        for host in ("0.0.0.0", "", "::", "10.0.0.1", "example.com", "localhost.example.com"):
            with self.subTest(host=host):
                self.assertFalse(server.is_loopback_host(host))

    def test_server_is_threaded(self) -> None:
        self.assertTrue(issubclass(server.BrainHTTPServer, ThreadingHTTPServer))
        self.assertTrue(server.BrainHTTPServer.daemon_threads)

    def test_main_uses_the_validated_log_level(self) -> None:
        with (
            mock.patch.object(server, "config", make_settings(log_level="WARNING")),
            mock.patch.object(server, "run_server") as run,
            mock.patch.object(server.logging, "basicConfig") as basic,
        ):
            self.assertEqual(server.main([]), 0)
            self.assertEqual(basic.call_args.kwargs["level"], "WARNING")
            server.main(["--log-level", "debug"])
            self.assertEqual(basic.call_args.kwargs["level"], "DEBUG")
        self.assertEqual(run.call_count, 2)


class ContentLengthParsingTests(unittest.TestCase):
    def test_parse_content_length(self) -> None:
        cases = {
            "0": 0,
            "17": 17,
            " 42 ": 42,
            "000": 0,
            "0" * 100 + "7": 7,
            "9" * server.MAX_CONTENT_LENGTH_DIGITS: int("9" * server.MAX_CONTENT_LENGTH_DIGITS),
            "1" + "0" * server.MAX_CONTENT_LENGTH_DIGITS: 10**server.MAX_CONTENT_LENGTH_DIGITS,
            "9" * 100_000: 10**server.MAX_CONTENT_LENGTH_DIGITS,
            "": None,
            "-1": None,
            "+1": None,
            "1.0": None,
            "0x10": None,
            "²": None,
            "١٢": None,
        }
        for value, expected in cases.items():
            with self.subTest(value=value[:20]):
                self.assertEqual(server.parse_content_length(value), expected)


if __name__ == "__main__":
    unittest.main()
