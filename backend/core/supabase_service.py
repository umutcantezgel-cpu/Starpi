"""Supabase access for the command line tools (health check, atomic ingest RPC, listing, search).

Uses the service role key, like :mod:`core.supabase_client`, and falls back to in-memory storage
when Supabase is not configured or unreachable.
"""

from __future__ import annotations

import logging
import threading
import uuid
from typing import Any

import httpx

from .config import config
from .http_utils import describe_error, http_timeout
from .supabase_client import DOCUMENT_LIST_COLUMNS, local_vector, rank_local_sections, section_payload

logger = logging.getLogger(__name__)

HEALTH_TIMEOUT_SECONDS = 10.0
INGEST_TIMEOUT_SECONDS = 30.0
SEARCH_TIMEOUT_SECONDS = 20.0
LIST_TIMEOUT_SECONDS = 15.0
CONNECT_TIMEOUT_SECONDS = 5.0
MAX_ERROR_BODY_CHARS = 500


class SupabaseService:
    """PostgREST / RPC client with an in-memory fallback for offline development."""

    def __init__(self, url: str | None = None, key: str | None = None) -> None:
        self.url = (config.supabase_url if url is None else url).strip().rstrip("/")
        self.key = (config.supabase_key if key is None else key).strip()
        self.is_configured = bool(self.url and self.key)

        self._lock = threading.Lock()
        self._local_docs: dict[str, dict[str, Any]] = {}
        self._local_sections: list[dict[str, Any]] = []
        self._local_chats: list[dict[str, Any]] = []

    def _headers(self, prefer: str = "return=representation") -> dict[str, str]:
        return {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Prefer": prefer,
        }

    def health_check(self) -> dict[str, Any]:
        """Checks that the REST API answers and the ``brain_settings`` table is readable."""
        if not self.is_configured:
            return {
                "status": "offline_mode",
                "connected": False,
                "message": "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set. Using in-memory storage.",
            }

        try:
            with httpx.Client(timeout=http_timeout(HEALTH_TIMEOUT_SECONDS, CONNECT_TIMEOUT_SECONDS)) as client:
                resp = client.get(
                    f"{self.url}/rest/v1/brain_settings",
                    params={"select": "key", "limit": "1"},
                    headers=self._headers(),
                )
        except httpx.HTTPError as exc:
            return {"status": "unreachable", "connected": False, "error": describe_error(exc)}

        if resp.status_code in (200, 206):
            return {
                "status": "connected",
                "connected": True,
                "url": self.url,
                "message": "Supabase connection active and schema verified.",
            }
        return {
            "status": "error",
            "connected": False,
            "status_code": resp.status_code,
            "error": resp.text[:MAX_ERROR_BODY_CHARS],
        }

    def ingest_document(
        self,
        title: str,
        summary: str,
        tags: list[str],
        markdown_content: str,
        sections: list[dict[str, Any]],
        source_type: str = "text",
        source_name: str = "",
        raw_content: str = "",
    ) -> dict[str, Any]:
        """Ingests a document and its sections through the ``ingest_document_atomic`` RPC.

        Only real embeddings (see :func:`core.supabase_client.section_payload`) are sent.
        Falls back to in-memory storage when the RPC is unavailable.
        """
        if self.is_configured:
            rpc_payload = {
                "doc_title": title,
                "doc_summary": summary,
                "doc_tags": tags,
                "doc_source_type": source_type,
                "doc_source_name": source_name,
                "doc_raw_content": raw_content,
                "sections_data": [section_payload(sec) for sec in sections],
            }
            try:
                with httpx.Client(timeout=http_timeout(INGEST_TIMEOUT_SECONDS, CONNECT_TIMEOUT_SECONDS)) as client:
                    resp = client.post(
                        f"{self.url}/rest/v1/rpc/ingest_document_atomic",
                        headers=self._headers(),
                        json=rpc_payload,
                    )
                    resp.raise_for_status()
                    returned_id = resp.json()
                if isinstance(returned_id, str):
                    return {
                        "id": returned_id,
                        "title": title,
                        "sections_count": len(sections),
                        "storage": "supabase_cloud",
                    }
                logger.warning("ingest_document_atomic returned %s instead of an id", type(returned_id).__name__)
            except (httpx.HTTPError, ValueError) as exc:
                logger.warning("ingest_document_atomic failed (%s); storing in memory", describe_error(exc))

        doc_id = str(uuid.uuid4())
        doc_record = {
            "id": doc_id,
            "title": title,
            "summary": summary,
            "tags": tags,
            "source_type": source_type,
            "source_name": source_name,
            "raw_content": raw_content,
            "markdown_content": markdown_content,
            "sections_count": len(sections),
        }
        local_sections = [
            {
                "id": str(uuid.uuid4()),
                "document_id": doc_id,
                "document_title": title,
                "heading": s.get("heading", ""),
                "markdown_content": s.get("markdown_content", ""),
                "tags": tags,
                "embedding": local_vector(s),
            }
            for s in sections
        ]
        with self._lock:
            self._local_docs[doc_id] = doc_record
            self._local_sections.extend(local_sections)

        return {
            "id": doc_id,
            "title": title,
            "sections_count": len(sections),
            "storage": "local_fallback",
        }

    def match_sections(
        self,
        query_embedding: list[float],
        threshold: float = 0.2,
        limit: int = 5,
    ) -> list[dict[str, Any]]:
        """Vector similarity search via the ``match_knowledge_sections`` RPC, or in memory."""
        if self.is_configured:
            try:
                with httpx.Client(timeout=http_timeout(SEARCH_TIMEOUT_SECONDS, CONNECT_TIMEOUT_SECONDS)) as client:
                    resp = client.post(
                        f"{self.url}/rest/v1/rpc/match_knowledge_sections",
                        headers=self._headers(),
                        json={
                            "query_embedding": query_embedding,
                            "match_threshold": threshold,
                            "match_count": limit,
                        },
                    )
                    resp.raise_for_status()
                    data = resp.json()
                if isinstance(data, list):
                    return data
                logger.warning("Unexpected match RPC response type %s", type(data).__name__)
            except (httpx.HTTPError, ValueError) as exc:
                logger.warning("match_knowledge_sections RPC failed (%s); searching in memory", describe_error(exc))

        with self._lock:
            sections = list(self._local_sections)
        return rank_local_sections(sections, query_embedding, threshold, limit)

    def list_documents(self) -> list[dict[str, Any]]:
        """Lists documents, newest first (without raw content)."""
        if self.is_configured:
            try:
                with httpx.Client(timeout=http_timeout(LIST_TIMEOUT_SECONDS, CONNECT_TIMEOUT_SECONDS)) as client:
                    resp = client.get(
                        f"{self.url}/rest/v1/knowledge_documents",
                        params={"select": ",".join(DOCUMENT_LIST_COLUMNS), "order": "created_at.desc"},
                        headers=self._headers(),
                    )
                    resp.raise_for_status()
                    data = resp.json()
                if isinstance(data, list):
                    return data
                logger.warning("Unexpected document list response type %s", type(data).__name__)
            except (httpx.HTTPError, ValueError) as exc:
                logger.warning("Listing documents from Supabase failed (%s)", describe_error(exc))

        with self._lock:
            docs = list(self._local_docs.values())
        docs.reverse()
        return [{k: v for k, v in doc.items() if k != "raw_content"} for doc in docs]


# Shared instance used by the command line tools.
supabase_service = SupabaseService()
