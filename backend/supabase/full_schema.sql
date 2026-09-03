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
