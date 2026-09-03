import os
from pathlib import Path
from dataclasses import dataclass

# Automatically load .env file from project directory if present
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
    # Supabase Connection
    supabase_url: str = os.getenv("SUPABASE_URL", "")
    supabase_key: str = os.getenv("SUPABASE_SERVICE_ROLE_KEY", os.getenv("SUPABASE_ANON_KEY", ""))
    
    # LLM Ingestion & RAG Ingestion Engine (Local or Cloud vLLM / RunPod / MLX)
    llm_base_url: str = os.getenv("LLM_BASE_URL", "http://127.0.0.1:8000/v1")
    llm_api_key: str = os.getenv("LLM_API_KEY", "EMPTY")
    llm_model: str = os.getenv("LLM_MODEL", "/Users/umurey/LocalModels/Qwen3.8-27B-Uncensored-MLX/4-bit")
    
    # Embedding Model Endpoint (1536 dim or compatible)
    embedding_base_url: str = os.getenv("EMBEDDING_BASE_URL", "http://127.0.0.1:8000/v1")
    embedding_api_key: str = os.getenv("EMBEDDING_API_KEY", "EMPTY")
    embedding_model: str = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
    
    # Server configuration
    server_port: int = int(os.getenv("BRAIN_SERVER_PORT", "9200"))
    server_host: str = os.getenv("BRAIN_SERVER_HOST", "0.0.0.0")

config = BrainConfig()
