"""PostgREST requests of the publisher: payloads, filters, limits and error handling."""

from __future__ import annotations

import json
import math
import unittest
from urllib.parse import parse_qs

import httpx

from publisher import supabase_service as svc
from publisher.supabase_service import SupabaseError, SupabaseService, section_payload

from .helpers import DIM, Recorder, json_response, unit_vector

URL = "https://project.supabase.test"
KEY = "service-role-test-key"


def service(handler) -> tuple[SupabaseService, Recorder]:
    recorder = Recorder(handler)
    return SupabaseService(URL + "/", KEY, transport=recorder.transport), recorder


def query(request: httpx.Request) -> dict[str, list[str]]:
    return parse_qs(request.url.query.decode(), keep_blank_values=True)


class SectionPayloadTests(unittest.TestCase):
    def test_only_valid_384_vectors_are_kept(self) -> None:
        cases = [
            (unit_vector(3), True),
            ([0.5] * 1536, False),
            ([0.5] * (DIM - 1), False),
            ([math.nan] + [0.0] * (DIM - 1), False),
            ([True] + [0.0] * (DIM - 1), False),
            ("[0.1, 0.2]", False),
            (None, False),
        ]
        for vector, kept in cases:
            with self.subTest(vector=str(vector)[:30]):
                payload = section_payload({"markdown_content": "x", "embedding_384": vector})
                self.assertEqual(payload["embedding_384"] is not None, kept)
                self.assertNotIn("embedding", payload)

    def test_fields_are_clipped_to_the_database_limits(self) -> None:
        payload = section_payload({"heading": "H" * 2000, "markdown_content": "M" * 300_000, "section_index": "4"})
        self.assertEqual(len(payload["heading"]), svc.MAX_HEADING_CHARS)
        self.assertEqual(len(payload["markdown_content"]), svc.MAX_SECTION_CHARS)
        self.assertEqual(payload["section_index"], 4)


class SupabaseServiceTests(unittest.TestCase):
    def test_not_configured_sends_nothing(self) -> None:
        recorder = Recorder(lambda _r: json_response(200, []))
        unconfigured = SupabaseService("", KEY, transport=recorder.transport)
        self.assertEqual(unconfigured.health_check(), {"connected": False, "status": "not_configured"})
        with self.assertRaises(SupabaseError):
            unconfigured.list_documents()
        self.assertEqual(recorder.requests, [])

    def test_ingest_sends_the_service_role_key_and_a_clipped_payload(self) -> None:
        client, recorder = service(lambda _r: json_response(200, "doc-1"))
        doc_id = client.ingest_document(
            title="T" * 600,
            summary="S" * 6000,
            tags=["  ", "x" * 300, *[f"t{i}" for i in range(80)]],
            source_type="markdown",
            source_name="n" * 700,
            raw_content="raw",
            sections=[
                {"section_index": 0, "heading": "A", "markdown_content": "a", "embedding_384": unit_vector(1)},
                {"section_index": 1, "heading": "B", "markdown_content": "b"},
            ],
        )
        self.assertEqual(doc_id, "doc-1")
        request = recorder.requests[0]
        self.assertEqual(request.method, "POST")
        self.assertEqual(str(request.url), f"{URL}/rest/v1/rpc/ingest_document_atomic")
        self.assertEqual(request.headers["apikey"], KEY)
        self.assertEqual(request.headers["authorization"], f"Bearer {KEY}")
        body = json.loads(request.content)
        self.assertEqual(len(body["doc_title"]), svc.MAX_TITLE_CHARS)
        self.assertEqual(len(body["doc_summary"]), svc.MAX_SUMMARY_CHARS)
        self.assertEqual(len(body["doc_source_name"]), svc.MAX_SOURCE_NAME_CHARS)
        self.assertEqual(len(body["doc_tags"]), svc.MAX_TAGS)
        self.assertEqual(len(body["doc_tags"][0]), svc.MAX_TAG_CHARS)
        self.assertEqual(body["sections_data"][0]["embedding_384"], unit_vector(1))
        self.assertIsNone(body["sections_data"][1]["embedding_384"])

    def test_ingest_needs_an_id_back(self) -> None:
        client, _ = service(lambda _r: json_response(200, {"id": "x"}))
        with self.assertRaises(SupabaseError):
            client.ingest_document(
                title="t", summary="", tags=[], source_type="text", source_name="t.txt", raw_content="r", sections=[]
            )

    def test_errors_carry_the_postgrest_code_but_never_the_key(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return json_response(404, {"code": "PGRST202", "message": "Could not find the function"})

        client, _ = service(handler)
        with self.assertRaises(SupabaseError) as caught:
            client.match_384(unit_vector(0))
        self.assertTrue(caught.exception.missing_migration)
        self.assertEqual(caught.exception.status, 404)
        self.assertIn("PGRST202", str(caught.exception))
        self.assertNotIn(KEY, str(caught.exception))

    def test_network_errors_are_described_without_url_or_key(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError(f"cannot reach {request.url} with {KEY}")

        client, _ = service(handler)
        with self.assertRaises(SupabaseError) as caught:
            client.list_documents()
        self.assertEqual(str(caught.exception), "request failed: ConnectError")
        self.assertNotIn(KEY, repr(client))

    def test_set_public_patches_one_document(self) -> None:
        client, recorder = service(lambda _r: json_response(200, [{"id": "doc-1"}]))
        client.set_public("doc-1")
        request = recorder.requests[0]
        self.assertEqual(request.method, "PATCH")
        self.assertEqual(query(request)["id"], ["eq.doc-1"])
        self.assertEqual(json.loads(request.content), {"is_public": True})
        self.assertEqual(request.headers["prefer"], "return=representation")
        missing, _ = service(lambda _r: json_response(200, []))
        with self.assertRaises(SupabaseError):
            missing.set_public("doc-2")

    def test_reads_stay_in_the_shared_library(self) -> None:
        client, recorder = service(lambda _r: json_response(200, []))
        client.list_documents(limit=7)
        client.sections_missing_384(limit=20, after="sec-9")
        listing, pending = (query(r) for r in recorder.requests)
        self.assertEqual(listing["or"], [svc.SHARED_ROWS])
        self.assertEqual(listing["limit"], ["7"])
        self.assertNotIn("raw_content", listing["select"][0])
        self.assertEqual(pending["embedding_384"], ["is.null"])
        self.assertEqual(pending["knowledge_documents.or"], [svc.SHARED_ROWS])
        self.assertIn("knowledge_documents!inner(title)", pending["select"][0])
        self.assertEqual(pending["id"], ["gt.sec-9"])
        self.assertEqual(pending["order"], ["id.asc"])

    def test_set_section_vector(self) -> None:
        client, recorder = service(lambda _r: httpx.Response(204))
        client.set_section_vector("sec-1", unit_vector(5))
        request = recorder.requests[0]
        self.assertEqual((request.method, query(request)["id"]), ("PATCH", ["eq.sec-1"]))
        self.assertEqual(json.loads(request.content), {"embedding_384": unit_vector(5)})
        with self.assertRaises(ValueError):
            client.set_section_vector("sec-1", [0.1] * 1536)
        self.assertEqual(len(recorder.requests), 1)

    def test_match_384_keeps_only_shared_documents(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/rpc/match_knowledge_vector_384"):
                return json_response(
                    200,
                    [
                        {"document_id": "pub", "heading": "A", "similarity": 0.9},
                        {"document_id": "private", "heading": "B", "similarity": 0.8},
                        {"document_id": "pub", "heading": "C", "similarity": 0.7},
                    ],
                )
            return json_response(200, [{"id": "pub"}])

        client, recorder = service(handler)
        matches = client.match_384(unit_vector(0), count=3)
        self.assertEqual([m["heading"] for m in matches], ["A", "C"])
        rpc, visible = recorder.requests
        self.assertEqual(json.loads(rpc.content)["match_count"], 3)
        self.assertEqual(len(json.loads(rpc.content)["query_embedding"]), DIM)
        self.assertEqual(query(visible)["id"], ["in.(private,pub)"])
        self.assertEqual(query(visible)["or"], [svc.SHARED_ROWS])

    def test_health_reports_a_missing_embedding_384_column(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if "embedding_384" in request.url.query.decode():
                return json_response(400, {"code": "42703", "message": "column does not exist"})
            return json_response(200, [])

        client, _ = service(handler)
        self.assertEqual(client.health_check(), {"connected": True, "status": "ok", "embedding_384": False})
        healthy, _ = service(lambda _r: json_response(200, []))
        self.assertEqual(healthy.health_check(), {"connected": True, "status": "ok", "embedding_384": True})
        denied, _ = service(lambda _r: json_response(401, {"message": "Invalid API key"}))
        self.assertEqual(denied.health_check()["status"], "error")


if __name__ == "__main__":
    unittest.main()
