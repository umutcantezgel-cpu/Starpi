"""Supabase access of the library publisher: PostgREST tables and RPCs with the service role key.

The service role bypasses row level security, so this module only ever reads the shared library
(rows that are published or that have no owner, i.e. rows written with the service role) and
never the private rows of browser sessions. It writes through ``ingest_document_atomic``, so a
document and its sections are stored together or not at all.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Iterable
from typing import Any

import httpx

from .embedder import EMBEDDING_DIM
from .http_utils import describe_error, http_timeout

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT_SECONDS = 30.0
CONNECT_TIMEOUT_SECONDS = 5.0
MAX_ERROR_MESSAGE_CHARS = 300

# Columns returned by list_documents; raw_content is left out to keep responses small.
DOCUMENT_LIST_COLUMNS = ("id", "title", "source_name", "tags", "total_sections", "is_public", "created_at")
DOCUMENT_LIST_LIMIT = 200
# The shared library: published rows and rows without an owner (written with the service role).
SHARED_ROWS = "(is_public.eq.true,owner_id.is.null)"

# Size limits of the CHECK constraints in backend/supabase (see its README). Fields are clipped to
# them, so a long title or heading cannot make an insert fail.
MAX_TITLE_CHARS = 500
MAX_SOURCE_TYPE_CHARS = 64
MAX_SOURCE_NAME_CHARS = 500
MAX_SUMMARY_CHARS = 5_000
MAX_RAW_CONTENT_CHARS = 200_000
MAX_TAGS = 50
MAX_TAG_CHARS = 100
MAX_HEADING_CHARS = 1_000
MAX_SECTION_CHARS = 210_000

# PostgREST / PostgreSQL codes that mean the 384-dimension migration has not been applied.
MISSING_MIGRATION_CODES = ("PGRST202", "PGRST204", "42703", "42883")


class SupabaseError(Exception):
    """A Supabase request failed. The message never contains the key."""

    def __init__(self, message: str, *, status: int | None = None, code: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code

    @property
    def missing_migration(self) -> bool:
        return self.code in MISSING_MIGRATION_CODES


def clip_text(value: Any, max_chars: int) -> Any:
    """Cuts strings to ``max_chars`` characters; other values (e.g. None) are returned unchanged."""
    return value[:max_chars] if isinstance(value, str) else value


def clip_tags(tags: Iterable[Any]) -> list[str]:
    """At most ``MAX_TAGS`` non-empty tags of at most ``MAX_TAG_CHARS`` characters."""
    cleaned = [str(tag).strip()[:MAX_TAG_CHARS] for tag in tags if str(tag).strip()]
    return cleaned[:MAX_TAGS]


def is_vector_384(value: Any) -> bool:
    """True for a list of ``EMBEDDING_DIM`` finite numbers (the ``embedding_384`` column)."""
    if not isinstance(value, list) or len(value) != EMBEDDING_DIM:
        return False
    return all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in value)


def section_payload(section: dict[str, Any]) -> dict[str, Any]:
    """Section fields as ``ingest_document_atomic`` stores them, clipped to the database limits.

    A missing or malformed vector becomes None (SQL NULL), so ``backfill`` can fill it later.
    """
    vector = section.get("embedding_384")
    return {
        "section_index": int(section.get("section_index", 0) or 0),
        "heading": clip_text(str(section.get("heading", "") or ""), MAX_HEADING_CHARS),
        "markdown_content": clip_text(str(section.get("markdown_content", "") or ""), MAX_SECTION_CHARS),
        "token_count": int(section.get("token_count", 0) or 0),
        "embedding_384": vector if is_vector_384(vector) else None,
    }


def _error_from_response(response: httpx.Response) -> SupabaseError:
    code: str | None = None
    message = ""
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        code = str(body["code"]) if body.get("code") is not None else None
        message = str(body.get("message") or body.get("hint") or "")
    detail = f" {code}" if code else ""
    text = f": {message[:MAX_ERROR_MESSAGE_CHARS]}" if message else ""
    return SupabaseError(f"HTTP {response.status_code}{detail}{text}", status=response.status_code, code=code)


class SupabaseService:
    """PostgREST client for the shared library. ``transport`` replaces the network in tests."""

    def __init__(self, url: str, key: str, *, transport: httpx.BaseTransport | None = None) -> None:
        self.url = url.strip().rstrip("/")
        self.key = key.strip()
        self.is_configured = bool(self.url and self.key)
        self._transport = transport

    def __repr__(self) -> str:
        return f"SupabaseService(url={self.url!r}, configured={self.is_configured})"

    def _headers(self, prefer: str | None) -> dict[str, str]:
        headers = {"apikey": self.key, "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"}
        if prefer:
            headers["Prefer"] = prefer
        return headers

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        json: Any = None,
        prefer: str | None = None,
    ) -> Any:
        """Sends one request and returns the decoded JSON body (None for an empty body)."""
        if not self.is_configured:
            raise SupabaseError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set")
        timeout = http_timeout(REQUEST_TIMEOUT_SECONDS, CONNECT_TIMEOUT_SECONDS)
        try:
            with httpx.Client(timeout=timeout, transport=self._transport) as client:
                response = client.request(
                    method, f"{self.url}{path}", params=params, json=json, headers=self._headers(prefer)
                )
        except httpx.HTTPError as exc:
            raise SupabaseError(f"request failed: {describe_error(exc)}") from exc
        if response.status_code >= 400:
            raise _error_from_response(response)
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError as exc:
            raise SupabaseError(f"HTTP {response.status_code}: response is not JSON") from exc

    def health_check(self) -> dict[str, Any]:
        """Checks the REST API, the service role key and the ``embedding_384`` column."""
        if not self.is_configured:
            return {"connected": False, "status": "not_configured"}
        try:
            self._request("GET", "/rest/v1/knowledge_documents", params={"select": "id", "limit": "1"})
        except SupabaseError as exc:
            return {"connected": False, "status": "error", "error": str(exc)}
        try:
            self._request("GET", "/rest/v1/knowledge_sections", params={"select": "id,embedding_384", "limit": "1"})
            vectors = True
        except SupabaseError as exc:
            if not exc.missing_migration:
                return {"connected": True, "status": "error", "error": str(exc)}
            vectors = False
        return {"connected": True, "status": "ok", "embedding_384": vectors}

    def ingest_document(
        self,
        *,
        title: str,
        summary: str,
        tags: Iterable[str],
        source_type: str,
        source_name: str,
        raw_content: str,
        sections: list[dict[str, Any]],
    ) -> str:
        """Stores a document and its sections in one transaction; returns the new document id.

        The new document is private and has no owner until :meth:`set_public` publishes it.
        """
        body = {
            "doc_title": clip_text(title, MAX_TITLE_CHARS),
            "doc_summary": clip_text(summary, MAX_SUMMARY_CHARS),
            "doc_tags": clip_tags(tags),
            "doc_source_type": clip_text(source_type, MAX_SOURCE_TYPE_CHARS),
            "doc_source_name": clip_text(source_name, MAX_SOURCE_NAME_CHARS),
            "doc_raw_content": raw_content,
            "sections_data": [section_payload(section) for section in sections],
        }
        returned = self._request("POST", "/rest/v1/rpc/ingest_document_atomic", json=body)
        if not isinstance(returned, str) or not returned:
            raise SupabaseError(f"ingest_document_atomic returned {type(returned).__name__} instead of an id")
        return returned

    def set_public(self, document_id: str, public: bool = True) -> None:
        """Publishes (or unpublishes) one document. Only the service role can do this."""
        rows = self._request(
            "PATCH",
            "/rest/v1/knowledge_documents",
            params={"id": f"eq.{document_id}", "select": "id"},
            json={"is_public": public},
            prefer="return=representation",
        )
        if not isinstance(rows, list) or len(rows) != 1:
            raise SupabaseError(f"document {document_id} was not found")

    def list_documents(self, limit: int = DOCUMENT_LIST_LIMIT) -> list[dict[str, Any]]:
        """The newest documents of the shared library (without their text)."""
        rows = self._request(
            "GET",
            "/rest/v1/knowledge_documents",
            params={
                "select": ",".join(DOCUMENT_LIST_COLUMNS),
                "or": SHARED_ROWS,
                "order": "created_at.desc",
                "limit": str(max(1, limit)),
            },
        )
        return rows if isinstance(rows, list) else []

    def sections_missing_384(self, *, limit: int, after: str | None = None) -> list[dict[str, Any]]:
        """Up to ``limit`` shared-library sections without ``embedding_384``, ordered by id.

        Each row has ``id``, ``heading``, ``markdown_content`` and ``knowledge_documents.title``.
        ``after`` continues behind the last id of the previous page.
        """
        params = {
            "select": "id,heading,markdown_content,knowledge_documents!inner(title)",
            "embedding_384": "is.null",
            "knowledge_documents.or": SHARED_ROWS,
            "order": "id.asc",
            "limit": str(max(1, limit)),
        }
        if after:
            params["id"] = f"gt.{after}"
        rows = self._request("GET", "/rest/v1/knowledge_sections", params=params)
        return rows if isinstance(rows, list) else []

    def set_section_vector(self, section_id: str, vector: list[float]) -> None:
        """Writes ``embedding_384`` of one section."""
        if not is_vector_384(vector):
            raise ValueError(f"expected {EMBEDDING_DIM} finite numbers")
        self._request(
            "PATCH",
            "/rest/v1/knowledge_sections",
            params={"id": f"eq.{section_id}"},
            json={"embedding_384": vector},
            prefer="return=minimal",
        )

    def match_384(self, vector: list[float], *, count: int = 5, threshold: float = 0.0) -> list[dict[str, Any]]:
        """Nearest sections through ``match_knowledge_vector_384``.

        With the service role the RPC sees every row, so the result is cut to the shared library
        here (published rows and rows without an owner); private rows of browser sessions never
        show up.
        """
        if not is_vector_384(vector):
            raise ValueError(f"expected {EMBEDDING_DIM} finite numbers")
        rows = self._request(
            "POST",
            "/rest/v1/rpc/match_knowledge_vector_384",
            json={"query_embedding": vector, "match_count": count, "match_threshold": threshold},
        )
        if not isinstance(rows, list):
            return []
        ids = sorted({str(row["document_id"]) for row in rows if isinstance(row, dict) and row.get("document_id")})
        if not ids:
            return []
        shared = self._request(
            "GET",
            "/rest/v1/knowledge_documents",
            params={"select": "id", "id": f"in.({','.join(ids)})", "or": SHARED_ROWS},
        )
        visible = {str(row.get("id")) for row in shared if isinstance(row, dict)} if isinstance(shared, list) else set()
        return [row for row in rows if isinstance(row, dict) and str(row.get("document_id")) in visible]
