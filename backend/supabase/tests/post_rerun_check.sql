-- Runs after rls_test.sql and a further application of the migration on the
-- same database: re-running the migration must keep user data, ownership and
-- visibility exactly as they were.

\set ON_ERROR_STOP 1
\set QUIET 1
\set VERBOSITY terse
\o /dev/null
set client_min_messages = notice;

\set as_super 'reset role; set request.jwt.claim.sub = '''';'
\set as_anon 'reset role; set request.jwt.claim.sub = ''''; set role anon;'
\set as_a 'reset role; set request.jwt.claim.sub = ''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa''; set role authenticated;'

:as_super
select set_config('rls_test.passed', '0', false);

select rls_test.expect_true('re-run keeps A''s document private and owned by A', $q$
    select not is_public and owner_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    from public.knowledge_documents where id = 'd0000000-0000-4000-8000-0000000000a1'
$q$);

select rls_test.expect_true('re-run keeps A''s entity private', $q$
    select not is_public from public.knowledge_entities where name = 'A Geheimprojekt'
$q$);

select rls_test.expect_count('re-run keeps owned chat rows', $q$
    select 1 from public.chat_history
    where owner_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and session_id = 'sess-a-only'
$q$, 1);

select rls_test.expect_true('re-run keeps the private service document private', $q$
    select not is_public from public.knowledge_documents where id = 'd0000000-0000-4000-8000-000000000004'
$q$);

select rls_test.expect_true('re-run keeps the published document public', $q$
    select is_public from public.knowledge_documents where title = 'Ingest Test'
$q$);

:as_a
select rls_test.expect_count('A still reads own chat after re-run', $q$
    select 1 from public.chat_history where session_id = 'sess-a-only'
$q$, 1);

:as_anon
select rls_test.expect_count('anon still cannot see A''s document after re-run', $q$
    select 1 from public.knowledge_documents where id = 'd0000000-0000-4000-8000-0000000000a1'
$q$, 0);

:as_super
do $$
begin
    raise notice 'post_rerun_check: % checks passed', current_setting('rls_test.passed');
end
$$;
