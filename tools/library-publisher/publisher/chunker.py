"""Splits Markdown into heading-based sections small enough for one embedding each."""

from __future__ import annotations

import re
from typing import Any

# Heading of the text before the first Markdown heading.
DEFAULT_HEADING = "Overview"
DEFAULT_MAX_CHUNK_CHARS = 1500

# ATX headings of levels 1 to 4; closing hashes ("## Title ##") are not part of the title.
_HEADING = re.compile(r"^ {0,3}(#{1,4})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$")
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")


def _pieces(line: str, max_chars: int) -> list[str]:
    """Cuts a line longer than ``max_chars`` at the last whitespace before the limit (or at it)."""
    pieces: list[str] = []
    while len(line) > max_chars:
        cut = line.rfind(" ", 0, max_chars + 1)
        if cut <= 0:
            cut = max_chars
        pieces.append(line[:cut].rstrip())
        line = line[cut:].lstrip()
    pieces.append(line)
    return pieces


def chunk_markdown(markdown_text: str, max_chunk_chars: int = DEFAULT_MAX_CHUNK_CHARS) -> list[dict[str, Any]]:
    """Returns the sections of ``markdown_text`` in order.

    A heading line (``#`` to ``####``, not inside a code fence) starts a new section and stays its
    first line; ``heading`` is its text without the markers. A section that would grow past
    ``max_chunk_chars`` continues in a new section with the same heading. Each section is a dict
    with ``section_index``, ``heading``, ``markdown_content`` and ``token_count`` (whitespace
    separated words).
    """
    if not markdown_text or not markdown_text.strip():
        return []
    if max_chunk_chars < 1:
        raise ValueError("max_chunk_chars must be positive")

    sections: list[dict[str, Any]] = []
    heading = DEFAULT_HEADING
    lines: list[str] = []
    size = 0
    fence: str | None = None

    def flush() -> None:
        nonlocal size
        text = "\n".join(lines).strip()
        if text:
            sections.append(
                {
                    "section_index": len(sections),
                    "heading": heading,
                    "markdown_content": text,
                    "token_count": len(text.split()),
                }
            )
        lines.clear()
        size = 0

    for line in markdown_text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        fence_match = _FENCE.match(line)
        if fence_match:
            marker = fence_match.group(1)
            if fence is None:
                fence = marker
            elif marker[0] == fence[0] and len(marker) >= len(fence):
                fence = None
        heading_match = _HEADING.match(line) if fence is None and not fence_match else None
        if heading_match:
            flush()
            heading = heading_match.group(2).strip()
        for piece in _pieces(line, max_chunk_chars) if not heading_match else [line]:
            if lines and size + 1 + len(piece) > max_chunk_chars:
                flush()
            lines.append(piece)
            size += len(piece) + (1 if len(lines) > 1 else 0)
    flush()
    return sections
