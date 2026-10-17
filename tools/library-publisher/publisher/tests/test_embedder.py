"""e5 prefixes, mean pooling, L2 normalisation and model checks of the embedder."""

from __future__ import annotations

import json
import math
import os
import tempfile
import unittest
from pathlib import Path

from publisher.embedder import (
    DEFAULT_BATCH_SIZE,
    EMBEDDING_DIM,
    E5Embedder,
    EmbedderError,
    load_embedder,
    prefixed,
)

from .helpers import HAS_NUMPY, FakeSession, FakeTokenizer

FIXTURES = Path(__file__).resolve().parent / "fixtures"
REAL_MODEL_DIR = os.environ.get("PUBLISHER_TEST_MODEL_DIR", "")


def dot(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))


class PrefixTests(unittest.TestCase):
    def test_e5_prefixes(self) -> None:
        self.assertEqual(prefixed(["a", "b"], "query"), ["query: a", "query: b"])
        self.assertEqual(prefixed(["a"], "passage"), ["passage: a"])
        with self.assertRaises(ValueError):
            prefixed(["a"], "document")  # type: ignore[arg-type]

    def test_one_text_per_model_run_by_default(self) -> None:
        self.assertEqual(DEFAULT_BATCH_SIZE, 1)


class LoadEmbedderTests(unittest.TestCase):
    def test_missing_model_files_point_to_fetch_model(self) -> None:
        with tempfile.TemporaryDirectory() as empty, self.assertRaises(EmbedderError) as caught:
            load_embedder(Path(empty))
        self.assertIn("tokenizer.json is missing", str(caught.exception))
        self.assertIn("fetch-model", str(caught.exception))


@unittest.skipUnless(HAS_NUMPY, "numpy is not installed")
class E5EmbedderTests(unittest.TestCase):
    def setUp(self) -> None:
        import numpy as np

        self.np = np
        self.table = np.random.default_rng(7).standard_normal((50, EMBEDDING_DIM)).astype(np.float32)
        self.tokenizer = FakeTokenizer()

    def expected(self, text: str) -> list[float]:
        ids = self.tokenizer.encode_batch([text])[0].ids
        self.tokenizer.seen.pop()
        mean = self.table[ids].mean(axis=0)
        return list(map(float, mean / self.np.linalg.norm(mean)))

    def test_vectors_are_mean_pooled_unit_length_and_prefixed(self) -> None:
        embedder = E5Embedder(self.tokenizer, FakeSession(self.table))
        vectors = embedder.embed(["opening hours", "the library opens at ten"], "passage")
        self.assertEqual(self.tokenizer.seen, ["passage: opening hours", "passage: the library opens at ten"])
        self.assertEqual([len(v) for v in vectors], [EMBEDDING_DIM, EMBEDDING_DIM])
        for vector, text in zip(vectors, ["passage: opening hours", "passage: the library opens at ten"], strict=True):
            self.assertAlmostEqual(dot(vector, vector), 1.0, places=5)
            for got, want in zip(vector, self.expected(text), strict=True):
                self.assertAlmostEqual(got, want, places=5)
        self.assertTrue(all(isinstance(v, float) for v in vectors[0]))

    def test_padding_in_a_batch_does_not_change_a_vector(self) -> None:
        single = E5Embedder(self.tokenizer, FakeSession(self.table)).embed_query("short")
        session = FakeSession(self.table)
        batched = E5Embedder(self.tokenizer, session, batch_size=8).embed(
            ["short", "a much longer question with many words"], "query"
        )
        # "<s> query: short </s>" padded with <pad> (id 1) to the 10 tokens of the longer text.
        self.assertEqual(session.feeds[0]["input_ids"].shape, (2, 10))
        self.assertEqual(session.feeds[0]["attention_mask"][0].tolist(), [1] * 4 + [0] * 6)
        self.assertEqual(session.feeds[0]["input_ids"][0].tolist()[4:], [1] * 6)
        for got, want in zip(batched[0], single, strict=True):
            self.assertAlmostEqual(got, want, places=6)

    def test_batches_keep_the_input_order(self) -> None:
        texts = [f"text number {i}" for i in range(5)]
        session = FakeSession(self.table)
        vectors = E5Embedder(self.tokenizer, session, batch_size=2).embed_passages(texts)
        self.assertEqual(len(session.feeds), 3)
        for vector, text in zip(vectors, texts, strict=True):
            self.assertAlmostEqual(dot(vector, self.expected("passage: " + text)), 1.0, places=5)

    def test_only_the_declared_inputs_are_fed(self) -> None:
        session = FakeSession(self.table, inputs=("input_ids", "attention_mask"))
        E5Embedder(self.tokenizer, session).embed_query("q")
        self.assertEqual(sorted(session.feeds[0]), ["attention_mask", "input_ids"])
        self.assertEqual(str(session.feeds[0]["input_ids"].dtype), "int64")

    def test_unknown_inputs_are_refused(self) -> None:
        with self.assertRaises(EmbedderError):
            E5Embedder(self.tokenizer, FakeSession(self.table, inputs=("input_ids", "pixel_values")))
        with self.assertRaises(EmbedderError):
            E5Embedder(self.tokenizer, FakeSession(self.table, inputs=("attention_mask",)))

    def test_wrong_dimension_and_non_finite_output_are_refused(self) -> None:
        narrow = FakeSession(self.table[:, :128])
        with self.assertRaises(EmbedderError):
            E5Embedder(self.tokenizer, narrow).embed_query("q")
        broken = FakeSession(self.table, transform=lambda hidden: hidden * self.np.nan)
        with self.assertRaises(EmbedderError):
            E5Embedder(self.tokenizer, broken).embed_query("q")

    def test_empty_input_runs_nothing(self) -> None:
        session = FakeSession(self.table)
        self.assertEqual(E5Embedder(self.tokenizer, session).embed_passages([]), [])
        self.assertEqual(session.feeds, [])


@unittest.skipUnless(REAL_MODEL_DIR, "set PUBLISHER_TEST_MODEL_DIR to the fetched model files")
class RealModelTests(unittest.TestCase):
    """Runs the pinned q8 model against vectors that Transformers.js computed in the browser runtime."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.embedder = load_embedder(Path(REAL_MODEL_DIR))
        cls.reference = json.loads((FIXTURES / "e5_transformers_js.json").read_text(encoding="utf-8"))

    def test_vectors_agree_with_transformers_js(self) -> None:
        for text, expected in zip(self.reference["texts"], self.reference["vectors"], strict=True):
            kind, body = text.split(": ", 1)
            vector = self.embedder.embed([body], kind)[0]
            self.assertEqual(len(vector), EMBEDDING_DIM)
            self.assertAlmostEqual(math.sqrt(dot(vector, vector)), 1.0, places=5)
            with self.subTest(text=text):
                self.assertGreater(dot(vector, expected), 0.99)

    def test_the_answer_ranks_above_an_unrelated_passage_in_both_languages(self) -> None:
        query = self.embedder.embed_query("When does the city library open on Saturdays?")
        english, german, unrelated = self.embedder.embed_passages(
            [
                "The city library is open on Saturdays from 10 am to 2 pm.",
                "Die Stadtbibliothek hat samstags von 10 bis 14 Uhr geöffnet.",
                "Bananas are a good source of potassium.",
            ]
        )
        self.assertGreater(dot(query, english), dot(query, unrelated))
        self.assertGreater(dot(query, german), dot(query, unrelated))


if __name__ == "__main__":
    unittest.main()
