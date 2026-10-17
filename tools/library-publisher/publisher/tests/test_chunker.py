"""Heading-based sections for the embedder."""

from __future__ import annotations

import unittest

from publisher.chunker import DEFAULT_HEADING, chunk_markdown


class ChunkerTests(unittest.TestCase):
    def test_blank_input_has_no_sections(self) -> None:
        self.assertEqual(chunk_markdown(""), [])
        self.assertEqual(chunk_markdown("  \n\t\n"), [])

    def test_headings_start_sections_and_keep_their_line(self) -> None:
        text = "Intro line\n\n# Guide\nFirst part\n## Setup ##\nInstall it\n### Notes\nMore words here"
        sections = chunk_markdown(text)
        self.assertEqual([s["heading"] for s in sections], [DEFAULT_HEADING, "Guide", "Setup", "Notes"])
        self.assertEqual([s["section_index"] for s in sections], [0, 1, 2, 3])
        self.assertEqual(sections[2]["markdown_content"], "## Setup ##\nInstall it")
        self.assertEqual(sections[3]["token_count"], 5)

    def test_level_five_headings_and_hashes_without_space_are_text(self) -> None:
        sections = chunk_markdown("# Top\n##### deep\n#hashtag")
        self.assertEqual(len(sections), 1)
        self.assertIn("#hashtag", sections[0]["markdown_content"])

    def test_hash_lines_inside_code_fences_are_not_headings(self) -> None:
        text = "# Shell\n```bash\n# a comment\necho hi\n```\n~~~\n## also code\n~~~\nAfter"
        sections = chunk_markdown(text)
        self.assertEqual([s["heading"] for s in sections], ["Shell"])
        self.assertIn("# a comment", sections[0]["markdown_content"])

    def test_long_sections_continue_under_the_same_heading_within_the_limit(self) -> None:
        text = "# Long\n" + "\n".join(f"Sentence number {i} with a few words." for i in range(60))
        sections = chunk_markdown(text, max_chunk_chars=200)
        self.assertGreater(len(sections), 5)
        self.assertTrue(all(s["heading"] == "Long" for s in sections))
        self.assertTrue(all(len(s["markdown_content"]) <= 200 for s in sections))
        rejoined = "\n".join(s["markdown_content"] for s in sections)
        self.assertEqual(rejoined.split(), text.split())

    def test_a_single_long_line_is_cut_at_whitespace(self) -> None:
        text = " ".join(["word"] * 300)
        sections = chunk_markdown(text, max_chunk_chars=100)
        self.assertTrue(all(len(s["markdown_content"]) <= 100 for s in sections))
        self.assertEqual(sum(s["token_count"] for s in sections), 300)

    def test_a_line_without_whitespace_is_cut_hard(self) -> None:
        sections = chunk_markdown("x" * 250, max_chunk_chars=100)
        self.assertEqual([len(s["markdown_content"]) for s in sections], [100, 100, 50])

    def test_windows_line_endings(self) -> None:
        sections = chunk_markdown("# A\r\none\r\n# B\r\ntwo")
        self.assertEqual([s["markdown_content"] for s in sections], ["# A\none", "# B\ntwo"])

    def test_limit_must_be_positive(self) -> None:
        with self.assertRaises(ValueError):
            chunk_markdown("text", max_chunk_chars=0)


if __name__ == "__main__":
    unittest.main()
