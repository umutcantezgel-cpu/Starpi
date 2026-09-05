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

    # 4. Generate Answer via Private LLM or Cloud AI Multi-Key Pools
    system_prompt = RAG_SYSTEM_PROMPT.format(context=context_text)
    full_prompt = f"{system_prompt}\n\nBenutzerfrage: {user_query}"

    # Try Gemini Multi-Key Pool first if available
    gemini_answer = _call_gemini_pool(full_prompt)
    if gemini_answer:
        return {
            "answer": gemini_answer,
            "sources": matching_sections,
            "provider": "gemini_pool"
        }

    # Try OpenRouter Multi-Key Pool next
    openrouter_answer = _call_openrouter_pool(system_prompt, user_query)
    if openrouter_answer:
        return {
            "answer": openrouter_answer,
            "sources": matching_sections,
            "provider": "openrouter_pool"
        }

    # Fallback to local LLM endpoint (MLX/vLLM)
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
                "sources": matching_sections,
                "provider": "local_llm"
            }
    except Exception as e:
        return {
            "answer": f"**Hinweis aus dem lokalen Brain-Speicher:**\n\nBasierend auf den gefundenen Dokumenten:\n\n{context_text}",
            "sources": matching_sections,
            "error": str(e)
        }

_gemini_idx = 0
def _call_gemini_pool(prompt: str) -> str:
    global _gemini_idx
    keys = config.gemini_keys
    if not keys:
        return ""
    
    for _ in range(len(keys)):
        key = keys[_gemini_idx % len(keys)]
        _gemini_idx += 1
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={key}"
        try:
            with httpx.Client(timeout=25.0) as client:
                res = client.post(
                    url,
                    json={"contents": [{"role": "user", "parts": [{"text": prompt}]}]},
                    headers={"Content-Type": "application/json"}
                )
                if res.status_code == 200:
                    data = res.json()
                    parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
                    if parts and "text" in parts[0]:
                        return parts[0]["text"].strip()
        except Exception:
            continue
    return ""

_openrouter_idx = 0
def _call_openrouter_pool(system_prompt: str, user_query: str) -> str:
    global _openrouter_idx
    keys = config.openrouter_keys
    if not keys:
        return ""
    
    models = ["liquid/lfm-2.5-2.6b:free", "nvidia/nemotron-3.5-lightning:free", "google/gemini-2.0-flash-exp:free", "openrouter/auto"]
    
    for _ in range(len(keys)):
        key = keys[_openrouter_idx % len(keys)]
        _openrouter_idx += 1
        for model in models:
            try:
                with httpx.Client(timeout=25.0) as client:
                    res = client.post(
                        "https://openrouter.ai/api/v1/chat/completions",
                        headers={
                            "Authorization": f"Bearer {key}",
                            "Content-Type": "application/json",
                            "HTTP-Referer": "https://starpi-three.vercel.app/",
                            "X-Title": "Starpi Enterprise Brain"
                        },
                        json={
                            "model": model,
                            "messages": [
                                {"role": "system", "content": system_prompt},
                                {"role": "user", "content": user_query}
                            ],
                            "temperature": 0.5,
                            "max_tokens": 1024
                        }
                    )
                    if res.status_code == 200:
                        data = res.json()
                        choices = data.get("choices", [])
                        if choices and "message" in choices[0]:
                            return choices[0]["message"].get("content", "").strip()
            except Exception:
                continue
    return ""
