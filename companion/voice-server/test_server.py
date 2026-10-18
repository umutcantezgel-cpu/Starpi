# SPDX-License-Identifier: MIT
"""Tests of the Starpi local voice server with a fake recognizer and a fake Piper command line, so
no model is needed. Run: python3 -I -m unittest discover -s companion/voice-server -v

The test against real models (faster-whisper and Piper installed, a model and a voice in place)
runs only when STARPI_VOICE_MODELS names the voice server home with whisper/ and voices/.
"""

from __future__ import annotations

import http.client
import io
import json
import logging
import os
import sys
import tempfile
import threading
import time
import unittest
import wave
from pathlib import Path
from typing import Any

import server as vs

ALLOWED_VOICE = "en_US-ljspeech-medium"  # on allowlist.json
UNLISTED_VOICE = "en_US-lessac-medium"  # installed in the fixtures, not on the allowlist
APP_ORIGIN = "https://www.starpi.app"
SELF_HOST = "https://chat.example.org"

FAKE_PIPER = r"""
import json, sys, time
from pathlib import Path
argv = sys.argv[1:]
text = sys.stdin.buffer.read().decode("utf-8")
log = Path(__file__).with_suffix(".log")
log.write_text(json.dumps({"argv": argv, "text": text, "env": sorted(__import__("os").environ)}), encoding="utf-8")
if "fail" in text:
    sys.exit(3)
if "slow" in text:
    time.sleep(10)
if "silence" in text:
    sys.exit(0)
if "flood" in text:
    sys.stdout.buffer.write(b"\0" * (4 * 1024 * 1024))
    sys.exit(0)
sys.stdout.buffer.write(b"\x01\x00" * (len(text.strip()) * 100))
"""


def make_wav(seconds: float = 0.25, rate: int = 16000, channels: int = 1) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(b"\0\0" * channels * int(seconds * rate))
    return out.getvalue()


def form(
    fields: list[tuple[str, bytes, str | None, str | None]], boundary: str = "starpi-test-boundary"
) -> tuple[str, bytes]:
    """A multipart/form-data body: (name, data, filename, content type) per part."""
    chunks = []
    for name, data, filename, content_type in fields:
        disposition = f'form-data; name="{name}"' + (f'; filename="{filename}"' if filename else "")
        head = f"--{boundary}\r\nContent-Disposition: {disposition}\r\n"
        if content_type:
            head += f"Content-Type: {content_type}\r\n"
        chunks.append(head.encode() + b"\r\n" + data + b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return f"multipart/form-data; boundary={boundary}", b"".join(chunks)


def audio_form(**extra: str) -> tuple[str, bytes]:
    fields: list[tuple[str, bytes, str | None, str | None]] = [
        ("file", make_wav(), "speech.wav", "audio/wav"),
        ("model", b"whisper", None, None),
    ]
    fields += [(k, v.encode("utf-8"), None, None) for k, v in extra.items()]
    return form(fields)


class FakeRecognizer:
    def __init__(self, text: str = "a simulated transcript") -> None:
        self.name = "fake-whisper"
        self.text = text
        self.calls: list[tuple[str | None, vs.PromptPlan]] = []
        self.hold: threading.Event | None = None
        self.entered = threading.Event()

    @property
    def ready(self) -> bool:
        return True

    @property
    def counter(self) -> vs.TokenCounter | None:
        return lambda text: len(text.split())

    def transcribe(self, audio: bytes, language: str | None, plan: vs.PromptPlan) -> str:
        self.calls.append((language, plan))
        self.entered.set()
        if self.hold is not None:
            self.hold.wait(5)
        if language == "xx":
            raise ValueError("unknown language")
        return self.text


def write_voice(folder: Path, vid: str, config: Any) -> None:
    (folder / f"{vid}.onnx").write_bytes(b"onnx")
    (folder / f"{vid}.onnx.json").write_text(
        config if isinstance(config, str) else json.dumps(config), encoding="utf-8"
    )


class ServerCase(unittest.TestCase):
    """A server on an ephemeral port with the fakes; one per test."""

    origins = frozenset({APP_ORIGIN, SELF_HOST})

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.voices = root / "voices"
        self.voices.mkdir()
        write_voice(self.voices, ALLOWED_VOICE, {"audio": {"sample_rate": 22050}, "inference": {"length_scale": 1.0}})
        write_voice(self.voices, UNLISTED_VOICE, {"audio": {"sample_rate": 22050}})
        write_voice(self.voices, "de_DE-mls-medium", {"audio": {}})  # no sample rate: not installed
        write_voice(self.voices, "it_IT-serena-medium", "{not json")  # unreadable: not installed
        self.piper = root / "fake_piper.py"
        self.piper.write_text(FAKE_PIPER, encoding="utf-8")
        self.recognizer = FakeRecognizer()
        self.speaker = vs.PiperSpeaker(self.voices, [sys.executable, "-I", str(self.piper)], timeout_s=2.0)
        self.settings = vs.ServerSettings(
            port=0, origins=self.origins, allowlist=vs.load_allowlist(vs.DEFAULT_ALLOWLIST)
        )
        self.server = vs.VoiceServer(("127.0.0.1", 0), self.settings, self.recognizer, self.speaker)
        self.settings.port = self.server.port
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)
        self.tmp.cleanup()

    def request(
        self, method: str, path: str, body: bytes | None = None, headers: dict[str, str] | None = None
    ) -> tuple[int, dict[str, str], bytes]:
        conn = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=10)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            res = conn.getresponse()
            return res.status, {k.lower(): v for k, v in res.getheaders()}, res.read()
        finally:
            conn.close()

    def post_json(
        self, path: str, value: Any, headers: dict[str, str] | None = None
    ) -> tuple[int, dict[str, str], bytes]:
        body = value if isinstance(value, bytes) else json.dumps(value).encode("utf-8")
        return self.request("POST", path, body, {"Content-Type": "application/json", **(headers or {})})

    def error_code(self, body: bytes) -> str:
        return json.loads(body)["error"]["code"]

    def piper_log(self) -> dict[str, Any]:
        return json.loads(self.piper.with_suffix(".log").read_text(encoding="utf-8"))


class RoutesTest(ServerCase):
    def test_health_reports_both_engines(self) -> None:
        status, headers, body = self.request("GET", "/health")
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["stt"], {"ready": True, "model": "fake-whisper"})
        self.assertEqual(data["tts"], {"ready": True, "voices": 1})
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertTrue(headers["server"].startswith("starpi-voice/"))

    def test_models_lists_recognizer_and_piper(self) -> None:
        status, _, body = self.request("GET", "/v1/models")
        self.assertEqual(status, 200)
        self.assertEqual([m["id"] for m in json.loads(body)["data"]], ["fake-whisper", "piper"])

    def test_voices_are_installed_and_allowlisted(self) -> None:
        status, _, body = self.request("GET", "/v1/audio/voices")
        self.assertEqual(status, 200)
        voices = json.loads(body)["voices"]
        self.assertEqual([v["id"] for v in voices], [ALLOWED_VOICE])
        self.assertEqual(voices[0]["language"], "en-US")
        self.assertEqual(voices[0]["license"], "LicenseRef-public-domain")

    def test_unknown_route_and_method(self) -> None:
        status, _, body = self.request("GET", "/v1/audio/nothing")
        self.assertEqual((status, self.error_code(body)), (404, "not_found"))
        status, headers, body = self.request("DELETE", "/v1/audio/voices")
        self.assertEqual((status, self.error_code(body)), (405, "method_not_allowed"))
        self.assertEqual(headers["allow"], "GET, OPTIONS")

    def test_wrong_host_is_refused(self) -> None:
        status, _, body = self.request("GET", "/health", headers={"Host": f"rebound.example:{self.server.port}"})
        self.assertEqual((status, self.error_code(body)), (421, "wrong_host"))
        status, _, _ = self.request("GET", "/health", headers={"Host": f"localhost:{self.server.port}"})
        self.assertEqual(status, 200)

    def test_bodies_need_a_content_length(self) -> None:
        conn = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=10)
        try:
            conn.putrequest("POST", "/v1/audio/speech")
            conn.putheader("Content-Type", "application/json")
            conn.endheaders()
            res = conn.getresponse()
            self.assertEqual((res.status, self.error_code(res.read())), (411, "length_required"))
        finally:
            conn.close()
        status, _, body = self.request(
            "POST", "/v1/audio/speech", b"", {"Content-Type": "application/json", "Transfer-Encoding": "chunked"}
        )
        self.assertEqual((status, self.error_code(body)), (501, "transfer_encoding_unsupported"))
        status, _, body = self.request("GET", "/health", b"x", {"Content-Length": "1"})
        self.assertEqual((status, self.error_code(body)), (400, "unexpected_body"))

    def test_nothing_of_the_content_is_logged(self) -> None:
        content_type, body = audio_form(glossary="confidential-term-one\nconfidential-term-two")
        with self.assertLogs("starpi-voice", level="DEBUG") as logs:
            self.request("POST", "/v1/audio/transcriptions", body, {"Content-Type": content_type})
            self.post_json("/v1/audio/speech", {"input": "a private sentence", "voice": ALLOWED_VOICE})
        joined = "\n".join(logs.output)
        for secret in ("confidential-term", "private sentence", "simulated transcript"):
            self.assertNotIn(secret, joined)
        self.assertIn("POST /v1/audio/speech 200", joined)


class TranscriptionTest(ServerCase):
    def transcribe(self, **extra: str) -> tuple[int, dict[str, str], bytes]:
        content_type, body = audio_form(**extra)
        return self.request("POST", "/v1/audio/transcriptions", body, {"Content-Type": content_type})

    def test_transcript_as_json(self) -> None:
        status, headers, body = self.transcribe(language="en", response_format="json")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"text": "a simulated transcript"})
        self.assertTrue(headers["content-type"].startswith("application/json"))
        self.assertEqual(self.recognizer.calls[0][0], "en")

    def test_transcript_as_text_and_region_codes(self) -> None:
        status, headers, body = self.transcribe(language="de-AT", response_format="text")
        self.assertEqual((status, body), (200, b"a simulated transcript"))
        self.assertTrue(headers["content-type"].startswith("text/plain"))
        self.assertEqual(self.recognizer.calls[0][0], "de")

    def test_glossary_terms_become_hotwords(self) -> None:
        # The app sends the glossary twice: as the prompt (comma list) and as the glossary field.
        status, _, _ = self.transcribe(
            prompt="Kubernetes, pnpm, focaccia, notes from the stand-up", glossary="Kubernetes\npnpm\nfocaccia"
        )
        self.assertEqual(status, 200)
        plan = self.recognizer.calls[0][1]
        self.assertEqual(plan.hotwords, "Kubernetes, pnpm, focaccia")
        self.assertEqual(plan.initial_prompt, "notes from the stand-up")

    def test_without_hints_nothing_is_sent(self) -> None:
        self.transcribe()
        self.assertEqual(self.recognizer.calls[0], (None, vs.PromptPlan(None, None)))

    def test_form_refusals(self) -> None:
        cases = [
            (form([("model", b"whisper", None, None)]), 400, "missing_field"),
            (form([("file", b"RIFF....WAVEfmt but not really", "a.wav", "audio/wav")]), 400, "invalid_audio"),
            (form([("file", b"ID3" + b"\0" * 64, "a.mp3", "audio/mpeg")]), 400, "invalid_audio"),
            (form([("file", make_wav(rate=96000), "a.wav", None)]), 400, "invalid_audio"),
            (
                form(
                    [
                        ("file", make_wav(), "a.wav", None),
                        ("language", b"en", None, None),
                        ("language", b"de", None, None),
                    ]
                ),
                400,
                "duplicate_field",
            ),
            (
                form([("file", make_wav(), "a.wav", None), ("inner", b"--x--", None, "multipart/mixed; boundary=x")]),
                400,
                "invalid_form",
            ),
            (form([("file", make_wav(), "a.wav", None), ("prompt", b"a\x00b", None, None)]), 400, "invalid_text"),
            (form([("file", make_wav(), "a.wav", None), ("prompt", b"\xff\xfe", None, None)]), 400, "invalid_text"),
            (
                form([("file", make_wav(), "a.wav", None), ("glossary", ("x" * 601).encode(), None, None)]),
                400,
                "too_long",
            ),
            (
                form([("file", make_wav(), "a.wav", None), ("language", b"english!", None, None)]),
                400,
                "unsupported_language",
            ),
            (
                form([("file", make_wav(), "a.wav", None), ("response_format", b"srt", None, None)]),
                400,
                "unsupported_format",
            ),
            (
                form([("file", make_wav(), "a.wav", None)] + [(f"extra{i}", b"1", None, None) for i in range(20)]),
                400,
                "invalid_form",
            ),
        ]
        for (content_type, body), status, code in cases:
            with self.subTest(code=code):
                got, _, answer = self.request("POST", "/v1/audio/transcriptions", body, {"Content-Type": content_type})
                self.assertEqual((got, self.error_code(answer)), (status, code))
        self.assertEqual(self.recognizer.calls, [])

    def test_unknown_language_of_the_model(self) -> None:
        status, _, body = self.transcribe(language="xx")
        self.assertEqual((status, self.error_code(body)), (400, "unsupported_language"))

    def test_media_type_and_size(self) -> None:
        status, _, body = self.request("POST", "/v1/audio/transcriptions", make_wav(), {"Content-Type": "audio/wav"})
        self.assertEqual((status, self.error_code(body)), (415, "unsupported_media_type"))
        # The answer comes before any of the body is read, so only the head is sent here.
        conn = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=10)
        try:
            conn.putrequest("POST", "/v1/audio/transcriptions")
            conn.putheader("Content-Type", "multipart/form-data; boundary=x")
            conn.putheader("Content-Length", str(3 * 1024 * 1024))
            conn.endheaders()
            res = conn.getresponse()
            self.assertEqual((res.status, self.error_code(res.read())), (413, "too_large"))
            self.assertEqual(res.getheader("Connection"), "close")
        finally:
            conn.close()
        # A form within the size limit whose file alone is over the audio limit.
        self.settings.limits = vs.Limits(audio_bytes=4096)
        content_type, body = form([("file", make_wav(seconds=1), "a.wav", None)])
        status, _, answer = self.request("POST", "/v1/audio/transcriptions", body, {"Content-Type": content_type})
        self.assertEqual((status, self.error_code(answer)), (413, "too_large"))

    def test_one_recognition_at_a_time_then_busy(self) -> None:
        self.settings.stt_gate = vs.Gate(1, 0, 0.2, "speech input")
        self.recognizer.hold = threading.Event()
        content_type, body = audio_form()
        results: list[int] = []
        first = threading.Thread(
            target=lambda: results.append(
                self.request("POST", "/v1/audio/transcriptions", body, {"Content-Type": content_type})[0]
            )
        )
        first.start()
        self.assertTrue(self.recognizer.entered.wait(5))
        status, headers, answer = self.request("POST", "/v1/audio/transcriptions", body, {"Content-Type": content_type})
        self.assertEqual((status, self.error_code(answer)), (429, "busy"))
        self.assertEqual(headers["retry-after"], "5")
        self.recognizer.hold.set()
        first.join(5)
        self.assertEqual(results, [200])


class SpeechTest(ServerCase):
    def test_speech_is_wav_at_the_voice_rate(self) -> None:
        status, headers, body = self.post_json(
            "/v1/audio/speech",
            {
                "model": "piper",
                "input": "Fresh focaccia at nine.",
                "voice": ALLOWED_VOICE,
                "response_format": "wav",
                "speed": 2,
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "audio/wav")
        with wave.open(io.BytesIO(body), "rb") as wav:
            self.assertEqual((wav.getnchannels(), wav.getsampwidth(), wav.getframerate()), (1, 2, 22050))
            self.assertGreater(wav.getnframes(), 0)
        call = self.piper_log()
        self.assertEqual(call["text"], "Fresh focaccia at nine.\n")
        argv = call["argv"]
        self.assertEqual(argv[argv.index("--length-scale") + 1], "0.5")
        self.assertIn("--output-raw", argv)
        self.assertTrue(argv[argv.index("--model") + 1].endswith(f"{ALLOWED_VOICE}.onnx"))

    def test_text_goes_in_as_one_line(self) -> None:
        self.post_json("/v1/audio/speech", {"input": "first line\nsecond\tline", "voice": ALLOWED_VOICE})
        self.assertEqual(self.piper_log()["text"], "first line second line\n")

    def test_piper_gets_no_secrets_of_the_environment(self) -> None:
        os.environ["STARPI_TEST_SECRET"] = "s3cr3t"
        try:
            speaker = vs.PiperSpeaker(self.voices, [sys.executable, "-I", str(self.piper)])
            speaker.speak("hello", speaker.voices()[ALLOWED_VOICE], 1.0)
        finally:
            del os.environ["STARPI_TEST_SECRET"]
        self.assertNotIn("STARPI_TEST_SECRET", self.piper_log()["env"])

    def test_refusals_before_piper_runs(self) -> None:
        cases = [
            ({"input": "hello", "voice": UNLISTED_VOICE}, "unknown_voice"),
            ({"input": "hello", "voice": "alloy"}, "unknown_voice"),
            ({"input": "hello"}, "missing_field"),
            ({"voice": ALLOWED_VOICE}, "missing_field"),
            ({"input": "...!? ", "voice": ALLOWED_VOICE}, "nothing_to_speak"),
            ({"input": "​﻿", "voice": ALLOWED_VOICE}, "nothing_to_speak"),
            ({"input": "bell\x07", "voice": ALLOWED_VOICE}, "invalid_text"),
            ({"input": "x" * 601, "voice": ALLOWED_VOICE}, "too_long"),
            ({"input": 42, "voice": ALLOWED_VOICE}, "invalid_field"),
            ({"input": "hello", "voice": ALLOWED_VOICE, "speed": 5}, "invalid_speed"),
            ({"input": "hello", "voice": ALLOWED_VOICE, "speed": True}, "invalid_speed"),
            ({"input": "hello", "voice": ALLOWED_VOICE, "response_format": "mp3"}, "unsupported_format"),
            ({"input": "hello", "voice": ALLOWED_VOICE, "model": "other"}, "unknown_model"),
            (b'{"input": "a", "input": "b", "voice": "en_US-ljspeech-medium"}', "invalid_json"),
            (b'{"input": "hello", "voice": "en_US-ljspeech-medium", "speed": NaN}', "invalid_json"),
            (b'{"input": "\\ud800", "voice": "en_US-ljspeech-medium"}', "invalid_text"),
            (b"[" * 5000 + b"]" * 5000, "invalid_json"),
            (b'["not", "an", "object"]', "invalid_json"),
        ]
        for value, code in cases:
            with self.subTest(code=code, value=str(value)[:40]):
                status, _, body = self.post_json("/v1/audio/speech", value)
                self.assertEqual((status, self.error_code(body)), (400, code))
        self.assertFalse(self.piper.with_suffix(".log").exists())

    def test_wrong_media_type(self) -> None:
        status, _, body = self.request(
            "POST", "/v1/audio/speech", b"input=hello", {"Content-Type": "application/x-www-form-urlencoded"}
        )
        self.assertEqual((status, self.error_code(body)), (415, "unsupported_media_type"))

    def test_engine_failures(self) -> None:
        for text, status, code in (
            ("please fail", 502, "engine_failed"),
            ("silence please", 502, "engine_failed"),
            ("slow please", 504, "engine_timeout"),
        ):
            with self.subTest(code=code, text=text):
                got, _, body = self.post_json("/v1/audio/speech", {"input": text, "voice": ALLOWED_VOICE})
                self.assertEqual((got, self.error_code(body)), (status, code))

    def test_too_much_audio_is_cut_off(self) -> None:
        speaker = vs.PiperSpeaker(self.voices, [sys.executable, "-I", str(self.piper)], max_pcm_bytes=1024 * 1024)
        with self.assertRaises(vs.EngineFailure):
            speaker.speak("flood", speaker.voices()[ALLOWED_VOICE], 1.0)


class CorsTest(ServerCase):
    def test_preflight_of_an_allowed_origin_with_private_network(self) -> None:
        status, headers, _ = self.request(
            "OPTIONS",
            "/v1/audio/speech",
            headers={
                "Origin": APP_ORIGIN,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
                "Access-Control-Request-Private-Network": "true",
            },
        )
        self.assertEqual(status, 204)
        self.assertEqual(headers["access-control-allow-origin"], APP_ORIGIN)
        self.assertEqual(headers["access-control-allow-private-network"], "true")
        self.assertEqual(headers["access-control-allow-methods"], "POST, OPTIONS")
        self.assertIn("content-type", headers["access-control-allow-headers"])
        self.assertEqual(headers["vary"], "Origin")

    def test_preflight_without_private_network_question(self) -> None:
        status, headers, _ = self.request(
            "OPTIONS", "/v1/audio/voices", headers={"Origin": SELF_HOST, "Access-Control-Request-Method": "GET"}
        )
        self.assertEqual(status, 204)
        self.assertNotIn("access-control-allow-private-network", headers)

    def test_preflight_for_a_method_the_route_lacks(self) -> None:
        status, _, body = self.request(
            "OPTIONS", "/v1/audio/voices", headers={"Origin": APP_ORIGIN, "Access-Control-Request-Method": "POST"}
        )
        self.assertEqual((status, self.error_code(body)), (405, "method_not_allowed"))

    def test_other_origins_get_nothing(self) -> None:
        for origin in ("https://evil.example", "null", "http://www.starpi.app", "https://www.starpi.app.evil.example"):
            with self.subTest(origin=origin):
                status, headers, body = self.request(
                    "OPTIONS",
                    "/v1/audio/speech",
                    headers={
                        "Origin": origin,
                        "Access-Control-Request-Method": "POST",
                        "Access-Control-Request-Private-Network": "true",
                    },
                )
                self.assertEqual((status, self.error_code(body)), (403, "origin_not_allowed"))
                self.assertNotIn("access-control-allow-origin", headers)
                self.assertNotIn("access-control-allow-private-network", headers)
        status, _, _ = self.post_json(
            "/v1/audio/speech", {"input": "hello", "voice": ALLOWED_VOICE}, {"Origin": "https://evil.example"}
        )
        self.assertEqual(status, 403)
        self.assertFalse(self.piper.with_suffix(".log").exists())

    def test_a_refused_body_does_not_poison_the_connection(self) -> None:
        conn = http.client.HTTPConnection("127.0.0.1", self.server.port, timeout=10)
        try:
            conn.request(
                "POST",
                "/v1/audio/speech",
                body=b'{"input": "hello"}',
                headers={"Content-Type": "application/json", "Origin": "https://evil.example"},
            )
            res = conn.getresponse()
            res.read()
            self.assertEqual((res.status, res.getheader("Connection")), (403, "close"))
        finally:
            conn.close()

    def test_answers_name_the_allowed_origin(self) -> None:
        status, headers, _ = self.request("GET", "/v1/audio/voices", headers={"Origin": APP_ORIGIN})
        self.assertEqual(status, 200)
        self.assertEqual(headers["access-control-allow-origin"], APP_ORIGIN)
        self.assertEqual(headers["vary"], "Origin")

    def test_callers_without_origin_get_no_cors_headers(self) -> None:
        status, headers, _ = self.request("GET", "/v1/audio/voices")
        self.assertEqual(status, 200)
        self.assertNotIn("access-control-allow-origin", headers)


class UnitTest(unittest.TestCase):
    def test_split_terms(self) -> None:
        self.assertEqual(
            vs.split_terms(" Kubernetes \n\npnpm; focaccia,  rye   levain ,kubernetes", 10),
            ["Kubernetes", "pnpm", "focaccia", "rye levain"],
        )
        self.assertEqual(vs.split_terms("a\nb\nc", 2), ["a", "b"])
        self.assertEqual(vs.split_terms(None, 5), [])

    def test_plan_prompt_keeps_the_budget(self) -> None:
        words = lambda text: len(text.split())  # noqa: E731
        glossary = "\n".join(f"term{i}" for i in range(50))
        plan = vs.plan_prompt("a long free prompt " * 20, glossary, words, budget=12, max_terms=60)
        hot = (plan.hotwords or "").split(", ")
        self.assertEqual(hot, [f"term{i}" for i in range(12)])
        self.assertIsNone(plan.initial_prompt)
        plan = vs.plan_prompt("sourdough, rye levain, a bakery stock check", "focaccia", words, budget=6, max_terms=60)
        self.assertEqual(plan.hotwords, "focaccia")
        self.assertEqual(plan.initial_prompt, "sourdough, rye levain")

    def test_plan_prompt_without_tokenizer_counts_bytes(self) -> None:
        plan = vs.plan_prompt(None, "ab\ncd\nef", None, budget=8, max_terms=60)
        self.assertEqual(plan.hotwords, "ab, cd")  # " ab, cd" is 7 bytes; one more term would be 11

    def test_normalize_origin(self) -> None:
        self.assertEqual(vs.normalize_origin("https://WWW.Starpi.app"), "https://www.starpi.app")
        self.assertEqual(vs.normalize_origin("https://chat.example.org:443"), "https://chat.example.org")
        self.assertEqual(vs.normalize_origin("https://chat.example.org:8443/"), "https://chat.example.org:8443")
        self.assertEqual(vs.normalize_origin("http://localhost:3000"), "http://localhost:3000")
        self.assertEqual(vs.normalize_origin("http://[::1]:3000"), "http://[::1]:3000")
        for bad in (
            "http://chat.example.org",
            "https://chat.example.org/app",
            "null",
            "ftp://x.example",
            "https://user@x.example",
            "https://x.example:99999",
        ):
            with self.subTest(bad=bad):
                self.assertIsNone(vs.normalize_origin(bad))

    def test_parse_form_edges(self) -> None:
        single = frozenset({"file"})
        _, body = form([("file", b"\r\n--not-the-boundary\r\n", "a.bin", None)])
        self.assertEqual(
            vs.parse_form("starpi-test-boundary", body, 4, single)["file"].data, b"\r\n--not-the-boundary\r\n"
        )
        bad = [
            (b"preamble\r\n" + body, "opening"),
            (body.replace(b"--starpi-test-boundary--\r\n", b""), "closing"),
            (body.replace(b"Content-Disposition", b"Content-Disposition: x\r\nContent-Disposition"), "repeated"),
            (body.replace(b"form-data;", b"attachment;"), "form-data"),
            (body.replace(b'name="file"', b'name*="file"'), "parameter"),
        ]
        for data, why in bad:
            with self.subTest(why=why), self.assertRaises(ValueError):
                vs.parse_form("starpi-test-boundary", data, 4, single)
        with self.assertRaises(ValueError):
            vs.parse_form("bad boundary ", body, 4, single)

    def test_gate_serves_in_order(self) -> None:
        gate = vs.Gate(1, 5, 5.0, "test")
        order: list[int] = []
        release = threading.Event()

        def job(n: int) -> None:
            with gate.turn():
                order.append(n)
                if n == 0:
                    release.wait(5)

        threads = [threading.Thread(target=job, args=(0,))]
        threads[0].start()
        while not order:
            time.sleep(0.01)
        for n in range(1, 5):
            t = threading.Thread(target=job, args=(n,))
            t.start()
            threads.append(t)
            while len(gate._line) < n:  # each waiter is in line before the next one arrives
                time.sleep(0.01)
        release.set()
        for t in threads:
            t.join(5)
        self.assertEqual(order, [0, 1, 2, 3, 4])

    def test_gate_times_out_and_leaves_the_line(self) -> None:
        gate = vs.Gate(1, 1, 0.1, "test")
        with gate.turn():
            with self.assertRaises(vs.HttpError) as caught, gate.turn():
                pass
            self.assertEqual(caught.exception.status, 429)
            self.assertEqual(len(gate._line), 0)
        with gate.turn():
            pass

    def test_speakable_text(self) -> None:
        self.assertTrue(vs.has_letter_or_digit("42"))
        self.assertTrue(vs.has_letter_or_digit("㏏"))  # a squared unit sign folds to letters
        self.assertFalse(vs.has_letter_or_digit("?! ​"))

    def test_check_wav(self) -> None:
        vs.check_wav(make_wav(channels=2, rate=48000))
        for data in (b"", b"RIFF" + b"\0" * 60, make_wav(seconds=0)):
            with self.subTest(size=len(data)), self.assertRaises(vs.HttpError):
                vs.check_wav(data)

    def test_allowlist_rules(self) -> None:
        good = {
            "id": "en_GB-cori-medium",
            "label": "Cori",
            "lang": "en-GB",
            "license": "CC-BY-4.0",
            "card": "https://example.org/card",
            "base": None,
        }
        ids = {"en_GB-cori-medium", "en_US-ljspeech-medium"}
        self.assertEqual(vs.entry_problems(good, ids), [])
        self.assertEqual(vs.entry_problems({**good, "license": "CC-BY-NC-4.0"}, ids), ["license"])
        self.assertEqual(vs.entry_problems({**good, "license": "CC-BY-NC-SA-4.0"}, ids), ["license"])
        self.assertEqual(vs.entry_problems({**good, "base": "en_US-other-medium"}, ids), ["base"])
        self.assertEqual(vs.entry_problems({**good, "base": "en_US-ljspeech-medium"}, ids), [])
        self.assertEqual(vs.entry_problems({**good, "card": "http://example.org"}, ids), ["card"])
        self.assertEqual(vs.entry_problems({**good, "id": "../etc/passwd"}, ids), ["id"])

    def test_the_shipped_allowlist_loads_whole(self) -> None:
        raw = json.loads(vs.DEFAULT_ALLOWLIST.read_text(encoding="utf-8"))
        loaded = vs.load_allowlist(vs.DEFAULT_ALLOWLIST)
        self.assertEqual(sorted(loaded), sorted(v["id"] for v in raw["voices"]))
        self.assertGreater(len(loaded), 0)

    def test_allowlist_matches_the_app(self) -> None:
        app = vs.HERE.parent.parent / "api" / "_lib" / "voice-allowlist.json"
        if not app.exists():
            self.skipTest("not inside the Starpi repository")
        self.assertEqual(vs.DEFAULT_ALLOWLIST.read_bytes(), app.read_bytes())

    def test_command_line_without_models(self) -> None:
        with self.assertRaises(SystemExit) as caught, open(os.devnull, "w") as sink:
            stdout, sys.stdout = sys.stdout, sink
            try:
                vs.build_parser().parse_args(["--help"])
            finally:
                sys.stdout = stdout
        self.assertEqual(caught.exception.code, 0)
        self.assertEqual(vs.main(["--no-stt", "--no-tts", "--port", "80"]), 2)


@unittest.skipUnless(
    os.environ.get("STARPI_VOICE_MODELS"), "set STARPI_VOICE_MODELS to the voice server home to test real models"
)
class RealModelsTest(unittest.TestCase):
    """Silence gives an empty transcript, and an installed allowlisted voice speaks."""

    def test_models(self) -> None:
        home = Path(os.environ["STARPI_VOICE_MODELS"])
        recognizer = vs.WhisperRecognizer(os.environ.get("STARPI_VOICE_WHISPER", "small"), home / "whisper")
        recognizer.load()
        self.assertEqual(recognizer.transcribe(make_wav(seconds=2), "en", vs.PromptPlan(None, "Kubernetes")), "")
        speaker = vs.PiperSpeaker(home / "voices", [sys.executable, "-I", "-m", "piper"])
        offered = [v for v in speaker.voices().values() if v.id in vs.load_allowlist(vs.DEFAULT_ALLOWLIST)]
        if offered:
            audio = speaker.speak("Hello from the voice server.", offered[0], 1.0)
            self.assertEqual(audio[:4], b"RIFF")


def setUpModule() -> None:
    logging.getLogger("starpi-voice").setLevel(logging.CRITICAL)


if __name__ == "__main__":
    unittest.main()
