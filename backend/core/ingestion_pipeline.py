from typing import Dict, Any
from .structurer import structure_raw_content
from .chunker import chunk_markdown
from .embeddings import get_embedding
from .supabase_client import db

def ingest_raw_information(
    raw_text: str,
    source_name: str = "Notiz",
    source_type: str = "text"
) -> Dict[str, Any]:
    """
    Complete ingestion pipeline:
    1. Re-formats raw text into clean, standardized Markdown + metadata via LLM.
    2. Chunks the Markdown into semantic section blocks.
    3. Computes vector embeddings for each chunk.
    4. Saves to Supabase (knowledge_documents & knowledge_sections).
    """
    # 1. Structure raw content
    structured = structure_raw_content(raw_text, source_name=source_name)
    title = structured.get("title", source_name)
    summary = structured.get("summary", "")
    tags = structured.get("tags", [])
    markdown_content = structured.get("markdown", raw_text)

    # 2. Chunk Markdown
    chunks = chunk_markdown(markdown_content)
    
    # 3. Compute Embeddings for each chunk
    sections_to_save = []
    for chunk in chunks:
        vector = get_embedding(f"{title} - {chunk['heading']}\n{chunk['markdown_content']}")
        sections_to_save.append({
            "section_index": chunk["section_index"],
            "heading": chunk["heading"],
            "markdown_content": chunk["markdown_content"],
            "token_count": chunk["token_count"],
            "embedding": vector
        })

    # 4. Save into Supabase Database
    doc_record = db.save_document(
        title=title,
        summary=summary,
        tags=tags,
        source_type=source_type,
        source_name=source_name,
        raw_content=raw_text,
        sections=sections_to_save
    )

    return {
        "document_id": doc_record.get("id"),
        "title": title,
        "summary": summary,
        "tags": tags,
        "markdown": markdown_content,
        "sections_count": len(sections_to_save),
        "status": "success"
    }
