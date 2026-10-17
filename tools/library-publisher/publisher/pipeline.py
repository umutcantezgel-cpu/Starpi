"""From a source file to the rows of one shared-library document.

source text -> optional structuring -> sections (chunker) -> passage vectors (embedder)
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from .chunker import chunk_markdown
from .supabase_service import MAX_RAW_CONTENT_CHARS, MAX_SUMMARY_CHARS, MAX_TITLE_CHARS

SUMMARY_CHARS = 300
MARKDOWN_SUFFIXES = (".md", ".markdown")
TEXT_SUFFIXES = (".txt", ".text", *MARKDOWN_SUFFIXES)

_H1 = re.compile(r"^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$")
_MARKUP_LINE = re.compile(r"^ {0,3}(#{1,6}[ \t]|[-*+][ \t]|\d+[.)][ \t]|>|\||`{3}|~{3})")


class PassageEmbedder(Protocol):
    def embed_passages(self, texts: Sequence[str]) -> list[list[float]]: ...


class SourceError(Exception):
    """A source file cannot be published as it is."""


@dataclass
class PreparedDocument:
    """One document with its sections, ready for ``SupabaseService.ingest_document``."""

    title: str
    summary: str
    tags: list[str]
    source_type: str
    source_name: str
    raw_content: str
    markdown: str
    sections: list[dict[str, Any]] = field(default_factory=list)

    @property
    def embedded_sections(self) -> int:
        return sum(1 for section in self.sections if section.get("embedding_384") is not None)


def read_source(path: Path) -> str:
    """Text of a UTF-8 text or Markdown file within the database limit for raw content."""
    if path.suffix.lower() not in TEXT_SUFFIXES:
        raise SourceError(f"{path.name}: only {', '.join(TEXT_SUFFIXES)} files are supported")
    try:
        text = path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError as exc:
        raise SourceError(f"{path.name} is not UTF-8 text") from exc
    except OSError as exc:
        raise SourceError(f"{path.name} cannot be read ({type(exc).__name__})") from exc
    if not text.strip():
        raise SourceError(f"{path.name} is empty")
    if len(text) > MAX_RAW_CONTENT_CHARS:
        raise SourceError(f"{path.name} has {len(text)} characters, more than {MAX_RAW_CONTENT_CHARS}; split it first")
    return text


def derive_title(markdown: str, fallback: str) -> str:
    """The first level-1 heading, else the first non-empty line, else ``fallback``."""
    first_line = ""
    for line in markdown.splitlines():
        match = _H1.match(line)
        if match:
            return match.group(1).strip()[:MAX_TITLE_CHARS]
        if not first_line and line.strip():
            first_line = line.strip().lstrip("#").strip()
    return (first_line or fallback)[:MAX_TITLE_CHARS]


def derive_summary(markdown: str, limit: int = SUMMARY_CHARS) -> str:
    """The first paragraph of plain text (no heading, list, quote, table or fence), cut at a word."""
    paragraph: list[str] = []
    for line in markdown.splitlines():
        if not line.strip():
            if paragraph:
                break
            continue
        if _MARKUP_LINE.match(line):
            if paragraph:
                break
            continue
        paragraph.append(line.strip())
    text = " ".join(paragraph)
    if len(text) <= limit:
        return text
    cut = text.rfind(" ", 0, limit)
    return text[: cut if cut > 0 else limit].rstrip(" ,;:") + " …"


def passage_text(title: str, section: dict[str, Any]) -> str:
    """What the embedder reads for a section: the document title, the heading (when the section
    does not start with it) and the section text."""
    content = str(section.get("markdown_content", ""))
    heading = str(section.get("heading", ""))
    first_line = content.split("\n", 1)[0].lstrip("#").strip()
    parts = [title] if title else []
    if heading and heading != first_line:
        parts.append(heading)
    parts.append(content)
    return "\n".join(parts)


def prepare_document(
    raw_text: str,
    source_name: str,
    *,
    tags: Iterable[str] = (),
    structured: dict[str, Any] | None = None,
    embedder: PassageEmbedder | None = None,
) -> PreparedDocument:
    """Builds the document rows for ``raw_text``.

    ``structured`` is the optional result of :func:`publisher.structurer.structure_raw_content`;
    without it the text is published as written. Without ``embedder`` the sections get no vector
    (``publish --no-vectors``; ``backfill`` adds them later).
    """
    markdown = str(structured["markdown"]) if structured else raw_text
    stem = Path(source_name).stem or "document"
    title = str(structured["title"]) if structured else derive_title(markdown, stem)
    summary = str(structured["summary"]) if structured else derive_summary(markdown)
    merged_tags = list(dict.fromkeys([*(structured.get("tags", []) if structured else []), *tags]))
    suffix = Path(source_name).suffix.lower()
    document = PreparedDocument(
        title=title,
        summary=summary[:MAX_SUMMARY_CHARS],
        tags=merged_tags,
        source_type="markdown" if suffix in MARKDOWN_SUFFIXES else "text",
        source_name=source_name,
        raw_content=raw_text,
        markdown=markdown,
        sections=chunk_markdown(markdown),
    )
    if embedder is not None and document.sections:
        vectors = embedder.embed_passages([passage_text(title, section) for section in document.sections])
        if len(vectors) != len(document.sections):
            raise ValueError("the embedder returned a different number of vectors than sections")
        for section, vector in zip(document.sections, vectors, strict=True):
            section["embedding_384"] = vector
    return document
