"""From a source file to document rows: reading, titles, summaries, sections and vectors."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from publisher.pipeline import (
    SourceError,
    derive_summary,
    derive_title,
    passage_text,
    prepare_document,
    read_source,
)
from publisher.supabase_service import MAX_RAW_CONTENT_CHARS

from .helpers import FakePassageEmbedder, unit_vector

HANDBOOK = """# Library handbook

The city library lends books, films and games. Members borrow up to 20 items.

## Opening hours

Monday to Friday 9 am to 7 pm, Saturday 10 am to 2 pm.

## Fees

- Membership: free
- Late return: 0.50 per item and day
"""


class ReadSourceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.dir = Path(self._dir.name)

    def test_reads_utf8_with_bom(self) -> None:
        path = self.dir / "notes.md"
        path.write_bytes("﻿# Notes\nÄpfel".encode())
        self.assertEqual(read_source(path), "# Notes\nÄpfel")

    def test_refuses_what_cannot_be_published(self) -> None:
        cases = {
            "slides.pdf": b"%PDF",
            "empty.md": b"  \n",
            "latin1.txt": "café".encode("latin-1"),
            "huge.txt": b"x" * (MAX_RAW_CONTENT_CHARS + 1),
        }
        for name, data in cases.items():
            with self.subTest(name=name):
                (self.dir / name).write_bytes(data)
                with self.assertRaises(SourceError) as caught:
                    read_source(self.dir / name)
                self.assertIn(name, str(caught.exception))
                self.assertNotIn(str(self.dir), str(caught.exception))
        with self.assertRaises(SourceError):
            read_source(self.dir / "missing.md")


class DeriveTests(unittest.TestCase):
    def test_title_prefers_the_first_level_one_heading(self) -> None:
        self.assertEqual(derive_title("intro\n# Real title #\n# Second", "file"), "Real title")
        self.assertEqual(derive_title("## Only a subheading\ntext", "file"), "Only a subheading")
        self.assertEqual(derive_title("   \n", "file"), "file")

    def test_summary_is_the_first_plain_paragraph(self) -> None:
        self.assertEqual(
            derive_summary(HANDBOOK), "The city library lends books, films and games. Members borrow up to 20 items."
        )
        self.assertEqual(derive_summary("# T\n- a list\n> a quote\n"), "")
        summary = derive_summary("word " * 200, limit=50)
        self.assertLessEqual(len(summary), 52)
        self.assertTrue(summary.endswith(" …"))

    def test_passage_text_adds_the_heading_only_where_the_section_lacks_it(self) -> None:
        self.assertEqual(
            passage_text("Doc", {"heading": "Fees", "markdown_content": "## Fees\n- free"}), "Doc\n## Fees\n- free"
        )
        self.assertEqual(passage_text("Doc", {"heading": "Fees", "markdown_content": "- more"}), "Doc\nFees\n- more")


class PrepareDocumentTests(unittest.TestCase):
    def test_text_is_published_as_written_with_one_vector_per_section(self) -> None:
        embedder = FakePassageEmbedder()
        document = prepare_document(HANDBOOK, "handbook.md", tags=["library", "library"], embedder=embedder)
        self.assertEqual(document.title, "Library handbook")
        self.assertEqual(document.source_type, "markdown")
        self.assertEqual(document.source_name, "handbook.md")
        self.assertEqual(document.raw_content, HANDBOOK)
        self.assertEqual(document.tags, ["library"])
        self.assertEqual([s["heading"] for s in document.sections], ["Library handbook", "Opening hours", "Fees"])
        self.assertEqual(document.embedded_sections, 3)
        self.assertEqual(document.sections[1]["embedding_384"], unit_vector(1))
        self.assertTrue(all(p.startswith("Library handbook\n") for p in embedder.passages))
        self.assertIn("Saturday 10 am to 2 pm", embedder.passages[1])

    def test_without_an_embedder_sections_have_no_vector(self) -> None:
        document = prepare_document("plain words", "notes.txt")
        self.assertEqual(document.source_type, "text")
        self.assertEqual(document.title, "plain words")
        self.assertEqual(document.embedded_sections, 0)
        self.assertNotIn("embedding_384", document.sections[0])

    def test_a_structured_result_replaces_title_summary_and_markdown(self) -> None:
        structured = {"title": "Clean", "summary": "Short.", "tags": ["auto"], "markdown": "# Clean\nBody"}
        document = prepare_document("raw notes", "raw.txt", tags=["manual"], structured=structured)
        self.assertEqual((document.title, document.summary, document.markdown), ("Clean", "Short.", "# Clean\nBody"))
        self.assertEqual(document.tags, ["auto", "manual"])
        self.assertEqual(document.raw_content, "raw notes")

    def test_a_vector_count_mismatch_is_an_error(self) -> None:
        class Broken:
            def embed_passages(self, texts: list[str]) -> list[list[float]]:
                return []

        with self.assertRaises(ValueError):
            prepare_document(HANDBOOK, "handbook.md", embedder=Broken())


if __name__ == "__main__":
    unittest.main()
