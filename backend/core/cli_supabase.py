"""Command line checks against the configured Supabase project.

Usage (from the ``backend`` directory)::

    python -m core.cli_supabase health
    python -m core.cli_supabase list
    python -m core.cli_supabase test-query "Projekt Alpha"
"""

from __future__ import annotations

import argparse
import json
import logging
import sys

from .embeddings import get_embedding_with_source
from .supabase_service import supabase_service


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m core.cli_supabase", description="Command line checks against the configured Supabase project."
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("health", help="check the connection and schema")
    sub.add_parser("list", help="list ingested documents")
    query = sub.add_parser("test-query", help="run a vector similarity search")
    query.add_argument("text", nargs="*", help="query text (default: 'Projekt Alpha')")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")

    if args.command == "health":
        result = supabase_service.health_check()
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0 if result.get("connected") else 1

    if args.command == "list":
        docs = supabase_service.list_documents()
        print(f"Total documents: {len(docs)}")
        for d in docs:
            print(f"  - [{d.get('id')}] {d.get('title')} (tags: {d.get('tags')})")
        return 0

    query = " ".join(args.text) or "Projekt Alpha"
    print(f"Vector similarity search for: {query!r}")
    vector, is_real = get_embedding_with_source(query)
    if vector is None:
        print("Empty query.", file=sys.stderr)
        return 1
    if supabase_service.is_configured and not is_real:
        print("Embedding endpoint unavailable; remote vector search skipped.", file=sys.stderr)
        return 1
    matches = supabase_service.match_sections(vector, threshold=0.1, limit=3)
    print(f"Matches found: {len(matches)}")
    for m in matches:
        print(f"  - {m.get('document_title')} | {m.get('heading')} (score: {m.get('similarity')})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
