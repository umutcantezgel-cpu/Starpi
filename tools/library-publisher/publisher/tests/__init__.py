"""Offline tests of the library publisher (no network, no model download).

Run from tools/library-publisher with ``python -m unittest discover -v`` or ``python -m pytest``.
Tests of the vector math need numpy and are skipped without it; the test against the real model
runs only when PUBLISHER_TEST_MODEL_DIR points at the fetched model files.
"""

import importlib.util
import unittest

if importlib.util.find_spec("httpx") is None:
    # httpx is the publisher's one required dependency; say so instead of failing every import.
    raise unittest.SkipTest("httpx is not installed: pip install -r requirements-dev.txt")
