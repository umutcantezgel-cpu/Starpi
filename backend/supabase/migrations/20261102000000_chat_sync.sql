-- ==============================================================================
-- Starpi migration 20261102000000: end-to-end encrypted chat sync
-- ==============================================================================
--
-- Optional. Needs only the Supabase auth schema (auth.users, auth.uid()), so it
-- can run before or after the other migrations; applied in file-name order it
-- runs last. Without it the app keeps every conversation on the device.
--
-- What it does (details in README.md):
--   * chat_sync: one row per synced conversation and user. The browser
--     encrypts the conversation with AES-GCM before it sends it; the row holds
--     an opaque id (an HMAC of the conversation id under the user's sync key),
--     a revision number, the IV and the ciphertext, all as base64. Nothing in
--     a row is readable without the user's passphrase.
--   * chat_sync_keys: one row per user with the sync key wrapped by a key the
--     browser derives from the passphrase (PBKDF2-SHA256, at least 600000
--     iterations, random salt). The passphrase itself never leaves the browser.
--   * Owner-only row level security on both tables; anon has no access.
--   * A trigger keeps owner and id of a chat_sync row fixed, lets the revision
--     only grow and stamps updated_at with the server time.
--
-- The plaintext chat_history table is not changed: the app no longer writes it,
-- and only deletes the rows an earlier version stored.
--
-- Safe to run more than once. Runs in a single transaction.
-- ==============================================================================

begin;

set local lock_timeout = '15s';

-- ------------------------------------------------------------------------------
-- 0. Preconditions
-- ------------------------------------------------------------------------------
do $$
begin
    if to_regclass('auth.users') is null or to_regprocedure('auth.uid()') is null then
        raise exception 'auth.users / auth.uid() not found: run this migration on a Supabase database';
    end if;
end
$$;

-- ------------------------------------------------------------------------------
-- 1. Tables
-- ------------------------------------------------------------------------------
-- Formats (checked here so that a row can only ever hold opaque data):
--   conv_id      32 characters of base64url (24 bytes of an HMAC-SHA-256)
--   iv           16 characters of base64 (12 bytes)
--   ciphertext   base64 of the AES-GCM output, at most 2800000 characters
--   key_id       22 characters of base64url (16 random bytes)
--   salt         24 characters of base64 (16 bytes)
--   wrapped_key  64 characters of base64 (a 32-byte key plus the 16-byte tag)
create table if not exists public.chat_sync (
    user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
    conv_id text not null,
    rev bigint not null,
    iv text not null,
    ciphertext text not null,
    updated_at timestamptz not null default now(),
    constraint chat_sync_pkey primary key (user_id, conv_id),
    constraint chat_sync_conv_id_format check (conv_id ~ '^[A-Za-z0-9_-]{32}$'),
    constraint chat_sync_rev_positive check (rev > 0),
    constraint chat_sync_iv_format check (iv ~ '^[A-Za-z0-9+/]{16}$'),
    constraint chat_sync_ciphertext_format check (
        char_length(ciphertext) between 24 and 2800000
        and char_length(ciphertext) % 4 = 0
        and ciphertext ~ '^[A-Za-z0-9+/]+={0,2}$'
    )
);

comment on table public.chat_sync is
    'End-to-end encrypted conversations: AES-GCM ciphertext made in the browser, opaque ids, owner only.';

create table if not exists public.chat_sync_keys (
    user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
    key_id text not null,
    kdf text not null,
    iterations integer not null,
    salt text not null,
    iv text not null,
    wrapped_key text not null,
    created_at timestamptz not null default now(),
    constraint chat_sync_keys_pkey primary key (user_id),
    constraint chat_sync_keys_key_id_format check (key_id ~ '^[A-Za-z0-9_-]{22}$'),
    constraint chat_sync_keys_kdf_check check (kdf = 'PBKDF2-SHA256'),
    constraint chat_sync_keys_iterations_range check (iterations between 600000 and 10000000),
    constraint chat_sync_keys_salt_format check (salt ~ '^[A-Za-z0-9+/]{22}==$'),
    constraint chat_sync_keys_iv_format check (iv ~ '^[A-Za-z0-9+/]{16}$'),
    constraint chat_sync_keys_wrapped_key_format check (wrapped_key ~ '^[A-Za-z0-9+/]{64}$')
);

comment on table public.chat_sync_keys is
    'The chat sync key of a user, wrapped with a key derived from a passphrase that never leaves the browser.';

-- ------------------------------------------------------------------------------
-- 2. Row guard
-- ------------------------------------------------------------------------------
-- A row keeps its owner and id; an update must raise the revision (a stale
-- write fails with SQLSTATE 40001 instead of replacing a newer one); the
-- server sets updated_at.
create or replace function public.chat_sync_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if tg_op = 'UPDATE' then
        if new.user_id is distinct from old.user_id or new.conv_id is distinct from old.conv_id then
            raise exception 'a chat_sync row keeps its owner and id' using errcode = '42501';
        end if;
        if new.rev <= old.rev then
            raise exception 'chat_sync revision % is not newer than %', new.rev, old.rev using errcode = '40001';
        end if;
    end if;
    new.updated_at := now();
    return new;
end;
$$;

revoke all on function public.chat_sync_guard() from public, anon, authenticated, service_role;

drop trigger if exists chat_sync_guard on public.chat_sync;
create trigger chat_sync_guard
    before insert or update on public.chat_sync
    for each row execute function public.chat_sync_guard();

-- ------------------------------------------------------------------------------
-- 3. Row level security: owner only, nothing for anon
-- ------------------------------------------------------------------------------
alter table public.chat_sync enable row level security;
alter table public.chat_sync_keys enable row level security;

drop policy if exists chat_sync_select_own on public.chat_sync;
drop policy if exists chat_sync_insert_own on public.chat_sync;
drop policy if exists chat_sync_update_own on public.chat_sync;
drop policy if exists chat_sync_delete_own on public.chat_sync;
drop policy if exists chat_sync_keys_select_own on public.chat_sync_keys;
drop policy if exists chat_sync_keys_insert_own on public.chat_sync_keys;
drop policy if exists chat_sync_keys_delete_own on public.chat_sync_keys;

-- Any other policy on these tables would be OR-ed with the ones below.
do $$
declare
    pol record;
begin
    for pol in
        select tablename, policyname
        from pg_policies
        where schemaname = 'public' and tablename in ('chat_sync', 'chat_sync_keys')
    loop
        raise notice 'dropping unexpected policy % on public.%', pol.policyname, pol.tablename;
        execute format('drop policy %I on public.%I', pol.policyname, pol.tablename);
    end loop;
end
$$;

create policy chat_sync_select_own on public.chat_sync
    for select to authenticated
    using (user_id = (select auth.uid()));

create policy chat_sync_insert_own on public.chat_sync
    for insert to authenticated
    with check (user_id = (select auth.uid()));

create policy chat_sync_update_own on public.chat_sync
    for update to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()));

create policy chat_sync_delete_own on public.chat_sync
    for delete to authenticated
    using (user_id = (select auth.uid()));

create policy chat_sync_keys_select_own on public.chat_sync_keys
    for select to authenticated
    using (user_id = (select auth.uid()));

create policy chat_sync_keys_insert_own on public.chat_sync_keys
    for insert to authenticated
    with check (user_id = (select auth.uid()));

create policy chat_sync_keys_delete_own on public.chat_sync_keys
    for delete to authenticated
    using (user_id = (select auth.uid()));

-- ------------------------------------------------------------------------------
-- 4. Privileges
-- ------------------------------------------------------------------------------
-- The key row is written once and replaced by delete + insert, never updated.
revoke all on table public.chat_sync, public.chat_sync_keys from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.chat_sync to authenticated, service_role;
grant select, insert, delete on table public.chat_sync_keys to authenticated;
grant select, insert, update, delete on table public.chat_sync_keys to service_role;

notify pgrst, 'reload schema';

commit;
