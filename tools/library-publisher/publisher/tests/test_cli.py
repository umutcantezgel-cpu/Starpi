"""The publisher's commands against fake Supabase responses and a fake embedder."""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import httpx

from publisher.cli_supabase import Context, main
from publisher.config import PublisherConfig
from publisher.embedder import EmbedderError
from publisher.supabase_service import SupabaseService

from .helpers import Recorder, json_response


class CliTests(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.dir = Path(self._dir.name)
        self.embedder = mock.MagicMock(name="embedder")
        self.embedder.embed_passages.side_effect = lambda texts: [[0.0] * 383 + [1.0] for _ in texts]
        self.embedder.embed_query.return_value = [1.0] + [0.0] * 383
        self.handler = lambda request: json_response(200, [])
        self.recorder = Recorder(lambda request: self.handler(request))

    def run_cli(self, *argv: str, configured: bool = True, embedder_error: str | None = None) -> tuple[int, str, str]:
        config = PublisherConfig(
            supabase_url="https://project.supabase.test" if configured else "",
            supabase_key="service-role-test-key" if configured else "",
            model_dir=self.dir / "model",
        )

        def embedder_factory(_model_dir: Path):
            if embedder_error:
                raise EmbedderError(embedder_error)
            return self.embedder

        out, err = io.StringIO(), io.StringIO()
        context = Context(
            config,
            out=out,
            err=err,
            service_factory=lambda cfg: SupabaseService(
                cfg.supabase_url, cfg.supabase_key, transport=self.recorder.transport
            ),
            embedder_factory=embedder_factory,
        )
        code = main(list(argv), context=context)
        return code, out.getvalue(), err.getvalue()

    def write(self, name: str, text: str) -> Path:
        path = self.dir / name
        path.write_text(text, encoding="utf-8")
        return path

    def test_publish_dry_run_embeds_but_writes_nothing(self) -> None:
        path = self.write("guide.md", "# Guide\nFirst\n## Part\nSecond")
        code, out, _ = self.run_cli("publish", str(path), "--dry-run", configured=False)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {"file": "guide.md", "title": "Guide", "sections": 2, "vectors": 2})
        self.assertEqual(self.recorder.requests, [])

    def test_publish_public_ingests_then_publishes(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/rpc/ingest_document_atomic"):
                return json_response(200, "doc-1")
            return json_response(200, [{"id": "doc-1"}])

        self.handler = handler
        path = self.write("guide.md", "# Guide\nText")
        code, out, err = self.run_cli("publish", str(path), "--public", "--tag", "docs")
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["id"], "doc-1")
        self.assertTrue(json.loads(out)["public"])
        ingest, publish = self.recorder.requests
        body = json.loads(ingest.content)
        self.assertEqual(body["doc_tags"], ["docs"])
        self.assertEqual(body["doc_source_name"], "guide.md")
        self.assertEqual(len(body["sections_data"][0]["embedding_384"]), 384)
        self.assertEqual((publish.method, json.loads(publish.content)), ("PATCH", {"is_public": True}))
        self.assertNotIn("Documents are private", err)

    def test_publish_private_by_default_and_reports_each_failed_file(self) -> None:
        self.handler = lambda request: json_response(200, "doc-1")
        good = self.write("good.md", "# Good\nText")
        code, out, err = self.run_cli("publish", str(self.dir / "missing.md"), str(good))
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out)["public"], False)
        self.assertIn("missing.md", err)
        self.assertIn("Documents are private until published", err)
        self.assertEqual(len(self.recorder.requests), 1)

    def test_publish_explains_a_missing_migration(self) -> None:
        self.handler = lambda request: json_response(400, {"code": "PGRST204", "message": "embedding_384 not found"})
        code, _, err = self.run_cli("publish", str(self.write("a.md", "# A\nText")))
        self.assertEqual(code, 1)
        self.assertIn("20261101000000_embedding_384.sql", err)

    def test_publish_needs_supabase_and_a_model(self) -> None:
        path = self.write("a.md", "# A\nText")
        code, _, err = self.run_cli("publish", str(path), configured=False)
        self.assertEqual(code, 1)
        self.assertIn("SUPABASE_URL", err)
        code, _, err = self.run_cli("publish", str(path), embedder_error="tokenizer.json is missing")
        self.assertEqual(code, 1)
        self.assertIn("--no-vectors", err)
        self.handler = lambda request: json_response(200, "doc-1")
        code, out, _ = self.run_cli("publish", str(path), "--no-vectors", embedder_error="unused")
        self.assertEqual((code, json.loads(out)["vectors"]), (0, 0))

    def test_backfill_pages_through_missing_vectors(self) -> None:
        pages = [
            [
                {
                    "id": f"s{i}",
                    "heading": "H",
                    "markdown_content": f"text {i}",
                    "knowledge_documents": {"title": "Doc"},
                }
                for i in range(2)
            ],
            [{"id": "s2", "heading": "H", "markdown_content": "text 2", "knowledge_documents": None}],
            [],
        ]

        def handler(request: httpx.Request) -> httpx.Response:
            if request.method == "GET":
                return json_response(200, pages.pop(0))
            return httpx.Response(204)

        self.handler = handler
        code, out, _ = self.run_cli("backfill")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {"embedded": 3, "failed": 0, "dry_run": False})
        gets = [r for r in self.recorder.requests if r.method == "GET"]
        patches = [r for r in self.recorder.requests if r.method == "PATCH"]
        self.assertEqual(len(gets), 3)
        self.assertIn("id=gt.s1", gets[1].url.query.decode())
        self.assertEqual([r.url.query.decode() for r in patches], ["id=eq.s0", "id=eq.s1", "id=eq.s2"])
        self.assertEqual(self.embedder.embed_passages.call_args_list[0].args[0], ["Doc\nH\ntext 0"])

    def test_backfill_dry_run_and_limit(self) -> None:
        rows = [{"id": f"s{i}", "heading": "", "markdown_content": "t"} for i in range(5)]
        self.handler = lambda request: json_response(200, rows[:2])
        code, out, _ = self.run_cli("backfill", "--dry-run", "--limit", "2")
        self.assertEqual((code, json.loads(out)["embedded"]), (0, 2))
        self.assertTrue(all(r.method == "GET" for r in self.recorder.requests))
        self.assertIn("limit=2", self.recorder.requests[0].url.query.decode())

    def test_test_query_prints_shared_matches(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/rpc/match_knowledge_vector_384"):
                return json_response(
                    200, [{"document_id": "d", "document_title": "Doc", "heading": "H", "similarity": 0.91234}]
                )
            return json_response(200, [{"id": "d"}])

        self.handler = handler
        code, out, err = self.run_cli("test-query", "When", "does", "it", "open?")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {"similarity": 0.9123, "document": "Doc", "heading": "H"})
        self.embedder.embed_query.assert_called_once_with("When does it open?")
        self.assertIn("1 matches", err)

    def test_health_exit_codes(self) -> None:
        self.assertEqual(self.run_cli("health")[0], 0)
        self.assertEqual(self.run_cli("health", configured=False)[0], 1)
        self.handler = lambda request: (
            json_response(400, {"code": "42703"})
            if "embedding_384" in request.url.query.decode()
            else json_response(200, [])
        )
        code, _, err = self.run_cli("health")
        self.assertEqual(code, 1)
        self.assertIn("20261101000000_embedding_384.sql", err)

    def test_list_prints_one_line_per_document(self) -> None:
        self.handler = lambda request: json_response(
            200, [{"id": "d1", "title": "A", "is_public": True, "total_sections": 2}]
        )
        code, out, _ = self.run_cli("list", "--limit", "5")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {"id": "d1", "title": "A", "is_public": True, "total_sections": 2})

    def test_fetch_model_uses_the_configured_directory(self) -> None:
        with mock.patch("publisher.cli_supabase.fetch_model", return_value=[("tokenizer.json", "kept")]) as fetch:
            code, out, _ = self.run_cli("--model-dir", str(self.dir / "elsewhere"), "fetch-model")
        self.assertEqual(code, 0)
        self.assertEqual(fetch.call_args.args[0], self.dir / "elsewhere")
        self.assertEqual(json.loads(out), {"file": "tokenizer.json", "state": "kept"})

    def test_invalid_arguments_exit_with_status_2(self) -> None:
        with mock.patch("sys.stderr", io.StringIO()), self.assertRaises(SystemExit) as caught:
            self.run_cli("publish")
        self.assertEqual(caught.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
