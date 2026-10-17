"""Pinned files of the embedding model: download from Hugging Face and SHA-256 verification.

The browser computes its query vectors with the q8 ONNX export of multilingual-e5-small, so the
publisher loads exactly that file. Vectors from other weights (the fp32 export, a different
revision) would still have 384 dimensions but would rank worse against the browser's queries.
"""

from __future__ import annotations

import hashlib
import logging
import os
from dataclasses import dataclass
from pathlib import Path

import httpx

from .http_utils import describe_error, http_timeout

logger = logging.getLogger(__name__)

MODEL_REPO = "Xenova/multilingual-e5-small"
# The ONNX repository above is an export of this model; its card documents the prefixes.
BASE_MODEL = "intfloat/multilingual-e5-small"
MODEL_REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78"
DEFAULT_BASE_URL = "https://huggingface.co"

TOKENIZER_FILE = "tokenizer.json"
ONNX_FILE = "onnx/model_quantized.onnx"

DOWNLOAD_TIMEOUT_SECONDS = 120.0
DOWNLOAD_CONNECT_TIMEOUT_SECONDS = 10.0
_CHUNK_BYTES = 1 << 20


@dataclass(frozen=True)
class PinnedFile:
    path: str
    sha256: str
    size: int


PINNED_FILES = (
    PinnedFile(TOKENIZER_FILE, "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39", 17_082_730),
    PinnedFile(ONNX_FILE, "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193", 118_308_185),
)


class ModelFileError(Exception):
    """A model file is missing, has the wrong hash, or could not be downloaded."""


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(_CHUNK_BYTES), b""):
            digest.update(block)
    return digest.hexdigest()


def check_file(model_dir: Path, pinned: PinnedFile) -> str | None:
    """Returns None when the file matches its pin, else a short reason."""
    target = model_dir / pinned.path
    if not target.is_file():
        return f"{pinned.path} is missing"
    if target.stat().st_size != pinned.size:
        return f"{pinned.path} has {target.stat().st_size} bytes, expected {pinned.size}"
    if sha256_of(target) != pinned.sha256:
        return f"{pinned.path} does not match its SHA-256 pin"
    return None


def verify_model_dir(model_dir: Path, files: tuple[PinnedFile, ...] = PINNED_FILES) -> list[str]:
    """Problems with the model files in ``model_dir``; an empty list means every pin matches."""
    return [reason for pinned in files if (reason := check_file(model_dir, pinned)) is not None]


def _download(client: httpx.Client, url: str, pinned: PinnedFile, target: Path) -> None:
    partial = target.with_name(target.name + ".part")
    digest = hashlib.sha256()
    received = 0
    try:
        with client.stream("GET", url) as response:
            response.raise_for_status()
            with partial.open("wb") as handle:
                for block in response.iter_bytes(_CHUNK_BYTES):
                    received += len(block)
                    if received > pinned.size:
                        raise ModelFileError(f"{pinned.path} is larger than the pinned {pinned.size} bytes")
                    digest.update(block)
                    handle.write(block)
        if received != pinned.size:
            raise ModelFileError(f"{pinned.path} has {received} bytes, expected {pinned.size}")
        if digest.hexdigest() != pinned.sha256:
            raise ModelFileError(f"{pinned.path} does not match its SHA-256 pin")
        os.replace(partial, target)
    except httpx.HTTPError as exc:
        raise ModelFileError(f"downloading {pinned.path} failed: {describe_error(exc)}") from exc
    finally:
        partial.unlink(missing_ok=True)


def fetch_model(
    model_dir: Path,
    *,
    base_url: str = DEFAULT_BASE_URL,
    files: tuple[PinnedFile, ...] = PINNED_FILES,
    transport: httpx.BaseTransport | None = None,
) -> list[tuple[str, str]]:
    """Downloads every pinned file that is missing or changed; returns ``(path, "kept" | "downloaded")``.

    A file is written only after its size and SHA-256 match the pin, so an interrupted or
    tampered download never replaces a good file. ``transport`` replaces the network in tests.
    """
    results: list[tuple[str, str]] = []
    timeout = http_timeout(DOWNLOAD_TIMEOUT_SECONDS, DOWNLOAD_CONNECT_TIMEOUT_SECONDS)
    with httpx.Client(timeout=timeout, follow_redirects=True, transport=transport) as client:
        for pinned in files:
            if check_file(model_dir, pinned) is None:
                results.append((pinned.path, "kept"))
                continue
            target = model_dir / pinned.path
            target.parent.mkdir(parents=True, exist_ok=True)
            url = f"{base_url.rstrip('/')}/{MODEL_REPO}/resolve/{MODEL_REVISION}/{pinned.path}"
            logger.info("Downloading %s (%d bytes)", pinned.path, pinned.size)
            _download(client, url, pinned, target)
            results.append((pinned.path, "downloaded"))
    return results
