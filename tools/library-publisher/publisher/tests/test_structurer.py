"""Optional structuring through a Chat Completions model."""

from __future__ import annotations

import json
import unittest

import httpx

from publisher.config import PublisherConfig
from publisher.structurer import MAX_TAGS, STRUCTURING_PROMPT, structure_raw_content

from .helpers import Recorder, json_response


def reply(content: str) -> httpx.Response:
    return json_response(200, {"choices": [{"message": {"content": content}}]})


def config(api_key: str = "EMPTY") -> PublisherConfig:
    return PublisherConfig(llm_base_url="http://llm.test/v1/", llm_api_key=api_key, llm_model="test-model")


class StructurerTests(unittest.TestCase):
    def test_fenced_json_reply_is_parsed_and_cleaned(self) -> None:
        reply_json = '{"title": " T ", "summary": "S", "tags": ["a", 1, true, null, " "], "markdown": "# T\\nBody"}'
        content = f"Here you go:\n```json\n{reply_json}\n```"
        recorder = Recorder(lambda _request: reply(content))
        result = structure_raw_content("raw", "notes.md", config(), transport=recorder.transport)
        self.assertEqual(result, {"title": "T", "summary": "S", "tags": ["a", "1"], "markdown": "# T\nBody"})
        request = recorder.requests[0]
        self.assertEqual(str(request.url), "http://llm.test/v1/chat/completions")
        body = json.loads(request.content)
        self.assertEqual(body["model"], "test-model")
        self.assertEqual(body["messages"][0]["content"], STRUCTURING_PROMPT)
        self.assertIn("raw", body["messages"][1]["content"])
        self.assertNotIn("authorization", request.headers)

    def test_api_key_is_sent_as_bearer_token(self) -> None:
        recorder = Recorder(lambda _request: reply('{"markdown": "# X"}'))
        result = structure_raw_content("raw", "x.md", config("llm-key"), transport=recorder.transport)
        self.assertEqual(recorder.requests[0].headers["authorization"], "Bearer llm-key")
        self.assertEqual(result and result["title"], "x.md")

    def test_tags_are_capped(self) -> None:
        tags = json.dumps([f"t{i}" for i in range(40)])
        recorder = Recorder(lambda _request: reply(f'{{"markdown": "# X", "tags": {tags}}}'))
        result = structure_raw_content("raw", "x.md", config(), transport=recorder.transport)
        self.assertEqual(len(result["tags"]) if result else 0, MAX_TAGS)

    def test_unusable_replies_return_none(self) -> None:
        for content in ("not json", '["a list"]', '{"title": "no markdown"}'):
            with self.subTest(content=content):
                recorder = Recorder(lambda _request, content=content: reply(content))
                with self.assertLogs("publisher.structurer", "WARNING"):
                    self.assertIsNone(structure_raw_content("raw", "x.md", config(), transport=recorder.transport))

    def test_http_errors_return_none_without_details(self) -> None:
        def fail(_request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused to http://llm.test/v1?key=secret")

        for transport in (Recorder(fail).transport, Recorder(lambda _r: json_response(500, {})).transport):
            with self.subTest(transport=transport), self.assertLogs("publisher.structurer", "WARNING") as logs:
                self.assertIsNone(structure_raw_content("raw", "x.md", config(), transport=transport))
            self.assertNotIn("secret", "\n".join(logs.output))

    def test_blank_text_skips_the_model(self) -> None:
        recorder = Recorder(lambda _request: reply("{}"))
        self.assertIsNone(structure_raw_content("  \n", "x.md", config(), transport=recorder.transport))
        self.assertEqual(recorder.requests, [])


if __name__ == "__main__":
    unittest.main()
