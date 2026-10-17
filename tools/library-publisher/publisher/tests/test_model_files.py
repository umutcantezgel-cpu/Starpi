"""Pinned model files: download, size and SHA-256 checks."""

from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

import httpx

from publisher.model_files import (
    MODEL_REPO,
    MODEL_REVISION,
    ONNX_FILE,
    PINNED_FILES,
    TOKENIZER_FILE,
    ModelFileError,
    PinnedFile,
    fetch_model,
    verify_model_dir,
)

from .helpers import Recorder

CONTENT = {"tokenizer.json": b'{"model": "tiny"}', "onnx/model_quantized.onnx": b"\x08\x01onnx-bytes" * 100}


def pins(content: dict[str, bytes] = CONTENT) -> tuple[PinnedFile, ...]:
    return tuple(PinnedFile(path, hashlib.sha256(data).hexdigest(), len(data)) for path, data in content.items())


def serve(content: dict[str, bytes]) -> Recorder:
    prefix = f"/{MODEL_REPO}/resolve/{MODEL_REVISION}/"

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.url.host == "mirror.test":
            # The hub answers with a redirect to its content host.
            return httpx.Response(302, headers={"location": f"https://cdn.test{path}"})
        if path.startswith(prefix) and path[len(prefix) :] in content:
            return httpx.Response(200, content=content[path[len(prefix) :]])
        return httpx.Response(404)

    return Recorder(handler)


class ModelFileTests(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.dir = Path(self._dir.name)

    def test_the_pins_name_the_q8_export_and_the_tokenizer(self) -> None:
        self.assertEqual(MODEL_REPO, "Xenova/multilingual-e5-small")
        self.assertEqual({p.path for p in PINNED_FILES}, {TOKENIZER_FILE, ONNX_FILE})
        self.assertEqual(ONNX_FILE, "onnx/model_quantized.onnx")
        self.assertTrue(all(len(p.sha256) == 64 and p.size > 0 for p in PINNED_FILES))

    def test_downloads_verified_files_and_keeps_them_on_the_next_run(self) -> None:
        server = serve(CONTENT)
        first = fetch_model(self.dir, base_url="https://hub.test", files=pins(), transport=server.transport)
        self.assertEqual(first, [(path, "downloaded") for path in CONTENT])
        self.assertEqual((self.dir / ONNX_FILE).read_bytes(), CONTENT[ONNX_FILE])
        self.assertEqual(verify_model_dir(self.dir, pins()), [])
        self.assertEqual(
            str(server.requests[0].url), f"https://hub.test/{MODEL_REPO}/resolve/{MODEL_REVISION}/tokenizer.json"
        )
        second = fetch_model(self.dir, base_url="https://hub.test", files=pins(), transport=server.transport)
        self.assertEqual(second, [(path, "kept") for path in CONTENT])
        self.assertEqual(len(server.requests), 2)

    def test_redirects_are_followed(self) -> None:
        server = serve(CONTENT)
        fetch_model(self.dir, base_url="https://mirror.test", files=pins(), transport=server.transport)
        self.assertEqual(verify_model_dir(self.dir, pins()), [])
        self.assertEqual([request.url.host for request in server.requests], ["mirror.test", "cdn.test"] * 2)

    def test_a_tampered_download_never_replaces_or_leaves_a_file(self) -> None:
        tampered = dict(CONTENT, **{ONNX_FILE: b"\x08\x01evil-bytes" * 100})
        with self.assertRaises(ModelFileError) as caught:
            fetch_model(self.dir, base_url="https://hub.test", files=pins(), transport=serve(tampered).transport)
        self.assertIn("SHA-256", str(caught.exception))
        self.assertFalse((self.dir / ONNX_FILE).exists())
        self.assertEqual(list((self.dir / "onnx").iterdir()), [])

    def test_oversized_and_short_downloads_are_refused(self) -> None:
        for data in (CONTENT[ONNX_FILE] + b"x", CONTENT[ONNX_FILE][:-1]):
            with self.subTest(size=len(data)), self.assertRaises(ModelFileError):
                served = dict(CONTENT, **{ONNX_FILE: data})
                fetch_model(self.dir, base_url="https://hub.test", files=pins(), transport=serve(served).transport)

    def test_http_errors_name_the_file_only(self) -> None:
        with self.assertRaises(ModelFileError) as caught:
            fetch_model(self.dir, base_url="https://hub.test", files=pins(), transport=serve({}).transport)
        self.assertEqual(str(caught.exception), "downloading tokenizer.json failed: HTTPStatusError (status 404)")

    def test_verify_reports_missing_resized_and_changed_files(self) -> None:
        (self.dir / "onnx").mkdir()
        (self.dir / TOKENIZER_FILE).write_bytes(b"short")
        (self.dir / ONNX_FILE).write_bytes(b"\x08\x01ONNX-BYTES" * 100)
        problems = verify_model_dir(self.dir, pins())
        self.assertEqual(len(problems), 2)
        self.assertIn("bytes, expected", problems[0])
        self.assertIn("SHA-256", problems[1])
        self.assertEqual(verify_model_dir(self.dir / "nowhere", pins()), [f"{p} is missing" for p in CONTENT])


if __name__ == "__main__":
    unittest.main()
