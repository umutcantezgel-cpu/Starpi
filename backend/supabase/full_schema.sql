-- ==============================================================================
-- Enterprise Brain: Full Supabase Schema & Database Program
-- Version: 2.0.0
-- Includes: pgvector, HNSW indexing, fulltext search, atomic ingestion RPC, RAG match RPC
-- ==============================================================================

-- 1. Required Extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Knowledge Documents (Metadata & Master Documents)
CREATE TABLE IF NOT EXISTS public.knowledge_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'text',     -- 'text', 'file', 'meeting_notes', 'web', 'chat'
    source_name TEXT,                             -- e.g. "Q3_Report.pdf", "Meeting_28Aug.txt"
    raw_content TEXT,                             -- Original raw unstructured data
    summary TEXT,                                 -- LLM-generated executive summary
    tags TEXT[] DEFAULT '{}'::TEXT[],             -- Categorization tags
    metadata JSONB DEFAULT '{}'::JSONB,           -- Department, author, confidentiality
    total_sections INT DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes on Documents
CREATE INDEX IF NOT EXISTS idx_kdocs_created_at ON public.knowledge_documents (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kdocs_tags ON public.knowledge_documents USING GIN (tags);

-- 3. Knowledge Sections (Structured Markdown Chunks + Vector Embeddings)
CREATE TABLE IF NOT EXISTS public.knowledge_sections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES public.knowledge_documents(id) ON DELETE CASCADE,
    section_index INT NOT NULL DEFAULT 0,
    heading TEXT,                                 -- Markdown section header (e.g. "## 2. Budget Details")
    markdown_content TEXT NOT NULL,               -- Clean structured markdown text
    token_count INT DEFAULT 0,
    embedding vector(1536),                       -- Standard 1536-dim vector embedding
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast HNSW Index for Cosine Similarity Search
CREATE INDEX IF NOT EXISTS idx_ksections_embedding_hnsw 
ON public.knowledge_sections USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_ksections_doc_id ON public.knowledge_sections(document_id);

-- 4. Chat History & Memory Table (Multi-Device Conversation Persistence)
CREATE TABLE IF NOT EXISTS public.chat_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content TEXT NOT NULL,
    sources JSONB DEFAULT '[]'::JSONB,            -- Citations & reference section IDs
    metadata JSONB DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chathistory_session ON public.chat_history(session_id, created_at ASC);

-- 5. Enterprise Brain Settings Table (White-label & Tenant Configurations)
CREATE TABLE IF NOT EXISTS public.brain_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert Default Settings
INSERT INTO public.brain_settings (key, value, description)
VALUES 
    ('llm_config', '{"model": "qwen3.8-27b", "temperature": 0.2, "max_tokens": 2048}'::jsonb, 'Global default LLM inference configuration'),
    ('rag_config', '{"match_threshold": 0.2, "match_count": 5, "chunk_size": 1200}'::jsonb, 'RAG retrieval parameters')
ON CONFLICT (key) DO NOTHING;

-- 6. RPC Function: match_knowledge_sections (Fast Vector RAG Retrieval)
CREATE OR REPLACE FUNCTION public.match_knowledge_sections (
    query_embedding vector(1536),
    match_threshold FLOAT DEFAULT 0.25,
    match_count INT DEFAULT 5
)
RETURNS TABLE (
    id UUID,
    document_id UUID,
    document_title TEXT,
    heading TEXT,
    markdown_content TEXT,
    tags TEXT[],
    similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT
        ks.id,
        ks.document_id,
        kd.title AS document_title,
        ks.heading,
        ks.markdown_content,
        kd.tags,
        (1 - (ks.embedding <=> query_embedding))::FLOAT AS similarity
    FROM public.knowledge_sections ks
    JOIN public.knowledge_documents kd ON ks.document_id = kd.id
    WHERE (1 - (ks.embedding <=> query_embedding)) > match_threshold
    ORDER BY ks.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- 7. RPC Function: ingest_document_atomic (Atomic Ingestion of Doc + Sections)
CREATE OR REPLACE FUNCTION public.ingest_document_atomic (
    doc_title TEXT,
    doc_summary TEXT,
    doc_tags TEXT[],
    doc_source_type TEXT,
    doc_source_name TEXT,
    doc_raw_content TEXT,
    sections_data JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    new_doc_id UUID;
    sec_elem JSONB;
BEGIN
    -- 1. Insert master document
    INSERT INTO public.knowledge_documents (
        title, summary, tags, source_type, source_name, raw_content, total_sections
    ) VALUES (
        doc_title, doc_summary, doc_tags, doc_source_type, doc_source_name, doc_raw_content, jsonb_array_length(sections_data)
    ) RETURNING id INTO new_doc_id;

    -- 2. Insert sections
    FOR sec_elem IN SELECT * FROM jsonb_array_elements(sections_data)
    LOOP
        INSERT INTO public.knowledge_sections (
            document_id,
            section_index,
            heading,
            markdown_content,
            token_count,
            embedding
        ) VALUES (
            new_doc_id,
            (sec_elem->>'section_index')::INT,
            sec_elem->>'heading',
            sec_elem->>'markdown_content',
            COALESCE((sec_elem->>'token_count')::INT, 0),
            (sec_elem->>'embedding')::vector
        );
    END LOOP;

    RETURN new_doc_id;
END;
$$;

-- 8. Row Level Security (RLS) & Policies
ALTER TABLE public.knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brain_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read documents" ON public.knowledge_documents FOR SELECT USING (true);
CREATE POLICY "Allow public insert documents" ON public.knowledge_documents FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public update documents" ON public.knowledge_documents FOR UPDATE USING (true);

CREATE POLICY "Allow public read sections" ON public.knowledge_sections FOR SELECT USING (true);
CREATE POLICY "Allow public insert sections" ON public.knowledge_sections FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public all chat_history" ON public.chat_history FOR ALL USING (true);
CREATE POLICY "Allow public read brain_settings" ON public.brain_settings FOR SELECT USING (true);

-- ==============================================================================
-- 9. Enterprise Brain 10x Expansion: Hybrid Search & Knowledge Graph
-- ==============================================================================

-- Fulltext Search Indexes (German)
ALTER TABLE public.knowledge_documents ADD COLUMN IF NOT EXISTS fts tsvector 
  GENERATED ALWAYS AS (to_tsvector('german', coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(raw_content, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_kdocs_fts ON public.knowledge_documents USING GIN (fts);

ALTER TABLE public.knowledge_sections ADD COLUMN IF NOT EXISTS fts tsvector 
  GENERATED ALWAYS AS (to_tsvector('german', coalesce(heading, '') || ' ' || coalesce(markdown_content, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_ksections_fts ON public.knowledge_sections USING GIN (fts);

-- Knowledge Entities & Relations (Knowledge Graph)
CREATE TABLE IF NOT EXISTS public.knowledge_entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    entity_type TEXT NOT NULL, -- 'person', 'project', 'budget', 'technology', 'date', 'topic'
    metadata JSONB DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(name, entity_type)
);

CREATE TABLE IF NOT EXISTS public.knowledge_relations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_entity_id UUID REFERENCES public.knowledge_entities(id) ON DELETE CASCADE,
    target_entity_id UUID REFERENCES public.knowledge_entities(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL, -- 'leads', 'budgeted_at', 'launches_on', 'uses', 'deploys'
    document_id UUID REFERENCES public.knowledge_documents(id) ON DELETE CASCADE,
    section_id UUID REFERENCES public.knowledge_sections(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.knowledge_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_relations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read entities" ON public.knowledge_entities FOR SELECT USING (true);
CREATE POLICY "Allow public insert entities" ON public.knowledge_entities FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow public read relations" ON public.knowledge_relations FOR SELECT USING (true);
CREATE POLICY "Allow public insert relations" ON public.knowledge_relations FOR INSERT WITH CHECK (true);

-- Hybrid Search RPC Function (Reciprocal Rank Fusion - BM25 + Vector)
CREATE OR REPLACE FUNCTION public.match_knowledge_hybrid (
    query_text TEXT,
    query_embedding vector(1536),
    match_count INT DEFAULT 5,
    rrf_k INT DEFAULT 60
)
RETURNS TABLE (
    id UUID,
    document_id UUID,
    document_title TEXT,
    heading TEXT,
    markdown_content TEXT,
    tags TEXT[],
    score FLOAT
)
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    WITH vector_matches AS (
        SELECT 
            ks.id,
            ROW_NUMBER() OVER (ORDER BY ks.embedding <=> query_embedding) as rank
        FROM public.knowledge_sections ks
        WHERE ks.embedding IS NOT NULL
        LIMIT 25
    ),
    text_matches AS (
        SELECT 
            ks.id,
            ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ks.fts, websearch_to_tsquery('german', query_text)) DESC) as rank
        FROM public.knowledge_sections ks
        WHERE ks.fts @@ websearch_to_tsquery('german', query_text)
        LIMIT 25
    )
    SELECT 
        ks.id,
        ks.document_id,
        kd.title AS document_title,
        ks.heading,
        ks.markdown_content,
        kd.tags,
        (
            COALESCE(1.0 / (rrf_k + vm.rank), 0.0) + 
            COALESCE(1.0 / (rrf_k + tm.rank), 0.0)
        )::FLOAT AS score
    FROM public.knowledge_sections ks
    JOIN public.knowledge_documents kd ON ks.document_id = kd.id
    LEFT JOIN vector_matches vm ON ks.id = vm.id
    LEFT JOIN text_matches tm ON ks.id = tm.id
    WHERE vm.rank IS NOT NULL OR tm.rank IS NOT NULL
    ORDER BY score DESC
    LIMIT match_count;
END;
$$;

