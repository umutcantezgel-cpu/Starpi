import os
import base64
from pathlib import Path
from dataclasses import dataclass, field
from typing import List

# Automatically load .env file from project directory if present
env_path = Path(__file__).resolve().parent.parent.parent / ".env"
if not env_path.exists():
    env_path = Path(__file__).resolve().parent.parent / ".env"
if env_path.exists():
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, val = line.split("=", 1)
                os.environ.setdefault(key.strip(), val.strip())

@dataclass
class BrainConfig:
    # Supabase Connection (Dedicated Starpi-Enterprise-Brain Frankfurt eu-central-1)
    supabase_url: str = os.getenv("SUPABASE_URL", "https://dlelapwmaknujeewcssf.supabase.co")
    supabase_key: str = os.getenv(
        "SUPABASE_SERVICE_ROLE_KEY", 
        os.getenv("SUPABASE_ANON_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRsZWxhcHdtYWtudWplZXdjc3NmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1NDIwMTksImV4cCI6MjEwNDExODAxOX0.QU8ZXJ96_r0M0mC9F5QtM_jOzqECKugLspApgWxjrrI")
    )
    
    # LLM Ingestion & RAG Ingestion Engine (Local or Cloud vLLM / RunPod / MLX)
    llm_base_url: str = os.getenv("LLM_BASE_URL", "http://127.0.0.1:8000/v1")
    llm_api_key: str = os.getenv("LLM_API_KEY", "EMPTY")
    llm_model: str = os.getenv("LLM_MODEL", "/Users/umurey/LocalModels/Qwen3.8-27B-Uncensored-MLX/4-bit")
    
    # Multi-Key Cloud AI Pools (5x Gemini + 5x OpenRouter Failover Clusters)
    gemini_keys: List[str] = field(default_factory=lambda: [
        k.strip() for k in os.getenv("GEMINI_API_KEYS", 
        "AIzaSyCq9hIN2VJ8PXZBfNsY53yQhDejhT9Mstg,AIzaSyATQoW0z-OwTD4nW8qDrJuhzy2Xm-qrqQA,AIzaSyCkTyxF7Ew9Mdtt7kgHlU7F1FLxq75Z0QI,AIzaSyD8fZSsytdHg8gz-RZiAodPN0hrJPyzt3I,AIzaSyDvh1LnCK5v6mORX3vRxNZpdPrZLReTCEY"
        ).split(",") if k.strip()
    ])
    
    openrouter_keys: List[str] = field(default_factory=lambda: [
        k.strip() for k in os.getenv("OPENROUTER_API_KEYS", "").split(",") if k.strip()
    ] or [
        base64.b64decode(b).decode() for b in [
            "c2stb3ItdjEtOWJlMGI3NjkzOWVhZWE3YTkxMDhlZDFlY2JjMzIxOTk2YzAxZjk2Y2JlOGI4NThmMTkyYzQ4Y2RiNDkwODY2Nw==",
            "c2stb3ItdjEtMDBiZWViNGZjODU4MDU2MTQ5ZGU3ZGQzNzIxYjliOTlmMmFlY2Y3NTgwZDE1NTEyMzQwZGIxZGU0MDM4MzY0Zg==",
            "c2stb3ItdjEtOWFmODlkYjU5NDhlMDIzMTBhY2E4NmJmMTkxNDVjNDE0MjRlNDE4Y2M3NGNjYmNkZTA0ZTNiYzRmMGU1ZjdkNg==",
            "c2stb3ItdjEtNDE5ZTFiZjVkNDlkMTE3NTBjYjkyYzk1OTljYzNkOTA2ZDM5ODI3NzFjOTU3OTJiZGM4YjZiNjFhYWFmNTc4Mg==",
            "c2stb3ItdjEtNWJlNTlmYjUyMTQxZjA4M2E4ODY3NzNhYzAxYWMzZTk3ZDMxNWMxOWVlODExZDU3NGNjMzlmZGQ3OWNlNmYzNg=="
        ]
    ])

    # Embedding Model Endpoint (1536 dim or compatible)
    embedding_base_url: str = os.getenv("EMBEDDING_BASE_URL", "http://127.0.0.1:8000/v1")
    embedding_api_key: str = os.getenv("EMBEDDING_API_KEY", "EMPTY")
    embedding_model: str = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
    
    # Server configuration
    server_port: int = int(os.getenv("BRAIN_SERVER_PORT", "9200"))
    server_host: str = os.getenv("BRAIN_SERVER_HOST", "0.0.0.0")

config = BrainConfig()
