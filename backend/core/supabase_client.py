"""Supabase (PostgREST) storage for documents and sections, with an in-memory offline fallback.

The client authenticates with the service role key and therefore bypasses RLS. It must only run
server side. Section dicts passed in may carry two vectors:

- ``embedding``: a real vector from the embedding endpoint, or None. Only this one is persisted.
- ``fallback_embedding``: a hash vector used by the in-memory store when no real vector exists.
"""

from __future__ import annotations

import logging
import math
import threading
import uuid
from collections.abc import Iterable
from typing import Any

import httpx

from .config import config
from .embeddings import EMBEDDING_DIM
from .http_utils import describe_error, http_timeout

logger = logging.getLogger(__name__)

SUPABASE_TIMEOUT_SECONDS = 30.0
SUPABASE_CONNECT_TIMEOUT_SECONDS = 5.0

# Columns returned by list_documents; raw_content is left out to keep responses small.
DOCUMENT_LIST_COLUMNS = ("id", "title", "summary", "tags", "source_type", "source_name", "total_sections", "created_at")
DOCUMENT_LIST_LIMIT = 200


def supabase_timeout() -> httpx.Timeout:
    return http_timeout(SUPABASE_TIMEOUT_SECONDS, SUPABASE_CONNECT_TIMEOUT_SECONDS)


def is_real_vector(value: Any) -> bool:
    """True for a list with the dimension of the ``knowledge_sections.embedding`` column."""
    return isinstance(value, list) and len(value) == EMBEDDING_DIM


def section_payload(sec: dict[str, Any]) -> dict[str, Any]:
    """Section fields as stored in Supabase. Missing or malformed embeddings become None (SQL NULL)."""
    embedding = sec.get("embedding")
    return {
        "section_index": int(sec.get("section_index", 0) or 0),
        "heading": str(sec.get("heading", "") or ""),
        "markdown_content": str(sec.get("markdown_content", "") or ""),
        "token_count": int(sec.get("token_count", 0) or 0),
        "embedding": embedding if is_real_vector(embedding) else None,
    }


def local_vector(sec: dict[str, Any]) -> list[float]:
    """Vector used by the in-memory store: the real embedding if present, else the hash fallback."""
    return sec.get("embedding") or sec.get("fallback_embedding") or []


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if len(a) != len(b) or not a:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm > 0 else 0.0


def rank_local_sections(
    sections: Iterable[dict[str, Any]],
    query_embedding: list[float],
    threshold: float,
    limit: int,
) -> list[dict[str, Any]]:
    """Cosine similarity search over in-memory sections, shaped like the match RPC result."""
    results: list[dict[str, Any]] = []
    for sec in sections:
        score = cosine_similarity(sec.get("embedding") or [], query_embedding)
        if score > threshold:
            results.append(
                {
                    "id": sec["id"],
                    "document_id": sec["document_id"],
                    "document_title": sec["document_title"],
                    "heading": sec["heading"],
                    "markdown_content": sec["markdown_content"],
                    "tags": sec.get("tags", []),
                    "similarity": round(float(score), 4),
                }
            )
    results.sort(key=lambda r: r["similarity"], reverse=True)
    return results[:limit]


class SupabaseBrainClient:
    """Document store used by the HTTP API and the ingestion pipeline."""

    def __init__(self, url: str | None = None, key: str | None = None) -> None:
        self.url = (config.supabase_url if url is None else url).strip().rstrip("/")
        self.key = (config.supabase_key if key is None else key).strip()
        self.is_live = bool(self.url and self.key)

        # In-memory storage for offline development; guarded because the server is threaded.
        self._lock = threading.Lock()
        self._local_docs: dict[str, dict[str, Any]] = {}
        self._local_sections: list[dict[str, Any]] = []

    def _headers(self, prefer: str = "return=representation") -> dict[str, str]:
        return {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Prefer": prefer,
        }

    def save_document(
        self,
        title: str,
        summary: str,
        tags: list[str],
        source_type: str = "text",
        source_name: str = "",
        raw_content: str = "",
        sections: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Saves a document and its sections. The returned record has ``storage`` set to
        ``"supabase"`` or ``"memory"`` (offline mode or after a failed remote write)."""
        sections = sections or []
        doc_record: dict[str, Any] = {
            "id": str(uuid.uuid4()),
            "title": title,
            "summary": summary,
            "tags": tags,
            "source_type": source_type,
            "source_name": source_name,
            "raw_content": raw_content,
            "total_sections": len(sections),
        }

        if self.is_live:
            try:
                return self._save_remote(doc_record, sections)
            except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError) as exc:
                logger.warning(
                    "Supabase insert failed (%s); keeping document %s in memory only",
                    describe_error(exc),
                    doc_record["id"],
                )

        return self._save_local(doc_record, sections)

    def _save_remote(self, doc_record: dict[str, Any], sections: list[dict[str, Any]]) -> dict[str, Any]:
        payloads = [section_payload(sec) for sec in sections]
        with httpx.Client(timeout=supabase_timeout()) as client:
            resp = client.post(f"{self.url}/rest/v1/knowledge_documents", headers=self._headers(), json=doc_record)
            resp.raise_for_status()
            body = resp.json()
            created = body[0] if isinstance(body, list) else body
            doc_id = created["id"]

            if payloads:
                try:
                    sec_resp = client.post(
                        f"{self.url}/rest/v1/knowledge_sections",
                        headers=self._headers(prefer="return=minimal"),
                        json=[{"document_id": doc_id, **payload} for payload in payloads],
                    )
                    sec_resp.raise_for_status()
                except httpx.HTTPError:
                    # Do not leave a document without its sections behind.
                    self._delete_remote_document(client, doc_id)
                    raise

        embedded = sum(1 for payload in payloads if payload["embedding"] is not None)
        logger.info("Stored document %s with %d sections (%d embedded)", doc_id, len(payloads), embedded)
        return {**created, "storage": "supabase"}

    def _delete_remote_document(self, client: httpx.Client, doc_id: str) -> None:
        try:
            resp = client.delete(
                f"{self.url}/rest/v1/knowledge_documents",
                params={"id": f"eq.{doc_id}"},
                headers=self._headers(prefer="return=minimal"),
            )
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            logger.error(
                "Could not roll back document %s after a failed section insert (%s)", doc_id, describe_error(exc)
            )

    def _save_local(self, doc_record: dict[str, Any], sections: list[dict[str, Any]]) -> dict[str, Any]:
        record = {**doc_record, "storage": "memory"}
        local_sections = [
            {
                "id": str(uuid.uuid4()),
                "document_id": record["id"],
                "document_title": record["title"],
                "heading": sec.get("heading", ""),
                "markdown_content": sec.get("markdown_content", ""),
                "tags": record["tags"],
                "embedding": local_vector(sec),
            }
            for sec in sections
        ]
        with self._lock:
            self._local_docs[record["id"]] = record
            self._local_sections.extend(local_sections)
        return record

    def list_documents(self, limit: int = DOCUMENT_LIST_LIMIT) -> list[dict[str, Any]]:
        """Returns the newest documents (without raw content)."""
        if self.is_live:
            try:
                with httpx.Client(timeout=supabase_timeout()) as client:
                    resp = client.get(
                        f"{self.url}/rest/v1/knowledge_documents",
                        params={
                            "select": ",".join(DOCUMENT_LIST_COLUMNS),
                            "order": "created_at.desc",
                            "limit": str(limit),
                        },
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
        return [{col: doc.get(col) for col in DOCUMENT_LIST_COLUMNS} | {"storage": "memory"} for doc in docs[:limit]]

    def search_similar_sections(
        self,
        query_embedding: list[float],
        threshold: float = 0.2,
        limit: int = 4,
    ) -> list[dict[str, Any]]:
        """Vector search via the ``match_knowledge_sections`` RPC, or in memory when offline.

        ``query_embedding`` must be a real embedding when Supabase is live; hash vectors are not
        comparable with stored embeddings.
        """
        if self.is_live:
            try:
                with httpx.Client(timeout=supabase_timeout()) as client:
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


# Shared instance used by the server and the ingestion pipeline.
db = SupabaseBrainClient()
