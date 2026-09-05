# ✦ Starpi — Enterprise AI Brain & Knowledge Assistant

> **Live Web App:** [https://starpi-three-iota.vercel.app/](https://starpi-three-iota.vercel.app/) (oder [https://starpi-three.vercel.app/](https://starpi-three.vercel.app/))  
> **Backend & Vektordatenbank:** Dediziertes Supabase-Projekt in Frankfurt am Main (`eu-central-1`, `pgvector` + HNSW-Index)  
> **Architektur:** Vercel (Edge-Gateway) + Supabase (Brain/Cloud-Speicher) + BYOC Lokale Rechenpower (0 € GPU-Cloudkosten)

---

## 🌟 Überblick

**Starpi** ist ein privates Unternehmens-Brain und ein intelligenter Wissensassistent. Es nimmt unstrukturierte Notizen, Meeting-Transkripte und Berichte auf, strukturiert diese automatisch in sauberes, hierarchisches Markdown, speichert sie in einer cloudbasierten PostgreSQL-Vektordatenbank (**Supabase in Frankfurt**) und macht das Wissen über eine blitzschnelle semantische RAG-Suche abrufbar.

### 📱 Features & Architektur
* **BYOC (Bring Your Own Compute) mit Dual-Tier WebGPU:** 
  * **Mobilgeräte (iOS Safari ab 17.4 / Android Chrome ab 121):** *Meta Llama-3.2-1B-Instruct* (705 MB Download, ~879 MB VRAM, 22–35 Token/s) – läuft 100% lokal im mobilen Browser ohne Tab-Abstürze oder Heimrechner!
  * **Desktop & Notebooks:** *Alibaba Qwen2.5-3B-Instruct* (1,85 GB Download, ~2,5 GB VRAM, 77,4 % IFEval) – schlussfolgernde Antworten auf GPT-4-Niveau direkt auf Ihrer GPU.
  * **Optionaler Mac-Tunnel:** Weiterhin kompatibel mit lokalen MLX-Servern (z. B. Qwen 27B / 70B) via P2P-Tunnel.
* **Zero Hosting-Kosten:** Vercel liefert nur wenige Kilobyte statisches HTML/JS aus; die Modellgewichte streamt der Client kostenlos von Hugging Face.
* **Brain Ingestion:** Automatisches Formatieren von Rohtexten mit Überschriften, Kernfakten und Tags.
* **Wissensarchiv:** Durchsuchen und Betrachten aller hinterlegten Dokumente im Volltext.
* **Live RAG-Chat:** Antworten mit Token-Streaming, genauen Quellenangaben, Ähnlichkeitsscores und Zitaten.
* **Datenschutz & EU-Hosting:** 100 % DSGVO-konforme Datenhaltung in Frankfurt (`eu-central-1`). Prompts verbleiben auf dem Endgerät.

---

## 🚀 Schnelleinstieg

### 1. Web-App öffnen
Besuchen Sie einfach **[https://starpi-three-iota.vercel.app/](https://starpi-three-iota.vercel.app/)** in einem beliebigen Browser auf Handy oder Desktop.

### 2. Lokale Entwicklung
```bash
# Repository klonen
git clone https://github.com/umutcantezgel-cpu/Starpi.git
cd Starpi

# Lokalen Webserver starten
npm start
# -> Öffnet http://localhost:3000
```

---

## 🗄️ Datenbank-Architektur (Supabase)
Das Schema befindet sich in `backend/supabase/full_schema.sql` und umfasst:
* `knowledge_documents`: Gesamtdokumente, Zusammenfassungen, Metadaten und Tags.
* `knowledge_sections`: Strukturierte Markdown-Abschnitte mit 1536-dimensionalen Vektoren und schnellem HNSW-Kosinus-Index.
* `chat_history`: Multi-Device Konversationsverlauf.
* `match_knowledge_sections()`: RPC-Funktion für semantische Ähnlichkeitssuche.

---

## 📄 Lizenz
MIT License © 2026 umutcantezgel-cpu