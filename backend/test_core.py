"""Unit tests for the core modules.

All tests are offline: every outgoing HTTP call is replaced with a mock of ``httpx.Client``.
Run from the repository root with ``python -m unittest discover -s backend -p 'test_*.py'``.
"""

from __future__ import annotations

import math
import os
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

import httpx

from core import embeddings, rag, structurer
from core.chunker import chunk_markdown
from core.config import DEFAULT_MAX_BODY_BYTES, BrainConfig, load_env_file, parse_env_line
from core.embeddings import (
    EMBEDDING_DIM,
    get_embedding,
    get_embedding_with_source,
    get_embeddings_batch,
    hash_embedding,
)
from core.ingestion_pipeline import ingest_raw_information
from core.structurer import structure_raw_content
from core.supabase_client import SupabaseBrainClient

REAL_VECTOR = [0.5] * EMBEDDING_DIM


def response(status: int, payload: Any, method: str = "POST", url: str = "http://test.invalid/") -> httpx.Response:
    return httpx.Response(status, json=payload, request=httpx.Request(method, url))


def fake_http_client(**side_effects: Any) -> tuple[mock.MagicMock, mock.MagicMock]:
    """Returns ``(factory, client)``: ``factory`` replaces ``httpx.Client`` and yields ``client``.

    Keyword arguments set side effects on the client's methods, e.g. ``post=httpx.ConnectError("x")``.
    """
    client = mock.MagicMock(name="client")
    for method, effect in side_effects.items():
        getattr(client, method).side_effect = effect
    factory = mock.MagicMock(name="httpx.Client")
    factory.return_value.__enter__.return_value = client
    factory.return_value.__exit__.return_value = False
    return factory, client


def unreachable() -> httpx.ConnectError:
    return httpx.ConnectError("connection refused")


class ChunkerTests(unittest.TestCase):
    def test_chunk_markdown_empty(self) -> None:
        self.assertEqual(chunk_markdown(""), [])
        self.assertEqual(chunk_markdown("   "), [])

    def test_chunk_markdown_headings(self) -> None:
        md = """# Introduction
This is the intro section.

## Architecture
This is the architecture section with details.

### Subsystem
Details of subsystem."""
        chunks = chunk_markdown(md)
        self.assertEqual([c["heading"] for c in chunks], ["# Introduction", "## Architecture", "### Subsystem"])
        self.assertEqual([c["section_index"] for c in chunks], [0, 1, 2])

    def test_chunk_markdown_long_section(self) -> None:
        long_paragraph = "\n".join(f"Paragraph line {i} with substantial content." for i in range(50))
        chunks = chunk_markdown(long_paragraph, max_chunk_chars=300)
        self.assertGreater(len(chunks), 1)
        for c in chunks:
            self.assertGreater(len(c["markdown_content"]), 0)


class EmbeddingTests(unittest.TestCase):
    def patch_client(self, **side_effects: Any) -> tuple[mock.MagicMock, mock.MagicMock]:
        factory, client = fake_http_client(**side_effects)
        patcher = mock.patch.object(embeddings.httpx, "Client", factory)
        patcher.start()
        self.addCleanup(patcher.stop)
        return factory, client

    def test_fallback_when_endpoint_unreachable(self) -> None:
        self.patch_client(post=unreachable())
        with self.assertLogs("core.embeddings", "WARNING"):
            vector, is_real = get_embedding_with_source("Starpi semantic test")
        self.assertFalse(is_real)
        self.assertEqual(len(vector), EMBEDDING_DIM)
        self.assertAlmostEqual(math.sqrt(sum(x * x for x in vector)), 1.0, places=6)
        self.assertEqual(vector, hash_embedding("Starpi semantic test"))

    def test_get_embedding_keeps_returning_a_vector(self) -> None:
        self.patch_client(post=unreachable())
        with self.assertLogs("core.embeddings", "WARNING"):
            vector = get_embedding("Starpi Enterprise Brain semantic test")
        self.assertEqual(len(vector), EMBEDDING_DIM)
        self.assertAlmostEqual(math.sqrt(sum(x * x for x in vector)), 1.0, places=3)

    def test_remote_vector_is_marked_real(self) -> None:
        factory, client = self.patch_client(post=[response(200, {"data": [{"embedding": REAL_VECTOR}]})])
        vector, is_real = get_embedding_with_source("hello")
        self.assertTrue(is_real)
        self.assertEqual(vector, REAL_VECTOR)
        self.assertEqual(client.post.call_args.kwargs["json"]["input"], "hello")

    def test_wrong_dimension_is_not_real(self) -> None:
        self.patch_client(post=[response(200, {"data": [{"embedding": [0.1] * 10}]})])
        with self.assertLogs("core.embeddings", "WARNING"):
            vector, is_real = get_embedding_with_source("hello")
        self.assertFalse(is_real)
        self.assertEqual(len(vector), EMBEDDING_DIM)

    def test_http_error_status_falls_back(self) -> None:
        self.patch_client(post=[response(500, {"error": "boom"})])
        with self.assertLogs("core.embeddings", "WARNING") as logs:
            _, is_real = get_embedding_with_source("hello")
        self.assertFalse(is_real)
        self.assertIn("status 500", "\n".join(logs.output))

    def test_empty_input(self) -> None:
        _, client = self.patch_client(post=unreachable())
        self.assertEqual(get_embedding(""), [0.0] * EMBEDDING_DIM)
        self.assertEqual(get_embedding_with_source(""), (None, False))
        client.post.assert_not_called()

    def test_batch_embeddings(self) -> None:
        self.patch_client(post=unreachable())
        with self.assertLogs("core.embeddings", "WARNING"):
            batch = get_embeddings_batch(["Alpha", "Beta", "Gamma"])
        self.assertEqual(len(batch), 3)
        for vec in batch:
            self.assertEqual(len(vec), EMBEDDING_DIM)

    def test_timeout_constants_are_applied(self) -> None:
        factory, _ = self.patch_client(post=unreachable())
        with (
            mock.patch.object(embeddings, "EMBEDDING_TIMEOUT_SECONDS", 0.25),
            mock.patch.object(embeddings, "EMBEDDING_CONNECT_TIMEOUT_SECONDS", 0.1),
            self.assertLogs("core.embeddings", "WARNING"),
        ):
            get_embedding_with_source("hello")
        timeout = factory.call_args.kwargs["timeout"]
        self.assertEqual(timeout.read, 0.25)
        self.assertEqual(timeout.connect, 0.1)


class ConfigTests(unittest.TestCase):
    def test_config_defaults(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            cfg = BrainConfig()
        self.assertEqual(cfg.supabase_url, "")
        self.assertEqual(cfg.supabase_key, "")
        self.assertEqual(cfg.server_host, "127.0.0.1")
        self.assertEqual(cfg.server_port, 9200)
        self.assertEqual(cfg.api_token, "")
        self.assertEqual(cfg.max_body_bytes, DEFAULT_MAX_BODY_BYTES)
        self.assertEqual(
            cfg.allowed_origins,
            ["http://localhost:3000", "http://127.0.0.1:3000", "https://www.starpi.app", "https://starpi.app"],
        )
        self.assertTrue(cfg.llm_model)
        self.assertEqual(cfg.gemini_keys, [])
        self.assertEqual(cfg.openrouter_keys, [])

    def test_anon_key_is_never_used(self) -> None:
        env = {"SUPABASE_URL": "https://example.supabase.co", "SUPABASE_ANON_KEY": "anon-key"}
        with mock.patch.dict(os.environ, env, clear=True):
            cfg = BrainConfig()
        self.assertEqual(cfg.supabase_key, "")
        self.assertFalse(SupabaseBrainClient(url=cfg.supabase_url, key=cfg.supabase_key).is_live)

    def test_environment_overrides(self) -> None:
        env = {
            "SUPABASE_URL": "https://example.supabase.co",
            "SUPABASE_SERVICE_ROLE_KEY": "service-key",
            "BRAIN_ALLOWED_ORIGINS": " https://a.example/ , ,https://b.example",
            "BRAIN_MAX_BODY_BYTES": "2048",
            "BRAIN_API_TOKEN": " token-value ",
            "GEMINI_API_KEYS": "k1, k2,",
        }
        with mock.patch.dict(os.environ, env, clear=True):
            cfg = BrainConfig()
        self.assertEqual(cfg.supabase_key, "service-key")
        self.assertEqual(cfg.allowed_origins, ["https://a.example", "https://b.example"])
        self.assertEqual(cfg.max_body_bytes, 2048)
        self.assertEqual(cfg.api_token, "token-value")
        self.assertEqual(cfg.gemini_keys, ["k1", "k2"])

    def test_invalid_integer_falls_back_to_default(self) -> None:
        with (
            mock.patch.dict(os.environ, {"BRAIN_SERVER_PORT": "abc"}, clear=True),
            self.assertLogs("core.config", "WARNING"),
        ):
            cfg = BrainConfig()
        self.assertEqual(cfg.server_port, 9200)

    def test_repr_hides_secrets(self) -> None:
        cfg = BrainConfig(
            supabase_key="sb-secret",
            api_token="api-secret",
            llm_api_key="llm-secret",
            embedding_api_key="emb-secret",
            gemini_keys=["gem-secret"],
            openrouter_keys=["or-secret"],
        )
        text = repr(cfg)
        for secret in ("sb-secret", "api-secret", "llm-secret", "emb-secret", "gem-secret", "or-secret"):
            self.assertNotIn(secret, text)

    def test_parse_env_line(self) -> None:
        cases = {
            "KEY=value": ("KEY", "value"),
            "export KEY=value": ("KEY", "value"),
            'KEY="quoted value"': ("KEY", "quoted value"),
            "KEY='single'": ("KEY", "single"),
            "KEY = spaced ": ("KEY", "spaced"),
            "KEY=value # comment": ("KEY", "value"),
            'KEY="keep # hash"': ("KEY", "keep # hash"),
            "KEY=a=b": ("KEY", "a=b"),
            "KEY=": ("KEY", ""),
            "# comment": None,
            "": None,
            "no equals sign": None,
            "=value": None,
        }
        for line, expected in cases.items():
            with self.subTest(line=line):
                self.assertEqual(parse_env_line(line), expected)

    def test_load_env_file_handles_bom_quotes_and_export(self) -> None:
        content = "﻿export A=\"1\"\nB='two words'\n# comment\n\nC = 3 # note\nD=from-file\n"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            path.write_text(content, encoding="utf-8")
            with mock.patch.dict(os.environ, {"D": "from-env"}, clear=True):
                self.assertTrue(load_env_file(path))
                values = {k: os.environ.get(k) for k in "ABCD"}
        self.assertEqual(values, {"A": "1", "B": "two words", "C": "3", "D": "from-env"})

    def test_load_env_file_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertFalse(load_env_file(Path(tmp) / "missing.env"))


class StructurerTests(unittest.TestCase):
    def patch_client(self, **side_effects: Any) -> tuple[mock.MagicMock, mock.MagicMock]:
        factory, client = fake_http_client(**side_effects)
        patcher = mock.patch.object(structurer.httpx, "Client", factory)
        patcher.start()
        self.addCleanup(patcher.stop)
        return factory, client

    def test_graceful_fallback(self) -> None:
        self.patch_client(post=unreachable())
        raw_sample = "Projekt Starpi: Dezentrales KI Betriebssystem für WebGPU und Enterprise Brain."
        with self.assertLogs("core.structurer", "WARNING"):
            result = structure_raw_content(raw_sample, source_name="TestDocument")
        self.assertEqual(set(result), {"title", "summary", "tags", "markdown"})
        self.assertEqual(result["title"], "TestDocument")
        self.assertIn(raw_sample, result["markdown"])

    def test_parses_fenced_json_reply(self) -> None:
        reply = 'Hier:\n```json\n{"title": "T", "summary": "S", "tags": ["a", 1, null], "markdown": "# T"}\n```'
        self.patch_client(post=[response(200, {"choices": [{"message": {"content": reply}}]})])
        result = structure_raw_content("raw", source_name="src")
        self.assertEqual(result, {"title": "T", "summary": "S", "tags": ["a", "1"], "markdown": "# T"})

    def test_invalid_json_reply_falls_back(self) -> None:
        self.patch_client(post=[response(200, {"choices": [{"message": {"content": "not json"}}]})])
        with self.assertLogs("core.structurer", "WARNING"):
            result = structure_raw_content("raw text", source_name="src")
        self.assertEqual(result["title"], "src")
        self.assertEqual(result["tags"], ["auto-ingest", "raw"])

    def test_empty_input_skips_the_model(self) -> None:
        _, client = self.patch_client(post=unreachable())
        result = structure_raw_content("   ", source_name="")
        self.assertEqual(result["tags"], ["empty"])
        client.post.assert_not_called()

    def test_timeout_constant_is_applied(self) -> None:
        factory, _ = self.patch_client(post=unreachable())
        with mock.patch.object(structurer, "STRUCTURER_TIMEOUT_SECONDS", 0.5), self.assertLogs("core.structurer"):
            structure_raw_content("raw", source_name="src")
        self.assertEqual(factory.call_args.kwargs["timeout"].read, 0.5)


class SupabaseClientTests(unittest.TestCase):
    def test_is_live_requires_url_and_key(self) -> None:
        self.assertFalse(SupabaseBrainClient(url="https://x.supabase.co", key="").is_live)
        self.assertFalse(SupabaseBrainClient(url="", key="service-key").is_live)
        self.assertTrue(SupabaseBrainClient(url="https://x.supabase.co", key="service-key").is_live)

    def test_offline_store_and_search(self) -> None:
        client = SupabaseBrainClient(url="", key="")
        vector = hash_embedding("budget alpha")
        record = client.save_document(
            title="Doc",
            summary="S",
            tags=["t"],
            raw_content="secret raw text",
            sections=[{"heading": "## Budget", "markdown_content": "Budget alpha", "fallback_embedding": vector}],
        )
        self.assertEqual(record["storage"], "memory")
        matches = client.search_similar_sections(vector, threshold=0.5, limit=3)
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["document_title"], "Doc")
        self.assertAlmostEqual(matches[0]["similarity"], 1.0, places=4)
        docs = client.list_documents()
        self.assertEqual([d["title"] for d in docs], ["Doc"])
        self.assertNotIn("raw_content", docs[0])

    def patch_client(self, **side_effects: Any) -> mock.MagicMock:
        factory, client = fake_http_client(**side_effects)
        patcher = mock.patch("core.supabase_client.httpx.Client", factory)
        patcher.start()
        self.addCleanup(patcher.stop)
        return client

    def test_live_save_never_persists_fallback_vectors(self) -> None:
        http = self.patch_client(post=[response(201, [{"id": "doc-1", "title": "Doc"}]), response(201, None)])
        client = SupabaseBrainClient(url="https://x.supabase.co", key="service-key")
        with self.assertLogs("core.supabase_client", "INFO"):
            record = client.save_document(
                title="Doc",
                summary="S",
                tags=[],
                sections=[
                    {"heading": "a", "markdown_content": "A", "embedding": REAL_VECTOR},
                    {"heading": "b", "markdown_content": "B", "embedding": None, "fallback_embedding": [1.0] * 1536},
                    {"heading": "c", "markdown_content": "C", "embedding": []},
                ],
            )
        self.assertEqual(record["storage"], "supabase")
        sections_sent = http.post.call_args_list[1].kwargs["json"]
        self.assertEqual([s["embedding"] for s in sections_sent], [REAL_VECTOR, None, None])
        self.assertTrue(all("fallback_embedding" not in s for s in sections_sent))
        self.assertTrue(all(s["document_id"] == "doc-1" for s in sections_sent))

    def test_failed_section_insert_rolls_back_document(self) -> None:
        http = self.patch_client(
            post=[response(201, [{"id": "doc-1"}]), response(400, {"message": "bad"})],
            delete=[response(204, None, method="DELETE")],
        )
        client = SupabaseBrainClient(url="https://x.supabase.co", key="service-key")
        with self.assertLogs("core.supabase_client", "WARNING"):
            record = client.save_document(title="Doc", summary="", tags=[], sections=[{"markdown_content": "A"}])
        self.assertEqual(http.delete.call_args.kwargs["params"], {"id": "eq.doc-1"})
        self.assertEqual(record["storage"], "memory")


class IngestionPipelineTests(unittest.TestCase):
    def run_pipeline(self, embedding: tuple[list[float] | None, bool]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        structured = {"title": "T", "summary": "S", "tags": ["x"], "markdown": "# One\nA\n## Two\nB"}
        fake_db = mock.MagicMock()
        fake_db.save_document.return_value = {"id": "doc-1", "storage": "memory"}
        with (
            mock.patch("core.ingestion_pipeline.structure_raw_content", return_value=structured),
            mock.patch("core.ingestion_pipeline.get_embedding_with_source", return_value=embedding),
            mock.patch("core.ingestion_pipeline.db", fake_db),
        ):
            result = ingest_raw_information("raw", source_name="src")
        return result, fake_db.save_document.call_args.kwargs["sections"]

    def test_fallback_vectors_are_not_stored_as_embeddings(self) -> None:
        fallback = hash_embedding("x")
        with self.assertLogs("core.ingestion_pipeline", "WARNING"):
            result, sections = self.run_pipeline((fallback, False))
        self.assertEqual(len(sections), 2)
        self.assertTrue(all(s["embedding"] is None for s in sections))
        self.assertTrue(all(s["fallback_embedding"] == fallback for s in sections))
        self.assertEqual(result["embedded_sections_count"], 0)
        self.assertEqual(result["storage"], "memory")

    def test_real_vectors_are_stored(self) -> None:
        result, sections = self.run_pipeline((REAL_VECTOR, True))
        self.assertTrue(all(s["embedding"] == REAL_VECTOR for s in sections))
        self.assertTrue(all(s["fallback_embedding"] is None for s in sections))
        self.assertEqual(result["embedded_sections_count"], 2)
        self.assertEqual(result["document_id"], "doc-1")


class RagTests(unittest.TestCase):
    def test_live_search_is_skipped_without_real_embedding(self) -> None:
        fake_db = mock.MagicMock(is_live=True)
        with (
            mock.patch.object(rag, "db", fake_db),
            mock.patch.object(rag, "get_embedding_with_source", return_value=(hash_embedding("q"), False)),
            self.assertLogs("core.rag", "WARNING"),
        ):
            self.assertEqual(rag.retrieve_sections("q"), [])
        fake_db.search_similar_sections.assert_not_called()

    def test_offline_search_uses_fallback_vector(self) -> None:
        fake_db = mock.MagicMock(is_live=False)
        fake_db.search_similar_sections.return_value = [{"id": "s1"}]
        with (
            mock.patch.object(rag, "db", fake_db),
            mock.patch.object(rag, "get_embedding_with_source", return_value=(hash_embedding("q"), False)),
        ):
            self.assertEqual(rag.retrieve_sections("q"), [{"id": "s1"}])

    def test_unavailable_llm_returns_context_without_error_details(self) -> None:
        factory, _ = fake_http_client(post=httpx.ConnectError("refused by http://10.0.0.5:8000"))
        with (
            mock.patch.object(rag, "retrieve_sections", return_value=[]),
            mock.patch.object(rag, "_call_gemini_pool", return_value=""),
            mock.patch.object(rag, "_call_openrouter_pool", return_value=""),
            mock.patch.object(rag.httpx, "Client", factory),
            self.assertLogs("core.rag", "WARNING"),
        ):
            result = rag.query_brain("Frage?")
        self.assertEqual(result["error"], "llm_unavailable")
        self.assertNotIn("10.0.0.5", str(result))

    def test_gemini_key_is_sent_in_header_not_url(self) -> None:
        reply = {"candidates": [{"content": {"parts": [{"text": " Antwort "}]}}]}
        factory, client = fake_http_client(post=[response(200, reply)])
        with (
            mock.patch.object(rag, "config", BrainConfig(gemini_keys=["gem-secret"])),
            mock.patch.object(rag.httpx, "Client", factory),
        ):
            self.assertEqual(rag._call_gemini_pool("prompt"), "Antwort")
        url = client.post.call_args.args[0]
        self.assertNotIn("gem-secret", url)
        self.assertEqual(client.post.call_args.kwargs["headers"]["x-goog-api-key"], "gem-secret")


if __name__ == "__main__":
    unittest.main()
