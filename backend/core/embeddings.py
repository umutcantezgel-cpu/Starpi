"""Text embeddings via a ``/v1/embeddings`` endpoint (same API family as ``/v1/chat/completions``).

When the endpoint is unavailable, a deterministic word-hash vector is produced instead. That
vector only supports the in-memory offline store; it has no semantic meaning and must never be
persisted as an embedding. Use :func:`get_embedding_with_source` to tell the two apart.
"""

from __future__ import annotations

import hashlib
import logging
import math

import httpx

from .config import config
from .http_utils import bearer_headers, describe_error, http_timeout

logger = logging.getLogger(__name__)

EMBEDDING_DIM = 1536
EMBEDDING_TIMEOUT_SECONDS = 20.0
EMBEDDING_CONNECT_TIMEOUT_SECONDS = 2.0


def is_finite_vector(values: list[float]) -> bool:
    """True when no value is NaN or +/-Infinity (JSON parsers accept both as literals)."""
    return all(math.isfinite(v) for v in values)


def fetch_remote_embedding(text: str) -> list[float] | None:
    """Returns the endpoint's embedding for ``text`` or None when it is unavailable or invalid."""
    if not text:
        return None
    payload = {"model": config.embedding_model, "input": text}
    url = f"{config.embedding_base_url.rstrip('/')}/embeddings"
    try:
        with httpx.Client(timeout=http_timeout(EMBEDDING_TIMEOUT_SECONDS, EMBEDDING_CONNECT_TIMEOUT_SECONDS)) as client:
            resp = client.post(url, json=payload, headers=bearer_headers(config.embedding_api_key))
            resp.raise_for_status()
            vector = resp.json()["data"][0]["embedding"]
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError) as exc:
        logger.warning("Embedding endpoint unavailable: %s", describe_error(exc))
        return None

    if not isinstance(vector, list) or len(vector) != EMBEDDING_DIM:
        size = len(vector) if isinstance(vector, list) else type(vector).__name__
        logger.warning("Embedding endpoint returned %s values, expected %d; ignoring it", size, EMBEDDING_DIM)
        return None
    try:
        floats = [float(v) for v in vector]
    except (TypeError, ValueError):
        logger.warning("Embedding endpoint returned non-numeric values; ignoring it")
        return None
    if not is_finite_vector(floats):
        # NaN / Infinity would poison cosine similarity and cannot be stored in pgvector.
        logger.warning("Embedding endpoint returned NaN or infinite values; ignoring it")
        return None
    return floats


def hash_embedding(text: str) -> list[float]:
    """Deterministic, L2-normalised bag-of-words hash vector for offline use only."""
    vector = [0.0] * EMBEDDING_DIM
    for word in text.lower().split():
        idx = int(hashlib.sha256(word.encode("utf-8")).hexdigest(), 16) % EMBEDDING_DIM
        vector[idx] += 1.0
    norm = math.sqrt(sum(v * v for v in vector))
    if norm > 0:
        return [v / norm for v in vector]
    vector[0] = 1.0
    return vector


def get_embedding_with_source(text: str) -> tuple[list[float] | None, bool]:
    """Returns ``(vector, is_real)``.

    - ``(remote_vector, True)`` when the embedding endpoint answered with a valid vector.
    - ``(hash_vector, False)`` when it did not; the vector is for in-memory search only.
    - ``(None, False)`` for empty input.
    """
    if not text:
        return None, False
    remote = fetch_remote_embedding(text)
    if remote is not None:
        return remote, True
    return hash_embedding(text), False


def get_embedding(text: str) -> list[float]:
    """Backwards compatible wrapper that always returns a vector.

    The result may be the hash fallback (all zeros for empty input), so it must not be stored as
    an embedding. New code should call :func:`get_embedding_with_source`.
    """
    vector, _ = get_embedding_with_source(text)
    return vector if vector is not None else [0.0] * EMBEDDING_DIM


def get_embeddings_batch(texts: list[str]) -> list[list[float]]:
    """Computes :func:`get_embedding` for each text."""
    return [get_embedding(t) for t in texts]
