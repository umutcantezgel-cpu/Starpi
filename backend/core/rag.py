import httpx
from typing import Dict, Any, List
from .config import config
from .embeddings import get_embedding
from .supabase_client import db

RAG_SYSTEM_PROMPT = """Du bist das private Unternehmens-Brain ("Enterprise Knowledge Assistant").
Du hast Zugriff auf vertrauliche, interne Unternehmensdokumente und strukturiertes Wissen.

Aufgabe:
Beantworte die Benutzeranfrage präzise, fundiert und ausschließlich auf Basis des bereitgestellten Wissenskontexts.
Falls eine Information nicht im Kontext steht, weise freundlich darauf hin.
Formatiere deine Antwort in sauberem Markdown mit klaren Absätzen, Aufzählungszeichen und nenne die verwendeten Quellen.

---
WISSENSKONTEXT AUS DEM ENTERPRISE BRAIN:
{context}
---
"""

def query_brain(user_query: str) -> Dict[str, Any]:
    """
    Executes RAG retrieval against Supabase and synthesizes response using private LLM.
    """
    if not user_query or not user_query.strip():
        return {
            "answer": "Bitte stellen Sie eine Frage.",
            "sources": []
        }

    # 1. Embed query
    query_vector = get_embedding(user_query)

    # 2. Retrieve top matching sections from Supabase
    matching_sections = db.search_similar_sections(query_vector, threshold=0.15, limit=5)

    # 3. Format Context
    if matching_sections:
        context_parts = []
        for i, match in enumerate(matching_sections, 1):
            doc_title = match.get("document_title", "Dokument")
            heading = match.get("heading", "")
            content = match.get("markdown_content", "")
            context_parts.append(f"[{i}] Dokument: {doc_title} | Abschnitt: {heading}\n{content}\n")
        context_text = "\n".join(context_parts)
    else:
        context_text = "Keine spezifischen Dokumente in der Datenbank gefunden."

    # 4. Generate Answer via Private LLM
    system_prompt = RAG_SYSTEM_PROMPT.format(context=context_text)
    
    payload = {
        "model": config.llm_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_query}
        ],
        "temperature": 0.3,
        "max_tokens": 2048
    }

    try:
        with httpx.Client(timeout=60.0) as client:
            headers = {"Authorization": f"Bearer {config.llm_api_key}"} if config.llm_api_key != "EMPTY" else {}
            resp = client.post(
                f"{config.llm_base_url.rstrip('/')}/chat/completions",
                json=payload,
                headers=headers
            )
            resp.raise_for_status()
            data = resp.json()
            answer = data["choices"][0]["message"]["content"].strip()
            
            return {
                "answer": answer,
                "sources": matching_sections
            }
    except Exception as e:
        return {
            "answer": f"**Hinweis aus dem lokalen Brain-Speicher:**\n\nBasierend auf den gefundenen Dokumenten:\n\n{context_text}",
            "sources": matching_sections,
            "error": str(e)
        }
