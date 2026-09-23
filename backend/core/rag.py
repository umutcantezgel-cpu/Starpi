"""Retrieval augmented answering over the knowledge base.

Order of answer providers: Gemini key pool, OpenRouter key pool, then the configured
Chat Completions-compatible endpoint (``/v1/chat/completions``). If none answers, the retrieved
context is returned as-is.
"""

from __future__ import annotations

import itertools
import logging
from typing import Any

import httpx

from .config import config
from .embeddings import get_embedding_with_source
from .http_utils import bearer_headers, describe_error, http_timeout
from .supabase_client import db

logger = logging.getLogger(__name__)

LLM_TIMEOUT_SECONDS = 60.0
CLOUD_POOL_TIMEOUT_SECONDS = 25.0
CONNECT_TIMEOUT_SECONDS = 3.0

MATCH_THRESHOLD = 0.15
MATCH_COUNT = 5

GEMINI_MODEL = "gemini-2.5-flash"
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_MODELS = (
    "liquid/lfm-2.5-2.6b:free",
    "nvidia/nemotron-3.5-lightning:free",
    "google/gemini-2.0-flash-exp:free",
    "openrouter/auto",
)

RAG_SYSTEM_PROMPT = """Du bist das private Unternehmens-Brain ("Enterprise Knowledge Assistant").
Du hast Zugriff auf vertrauliche, interne Unternehmensdokumente und strukturiertes Wissen.

Aufgabe:
Beantworte die Benutzeranfrage präzise, fundiert und ausschließlich auf Basis des bereitgestellten Wissenskontexts.
Falls eine Information nicht im Kontext steht, weise freundlich darauf hin.
Formatiere deine Antwort in sauberem Markdown mit klaren Absätzen, Aufzählungszeichen und nenne die verwendeten Quellen.

---
WISSENSKONTEXT AUS DEM ENTERPRISE BRAIN:
{context}
---
"""

# Round-robin start positions; itertools.count is safe to advance from several threads.
_gemini_counter = itertools.count()
_openrouter_counter = itertools.count()


def retrieve_sections(user_query: str) -> list[dict[str, Any]]:
    """Embeds the query and returns matching sections.

    Remote vector search is skipped when only a hash fallback vector is available, because it
    cannot be compared with the stored embeddings.
    """
    query_vector, is_real = get_embedding_with_source(user_query)
    if query_vector is None:
        return []
    if db.is_live and not is_real:
        logger.warning("Embedding endpoint unavailable; answering without retrieved context")
        return []
    return db.search_similar_sections(query_vector, threshold=MATCH_THRESHOLD, limit=MATCH_COUNT)


def _format_context(sections: list[dict[str, Any]]) -> str:
    if not sections:
        return "Keine spezifischen Dokumente in der Datenbank gefunden."
    parts = []
    for i, match in enumerate(sections, 1):
        doc_title = match.get("document_title", "Dokument")
        heading = match.get("heading", "")
        content = match.get("markdown_content", "")
        parts.append(f"[{i}] Dokument: {doc_title} | Abschnitt: {heading}\n{content}\n")
    return "\n".join(parts)


def query_brain(user_query: str) -> dict[str, Any]:
    """Answers ``user_query`` from the knowledge base; returns ``answer``, ``sources`` and ``provider``."""
    if not user_query or not user_query.strip():
        return {"answer": "Bitte stellen Sie eine Frage.", "sources": []}

    matching_sections = retrieve_sections(user_query)
    context_text = _format_context(matching_sections)
    system_prompt = RAG_SYSTEM_PROMPT.format(context=context_text)

    gemini_answer = _call_gemini_pool(f"{system_prompt}\n\nBenutzerfrage: {user_query}")
    if gemini_answer:
        return {"answer": gemini_answer, "sources": matching_sections, "provider": "gemini_pool"}

    openrouter_answer = _call_openrouter_pool(system_prompt, user_query)
    if openrouter_answer:
        return {"answer": openrouter_answer, "sources": matching_sections, "provider": "openrouter_pool"}

    local_answer = _call_local_llm(system_prompt, user_query)
    if local_answer:
        return {"answer": local_answer, "sources": matching_sections, "provider": "local_llm"}

    return {
        "answer": (
            f"**Hinweis aus dem lokalen Brain-Speicher:**\n\nBasierend auf den gefundenen Dokumenten:\n\n{context_text}"
        ),
        "sources": matching_sections,
        "provider": "none",
        "error": "llm_unavailable",
    }


def _call_local_llm(system_prompt: str, user_query: str) -> str:
    payload = {
        "model": config.llm_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_query},
        ],
        "temperature": 0.3,
        "max_tokens": 2048,
    }
    try:
        with httpx.Client(timeout=http_timeout(LLM_TIMEOUT_SECONDS, CONNECT_TIMEOUT_SECONDS)) as client:
            resp = client.post(
                f"{config.llm_base_url.rstrip('/')}/chat/completions",
                json=payload,
                headers=bearer_headers(config.llm_api_key),
            )
            resp.raise_for_status()
            return str(resp.json()["choices"][0]["message"]["content"]).strip()
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError) as exc:
        logger.warning("Local LLM endpoint failed: %s", describe_error(exc))
        return ""


def _call_gemini_pool(prompt: str) -> str:
    keys = config.gemini_keys
    if not keys:
        return ""
    start = next(_gemini_counter)
    for offset in range(len(keys)):
        key = keys[(start + offset) % len(keys)]
        try:
            with httpx.Client(timeout=http_timeout(CLOUD_POOL_TIMEOUT_SECONDS, CONNECT_TIMEOUT_SECONDS)) as client:
                # The key goes in a header, not the query string, so it never appears in URLs or logs.
                res = client.post(
                    GEMINI_URL,
                    json={"contents": [{"role": "user", "parts": [{"text": prompt}]}]},
                    headers={"Content-Type": "application/json", "x-goog-api-key": key},
                )
                res.raise_for_status()
                data = res.json()
            parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
            if parts and "text" in parts[0]:
                return str(parts[0]["text"]).strip()
            logger.warning("Gemini key #%d returned no text", (start + offset) % len(keys))
        except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError, AttributeError) as exc:
            logger.warning("Gemini key #%d failed: %s", (start + offset) % len(keys), describe_error(exc))
    return ""


def _call_openrouter_pool(system_prompt: str, user_query: str) -> str:
    keys = config.openrouter_keys
    if not keys:
        return ""
    start = next(_openrouter_counter)
    for offset in range(len(keys)):
        key_index = (start + offset) % len(keys)
        key = keys[key_index]
        for model in OPENROUTER_MODELS:
            try:
                with httpx.Client(timeout=http_timeout(CLOUD_POOL_TIMEOUT_SECONDS, CONNECT_TIMEOUT_SECONDS)) as client:
                    res = client.post(
                        OPENROUTER_URL,
                        headers={
                            "Authorization": f"Bearer {key}",
                            "Content-Type": "application/json",
                            "HTTP-Referer": "https://www.starpi.app/",
                            "X-Title": "Starpi Enterprise Brain",
                        },
                        json={
                            "model": model,
                            "messages": [
                                {"role": "system", "content": system_prompt},
                                {"role": "user", "content": user_query},
                            ],
                            "temperature": 0.5,
                            "max_tokens": 1024,
                        },
                    )
                    res.raise_for_status()
                    data = res.json()
                choices = data.get("choices", [])
                if choices and "message" in choices[0]:
                    content = str(choices[0]["message"].get("content") or "").strip()
                    if content:
                        return content
                logger.warning("OpenRouter key #%d model %s returned no text", key_index, model)
            except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError, AttributeError) as exc:
                logger.warning("OpenRouter key #%d model %s failed: %s", key_index, model, describe_error(exc))
    return ""
