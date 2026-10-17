"""Environment and .env handling."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from publisher.config import DEFAULT_MODEL_DIR, PublisherConfig, load_env_file, parse_env_line


class ParseEnvLineTests(unittest.TestCase):
    def test_lines(self) -> None:
        cases = {
            "KEY=value": ("KEY", "value"),
            "export KEY=value": ("KEY", "value"),
            "KEY = spaced ": ("KEY", "spaced"),
            "KEY='quoted # kept' # comment": ("KEY", "quoted # kept"),
            'KEY="double" trailing': ("KEY", "double"),
            "KEY=value # comment": ("KEY", "value"),
            "KEY=a#b": ("KEY", "a#b"),
            "KEY=": ("KEY", ""),
        }
        for line, expected in cases.items():
            with self.subTest(line=line):
                self.assertEqual(parse_env_line(line), expected)

    def test_ignored_lines(self) -> None:
        for line in ("", "   ", "# comment", "no equals sign", "=value"):
            with self.subTest(line=line):
                self.assertIsNone(parse_env_line(line))


class LoadEnvFileTests(unittest.TestCase):
    def write(self, text: str) -> Path:
        handle = tempfile.NamedTemporaryFile("w", suffix=".env", delete=False, encoding="utf-8")
        self.addCleanup(os.unlink, handle.name)
        with handle:
            handle.write(text)
        return Path(handle.name)

    def test_file_values_never_override_the_environment_and_the_last_assignment_wins(self) -> None:
        path = self.write("﻿PUB_TEST_A=first\nexport PUB_TEST_A=second\nPUB_TEST_B='kept'\n")
        with mock.patch.dict(os.environ, {"PUB_TEST_B": "from-env"}, clear=False):
            self.assertTrue(load_env_file(path))
            self.assertEqual(os.environ["PUB_TEST_A"], "second")
            self.assertEqual(os.environ["PUB_TEST_B"], "from-env")

    def test_missing_file(self) -> None:
        self.assertFalse(load_env_file(Path(tempfile.gettempdir()) / "publisher-missing.env"))

    def test_unreadable_file_is_logged_without_its_path(self) -> None:
        path = self.write("")
        path.write_bytes(b"\xff\xfe\x00broken")
        with self.assertLogs("publisher.config", "WARNING") as logs:
            self.assertFalse(load_env_file(path))
        self.assertNotIn(str(path.parent), "\n".join(logs.output))


class PublisherConfigTests(unittest.TestCase):
    def test_defaults(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            config = PublisherConfig()
        self.assertEqual(config.supabase_url, "")
        self.assertFalse(config.supabase_configured)
        self.assertEqual(config.model_dir, DEFAULT_MODEL_DIR)
        self.assertEqual(config.llm_api_key, "EMPTY")

    def test_environment_overrides(self) -> None:
        env = {
            "SUPABASE_URL": " https://x.supabase.co ",
            "SUPABASE_SERVICE_ROLE_KEY": "service-key",
            "PUBLISHER_MODEL_DIR": "~/models/e5",
            "LLM_MODEL": "some-model",
        }
        with mock.patch.dict(os.environ, env, clear=True):
            config = PublisherConfig()
        self.assertEqual(config.supabase_url, "https://x.supabase.co")
        self.assertTrue(config.supabase_configured)
        self.assertEqual(config.model_dir, Path("~/models/e5").expanduser())
        self.assertEqual(config.llm_model, "some-model")

    def test_anon_key_is_never_used(self) -> None:
        with mock.patch.dict(
            os.environ, {"SUPABASE_URL": "https://x.supabase.co", "SUPABASE_ANON_KEY": "anon"}, clear=True
        ):
            config = PublisherConfig()
        self.assertEqual(config.supabase_key, "")
        self.assertFalse(config.supabase_configured)

    def test_repr_hides_secrets(self) -> None:
        env = {"SUPABASE_SERVICE_ROLE_KEY": "service-secret", "LLM_API_KEY": "llm-secret"}
        with mock.patch.dict(os.environ, env, clear=True):
            text = repr(PublisherConfig())
        self.assertNotIn("service-secret", text)
        self.assertNotIn("llm-secret", text)


if __name__ == "__main__":
    unittest.main()
