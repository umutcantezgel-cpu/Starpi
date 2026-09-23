-- ==============================================================================
-- Starpi: full Supabase schema (fresh install)
-- ==============================================================================
--
-- Canonical schema for a new Supabase project: knowledge base (documents,
-- sections with 1536-dim pgvector embeddings and an HNSW index, German
-- full-text search), knowledge graph, chat history, settings and the RPCs
-- used by the browser and the backend.
--
-- Existing databases are upgraded with the files in migrations/ instead; this
-- file refuses to run on a pre-hardening schema. After a fresh install the
-- migrations are no-ops, and the resulting schema is identical to an
-- upgraded one (backend/supabase/tests/run_rls_tests.sh checks this; column
-- order therefore follows the upgrade path).
--
-- Security model (details in README.md):
--   * The browser uses the anon key and Supabase anonymous sign-ins. Signed-in
--     clients have the role "authenticated" and only reach their own rows.
--   * The backend uses the service role, which bypasses RLS.
--   * Knowledge rows are public (is_public, set by the service role) or
--     private to owner_id. Published rows are read-only for browser roles.
--     chat_history is always private to its owner; brain_settings is service
--     role only.
--   * CHECK constraints bound the size of every column the browser can write.
--
-- Prerequisite: Authentication > Sign In / Providers > Anonymous sign-ins.
--
-- Known advisor warning: "extension_in_public" for vector. The extension is
-- kept in schema public so this schema matches existing installs.
--
-- Safe to re-run on a database created by this file. Runs in one transaction.
-- ==============================================================================

begin;

-- ------------------------------------------------------------------------------
-- 0. Extensions and preconditions
-- ------------------------------------------------------------------------------
create extension if not exists vector with schema public;

do $$
declare
    vector_schema name;
    tbl text;
begin
    select n.nspname into vector_schema
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'vector';

    if vector_schema is distinct from 'public' then
        raise exception 'Starpi expects the vector extension in schema public, found it in %', vector_schema;
    end if;

    if to_regclass('auth.users') is null or to_regprocedure('auth.uid()') is null then
        raise exception 'auth.users / auth.uid() not found: run this schema on a Supabase database';
    end if;

    foreach tbl in array array['knowledge_documents', 'knowledge_entities', 'knowledge_relations', 'chat_history'] loop
        if to_regclass('public.' || tbl) is not null and not exists (
            select 1 from information_schema.columns
            where table_schema = 'public' and table_name = tbl and column_name = 'owner_id'
        ) then
            raise exception 'public.% comes from an older Starpi schema: apply the files in migrations/ (in file-name order) instead of full_schema.sql', tbl;
        end if;
    end loop;
end
$$;

-- ------------------------------------------------------------------------------
-- 1. Knowledge documents
-- ------------------------------------------------------------------------------
create table if not exists public.knowledge_documents (
    id uuid primary key default gen_random_uuid(),
    title text not null,
    source_type text not null default 'text',   -- 'text', 'file', 'meeting_notes', 'web', 'chat'
    source_name text,                            -- file name or source URI
    raw_content text,                            -- original unstructured input
    summary text,
    tags text[] default '{}'::text[],
    metadata jsonb default '{}'::jsonb,
    total_sections integer default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    -- null for rows written by the service role (backend)
    owner_id uuid default auth.uid() references auth.users (id) on delete set null,
    -- public rows are readable by everyone; only the service role can publish
    is_public boolean not null default false,
    fts tsvector generated always as (
        to_tsvector('german', coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(raw_content, ''))
    ) stored
);

-- ------------------------------------------------------------------------------
-- 2. Knowledge sections (markdown chunks + embeddings)
-- ------------------------------------------------------------------------------
create table if not exists public.knowledge_sections (
    id uuid primary key default gen_random_uuid(),
    document_id uuid not null references public.knowledge_documents (id) on delete cascade,
    section_index integer not null default 0,
    heading text,
    markdown_content text not null,
    token_count integer default 0,
    embedding public.vector(1536),               -- null until an embedding is computed
    created_at timestamptz not null default now(),
    fts tsvector generated always as (
        to_tsvector('german', coalesce(heading, '') || ' ' || coalesce(markdown_content, ''))
    ) stored
);

-- ------------------------------------------------------------------------------
-- 3. Chat history (private to the signed-in user)
-- ------------------------------------------------------------------------------
create table if not exists public.chat_history (
    id uuid primary key default gen_random_uuid(),
    session_id text not null,
    role text not null,
    content text not null,
    sources jsonb not null default '[]'::jsonb,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
    constraint chat_history_role_check check (role in ('user', 'assistant', 'system')),
    constraint chat_history_session_id_length check (char_length(session_id) between 1 and 128),
    constraint chat_history_content_length check (char_length(content) <= 100000),
    constraint chat_history_sources_size check (octet_length(sources::text) <= 65536),
    constraint chat_history_metadata_size check (octet_length(metadata::text) <= 65536)
);

-- ------------------------------------------------------------------------------
-- 4. Settings
-- ------------------------------------------------------------------------------
create table if not exists public.brain_settings (
    key text primary key,
    value jsonb not null,
    description text,
    updated_at timestamptz not null default now()
);

insert into public.brain_settings (key, value, description)
values
    ('llm_config', '{"model": "qwen3.8-27b", "temperature": 0.2, "max_tokens": 2048}'::jsonb, 'Global default LLM inference configuration'),
    ('rag_config', '{"match_threshold": 0.2, "match_count": 5, "chunk_size": 1200}'::jsonb, 'RAG retrieval parameters')
on conflict (key) do nothing;

-- ------------------------------------------------------------------------------
-- 5. Knowledge graph
-- ------------------------------------------------------------------------------
create table if not exists public.knowledge_entities (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    entity_type text not null,                   -- 'person', 'project', 'metric', 'tech', ...
    description text,
    properties jsonb default '{}'::jsonb,
    owner_id uuid default auth.uid() references auth.users (id) on delete set null,
    is_public boolean not null default false,
    created_at timestamptz not null default now()
);

create table if not exists public.knowledge_relations (
    id uuid primary key default gen_random_uuid(),
    source_entity_id uuid references public.knowledge_entities (id) on delete cascade,
    target_entity_id uuid references public.knowledge_entities (id) on delete cascade,
    relation_type text not null,                 -- 'leads', 'budgeted_at', 'uses', ...
    properties jsonb default '{}'::jsonb,
    owner_id uuid default auth.uid() references auth.users (id) on delete set null,
    is_public boolean not null default false,
    created_at timestamptz not null default now()
);

-- ------------------------------------------------------------------------------
-- 6. Size limits for browser writes
-- ------------------------------------------------------------------------------
-- Limits (characters unless noted), above what the PWA and the backend send:
--   documents: title 500, source_type 64, source_name 500, summary 5000,
--              raw_content 200000 (PWA and backend ingest limit), at most 50
--              tags / 16 KiB, metadata 64 KiB of JSON
--   sections:  heading 1000, markdown_content 210000 (a whole document plus
--              the Markdown frame the PWA adds)
--   entities:  name 500, entity_type 64, description 5000, properties 64 KiB
--   relations: relation_type 64, properties 64 KiB (there is no description)
--   chat_history: content 20000 (chat_history_content_length above is the
--              older 100000 bound)
-- Added NOT VALID exactly like migrations/20260924000000_lock_published_rows.sql
-- does on existing databases, so both schemas stay identical. NOT VALID only
-- skips the check of rows that exist when the constraint is added; every new
-- or updated row is checked.
do $$
declare
    c record;
begin
    for c in
        select * from (values
            ('knowledge_documents', 'knowledge_documents_title_max_length', 'char_length(title) <= 500'),
            ('knowledge_documents', 'knowledge_documents_source_type_max_length', 'char_length(source_type) <= 64'),
            ('knowledge_documents', 'knowledge_documents_source_name_max_length', 'char_length(source_name) <= 500'),
            ('knowledge_documents', 'knowledge_documents_summary_max_length', 'char_length(summary) <= 5000'),
            ('knowledge_documents', 'knowledge_documents_raw_content_max_length', 'char_length(raw_content) <= 200000'),
            ('knowledge_documents', 'knowledge_documents_tags_max_size', 'cardinality(tags) <= 50 and octet_length(tags::text) <= 16384'),
            ('knowledge_documents', 'knowledge_documents_metadata_max_size', 'octet_length(metadata::text) <= 65536'),
            ('knowledge_sections', 'knowledge_sections_heading_max_length', 'char_length(heading) <= 1000'),
            ('knowledge_sections', 'knowledge_sections_markdown_content_max_length', 'char_length(markdown_content) <= 210000'),
            ('knowledge_entities', 'knowledge_entities_name_max_length', 'char_length(name) <= 500'),
            ('knowledge_entities', 'knowledge_entities_entity_type_max_length', 'char_length(entity_type) <= 64'),
            ('knowledge_entities', 'knowledge_entities_description_max_length', 'char_length(description) <= 5000'),
            ('knowledge_entities', 'knowledge_entities_properties_max_size', 'octet_length(properties::text) <= 65536'),
            ('knowledge_relations', 'knowledge_relations_relation_type_max_length', 'char_length(relation_type) <= 64'),
            ('knowledge_relations', 'knowledge_relations_properties_max_size', 'octet_length(properties::text) <= 65536'),
            ('chat_history', 'chat_history_content_max_length', 'char_length(content) <= 20000')
        ) as v (table_name, constraint_name, check_expression)
    loop
        if not exists (
            select 1 from pg_constraint
            where conrelid = ('public.' || c.table_name)::regclass
              and conname = c.constraint_name
        ) then
            execute format('alter table public.%I add constraint %I check (%s) not valid',
                           c.table_name, c.constraint_name, c.check_expression);
        end if;
    end loop;
end
$$;

-- ------------------------------------------------------------------------------
-- 7. Indexes
-- ------------------------------------------------------------------------------
create index if not exists idx_kdocs_created_at on public.knowledge_documents (created_at desc);
create index if not exists idx_kdocs_tags on public.knowledge_documents using gin (tags);
create index if not exists idx_kdocs_owner_id on public.knowledge_documents (owner_id);
create index if not exists idx_kdocs_fts on public.knowledge_documents using gin (fts);

create index if not exists idx_ksections_embedding_hnsw on public.knowledge_sections
    using hnsw (embedding public.vector_cosine_ops) with (m = 16, ef_construction = 64);
create index if not exists idx_ksections_doc_id on public.knowledge_sections (document_id);
create index if not exists idx_ksections_fts on public.knowledge_sections using gin (fts);

create index if not exists idx_chathistory_owner_session on public.chat_history (owner_id, session_id, created_at);

create index if not exists idx_kentities_owner_id on public.knowledge_entities (owner_id);
create index if not exists idx_krelations_owner_id on public.knowledge_relations (owner_id);
create index if not exists idx_krelations_source on public.knowledge_relations (source_entity_id);
create index if not exists idx_krelations_target on public.knowledge_relations (target_entity_id);

-- ------------------------------------------------------------------------------
-- 8. Row level security
-- ------------------------------------------------------------------------------
alter table public.knowledge_documents enable row level security;
alter table public.knowledge_sections enable row level security;
alter table public.knowledge_entities enable row level security;
alter table public.knowledge_relations enable row level security;
alter table public.chat_history enable row level security;
alter table public.brain_settings enable row level security;

-- Re-run: drop the policies created below, then anything else on these
-- tables (an extra permissive policy would be OR-ed with them).
drop policy if exists knowledge_documents_select_public_or_own on public.knowledge_documents;
drop policy if exists knowledge_documents_insert_own on public.knowledge_documents;
drop policy if exists knowledge_documents_update_own on public.knowledge_documents;
drop policy if exists knowledge_documents_delete_own on public.knowledge_documents;
drop policy if exists knowledge_sections_select_visible_document on public.knowledge_sections;
drop policy if exists knowledge_sections_insert_own_document on public.knowledge_sections;
drop policy if exists knowledge_sections_update_own_document on public.knowledge_sections;
drop policy if exists knowledge_sections_delete_own_document on public.knowledge_sections;
drop policy if exists knowledge_entities_select_public_or_own on public.knowledge_entities;
drop policy if exists knowledge_entities_insert_own on public.knowledge_entities;
drop policy if exists knowledge_entities_update_own on public.knowledge_entities;
drop policy if exists knowledge_entities_delete_own on public.knowledge_entities;
drop policy if exists knowledge_relations_select_public_or_own on public.knowledge_relations;
drop policy if exists knowledge_relations_insert_own on public.knowledge_relations;
drop policy if exists knowledge_relations_update_own on public.knowledge_relations;
drop policy if exists knowledge_relations_delete_own on public.knowledge_relations;
drop policy if exists chat_history_select_own on public.chat_history;
drop policy if exists chat_history_insert_own on public.chat_history;
drop policy if exists chat_history_delete_own on public.chat_history;
drop policy if exists brain_settings_select_all on public.brain_settings;

do $$
declare
    pol record;
begin
    for pol in
        select tablename, policyname
        from pg_policies
        where schemaname = 'public'
          and tablename in ('knowledge_documents', 'knowledge_sections', 'knowledge_entities',
                            'knowledge_relations', 'chat_history', 'brain_settings')
    loop
        raise notice 'dropping unexpected policy % on public.%', pol.policyname, pol.tablename;
        execute format('drop policy %I on public.%I', pol.policyname, pol.tablename);
    end loop;
end
$$;

-- knowledge_documents: public rows for everyone, private rows for the owner.
-- The browser can never publish (is_public = true is service role only), and
-- once the service role has published a row it is read-only for its owner.
create policy knowledge_documents_select_public_or_own on public.knowledge_documents
    for select to anon, authenticated
    using (is_public or owner_id = (select auth.uid()));

create policy knowledge_documents_insert_own on public.knowledge_documents
    for insert to authenticated
    with check (owner_id = (select auth.uid()) and is_public = false);

create policy knowledge_documents_update_own on public.knowledge_documents
    for update to authenticated
    using (owner_id = (select auth.uid()) and not is_public)
    with check (owner_id = (select auth.uid()) and is_public = false);

create policy knowledge_documents_delete_own on public.knowledge_documents
    for delete to authenticated
    using (owner_id = (select auth.uid()) and not is_public);

-- knowledge_sections: visible with the parent document, writable only while
-- the parent is own and private.
create policy knowledge_sections_select_visible_document on public.knowledge_sections
    for select to anon, authenticated
    using (exists (
        select 1 from public.knowledge_documents d
        where d.id = knowledge_sections.document_id
          and (d.is_public or d.owner_id = (select auth.uid()))
    ));

create policy knowledge_sections_insert_own_document on public.knowledge_sections
    for insert to authenticated
    with check (exists (
        select 1 from public.knowledge_documents d
        where d.id = knowledge_sections.document_id
          and d.owner_id = (select auth.uid())
          and not d.is_public
    ));

create policy knowledge_sections_update_own_document on public.knowledge_sections
    for update to authenticated
    using (exists (
        select 1 from public.knowledge_documents d
        where d.id = knowledge_sections.document_id
          and d.owner_id = (select auth.uid())
          and not d.is_public
    ))
    with check (exists (
        select 1 from public.knowledge_documents d
        where d.id = knowledge_sections.document_id
          and d.owner_id = (select auth.uid())
          and not d.is_public
    ));

create policy knowledge_sections_delete_own_document on public.knowledge_sections
    for delete to authenticated
    using (exists (
        select 1 from public.knowledge_documents d
        where d.id = knowledge_sections.document_id
          and d.owner_id = (select auth.uid())
          and not d.is_public
    ));

-- knowledge_entities: same pattern as documents.
create policy knowledge_entities_select_public_or_own on public.knowledge_entities
    for select to anon, authenticated
    using (is_public or owner_id = (select auth.uid()));

create policy knowledge_entities_insert_own on public.knowledge_entities
    for insert to authenticated
    with check (owner_id = (select auth.uid()) and is_public = false);

create policy knowledge_entities_update_own on public.knowledge_entities
    for update to authenticated
    using (owner_id = (select auth.uid()) and not is_public)
    with check (owner_id = (select auth.uid()) and is_public = false);

create policy knowledge_entities_delete_own on public.knowledge_entities
    for delete to authenticated
    using (owner_id = (select auth.uid()) and not is_public);

-- knowledge_relations: same pattern; both endpoints must be visible to the
-- writer, so a relation cannot point at someone else's private entity.
create policy knowledge_relations_select_public_or_own on public.knowledge_relations
    for select to anon, authenticated
    using (is_public or owner_id = (select auth.uid()));

create policy knowledge_relations_insert_own on public.knowledge_relations
    for insert to authenticated
    with check (
        owner_id = (select auth.uid())
        and is_public = false
        and exists (
            select 1 from public.knowledge_entities e
            where e.id = knowledge_relations.source_entity_id
              and (e.is_public or e.owner_id = (select auth.uid()))
        )
        and exists (
            select 1 from public.knowledge_entities e
            where e.id = knowledge_relations.target_entity_id
              and (e.is_public or e.owner_id = (select auth.uid()))
        )
    );

create policy knowledge_relations_update_own on public.knowledge_relations
    for update to authenticated
    using (owner_id = (select auth.uid()) and not is_public)
    with check (
        owner_id = (select auth.uid())
        and is_public = false
        and exists (
            select 1 from public.knowledge_entities e
            where e.id = knowledge_relations.source_entity_id
              and (e.is_public or e.owner_id = (select auth.uid()))
        )
        and exists (
            select 1 from public.knowledge_entities e
            where e.id = knowledge_relations.target_entity_id
              and (e.is_public or e.owner_id = (select auth.uid()))
        )
    );

create policy knowledge_relations_delete_own on public.knowledge_relations
    for delete to authenticated
    using (owner_id = (select auth.uid()) and not is_public);

-- chat_history: owner only, no UPDATE, nothing for anon.
create policy chat_history_select_own on public.chat_history
    for select to authenticated
    using (owner_id = (select auth.uid()));

create policy chat_history_insert_own on public.chat_history
    for insert to authenticated
    with check (owner_id = (select auth.uid()));

create policy chat_history_delete_own on public.chat_history
    for delete to authenticated
    using (owner_id = (select auth.uid()));

-- brain_settings: no policy. The browser never reads it; the backend uses the
-- service role, which bypasses RLS.

-- ------------------------------------------------------------------------------
-- 9. Functions
-- ------------------------------------------------------------------------------
-- Re-run: drop every overload before creating the current definitions.
do $$
declare
    fn regprocedure;
begin
    for fn in
        select p.oid::regprocedure
        from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and p.proname in ('match_knowledge_sections', 'match_knowledge_hybrid',
                            'ingest_document_atomic', 'search_knowledge')
    loop
        execute format('drop function %s', fn);
    end loop;
end
$$;

-- Vector similarity search for the backend and signed-in clients. Runs as the
-- caller, so RLS limits results to visible sections.
create function public.match_knowledge_sections(
    query_embedding public.vector(1536),
    match_threshold double precision default 0.25,
    match_count integer default 5
)
returns table (
    id uuid,
    document_id uuid,
    document_title text,
    heading text,
    markdown_content text,
    tags text[],
    similarity double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
    select
        ks.id,
        ks.document_id,
        kd.title as document_title,
        ks.heading,
        ks.markdown_content,
        kd.tags,
        1 - (ks.embedding operator(public.<=>) query_embedding) as similarity
    from public.knowledge_sections ks
    join public.knowledge_documents kd on kd.id = ks.document_id
    where ks.embedding is not null
      and 1 - (ks.embedding operator(public.<=>) query_embedding) > match_threshold
    order by ks.embedding operator(public.<=>) query_embedding
    limit greatest(1, least(coalesce(match_count, 5), 50));
$$;

-- Hybrid search: reciprocal rank fusion of vector and German full-text ranks.
create function public.match_knowledge_hybrid(
    query_text text,
    query_embedding public.vector(1536),
    match_count integer default 5,
    rrf_k integer default 60
)
returns table (
    id uuid,
    document_id uuid,
    document_title text,
    heading text,
    markdown_content text,
    tags text[],
    score double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
    with vector_matches as (
        select v.id, row_number() over (order by v.distance) as rank
        from (
            select ks.id, ks.embedding operator(public.<=>) query_embedding as distance
            from public.knowledge_sections ks
            where ks.embedding is not null
              and query_embedding is not null
            order by ks.embedding operator(public.<=>) query_embedding
            limit 25
        ) v
    ),
    terms as (
        select websearch_to_tsquery('german', query_text) as tsq
        where btrim(coalesce(query_text, '')) <> ''
    ),
    text_matches as (
        select t.id, row_number() over (order by t.text_rank desc) as rank
        from (
            select ks.id, ts_rank_cd(ks.fts, terms.tsq) as text_rank
            from terms
            join public.knowledge_sections ks on ks.fts @@ terms.tsq
            order by text_rank desc
            limit 25
        ) t
    ),
    candidates as (
        select vector_matches.id from vector_matches
        union
        select text_matches.id from text_matches
    )
    select
        ks.id,
        ks.document_id,
        kd.title as document_title,
        ks.heading,
        ks.markdown_content,
        kd.tags,
        (coalesce(1.0 / (coalesce(rrf_k, 60) + vm.rank), 0.0)
         + coalesce(1.0 / (coalesce(rrf_k, 60) + tm.rank), 0.0))::double precision as score
    from candidates c
    join public.knowledge_sections ks on ks.id = c.id
    join public.knowledge_documents kd on kd.id = ks.document_id
    left join vector_matches vm on vm.id = c.id
    left join text_matches tm on tm.id = c.id
    order by score desc
    limit greatest(1, least(coalesce(match_count, 5), 50));
$$;

-- German full-text search for the browser (anon and signed-in users). Returns
-- the best matching sections; a document that matches only on title, summary
-- or raw text is returned with its first section, or with section fields set
-- to null (markdown_content falls back to the summary) when it has none.
-- Blank queries return no rows. RLS decides what is visible.
create function public.search_knowledge(
    query_text text,
    match_count integer default 6
)
returns table (
    section_id uuid,
    document_id uuid,
    document_title text,
    heading text,
    markdown_content text,
    tags text[],
    rank real
)
language sql
stable
security invoker
set search_path = ''
as $$
    with terms as (
        select websearch_to_tsquery('german', query_text) as tsq
        where btrim(coalesce(query_text, '')) <> ''
    ),
    section_hits as (
        select
            ks.id as section_id,
            ks.document_id,
            kd.title as document_title,
            ks.heading,
            ks.markdown_content,
            kd.tags,
            ts_rank_cd(ks.fts, terms.tsq) as rank,
            ks.section_index
        from terms
        join public.knowledge_sections ks on ks.fts @@ terms.tsq
        join public.knowledge_documents kd on kd.id = ks.document_id
    ),
    document_hits as (
        select
            first_section.id as section_id,
            kd.id as document_id,
            kd.title as document_title,
            first_section.heading,
            coalesce(first_section.markdown_content, kd.summary, left(kd.raw_content, 2000)) as markdown_content,
            kd.tags,
            ts_rank_cd(kd.fts, terms.tsq) as rank,
            coalesce(first_section.section_index, 0) as section_index
        from terms
        join public.knowledge_documents kd on kd.fts @@ terms.tsq
        left join lateral (
            select s.id, s.heading, s.markdown_content, s.section_index
            from public.knowledge_sections s
            where s.document_id = kd.id
            order by s.section_index, s.created_at
            limit 1
        ) first_section on true
        where not exists (
            select 1 from section_hits sh where sh.document_id = kd.id
        )
    )
    select h.section_id, h.document_id, h.document_title, h.heading, h.markdown_content, h.tags, h.rank
    from (
        select * from section_hits
        union all
        select * from document_hits
    ) h
    order by h.rank desc, h.document_title, h.section_index
    limit greatest(1, least(coalesce(match_count, 6), 20));
$$;

-- Atomic ingestion of a document and its sections, used by the backend with
-- the service role. SECURITY INVOKER: the service role has the table
-- privileges it needs, and nobody else may execute it.
create function public.ingest_document_atomic(
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
        document_id, section_index, heading, markdown_content, token_count, embedding
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
        end
    from jsonb_array_elements(payload) with ordinality as s (elem, ord);

    return new_doc_id;
end;
$$;

-- ------------------------------------------------------------------------------
-- 10. Privileges
-- ------------------------------------------------------------------------------
-- Supabase grants everything on new objects to anon / authenticated /
-- service_role by default; start from nothing and grant what is needed.
revoke all on table
    public.knowledge_documents, public.knowledge_sections, public.knowledge_entities,
    public.knowledge_relations, public.chat_history, public.brain_settings
    from public, anon, authenticated, service_role;

grant select on table
    public.knowledge_documents, public.knowledge_sections, public.knowledge_entities,
    public.knowledge_relations
    to anon;

grant select, insert, update, delete on table
    public.knowledge_documents, public.knowledge_sections, public.knowledge_entities,
    public.knowledge_relations
    to authenticated;
grant select, insert, delete on table public.chat_history to authenticated;

grant select, insert, update, delete on table
    public.knowledge_documents, public.knowledge_sections, public.knowledge_entities,
    public.knowledge_relations, public.chat_history, public.brain_settings
    to service_role;

revoke all on function public.search_knowledge(text, integer)
    from public, anon, authenticated, service_role;
grant execute on function public.search_knowledge(text, integer)
    to anon, authenticated, service_role;

revoke all on function public.match_knowledge_sections(public.vector, double precision, integer)
    from public, anon, authenticated, service_role;
grant execute on function public.match_knowledge_sections(public.vector, double precision, integer)
    to authenticated, service_role;

revoke all on function public.match_knowledge_hybrid(text, public.vector, integer, integer)
    from public, anon, authenticated, service_role;
grant execute on function public.match_knowledge_hybrid(text, public.vector, integer, integer)
    to authenticated, service_role;

revoke all on function public.ingest_document_atomic(text, text, text[], text, text, text, jsonb)
    from public, anon, authenticated, service_role;
grant execute on function public.ingest_document_atomic(text, text, text[], text, text, text, jsonb)
    to service_role;

-- Let PostgREST pick up the new functions and privileges.
notify pgrst, 'reload schema';

commit;
