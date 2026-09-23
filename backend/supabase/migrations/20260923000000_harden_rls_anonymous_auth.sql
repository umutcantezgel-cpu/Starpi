-- ==============================================================================
-- Starpi migration 20260923000000: harden RLS for anonymous sign-ins
-- ==============================================================================
--
-- Replaces the open policies of the first schema versions with owner-based
-- row level security. The browser signs in with Supabase anonymous sign-ins
-- (role "authenticated", is_anonymous = true in the JWT) and may only touch
-- its own rows; the backend keeps using the service role, which bypasses RLS.
--
-- Prerequisite: Authentication > Sign In / Providers > Anonymous sign-ins
-- enabled, otherwise the browser stays on the anon role and can only read
-- public knowledge.
--
-- What it does (details in README.md):
--   * chat_history: owner_id NOT NULL (default auth.uid()), owner-only
--     SELECT / INSERT / DELETE, nothing for anon. Existing rows are deleted
--     because their owner is unknown (see step 4).
--   * knowledge_documents / knowledge_entities / knowledge_relations:
--     owner_id + is_public. Rows that exist before this migration were world
--     readable and are kept public (is_public = true); new rows default to
--     private. Browser writes are limited to own, private rows.
--   * knowledge_sections: visibility and write access follow the parent
--     document.
--   * knowledge_entities / knowledge_relations are created when missing.
--   * German full-text columns (fts) + GIN indexes and the RPC
--     search_knowledge(query_text, match_count) for the browser.
--   * RPCs run as SECURITY INVOKER with an empty search_path, so RLS applies
--     to the caller. ingest_document_atomic is service_role only,
--     match_knowledge_sections / match_knowledge_hybrid are not callable by
--     anon.
--   * Explicit table and function privileges for anon, authenticated and
--     service_role.
--
-- Safe to run more than once, on the live shape (first full_schema.sql
-- without the knowledge graph tables) and on installs from any earlier
-- schema.sql / full_schema.sql. Runs in a single transaction.
--
-- Scope: only the Starpi objects listed above. Other objects in this
-- database (for example leads, bookings, conversion_events,
-- prune_conversion_events) are not touched.
--
-- Known advisor warning: "extension_in_public" for vector. The extension
-- stays in schema public because existing columns and indexes use
-- public.vector; moving it would break them.
-- ==============================================================================

begin;

set local lock_timeout = '15s';

-- ------------------------------------------------------------------------------
-- 0. Preconditions
-- ------------------------------------------------------------------------------
create extension if not exists vector with schema public;

do $$
declare
    vector_schema name;
begin
    select n.nspname into vector_schema
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'vector';

    if vector_schema is distinct from 'public' then
        raise exception 'Starpi expects the vector extension in schema public, found it in %', vector_schema;
    end if;

    if to_regclass('auth.users') is null or to_regprocedure('auth.uid()') is null then
        raise exception 'auth.users / auth.uid() not found: run this migration on a Supabase database';
    end if;

    if to_regclass('public.knowledge_documents') is null
       or to_regclass('public.knowledge_sections') is null
       or to_regclass('public.chat_history') is null then
        raise exception 'Starpi tables not found: use full_schema.sql for a fresh install';
    end if;
end
$$;

-- ------------------------------------------------------------------------------
-- 1. Tables that older installs may lack
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

create table if not exists public.knowledge_entities (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    entity_type text not null,
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
    relation_type text not null,
    properties jsonb default '{}'::jsonb,
    owner_id uuid default auth.uid() references auth.users (id) on delete set null,
    is_public boolean not null default false,
    created_at timestamptz not null default now()
);

-- ------------------------------------------------------------------------------
-- 2. Columns: total_sections (schema.sql era), knowledge graph columns from
--    the first full_schema.sql, owner_id and is_public
-- ------------------------------------------------------------------------------
alter table public.knowledge_documents
    add column if not exists total_sections integer default 0;

alter table public.knowledge_entities
    add column if not exists description text;

do $$
begin
    -- The first full_schema.sql stored entity attributes in "metadata".
    if not exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'knowledge_entities' and column_name = 'properties'
    ) then
        alter table public.knowledge_entities add column properties jsonb default '{}'::jsonb;
        if exists (
            select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'knowledge_entities' and column_name = 'metadata'
        ) then
            update public.knowledge_entities set properties = coalesce(metadata, '{}'::jsonb);
        end if;
    end if;
end
$$;

alter table public.knowledge_relations
    add column if not exists properties jsonb default '{}'::jsonb;

update public.knowledge_entities set created_at = now() where created_at is null;
update public.knowledge_relations set created_at = now() where created_at is null;
alter table public.knowledge_entities
    alter column created_at set default now(),
    alter column created_at set not null;
alter table public.knowledge_relations
    alter column created_at set default now(),
    alter column created_at set not null;

-- A global UNIQUE (name, entity_type) lets one user block names for everyone
-- and reveals whether a private entity with that name exists.
alter table public.knowledge_entities
    drop constraint if exists knowledge_entities_name_entity_type_key;

-- owner_id: null for rows written by the service role (backend).
alter table public.knowledge_documents add column if not exists owner_id uuid;
alter table public.knowledge_entities add column if not exists owner_id uuid;
alter table public.knowledge_relations add column if not exists owner_id uuid;

alter table public.knowledge_documents alter column owner_id set default auth.uid();
alter table public.knowledge_entities alter column owner_id set default auth.uid();
alter table public.knowledge_relations alter column owner_id set default auth.uid();

-- is_public: rows that already exist were readable by anyone holding the anon
-- key, so they stay public. Only runs when the column is added, so re-running
-- never publishes rows created after the first run.
do $$
declare
    tbl text;
begin
    foreach tbl in array array['knowledge_documents', 'knowledge_entities', 'knowledge_relations'] loop
        if not exists (
            select 1 from information_schema.columns
            where table_schema = 'public' and table_name = tbl and column_name = 'is_public'
        ) then
            execute format('alter table public.%I add column is_public boolean not null default true', tbl);
        end if;
        execute format('alter table public.%I alter column is_public set default false', tbl);
    end loop;
end
$$;

-- ------------------------------------------------------------------------------
-- 3. German full-text search columns
-- ------------------------------------------------------------------------------
alter table public.knowledge_documents
    add column if not exists fts tsvector generated always as (
        to_tsvector('german', coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(raw_content, ''))
    ) stored;

alter table public.knowledge_sections
    add column if not exists fts tsvector generated always as (
        to_tsvector('german', coalesce(heading, '') || ' ' || coalesce(markdown_content, ''))
    ) stored;

-- ------------------------------------------------------------------------------
-- 4. chat_history ownership
-- ------------------------------------------------------------------------------
alter table public.chat_history add column if not exists owner_id uuid;

-- Rows written before this migration have no owner and were readable and
-- deletable by anyone holding the anon key. They cannot be assigned to a
-- user, so they are removed (the live table is empty). No-op on re-runs:
-- owner_id is NOT NULL from then on.
do $$
declare
    removed bigint;
begin
    delete from public.chat_history where owner_id is null;
    get diagnostics removed = row_count;
    if removed > 0 then
        raise notice 'chat_history: removed % rows without owner', removed;
    end if;
end
$$;

update public.chat_history set sources = '[]'::jsonb where sources is null;
update public.chat_history set metadata = '{}'::jsonb where metadata is null;

alter table public.chat_history
    alter column owner_id set default auth.uid(),
    alter column owner_id set not null,
    alter column sources set not null,
    alter column metadata set not null;

alter table public.chat_history drop constraint if exists chat_history_role_check;
alter table public.chat_history drop constraint if exists chat_history_session_id_length;
alter table public.chat_history drop constraint if exists chat_history_content_length;
alter table public.chat_history drop constraint if exists chat_history_sources_size;
alter table public.chat_history drop constraint if exists chat_history_metadata_size;

alter table public.chat_history
    add constraint chat_history_role_check check (role in ('user', 'assistant', 'system')),
    add constraint chat_history_session_id_length check (char_length(session_id) between 1 and 128),
    add constraint chat_history_content_length check (char_length(content) <= 100000),
    add constraint chat_history_sources_size check (octet_length(sources::text) <= 65536),
    add constraint chat_history_metadata_size check (octet_length(metadata::text) <= 65536);

-- ------------------------------------------------------------------------------
-- 5. Foreign keys to auth.users
-- ------------------------------------------------------------------------------
alter table public.chat_history drop constraint if exists chat_history_owner_id_fkey;
alter table public.chat_history
    add constraint chat_history_owner_id_fkey
    foreign key (owner_id) references auth.users (id) on delete cascade;

alter table public.knowledge_documents drop constraint if exists knowledge_documents_owner_id_fkey;
alter table public.knowledge_documents
    add constraint knowledge_documents_owner_id_fkey
    foreign key (owner_id) references auth.users (id) on delete set null;

alter table public.knowledge_entities drop constraint if exists knowledge_entities_owner_id_fkey;
alter table public.knowledge_entities
    add constraint knowledge_entities_owner_id_fkey
    foreign key (owner_id) references auth.users (id) on delete set null;

alter table public.knowledge_relations drop constraint if exists knowledge_relations_owner_id_fkey;
alter table public.knowledge_relations
    add constraint knowledge_relations_owner_id_fkey
    foreign key (owner_id) references auth.users (id) on delete set null;

-- ------------------------------------------------------------------------------
-- 6. Indexes
-- ------------------------------------------------------------------------------
-- The old schema.sql used different index names; keep one index per purpose.
do $$
declare
    pair text[];
begin
    foreach pair slice 1 in array array[
        array['knowledge_sections_embedding_hnsw_idx', 'idx_ksections_embedding_hnsw'],
        array['knowledge_sections_doc_id_idx', 'idx_ksections_doc_id'],
        array['knowledge_documents_tags_idx', 'idx_kdocs_tags']
    ] loop
        if to_regclass('public.' || pair[1]) is not null then
            if to_regclass('public.' || pair[2]) is null then
                execute format('alter index public.%I rename to %I', pair[1], pair[2]);
            else
                execute format('drop index public.%I', pair[1]);
            end if;
        end if;
    end loop;
end
$$;

-- Replaced by idx_chathistory_owner_session (every query is scoped to the owner).
drop index if exists public.chat_history_session_idx;
drop index if exists public.idx_chathistory_session;

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
-- 7. Row level security
-- ------------------------------------------------------------------------------
alter table public.knowledge_documents enable row level security;
alter table public.knowledge_sections enable row level security;
alter table public.knowledge_entities enable row level security;
alter table public.knowledge_relations enable row level security;
alter table public.chat_history enable row level security;
alter table public.brain_settings enable row level security;

-- Policies of earlier schema versions.
drop policy if exists "Allow public read documents" on public.knowledge_documents;
drop policy if exists "Allow public insert documents" on public.knowledge_documents;
drop policy if exists "Allow public update documents" on public.knowledge_documents;
drop policy if exists "Allow public read sections" on public.knowledge_sections;
drop policy if exists "Allow public insert sections" on public.knowledge_sections;
drop policy if exists "Allow public all chat_history" on public.chat_history;
drop policy if exists "Allow public read brain_settings" on public.brain_settings;
drop policy if exists "Allow public read entities" on public.knowledge_entities;
drop policy if exists "Allow public insert entities" on public.knowledge_entities;
drop policy if exists "Allow public read relations" on public.knowledge_relations;
drop policy if exists "Allow public insert relations" on public.knowledge_relations;

-- Policies created below (re-run).
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

-- Any other policy on these tables (for example one added in the dashboard)
-- would be OR-ed with the policies below and could reopen access.
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
-- The browser can never publish (is_public = true is service role only).
create policy knowledge_documents_select_public_or_own on public.knowledge_documents
    for select to anon, authenticated
    using (is_public or owner_id = (select auth.uid()));

create policy knowledge_documents_insert_own on public.knowledge_documents
    for insert to authenticated
    with check (owner_id = (select auth.uid()) and is_public = false);

create policy knowledge_documents_update_own on public.knowledge_documents
    for update to authenticated
    using (owner_id = (select auth.uid()))
    with check (owner_id = (select auth.uid()) and is_public = false);

create policy knowledge_documents_delete_own on public.knowledge_documents
    for delete to authenticated
    using (owner_id = (select auth.uid()));

-- knowledge_sections: follow the parent document.
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
    ));

create policy knowledge_sections_update_own_document on public.knowledge_sections
    for update to authenticated
    using (exists (
        select 1 from public.knowledge_documents d
        where d.id = knowledge_sections.document_id
          and d.owner_id = (select auth.uid())
    ))
    with check (exists (
        select 1 from public.knowledge_documents d
        where d.id = knowledge_sections.document_id
          and d.owner_id = (select auth.uid())
    ));

create policy knowledge_sections_delete_own_document on public.knowledge_sections
    for delete to authenticated
    using (exists (
        select 1 from public.knowledge_documents d
        where d.id = knowledge_sections.document_id
          and d.owner_id = (select auth.uid())
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
    using (owner_id = (select auth.uid()))
    with check (owner_id = (select auth.uid()) and is_public = false);

create policy knowledge_entities_delete_own on public.knowledge_entities
    for delete to authenticated
    using (owner_id = (select auth.uid()));

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
    using (owner_id = (select auth.uid()))
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
    using (owner_id = (select auth.uid()));

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

-- brain_settings: read only for clients.
create policy brain_settings_select_all on public.brain_settings
    for select to anon, authenticated
    using (true);

-- ------------------------------------------------------------------------------
-- 8. Functions
-- ------------------------------------------------------------------------------
-- Drop every overload so no older SECURITY DEFINER variant stays callable.
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
-- 9. Privileges
-- ------------------------------------------------------------------------------
-- Supabase grants everything on new objects to anon / authenticated /
-- service_role by default; start from nothing and grant what is needed.
revoke all on table
    public.knowledge_documents, public.knowledge_sections, public.knowledge_entities,
    public.knowledge_relations, public.chat_history, public.brain_settings
    from public, anon, authenticated, service_role;

grant select on table
    public.knowledge_documents, public.knowledge_sections, public.knowledge_entities,
    public.knowledge_relations, public.brain_settings
    to anon;

grant select, insert, update, delete on table
    public.knowledge_documents, public.knowledge_sections, public.knowledge_entities,
    public.knowledge_relations
    to authenticated;
grant select, insert, delete on table public.chat_history to authenticated;
grant select on table public.brain_settings to authenticated;

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

-- Let PostgREST pick up the changed functions and privileges.
notify pgrst, 'reload schema';

commit;
