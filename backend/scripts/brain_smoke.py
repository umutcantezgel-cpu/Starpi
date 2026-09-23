"""Manual end-to-end smoke run of ingestion and retrieval.

This is not a unit test. It calls the endpoints configured in the environment / backend/.env:
the chat model (LLM_BASE_URL or the Gemini / OpenRouter key pools), the embedding endpoint
(EMBEDDING_BASE_URL) and, if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set, the Supabase
project, where it writes a real test document. Without live endpoints the run falls back to the
in-memory store and hash vectors, which only shows that the pipeline is wired together.

Usage (from the repository root):
    python backend/scripts/brain_smoke.py
    python backend/scripts/brain_smoke.py --query "Wer baut die Supabase Anbindung?"
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

RAW_TEST_NOTE = """
Meeting Notizen Projekt Alpha - 28. August
Teilnehmer: Alex, Sarah, Michael
Wir haben besprochen dass das neue Feature am 15. September gelauncht wird.
Budget liegt bei 45.000 EUR.
Sarah kümmert sich um das Frontend Design in Figma bis zum 5. September.
Michael baut die Supabase Anbindung für die Vektordatenbank auf Port 5432.
Wichtig: DSGVO Compliance muss zu 100% sichergestellt sein, keine Nutzerdaten an US-Cloud-Provider ohne Verschlüsselung!
Alex übernimmt das Cloud-GPU Deployment mit vLLM auf einem deutschen Server.
"""

DEFAULT_QUERIES = (
    "Wer kümmert sich um die Supabase Vektordatenbank und bis wann ist der Launch?",
    "Welche Budgetgrenze und welche DSGVO-Vorgaben wurden für Projekt Alpha festgelegt?",
)


def _ensure_backend_on_path() -> None:
    backend_dir = str(Path(__file__).resolve().parent.parent)
    if backend_dir not in sys.path:
        sys.path.insert(0, backend_dir)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Manual end-to-end smoke run of ingestion and retrieval.")
    parser.add_argument("--query", action="append", help="question to ask (repeatable); defaults to two samples")
    parser.add_argument("--skip-ingest", action="store_true", help="only run the queries")
    parser.add_argument("--verbose", action="store_true", help="show INFO logs")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING, format="%(levelname)s %(name)s: %(message)s"
    )
    _ensure_backend_on_path()
    from core.ingestion_pipeline import ingest_raw_information
    from core.rag import query_brain
    from core.supabase_client import db

    print(f"Supabase live: {db.is_live}")

    if not args.skip_ingest:
        print("\n[1] Ingesting a sample meeting note ...")
        result = ingest_raw_information(
            raw_text=RAW_TEST_NOTE,
            source_name="Meeting_Alpha_28Aug.txt",
            source_type="meeting_notes",
        )
        print(f"  title:     {result['title']}")
        print(f"  summary:   {result['summary']}")
        print(f"  tags:      {result['tags']}")
        print(f"  sections:  {result['sections_count']} ({result['embedded_sections_count']} with embeddings)")
        print(f"  storage:   {result['storage']}")
        print("\n--- Structured Markdown ---")
        print(result["markdown"])
        print("---------------------------")

    print("\n[2] Retrieval and answers ...")
    for question in args.query or DEFAULT_QUERIES:
        answer = query_brain(question)
        print(f"\nQuestion: {question}")
        print(f"Provider: {answer.get('provider')}")
        print(f"Answer:\n{answer['answer']}")
        print(f"Sources ({len(answer['sources'])}):")
        for source in answer["sources"]:
            print(f"  - {source.get('document_title')} | {source.get('heading')} ({source.get('similarity')})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
