"""Small helpers shared by the modules that call external HTTP APIs."""

from __future__ import annotations

import httpx

# Connecting should fail fast when a local endpoint is not running.
DEFAULT_CONNECT_TIMEOUT_SECONDS = 3.0

# Placeholder used in .env files for endpoints that need no key.
NO_API_KEY = "EMPTY"


def http_timeout(total_seconds: float, connect_seconds: float = DEFAULT_CONNECT_TIMEOUT_SECONDS) -> httpx.Timeout:
    """Returns a timeout with a short connect phase and ``total_seconds`` for read/write/pool."""
    return httpx.Timeout(total_seconds, connect=min(connect_seconds, total_seconds))


def bearer_headers(api_key: str) -> dict[str, str]:
    """Authorization header for OpenAI-compatible endpoints, or nothing when no key is set."""
    if not api_key or api_key == NO_API_KEY:
        return {}
    return {"Authorization": f"Bearer {api_key}"}


def describe_error(exc: BaseException) -> str:
    """Short, secret-free description of an exception for log lines.

    httpx exceptions can embed request URLs; only the class name and, for HTTP status errors,
    the status code are kept.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        return f"{type(exc).__name__} (status {exc.response.status_code})"
    return type(exc).__name__
