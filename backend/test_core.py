import math
import unittest
from core.chunker import chunk_markdown
from core.embeddings import get_embedding, get_embeddings_batch
from core.config import BrainConfig
from core.structurer import structure_raw_content

class TestCoreModules(unittest.TestCase):
    def test_chunk_markdown_empty(self):
        self.assertEqual(chunk_markdown(""), [])
        self.assertEqual(chunk_markdown("   "), [])

    def test_chunk_markdown_headings(self):
        md = """# Introduction
This is the intro section.

## Architecture
This is the architecture section with details.

### Subsystem
Details of subsystem."""
        chunks = chunk_markdown(md)
        self.assertEqual(len(chunks), 3)
        self.assertEqual(chunks[0]["heading"], "# Introduction")
        self.assertEqual(chunks[1]["heading"], "## Architecture")
        self.assertEqual(chunks[2]["heading"], "### Subsystem")
        self.assertEqual(chunks[0]["section_index"], 0)
        self.assertEqual(chunks[1]["section_index"], 1)
        self.assertEqual(chunks[2]["section_index"], 2)

    def test_chunk_markdown_long_section(self):
        long_paragraph = "\n".join([f"Paragraph line {i} with substantial content." for i in range(50)])
        chunks = chunk_markdown(long_paragraph, max_chunk_chars=300)
        self.assertGreater(len(chunks), 1)
        for c in chunks:
            self.assertGreater(len(c["markdown_content"]), 0)

    def test_embedding_fallback_dimensions_and_norm(self):
        vec = get_embedding("Starpi Enterprise Brain semantic test")
        self.assertEqual(len(vec), 1536)
        norm = math.sqrt(sum(x * x for x in vec))
        self.assertAlmostEqual(norm, 1.0, places=3)

    def test_embedding_empty_input(self):
        vec = get_embedding("")
        self.assertEqual(len(vec), 1536)
        self.assertTrue(all(x == 0.0 for x in vec))

    def test_batch_embeddings(self):
        batch = get_embeddings_batch(["Alpha", "Beta", "Gamma"])
        self.assertEqual(len(batch), 3)
        for vec in batch:
            self.assertEqual(len(vec), 1536)

    def test_config_defaults(self):
        cfg = BrainConfig()
        self.assertTrue(cfg.supabase_url.startswith("https://"))
        self.assertTrue(len(cfg.llm_model) > 0)
        self.assertEqual(cfg.server_port, 9200)
        self.assertIsInstance(cfg.gemini_keys, list)
        self.assertIsInstance(cfg.openrouter_keys, list)

    def test_structurer_graceful_fallback(self):
        raw_sample = "Projekt Starpi: Dezentrales KI Betriebssystem für WebGPU und Enterprise Brain."
        result = structure_raw_content(raw_sample, source_name="TestDocument")
        self.assertIn("title", result)
        self.assertIn("summary", result)
        self.assertIn("tags", result)
        self.assertIn("markdown", result)
        self.assertEqual(result["title"], "TestDocument")

if __name__ == "__main__":
    unittest.main()
