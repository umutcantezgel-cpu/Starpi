-- ==============================================================================
-- Starpi migration 20261101000000: 384-dimensional vectors for on-device ranking
-- ==============================================================================
--
-- Follow-up to 20260923000000, 20260924000000 and 20260924120000 (required
-- first). Optional: the app works without it and then searches the shared
-- library by keywords only (search_knowledge).
--
-- What it does (details in README.md):
--   * knowledge_sections.embedding_384 vector(384), nullable, with an HNSW
--     cosine index. The vectors come from multilingual-e5-small: the library
--     publisher (tools/library-publisher) embeds "passage: " + section text,
--     the browser embeds "query: " + question with the same model on the
--     device, both mean-pooled and L2-normalised.
--   * match_knowledge_vector_384(query_embedding, match_count, match_threshold)
--     ranks the sections the caller can see by cosine similarity. anon may
--     call it, so a visitor can rank the shared library by vector without
--     sending the question text. SECURITY INVOKER: RLS decides what is visible.
--   * ingest_document_atomic also stores an "embedding_384" array per section.
--     Its signature and privileges stay the same.
--
-- Safe to run more than once. Runs in a single transaction. Existing rows are
-- not changed; their embedding_384 stays null until the publisher fills it.
-- ==============================================================================

begin;

set local lock_timeout = '15s';

-- ------------------------------------------------------------------------------
-- 0. Preconditions
-- ------------------------------------------------------------------------------
do $$
begin
    if to_regclass('public.knowledge_sections') is null
       or to_regclass('public.knowledge_documents') is null
       or to_regprocedure('public.search_knowledge(text, integer)') is null
       or to_regprocedure('public.ingest_document_atomic(text, text, text[], text, text, text, jsonb)') is null
       or (
           select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'knowledge_documents'
             and column_name in ('owner_id', 'is_public')
       ) <> 2 then
        raise exception 'Starpi knowledge schema not found: apply migrations/20260923000000_harden_rls_anonymous_auth.sql, 20260924000000_lock_published_rows.sql and 20260924120000_search_knowledge_shared_terms.sql first';
    end if;
end
$$;

-- ------------------------------------------------------------------------------
-- 1. Column and index
-- ------------------------------------------------------------------------------
alter table public.knowledge_sections add column if not exists embedding_384 public.vector(384);

comment on column public.knowledge_sections.embedding_384 is
    'multilingual-e5-small, 384 dimensions, L2-normalised: "passage: " + section text. Queries use "query: " + question with the same model.';

create index if not exists idx_ksections_embedding_384_hnsw on public.knowledge_sections
    using hnsw (embedding_384 public.vector_cosine_ops) with (m = 16, ef_construction = 64);

-- ------------------------------------------------------------------------------
-- 2. Vector ranking for the browser (anon and signed-in users)
-- ------------------------------------------------------------------------------
-- Returns the visible sections most similar to query_embedding, best first,
-- with the columns of search_knowledge plus the cosine similarity. Sections
-- without embedding_384 are never returned; a null query returns no rows; a
-- query of another dimension fails with SQLSTATE 22023. match_count is
-- clamped to 1..20, only rows above match_threshold (default 0) are returned.
-- With the HNSW index the ranking is approximate (it looks at hnsw.ef_search
-- candidates, 40 by default) and RLS filters those candidates, so a caller who
-- can see only a small part of the table may get fewer rows than asked for.
create or replace function public.match_knowledge_vector_384(
    query_embedding public.vector(384),
    match_count integer default 6,
    match_threshold double precision default 0
)
returns table (
    section_id uuid,
    document_id uuid,
    document_title text,
    heading text,
    markdown_content text,
    tags text[],
    similarity double precision
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
    if query_embedding is null then
        return;
    end if;
    if public.vector_dims(query_embedding) <> 384 then
        raise exception 'query_embedding has % dimensions, expected 384', public.vector_dims(query_embedding)
            using errcode = '22023';
    end if;

    return query
        select
            ks.id,
            ks.document_id,
            kd.title,
            ks.heading,
            ks.markdown_content,
            kd.tags,
            (1 - (ks.embedding_384 operator(public.<=>) query_embedding))::double precision
        from public.knowledge_sections ks
        join public.knowledge_documents kd on kd.id = ks.document_id
        where ks.embedding_384 is not null
          and 1 - (ks.embedding_384 operator(public.<=>) query_embedding) > coalesce(match_threshold, 0)
        order by ks.embedding_384 operator(public.<=>) query_embedding
        limit greatest(1, least(coalesce(match_count, 6), 20));
end;
$$;

revoke all on function public.match_knowledge_vector_384(public.vector, integer, double precision)
    from public, anon, authenticated, service_role;
grant execute on function public.match_knowledge_vector_384(public.vector, integer, double precision)
    to anon, authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 3. ingest_document_atomic stores embedding_384 as well
-- ------------------------------------------------------------------------------
-- Atomic ingestion of a document and its sections, used by the library
-- publisher with the service role. SECURITY INVOKER: the service role has the
-- table privileges it needs, and nobody else may execute it. A section's
-- "embedding" (1536) and "embedding_384" are optional; an empty or missing
-- array stores null, an array of another length fails the whole call.
create or replace function public.ingest_document_atomic(
    doc_title text,
    doc_summary text,
    doc_tags text[],
    doc_source_type text,
    doc_source_name text,
    doc_raw_content text,
    sections_data jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
    payload jsonb := coalesce(sections_data, '[]'::jsonb);
    new_doc_id uuid;
begin
    if jsonb_typeof(payload) <> 'array' then
        raise exception 'sections_data must be a JSON array' using errcode = '22023';
    end if;

    insert into public.knowledge_documents (
        title, summary, tags, source_type, source_name, raw_content, total_sections
    ) values (
        doc_title,
        doc_summary,
        coalesce(doc_tags, '{}'::text[]),
        coalesce(doc_source_type, 'text'),
        doc_source_name,
        doc_raw_content,
        jsonb_array_length(payload)
    )
    returning id into new_doc_id;

    insert into public.knowledge_sections (
        document_id, section_index, heading, markdown_content, token_count, embedding, embedding_384
    )
    select
        new_doc_id,
        coalesce((s.elem ->> 'section_index')::integer, (s.ord - 1)::integer),
        s.elem ->> 'heading',
        s.elem ->> 'markdown_content',
        coalesce((s.elem ->> 'token_count')::integer, 0),
        case
            when jsonb_typeof(s.elem -> 'embedding') = 'array'
                 and jsonb_array_length(s.elem -> 'embedding') > 0
            then (s.elem ->> 'embedding')::public.vector(1536)
        end,
        case
            when jsonb_typeof(s.elem -> 'embedding_384') = 'array'
                 and jsonb_array_length(s.elem -> 'embedding_384') > 0
            then (s.elem ->> 'embedding_384')::public.vector(384)
        end
    from jsonb_array_elements(payload) with ordinality as s (elem, ord);

    return new_doc_id;
end;
$$;

revoke all on function public.ingest_document_atomic(text, text, text[], text, text, text, jsonb)
    from public, anon, authenticated, service_role;
grant execute on function public.ingest_document_atomic(text, text, text[], text, text, text, jsonb)
    to service_role;

-- Let PostgREST pick up the new column, function and privileges.
notify pgrst, 'reload schema';

commit;
