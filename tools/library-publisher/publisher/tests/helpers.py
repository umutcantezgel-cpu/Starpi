"""Fakes shared by the publisher tests: a recording HTTP transport, a tokenizer and a model."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx

HAS_NUMPY = importlib.util.find_spec("numpy") is not None
DIM = 384


class Recorder:
    """httpx transport that answers from ``handler`` and keeps every request."""

    def __init__(self, handler: Callable[[httpx.Request], httpx.Response]) -> None:
        self.requests: list[httpx.Request] = []
        self._handler = handler
        self.transport = httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self._handler(request)

    def json_bodies(self) -> list[Any]:
        return [json.loads(request.content) if request.content else None for request in self.requests]


def json_response(status: int, payload: Any) -> httpx.Response:
    return httpx.Response(status, json=payload)


def unit_vector(position: int = 0, dim: int = DIM) -> list[float]:
    return [1.0 if i == position else 0.0 for i in range(dim)]


class FakePassageEmbedder:
    """Pure-Python stand-in for E5Embedder: a one-hot vector per call, recording the texts."""

    def __init__(self) -> None:
        self.passages: list[str] = []
        self.queries: list[str] = []

    def embed_passages(self, texts: list[str]) -> list[list[float]]:
        self.passages.extend(texts)
        return [unit_vector(len(self.passages) - len(texts) + i) for i in range(len(texts))]

    def embed_query(self, text: str) -> list[float]:
        self.queries.append(text)
        return unit_vector(0)


@dataclass
class FakeEncoding:
    ids: list[int]
    attention_mask: list[int]


@dataclass
class FakeTokenizer:
    """Whitespace tokenizer with <s> = 0, <pad> = 1, </s> = 2 and hashed word ids."""

    vocab_size: int = 50
    seen: list[str] = field(default_factory=list)

    def token_to_id(self, token: str) -> int | None:
        return {"<s>": 0, "<pad>": 1, "</s>": 2}.get(token)

    def word_id(self, word: str) -> int:
        return 3 + int(hashlib.sha256(word.encode()).hexdigest(), 16) % (self.vocab_size - 3)

    def encode_batch(self, texts: list[str]) -> list[FakeEncoding]:
        self.seen.extend(texts)
        encodings = []
        for text in texts:
            ids = [0, *(self.word_id(word) for word in text.split()), 2]
            encodings.append(FakeEncoding(ids, [1] * len(ids)))
        return encodings


@dataclass
class FakeNode:
    name: str


class FakeSession:
    """ONNX Runtime stand-in: each token's hidden state is a fixed row of ``table`` (numpy)."""

    def __init__(
        self,
        table: Any,
        *,
        inputs: tuple[str, ...] = ("input_ids", "attention_mask", "token_type_ids"),
        outputs: tuple[str, ...] = ("last_hidden_state",),
        transform: Callable[[Any], Any] | None = None,
    ) -> None:
        self.table = table
        self.inputs = inputs
        self.outputs = outputs
        self.transform = transform
        self.feeds: list[dict[str, Any]] = []

    def get_inputs(self) -> list[FakeNode]:
        return [FakeNode(name) for name in self.inputs]

    def get_outputs(self) -> list[FakeNode]:
        return [FakeNode(name) for name in self.outputs]

    def run(self, names: list[str], feeds: dict[str, Any]) -> list[Any]:
        self.feeds.append(feeds)
        hidden = self.table[feeds["input_ids"]]
        return [self.transform(hidden) if self.transform else hidden]
