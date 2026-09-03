import json
import httpx
from typing import Dict, Any, List
from .config import config

STRUCTURING_PROMPT = """Du bist ein hochpräziser KI-Wissens-Architekt ("Enterprise Brain Ingestion Engine").
Deine Aufgabe ist es, unstrukturierte Rohdaten (Notizen, Berichte, Chat-Dumps, Meeting-Transkripte, Dokumente) aufzunehmen, Füllwörter zu entfernen, logisch zu ordnen und in ein professionelles, sauberes Markdown-Dokument umzuwandeln.

Erstelle aus dem folgenden Rohtext eine perfekte Markdown-Struktur und antworte AUSSCHLIESSLICH im folgenden JSON-Format:

```json
{
  "title": "Prägnanter Dokumententitel",
  "summary": "2-3 Sätze Zusammenfassung der Kernfakten",
  "tags": ["Kategorie1", "Schlagwort2", "Thema3"],
  "markdown": "# Titel\\n\\n## 1. Überblick & Kernaussagen\\n- Punkt A\\n\\n## 2. Details & Spezifikationen\\n| Eigenschaft | Wert |\\n|---|---|\\n\\n## 3. Handlungsempfehlungen / To-Dos\\n..."
}
```

Richtlinien für das Markdown:
1. Nutze klare Hierarchien (`#`, `##`, `###`).
2. Hebe Schlüsselbegriffe **fett** hervor.
3. Verwende Tabellen und Listen für Zahlen, Parameter und Vergleiche.
4. Behalte alle Fakten, Daten, Namen und technischen Spezifikationen verlustfrei bei.
"""

def structure_raw_content(raw_text: str, source_name: str = "") -> Dict[str, Any]:
    """
    Sends raw unstructured content to the LLM to convert it into structured Markdown with metadata.
    """
    if not raw_text or not raw_text.strip():
        return {
            "title": source_name or "Leeres Dokument",
            "summary": "Kein Inhalt vorhanden.",
            "tags": ["empty"],
            "markdown": "# Leeres Dokument\n\nKeine Daten übergeben."
        }

    user_message = f"Quelldatei / Kontext: {source_name}\n\nRohtext:\n{raw_text.strip()}"
    
    payload = {
        "model": config.llm_model,
        "messages": [
            {"role": "system", "content": STRUCTURING_PROMPT},
            {"role": "user", "content": user_message}
        ],
        "temperature": 0.2,
        "max_tokens": 3000
    }
    
    try:
        with httpx.Client(timeout=120.0) as client:
            headers = {"Authorization": f"Bearer {config.llm_api_key}"} if config.llm_api_key != "EMPTY" else {}
            response = client.post(
                f"{config.llm_base_url.rstrip('/')}/chat/completions",
                json=payload,
                headers=headers
            )
            response.raise_for_status()
            data = response.json()
            content = data["choices"][0]["message"]["content"].strip()
            
            # Extract JSON block if surrounded by markdown fences
            if "```json" in content:
                content = content.split("```json", 1)[1].split("```", 1)[0].strip()
            elif "```" in content:
                content = content.split("```", 1)[1].split("```", 1)[0].strip()
            
            structured = json.loads(content)
            return {
                "title": structured.get("title", source_name or "Unbenanntes Dokument"),
                "summary": structured.get("summary", ""),
                "tags": structured.get("tags", []),
                "markdown": structured.get("markdown", raw_text)
            }
    except Exception as e:
        # Graceful fallback: basic markdown generation
        first_line = raw_text.strip().split("\n")[0][:60]
        return {
            "title": source_name or first_line or "Dokument",
            "summary": raw_text[:200] + "...",
            "tags": ["auto-ingest", "raw"],
            "markdown": f"# {source_name or 'Dokument'}\n\n{raw_text}"
        }
