-- ==============================================================================
-- Starpi migration 20260924000000: lock published rows, bound browser writes
-- ==============================================================================
--
-- Follow-up to 20260923000000_harden_rls_anonymous_auth.sql (required first).
--
-- What it does (details in README.md):
--   * Published rows are read-only for browser roles. Until now the owner of
--     a document, entity or relation that the service role later published
--     (is_public = true) could still UPDATE / DELETE it, and could INSERT /
--     UPDATE / DELETE the sections of a published document. The owner
--     policies now only match private rows (and not is_public); the section
--     write policies require an own, private parent document.
--   * brain_settings is service role only: the browser never reads it, so the
--     unconditional SELECT policy for anon / authenticated and their table
--     privileges are removed. RLS stays enabled without any policy.
--   * CHECK constraints bound the size of every text / JSON column the browser
--     can write (limits in section 3). They are added NOT VALID: new and
--     updated rows are checked, rows that already exist are not, so legacy
--     data never blocks the migration.
--
-- Re-running 20260923000000 re-creates its own, older policies (it drops every
-- policy on the Starpi tables first). Always apply the migrations in file-name
-- order, e.g. with apply_migration.py --migrations.
--
-- Safe to run more than once. Runs in a single transaction. Only touches the
-- Starpi tables listed above.
-- ==============================================================================

begin;

set local lock_timeout = '15s';

-- ------------------------------------------------------------------------------
-- 0. Preconditions
-- ------------------------------------------------------------------------------
do $$
declare
    tbl text;
begin
    foreach tbl in array array['knowledge_documents', 'knowledge_entities', 'knowledge_relations'] loop
        if to_regclass('public.' || tbl) is null or (
            select count(*) from information_schema.columns
            where table_schema = 'public' and table_name = tbl and column_name in ('owner_id', 'is_public')
        ) <> 2 then
            raise exception 'public.% has no owner_id / is_public: apply migrations/20260923000000_harden_rls_anonymous_auth.sql first', tbl;
        end if;
    end loop;

    if to_regclass('public.knowledge_sections') is null
       or to_regclass('public.chat_history') is null
       or to_regclass('public.brain_settings') is null then
        raise exception 'Starpi tables not found: apply migrations/20260923000000_harden_rls_anonymous_auth.sql first';
    end if;
end
$$;

-- ------------------------------------------------------------------------------
-- 1. Published rows are read-only for browser roles
-- ------------------------------------------------------------------------------
-- USING decides which existing rows an UPDATE / DELETE can reach; WITH CHECK
-- (unchanged) keeps updated rows own and private.
drop policy if exists knowledge_documents_update_own on public.knowledge_documents;
create policy knowledge_documents_update_own on public.knowledge_documents
    for update to authenticated
    using (owner_id = (select auth.uid()) and not is_public)
    with check (owner_id = (select auth.uid()) and is_public = false);

drop policy if exists knowledge_documents_delete_own on public.knowledge_documents;
create policy knowledge_documents_delete_own on public.knowledge_documents
    for delete to authenticated
    using (owner_id = (select auth.uid()) and not is_public);

-- Sections: writable only while the parent document is own and private.
drop policy if exists knowledge_sections_insert_own_document on public.knowledge_sections;
create policy knowledge_sections_insert_own_document on public.knowledge_sections
    for insert to authenticated
    with check (exists (
        select 1 from public.knowledge_documents d
        where d.id = knowledge_sections.document_id
          and d.owner_id = (select auth.uid())
          and not d.is_public
    ));

drop policy if exists knowledge_sections_update_own_document on public.knowledge_sections;
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

drop policy if exists knowledge_sections_delete_own_document on public.knowledge_sections;
create policy knowledge_sections_delete_own_document on public.knowledge_sections
    for delete to authenticated
    using (exists (
        select 1 from public.knowledge_documents d
        where d.id = knowledge_sections.document_id
          and d.owner_id = (select auth.uid())
          and not d.is_public
    ));

drop policy if exists knowledge_entities_update_own on public.knowledge_entities;
create policy knowledge_entities_update_own on public.knowledge_entities
    for update to authenticated
    using (owner_id = (select auth.uid()) and not is_public)
    with check (owner_id = (select auth.uid()) and is_public = false);

drop policy if exists knowledge_entities_delete_own on public.knowledge_entities;
create policy knowledge_entities_delete_own on public.knowledge_entities
    for delete to authenticated
    using (owner_id = (select auth.uid()) and not is_public);

drop policy if exists knowledge_relations_update_own on public.knowledge_relations;
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

drop policy if exists knowledge_relations_delete_own on public.knowledge_relations;
create policy knowledge_relations_delete_own on public.knowledge_relations
    for delete to authenticated
    using (owner_id = (select auth.uid()) and not is_public);

-- ------------------------------------------------------------------------------
-- 2. brain_settings: service role only
-- ------------------------------------------------------------------------------
-- The browser never reads brain_settings; the backend uses the service role,
-- which bypasses RLS. Any policy here would open the table again.
do $$
declare
    pol record;
begin
    for pol in
        select policyname from pg_policies
        where schemaname = 'public' and tablename = 'brain_settings'
    loop
        if pol.policyname <> 'brain_settings_select_all' then
            raise notice 'dropping unexpected policy % on public.brain_settings', pol.policyname;
        end if;
        execute format('drop policy %I on public.brain_settings', pol.policyname);
    end loop;
end
$$;

alter table public.brain_settings enable row level security;
revoke all on table public.brain_settings from public, anon, authenticated;

-- ------------------------------------------------------------------------------
-- 3. Size limits for browser writes
-- ------------------------------------------------------------------------------
-- Limits (characters unless noted), above what the PWA and the backend send:
--   documents: title 500, source_type 64, source_name 500, summary 5000,
--              raw_content 200000 (PWA and backend ingest limit), at most 50
--              tags / 16 KiB, metadata 64 KiB of JSON
--   sections:  heading 1000, markdown_content 210000 (a whole document plus
--              the Markdown frame the PWA adds)
--   entities:  name 500, entity_type 64, description 5000, properties 64 KiB
--   relations: relation_type 64, properties 64 KiB (there is no description)
--   chat_history: content 20000 (chat_history_content_length from
--              20260923000000 keeps its validated 100000 bound for older rows)
-- NOT VALID: enforced for every new or updated row, existing rows are not
-- scanned. Names ending in _max_length / _max_size belong to this migration;
-- an existing constraint with the same name is left as it is.
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

-- Let PostgREST pick up the changed privileges.
notify pgrst, 'reload schema';

commit;
