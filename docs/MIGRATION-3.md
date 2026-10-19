# Migrating to Starpi 3.0

Starpi 3.0 rebuilds the app around a provider-neutral AI layer, keeps chats and files on the device
in IndexedDB, signs receipts on the device and checks relations between statements. Most of the
move happens on its own the first time a browser opens 3.0. This guide lists what changes for
**users**, for **operators** who deploy their own copy, for **forks and embedding apps**, and for
code that uses **`@starpi/core`**. The [changelog](../CHANGELOG.md#300---2026-10-19) lists
everything that was added.

## At a glance

| Area | 2.x | 3.0 |
| --- | --- | --- |
| Model choice | `starpi_compute_mode`: `council`, `client`, `local`, `nvidia` | one picker value in `starpi_assistant_v1`: `auto`, `device`, `<provider>:<model>`, `local:*`, `companion:starpi-core` |
| Chats | `localStorage` (`starpi_local_chats_v1`), plaintext sync to `chat_history` | a message tree in IndexedDB (`starpi` database), sync only end-to-end encrypted (`chat_sync`), off until turned on |
| Chat export | `starpi.chat/v1` | `starpi.chat/v2` (the importer still reads v1) |
| Provider keys | session storage, or plaintext in `localStorage` with "remember keys" | session storage, or the passphrase vault (AES-GCM in IndexedDB) |
| Receipts | `starpi.receipt/v2` | `starpi.receipt/v3`, signed by a key of the device |
| Source check | rules version 2 | rules version 3 (relations), two new reason codes |
| Text extraction | `starpi-extract` 1 | `starpi-extract` 2 (Word, Excel, PowerPoint, HTML) |
| Workspace | memory of the tab | kept on the device (IndexedDB and OPFS) unless "memory only" |
| Response headers | written by hand in `vercel.json` | generated from `scripts/headers.json`, cross-origin isolated (COOP + COEP) |
| Python backend | `backend/server.py` with `/api/brain/*` and an NVIDIA mirror | removed; `tools/library-publisher` only |
| Interface languages | English, German | English, German, French, Spanish, Italian, Turkish |

## For users

Nothing needs to be done. On the first start of 3.0 in a browser profile:

- **Chats.** Every chat 2.x kept in `localStorage` becomes a conversation in the sidebar, with its
  messages as one thread. A turn that stayed on the device in 2.x (on-device answers, questions
  about your files) keeps that mark, so it is never sent to a cloud model as history later. The
  chat that was open stays open. The move runs once per browser profile; a reload does not repeat
  it.
- **Keys.** Keys that 2.x remembered in plaintext move into the session storage of the tab and are
  removed from `localStorage`, together with the "remember keys" switch. **Settings › Model
  providers and keys** then suggests setting a vault passphrase: with one, keys are kept on the
  device encrypted (PBKDF2-SHA-256 with 600,000 iterations, AES-GCM) and the vault locks after 30
  minutes without activity. Without one, keys last until the tab closes.
- **Settings.** The 2.x mode becomes a picker value: the cloud assistant becomes **Auto**, on-device
  stays on the device, your own server becomes `local:*` (the first model it lists), an NVIDIA model
  becomes that model of the site's NVIDIA pool. The chat mode (free or verified source mode), the
  language and your server's address stay.
- **Sync.** 3.0 never reads or writes the plaintext `chat_history` table of 2.x. Conversations sync
  only when you turn on **Settings › Chat sync** with a passphrase; rows are encrypted in the
  browser. Deleting a chat still removes the rows an earlier version stored in the old table.
- **Files.** Workspace files now stay on the device after a reload. The first file asks whether to
  keep files or hold them in memory only; **Settings › Files on this device** shows the storage used
  and offers "Forget all".
- **Receipts.** Downloaded receipts are signed with a key of this device (Ed25519, or ECDSA P-256),
  whose public key **Settings › Trust** exports. A verifier of 2.x refuses a v3 receipt: use the
  3.0 app or `starpi-verify-receipt` of `@starpi/core` 3.0. Receipts of 1.x and 2.x still verify.

## For operators

### Headers are generated, and the site is cross-origin isolated

- `vercel.json`'s `headers` section is **generated** from `scripts/headers.json`. Edit that file
  and run `npm run headers:gen`; `npm run headers:check` (part of `npm run verify` and CI) fails when
  `vercel.json` differs. `scripts/serve.mjs`, the build and the end-to-end tests read the same file.
- Every profile sends `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` (the WebAssembly runtimes get `SharedArrayBuffer`),
  plus `Cross-Origin-Resource-Policy: same-origin` and `Origin-Agent-Cluster`. **A self-hosted copy
  that embeds cross-origin images, scripts, fonts or frames without a
  `Cross-Origin-Resource-Policy` (or CORS) header breaks**: the browser refuses them. Serve such
  files from your own origin or give them the header.
- Build profiles: `public` (the hosted site, the only one that names the Gemini Live socket),
  `self-host` (serving `dist/` from your own host), `test` (local fakes) and `companion` (the build
  the local companion serves). Pick one with `STARPI_HEADER_PROFILE` at build time.

### The Python service is gone

- `backend/server.py` with its `/api/brain/*` routes (the app never called them), its copy of the
  NVIDIA routes with the mirrored model list (`backend/core/nvidia_catalog.json`) and the EC2 scripts
  (`backend/aws/deploy_ec2.sh`, `backend/remote_sync.sh`) are removed. Serve the app and its
  functions with `node scripts/serve.mjs --functions` (`npm run preview`) behind a TLS reverse proxy
  instead, or deploy to Vercel. [backend/README.md](../backend/README.md#what-changed-in-30) has the
  details.
- `npm run nvidia:sync` is replaced by `npm run models:sync`, which writes the model snapshot of
  every provider (`src/js/ai/catalog/snapshot.json`), the NVIDIA section included.
  `npm run nvidia:ping` stays; `npm run providers:ping` checks every provider and pool.
- Ingestion is the **library publisher** (`tools/library-publisher`): it writes documents, sections
  and 384-dimensional multilingual-e5-small vectors with the service role key. The vectors need the
  optional migration `20261101000000_embedding_384.sql`; without it the app ranks the library by
  full-text search as before.

### New server functions and variables

The functions under `api/` are stateless and store nothing: the BYOK relay
(`/api/relay/<provider>/<path>`), the site's key pools (`/api/pool`, NVIDIA, Groq, Gemini and
OpenRouter), the speech routes (`/api/voice/*`), research steps (`/api/research/step`) and
`/api/health`. `POST /api/chat/nvidia` and `GET /api/models/nvidia` keep working for clients of 2.x.
[docs/SERVER.md](SERVER.md) lists every route, guard and variable. Renamed variables (the old names
are still read):

| 2.x | 3.0 |
| --- | --- |
| `NVIDIA_ALLOWED_ORIGINS` | `STARPI_ALLOWED_ORIGINS` (one list for every function) |
| `NVIDIA_RATE_LIMIT_PER_MINUTE` | `STARPI_POOL_RPM_PER_IP` |

`STARPI_ACCESS_CODE` makes the relay, the pools, the speech routes and research steps require a
code; `STARPI_POOL_PROVIDERS` chooses the pools the site offers.

### Database

- The plaintext `chat_history` table is no longer written or read. Encrypted sync needs the
  optional migration `20261102000000_chat_sync.sql` (tables `chat_sync` and `chat_sync_keys`,
  owner-only row level security). Restoring conversations in a second browser needs Email sign-in
  with a one-time code: put `{{ .Token }}` into the Magic Link and Change Email templates
  ([backend/supabase/README.md](../backend/supabase/README.md)).
- `chat_sync` has no per-user row quota in 3.0; one row is capped at 2.8 million characters of
  ciphertext by a check constraint. Watch the table size on a public project.

### Verify and CI

`npm run verify` is now lint, typecheck, unit tests, build, `verify:dist`, `headers:check`,
`license:check` and `eol:check`. CI adds the companion jobs (Node 22 and 24, a systemd user unit
smoke test, the voice server), a weekly model-lock check (`model-lock.yml`), CodeQL and a workflow
lint (actionlint and zizmor). The release workflow publishes both packages to npm with provenance
and signs the assets ([CONTRIBUTING.md](../CONTRIBUTING.md#releases)).

## For forks and embedding apps

- **Model choice.** `COMPUTE_MODES` and the `council` mode are replaced by provider and model
  selection on the AI layer (`src/js/ai/*`). `getMode()` still answers with a 2.x compute mode
  derived from the picker value, for modules that only ask where an answer is computed; the value
  itself lives in `starpi_assistant_v1` (`state.js` `getAssistant`/`setAssistant`). The council is a
  chat action now ("Ask the council"), not a mode.
- **Chats.** `chat-store.js` keeps the 2.x names (sessions and flat messages) as a layer over the
  conversation store (`chat/store.js`, stores `conversations` and `nodes`). The data stays apart per
  product: `configureStore()` takes the database name of the build profile.
- **Mount points.** `index.html` holds empty elements with `data-mount`; a feature registers what it
  renders with `registerFeature()` (`src/js/features/registry.js`) instead of editing the markup or
  `main.js`. The chat offers seams for features (`chat/hooks.js`: route decider, request notes,
  retrieval sources, receipt hooks, message actions, answer labels).
- **Locale namespaces.** Dictionaries are a root file per language plus namespace files
  (`src/locales/<namespace>/<lang>.json`) whose keys read `<namespace>.<key>`. English ships with the
  first script; the other languages load when chosen. The tests require every key in all six
  languages.
- **Dark mode.** The theme is the `dark` class on `<html>` plus colour tokens in `app.css`;
  `theme-boot.js` applies the stored choice before the first paint. Styles of your own should use
  the tokens, not fixed colours.
- **Formats.** The workspace and `starpi-ground` also read `.docx`, `.xlsx`, `.pptx` and `.html`
  (`EXTRACTOR` version 2). The text of text, Markdown, CSV, JSON and PDF files is byte for byte that
  of version 1, so their receipts still verify.

## For `@starpi/core`

The package keeps its API and adds to it; these changes can break code that relied on 2.x:

- **`GROUNDING.version` is 3.** `groundAnswer` checks relations between values and events (within a
  statement and with the statement before it) by default. `groundAnswer(blocks, sources, { version:
  2 })` runs the 2.x rules unchanged, and receipts recompute with the version they record.
- **New reason codes** `relation_inverted` and `relation_unsupported` (both weak) in reports,
  receipts and SARIF. `REASON_CODES` lists them; `REASON_CODES_V2` and `reasonCodes(version)` give
  the codes of an older version. Code that switches exhaustively over reason codes must handle them.
  The advisory second opinion adds `second_opinion_contradiction` (`SECOND_OPINION_REASON`) next to
  a weak statement's reasons; it never changes a verdict.
- **Receipts default to `starpi.receipt/v3`**: optional `signer`, `gate`, `secondOpinion`,
  `relations` and per-file OCR members ([docs/spec/receipts.md](spec/receipts.md)). A 2.x verifier
  refuses v3; `buildReceipt(draft, { schema: RECEIPT_SCHEMA_V2 })` still writes v2.
  `starpi-verify-receipt --require-signature` fails a receipt without a valid signature.
- **`EXTRACTOR.version` is 2** (Word, Excel, PowerPoint, HTML; `EXTRACTOR_COMPATIBLE` names the
  kinds whose text did not change).
- **Language packs.** Stop words, number words and negation cues come from language packs
  (`LANGUAGES`, `languagePack`, `registerLanguage`); English and German are built in,
  `loadShippedLanguages()` adds French, Spanish, Italian and Turkish. `STOPWORDS` stays exported.
- **Added:** the sentence gate (`createSentenceGate`, `checkText`, `isReleased`, `canonicalText`,
  `spokenText`, `createSentenceReleaser`) with the `starpi-gate` command, relations and second
  opinions, hybrid retrieval (`fuseRrf`, `hybridSearch`, `probeIndex`, `VectorIndex`), and the
  Office, HTML and ZIP readers. The [package README](../packages/core/README.md) has examples.
