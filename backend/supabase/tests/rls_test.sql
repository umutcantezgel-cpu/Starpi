-- RLS and privilege tests for the Starpi schema.
--
-- Run with psql as a superuser on a throwaway database prepared with
-- stub_supabase.sql and full_schema.sql or a legacy fixture + the migrations:
--
--   psql -X -v ON_ERROR_STOP=1 -v legacy=false -f rls_test.sql
--
-- legacy=true additionally checks the rows from fixtures/legacy_seed.sql.
-- Every check prints "ok - <label>"; the first failing check raises
-- "FAIL: <label> ..." and stops the script with a non-zero exit code.
-- Roles are switched the way PostgREST does it: SET ROLE plus the JWT subject
-- in request.jwt.claim.sub (read by auth.uid()).

\set ON_ERROR_STOP 1
\set QUIET 1
\set VERBOSITY terse
\o /dev/null
set client_min_messages = notice;

\if :{?legacy}
\else
\set legacy false
\endif

\set as_super 'reset role; set request.jwt.claim.sub = '''';'
\set as_service 'reset role; set request.jwt.claim.sub = ''''; set role service_role;'
\set as_anon 'reset role; set request.jwt.claim.sub = ''''; set role anon;'
\set as_a 'reset role; set request.jwt.claim.sub = ''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa''; set role authenticated;'
\set as_b 'reset role; set request.jwt.claim.sub = ''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb''; set role authenticated;'

-- ------------------------------------------------------------------------------
-- Helpers
-- ------------------------------------------------------------------------------
:as_super
set client_min_messages = warning;
drop schema if exists rls_test cascade;
set client_min_messages = notice;
create schema rls_test;
grant usage on schema rls_test to public;

create function rls_test.pass(label text) returns void
language plpgsql as $$
begin
    perform set_config('rls_test.passed',
        (coalesce(nullif(current_setting('rls_test.passed', true), ''), '0')::integer + 1)::text, false);
    raise notice 'ok - %', label;
end
$$;

create function rls_test.expect_ok(label text, stmt text) returns void
language plpgsql as $$
begin
    begin
        execute stmt;
    exception when others then
        raise exception 'FAIL: % -- unexpected error % (%)', label, sqlstate, sqlerrm;
    end;
    perform rls_test.pass(label);
end
$$;

create function rls_test.expect_error(label text, stmt text, expected_state text default '42501') returns void
language plpgsql as $$
begin
    begin
        execute stmt;
    exception when others then
        if sqlstate = expected_state then
            perform rls_test.pass(label);
            return;
        end if;
        raise exception 'FAIL: % -- expected SQLSTATE %, got % (%)', label, expected_state, sqlstate, sqlerrm;
    end;
    raise exception 'FAIL: % -- statement succeeded, expected SQLSTATE %', label, expected_state;
end
$$;

create function rls_test.expect_count(label text, query text, expected bigint) returns void
language plpgsql as $$
declare
    actual bigint;
begin
    execute format('select count(*) from (%s) q', query) into actual;
    if actual is distinct from expected then
        raise exception 'FAIL: % -- expected % rows, got %', label, expected, actual;
    end if;
    perform rls_test.pass(label);
end
$$;

create function rls_test.expect_affected(label text, stmt text, expected bigint) returns void
language plpgsql as $$
declare
    actual bigint;
begin
    execute stmt;
    get diagnostics actual = row_count;
    if actual is distinct from expected then
        raise exception 'FAIL: % -- expected % affected rows, got %', label, expected, actual;
    end if;
    perform rls_test.pass(label);
end
$$;

create function rls_test.expect_true(label text, query text) returns void
language plpgsql as $$
declare
    actual boolean;
begin
    execute query into actual;
    if actual is not true then
        raise exception 'FAIL: % -- expected true, got %', label, coalesce(actual::text, 'null');
    end if;
    perform rls_test.pass(label);
end
$$;

-- Fails and lists the rows when the query returns any.
create function rls_test.expect_none(label text, query text) returns void
language plpgsql as $$
declare
    offending text;
begin
    execute format('select string_agg(q::text, E''\n'') from (%s) q', query) into offending;
    if offending is not null then
        raise exception E'FAIL: % -- unexpected rows:\n%', label, offending;
    end if;
    perform rls_test.pass(label);
end
$$;

-- 1536-dim one-hot vector, used as a deterministic embedding.
create function rls_test.onehot(pos integer) returns public.vector
language sql immutable as $$
    select ('[' || string_agg(case when i = pos then '1' else '0' end, ',' order by i) || ']')::public.vector
    from generate_series(1, 1536) as i
$$;

insert into auth.users (id, is_anonymous) values
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true),
    ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);

-- ------------------------------------------------------------------------------
-- Catalog: RLS, policies, functions, privileges
-- ------------------------------------------------------------------------------
select rls_test.expect_count('RLS enabled on all six Starpi tables', $q$
    select 1 from pg_class
    where oid in ('public.knowledge_documents'::regclass, 'public.knowledge_sections'::regclass,
                  'public.knowledge_entities'::regclass, 'public.knowledge_relations'::regclass,
                  'public.chat_history'::regclass, 'public.brain_settings'::regclass)
      and relrowsecurity
$q$, 6);

select rls_test.expect_none('policy set is exactly the expected one', $q$
    with expected(tablename, policyname, cmd, roles) as (values
        ('knowledge_documents', 'knowledge_documents_select_public_or_own', 'SELECT', '{anon,authenticated}'),
        ('knowledge_documents', 'knowledge_documents_insert_own', 'INSERT', '{authenticated}'),
        ('knowledge_documents', 'knowledge_documents_update_own', 'UPDATE', '{authenticated}'),
        ('knowledge_documents', 'knowledge_documents_delete_own', 'DELETE', '{authenticated}'),
        ('knowledge_sections', 'knowledge_sections_select_visible_document', 'SELECT', '{anon,authenticated}'),
        ('knowledge_sections', 'knowledge_sections_insert_own_document', 'INSERT', '{authenticated}'),
        ('knowledge_sections', 'knowledge_sections_update_own_document', 'UPDATE', '{authenticated}'),
        ('knowledge_sections', 'knowledge_sections_delete_own_document', 'DELETE', '{authenticated}'),
        ('knowledge_entities', 'knowledge_entities_select_public_or_own', 'SELECT', '{anon,authenticated}'),
        ('knowledge_entities', 'knowledge_entities_insert_own', 'INSERT', '{authenticated}'),
        ('knowledge_entities', 'knowledge_entities_update_own', 'UPDATE', '{authenticated}'),
        ('knowledge_entities', 'knowledge_entities_delete_own', 'DELETE', '{authenticated}'),
        ('knowledge_relations', 'knowledge_relations_select_public_or_own', 'SELECT', '{anon,authenticated}'),
        ('knowledge_relations', 'knowledge_relations_insert_own', 'INSERT', '{authenticated}'),
        ('knowledge_relations', 'knowledge_relations_update_own', 'UPDATE', '{authenticated}'),
        ('knowledge_relations', 'knowledge_relations_delete_own', 'DELETE', '{authenticated}'),
        ('chat_history', 'chat_history_select_own', 'SELECT', '{authenticated}'),
        ('chat_history', 'chat_history_insert_own', 'INSERT', '{authenticated}'),
        ('chat_history', 'chat_history_delete_own', 'DELETE', '{authenticated}')
    ),
    actual as (
        select tablename::text, policyname::text, cmd::text, roles::text as roles
        from pg_policies
        where schemaname = 'public'
          and tablename in ('knowledge_documents', 'knowledge_sections', 'knowledge_entities',
                            'knowledge_relations', 'chat_history', 'brain_settings')
    )
    (select 'missing' as problem, * from expected except select 'missing', * from actual)
    union all
    (select 'unexpected', * from actual except select 'unexpected', * from expected)
$q$);

select rls_test.expect_count('no policy is unconditional (brain_settings has none at all)', $q$
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename in ('knowledge_documents', 'knowledge_sections', 'knowledge_entities',
                        'knowledge_relations', 'chat_history', 'brain_settings')
      and (qual = 'true' or with_check = 'true')
$q$, 0);

select rls_test.expect_none('size limits on browser-writable columns', $q$
    with expected(tbl, conname) as (values
        ('knowledge_documents', 'knowledge_documents_title_max_length'),
        ('knowledge_documents', 'knowledge_documents_source_type_max_length'),
        ('knowledge_documents', 'knowledge_documents_source_name_max_length'),
        ('knowledge_documents', 'knowledge_documents_summary_max_length'),
        ('knowledge_documents', 'knowledge_documents_raw_content_max_length'),
        ('knowledge_documents', 'knowledge_documents_tags_max_size'),
        ('knowledge_documents', 'knowledge_documents_metadata_max_size'),
        ('knowledge_sections', 'knowledge_sections_heading_max_length'),
        ('knowledge_sections', 'knowledge_sections_markdown_content_max_length'),
        ('knowledge_entities', 'knowledge_entities_name_max_length'),
        ('knowledge_entities', 'knowledge_entities_entity_type_max_length'),
        ('knowledge_entities', 'knowledge_entities_description_max_length'),
        ('knowledge_entities', 'knowledge_entities_properties_max_size'),
        ('knowledge_relations', 'knowledge_relations_relation_type_max_length'),
        ('knowledge_relations', 'knowledge_relations_properties_max_size'),
        ('chat_history', 'chat_history_content_max_length')
    ),
    actual as (
        select c.relname::text as tbl, k.conname::text
        from pg_constraint k
        join pg_class c on c.oid = k.conrelid
        where k.connamespace = 'public'::regnamespace
          and k.contype = 'c'
          and (k.conname like '%\_max\_length' or k.conname like '%\_max\_size')
    )
    (select 'missing' as problem, * from expected except select 'missing', * from actual)
    union all
    (select 'unexpected', * from actual except select 'unexpected', * from expected)
$q$);

select rls_test.expect_none('RPCs: SECURITY INVOKER, search_path pinned, no stray overloads', $q$
    select p.oid::regprocedure, p.prosecdef, p.proconfig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('match_knowledge_sections', 'match_knowledge_hybrid',
                        'ingest_document_atomic', 'search_knowledge')
      and (p.prosecdef or p.proconfig is distinct from array['search_path=""'])
    union all
    select null, null, array['expected 4 functions, found ' || count(*)]
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('match_knowledge_sections', 'match_knowledge_hybrid',
                        'ingest_document_atomic', 'search_knowledge')
    having count(*) <> 4
$q$);

select rls_test.expect_none('table privilege matrix (anon / authenticated / service_role)', $q$
    with roles(r) as (values ('anon'), ('authenticated'), ('service_role')),
    tables(t) as (values ('knowledge_documents'), ('knowledge_sections'), ('knowledge_entities'),
                         ('knowledge_relations'), ('chat_history'), ('brain_settings')),
    privs(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
    granted(r, t, p) as (
        select 'anon', t, 'SELECT'
        from unnest(array['knowledge_documents', 'knowledge_sections', 'knowledge_entities',
                          'knowledge_relations']) as t
        union all
        select 'authenticated', t, p
        from unnest(array['knowledge_documents', 'knowledge_sections', 'knowledge_entities',
                          'knowledge_relations']) as t,
             unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p
        union all
        select 'authenticated', 'chat_history', p from unnest(array['SELECT', 'INSERT', 'DELETE']) as p
        union all
        select 'service_role', t, p
        from unnest(array['knowledge_documents', 'knowledge_sections', 'knowledge_entities',
                          'knowledge_relations', 'chat_history', 'brain_settings']) as t,
             unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p
    )
    select roles.r, tables.t, privs.p, has_table_privilege(roles.r, 'public.' || tables.t, privs.p) as actual
    from roles, tables, privs
    where has_table_privilege(roles.r, 'public.' || tables.t, privs.p)
          <> exists (select 1 from granted g where g.r = roles.r and g.t = tables.t and g.p = privs.p)
$q$);

select rls_test.expect_none('function EXECUTE matrix', $q$
    select r, f, expected
    from (values
        ('anon', 'public.search_knowledge(text, integer)', true),
        ('authenticated', 'public.search_knowledge(text, integer)', true),
        ('service_role', 'public.search_knowledge(text, integer)', true),
        ('anon', 'public.match_knowledge_sections(public.vector, double precision, integer)', false),
        ('authenticated', 'public.match_knowledge_sections(public.vector, double precision, integer)', true),
        ('service_role', 'public.match_knowledge_sections(public.vector, double precision, integer)', true),
        ('anon', 'public.match_knowledge_hybrid(text, public.vector, integer, integer)', false),
        ('authenticated', 'public.match_knowledge_hybrid(text, public.vector, integer, integer)', true),
        ('service_role', 'public.match_knowledge_hybrid(text, public.vector, integer, integer)', true),
        ('anon', 'public.ingest_document_atomic(text, text, text[], text, text, text, jsonb)', false),
        ('authenticated', 'public.ingest_document_atomic(text, text, text[], text, text, text, jsonb)', false),
        ('service_role', 'public.ingest_document_atomic(text, text, text[], text, text, text, jsonb)', true)
    ) as m(r, f, expected)
    where has_function_privilege(r, f, 'EXECUTE') <> expected
$q$);

select rls_test.expect_true('objects of the other app are untouched', $q$
    select s.fingerprint = supabase_stub.sentinel_fingerprint() from supabase_stub.sentinel s
$q$);

select rls_test.expect_true('knowledge_sections.embedding is nullable', $q$
    select not attnotnull from pg_attribute
    where attrelid = 'public.knowledge_sections'::regclass and attname = 'embedding'
$q$);

-- ------------------------------------------------------------------------------
-- Rows that existed before the migration (legacy fixtures only)
-- ------------------------------------------------------------------------------
\if :legacy
select rls_test.expect_true('legacy document is kept and marked public', $q$
    select is_public and owner_id is null from public.knowledge_documents
    where id = '11111111-1111-4111-8111-111111111111'
$q$);

select rls_test.expect_count('ownerless legacy chat rows were deleted', $q$
    select 1 from public.chat_history where content = 'legacy chat row'
$q$, 0);

select rls_test.expect_true('legacy entities / relations (if any) are public', $q$
    select coalesce(bool_and(e.is_public), true)
       and coalesce((select bool_and(r.is_public) from public.knowledge_relations r
                     where r.source_entity_id = '22222222-2222-4222-8222-222222222222'), true)
    from public.knowledge_entities e where e.id = '22222222-2222-4222-8222-222222222222'
$q$);

select rls_test.expect_true('an oversized legacy row survives the migration (limits are NOT VALID)', $q$
    select char_length(title) > 500 and is_public from public.knowledge_documents
    where id = '33333333-3333-4333-8333-333333333333'
$q$);

:as_service
select rls_test.expect_error('updating an oversized legacy row is checked against the limits', $q$
    update public.knowledge_documents set summary = 'geaendert'
    where id = '33333333-3333-4333-8333-333333333333'
$q$, '23514');

select rls_test.expect_affected('an oversized legacy row can be updated once it fits', $q$
    update public.knowledge_documents set title = left(title, 500), summary = 'gekuerzt'
    where id = '33333333-3333-4333-8333-333333333333'
$q$, 1);
:as_super
\endif

-- ------------------------------------------------------------------------------
-- Service role: seed public and private knowledge, backend RPCs
-- ------------------------------------------------------------------------------
:as_service
select rls_test.expect_ok('service_role inserts public and private documents', $q$
    insert into public.knowledge_documents (id, title, summary, raw_content, tags, is_public) values
        ('d0000000-0000-4000-8000-000000000001', 'Starpi Handbuch', 'Projektwissen', 'Handbuch', '{handbuch}', true),
        ('d0000000-0000-4000-8000-000000000002', 'Marketing Notizen', 'Kampagnen', 'Notizen', '{marketing}', true),
        ('d0000000-0000-4000-8000-000000000003', 'Reisekostenrichtlinie', 'Regeln für Dienstreisen und Spesen', null, '{richtlinie}', true),
        ('d0000000-0000-4000-8000-000000000004', 'Interne Gehaltsdaten', 'Vertraulich', 'Gehaltsbänder', '{hr}', false),
        ('d0000000-0000-4000-8000-000000000005', 'Kaffee', 'Kaffeeküche', null, '{}', true)
$q$);

select rls_test.expect_ok('service_role inserts sections', $q$
    insert into public.knowledge_sections (document_id, section_index, heading, markdown_content, embedding)
    values
        ('d0000000-0000-4000-8000-000000000001', 0, 'Budgetplanung',
         'Das Budget für Projekt Alpha beträgt 45.000 Euro. Das Budget wird quartalsweise geprüft.', rls_test.onehot(3)),
        ('d0000000-0000-4000-8000-000000000001', 1, 'Zeitplan',
         'Der Launch von Projekt Alpha ist für Oktober geplant.', null),
        ('d0000000-0000-4000-8000-000000000002', 0, 'Kampagnen',
         'Ein Budget für Kampagnen ist noch nicht festgelegt.', null),
        ('d0000000-0000-4000-8000-000000000004', 0, 'Gehaltsbänder',
         'Die Gehaltsbänder werden jährlich angepasst.', rls_test.onehot(4))
$q$);

select rls_test.expect_ok('service_role inserts 25 sections for limit checks', $q$
    insert into public.knowledge_sections (document_id, section_index, heading, markdown_content)
    select 'd0000000-0000-4000-8000-000000000005', i, 'Hinweis ' || i, 'Die Kaffeemaschine wird entkalkt.'
    from generate_series(1, 25) as i
$q$);

select rls_test.expect_ok('service_role inserts a public entity', $q$
    insert into public.knowledge_entities (id, name, entity_type, description, is_public)
    values ('e0000000-0000-4000-8000-000000000001', 'Projekt Alpha', 'project', 'Kernprojekt', true)
$q$);

select rls_test.expect_ok('service_role executes ingest_document_atomic', $q$
    select public.ingest_document_atomic(
        'Ingest Test', 'Zusammenfassung', array['ingest'], 'text', 'test.md', 'Rohtext',
        jsonb_build_array(
            jsonb_build_object('heading', 'Teil 1', 'markdown_content', 'Erster Teil', 'token_count', 3,
                               'embedding', (select to_jsonb(array_agg(case when i = 1 then 1 else 0 end order by i))
                                             from generate_series(1, 1536) as i)),
            jsonb_build_object('heading', 'Teil 2', 'markdown_content', 'Zweiter Teil', 'embedding', '[]'::jsonb)
        )
    )
$q$);

select rls_test.expect_true('ingested document: no owner, private, sections stored', $q$
    select d.owner_id is null and not d.is_public and d.total_sections = 2
       and (select array_agg(s.section_index order by s.section_index) = array[0, 1]
               and bool_and((s.embedding is not null) = (s.heading = 'Teil 1'))
            from public.knowledge_sections s where s.document_id = d.id)
    from public.knowledge_documents d where d.title = 'Ingest Test'
$q$);

select rls_test.expect_true('service_role: match_knowledge_sections finds the ingested section', $q$
    select m.heading = 'Teil 1' and m.similarity > 0.99 and m.document_title = 'Ingest Test'
    from public.match_knowledge_sections(rls_test.onehot(1), 0.5, 5) m
$q$);

select rls_test.expect_true('service_role: match_knowledge_hybrid ranks the matching section first', $q$
    select h.heading = 'Budgetplanung'
    from public.match_knowledge_hybrid('Budget', rls_test.onehot(3), 5) h
    order by h.score desc limit 1
$q$);

select rls_test.expect_count('service_role sees private documents', $q$
    select 1 from public.knowledge_documents
    where id = 'd0000000-0000-4000-8000-000000000004' or title = 'Ingest Test'
$q$, 2);

select rls_test.expect_count('service_role reads brain_settings', $q$
    select 1 from public.brain_settings where key in ('llm_config', 'rag_config')
$q$, 2);

-- ------------------------------------------------------------------------------
-- User A (anonymous sign-in, role authenticated)
-- ------------------------------------------------------------------------------
:as_a
select rls_test.expect_ok('A inserts a document with the browser payload', $q$
    insert into public.knowledge_documents (title, source_type, source_name, raw_content, summary, tags)
    values ('A Entwurf', 'text', 'entwurf.md', 'Entwurf', 'Entwurf', '{}')
$q$);

select rls_test.expect_true('owner_id defaults to auth.uid(), is_public to false', $q$
    select owner_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and not is_public
    from public.knowledge_documents where title = 'A Entwurf'
$q$);

select rls_test.expect_ok('A inserts a private document', $q$
    insert into public.knowledge_documents (id, title, source_type, source_name, raw_content, summary, tags)
    values ('d0000000-0000-4000-8000-0000000000a1', 'A Passwortrichtlinie', 'text', 'pw.md',
            'Alle Passwörter müssen alle 90 Tage geändert werden.', 'Passwortregeln', '{intern}')
$q$);

select rls_test.expect_ok('A inserts sections into own documents (embedding null)', $q$
    insert into public.knowledge_sections (document_id, section_index, heading, markdown_content, token_count, embedding)
    select id, 0, 'Regeln',
           case when title = 'A Entwurf' then 'Ein erster Entwurf.'
                else 'Alle Passwörter müssen alle 90 Tage geändert werden.' end,
           12, null
    from public.knowledge_documents where title in ('A Passwortrichtlinie', 'A Entwurf')
$q$);

select rls_test.expect_error('A cannot insert a public document', $q$
    insert into public.knowledge_documents (title, is_public) values ('A oeffentlich', true)
$q$);

select rls_test.expect_error('A cannot insert a document owned by B', $q$
    insert into public.knowledge_documents (title, owner_id)
    values ('A fuer B', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
$q$);

select rls_test.expect_error('A cannot publish own document', $q$
    update public.knowledge_documents set is_public = true
    where id = 'd0000000-0000-4000-8000-0000000000a1'
$q$);

select rls_test.expect_error('A cannot hand own document to B', $q$
    update public.knowledge_documents set owner_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    where id = 'd0000000-0000-4000-8000-0000000000a1'
$q$);

select rls_test.expect_affected('A updates own document', $q$
    update public.knowledge_documents set summary = 'Passwortregeln (aktualisiert)'
    where id = 'd0000000-0000-4000-8000-0000000000a1'
$q$, 1);

select rls_test.expect_affected('A cannot update a public document', $q$
    update public.knowledge_documents set title = 'kaputt'
    where id = 'd0000000-0000-4000-8000-000000000001'
$q$, 0);

select rls_test.expect_affected('A cannot delete a public document', $q$
    delete from public.knowledge_documents where id = 'd0000000-0000-4000-8000-000000000001'
$q$, 0);

select rls_test.expect_error('A cannot add sections to a public document', $q$
    insert into public.knowledge_sections (document_id, markdown_content)
    values ('d0000000-0000-4000-8000-000000000001', 'eingeschleust')
$q$);

select rls_test.expect_error('document title is limited to 500 characters', $q$
    insert into public.knowledge_documents (title) values (repeat('t', 501))
$q$, '23514');

select rls_test.expect_error('document source_type is limited to 64 characters', $q$
    insert into public.knowledge_documents (title, source_type) values ('zu lang', repeat('t', 65))
$q$, '23514');

select rls_test.expect_error('document source_name is limited to 500 characters', $q$
    insert into public.knowledge_documents (title, source_name) values ('zu lang', repeat('n', 501))
$q$, '23514');

select rls_test.expect_error('document summary is limited to 5000 characters', $q$
    insert into public.knowledge_documents (title, summary) values ('zu lang', repeat('s', 5001))
$q$, '23514');

select rls_test.expect_error('document raw_content is limited to 200000 characters', $q$
    insert into public.knowledge_documents (title, raw_content) values ('zu lang', repeat('x ', 100001))
$q$, '23514');

select rls_test.expect_error('documents have at most 50 tags', $q$
    insert into public.knowledge_documents (title, tags) values ('zu viele', array_fill('t'::text, array[51]))
$q$, '23514');

select rls_test.expect_error('document tags are limited to 16 KiB', $q$
    insert into public.knowledge_documents (title, tags) values ('zu lang', array[repeat('t', 16385)])
$q$, '23514');

select rls_test.expect_error('document metadata is limited to 64 KiB', $q$
    insert into public.knowledge_documents (title, metadata)
    values ('zu lang', jsonb_build_object('k', repeat('m', 65536)))
$q$, '23514');

select rls_test.expect_error('A cannot grow own document past the limits', $q$
    update public.knowledge_documents set title = repeat('t', 501)
    where id = 'd0000000-0000-4000-8000-0000000000a1'
$q$, '23514');

select rls_test.expect_error('section heading is limited to 1000 characters', $q$
    insert into public.knowledge_sections (document_id, heading, markdown_content)
    values ('d0000000-0000-4000-8000-0000000000a1', repeat('h', 1001), 'x')
$q$, '23514');

select rls_test.expect_error('section markdown_content is limited to 210000 characters', $q$
    insert into public.knowledge_sections (document_id, markdown_content)
    values ('d0000000-0000-4000-8000-0000000000a1', repeat('x ', 105001))
$q$, '23514');

select rls_test.expect_error('A cannot grow own section past the limits', $q$
    update public.knowledge_sections set heading = repeat('h', 1001)
    where document_id = 'd0000000-0000-4000-8000-0000000000a1'
$q$, '23514');

select rls_test.expect_ok('A inserts a document exactly at the limits', $q$
    insert into public.knowledge_documents (id, title, source_type, source_name, summary, raw_content, tags, metadata)
    values ('d0000000-0000-4000-8000-0000000000af', repeat('t', 500), repeat('t', 64), repeat('n', 500),
            repeat('s', 5000), repeat('x ', 100000), array_fill('t'::text, array[50]),
            jsonb_build_object('k', repeat('m', 65000)))
$q$);

select rls_test.expect_ok('A inserts a section exactly at the limits', $q$
    insert into public.knowledge_sections (document_id, heading, markdown_content)
    values ('d0000000-0000-4000-8000-0000000000af', repeat('h', 1000), repeat('x ', 105000))
$q$);

select rls_test.expect_affected('A deletes the document at the limits', $q$
    delete from public.knowledge_documents where id = 'd0000000-0000-4000-8000-0000000000af'
$q$, 1);

select rls_test.expect_count('A sees public documents and own ones, not private service rows', $q$
    select 1 from public.knowledge_documents
    where id in ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002',
                 'd0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000004',
                 'd0000000-0000-4000-8000-0000000000a1')
$q$, 4);

select rls_test.expect_count('A cannot see sections of a private service document', $q$
    select 1 from public.knowledge_sections where document_id = 'd0000000-0000-4000-8000-000000000004'
$q$, 0);

select rls_test.expect_count('A sees sections of own document', $q$
    select 1 from public.knowledge_sections where document_id = 'd0000000-0000-4000-8000-0000000000a1'
$q$, 1);

select rls_test.expect_ok('A inserts chat messages with the browser payload', $q$
    insert into public.chat_history (session_id, role, content, sources, metadata) values
        ('sess-shared', 'user', 'Wie hoch ist das Budget?', '[]', '{}'),
        ('sess-shared', 'assistant', 'Das Budget beträgt 45.000 Euro.', '[{"title": "Starpi Handbuch"}]', '{"provider": "test"}'),
        ('sess-a-only', 'user', 'Hallo', '[]', '{}')
$q$);

select rls_test.expect_count('A reads own session in order', $q$
    select 1 from public.chat_history where session_id = 'sess-shared' order by created_at
$q$, 2);

select rls_test.expect_count('A counts own messages', $q$
    select 1 from public.chat_history
$q$, 3);

select rls_test.expect_error('A cannot write chat rows for B', $q$
    insert into public.chat_history (session_id, role, content, owner_id)
    values ('sess-shared', 'user', 'x', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
$q$);

select rls_test.expect_error('chat role must be user / assistant / system', $q$
    insert into public.chat_history (session_id, role, content) values ('s', 'tool', 'x')
$q$, '23514');

select rls_test.expect_error('chat content is limited to 20000 characters', $q$
    insert into public.chat_history (session_id, role, content) values ('s', 'user', repeat('x', 20001))
$q$, '23514');

select rls_test.expect_ok('chat content of exactly 20000 characters is accepted', $q$
    insert into public.chat_history (session_id, role, content) values ('sess-limit', 'assistant', repeat('x', 20000))
$q$);

select rls_test.expect_affected('A deletes the chat row at the limit', $q$
    delete from public.chat_history where session_id = 'sess-limit'
$q$, 1);

select rls_test.expect_error('chat sources are limited to 64 KiB', $q$
    insert into public.chat_history (session_id, role, content, sources)
    values ('s', 'assistant', 'x', jsonb_build_array(repeat('q', 65536)))
$q$, '23514');

select rls_test.expect_error('chat session_id is limited to 128 characters', $q$
    insert into public.chat_history (session_id, role, content) values (repeat('s', 129), 'user', 'x')
$q$, '23514');

select rls_test.expect_error('chat session_id must not be empty', $q$
    insert into public.chat_history (session_id, role, content) values ('', 'user', 'x')
$q$, '23514');

select rls_test.expect_error('chat rows cannot be updated', $q$
    update public.chat_history set content = 'geaendert'
$q$);

select rls_test.expect_ok('A inserts an entity with the browser payload', $q$
    insert into public.knowledge_entities (name, entity_type, description, properties)
    values ('A Geheimprojekt', 'project', 'Nur fuer A', '{}')
$q$);

select rls_test.expect_error('A cannot insert a public entity', $q$
    insert into public.knowledge_entities (name, entity_type, is_public) values ('A oeffentlich', 'topic', true)
$q$);

select rls_test.expect_error('entity name is limited to 500 characters', $q$
    insert into public.knowledge_entities (name, entity_type) values (repeat('n', 501), 'topic')
$q$, '23514');

select rls_test.expect_error('entity type is limited to 64 characters', $q$
    insert into public.knowledge_entities (name, entity_type) values ('zu lang', repeat('t', 65))
$q$, '23514');

select rls_test.expect_error('entity description is limited to 5000 characters', $q$
    insert into public.knowledge_entities (name, entity_type, description) values ('zu lang', 'topic', repeat('d', 5001))
$q$, '23514');

select rls_test.expect_error('entity properties are limited to 64 KiB', $q$
    insert into public.knowledge_entities (name, entity_type, properties)
    values ('zu lang', 'topic', jsonb_build_object('k', repeat('p', 65536)))
$q$, '23514');

select rls_test.expect_error('A cannot grow own entity past the limits', $q$
    update public.knowledge_entities set description = repeat('d', 5001) where name = 'A Geheimprojekt'
$q$, '23514');

select rls_test.expect_count('A sees public and own entities', $q$
    select name, entity_type, description from public.knowledge_entities
    where name in ('Projekt Alpha', 'A Geheimprojekt') order by name
$q$, 2);

select rls_test.expect_ok('A links own entity to a public entity', $q$
    insert into public.knowledge_relations (source_entity_id, target_entity_id, relation_type)
    select e.id, 'e0000000-0000-4000-8000-000000000001', 'part_of'
    from public.knowledge_entities e where e.name = 'A Geheimprojekt'
$q$);

select rls_test.expect_count('A sees own relation', $q$
    select 1 from public.knowledge_relations where owner_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
$q$, 1);

select rls_test.expect_error('relation type is limited to 64 characters', $q$
    insert into public.knowledge_relations (source_entity_id, target_entity_id, relation_type)
    select e.id, 'e0000000-0000-4000-8000-000000000001', repeat('r', 65)
    from public.knowledge_entities e where e.name = 'A Geheimprojekt'
$q$, '23514');

select rls_test.expect_error('relation properties are limited to 64 KiB', $q$
    insert into public.knowledge_relations (source_entity_id, target_entity_id, relation_type, properties)
    select e.id, 'e0000000-0000-4000-8000-000000000001', 'part_of', jsonb_build_object('k', repeat('p', 65536))
    from public.knowledge_entities e where e.name = 'A Geheimprojekt'
$q$, '23514');

select rls_test.expect_true('A finds own document with search_knowledge (German stemming)', $q$
    select count(*) = 1 and bool_and(document_title = 'A Passwortrichtlinie')
    from public.search_knowledge('Passwort')
$q$);

select rls_test.expect_count('A: match_knowledge_sections skips private service rows', $q$
    select 1 from public.match_knowledge_sections(rls_test.onehot(4), 0.5, 5)
$q$, 0);

select rls_test.expect_count('A: match_knowledge_sections returns public rows', $q$
    select 1 from public.match_knowledge_sections(rls_test.onehot(3), 0.5, 5)
$q$, 1);

select rls_test.expect_count('A: match_knowledge_hybrid skips private service rows', $q$
    select 1 from public.match_knowledge_hybrid('Gehaltsbänder', rls_test.onehot(4), 5)
    where document_id = 'd0000000-0000-4000-8000-000000000004'
$q$, 0);

select rls_test.expect_error('A cannot execute ingest_document_atomic', $q$
    select public.ingest_document_atomic('x', 'x', '{}', 'text', 'x', 'x', '[]')
$q$);

select rls_test.expect_error('A cannot read brain_settings', $q$
    select * from public.brain_settings
$q$);

select rls_test.expect_error('A cannot change brain_settings', $q$
    update public.brain_settings set description = 'x'
$q$);

-- ------------------------------------------------------------------------------
-- User B
-- ------------------------------------------------------------------------------
:as_super
select id as a_entity_id from public.knowledge_entities where name = 'A Geheimprojekt' \gset

:as_b
select rls_test.expect_count('B cannot see A''s documents', $q$
    select 1 from public.knowledge_documents where owner_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
$q$, 0);

select rls_test.expect_count('B cannot see A''s sections', $q$
    select 1 from public.knowledge_sections where document_id = 'd0000000-0000-4000-8000-0000000000a1'
$q$, 0);

select rls_test.expect_count('B cannot see A''s entities and relations', $q$
    select 1 from public.knowledge_entities where name = 'A Geheimprojekt'
    union all
    select 1 from public.knowledge_relations where owner_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
$q$, 0);

select rls_test.expect_count('B sees no chat rows of A', $q$
    select 1 from public.chat_history
$q$, 0);

select rls_test.expect_ok('B writes into the same session id', $q$
    insert into public.chat_history (session_id, role, content, sources, metadata)
    values ('sess-shared', 'user', 'Ich bin B', '[]', '{}')
$q$);

select rls_test.expect_count('B reads only own rows of a shared session id', $q$
    select 1 from public.chat_history where session_id = 'sess-shared'
$q$, 1);

select rls_test.expect_affected('B deleting a session removes only B''s rows', $q$
    delete from public.chat_history where session_id = 'sess-shared'
$q$, 1);

select rls_test.expect_affected('B cannot update A''s document', $q$
    update public.knowledge_documents set title = 'gehackt'
    where id = 'd0000000-0000-4000-8000-0000000000a1'
$q$, 0);

select rls_test.expect_affected('B cannot delete A''s document', $q$
    delete from public.knowledge_documents where id = 'd0000000-0000-4000-8000-0000000000a1'
$q$, 0);

select rls_test.expect_error('B cannot add sections to A''s document', $q$
    insert into public.knowledge_sections (document_id, markdown_content)
    values ('d0000000-0000-4000-8000-0000000000a1', 'eingeschleust')
$q$);

select rls_test.expect_affected('B cannot update A''s sections', $q$
    update public.knowledge_sections set markdown_content = 'gehackt'
    where document_id = 'd0000000-0000-4000-8000-0000000000a1'
$q$, 0);

select rls_test.expect_affected('B cannot delete A''s sections', $q$
    delete from public.knowledge_sections where document_id = 'd0000000-0000-4000-8000-0000000000a1'
$q$, 0);

select rls_test.expect_affected('B cannot update A''s entity', $q$
    update public.knowledge_entities set description = 'gehackt' where name = 'A Geheimprojekt'
$q$, 0);

select rls_test.expect_affected('B cannot delete A''s entity', $q$
    delete from public.knowledge_entities where name = 'A Geheimprojekt'
$q$, 0);

select rls_test.expect_affected('B cannot update A''s relation', $q$
    update public.knowledge_relations set relation_type = 'gehackt'
    where owner_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
$q$, 0);

select rls_test.expect_affected('B cannot delete A''s relation', $q$
    delete from public.knowledge_relations where owner_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
$q$, 0);

select rls_test.expect_affected('B cannot delete A''s chat rows', $q$
    delete from public.chat_history where session_id = 'sess-a-only'
$q$, 0);

select rls_test.expect_error('B cannot update chat rows', $q$
    update public.chat_history set content = 'gehackt' where session_id = 'sess-a-only'
$q$);

select rls_test.expect_ok('B inserts an entity', $q$
    insert into public.knowledge_entities (name, entity_type, description, properties)
    values ('B Thema', 'topic', 'Nur fuer B', '{}')
$q$);

select rls_test.expect_error('B cannot link to A''s private entity', format($q$
    insert into public.knowledge_relations (source_entity_id, target_entity_id, relation_type)
    select e.id, %L, 'spies_on' from public.knowledge_entities e where e.name = 'B Thema'
$q$, :'a_entity_id'));

select rls_test.expect_count('B does not find A''s document with search_knowledge', $q$
    select 1 from public.search_knowledge('Passwort')
$q$, 0);

select rls_test.expect_ok('B writes a chat row before being deleted', $q$
    insert into public.chat_history (session_id, role, content) values ('sess-b', 'user', 'Tschuess')
$q$);

select rls_test.expect_ok('B inserts a private document', $q$
    insert into public.knowledge_documents (id, title, raw_content)
    values ('d0000000-0000-4000-8000-0000000000b1', 'B Notiz', 'Nur fuer B')
$q$);

select rls_test.expect_ok('B inserts a section into own document', $q$
    insert into public.knowledge_sections (document_id, heading, markdown_content)
    values ('d0000000-0000-4000-8000-0000000000b1', 'B Abschnitt', 'Nur fuer B')
$q$);

select rls_test.expect_ok('B links own entity to a public entity', $q$
    insert into public.knowledge_relations (source_entity_id, target_entity_id, relation_type)
    select e.id, 'e0000000-0000-4000-8000-000000000001', 'related_to'
    from public.knowledge_entities e where e.name = 'B Thema'
$q$);

:as_super
select rls_test.expect_true('A''s rows are intact after B''s attempts', $q$
    select (select title = 'A Passwortrichtlinie' from public.knowledge_documents
            where id = 'd0000000-0000-4000-8000-0000000000a1')
       and (select bool_and(markdown_content like 'Alle Passw%') and count(*) = 1 from public.knowledge_sections
            where document_id = 'd0000000-0000-4000-8000-0000000000a1')
       and (select description = 'Nur fuer A' from public.knowledge_entities where name = 'A Geheimprojekt')
       and (select bool_and(relation_type = 'part_of') and count(*) = 1 from public.knowledge_relations
            where owner_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
       and (select count(*) = 1 from public.chat_history where session_id = 'sess-a-only')
$q$);

-- ------------------------------------------------------------------------------
-- User A against B's private rows
-- ------------------------------------------------------------------------------
:as_a
select rls_test.expect_count('A cannot see B''s document, section, entity, relation or chat rows', $q$
    select 1 from public.knowledge_documents where id = 'd0000000-0000-4000-8000-0000000000b1'
    union all
    select 1 from public.knowledge_sections where document_id = 'd0000000-0000-4000-8000-0000000000b1'
    union all
    select 1 from public.knowledge_entities where name = 'B Thema'
    union all
    select 1 from public.knowledge_relations where owner_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    union all
    select 1 from public.chat_history where session_id = 'sess-b'
$q$, 0);

select rls_test.expect_affected('A cannot update B''s document', $q$
    update public.knowledge_documents set title = 'gehackt' where id = 'd0000000-0000-4000-8000-0000000000b1'
$q$, 0);

select rls_test.expect_affected('A cannot delete B''s document', $q$
    delete from public.knowledge_documents where id = 'd0000000-0000-4000-8000-0000000000b1'
$q$, 0);

select rls_test.expect_error('A cannot add sections to B''s document', $q$
    insert into public.knowledge_sections (document_id, markdown_content)
    values ('d0000000-0000-4000-8000-0000000000b1', 'eingeschleust')
$q$);

select rls_test.expect_affected('A cannot update B''s sections', $q$
    update public.knowledge_sections set markdown_content = 'gehackt'
    where document_id = 'd0000000-0000-4000-8000-0000000000b1'
$q$, 0);

select rls_test.expect_affected('A cannot delete B''s sections', $q$
    delete from public.knowledge_sections where document_id = 'd0000000-0000-4000-8000-0000000000b1'
$q$, 0);

select rls_test.expect_affected('A cannot update B''s entity', $q$
    update public.knowledge_entities set description = 'gehackt' where name = 'B Thema'
$q$, 0);

select rls_test.expect_affected('A cannot delete B''s entity', $q$
    delete from public.knowledge_entities where name = 'B Thema'
$q$, 0);

select rls_test.expect_affected('A cannot update B''s relation', $q$
    update public.knowledge_relations set relation_type = 'gehackt'
    where owner_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
$q$, 0);

select rls_test.expect_affected('A cannot delete B''s relation', $q$
    delete from public.knowledge_relations where owner_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
$q$, 0);

select rls_test.expect_affected('A cannot delete B''s chat rows', $q$
    delete from public.chat_history where session_id = 'sess-b'
$q$, 0);

:as_super
select rls_test.expect_true('B''s rows are intact after A''s attempts', $q$
    select (select title = 'B Notiz' from public.knowledge_documents
            where id = 'd0000000-0000-4000-8000-0000000000b1')
       and (select bool_and(markdown_content = 'Nur fuer B') and count(*) = 1 from public.knowledge_sections
            where document_id = 'd0000000-0000-4000-8000-0000000000b1')
       and (select description = 'Nur fuer B' from public.knowledge_entities where name = 'B Thema')
       and (select bool_and(relation_type = 'related_to') and count(*) = 1 from public.knowledge_relations
            where owner_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
       and (select count(*) = 1 from public.chat_history where session_id = 'sess-b')
$q$);

-- ------------------------------------------------------------------------------
-- anon (browser before sign-in)
-- ------------------------------------------------------------------------------
:as_anon
select rls_test.expect_error('anon cannot read chat_history', $q$
    select * from public.chat_history
$q$);

select rls_test.expect_error('anon cannot write chat_history', $q$
    insert into public.chat_history (session_id, role, content) values ('s', 'user', 'x')
$q$);

select rls_test.expect_error('anon cannot delete chat_history', $q$
    delete from public.chat_history where session_id = 'sess-a-only'
$q$);

select rls_test.expect_count('anon sees public documents only', $q$
    select 1 from public.knowledge_documents
    where id in ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002',
                 'd0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000004',
                 'd0000000-0000-4000-8000-0000000000a1')
$q$, 3);

select rls_test.expect_count('anon never sees private documents', $q$
    select 1 from public.knowledge_documents where not is_public
$q$, 0);

select rls_test.expect_count('anon sees sections of public documents', $q$
    select 1 from public.knowledge_sections where document_id = 'd0000000-0000-4000-8000-000000000001'
$q$, 2);

select rls_test.expect_count('anon cannot see sections of private documents', $q$
    select 1 from public.knowledge_sections
    where document_id in ('d0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-0000000000a1')
$q$, 0);

select rls_test.expect_error('anon cannot insert documents', $q$
    insert into public.knowledge_documents (title) values ('anon')
$q$);

select rls_test.expect_error('anon cannot update documents', $q$
    update public.knowledge_documents set title = 'anon'
$q$);

select rls_test.expect_error('anon cannot delete documents', $q$
    delete from public.knowledge_documents
$q$);

select rls_test.expect_error('anon cannot insert sections', $q$
    insert into public.knowledge_sections (document_id, markdown_content)
    values ('d0000000-0000-4000-8000-000000000001', 'anon')
$q$);

select rls_test.expect_count('anon sees public entities only', $q$
    select 1 from public.knowledge_entities where name in ('Projekt Alpha', 'A Geheimprojekt', 'B Thema')
$q$, 1);

select rls_test.expect_count('anon sees no private relations', $q$
    select 1 from public.knowledge_relations where not is_public
$q$, 0);

select rls_test.expect_error('anon cannot insert entities', $q$
    insert into public.knowledge_entities (name, entity_type) values ('anon', 'topic')
$q$);

select rls_test.expect_error('anon cannot read brain_settings', $q$
    select * from public.brain_settings
$q$);

select rls_test.expect_error('anon cannot write brain_settings', $q$
    insert into public.brain_settings (key, value) values ('x', '{}')
$q$);

select rls_test.expect_true('search_knowledge ranks the denser German match first', $q$
    select array_agg(heading order by ord) = array['Budgetplanung', 'Kampagnen']
       and bool_and(rank > 0)
    from (select heading, rank, row_number() over () as ord
          from public.search_knowledge('Budget')) s
$q$);

select rls_test.expect_true('search_knowledge returns ranks in descending order', $q$
    select bool_and(rank <= prev)
    from (select rank, lag(rank, 1, 'Infinity'::real) over () as prev
          from public.search_knowledge('Budget OR Oktober OR Kaffeemaschine', 20)) s
$q$);

select rls_test.expect_true('search_knowledge applies websearch AND and stemming', $q$
    select count(*) = 1 and bool_and(heading = 'Budgetplanung')
    from public.search_knowledge('Budgets Alpha')
$q$);

select rls_test.expect_count('search_knowledge supports OR and phrases', $q$
    select 1 from public.search_knowledge('Budget OR "Projekt Alpha" Oktober')
$q$, 3);

select rls_test.expect_true('search_knowledge falls back to a document-level hit', $q$
    select count(*) = 1
       and bool_and(section_id is null and heading is null
                    and document_title = 'Reisekostenrichtlinie'
                    and markdown_content = 'Regeln für Dienstreisen und Spesen')
    from public.search_knowledge('Dienstreisen')
$q$);

select rls_test.expect_count('search_knowledge hides private service documents', $q$
    select 1 from public.search_knowledge('Gehaltsbänder')
$q$, 0);

select rls_test.expect_count('search_knowledge hides private user documents', $q$
    select 1 from public.search_knowledge('Passwort')
$q$, 0);

select rls_test.expect_count('search_knowledge: empty query returns nothing', $q$
    select 1 from public.search_knowledge('')
$q$, 0);

select rls_test.expect_count('search_knowledge: blank query returns nothing', $q$
    select 1 from public.search_knowledge('   ')
$q$, 0);

select rls_test.expect_count('search_knowledge: null query returns nothing', $q$
    select 1 from public.search_knowledge(null)
$q$, 0);

select rls_test.expect_count('search_knowledge: default match_count is 6', $q$
    select 1 from public.search_knowledge('Kaffeemaschine')
$q$, 6);

select rls_test.expect_count('search_knowledge: match_count is capped at 20', $q$
    select 1 from public.search_knowledge('Kaffeemaschine', 1000)
$q$, 20);

select rls_test.expect_count('search_knowledge: match_count below 1 returns 1 row', $q$
    select 1 from public.search_knowledge('Kaffeemaschine', 0)
$q$, 1);

\if :legacy
select rls_test.expect_count('anon finds the legacy public document', $q$
    select 1 from public.search_knowledge('Altbestand')
    where document_id = '11111111-1111-4111-8111-111111111111'
$q$, 1);
\endif

select rls_test.expect_error('anon cannot execute ingest_document_atomic', $q$
    select public.ingest_document_atomic('x', 'x', '{}', 'text', 'x', 'x', '[]')
$q$);

select rls_test.expect_error('anon cannot execute match_knowledge_sections', $q$
    select * from public.match_knowledge_sections(rls_test.onehot(3), 0.1, 5)
$q$);

select rls_test.expect_error('anon cannot execute match_knowledge_hybrid', $q$
    select * from public.match_knowledge_hybrid('Budget', rls_test.onehot(3), 5)
$q$);

-- ------------------------------------------------------------------------------
-- Publishing (service role) and cleanup paths
-- ------------------------------------------------------------------------------
:as_service
select rls_test.expect_affected('service_role publishes the ingested document', $q$
    update public.knowledge_documents set is_public = true where title = 'Ingest Test'
$q$, 1);

:as_anon
select rls_test.expect_count('sections follow the parent once it is public', $q$
    select 1 from public.knowledge_sections s
    join public.knowledge_documents d on d.id = s.document_id
    where d.title = 'Ingest Test'
$q$, 2);

:as_a
select rls_test.expect_count('A: match_knowledge_sections sees the published section', $q$
    select 1 from public.match_knowledge_sections(rls_test.onehot(1), 0.5, 5)
$q$, 1);

select rls_test.expect_count('B''s delete left A''s rows of the shared session', $q$
    select 1 from public.chat_history where session_id = 'sess-shared'
$q$, 2);

select rls_test.expect_affected('A deletes own session', $q$
    delete from public.chat_history where session_id = 'sess-shared'
$q$, 2);

select rls_test.expect_affected('A deletes own document', $q$
    delete from public.knowledge_documents where title = 'A Entwurf'
$q$, 1);

-- ------------------------------------------------------------------------------
-- Published rows are read-only for their owner
-- ------------------------------------------------------------------------------
select rls_test.expect_ok('A inserts a document to be published', $q$
    insert into public.knowledge_documents (id, title, raw_content)
    values ('d0000000-0000-4000-8000-0000000000a2', 'A Freigabe', 'Freigegebener Inhalt')
$q$);

select rls_test.expect_ok('A inserts a section into the document to be published', $q$
    insert into public.knowledge_sections (id, document_id, section_index, heading, markdown_content)
    values ('50000000-0000-4000-8000-0000000000a2', 'd0000000-0000-4000-8000-0000000000a2', 0,
            'Freigabe', 'Freigegebener Abschnitt')
$q$);

select rls_test.expect_ok('A inserts an entity to be published', $q$
    insert into public.knowledge_entities (id, name, entity_type, description)
    values ('e0000000-0000-4000-8000-0000000000a2', 'A Freigabeprojekt', 'project', 'Vor der Freigabe')
$q$);

select rls_test.expect_ok('A links the entity to be published', $q$
    insert into public.knowledge_relations (id, source_entity_id, target_entity_id, relation_type)
    values ('f0000000-0000-4000-8000-0000000000a2', 'e0000000-0000-4000-8000-0000000000a2',
            'e0000000-0000-4000-8000-000000000001', 'part_of')
$q$);

select rls_test.expect_affected('A updates a section of own private document', $q$
    update public.knowledge_sections set markdown_content = 'Freigegebener Abschnitt, geprueft'
    where id = '50000000-0000-4000-8000-0000000000a2'
$q$, 1);

select rls_test.expect_affected('A updates own private entity', $q$
    update public.knowledge_entities set description = 'Zur Freigabe'
    where id = 'e0000000-0000-4000-8000-0000000000a2'
$q$, 1);

select rls_test.expect_affected('A updates own private relation', $q$
    update public.knowledge_relations set relation_type = 'belongs_to'
    where id = 'f0000000-0000-4000-8000-0000000000a2'
$q$, 1);

:as_service
select rls_test.expect_affected('service_role publishes A''s document', $q$
    update public.knowledge_documents set is_public = true where id = 'd0000000-0000-4000-8000-0000000000a2'
$q$, 1);

select rls_test.expect_affected('service_role publishes A''s entity', $q$
    update public.knowledge_entities set is_public = true where id = 'e0000000-0000-4000-8000-0000000000a2'
$q$, 1);

select rls_test.expect_affected('service_role publishes A''s relation', $q$
    update public.knowledge_relations set is_public = true where id = 'f0000000-0000-4000-8000-0000000000a2'
$q$, 1);

:as_a
select rls_test.expect_count('A still sees own published document and section', $q$
    select 1 from public.knowledge_documents where id = 'd0000000-0000-4000-8000-0000000000a2'
    union all
    select 1 from public.knowledge_sections where document_id = 'd0000000-0000-4000-8000-0000000000a2'
$q$, 2);

select rls_test.expect_affected('A cannot update own published document', $q$
    update public.knowledge_documents set title = 'umgeschrieben'
    where id = 'd0000000-0000-4000-8000-0000000000a2'
$q$, 0);

select rls_test.expect_affected('A cannot unpublish own published document', $q$
    update public.knowledge_documents set is_public = false
    where id = 'd0000000-0000-4000-8000-0000000000a2'
$q$, 0);

select rls_test.expect_affected('A cannot delete own published document', $q$
    delete from public.knowledge_documents where id = 'd0000000-0000-4000-8000-0000000000a2'
$q$, 0);

select rls_test.expect_error('A cannot add sections to own published document', $q$
    insert into public.knowledge_sections (document_id, markdown_content)
    values ('d0000000-0000-4000-8000-0000000000a2', 'eingeschleust')
$q$);

select rls_test.expect_affected('A cannot update sections of own published document', $q$
    update public.knowledge_sections set markdown_content = 'umgeschrieben'
    where document_id = 'd0000000-0000-4000-8000-0000000000a2'
$q$, 0);

select rls_test.expect_affected('A cannot move a section out of own published document', $q$
    update public.knowledge_sections set document_id = 'd0000000-0000-4000-8000-0000000000a1'
    where document_id = 'd0000000-0000-4000-8000-0000000000a2'
$q$, 0);

select rls_test.expect_error('A cannot move a section into own published document', $q$
    update public.knowledge_sections set document_id = 'd0000000-0000-4000-8000-0000000000a2'
    where document_id = 'd0000000-0000-4000-8000-0000000000a1'
$q$);

select rls_test.expect_affected('A cannot delete sections of own published document', $q$
    delete from public.knowledge_sections where document_id = 'd0000000-0000-4000-8000-0000000000a2'
$q$, 0);

select rls_test.expect_affected('A cannot update own published entity', $q$
    update public.knowledge_entities set description = 'umgeschrieben'
    where id = 'e0000000-0000-4000-8000-0000000000a2'
$q$, 0);

select rls_test.expect_affected('A cannot delete own published entity', $q$
    delete from public.knowledge_entities where id = 'e0000000-0000-4000-8000-0000000000a2'
$q$, 0);

select rls_test.expect_affected('A cannot update own published relation', $q$
    update public.knowledge_relations set relation_type = 'umgeschrieben'
    where id = 'f0000000-0000-4000-8000-0000000000a2'
$q$, 0);

select rls_test.expect_affected('A cannot delete own published relation', $q$
    delete from public.knowledge_relations where id = 'f0000000-0000-4000-8000-0000000000a2'
$q$, 0);

:as_super
select rls_test.expect_true('published rows are unchanged', $q$
    select (select title = 'A Freigabe' and is_public and owner_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
            from public.knowledge_documents where id = 'd0000000-0000-4000-8000-0000000000a2')
       and (select count(*) = 1 and bool_and(markdown_content = 'Freigegebener Abschnitt, geprueft')
            from public.knowledge_sections where document_id = 'd0000000-0000-4000-8000-0000000000a2')
       and (select description = 'Zur Freigabe' and is_public
            from public.knowledge_entities where id = 'e0000000-0000-4000-8000-0000000000a2')
       and (select relation_type = 'belongs_to' and is_public
            from public.knowledge_relations where id = 'f0000000-0000-4000-8000-0000000000a2')
       and (select count(*) = 1 from public.knowledge_sections
            where document_id = 'd0000000-0000-4000-8000-0000000000a1')
$q$);

select rls_test.expect_count('deleting a document cascades to its sections', $q$
    select 1 from public.knowledge_sections s
    where not exists (select 1 from public.knowledge_documents d where d.id = s.document_id)
$q$, 0);

select rls_test.expect_ok('deleting an auth user', $q$
    delete from auth.users where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
$q$);

select rls_test.expect_count('... removes the user''s chat rows', $q$
    select 1 from public.chat_history where session_id = 'sess-b'
$q$, 0);

select rls_test.expect_true('... and keeps the user''s knowledge rows private without owner', $q$
    select owner_id is null and not is_public from public.knowledge_entities where name = 'B Thema'
$q$);

do $$
begin
    raise notice 'rls_test: % checks passed', current_setting('rls_test.passed');
end
$$;
