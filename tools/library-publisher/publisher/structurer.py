"""Optional clean-up of raw notes into Markdown plus metadata by a Chat Completions model.

Only ``publish --structure`` uses it. Without it the publisher stores the source text as written,
which keeps every citation the app shows identical to the file that was published.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from .config import PublisherConfig
from .http_utils import bearer_headers, describe_error, http_timeout

logger = logging.getLogger(__name__)

STRUCTURER_TIMEOUT_SECONDS = 120.0
STRUCTURER_CONNECT_TIMEOUT_SECONDS = 3.0
MAX_TAGS = 20
UNTITLED = "Untitled document"

STRUCTURING_PROMPT = """You prepare documents for a shared knowledge library.
Rewrite the raw text you receive as a clean Markdown document:

- Keep every fact, number, date, name and unit exactly as written. Do not add facts, opinions or advice.
- Remove filler and repetition, and order the content logically.
- Use headings (#, ##, ###) for the structure, lists for enumerations and tables for values that belong together.
- Write in the language of the raw text.

Answer with one JSON object and nothing else:

{"title": "short document title",
 "summary": "two or three sentences with the main facts",
 "tags": ["topic", "keyword"],
 "markdown": "# Title\\n\\n## Section\\n..."}
"""


def _extract_json_object(content: str) -> dict[str, Any]:
    """Parses the JSON object in a model reply, tolerating Markdown code fences around it."""
    json_str = content
    if "```" in content:
        start_fence = content.find("```")
        start = content.find("\n", start_fence)
        end_fence = content.rfind("```")
        if start != -1 and end_fence > start:
            json_str = content[start + 1 : end_fence].strip()
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
    tags = [
        str(tag).strip()
        for tag in value
        if isinstance(tag, (str, int, float)) and not isinstance(tag, bool) and str(tag).strip()
    ]
    return tags[:MAX_TAGS]


def structure_raw_content(
    raw_text: str,
    source_name: str,
    config: PublisherConfig,
    *,
    transport: httpx.BaseTransport | None = None,
) -> dict[str, Any] | None:
    """Returns ``{"title", "summary", "tags", "markdown"}`` for ``raw_text``, or None.

    None means the model was unreachable or answered with something unusable; the caller then
    publishes the text as written. ``transport`` replaces the network in tests.
    """
    if not raw_text.strip():
        return None

    payload = {
        "model": config.llm_model,
        "messages": [
            {"role": "system", "content": STRUCTURING_PROMPT},
            {"role": "user", "content": f"Source: {source_name}\n\nRaw text:\n{raw_text.strip()}"},
        ],
        "temperature": 0.2,
        "max_tokens": 4000,
    }
    url = f"{config.llm_base_url.rstrip('/')}/chat/completions"
    try:
        timeout = http_timeout(STRUCTURER_TIMEOUT_SECONDS, STRUCTURER_CONNECT_TIMEOUT_SECONDS)
        with httpx.Client(timeout=timeout, transport=transport) as client:
            response = client.post(url, json=payload, headers=bearer_headers(config.llm_api_key))
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"].strip()
        structured = _extract_json_object(content)
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError, AttributeError) as exc:
        logger.warning(
            "Structuring via the chat model failed (%s); publishing the text as written", describe_error(exc)
        )
        return None

    markdown = _as_text(structured.get("markdown"), "")
    if not markdown:
        logger.warning("The chat model returned no Markdown; publishing the text as written")
        return None
    return {
        "title": _as_text(structured.get("title"), source_name or UNTITLED),
        "summary": _as_text(structured.get("summary"), ""),
        "tags": _as_tags(structured.get("tags")),
        "markdown": markdown,
    }
