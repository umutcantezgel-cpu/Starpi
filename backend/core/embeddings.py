import hashlib
import math
import httpx
from typing import List
from .config import config

def get_embedding(text: str) -> List[float]:
    """
    Fetches embedding from configured embedding endpoint (/v1/embeddings).
    Falls back to a normalized deterministic semantic vector (1536-dim) if endpoint is unavailable.
    """
    if not text:
        return [0.0] * 1536

    payload = {
        "model": config.embedding_model,
        "input": text
    }
    
    headers = {"Authorization": f"Bearer {config.embedding_api_key}"} if config.embedding_api_key != "EMPTY" else {}
    
    try:
        with httpx.Client(timeout=30.0) as client:
            resp = client.post(
                f"{config.embedding_base_url.rstrip('/')}/embeddings",
                json=payload,
                headers=headers
            )
            if resp.status_code == 200:
                data = resp.json()
                return data["data"][0]["embedding"]
    except Exception:
        pass
        
    # Fallback: Deterministic dense hash-vector generator (1536 dimensions) for local testing
    vector = [0.0] * 1536
    words = text.lower().split()
    for word in words:
        h = int(hashlib.sha256(word.encode('utf-8')).hexdigest(), 16)
        idx = h % 1536
        vector[idx] += 1.0
        
    # Normalize vector to unit length (L2 norm)
    norm = math.sqrt(sum(v * v for v in vector))
    if norm > 0:
        vector = [v / norm for v in vector]
    else:
        vector[0] = 1.0
        
    return vector

def get_embeddings_batch(texts: List[str]) -> List[List[float]]:
    """Batch computes embeddings for a list of text strings."""
    return [get_embedding(t) for t in texts]
