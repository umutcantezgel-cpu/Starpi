"""Turns raw notes into structured Markdown plus metadata using the configured chat model."""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from .config import config
from .http_utils import bearer_headers, describe_error, http_timeout

logger = logging.getLogger(__name__)

STRUCTURER_TIMEOUT_SECONDS = 120.0
STRUCTURER_CONNECT_TIMEOUT_SECONDS = 3.0
MAX_TAGS = 20

STRUCTURING_PROMPT = """Du bist ein hochpräziser KI-Wissens-Architekt ("Enterprise Brain Ingestion Engine").
Deine Aufgabe ist es, unstrukturierte Rohdaten (Notizen, Berichte, Chat-Dumps, Meeting-Transkripte, Dokumente) \
aufzunehmen, Füllwörter zu entfernen, logisch zu ordnen und in ein professionelles, sauberes Markdown-Dokument \
umzuwandeln.

Erstelle aus dem folgenden Rohtext eine perfekte Markdown-Struktur und antworte AUSSCHLIESSLICH im folgenden \
JSON-Format:

```json
{
  "title": "Prägnanter Dokumententitel",
  "summary": "2-3 Sätze Zusammenfassung der Kernfakten",
  "tags": ["Kategorie1", "Schlagwort2", "Thema3"],
  "markdown": "# Titel\\n\\n## 1. Überblick & Kernaussagen\\n- Punkt A\\n\\n## 2. Details & Spezifikationen\\n\
| Eigenschaft | Wert |\\n|---|---|\\n\\n## 3. Handlungsempfehlungen / To-Dos\\n..."
}
```

Richtlinien für das Markdown:
1. Nutze klare Hierarchien (`#`, `##`, `###`).
2. Hebe Schlüsselbegriffe **fett** hervor.
3. Verwende Tabellen und Listen für Zahlen, Parameter und Vergleiche.
4. Behalte alle Fakten, Daten, Namen und technischen Spezifikationen verlustfrei bei.
"""


def _extract_json_object(content: str) -> dict[str, Any]:
    """Parses the JSON object in a model reply, tolerating Markdown code fences around it."""
    json_str = content
    if "```json" in content:
        start_fence = content.find("```json") + len("```json")
        end_fence = content.rfind("```")
        if end_fence > start_fence:
            json_str = content[start_fence:end_fence].strip()
    first_brace = json_str.find("{")
    last_brace = json_str.rfind("}")
    if first_brace != -1 and last_brace > first_brace:
        json_str = json_str[first_brace : last_brace + 1]
    parsed = json.loads(json_str)
    if not isinstance(parsed, dict):
        raise ValueError("model reply is not a JSON object")
    return parsed


def _as_text(value: Any, default: str) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else default


def _as_tags(value: Any) -> list[str]:
    if isinstance(value, str):
        value = value.split(",")
    if not isinstance(value, list):
        return []
    tags = [str(tag).strip() for tag in value if isinstance(tag, (str, int, float)) and str(tag).strip()]
    return tags[:MAX_TAGS]


def fallback_structure(raw_text: str, source_name: str = "") -> dict[str, Any]:
    """Minimal structure used when the model is unavailable or answers with invalid JSON."""
    stripped = raw_text.strip()
    first_line = stripped.split("\n")[0][:60] if stripped else ""
    return {
        "title": source_name or first_line or "Dokument",
        "summary": raw_text[:200] + "...",
        "tags": ["auto-ingest", "raw"],
        "markdown": f"# {source_name or 'Dokument'}\n\n{raw_text}",
    }


def structure_raw_content(raw_text: str, source_name: str = "") -> dict[str, Any]:
    """Returns ``{"title", "summary", "tags", "markdown"}`` for ``raw_text``.

    Falls back to :func:`fallback_structure` when the model call fails.
    """
    if not raw_text or not raw_text.strip():
        return {
            "title": source_name or "Leeres Dokument",
            "summary": "Kein Inhalt vorhanden.",
            "tags": ["empty"],
            "markdown": "# Leeres Dokument\n\nKeine Daten übergeben.",
        }

    user_message = f"Quelldatei / Kontext: {source_name}\n\nRohtext:\n{raw_text.strip()}"
    payload = {
        "model": config.llm_model,
        "messages": [
            {"role": "system", "content": STRUCTURING_PROMPT},
            {"role": "user", "content": user_message},
        ],
        "temperature": 0.2,
        "max_tokens": 3000,
    }
    url = f"{config.llm_base_url.rstrip('/')}/chat/completions"

    try:
        timeout = http_timeout(STRUCTURER_TIMEOUT_SECONDS, STRUCTURER_CONNECT_TIMEOUT_SECONDS)
        with httpx.Client(timeout=timeout) as client:
            response = client.post(url, json=payload, headers=bearer_headers(config.llm_api_key))
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"].strip()
        structured = _extract_json_object(content)
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError, AttributeError) as exc:
        logger.warning("Structuring via LLM failed (%s); using plain Markdown fallback", describe_error(exc))
        return fallback_structure(raw_text, source_name)

    return {
        "title": _as_text(structured.get("title"), source_name or "Unbenanntes Dokument"),
        "summary": _as_text(structured.get("summary"), ""),
        "tags": _as_tags(structured.get("tags")),
        "markdown": _as_text(structured.get("markdown"), raw_text),
    }
