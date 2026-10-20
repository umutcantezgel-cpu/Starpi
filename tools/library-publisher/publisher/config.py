"""Runtime configuration of the library publisher, read from environment variables.

``tools/library-publisher/.env`` is loaded once by :func:`load_default_env_file` (the command line
does this at start-up). Variables already present in the process environment always win over
values from the file.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

PUBLISHER_DIR = Path(__file__).resolve().parent.parent
DEFAULT_ENV_FILE = PUBLISHER_DIR / ".env"
# Model files fetched by ``fetch-model`` land here unless PUBLISHER_MODEL_DIR says otherwise.
DEFAULT_MODEL_DIR = PUBLISHER_DIR / "models" / "multilingual-e5-small"

LOG_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR")
DEFAULT_LOG_LEVEL = "WARNING"


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
    if value[:1] in ("'", '"'):
        # Quoted value: everything up to the matching quote, so a trailing comment is dropped.
        end = value.find(value[0], 1)
        if end > 0:
            value = value[1:end]
    else:
        # Inline comment after an unquoted value.
        value = re.split(r"\s#", value, maxsplit=1)[0].rstrip()
    return key, value


def load_env_file(path: Path) -> bool:
    """Loads ``path`` into ``os.environ`` without overriding existing variables.

    Within the file the last assignment of a key wins. Returns True when the file was read.
    Unreadable files are logged and skipped.
    """
    try:
        # utf-8-sig drops a leading byte order mark if an editor added one.
        text = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return False
    except (OSError, UnicodeDecodeError) as exc:
        logger.warning("Could not read env file %s (%s)", path.name, type(exc).__name__)
        return False
    values: dict[str, str] = {}
    for raw_line in text.splitlines():
        parsed = parse_env_line(raw_line)
        if parsed is not None:
            values[parsed[0]] = parsed[1]
    for key, value in values.items():
        os.environ.setdefault(key, value)
    return True


def load_default_env_file() -> bool:
    """Loads ``tools/library-publisher/.env`` when it exists."""
    return DEFAULT_ENV_FILE.is_file() and load_env_file(DEFAULT_ENV_FILE)


def _env_str(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _env_path(name: str, default: Path) -> Path:
    raw = _env_str(name)
    return Path(raw).expanduser() if raw else default


@dataclass
class PublisherConfig:
    """Publisher settings. Every field is read from the environment when an instance is created.

    Secret fields are excluded from ``repr`` so that logging a config never prints credentials.
    """

    # Supabase. The publisher writes with the service role key, which bypasses RLS. It never falls
    # back to the anon key, and this key must never be shipped to a browser.
    supabase_url: str = field(default_factory=lambda: _env_str("SUPABASE_URL"))
    supabase_key: str = field(default_factory=lambda: _env_str("SUPABASE_SERVICE_ROLE_KEY"), repr=False)

    # Optional Chat Completions-compatible endpoint (``/v1/chat/completions``), used only by
    # ``publish --structure``.
    llm_base_url: str = field(default_factory=lambda: _env_str("LLM_BASE_URL", "http://127.0.0.1:8000/v1"))
    llm_api_key: str = field(default_factory=lambda: _env_str("LLM_API_KEY", "EMPTY"), repr=False)
    llm_model: str = field(default_factory=lambda: _env_str("LLM_MODEL", "Qwen/Qwen2.5-7B-Instruct"))

    # Directory with tokenizer.json and onnx/model_quantized.onnx of the embedding model.
    model_dir: Path = field(default_factory=lambda: _env_path("PUBLISHER_MODEL_DIR", DEFAULT_MODEL_DIR))

    @property
    def supabase_configured(self) -> bool:
        return bool(self.supabase_url and self.supabase_key)
