# ✦ Starpi — Enterprise AI Brain & Cloud Knowledge Assistant

> **Live Web App:** [https://starpi-three.vercel.app/](https://starpi-three.vercel.app/)  
> **Backend & Vector Database:** Supabase (`pgvector` + HNSW Cosine Indexing)  
> **LLM Engine Support:** AWS Cloud EC2 (vLLM) / Apple Silicon MLX Local

---

## 🌟 Überblick

**Starpi** ist ein privates Unternehmens-Brain und ein intelligenter Wissensassistent. Es nimmt unstrukturierte Notizen, Meeting-Transkripte und Berichte auf, strukturiert diese automatisch in sauberes, hierarchisches Markdown, speichert sie in einer cloudbasierten PostgreSQL-Vektordatenbank (**Supabase**) und macht das Wissen über eine blitzschnelle semantische RAG-Suche abrufbar.

### 📱 Features
* **Multi-Device Web App:** Optimiert für Smartphones (Safari/Chrome) und Desktop-Browser.
* **Brain Ingestion:** Automatisches Formatieren von Rohtexten mit Überschriften, Kernfakten und Tags.
* **Wissensarchiv:** Durchsuchen und Betrachten aller hinterlegten Dokumente im Volltext.
* **Live RAG-Chat:** Antworten mit genauen Quellenangaben, Ähnlichkeitsscores und Zitaten.
* **Datenschutz & Unabhängigkeit:** 100 % private Datenhaltung in der EU (`eu-west-1`), keine unverschlüsselten Schnittstellen zu Drittanbietern.

---

## 🚀 Schnelleinstieg

### 1. Web-App öffnen
Besuchen Sie einfach **[https://starpi-three.vercel.app/](https://starpi-three.vercel.app/)** in einem beliebigen Browser.

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