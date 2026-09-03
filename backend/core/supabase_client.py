import uuid
import json
import httpx
from typing import List, Dict, Any, Optional
from .config import config

class SupabaseBrainClient:
    def __init__(self):
        self.url = config.supabase_url.rstrip("/")
        self.key = config.supabase_key
        self.is_live = bool(self.url and self.key)
        
        # Local mock storage for offline / standalone prototype mode
        self._local_docs: Dict[str, Dict[str, Any]] = {}
        self._local_sections: List[Dict[str, Any]] = []

    def _headers(self) -> Dict[str, str]:
        return {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation"
        }

    def save_document(
        self,
        title: str,
        summary: str,
        tags: List[str],
        source_type: str = "text",
        source_name: str = "",
        raw_content: str = "",
        sections: Optional[List[Dict[str, Any]]] = None
    ) -> Dict[str, Any]:
        """
        Saves a document and its structured markdown sections with vector embeddings into Supabase.
        """
        doc_id = str(uuid.uuid4())
        doc_record = {
            "id": doc_id,
            "title": title,
            "summary": summary,
            "tags": tags,
            "source_type": source_type,
            "source_name": source_name,
            "raw_content": raw_content
        }

        if self.is_live:
            try:
                with httpx.Client(timeout=30.0) as client:
                    # 1. Insert Document
                    resp = client.post(
                        f"{self.url}/rest/v1/knowledge_documents",
                        headers=self._headers(),
                        json=doc_record
                    )
                    resp.raise_for_status()
                    created_doc = resp.json()[0] if isinstance(resp.json(), list) else resp.json()

                    # 2. Insert Sections with Embeddings
                    if sections:
                        sec_records = []
                        for sec in sections:
                            sec_records.append({
                                "document_id": created_doc["id"],
                                "section_index": sec.get("section_index", 0),
                                "heading": sec.get("heading", ""),
                                "markdown_content": sec.get("markdown_content", ""),
                                "token_count": sec.get("token_count", 0),
                                "embedding": sec.get("embedding", [])
                            })
                        sec_resp = client.post(
                            f"{self.url}/rest/v1/knowledge_sections",
                            headers=self._headers(),
                            json=sec_records
                        )
                        sec_resp.raise_for_status()
                    return created_doc
            except Exception as e:
                print(f"[SupabaseClient] Warning: Live Supabase call failed ({e}). Falling back to local storage.")

        # Local in-memory persistence fallback
        self._local_docs[doc_id] = doc_record
        if sections:
            for sec in sections:
                self._local_sections.append({
                    "id": str(uuid.uuid4()),
                    "document_id": doc_id,
                    "document_title": title,
                    "heading": sec.get("heading", ""),
                    "markdown_content": sec.get("markdown_content", ""),
                    "tags": tags,
                    "embedding": sec.get("embedding", [])
                })
        return doc_record

    def list_documents(self) -> List[Dict[str, Any]]:
        """Returns all registered knowledge documents."""
        if self.is_live:
            try:
                with httpx.Client(timeout=30.0) as client:
                    resp = client.get(
                        f"{self.url}/rest/v1/knowledge_documents?select=*&order=created_at.desc",
                        headers=self._headers()
                    )
                    if resp.status_code == 200:
                        return resp.json()
            except Exception:
                pass
        return list(self._local_docs.values())

    def search_similar_sections(
        self,
        query_embedding: List[float],
        threshold: float = 0.2,
        limit: int = 4
    ) -> List[Dict[str, Any]]:
        """
        Executes semantic vector search via match_knowledge_sections RPC in Supabase.
        """
        if self.is_live:
            try:
                with httpx.Client(timeout=30.0) as client:
                    payload = {
                        "query_embedding": query_embedding,
                        "match_threshold": threshold,
                        "match_count": limit
                    }
                    resp = client.post(
                        f"{self.url}/rest/v1/rpc/match_knowledge_sections",
                        headers=self._headers(),
                        json=payload
                    )
                    if resp.status_code == 200:
                        return resp.json()
            except Exception as e:
                print(f"[SupabaseClient] RPC search failed ({e}). Falling back to local cosine calculation.")

        # Local cosine similarity fallback
        results = []
        for sec in self._local_sections:
            sec_emb = sec.get("embedding", [])
            if len(sec_emb) == len(query_embedding):
                dot_prod = sum(a * b for a, b in zip(sec_emb, query_embedding))
                if dot_prod > threshold:
                    results.append({
                        "id": sec["id"],
                        "document_id": sec["document_id"],
                        "document_title": sec["document_title"],
                        "heading": sec["heading"],
                        "markdown_content": sec["markdown_content"],
                        "tags": sec.get("tags", []),
                        "similarity": round(float(dot_prod), 4)
                    })
        results.sort(key=lambda x: x["similarity"], reverse=True)
        return results[:limit]

# Singleton instance
db = SupabaseBrainClient()
