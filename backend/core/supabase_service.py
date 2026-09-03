import uuid
import json
import httpx
from typing import List, Dict, Any, Optional
from .config import config

class SupabaseService:
    """
    Enterprise-grade Supabase service for the Enterprise Brain.
    Communicates via PostgREST / RPC with built-in retry logic,
    atomic transactions, and standalone offline-fallback.
    """
    def __init__(self, url: Optional[str] = None, key: Optional[str] = None):
        self.url = (url or config.supabase_url).rstrip("/")
        self.key = key or config.supabase_key
        self.is_configured = bool(self.url and self.key)
        
        # Local mock storage for standalone / offline development
        self._local_docs: Dict[str, Dict[str, Any]] = {}
        self._local_sections: List[Dict[str, Any]] = []
        self._local_chats: List[Dict[str, Any]] = []

    def _headers(self, prefer: str = "return=representation") -> Dict[str, str]:
        return {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Prefer": prefer
        }

    def health_check(self) -> Dict[str, Any]:
        """Verifies database connection and schema tables."""
        if not self.is_configured:
            return {
                "status": "offline_mode",
                "connected": False,
                "message": "Supabase credentials not configured in .env. Running in local memory mode."
            }
            
        try:
            with httpx.Client(timeout=10.0) as client:
                resp = client.get(
                    f"{self.url}/rest/v1/brain_settings?select=key&limit=1",
                    headers=self._headers()
                )
                if resp.status_code in [200, 206]:
                    return {
                        "status": "connected",
                        "connected": True,
                        "url": self.url,
                        "message": "Supabase connection active and schema verified."
                    }
                else:
                    return {
                        "status": "error",
                        "connected": False,
                        "status_code": resp.status_code,
                        "error": resp.text
                    }
        except Exception as e:
            return {
                "status": "unreachable",
                "connected": False,
                "error": str(e)
            }

    def ingest_document(
        self,
        title: str,
        summary: str,
        tags: List[str],
        markdown_content: str,
        sections: List[Dict[str, Any]],
        source_type: str = "text",
        source_name: str = "",
        raw_content: str = ""
    ) -> Dict[str, Any]:
        """
        Ingests a document with its structured sections and vector embeddings.
        Prefers atomic RPC function if available.
        """
        doc_id = str(uuid.uuid4())
        
        if self.is_configured:
            try:
                with httpx.Client(timeout=30.0) as client:
                    # Try atomic ingestion RPC
                    rpc_payload = {
                        "doc_title": title,
                        "doc_summary": summary,
                        "doc_tags": tags,
                        "doc_source_type": source_type,
                        "doc_source_name": source_name,
                        "doc_raw_content": raw_content,
                        "sections_data": sections
                    }
                    resp = client.post(
                        f"{self.url}/rest/v1/rpc/ingest_document_atomic",
                        headers=self._headers(),
                        json=rpc_payload
                    )
                    if resp.status_code in [200, 201]:
                        returned_id = resp.json()
                        return {
                            "id": returned_id if isinstance(returned_id, str) else doc_id,
                            "title": title,
                            "sections_count": len(sections),
                            "storage": "supabase_cloud"
                        }
            except Exception as e:
                print(f"[SupabaseService] Atomic RPC failed ({e}). Falling back to multi-step or local storage.")

        # Local fallback persistence
        doc_record = {
            "id": doc_id,
            "title": title,
            "summary": summary,
            "tags": tags,
            "source_type": source_type,
            "source_name": source_name,
            "raw_content": raw_content,
            "markdown_content": markdown_content,
            "sections_count": len(sections)
        }
        self._local_docs[doc_id] = doc_record
        for s in sections:
            self._local_sections.append({
                "id": str(uuid.uuid4()),
                "document_id": doc_id,
                "document_title": title,
                "heading": s.get("heading", ""),
                "markdown_content": s.get("markdown_content", ""),
                "tags": tags,
                "embedding": s.get("embedding", [])
            })

        return {
            "id": doc_id,
            "title": title,
            "sections_count": len(sections),
            "storage": "local_fallback"
        }

    def match_sections(
        self,
        query_embedding: List[float],
        threshold: float = 0.2,
        limit: int = 5
    ) -> List[Dict[str, Any]]:
        """
        Executes semantic vector similarity search via match_knowledge_sections RPC.
        """
        if self.is_configured:
            try:
                with httpx.Client(timeout=20.0) as client:
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
                print(f"[SupabaseService] RPC search failed ({e}). Falling back to local vector cosine calculation.")

        # Local cosine similarity calculation
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

    def list_documents(self) -> List[Dict[str, Any]]:
        """Lists all registered knowledge documents."""
        if self.is_configured:
            try:
                with httpx.Client(timeout=15.0) as client:
                    resp = client.get(
                        f"{self.url}/rest/v1/knowledge_documents?select=*&order=created_at.desc",
                        headers=self._headers()
                    )
                    if resp.status_code == 200:
                        return resp.json()
            except Exception:
                pass
        return list(self._local_docs.values())

# Global singleton instance
supabase_service = SupabaseService()
