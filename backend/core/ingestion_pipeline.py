"""Ingestion: raw text -> structured Markdown -> sections -> embeddings -> storage."""

from __future__ import annotations

import logging
from typing import Any

from .chunker import chunk_markdown
from .embeddings import get_embedding_with_source
from .structurer import structure_raw_content
from .supabase_client import db

logger = logging.getLogger(__name__)


def ingest_raw_information(
    raw_text: str,
    source_name: str = "Notiz",
    source_type: str = "text",
) -> dict[str, Any]:
    """Runs the full ingestion pipeline.

    1. Structures the raw text into Markdown plus metadata via the LLM.
    2. Splits the Markdown into sections.
    3. Embeds each section. Only vectors from the embedding endpoint are persisted; when it is
       unavailable the section is stored with a NULL embedding (the hash fallback is kept for the
       in-memory store only).
    4. Saves the document and sections.
    """
    structured = structure_raw_content(raw_text, source_name=source_name)
    title = structured.get("title", source_name)
    summary = structured.get("summary", "")
    tags = structured.get("tags", [])
    markdown_content = structured.get("markdown", raw_text)

    chunks = chunk_markdown(markdown_content)

    sections_to_save: list[dict[str, Any]] = []
    embedded_count = 0
    for chunk in chunks:
        vector, is_real = get_embedding_with_source(f"{title} - {chunk['heading']}\n{chunk['markdown_content']}")
        if is_real:
            embedded_count += 1
        sections_to_save.append(
            {
                "section_index": chunk["section_index"],
                "heading": chunk["heading"],
                "markdown_content": chunk["markdown_content"],
                "token_count": chunk["token_count"],
                "embedding": vector if is_real else None,
                "fallback_embedding": None if is_real else vector,
            }
        )

    if embedded_count < len(sections_to_save):
        logger.warning(
            "%d of %d sections have no embedding and will not be found by vector search",
            len(sections_to_save) - embedded_count,
            len(sections_to_save),
        )

    doc_record = db.save_document(
        title=title,
        summary=summary,
        tags=tags,
        source_type=source_type,
        source_name=source_name,
        raw_content=raw_text,
        sections=sections_to_save,
    )

    return {
        "document_id": doc_record.get("id"),
        "title": title,
        "summary": summary,
        "tags": tags,
        "markdown": markdown_content,
        "sections_count": len(sections_to_save),
        "embedded_sections_count": embedded_count,
        "storage": doc_record.get("storage", "unknown"),
        "status": "success",
    }
