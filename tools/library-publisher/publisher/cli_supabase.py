"""Command line of the library publisher.

Run from ``tools/library-publisher`` (``python -m publisher`` is the same)::

    python -m publisher.cli_supabase fetch-model
    python -m publisher.cli_supabase health
    python -m publisher.cli_supabase publish handbook.md notes/*.md --public --tag handbook
    python -m publisher.cli_supabase backfill
    python -m publisher.cli_supabase test-query "When is the next release?"
    python -m publisher.cli_supabase list

Exit status: 0 on success, 1 when a command failed, 2 for invalid arguments.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any, TextIO

from .config import LOG_LEVELS, PublisherConfig, load_default_env_file
from .embedder import E5Embedder, EmbedderError, load_embedder
from .model_files import DEFAULT_BASE_URL, ModelFileError, fetch_model
from .pipeline import SourceError, passage_text, prepare_document, read_source
from .structurer import structure_raw_content
from .supabase_service import SupabaseError, SupabaseService

logger = logging.getLogger("publisher")

MIGRATION_HINT = "apply backend/supabase/migrations/20261101000000_embedding_384.sql first"
BACKFILL_PAGE = 50


class Context:
    """What the commands share; tests replace the factories."""

    def __init__(
        self,
        config: PublisherConfig,
        *,
        out: TextIO = sys.stdout,
        err: TextIO = sys.stderr,
        service_factory: Callable[[PublisherConfig], SupabaseService] | None = None,
        embedder_factory: Callable[[Path], E5Embedder] | None = None,
    ) -> None:
        self.config = config
        self.out = out
        self.err = err
        self._service_factory = service_factory or (lambda cfg: SupabaseService(cfg.supabase_url, cfg.supabase_key))
        self._embedder_factory = embedder_factory or load_embedder
        self._embedder: E5Embedder | None = None

    def service(self) -> SupabaseService:
        return self._service_factory(self.config)

    def embedder(self) -> E5Embedder:
        if self._embedder is None:
            self._embedder = self._embedder_factory(self.config.model_dir)
        return self._embedder

    def print_json(self, value: Any) -> None:
        print(json.dumps(value, ensure_ascii=False), file=self.out)

    def fail(self, message: str) -> int:
        print(f"error: {message}", file=self.err)
        return 1


def _supabase_message(exc: SupabaseError) -> str:
    return f"{exc} ({MIGRATION_HINT})" if exc.missing_migration else str(exc)


def cmd_health(ctx: Context, _args: argparse.Namespace) -> int:
    result = ctx.service().health_check()
    ctx.print_json(result)
    if result.get("status") == "not_configured":
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see .env.example).", file=ctx.err)
    elif result.get("embedding_384") is False:
        print(f"The embedding_384 column is missing: {MIGRATION_HINT}.", file=ctx.err)
    return 0 if result.get("status") == "ok" and result.get("embedding_384") else 1


def cmd_list(ctx: Context, args: argparse.Namespace) -> int:
    try:
        documents = ctx.service().list_documents(limit=args.limit)
    except SupabaseError as exc:
        return ctx.fail(_supabase_message(exc))
    for document in documents:
        ctx.print_json({column: document.get(column) for column in ("id", "title", "is_public", "total_sections")})
    print(f"{len(documents)} documents", file=ctx.err)
    return 0


def cmd_publish(ctx: Context, args: argparse.Namespace) -> int:
    service = None if args.dry_run else ctx.service()
    if service is not None and not service.is_configured:
        return ctx.fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set (or use --dry-run)")
    try:
        embedder = None if args.no_vectors else ctx.embedder()
    except EmbedderError as exc:
        return ctx.fail(f"{exc} (or use --no-vectors and run backfill later)")

    failures = 0
    for path in args.files:
        try:
            raw_text = read_source(path)
            structured = structure_raw_content(raw_text, path.name, ctx.config) if args.structure else None
            document = prepare_document(raw_text, path.name, tags=args.tag, structured=structured, embedder=embedder)
        except (SourceError, EmbedderError) as exc:
            print(f"error: {exc}", file=ctx.err)
            failures += 1
            continue
        summary: dict[str, Any] = {
            "file": path.name,
            "title": document.title,
            "sections": len(document.sections),
            "vectors": document.embedded_sections,
        }
        if service is not None:
            try:
                summary["id"] = service.ingest_document(
                    title=document.title,
                    summary=document.summary,
                    tags=document.tags,
                    source_type=document.source_type,
                    source_name=document.source_name,
                    raw_content=document.raw_content,
                    sections=document.sections,
                )
                if args.public:
                    service.set_public(summary["id"])
            except SupabaseError as exc:
                print(f"error: {path.name}: {_supabase_message(exc)}", file=ctx.err)
                failures += 1
                continue
            summary["public"] = bool(args.public)
        ctx.print_json(summary)
    if service is not None and not args.public and failures < len(args.files):
        print("Documents are private until published: run again with --public, or set is_public.", file=ctx.err)
    return 1 if failures else 0


def cmd_backfill(ctx: Context, args: argparse.Namespace) -> int:
    service = ctx.service()
    if not service.is_configured:
        return ctx.fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set")
    try:
        embedder = ctx.embedder()
    except EmbedderError as exc:
        return ctx.fail(str(exc))

    done = failed = 0
    after: str | None = None
    while args.limit is None or done + failed < args.limit:
        page = BACKFILL_PAGE if args.limit is None else min(BACKFILL_PAGE, args.limit - done - failed)
        try:
            rows = service.sections_missing_384(limit=page, after=after)
        except SupabaseError as exc:
            return ctx.fail(_supabase_message(exc))
        if not rows:
            break
        for row in rows:
            after = str(row["id"])
            title = str((row.get("knowledge_documents") or {}).get("title") or "")
            try:
                vector = embedder.embed_passages([passage_text(title, row)])[0]
                if not args.dry_run:
                    service.set_section_vector(after, vector)
                done += 1
            except (EmbedderError, SupabaseError) as exc:
                logger.warning("Section %s: %s", after, exc)
                failed += 1
    ctx.print_json({"embedded": done, "failed": failed, "dry_run": bool(args.dry_run)})
    return 1 if failed else 0


def cmd_test_query(ctx: Context, args: argparse.Namespace) -> int:
    question = " ".join(args.text).strip()
    if not question:
        return ctx.fail("give a question")
    service = ctx.service()
    if not service.is_configured:
        return ctx.fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set")
    try:
        vector = ctx.embedder().embed_query(question)
        matches = service.match_384(vector, count=args.count)
    except EmbedderError as exc:
        return ctx.fail(str(exc))
    except SupabaseError as exc:
        return ctx.fail(_supabase_message(exc))
    for match in matches:
        ctx.print_json(
            {
                "similarity": round(float(match.get("similarity") or 0.0), 4),
                "document": match.get("document_title"),
                "heading": match.get("heading"),
            }
        )
    print(f"{len(matches)} matches", file=ctx.err)
    return 0


def cmd_fetch_model(ctx: Context, args: argparse.Namespace) -> int:
    try:
        results = fetch_model(ctx.config.model_dir, base_url=args.base_url)
    except (ModelFileError, OSError) as exc:
        return ctx.fail(str(exc))
    for path, state in results:
        ctx.print_json({"file": path, "state": state})
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m publisher.cli_supabase",
        description="Publish text and Markdown files to the shared Starpi library in Supabase.",
    )
    parser.add_argument("--model-dir", type=Path, help="embedding model directory (default: PUBLISHER_MODEL_DIR)")
    parser.add_argument("--log-level", type=str.upper, choices=LOG_LEVELS, default="WARNING")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("health", help="check the connection, the key and the embedding_384 column")

    listing = sub.add_parser("list", help="list the newest shared-library documents")
    listing.add_argument("--limit", type=int, default=50)

    publish = sub.add_parser("publish", help="store files as documents with 384-dimension section vectors")
    publish.add_argument("files", nargs="+", type=Path, help="UTF-8 .md or .txt files")
    publish.add_argument("--public", action="store_true", help="publish the documents (visible to every visitor)")
    publish.add_argument("--tag", action="append", default=[], help="tag for every document (repeatable)")
    publish.add_argument("--structure", action="store_true", help="let the chat model at LLM_BASE_URL rewrite the text")
    publish.add_argument("--no-vectors", action="store_true", help="store without vectors (fill them with backfill)")
    publish.add_argument("--dry-run", action="store_true", help="prepare and embed, print, write nothing")

    backfill = sub.add_parser("backfill", help="add missing 384-dimension vectors to shared-library sections")
    backfill.add_argument("--limit", type=int, help="stop after this many sections")
    backfill.add_argument("--dry-run", action="store_true", help="compute the vectors, write nothing")

    query = sub.add_parser("test-query", help="rank shared-library sections for a question by vector")
    query.add_argument("text", nargs="+", help="the question")
    query.add_argument("--count", type=int, default=5)

    fetch = sub.add_parser("fetch-model", help="download the pinned model files and check their SHA-256")
    fetch.add_argument("--base-url", default=DEFAULT_BASE_URL, help="Hugging Face compatible host")
    return parser


COMMANDS: dict[str, Callable[[Context, argparse.Namespace], int]] = {
    "health": cmd_health,
    "list": cmd_list,
    "publish": cmd_publish,
    "backfill": cmd_backfill,
    "test-query": cmd_test_query,
    "fetch-model": cmd_fetch_model,
}


def main(argv: Sequence[str] | None = None, *, context: Context | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=args.log_level, format="%(levelname)s %(name)s: %(message)s")
    if context is None:
        load_default_env_file()
        context = Context(PublisherConfig())
    if args.model_dir is not None:
        context.config.model_dir = args.model_dir
    return COMMANDS[args.command](context, args)


if __name__ == "__main__":
    sys.exit(main())
