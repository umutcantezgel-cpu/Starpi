"""HTTP API of the brain backend (standard library only).

Endpoints:
    GET  /api/health            liveness probe; never requires a token
    GET  /api/brain/documents   newest documents
    POST /api/brain/ingest      {"text": str, "source_name"?: str, "source_type"?: str}
    POST /api/brain/query       {"query": str}

The server binds to 127.0.0.1 by default and refuses any other address unless BRAIN_API_TOKEN is
set. With a token, /api/brain/* requires ``Authorization: Bearer <token>``. Without one the API is
for local use only: only loopback Host headers are accepted (DNS rebinding guard), and requests
that carry reverse proxy headers (Forwarded, X-Forwarded-*, X-Real-IP) are refused with 401,
because a proxy on the same host makes every request look like it comes from loopback. That check
is a safety net only (nginx, for example, adds none of these headers by default): always set a
token when a proxy is in front. TLS is expected to be terminated by that reverse proxy.
"""

from __future__ import annotations

import argparse
import hmac
import ipaddress
import json
import logging
import signal
import socket
import socketserver
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from core.config import LOG_LEVELS, BrainConfig, config
from core.ingestion_pipeline import ingest_raw_information
from core.rag import query_brain
from core.supabase_client import db

logger = logging.getLogger("server")

MAX_TEXT_CHARS = 200_000
MAX_QUERY_CHARS = 4_000
MAX_SOURCE_NAME_CHARS = 256
MAX_SOURCE_TYPE_CHARS = 64

# Per-connection socket timeout (applied by StreamRequestHandler.setup via ``timeout``); bounds
# slow or stalled clients. A body that stalls longer than this is answered with 408.
REQUEST_TIMEOUT_SECONDS = 30
# Longest Content-Length value accepted for parsing, in significant digits. Anything longer is far
# above any body limit; bounding it keeps int() away from huge digit strings.
MAX_CONTENT_LENGTH_DIGITS = 18
# Unread request bodies up to this size are drained before an error response so the client gets a
# clean close instead of a TCP reset.
MAX_DRAIN_BYTES = 65_536
DRAIN_TIMEOUT_SECONDS = 1.0

MIN_RECOMMENDED_TOKEN_LENGTH = 32
PREFLIGHT_MAX_AGE_SECONDS = 600
ALLOWED_REQUEST_HEADERS = "Authorization, Content-Type"
PROTECTED_PREFIX = "/api/brain/"
# Headers set by reverse proxies. Without an API token, requests carrying any of them are refused.
PROXY_HEADERS = ("Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-IP")
UNAUTHORIZED_HEADERS = {"WWW-Authenticate": 'Bearer realm="starpi-brain"'}

# path -> {method -> handler method name}
ROUTES: dict[str, dict[str, str]] = {
    "/api/health": {"GET": "_handle_health"},
    "/api/brain/documents": {"GET": "_handle_documents"},
    "/api/brain/ingest": {"POST": "_handle_ingest"},
    "/api/brain/query": {"POST": "_handle_query"},
}

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
}


class ApiError(Exception):
    """An expected client error that becomes a JSON error response."""

    def __init__(self, status: HTTPStatus, error: str, headers: dict[str, str] | None = None, **details: Any) -> None:
        super().__init__(error)
        self.status = status
        self.payload: dict[str, Any] = {"error": error, **details}
        self.headers = headers or {}


def is_loopback_host(host: str) -> bool:
    """True for ``localhost`` and loopback IP literals (IPv4 or IPv6, brackets allowed)."""
    candidate = host.strip().strip("[]")
    if candidate.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(candidate).is_loopback
    except ValueError:
        return False


def parse_content_length(value: str) -> int | None:
    """Value of a Content-Length header, or None unless it is a plain decimal number.

    Leading zeros are allowed. Numbers with more than ``MAX_CONTENT_LENGTH_DIGITS`` significant
    digits are not converted; they are clamped to ``10 ** MAX_CONTENT_LENGTH_DIGITS``, which is
    above every body limit.
    """
    value = value.strip()
    if not (value.isascii() and value.isdigit()):
        return None
    significant = value.lstrip("0")
    if len(significant) > MAX_CONTENT_LENGTH_DIGITS:
        return 10**MAX_CONTENT_LENGTH_DIGITS
    return int(significant or "0")


def _hostname_from_host_header(value: str) -> str:
    value = value.strip()
    if value.startswith("["):
        return value[1 : value.find("]")] if "]" in value else value
    return value.rsplit(":", 1)[0] if value.count(":") == 1 else value


def _string_field(
    data: dict[str, Any],
    name: str,
    *,
    max_chars: int,
    required: bool = False,
    default: str = "",
) -> str:
    value = data.get(name)
    if value is None:
        if required:
            raise ApiError(HTTPStatus.BAD_REQUEST, "invalid_field", field=name, detail="required")
        return default
    if not isinstance(value, str):
        raise ApiError(HTTPStatus.BAD_REQUEST, "invalid_field", field=name, detail="must be a string")
    if len(value) > max_chars:
        raise ApiError(
            HTTPStatus.BAD_REQUEST, "invalid_field", field=name, detail=f"must be at most {max_chars} characters"
        )
    if not value.strip():
        if required:
            raise ApiError(HTTPStatus.BAD_REQUEST, "invalid_field", field=name, detail="must not be empty")
        return default
    return value


class BrainAPIHandler(BaseHTTPRequestHandler):
    server_version = "StarpiBrain"
    sys_version = ""
    timeout = REQUEST_TIMEOUT_SECONDS

    _response_started = False
    _body_consumed = False

    # ------------------------------------------------------------------ plumbing

    @property
    def settings(self) -> BrainConfig:
        return getattr(self.server, "settings", config)

    def _request_path(self) -> str:
        return getattr(self, "path", "").split("?", 1)[0].split("#", 1)[0]

    def _header(self, name: str) -> str | None:
        headers = getattr(self, "headers", None)
        return headers.get(name) if headers is not None else None

    def _allowed_origin(self) -> str | None:
        origin = self._header("Origin")
        if origin and origin in self.settings.allowed_origins:
            return origin
        return None

    def _send(self, status: int, payload: Any | None = None, headers: dict[str, str] | None = None) -> None:
        # Serialise first so a failure here can still become a 500 response.
        body = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        if payload is not None:
            self.send_header("Content-Type", "application/json; charset=utf-8")
        if status != HTTPStatus.NO_CONTENT:
            self.send_header("Content-Length", str(len(body)))
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        self.send_header("Vary", "Origin")
        allowed_origin = self._allowed_origin()
        if allowed_origin:
            self.send_header("Access-Control-Allow-Origin", allowed_origin)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self._response_started = True
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        """JSON variant of the stdlib error page (malformed requests, unsupported methods)."""
        self.close_connection = True
        self._discard_unread_body()
        try:
            phrase = HTTPStatus(code).phrase
        except ValueError:
            phrase = "error"
        self._send(code, {"error": phrase.lower().replace(" ", "_").replace("-", "_")})

    def log_request(self, code: int | str = "-", size: int | str = "-") -> None:
        # Method, path without query string and status only; headers are never logged.
        status = code.value if isinstance(code, HTTPStatus) else code
        logger.info("%s %s %r -> %s", self.address_string(), self.command or "-", self._request_path(), status)

    def log_message(self, format: str, *args: Any) -> None:
        logger.info("%s %s", self.address_string(), format % args)

    def _discard_unread_body(self) -> None:
        if self._body_consumed:
            return
        self._body_consumed = True
        remaining = parse_content_length(self._header("Content-Length") or "")
        if not remaining or remaining > MAX_DRAIN_BYTES:
            return
        try:
            self.connection.settimeout(DRAIN_TIMEOUT_SECONDS)
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 16_384))
                if not chunk:
                    break
                remaining -= len(chunk)
        except OSError as exc:
            logger.debug("Could not drain request body: %s", type(exc).__name__)

    # ------------------------------------------------------------------ dispatch

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_OPTIONS(self) -> None:
        self._dispatch("OPTIONS")

    def _dispatch(self, method: str) -> None:
        self._response_started = False
        self._body_consumed = False
        try:
            self._route(method)
        except ApiError as exc:
            self._discard_unread_body()
            self._send(exc.status, exc.payload, exc.headers)
        except (BrokenPipeError, ConnectionResetError):
            logger.info("Client disconnected during %s %r", method, self._request_path())
            self.close_connection = True
        except Exception:
            logger.exception("Unhandled error during %s %r", method, self._request_path())
            self.close_connection = True
            if not self._response_started:
                try:
                    self._send(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "internal_error"})
                except OSError:
                    logger.info("Client disconnected before the error response was sent")

    def _route(self, method: str) -> None:
        self._check_proxy_headers()
        if self._header("Origin") is not None and self._allowed_origin() is None:
            raise ApiError(HTTPStatus.FORBIDDEN, "origin_not_allowed")
        self._check_host()

        path = self._request_path()
        methods = ROUTES.get(path)
        if methods is None:
            raise ApiError(HTTPStatus.NOT_FOUND, "not_found")
        allow = ", ".join([*methods, "OPTIONS"])
        if method == "OPTIONS":
            self._handle_preflight(allow)
            return
        if method not in methods:
            raise ApiError(HTTPStatus.METHOD_NOT_ALLOWED, "method_not_allowed", headers={"Allow": allow})
        if path.startswith(PROTECTED_PREFIX):
            self._check_auth()
        getattr(self, methods[method])()

    def _check_proxy_headers(self) -> None:
        # Fail closed: a reverse proxy on this host forwards remote clients from 127.0.0.1 with a
        # loopback Host header, so without a token those requests would pass every local check.
        if self.settings.api_token:
            return
        if any(self._header(name) is not None for name in PROXY_HEADERS):
            raise ApiError(
                HTTPStatus.UNAUTHORIZED, "api_token_required_behind_proxy", headers=dict(UNAUTHORIZED_HEADERS)
            )

    def _check_host(self) -> None:
        # Without a token the API is only meant for local use. Rejecting foreign Host headers
        # blocks DNS rebinding from web pages the local user visits.
        if self.settings.api_token:
            return
        host_header = self._header("Host")
        if host_header and not is_loopback_host(_hostname_from_host_header(host_header)):
            raise ApiError(HTTPStatus.FORBIDDEN, "host_not_allowed")

    def _check_auth(self) -> None:
        token = self.settings.api_token
        if not token:
            return
        scheme, _, supplied = (self._header("Authorization") or "").partition(" ")
        valid = scheme.lower() == "bearer" and hmac.compare_digest(
            supplied.strip().encode("utf-8"), token.encode("utf-8")
        )
        if not valid:
            raise ApiError(HTTPStatus.UNAUTHORIZED, "unauthorized", headers=dict(UNAUTHORIZED_HEADERS))

    def _read_json_object(self) -> dict[str, Any]:
        if self._header("Transfer-Encoding") is not None:
            raise ApiError(HTTPStatus.LENGTH_REQUIRED, "length_required")
        lengths = self.headers.get_all("Content-Length") or []
        if not lengths:
            raise ApiError(HTTPStatus.LENGTH_REQUIRED, "length_required")
        length = parse_content_length(lengths[0])
        if len(lengths) > 1 or length is None:
            raise ApiError(HTTPStatus.BAD_REQUEST, "invalid_content_length")
        if length > self.settings.max_body_bytes:
            raise ApiError(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "payload_too_large", max_bytes=self.settings.max_body_bytes
            )
        media_type = (self._header("Content-Type") or "").split(";", 1)[0].strip().lower()
        if media_type != "application/json":
            raise ApiError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type")

        try:
            body = self.rfile.read(length) if length else b""
        except TimeoutError:
            # The socket timeout fired while the client was still sending the body. The reader
            # may hold a partial body, so this connection cannot be reused.
            self._body_consumed = True
            self.close_connection = True
            raise ApiError(HTTPStatus.REQUEST_TIMEOUT, "request_timeout", headers={"Connection": "close"}) from None
        self._body_consumed = True
        if len(body) < length:
            raise ApiError(HTTPStatus.BAD_REQUEST, "incomplete_body")
        try:
            data = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError):
            raise ApiError(HTTPStatus.BAD_REQUEST, "invalid_json") from None
        if not isinstance(data, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, "json_body_must_be_object")
        return data

    # ------------------------------------------------------------------ handlers

    def _handle_preflight(self, allow: str) -> None:
        if self._allowed_origin() is None:
            # Not a CORS preflight (no Origin header): answer like a plain OPTIONS request.
            self._send(HTTPStatus.NO_CONTENT, headers={"Allow": allow})
            return
        self._send(
            HTTPStatus.NO_CONTENT,
            headers={
                "Access-Control-Allow-Methods": allow,
                "Access-Control-Allow-Headers": ALLOWED_REQUEST_HEADERS,
                "Access-Control-Max-Age": str(PREFLIGHT_MAX_AGE_SECONDS),
            },
        )

    def _handle_health(self) -> None:
        self._send(HTTPStatus.OK, {"status": "healthy", "supabase_live": bool(db.is_live)})

    def _handle_documents(self) -> None:
        docs = db.list_documents()
        self._send(HTTPStatus.OK, {"documents": docs, "count": len(docs)})

    def _handle_ingest(self) -> None:
        data = self._read_json_object()
        text = _string_field(data, "text", max_chars=MAX_TEXT_CHARS, required=True)
        source_name = _string_field(data, "source_name", max_chars=MAX_SOURCE_NAME_CHARS, default="Web-Upload")
        source_type = _string_field(data, "source_type", max_chars=MAX_SOURCE_TYPE_CHARS, default="text")
        result = ingest_raw_information(raw_text=text, source_name=source_name, source_type=source_type)
        self._send(HTTPStatus.OK, result)

    def _handle_query(self) -> None:
        data = self._read_json_object()
        user_query = _string_field(data, "query", max_chars=MAX_QUERY_CHARS, required=True)
        self._send(HTTPStatus.OK, query_brain(user_query=user_query))


class BrainHTTPServer(ThreadingHTTPServer):
    """Threaded server that carries its settings for the request handlers."""

    daemon_threads = True

    def __init__(self, server_address: tuple[str, int], settings: BrainConfig) -> None:
        self.settings = settings
        if ":" in server_address[0]:
            self.address_family = socket.AF_INET6
        super().__init__(server_address, BrainAPIHandler)

    def server_bind(self) -> None:
        # HTTPServer.server_bind does a reverse DNS lookup of the bind address; skip it.
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = int(port)


def create_server(host: str, port: int, settings: BrainConfig | None = None) -> BrainHTTPServer:
    return BrainHTTPServer((host, port), settings or config)


def run_server(port: int | None = None, host: str | None = None, settings: BrainConfig | None = None) -> None:
    """Starts the API and blocks until interrupted.

    Raises SystemExit(2) when asked to bind to a non-loopback address without BRAIN_API_TOKEN.
    """
    settings = settings or config
    host = settings.server_host if host is None else host
    port = settings.server_port if port is None else port

    if not is_loopback_host(host) and not settings.api_token:
        logger.error(
            "Refusing to listen on %s without BRAIN_API_TOKEN. Set a token or bind to 127.0.0.1 "
            "and put a TLS reverse proxy in front.",
            host,
        )
        raise SystemExit(2)
    if settings.api_token and len(settings.api_token) < MIN_RECOMMENDED_TOKEN_LENGTH:
        logger.warning("BRAIN_API_TOKEN is shorter than %d characters", MIN_RECOMMENDED_TOKEN_LENGTH)

    httpd = create_server(host, port, settings)
    if threading.current_thread() is threading.main_thread():
        # systemd stops services with SIGTERM; shut down cleanly instead of dying mid-request.
        def _on_sigterm(signum: int, frame: object) -> None:
            logger.info("Received SIGTERM, shutting down")
            threading.Thread(target=httpd.shutdown, daemon=True).start()

        signal.signal(signal.SIGTERM, _on_sigterm)

    bound_host, bound_port = httpd.server_address[:2]
    logger.info(
        "Brain API listening on %s:%s (supabase_live=%s, token_auth=%s)",
        bound_host,
        bound_port,
        db.is_live,
        bool(settings.api_token),
    )
    if not db.is_live:
        logger.warning("Supabase is not configured; documents are kept in memory only")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down")
    finally:
        httpd.server_close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Starpi brain HTTP API")
    parser.add_argument("port", nargs="?", type=int, help="port (default: BRAIN_SERVER_PORT or 9200)")
    parser.add_argument("--host", help="bind address (default: BRAIN_SERVER_HOST or 127.0.0.1)")
    parser.add_argument(
        "--log-level",
        type=str.upper,
        choices=LOG_LEVELS,
        # BRAIN_LOG_LEVEL, validated by the config (unknown values fall back to INFO).
        default=config.log_level,
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=args.log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    run_server(port=args.port, host=args.host)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
