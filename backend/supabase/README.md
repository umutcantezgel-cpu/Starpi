# Starpi database (Supabase)

SQL for the Starpi knowledge base: documents and sections with 1536-dim
pgvector embeddings (HNSW index), German full-text search, a small knowledge
graph, chat history and the RPCs used by the browser and the backend.

| Path | Purpose |
| --- | --- |
| `full_schema.sql` | Fresh install. Canonical schema, safe to re-run on a database it created. Refuses to run on a pre-hardening schema. |
| `migrations/20260923000000_harden_rls_anonymous_auth.sql` | Upgrade of an existing database (the live project and any install from an earlier `schema.sql` / `full_schema.sql`). Idempotent. |
| `schema.sql` | Kept for old links: includes `full_schema.sql` when run with psql. |
| `apply_migration.py` | Applies `full_schema.sql`, given files or all migrations to `DATABASE_URL`. |
| `tests/` | Local PostgreSQL tests for RLS, privileges, RPCs and idempotency (`run_rls_tests.sh`). |

Both SQL entry points run in one transaction: if anything fails, nothing is
changed. After `full_schema.sql` the migrations are no-ops, and the schema is
identical to an upgraded database (checked by the tests with `pg_dump`).

## Prerequisites

1. **Enable anonymous sign-ins**: Supabase dashboard, *Authentication > Sign In / Providers > Anonymous sign-ins*.
   The browser calls `supabase.auth.signInAnonymously()` and then works as role
   `authenticated` with its own user id. Without it the browser stays on the
   `anon` role: it can read public knowledge but cannot store chats or add
   documents.
2. Recommended for anonymous sign-ins: CAPTCHA protection (*Authentication > Attack Protection*)
   and a sensible rate limit for anonymous sign-ins (*Authentication > Rate Limits*).
   Every sign-in creates a row in `auth.users`.
3. The `vector` extension must live in schema `public` (it does in the live
   project; both SQL files check this and stop with a clear error otherwise).
4. Run the SQL as the owner of the Starpi tables (`postgres`, the default in
   the SQL editor and for the database connection string). Check with
   `select tablename, tableowner from pg_tables where tablename like 'knowledge_%' or tablename = 'chat_history';`

## Applying

Take a backup of the Starpi tables first (see [Rollback](#rollback)).

**Existing project (live database)**: apply the migration.

- SQL editor: paste `migrations/20260923000000_harden_rls_anonymous_auth.sql` and run it.
- psql: `psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f backend/supabase/migrations/20260923000000_harden_rls_anonymous_auth.sql`
- Python: `DATABASE_URL=... python backend/supabase/apply_migration.py --migrations`
- Supabase CLI: copy the file into your CLI project's `supabase/migrations/`
  and run `supabase db push`. The file has its own `begin; ... commit;`.

**New project**: apply `full_schema.sql` the same way (SQL editor, `psql -f`,
or `python backend/supabase/apply_migration.py` which defaults to it).

`DATABASE_URL` is the Postgres connection string from the dashboard (*Connect*),
e.g. `postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres`.
`apply_migration.py` uses psycopg / psycopg2 when installed and otherwise
`psql`; it passes credentials to psql via environment variables, not argv.

Both files end with `notify pgrst, 'reload schema'`, so the REST API sees the
changed functions and privileges immediately.

### Behaviour changes to be aware of

- `chat_history` rows that existed before the migration are **deleted**: they
  had no owner and were readable by anyone with the anon key (the live table
  had 0 rows).
- Knowledge rows that existed before the migration stay **public**
  (`is_public = true`). New rows are **private by default**, including rows the
  backend writes with the service role (`owner_id` is null for those). To show a
  backend document to browser users, publish it with the service role:
  `update public.knowledge_documents set is_public = true where id = '...';`
- `ingest_document_atomic` can only be called with the service role key;
  `match_knowledge_sections` / `match_knowledge_hybrid` need a signed-in user or
  the service role. The browser uses `search_knowledge` for keyword search.
- The global `UNIQUE (name, entity_type)` on `knowledge_entities` from the first
  `full_schema.sql` is dropped (it would let users block names for each other
  and reveal private entities).
- `chat_history.role` no longer accepts `'tool'`; content is limited to
  100000 characters, `session_id` to 1..128 characters, `sources` / `metadata`
  to 64 KiB of JSON each.

## Security model

Roles: `anon` = browser before sign-in (anon key), `authenticated` = browser
after anonymous sign-in (`owner_id = auth.uid()`), `service_role` = backend
(bypasses RLS). "own" means `owner_id = auth.uid()`; "visible" means
`is_public or owner_id = auth.uid()`.

| Table | anon | authenticated | service_role |
| --- | --- | --- | --- |
| `knowledge_documents` | SELECT public rows | SELECT visible; INSERT / UPDATE own rows with `is_public = false`; DELETE own | all rows, all DML |
| `knowledge_sections` | SELECT if parent document is public | SELECT if parent visible; INSERT / UPDATE / DELETE if parent is own | all rows, all DML |
| `knowledge_entities` | SELECT public rows | same as documents | all rows, all DML |
| `knowledge_relations` | SELECT public rows | same as documents; both endpoint entities must be visible to the writer | all rows, all DML |
| `chat_history` | nothing | SELECT / INSERT / DELETE own rows; no UPDATE | all rows, all DML |
| `brain_settings` | SELECT | SELECT | all DML |

| Function | anon | authenticated | service_role | Notes |
| --- | --- | --- | --- | --- |
| `search_knowledge(query_text, match_count default 6)` | yes | yes | yes | German full-text search, returns `section_id, document_id, document_title, heading, markdown_content, tags, rank`; `match_count` clamped to 1..20; blank query returns nothing |
| `match_knowledge_sections(query_embedding, match_threshold, match_count)` | no | yes | yes | vector search, `match_count` clamped to 1..50 |
| `match_knowledge_hybrid(query_text, query_embedding, match_count, rrf_k)` | no | yes | yes | reciprocal rank fusion of vector and full-text ranks |
| `ingest_document_atomic(...)` | no | no | yes | document + sections in one transaction |

All four functions are `SECURITY INVOKER` with `search_path = ''`, so RLS
applies to the caller and results only contain visible rows. Only the service
role may publish (`is_public = true`). Deleting a user from `auth.users`
deletes their chat history and leaves their knowledge rows private without an
owner (`on delete set null`), i.e. visible only to the service role.

Advisor note: *extension_in_public* (vector) is expected. The extension stays
in `public` because existing columns and indexes use `public.vector`.

The SQL only touches the Starpi objects above. Other objects in the same
database (`leads`, `bookings`, `conversion_events`, `prune_conversion_events`)
are left alone.

## Verification

Run in the SQL editor after applying.

```sql
-- RLS on, and exactly 20 policies with explicit roles
select c.relname, c.relrowsecurity,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
from pg_class c
where c.relnamespace = 'public'::regnamespace
  and c.relname in ('knowledge_documents', 'knowledge_sections', 'knowledge_entities',
                    'knowledge_relations', 'chat_history', 'brain_settings');

select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('knowledge_documents', 'knowledge_sections', 'knowledge_entities',
                    'knowledge_relations', 'chat_history', 'brain_settings')
order by tablename, policyname;

-- Table privileges per role
select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated', 'service_role')
  and table_name in ('knowledge_documents', 'knowledge_sections', 'knowledge_entities',
                     'knowledge_relations', 'chat_history', 'brain_settings')
group by table_name, grantee
order by table_name, grantee;

-- Functions: prosecdef = false, proconfig = {search_path=""}, EXECUTE per role
select p.oid::regprocedure as function, p.prosecdef, p.proconfig,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role', p.oid, 'execute') as service_role
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('search_knowledge', 'match_knowledge_sections',
                    'match_knowledge_hybrid', 'ingest_document_atomic');

-- Act as a signed-in user (use an id from auth.users) without changing anything
begin;
select set_config('request.jwt.claims', '{"sub": "<user-id>", "role": "authenticated"}', true);
set local role authenticated;
select count(*) from public.chat_history;                -- only that user's rows
select * from public.search_knowledge('Budget', 5);      -- only visible rows
rollback;
```

Over HTTP with the anon key, `GET /rest/v1/chat_history` must fail with
`42501` (HTTP 401), while `GET /rest/v1/knowledge_documents` returns only
public rows. *Database > Advisors > Security* should show no Starpi findings
apart from *extension_in_public*.

## Tests

`tests/run_rls_tests.sh` builds a throwaway PostgreSQL cluster (Unix socket
only), loads a small Supabase stand-in (`tests/stub_supabase.sql`: roles,
`auth.users`, `auth.uid()`, Supabase's default grants) and checks:

- the live shape (`tests/fixtures/live_shape.sql`) and both earlier schema
  versions, upgraded by the migration twice, then again with user data present;
- a fresh `full_schema.sql` (applied through `apply_migration.py`) plus the
  migration, and `schema.sql` followed by `full_schema.sql`;
- `full_schema.sql` refusing a pre-hardening database;
- identical `pg_dump` output for upgraded and fresh installs;
- about 110 RLS / privilege / RPC assertions per scenario (`tests/rls_test.sql`),
  run as `anon`, two different anonymous users and `service_role`.

```bash
# Debian / Ubuntu: apt-get install postgresql-16 postgresql-16-pgvector
PG_BIN=/usr/lib/postgresql/16/bin backend/supabase/tests/run_rls_tests.sh
```

It exits non-zero on any failure. As root it runs the server as the
`postgres` OS user (`PGTEST_OS_USER`); `PGTEST_KEEP=1` keeps logs and data.

## Rollback

- A failed run changes nothing (single transaction).
- Before applying to the live project, keep a copy of the Starpi tables:
  `pg_dump "$DATABASE_URL" --data-only --table='public.knowledge_*' --table=public.chat_history --table=public.brain_settings -f starpi_backup.sql`
  (Supabase also keeps daily backups / PITR depending on the plan).
- There is no automatic down migration. Going back to the old open policies
  would make chat history world readable and writable again and is not
  recommended. If the browser cannot read or write after the upgrade, check
  first that anonymous sign-ins are enabled and that the frontend signs in.
- If a revert is still required: the previous definitions (open policies,
  `SECURITY DEFINER` functions) are in `tests/fixtures/live_shape.sql`.
  Dropping the new policies and re-creating those restores the old behaviour;
  the added columns (`owner_id`, `is_public`, `fts`), tables and indexes can
  stay, since the old code ignores them. Deleted ownerless chat rows can only
  be recovered from a backup.
