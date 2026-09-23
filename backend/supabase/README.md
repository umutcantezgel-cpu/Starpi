# Starpi database (Supabase)

SQL for the Starpi knowledge base: documents and sections with 1536-dim
pgvector embeddings (HNSW index), German full-text search, a small knowledge
graph, chat history and the RPCs used by the browser and the backend.

| Path | Purpose |
| --- | --- |
| `full_schema.sql` | Fresh install. Canonical schema (the state after all migrations), safe to re-run on a database it created. Refuses to run on a pre-hardening schema. |
| `migrations/20260923000000_harden_rls_anonymous_auth.sql` | Upgrade 1 of an existing database (the live project and any install from an earlier `schema.sql` / `full_schema.sql`): owner-based RLS for anonymous sign-ins. Idempotent. |
| `migrations/20260924000000_lock_published_rows.sql` | Upgrade 2 (needs upgrade 1): published rows read-only for browser roles, `brain_settings` service role only, size limits for browser writes. Idempotent. |
| `schema.sql` | Kept for old links: includes `full_schema.sql` when run with psql. |
| `apply_migration.py` | Applies `full_schema.sql`, given files or all migrations (in file-name order) to `DATABASE_URL`. |
| `tests/` | Local PostgreSQL tests for RLS, privileges, RPCs, size limits and idempotency (`run_rls_tests.sh`). |

Every SQL file runs in one transaction: if anything fails, nothing from that
file is changed. After `full_schema.sql`, applying the migrations changes
nothing, and the schema is identical to an upgraded database (checked by the
tests with `pg_dump`).

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
   project; `full_schema.sql` and `20260923000000` check this and stop with a
   clear error otherwise).
4. Run the SQL as the owner of the Starpi tables (`postgres`, the default in
   the SQL editor and for the database connection string). Check with
   `select tablename, tableowner from pg_tables where tablename like 'knowledge_%' or tablename = 'chat_history';`

## Applying

Take a backup of the Starpi tables first (see [Rollback](#rollback)).

**Existing project (live database)**: apply the migrations in file-name order:

1. `migrations/20260923000000_harden_rls_anonymous_auth.sql`
2. `migrations/20260924000000_lock_published_rows.sql`

- SQL editor: paste and run the first file, then the second.
- psql:
  ```bash
  for f in backend/supabase/migrations/*.sql; do
      psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$f" || break
  done
  ```
- Python: `DATABASE_URL=... python backend/supabase/apply_migration.py --migrations`
  (all files in `migrations/`, in order, stops at the first failure)
- Supabase CLI: copy both files into your CLI project's `supabase/migrations/`
  and run `supabase db push`. Each file has its own `begin; ... commit;`.

The second file checks that the first one has been applied and stops
otherwise. Both are idempotent, but `20260923000000` re-creates its own
policies on every run (it first drops every policy on the Starpi tables), so
re-running it alone undoes the policy part of `20260924000000`. Always re-run
the whole set, as `--migrations` does.

**New project**: apply `full_schema.sql` the same way (SQL editor, `psql -f`,
or `python backend/supabase/apply_migration.py` which defaults to it).

`DATABASE_URL` is the Postgres connection string from the dashboard (*Connect*),
e.g. `postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres`.
`apply_migration.py` uses psycopg / psycopg2 when installed and otherwise
`psql`; it passes credentials to psql via environment variables, not argv.

Every file ends with `notify pgrst, 'reload schema'`, so the REST API sees the
changed functions and privileges immediately.

### Behaviour changes to be aware of

`20260923000000`:

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

`20260924000000`:

- Once the service role publishes a row (`is_public = true`), its owner can no
  longer update or delete it (including setting `is_public = false` again), and
  can no longer insert, update, move or delete the sections of a published
  document. Unpublish with the service role to hand a row back to its owner.
- `brain_settings` is readable by the service role only (the browser never used
  it). The `using (true)` policy and the SELECT privileges of `anon` /
  `authenticated` are gone; RLS stays enabled without any policy.
- Size limits (CHECK constraints) on every column the browser can write:

  | Table | Limits (characters unless noted) |
  | --- | --- |
  | `knowledge_documents` | `title` 500, `source_type` 64, `source_name` 500, `summary` 5000, `raw_content` 200000, `tags` at most 50 and 16 KiB as text, `metadata` 64 KiB of JSON |
  | `knowledge_sections` | `heading` 1000, `markdown_content` 210000 |
  | `knowledge_entities` | `name` 500, `entity_type` 64, `description` 5000, `properties` 64 KiB of JSON |
  | `knowledge_relations` | `relation_type` 64, `properties` 64 KiB of JSON (there is no description column) |
  | `chat_history` | `content` 20000 |

  They sit above what the PWA sends (`src/js/config.js` `LIMITS`: 200000
  characters of document text, 200 character titles, 8000 character chat input)
  and what the backend writes (it clips generated titles, summaries and
  headings to these limits). A violation fails with SQLSTATE `23514` (HTTP 400
  from the REST API).
- The limits are added `NOT VALID`: every new or updated row is checked, rows
  that already exist are not, so legacy data never blocks the migration. An
  UPDATE of an existing oversized row fails until the row fits. To find such
  rows and then validate a constraint:
  ```sql
  select id, char_length(title) from public.knowledge_documents where char_length(title) > 500;
  alter table public.knowledge_documents validate constraint knowledge_documents_title_max_length;
  ```
  (`full_schema.sql` adds the same constraints `NOT VALID` as well, so fresh and
  upgraded schemas stay identical.)

## Schema

Knowledge base and knowledge graph (columns of the canonical `full_schema.sql`; databases
upgraded from the older schema may keep additional legacy columns):

<!-- diagram: db-schema-er -->
```mermaid
erDiagram
    auth_users {
        uuid id PK "Supabase auth.users"
    }
    knowledge_documents {
        uuid id PK "default gen_random_uuid()"
        text title "not null, max 500 chars"
        text source_type "not null, default text, max 64 chars"
        text source_name "file name or source URI, max 500 chars"
        text raw_content "max 200000 chars"
        text summary "max 5000 chars"
        text_array tags "default empty, max 50 tags and 16 KiB, GIN index"
        jsonb metadata "default empty object, max 64 KiB"
        int total_sections "default 0"
        timestamptz created_at "not null, default now(), index desc"
        timestamptz updated_at "not null, default now()"
        uuid owner_id FK "default auth.uid(), null for service role rows, index"
        bool is_public "not null, default false"
        tsvector fts "generated stored, german title summary raw_content, GIN"
    }
    knowledge_sections {
        uuid id PK "default gen_random_uuid()"
        uuid document_id FK "not null, index"
        int section_index "not null, default 0"
        text heading "max 1000 chars"
        text markdown_content "not null, max 210000 chars"
        int token_count "default 0"
        vector embedding "vector(1536), nullable, HNSW cosine m 16 ef_construction 64"
        timestamptz created_at "not null, default now()"
        tsvector fts "generated stored, german heading markdown_content, GIN"
    }
    knowledge_entities {
        uuid id PK "default gen_random_uuid()"
        text name "not null, max 500 chars, no unique constraint"
        text entity_type "not null, max 64 chars"
        text description "max 5000 chars"
        jsonb properties "default empty object, max 64 KiB"
        uuid owner_id FK "default auth.uid(), index"
        bool is_public "not null, default false"
        timestamptz created_at "not null, default now()"
    }
    knowledge_relations {
        uuid id PK "default gen_random_uuid()"
        uuid source_entity_id FK "nullable, index"
        uuid target_entity_id FK "nullable, index"
        text relation_type "not null, max 64 chars"
        jsonb properties "default empty object, max 64 KiB"
        uuid owner_id FK "default auth.uid(), index"
        bool is_public "not null, default false"
        timestamptz created_at "not null, default now()"
    }

    knowledge_documents ||--o{ knowledge_sections : "document_id, on delete cascade"
    auth_users |o--o{ knowledge_documents : "owner_id, on delete set null"
    auth_users |o--o{ knowledge_entities : "owner_id, on delete set null"
    auth_users |o--o{ knowledge_relations : "owner_id, on delete set null"
    knowledge_entities |o--o{ knowledge_relations : "source_entity_id, on delete cascade"
    knowledge_entities |o--o{ knowledge_relations : "target_entity_id, on delete cascade"
```

Chat history and settings:

<!-- diagram: db-schema-chat-settings -->
```mermaid
erDiagram
    auth_users {
        uuid id PK "Supabase auth.users"
    }
    chat_history {
        uuid id PK "default gen_random_uuid()"
        text session_id "not null, 1 to 128 chars"
        text role "not null, user, assistant or system"
        text content "not null, max 20000 chars, older validated bound 100000"
        jsonb sources "not null, default empty array, max 64 KiB"
        jsonb metadata "not null, default empty object, max 64 KiB"
        timestamptz created_at "not null, default now()"
        uuid owner_id FK "not null, default auth.uid(), index with session_id, created_at"
    }
    brain_settings {
        text key PK "seeded llm_config and rag_config"
        jsonb value "not null"
        text description
        timestamptz updated_at "not null, default now()"
    }

    auth_users ||--o{ chat_history : "owner_id, on delete cascade"
```

## Security model

Roles: `anon` = browser before sign-in (anon key), `authenticated` = browser
after anonymous sign-in (`owner_id = auth.uid()`), `service_role` = backend
(bypasses RLS). "own" means `owner_id = auth.uid()`; "visible" means
`is_public or owner_id = auth.uid()`.

| Table | anon | authenticated | service_role |
| --- | --- | --- | --- |
| `knowledge_documents` | SELECT public rows | SELECT visible; INSERT own rows with `is_public = false`; UPDATE / DELETE own private rows (the result must stay own and private) | all rows, all DML |
| `knowledge_sections` | SELECT if parent document is public | SELECT if parent visible; INSERT / UPDATE / DELETE if parent is own and private | all rows, all DML |
| `knowledge_entities` | SELECT public rows | same as documents | all rows, all DML |
| `knowledge_relations` | SELECT public rows | same as documents; both endpoint entities must be visible to the writer | all rows, all DML |
| `chat_history` | nothing | SELECT / INSERT / DELETE own rows; no UPDATE | all rows, all DML |
| `brain_settings` | nothing | nothing | all DML |

| Function | anon | authenticated | service_role | Notes |
| --- | --- | --- | --- | --- |
| `search_knowledge(query_text, match_count default 6)` | yes | yes | yes | German full-text search, returns `section_id, document_id, document_title, heading, markdown_content, tags, rank`; `match_count` clamped to 1..20; blank query returns nothing |
| `match_knowledge_sections(query_embedding, match_threshold, match_count)` | no | yes | yes | vector search, `match_count` clamped to 1..50 |
| `match_knowledge_hybrid(query_text, query_embedding, match_count, rrf_k)` | no | yes | yes | reciprocal rank fusion of vector and full-text ranks |
| `ingest_document_atomic(...)` | no | no | yes | document + sections in one transaction |

All four functions are `SECURITY INVOKER` with `search_path = ''`, so RLS
applies to the caller and results only contain visible rows. Only the service
role may publish (`is_public = true`), and published rows are read-only for
every browser role. No policy is unconditional. Deleting a user from `auth.users`
deletes their chat history and leaves their knowledge rows private without an
owner (`on delete set null`), i.e. visible only to the service role.

How a browser request is decided, per table and for the functions and size limits:

<!-- diagram: rls-access-knowledge-rows -->
```mermaid
flowchart TD
    req["Request on knowledge_documents,<br/>knowledge_entities or knowledge_relations"]
    role{"Database role?"}
    req --> role
    role -->|"service_role, backend key"| svc["RLS bypassed, select, insert, update, delete<br/>on every row, only role that can publish<br/>or unpublish (is_public), size CHECKs still apply"]
    role -->|"anon, no session"| anonOp{"Operation?"}
    role -->|"authenticated, anonymous sign-in"| authOp{"Operation?"}

    anonOp -->|"insert, update, delete"| noGrant["Error 42501<br/>anon only has the SELECT grant"]
    anonOp -->|"select"| anonVis{"select_public_or_own<br/>is_public? auth.uid() is null for anon"}
    anonVis -->|"yes, public row"| shown["Row returned"]
    anonVis -->|"no, any private row"| filtered["Row filtered out, no error"]

    authOp -->|"select"| authVis{"select_public_or_own<br/>is_public or owner_id = auth.uid()?"}
    authVis -->|"yes, public, own private<br/>or own published"| shown
    authVis -->|"no, other user or<br/>ownerless private"| filtered

    authOp -->|"insert"| insChk{"insert_own WITH CHECK<br/>owner_id = auth.uid() and is_public = false?<br/>the column defaults satisfy both"}
    insChk -->|"no, foreign owner_id<br/>or is_public true"| rlsErr["Error 42501<br/>row violates row-level security policy"]
    insChk -->|"yes"| isRel{"knowledge_relations?"}
    isRel -->|"no"| sizeChk{"Size CHECK constraints pass?"}
    isRel -->|"yes"| endpoints{"source and target entity each exist<br/>with is_public or owner_id = auth.uid()?"}
    endpoints -->|"yes"| sizeChk
    endpoints -->|"no, private entity of another user<br/>or ownerless, null or unknown id"| rlsErr
    sizeChk -->|"yes"| applied["Write applied"]
    sizeChk -->|"no, e.g. title over 500 chars"| sizeErr["Error 23514<br/>check constraint violated"]

    authOp -->|"update, delete"| usingChk{"update_own, delete_own USING<br/>owner_id = auth.uid() and not is_public?"}
    usingChk -->|"no, own published, public,<br/>other user or ownerless row"| zeroRows["0 rows affected, no error"]
    usingChk -->|"yes, own private row"| opKind{"Operation?"}
    opKind -->|"delete"| deleted["Row deleted, a document<br/>takes its sections along (cascade)"]
    opKind -->|"update"| updChk{"update_own WITH CHECK on new row<br/>owner_id = auth.uid() and is_public = false?"}
    updChk -->|"no, publish or hand to other owner"| rlsErr
    updChk -->|"yes"| isRel

    names["Policy names are the table name plus<br/>_select_public_or_own, _insert_own,<br/>_update_own and _delete_own"]
    lock["Published-row lock, 20260924000000_lock_published_rows<br/>added and not is_public to the update and delete USING,<br/>before that owners could still change published rows.<br/>Re-running 20260923000000 alone restores the old policies"]
    names -.- role
    lock -.- usingChk
```

<!-- diagram: rls-access-sections-chat-settings -->
```mermaid
flowchart TD
    subgraph sg_settings["brain_settings, service role only"]
        bReq["Settings request"]
        bRole{"Role?"}
        bReq --> bRole
        bRole -->|"service_role"| bSvc["RLS bypassed,<br/>select, insert, update, delete"]
        bRole -->|"anon, authenticated"| bDeny["Error 42501 on read and write, no table grant<br/>(full_schema.sql never grants it, 20260924000000<br/>revokes it), RLS on with no policy"]
    end

    subgraph sg_chat["chat_history, owner only"]
        cReq["Chat row request"]
        cRole{"Role?"}
        cReq --> cRole
        cRole -->|"service_role"| cSvc["RLS bypassed, all rows,<br/>select, insert, update, delete"]
        cRole -->|"anon"| cAnon["Error 42501 for every operation<br/>no grant and no policy"]
        cRole -->|"authenticated"| cOp{"Operation?"}
        cOp -->|"update"| cUpd["Error 42501<br/>no UPDATE grant or policy"]
        cOp -->|"select, delete"| cOwn{"chat_history_select_own, chat_history_delete_own<br/>owner_id = auth.uid()?"}
        cOwn -->|"yes"| cMine["Only own rows, even when another<br/>user writes the same session_id"]
        cOwn -->|"no"| cOther["Invisible, delete affects 0 rows"]
        cOp -->|"insert"| cIns{"chat_history_insert_own WITH CHECK<br/>owner_id = auth.uid()?<br/>owner_id defaults to auth.uid()"}
        cIns -->|"no, owner_id of another user"| cErr["Error 42501"]
        cIns -->|"yes"| cChk{"CHECKs pass? role user, assistant or system,<br/>session_id 1 to 128 chars, content max 20000,<br/>sources and metadata max 64 KiB"}
        cChk -->|"yes"| cStored["Row stored"]
        cChk -->|"no"| cSize["Error 23514"]
    end

    subgraph sg_sections["knowledge_sections, access follows parent knowledge_documents row d"]
        sReq["Section request"]
        sRole{"Role?"}
        sReq --> sRole
        sRole -->|"service_role"| sSvc["RLS bypassed, all rows, all DML"]
        sRole -->|"anon"| sAnonOp{"Operation?"}
        sAnonOp -->|"insert, update, delete"| sNoGrant["Error 42501, no grant"]
        sAnonOp -->|"select"| sAnonVis{"knowledge_sections_select_visible_document<br/>d.is_public?"}
        sAnonVis -->|"yes"| sShown["Section returned"]
        sAnonVis -->|"no"| sHidden["Section filtered out"]
        sRole -->|"authenticated"| sParent{"State of parent d?"}
        sParent -->|"own private"| sRW["select, insert, update, delete allowed<br/>policies _insert, _update and _delete_own_document<br/>need EXISTS d with owner_id = auth.uid()<br/>and not d.is_public"]
        sParent -->|"public, including own published"| sRO["select only, insert or moving a section<br/>into it fails 42501,<br/>update and delete affect 0 rows"]
        sParent -->|"other user or ownerless private"| sNone["invisible, insert or moving a section<br/>into it fails 42501,<br/>update and delete affect 0 rows"]
        sRW -->|"insert, update"| sChk{"heading max 1000 chars,<br/>markdown_content max 210000?"}
        sChk -->|"yes"| sDone["Section written"]
        sChk -->|"no"| sSize["Error 23514"]
    end
    sg_settings ~~~ sg_chat
    sg_chat ~~~ sg_sections
```

<!-- diagram: rls-access-functions-limits -->
```mermaid
flowchart TD
    anon["anon"]
    authn["authenticated"]
    svc["service_role"]

    subgraph sg_fns["RPCs, SECURITY INVOKER, search_path empty, arrows are EXECUTE grants"]
        sk["search_knowledge<br/>(query_text, match_count default 6)<br/>German full text on sections, else document hit,<br/>1 to 20 rows, blank or null query returns none"]
        mks["match_knowledge_sections<br/>(query_embedding, match_threshold default 0.25,<br/>match_count default 5)<br/>vector search, 1 to 50 rows"]
        mkh["match_knowledge_hybrid<br/>(query_text, query_embedding,<br/>match_count default 5, rrf_k default 60)<br/>RRF of top 25 vector and top 25 full-text ranks,<br/>1 to 50 rows"]
        ing["ingest_document_atomic<br/>(doc_title, doc_summary, doc_tags,<br/>doc_source_type, doc_source_name,<br/>doc_raw_content, sections_data)<br/>new document is private, owner_id null,<br/>22023 if sections_data is not a JSON array"]
    end

    anon --> sk
    authn --> sk
    authn --> mks
    authn --> mkh
    svc --> sk
    svc --> mks
    svc --> mkh
    svc --> ing

    invoker["Runs as the caller, so table RLS<br/>limits rows to what the caller can see,<br/>service_role bypasses RLS.<br/>Every overload is dropped before create,<br/>so no older SECURITY DEFINER variant stays"]
    sk -.- invoker
    mks -.- invoker
    mkh -.- invoker
    ing -.- invoker
    denied["EXECUTE revoked from PUBLIC,<br/>so every call without a grant fails with 42501"]
    anon -.->|"match_knowledge_sections,<br/>match_knowledge_hybrid,<br/>ingest_document_atomic"| denied
    authn -.->|"ingest_document_atomic"| denied

    subgraph sg_checks["Size CHECK constraints added NOT VALID, a violation is SQLSTATE 23514"]
        ckNote["New and updated rows are checked<br/>for every role, existing rows<br/>are not scanned"]
        ckDocs["knowledge_documents<br/>title 500, source_type 64,<br/>source_name 500, summary 5000,<br/>raw_content 200000 chars,<br/>tags at most 50 and 16384 bytes,<br/>metadata 65536 bytes"]
        ckSec["knowledge_sections<br/>heading 1000,<br/>markdown_content 210000 chars"]
        ckEnt["knowledge_entities<br/>name 500, entity_type 64,<br/>description 5000 chars,<br/>properties 65536 bytes"]
        ckRel["knowledge_relations<br/>relation_type 64 chars,<br/>properties 65536 bytes"]
        ckChat["chat_history<br/>content 20000 chars"]
        ckNote --- ckDocs
        ckNote --- ckSec
        ckNote --- ckEnt
        ckNote --- ckRel
        ckNote --- ckChat
    end
    ckOld["Validated chat_history checks, inline in full_schema.sql<br/>and added by 20260923000000: role user, assistant or system,<br/>session_id 1 to 128 chars, content 100000 chars,<br/>sources and metadata 65536 bytes"]
    ckChat -.- ckOld
    invoker ~~~ sg_checks
```

Advisor note: *extension_in_public* (vector) is expected. The extension stays
in `public` because existing columns and indexes use `public.vector`.

The SQL only touches the Starpi objects above. Other objects in the same
database (`leads`, `bookings`, `conversion_events`, `prune_conversion_events`)
are left alone.

## Verification

Run in the SQL editor after applying.

```sql
-- RLS on, and exactly 19 policies with explicit roles (4 per knowledge
-- table, 3 on chat_history, none on brain_settings)
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

-- Size limits: 16 constraints named *_max_length / *_max_size (convalidated = false)
select conrelid::regclass as table_name, conname, convalidated, pg_get_constraintdef(oid) as definition
from pg_constraint
where connamespace = 'public'::regnamespace and contype = 'c'
  and (conname like '%\_max\_length' or conname like '%\_max\_size')
order by 1, 2;

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

Over HTTP with the anon key, `GET /rest/v1/chat_history` and
`GET /rest/v1/brain_settings` must fail with `42501` (HTTP 401), while
`GET /rest/v1/knowledge_documents` returns only public rows.
*Database > Advisors > Security* should show no Starpi findings apart from
*extension_in_public*.

## Tests

`tests/run_rls_tests.sh` builds a throwaway PostgreSQL cluster (Unix socket
only), loads a small Supabase stand-in (`tests/stub_supabase.sql`: roles,
`auth.users`, `auth.uid()`, Supabase's default grants) and checks:

- the live shape (`tests/fixtures/live_shape.sql`) and both earlier schema
  versions, upgraded by all migrations twice, then again with user data
  present (`tests/post_rerun_check.sql`);
- a fresh `full_schema.sql` (applied through `apply_migration.py`) plus the
  migrations, and `schema.sql` followed by `full_schema.sql`;
- `full_schema.sql` refusing a pre-hardening database, and `20260924000000`
  refusing a database without `20260923000000`;
- identical `pg_dump` output for upgraded and fresh installs;
- 184 RLS / privilege / RPC / size-limit assertions per scenario, 191 in the
  scenarios seeded with legacy rows (`tests/rls_test.sql`), run as `anon`, two
  different anonymous users and `service_role`: tenant isolation in both
  directions on every table, published rows staying read-only for their owner,
  oversized writes rejected, and legacy rows above the limits surviving the
  upgrade.

The runner applies every file in `migrations/` in file-name order, so a new
migration is picked up without changing the script.

<!-- diagram: migrations-tests-rls-harness -->
```mermaid
flowchart TD
    setup{"initdb, pg_ctl, postgres, psql, pg_dump, pg_config in PG_BIN,<br/>pgvector installed, at least one migrations/*.sql,<br/>PGTEST_DIR not existing yet, and as root: PGTEST_OS_USER<br/>exists and can write the work dir?"}
    setupErr(["exit 2: setup error"])
    cluster["Throwaway cluster: initdb --auth=trust, pg_ctl start<br/>Unix socket in the work dir only, listen_addresses empty, port 55432<br/>as root the server runs as PGTEST_OS_USER, default postgres"]
    setup -->|"no"| setupErr
    setup -->|"yes"| cluster
    clusterErr(["exit 2: initdb failed or could not start PostgreSQL"])
    cluster -->|"fails"| clusterErr
    scen["run_scenario NAME: create database starpi_NAME, run the steps in order<br/>every scenario starts with stub_supabase.sql: roles anon, authenticated, service_role,<br/>auth.users, auth.uid(), Supabase default grants, sentinel objects of the other app<br/>first failing step: FAIL, log tail printed, next scenario"]
    cluster --> scen

    subgraph sg_upgrade["Upgrade paths"]
        live["live: live_shape.sql + legacy_seed.sql,<br/>migrations twice, rls_test.sql legacy=true,<br/>migrations again, post_rerun_check.sql"]
        v2["legacy_v2: legacy_full_schema_v2.sql + legacy_seed.sql,<br/>migrations twice, rls_test.sql legacy=true"]
        v1["legacy_v1: legacy_schema_v1.sql + legacy_seed.sql,<br/>migrations twice, rls_test.sql legacy=true"]
    end
    subgraph sg_fresh["Fresh installs"]
        fresh["fresh: full_schema.sql through apply_migration.py<br/>psql when python3 is missing, then migrations, rls_test.sql"]
        rerunS["fresh_rerun: schema.sql, a psql include of full_schema.sql,<br/>then full_schema.sql again, rls_test.sql"]
    end
    subgraph sg_guard["Guards, expect-fail steps"]
        guard["guard: live_shape.sql,<br/>then full_schema.sql must fail"]
        guardOrder["guard_order: live_shape.sql,<br/>then 20260924000000_lock_published_rows.sql must fail"]
    end
    scen --> live
    scen --> v2
    scen --> v1
    scen --> fresh
    scen --> rerunS
    scen --> guard
    scen --> guardOrder

    aIdem["Second migrations run succeeds on the upgraded schema:<br/>idempotent on the live shape and both earlier schema versions"]
    aRls["rls_test.sql: 184 checks, 191 with legacy=true<br/>catalog, tenant isolation, published-row lock, size limits, RPCs"]
    aPost["post_rerun_check.sql, 13 checks: a further migrations run keeps<br/>ownership, visibility, chat rows, the published-row lock,<br/>size limits and brain_settings closed to A and anon"]
    aGuard["Step passes only when psql exits non-zero:<br/>pre-hardening database refused, order enforced"]
    aFreshRerun["full_schema.sql re-runs cleanly on a database it created"]
    live --> aIdem
    v2 --> aIdem
    v1 --> aIdem
    live --> aPost
    live --> aRls
    v2 --> aRls
    v1 --> aRls
    fresh --> aRls
    rerunS --> aRls
    rerunS --> aFreshRerun
    guard --> aGuard
    guardOrder --> aGuard

    parity{"pg_dump --schema-only --schema=public of starpi_live,<br/>starpi_fresh, starpi_fresh_rerun, restrict lines removed:<br/>diff -u live vs fresh and fresh vs fresh_rerun empty?"}
    live --> parity
    fresh --> parity
    rerunS --> parity
    parity -->|"yes"| parityOk["PASS schema parity"]
    parity -->|"no"| parityFail["FAIL schema parity, failures + 1"]

    result{"Any failed scenario or parity check?"}
    parityOk --> result
    parityFail --> result
    result -->|"yes"| exit1(["exit 1: N check group(s) failed"])
    result -->|"no"| exit0(["exit 0: all checks passed"])
    cleanup["trap cleanup on exit: pg_ctl stop -m fast,<br/>remove the work dir unless PGTEST_KEEP=1"]
    exit1 -.-> cleanup
    exit0 -.-> cleanup
    clusterErr -.-> cleanup
```

```bash
# Debian / Ubuntu: apt-get install postgresql-16 postgresql-16-pgvector
PG_BIN=/usr/lib/postgresql/16/bin backend/supabase/tests/run_rls_tests.sh
```

It exits non-zero on any failure. As root it runs the server as the
`postgres` OS user (`PGTEST_OS_USER`); `PGTEST_KEEP=1` keeps logs and data.

## Rollback

- A failed run changes nothing: every file runs in a single transaction.
- Before applying to the live project, keep a copy of the Starpi data:
  `pg_dump "$DATABASE_URL" --data-only --table='public.knowledge_*' --table=public.chat_history --table=public.brain_settings -f starpi_backup.sql`
  (Supabase also keeps daily backups / PITR depending on the plan).
- There is no automatic down migration. Undo the migrations in reverse order,
  and do not run `apply_migration.py --migrations` (or `supabase db push`)
  afterwards, since that applies them again. With the Supabase CLI, mark an
  undone migration with `supabase migration repair --status reverted <version>`.
- If the browser cannot read or write after an upgrade, check first that
  anonymous sign-ins are enabled and that the frontend signs in.

### Undo `20260924000000` (back to the state after `20260923000000`)

1. Re-run `migrations/20260923000000_harden_rls_anonymous_auth.sql` on its own.
   It drops every policy on the six Starpi tables and re-creates its own: owners
   can again update / delete their published rows and their sections, and
   `brain_settings` is readable by `anon` / `authenticated` again (policy
   `brain_settings_select_all` plus SELECT privileges). Data is not changed.
2. Drop the size limits, which `20260923000000` does not know about:

```sql
begin;
do $$
declare
    c record;
begin
    for c in
        select conrelid::regclass as table_name, conname
        from pg_constraint
        where connamespace = 'public'::regnamespace
          and contype = 'c'
          and conrelid in ('public.knowledge_documents'::regclass, 'public.knowledge_sections'::regclass,
                           'public.knowledge_entities'::regclass, 'public.knowledge_relations'::regclass,
                           'public.chat_history'::regclass)
          and (conname like '%\_max\_length' or conname like '%\_max\_size')
    loop
        execute format('alter table %s drop constraint %I', c.table_name, c.conname);
    end loop;
end
$$;
commit;
```

The result has the same schema as a database upgraded with `20260923000000`
only (the constraints of that migration, e.g. `chat_history_content_length`,
do not match the name pattern and stay).

### Undo `20260923000000` (back to the open policies; not recommended)

This makes chat history and all knowledge world readable and writable again
for anyone holding the anon key. Undo `20260924000000` first. Re-creating the
old policies alone is **not** enough: the migration also revoked the table and
function privileges the old policies relied on and made
`chat_history.owner_id` NOT NULL (its default `auth.uid()` is null without a
signed-in user, so anonymous chat inserts would fail). For the live project
shape (`tests/fixtures/live_shape.sql`):

```sql
begin;

-- Owner-based policies out, the open policies of the live project back in.
do $$
declare
    pol record;
begin
    for pol in
        select tablename, policyname from pg_policies
        where schemaname = 'public'
          and tablename in ('knowledge_documents', 'knowledge_sections', 'knowledge_entities',
                            'knowledge_relations', 'chat_history', 'brain_settings')
    loop
        execute format('drop policy %I on public.%I', pol.policyname, pol.tablename);
    end loop;
end
$$;
create policy "Allow public read documents" on public.knowledge_documents for select using (true);
create policy "Allow public insert documents" on public.knowledge_documents for insert with check (true);
create policy "Allow public update documents" on public.knowledge_documents for update using (true);
create policy "Allow public read sections" on public.knowledge_sections for select using (true);
create policy "Allow public insert sections" on public.knowledge_sections for insert with check (true);
create policy "Allow public all chat_history" on public.chat_history for all using (true);
create policy "Allow public read brain_settings" on public.brain_settings for select using (true);

-- Supabase's default privileges, which the migration revoked.
grant all on table
    public.knowledge_documents, public.knowledge_sections, public.chat_history, public.brain_settings
    to anon, authenticated, service_role;
grant execute on function
    public.match_knowledge_sections(public.vector, double precision, integer),
    public.ingest_document_atomic(text, text, text[], text, text, text, jsonb)
    to public;

-- chat_history: rows without a signed-in user and the old role 'tool'.
alter table public.chat_history alter column owner_id drop not null;
alter table public.chat_history drop constraint chat_history_role_check;
alter table public.chat_history
    add constraint chat_history_role_check check (role in ('user', 'assistant', 'system', 'tool'));

notify pgrst, 'reload schema';
commit;
```

What stays, and why that is fine for the old code:

- The RPCs keep their current `SECURITY INVOKER` bodies. Under the open
  policies they see and write every row, like the old `SECURITY DEFINER`
  versions (`live_shape.sql` sections 6 and 7) did; re-creating those is not
  needed.
- The columns `owner_id`, `is_public` and `fts`, the indexes, `search_knowledge`
  / `match_knowledge_hybrid` and the remaining `chat_history` CHECK constraints
  (`session_id` 1..128 characters, content 100000 characters, `sources` /
  `metadata` 64 KiB) stay; the old code does not use them. New knowledge rows
  still default to `is_public = false`, which the open policies ignore.
- `knowledge_entities` / `knowledge_relations` did not exist in the live
  project; after the block above they have RLS without policies, so only the
  service role reaches them. Installs from the earlier `full_schema.sql` also
  had open read / insert policies on them and a global
  `UNIQUE (name, entity_type)` (see `tests/fixtures/legacy_full_schema_v2.sql`);
  re-create those from there if needed.
- `chat_history` rows the migration deleted (rows without an owner) can only be
  restored from a backup.
