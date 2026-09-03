-- ==============================================================================
-- Enterprise Brain: Supabase Schema with pgvector for RAG & Markdown Knowledge Base
-- ==============================================================================

-- 1. Enable the pgvector extension to support vector similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Knowledge Documents Table (High-Level Documents & Raw Ingests)
CREATE TABLE IF NOT EXISTS knowledge_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'text', -- 'text', 'file', 'meeting_notes', 'web', 'chat'
    source_name TEXT,                          -- Original filename or source URI
    raw_content TEXT,                          -- Original unformatted raw input
    summary TEXT,                              -- LLM-generated executive summary
    tags TEXT[] DEFAULT '{}'::TEXT[],          -- Categorization tags
    metadata JSONB DEFAULT '{}'::JSONB,        -- Arbitrary custom metadata (department, author, etc.)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Knowledge Sections Table (Structured Markdown Chunks with Vector Embeddings)
CREATE TABLE IF NOT EXISTS knowledge_sections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    section_index INT NOT NULL DEFAULT 0,
    heading TEXT,                              -- Markdown Section Header (e.g. "## 2. API Endpoints")
    markdown_content TEXT NOT NULL,            -- Formatted & structured markdown chunk
    token_count INT DEFAULT 0,
    embedding vector(1536),                    -- Vector embedding (default 1536 for OpenAI / text-embedding-3 or adaptable)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create HNSW Index for fast vector similarity search (cosine distance)
CREATE INDEX IF NOT EXISTS knowledge_sections_embedding_hnsw_idx 
ON knowledge_sections USING hnsw (embedding vector_cosine_ops);

-- Index for document lookups and fulltext search
CREATE INDEX IF NOT EXISTS knowledge_sections_doc_id_idx ON knowledge_sections(document_id);
CREATE INDEX IF NOT EXISTS knowledge_documents_tags_idx ON knowledge_documents USING gin(tags);

-- 4. Chat History & Conversation Persistence (Multi-Device Sync)
CREATE TABLE IF NOT EXISTS chat_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content TEXT NOT NULL,
    sources JSONB DEFAULT '[]'::JSONB,         -- Citations to knowledge_sections
    metadata JSONB DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS chat_history_session_idx ON chat_history(session_id, created_at ASC);

-- 5. Semantic Search RPC Function (Cosine Distance)
CREATE OR REPLACE FUNCTION match_knowledge_sections (
    query_embedding vector(1536),
    match_threshold FLOAT DEFAULT 0.3,
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
        1 - (ks.embedding <=> query_embedding) AS similarity
    FROM knowledge_sections ks
    JOIN knowledge_documents kd ON ks.document_id = kd.id
    WHERE 1 - (ks.embedding <=> query_embedding) > match_threshold
    ORDER BY ks.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;
