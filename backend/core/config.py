"""Runtime configuration for the brain backend, read from environment variables.

A ``.env`` file next to the backend (``backend/.env``) or, if that does not exist, at the
repository root is loaded once at import time. Variables already present in the process
environment always win over values from the file.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

_BACKEND_DIR = Path(__file__).resolve().parent.parent
_ENV_FILE_CANDIDATES = (_BACKEND_DIR / ".env", _BACKEND_DIR.parent / ".env")

DEFAULT_ALLOWED_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000,https://www.starpi.app,https://starpi.app"
DEFAULT_MAX_BODY_BYTES = 1_048_576


def parse_env_line(line: str) -> tuple[str, str] | None:
    """Parses one ``KEY=value`` line of a .env file; returns None for blanks and comments."""
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    if line.startswith("export "):
        line = line[len("export ") :].lstrip()
    if "=" not in line:
        return None
    key, value = line.split("=", 1)
    key = key.strip()
    value = value.strip()
    if not key:
        return None
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        value = value[1:-1]
    elif " #" in value:
        # Inline comment after an unquoted value.
        value = value.split(" #", 1)[0].rstrip()
    return key, value


def load_env_file(path: Path) -> bool:
    """Loads ``path`` into ``os.environ`` without overriding existing variables.

    Returns True when the file was read. Unreadable files are logged and skipped.
    """
    try:
        # utf-8-sig drops a leading byte order mark if an editor added one.
        text = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return False
    except (OSError, UnicodeDecodeError) as exc:
        logger.warning("Could not read env file %s (%s)", path, type(exc).__name__)
        return False
    for raw_line in text.splitlines():
        parsed = parse_env_line(raw_line)
        if parsed is not None:
            os.environ.setdefault(*parsed)
    return True


def _load_default_env_file() -> None:
    for candidate in _ENV_FILE_CANDIDATES:
        if candidate.is_file():
            load_env_file(candidate)
            return


def _env_str(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("Ignoring non-integer value for %s; using %d", name, default)
        return default


def _env_list(name: str, default: str = "") -> list[str]:
    return [item.strip() for item in os.environ.get(name, default).split(",") if item.strip()]


_load_default_env_file()


@dataclass
class BrainConfig:
    """Backend settings. Every field is read from the environment when an instance is created.

    Secret fields are excluded from ``repr`` so that logging a config never prints credentials.
    """

    # Supabase. The backend writes with the service role key (bypasses RLS). It never falls back to
    # the anon key and this key must never be shipped to a browser.
    supabase_url: str = field(default_factory=lambda: _env_str("SUPABASE_URL"))
    supabase_key: str = field(default_factory=lambda: _env_str("SUPABASE_SERVICE_ROLE_KEY"), repr=False)

    # OpenAI-compatible chat completion endpoint (vLLM, MLX, llama.cpp server, ...).
    llm_base_url: str = field(default_factory=lambda: _env_str("LLM_BASE_URL", "http://127.0.0.1:8000/v1"))
    llm_api_key: str = field(default_factory=lambda: _env_str("LLM_API_KEY", "EMPTY"), repr=False)
    llm_model: str = field(default_factory=lambda: _env_str("LLM_MODEL", "Qwen/Qwen2.5-7B-Instruct"))

    # Optional hosted model key pools, comma separated.
    gemini_keys: list[str] = field(default_factory=lambda: _env_list("GEMINI_API_KEYS"), repr=False)
    openrouter_keys: list[str] = field(default_factory=lambda: _env_list("OPENROUTER_API_KEYS"), repr=False)

    # OpenAI-compatible embeddings endpoint; vectors must have 1536 dimensions.
    embedding_base_url: str = field(default_factory=lambda: _env_str("EMBEDDING_BASE_URL", "http://127.0.0.1:8000/v1"))
    embedding_api_key: str = field(default_factory=lambda: _env_str("EMBEDDING_API_KEY", "EMPTY"), repr=False)
    embedding_model: str = field(default_factory=lambda: _env_str("EMBEDDING_MODEL", "text-embedding-3-small"))

    # HTTP API server.
    server_port: int = field(default_factory=lambda: _env_int("BRAIN_SERVER_PORT", 9200))
    server_host: str = field(default_factory=lambda: _env_str("BRAIN_SERVER_HOST", "127.0.0.1"))
    # Browser origins allowed via CORS. An Origin header never has a trailing slash.
    allowed_origins: list[str] = field(
        default_factory=lambda: [o.rstrip("/") for o in _env_list("BRAIN_ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS)]
    )
    api_token: str = field(default_factory=lambda: _env_str("BRAIN_API_TOKEN"), repr=False)
    max_body_bytes: int = field(default_factory=lambda: _env_int("BRAIN_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES))


config = BrainConfig()
