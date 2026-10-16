"""384-dimensional multilingual-e5-small embeddings through ONNX Runtime.

The vectors match the ones the browser computes with Transformers.js for the same model:

- every text gets the e5 prefix of its role, ``query: `` for questions and ``passage: `` for the
  stored sections;
- the tokens' last hidden states are averaged over the attention mask (mean pooling);
- the average is L2-normalised, so the cosine similarity is a dot product.

onnxruntime, tokenizers and numpy are optional dependencies (requirements-embed.txt). They are
imported only when a model is loaded, so the rest of the publisher works without them.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Literal

from .model_files import ONNX_FILE, TOKENIZER_FILE, verify_model_dir

logger = logging.getLogger(__name__)

EMBEDDING_DIM = 384
MAX_TOKENS = 512
# One text per model run. The q8 export quantises activations dynamically, per run, so in a batch
# every vector would depend slightly on its neighbours and on the padding; single runs keep a
# section's vector a function of its text alone (and are no slower on a CPU).
DEFAULT_BATCH_SIZE = 1
PREFIXES = {"query": "query: ", "passage": "passage: "}
Kind = Literal["query", "passage"]

_KNOWN_INPUTS = ("input_ids", "attention_mask", "token_type_ids")


class EmbedderError(Exception):
    """The model cannot be loaded or returned something that is not a valid embedding."""


def _numpy() -> Any:
    try:
        import numpy
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise EmbedderError("numpy is not installed: pip install -r requirements-embed.txt") from exc
    return numpy


def prefixed(texts: Sequence[str], kind: Kind) -> list[str]:
    """``texts`` with the e5 prefix for ``kind`` (``query`` or ``passage``)."""
    if kind not in PREFIXES:
        raise ValueError(f"kind must be one of {', '.join(PREFIXES)}")
    return [PREFIXES[kind] + text for text in texts]


def mean_pool_normalize(hidden: Any, mask: Any) -> Any:
    """Mean of ``hidden`` (batch, tokens, dim) over the tokens where ``mask`` is 1, L2-normalised."""
    np = _numpy()
    weights = np.asarray(mask, dtype=np.float32)[:, :, None]
    summed = (np.asarray(hidden, dtype=np.float32) * weights).sum(axis=1)
    counts = np.maximum(weights.sum(axis=1), 1.0)
    pooled = summed / counts
    norms = np.linalg.norm(pooled, axis=1, keepdims=True)
    return pooled / np.maximum(norms, 1e-12)


class E5Embedder:
    """Embeds texts with a tokenizer and an ONNX Runtime session of multilingual-e5-small.

    ``tokenizer`` needs ``encode_batch(texts)`` returning objects with ``ids`` and
    ``attention_mask`` (the ``tokenizers`` package); ``session`` needs ``get_inputs()``,
    ``get_outputs()`` and ``run(names, feeds)`` (``onnxruntime.InferenceSession``). Tests pass
    small stand-ins for both.
    """

    def __init__(self, tokenizer: Any, session: Any, *, batch_size: int = DEFAULT_BATCH_SIZE) -> None:
        if batch_size < 1:
            raise ValueError("batch_size must be positive")
        inputs = [item.name for item in session.get_inputs()]
        unknown = [name for name in inputs if name not in _KNOWN_INPUTS]
        if "input_ids" not in inputs or unknown:
            raise EmbedderError(f"unexpected model inputs {inputs}; expected a subset of {list(_KNOWN_INPUTS)}")
        outputs = [item.name for item in session.get_outputs()]
        self._inputs = inputs
        self._output = "last_hidden_state" if "last_hidden_state" in outputs else outputs[0]
        self._tokenizer = tokenizer
        self._session = session
        self._batch_size = batch_size
        token_to_id = getattr(tokenizer, "token_to_id", None)
        pad_id = token_to_id("<pad>") if callable(token_to_id) else None
        # Padded positions are masked out, so their id only has to be a valid token.
        self._pad_id = pad_id if isinstance(pad_id, int) else 0

    def embed(self, texts: Sequence[str], kind: Kind) -> list[list[float]]:
        """One unit-length vector of ``EMBEDDING_DIM`` floats per text, in input order."""
        inputs = prefixed(texts, kind)
        vectors: list[list[float]] = []
        for start in range(0, len(inputs), self._batch_size):
            vectors.extend(self._embed_batch(inputs[start : start + self._batch_size]))
        return vectors

    def embed_query(self, text: str) -> list[float]:
        return self.embed([text], "query")[0]

    def embed_passages(self, texts: Sequence[str]) -> list[list[float]]:
        return self.embed(texts, "passage")

    def _embed_batch(self, texts: list[str]) -> list[list[float]]:
        np = _numpy()
        encodings = self._tokenizer.encode_batch(texts)
        length = max(len(encoding.ids) for encoding in encodings)
        ids = np.full((len(encodings), length), self._pad_id, dtype=np.int64)
        mask = np.zeros((len(encodings), length), dtype=np.int64)
        for row, encoding in enumerate(encodings):
            ids[row, : len(encoding.ids)] = encoding.ids
            mask[row, : len(encoding.attention_mask)] = encoding.attention_mask
        feeds = {"input_ids": ids, "attention_mask": mask, "token_type_ids": np.zeros_like(ids)}
        hidden = np.asarray(self._session.run([self._output], {name: feeds[name] for name in self._inputs})[0])
        if hidden.ndim != 3 or hidden.shape[:2] != ids.shape or hidden.shape[2] != EMBEDDING_DIM:
            raise EmbedderError(f"model output has shape {hidden.shape}, expected (batch, tokens, {EMBEDDING_DIM})")
        vectors = mean_pool_normalize(hidden, mask)
        if not np.isfinite(vectors).all():
            raise EmbedderError("model returned NaN or infinite values")
        return [[float(value) for value in row] for row in vectors]


def load_embedder(model_dir: Path, *, batch_size: int = DEFAULT_BATCH_SIZE, verify: bool = True) -> E5Embedder:
    """Loads the pinned model files from ``model_dir``.

    With ``verify`` (the default) every file must match its SHA-256 pin first, so a replaced or
    truncated model never writes vectors into the shared library.
    """
    problems = verify_model_dir(model_dir) if verify else []
    if problems:
        raise EmbedderError(f"{'; '.join(problems)} (run: python -m publisher fetch-model)")
    try:
        import onnxruntime
        from tokenizers import Tokenizer
    except ImportError as exc:
        raise EmbedderError(
            "onnxruntime and tokenizers are not installed: pip install -r requirements-embed.txt"
        ) from exc

    tokenizer = Tokenizer.from_file(str(model_dir / TOKENIZER_FILE))
    tokenizer.enable_truncation(max_length=MAX_TOKENS)
    tokenizer.no_padding()
    options = onnxruntime.SessionOptions()
    options.log_severity_level = 3
    session = onnxruntime.InferenceSession(
        str(model_dir / ONNX_FILE), sess_options=options, providers=["CPUExecutionProvider"]
    )
    logger.info("Loaded %s from %s", ONNX_FILE, model_dir.name)
    return E5Embedder(tokenizer, session, batch_size=batch_size)
