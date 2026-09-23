-- Minimal stand-in for the parts of a Supabase database that the Starpi
-- schema depends on. Test use only: run as a superuser on a throwaway
-- database, never on a real project.
--
-- Provides:
--   * roles anon, authenticated, service_role (service_role bypasses RLS)
--   * auth.users and auth.uid(), reading the JWT subject the same way
--     Supabase does (request.jwt.claim.sub or request.jwt.claims ->> 'sub')
--   * Supabase's default privileges: every new table / function in public is
--     granted to anon, authenticated and service_role, so the tests prove the
--     explicit REVOKEs in the schema actually matter
--   * the vector extension in schema public (same as the live project)
--   * sentinel objects named like the other app sharing the database, used to
--     prove the Starpi SQL leaves them untouched

\set ON_ERROR_STOP 1
set client_min_messages = warning;

do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon nologin noinherit;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin noinherit;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
        create role service_role nologin noinherit bypassrls;
    end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;

alter default privileges in schema public
    grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
    grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public
    grant all on sequences to anon, authenticated, service_role;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
    id uuid primary key,
    is_anonymous boolean not null default false,
    created_at timestamptz not null default now()
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
    select coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;

create extension if not exists vector with schema public;

-- Sentinel objects of the other app sharing the database. The Starpi SQL must
-- never change them; rls_test.sql compares their fingerprint.
create table if not exists public.leads (
    id uuid primary key default gen_random_uuid(),
    email text not null
);
alter table public.leads enable row level security;
drop policy if exists leads_sentinel_insert on public.leads;
create policy leads_sentinel_insert on public.leads
    for insert to anon with check (true);

create or replace function public.prune_conversion_events()
returns void
language sql
security definer
as $$ select $$;

create schema if not exists supabase_stub;

create or replace function supabase_stub.sentinel_fingerprint()
returns text
language sql
stable
as $$
    select concat_ws(' | ',
        (select string_agg(concat_ws(':', policyname, cmd, roles::text, qual, with_check), ',' order by policyname)
           from pg_policies where schemaname = 'public' and tablename = 'leads'),
        (select relacl::text || ':' || relrowsecurity::text
           from pg_class where oid = 'public.leads'::regclass),
        (select coalesce(proacl::text, 'default') || ':' || prosecdef::text || ':' || prosrc
           from pg_proc where oid = 'public.prune_conversion_events()'::regprocedure)
    )
$$;

drop table if exists supabase_stub.sentinel;
create table supabase_stub.sentinel as
    select supabase_stub.sentinel_fingerprint() as fingerprint;
