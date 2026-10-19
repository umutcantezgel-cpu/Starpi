# @starpi/companion: Starpi Core, the local companion

A small service that runs on your own machine, on the loopback interface only, and gives the
Starpi app in your browser a place to keep things that should not live in a browser tab: notes,
chats, documents and API keys sealed at rest, a tamper-evident record of what was done on your
behalf, and language models reached only through a list of hosts you wrote down yourself.

In the app it is shown as **Starpi Core (local companion)**. The command is `starpi-companion`.

- Node.js 22.13 or newer (it uses the built-in `node:sqlite`); tested on 22 and 24.
- One runtime dependency, `@anthropic-ai/sdk`, loaded only when an Anthropic model is configured.
- Linux and macOS. Packaging (offline tarball, systemd user unit, launchd agent) is shipped
  separately.

## Quick start

```sh
npx starpi-companion start          # first start creates the installation and listens on 127.0.0.1:47821
npx starpi-companion pair           # prints a one-time code (valid 10 minutes)
```

Open Starpi, go to Settings > Companion and enter the code. Or, with an app build for the
companion profile in `appDir`, open `http://127.0.0.1:47821/` directly.

## Folders

| Folder | Default on Linux | Holds |
| --- | --- | --- |
| configuration | `~/.config/starpi-companion` | `config.json`, the key file of the `file` key provider |
| data | `~/.local/share/starpi-companion` | `companion.db` (event log, audit chain, sealed vault items, sessions), `vault/` (keyring, sealed blobs) |
| anchors | `~/.local/state/starpi-companion/anchors` | signed audit anchors, the pinned public key, the deletion list |

On macOS all three live below `~/Library/Application Support/starpi-companion`. The data and
anchor folders must not overlap. Put the anchor folder on another disk or a share the companion
may write to but not rewrite when you can: it is what lets the companion notice that an older copy
of the data folder was put back.

Overrides: `--config`, `--data-dir`, `--anchor-dir`, or `STARPI_COMPANION_CONFIG`,
`STARPI_COMPANION_DATA_DIR`, `STARPI_COMPANION_ANCHOR_DIR`, `STARPI_COMPANION_PORT`.

## Configuration

Every member of `config.json` is optional; see `src/profiles/minimal/companion.example.json`.

```json
{
  "port": 47821,
  "allowedOrigins": ["https://www.starpi.app"],
  "timeZone": null,
  "vault": { "kek": { "provider": "file" } },
  "egress": { "allow": { "brains": ["api.anthropic.com:443"] } },
  "brains": [
    { "id": "local", "type": "openai-compat", "baseUrl": "http://127.0.0.1:11434/v1", "model": "llama3.2", "memoryMb": 4096 },
    { "id": "claude", "type": "anthropic", "secret": "anthropic" }
  ],
  "router": { "personalToCloud": true }
}
```

The whole file is checked before anything starts; every problem is reported at once.
`timeZone` defaults to the machine's zone as `Intl` reports it.

## Commands

| Command | What it does |
| --- | --- |
| `start [--port n] [--app-dir folder] [--accept-new-anchors]` | runs in the foreground until SIGINT/SIGTERM, with the egress guard installed |
| `status [--port n] [--json]` | the installation from its files, and whether a companion answers |
| `pair [--role owner\|member] [--label name]` | a one-time pairing code |
| `secret set <name>` / `secret list` / `secret remove <name>` | sealed secrets (API keys); the value is read from stdin, never from an argument |
| `token-revoke <session> \| --all \| --list` | ends paired sessions |
| `verify-audit [--json]` | recomputes the audit chain and event links and checks the anchors (exit 1 on findings) |
| `backup create --out <folder>` / `backup verify <folder>` / `backup restore <folder> [--accept-rollback]` | sealed backups |
| `export --out <file> --namespaces a,b` / `import <file>` | passphrase-sealed bundles of vault namespaces |
| `erase <namespace> --yes` / `erase --all --yes` | crypto-erase |
| `kek-init` | creates the key-encryption key with the configured provider |
| `egress-splice --socket <path>` | the program of the egress splice unit (see below) |

## Pairing the browser

- **Mode A, same origin.** The companion serves the app itself from `http://127.0.0.1:<port>`.
  Pairing returns an `HttpOnly; SameSite=Strict` cookie (its name carries the port) and a second
  random value the app sends as `X-Companion-CSRF` on every call. A cookie without that header, or
  from another origin, counts for nothing.
- **Mode B, the hosted app.** The app at an allowed origin (`https://www.starpi.app` by default,
  plus `allowedOrigins`) probes `GET /v1/hello` only when the user opens the companion settings,
  then posts the code to `POST /v1/session/pair`. It gets a 32-byte bearer token bound to that
  origin and the companion's public key. CORS answers name exactly that origin; preflights that
  ask for it get `Access-Control-Allow-Private-Network: true`.

The store keeps only hashes of codes, cookies, CSRF values and tokens. Five wrong codes in a row
void every open code. Roles: `owner` (may change configuration, secrets and sessions) and `member`
(may use the companion). Requests whose `Host` is not `127.0.0.1`, `localhost` or `[::1]` with
the companion's port get 421, so a rebound DNS name cannot reach it.

## HTTP API (kernel)

| Route | Access | Answer |
| --- | --- | --- |
| `GET /v1/hello` | public | `{ name, version, pairing: true }` |
| `POST /v1/session/pair` | public | `{ mode, session, role, expiresAt, publicKey, keyId, csrf \| token }` |
| `GET /v1/session`, `POST /v1/session/logout` | member | the current session / end it |
| `GET /v1/status` | member | version, profile, egress list, brains, breaker, scheduler, vault counts, audit head |
| `GET /v1/audit/head[?seq=n]` | member | the signed head now, or of record `n` |
| `GET /v1/audit/verify` | owner | the verification report |
| `GET /v1/sessions`, `DELETE /v1/sessions/:id` | owner | paired devices |
| `GET /v1/secrets`, `PUT/DELETE /v1/secrets/:name` | owner | secret names (never values) |
| `POST /v1/vault/erase` | owner | `{ namespace, confirm }` crypto-erases a namespace |
| `POST /v1/breaker/reset` | owner | `{ reason }` steps the breaker back to steady |

Errors are `{ error: { code, message } }` with a stable snake_case `code`; the app translates
codes, messages are for logs. Modules add routes below `/v1/<module id>/`.

## Audit chain, signed heads and rollback detection

Every decision taken on the user's behalf (a device paired, a secret set, a namespace erased, an
answer released by a module) is a record in an append-only chain; each record holds the SHA-256 of
the one before. **Every answer carries the signed head** of the chain:

- header `X-Companion-Audit-Head: <seq>.<hash>.<sig>` (exposed to CORS callers),
- member `auditHead: { seq, hash, sig }` in JSON bodies, and a final `audit` event on streams.

`sig` is an Ed25519 signature (base64url) by the companion's identity key over the UTF-8 bytes of

```json
{"hash":"<64 hex>","key":"<key id>","kind":"starpi.companion.audit-head","seq":<n>,"v":1}
```

(canonical JSON: sorted keys, no whitespace), where the key id is the SHA-256 (hex) of the raw
32-byte public key returned at pairing. A browser verifies it with WebCrypto (`Ed25519`). It keeps
the highest head it saw per companion: a lower `seq`, or a different hash at a `seq` it knows
(checked with `GET /v1/audit/head?seq=n`), means the companion's data were put back or forked.

Inside the companion, **anchors** pin the chain and the event log outside the data folder: signed,
numbered, linked files written at start, at stop, every `audit.anchorEvery` records and every
`audit.anchorIntervalS` seconds while records come in. At start the companion refuses to run
(`audit_rollback`) when the database no longer reaches the newest anchor, and also when the chain
or the event log does not recompute (`audit_tampered`), when an anchor does not verify
(`anchor_invalid`), when the anchor folder belongs to another identity (`anchor_key_mismatch`) or
is empty although the installation has a history (`anchor_dir_missing`; mount it, or start a new
line of anchors on purpose with `--accept-new-anchors`).

## Vault, keys and crypto-erase

Everything the companion keeps about its user is sealed with AES-256-GCM: every vault namespace
(notes, chats, documents, secrets, a module's own data), the identity key, and the bodies of
events whose data class is not `public`. Each namespace has its own data key; the keyring wraps
those keys with a **key-encryption key** (KEK) that never lies in the data folder:

| Provider | Where the KEK lives |
| --- | --- |
| `file` (default) | a 0600 file outside the data folder (`<config>/kek.key`) |
| `systemd-creds` | an encrypted systemd credential (host key, TPM2 where present), loaded by the user unit with `LoadCredentialEncrypted=starpi-companion-kek` |
| `keychain-macos` | a generic password item in the login keychain |

**Crypto-erase** destroys a namespace's key first, then its rows and blobs, and appends a line to
the deletion list (in the anchor folder) that names the key generation erased (for a namespace with
no key: the last one erased before, or 0), so what is stored in the namespace afterwards is never
taken for erased content. Any copy of its sealed values (WAL pages, old backups) can
no longer be opened. A namespace made again gets a new key generation, so old values never open
with the new key either.

**Backups** (`backup create`) hold a consistent copy of the database, the wrapped keyring and the
sealed blobs, plus a manifest of hashes signed by the identity key. They never contain the KEK.
`backup restore` checks everything before it writes; a backup older than the newest anchor is a
rollback and is restored only with `--accept-rollback`, which leaves a signed restore anchor. After
every restore the deletion list is applied again: nothing deleted after the backup comes back.

**Bundles** (`export`/`import`) move chosen namespaces between machines, sealed with a passphrase
(scrypt, AES-256-GCM); an import skips what was deleted on the target after the bundle was made.

## Egress: zero by default

With no `egress.allow` entries the companion reaches nothing but this machine. The guard runs in
the process and patches `net.Socket#connect` (the path of every TCP and TLS connection, `fetch`
included), DNS lookups and queries, and datagram sockets: only loopback and `localhost` pass, and
other host names are refused before any DNS query leaves. `localhost` is resolved through a lookup
whose every answer must be a loopback address; a `lookup` function passed by the caller (HTTP
libraries often pass one) still runs, and its answer is checked the same way, for TCP, TLS, HTTP
and datagram sockets.

A module that needs the internet gets a **capability** for the `host:443` entries the owner listed
for it under `egress.allow.<module id>` (at most 16; one module per host; public DNS names only).
The capability resolves exactly that host, connects only to public unicast addresses and runs TLS
with the normal certificate and host-name checks. The kernel's language models use the module id
`brains`.

**Spawning is forbidden in this release.** A child process, a replaced process image or a worker
thread would start outside the guard, so the `child_process` functions, `ChildProcess#spawn`,
`process.execve`, `cluster.fork`, `worker_threads.Worker` and `module.register` throw
`SPAWN_FORBIDDEN` once the guard is installed. The only programs the kernel itself runs are fixed
absolute paths with argument lists (`systemd-creds`, the macOS `security` tool for the KEK, and
`systemd-notify` for readiness); the guard lets exactly those through while the kernel's runner
starts them. Shell tools for models are not part of this release.

Limits of an in-process guard: references to the original functions and sockets made before it is
installed, Node's internal handle objects reached through a live socket, native add-ons and
WebAssembly with host imports. On Linux the user unit therefore adds a boundary
outside the process: `IPAddressDeny=any` for the companion, and a second, tiny unit running
`starpi-companion egress-splice` on a Unix socket only the companion may open. With
`STARPI_COMPANION_EGRESS_SOCKET` set, capabilities connect through that socket (`CONNECT host:443`);
the splice checks the host and its addresses again and only ever sees ciphertext.

## Language models and data classes

| Type | Notes |
| --- | --- |
| `none` | always present; a template answer, the last resort |
| `openai-compat` | any chat-completions server; on loopback it is a local model (Ollama, llama.cpp, LM Studio). `Authorization: Bearer` is sent only when `secret` names a vault secret |
| `cloud` | an OpenAI-compatible provider by preset: `openai`, `groq`, `mistral`, `deepseek`, `openrouter`, `xai`, `nvidia` |
| `anthropic` | the Messages API through the official SDK; `model` defaults to `claude-opus-5-5`; optional `effort` and `showReasoning` |
| `gemini` | the Gemini API, key in the `x-goog-api-key` header |

Every request carries a data class, and the router decides where it may go:

| Class | May reach |
| --- | --- |
| `public` | any configured model |
| `personal` | any configured model; cloud models only while `router.personalToCloud` is true (the default) |
| `sensitive` | local models only |
| `secret` | no model: the answer is a template |

There is **no silent switch**: the first allowed model fixes whether a request stays local or goes
to the cloud, a failing model is never replaced by one of the other kind, and server-side fallbacks
to other models are not requested. A model that fails after text went out leaves a template and a
`reset` signal; a refusal is passed on as a refusal. A model that failed three times in a row rests
for a minute; while no model of the request's kind may run (resting, or held by the breaker), the
answer is a template with the notice `brain_unavailable` or `breaker`, never a model of the other
kind.

## Runtime

- **Store**: one `node:sqlite` database in WAL mode with `synchronous=FULL`: an append-only event
  log (each row linked by a running SHA-256), projections rebuilt when their version changes, and
  the kernel's tables.
- **Scheduler**: lanes `interactive` (reserved slots), `events` and `background` (yields whenever
  someone waits).
- **Breaker**: `steady`, `slowed`, `paused`, `isolated` (no cloud calls), `halted` (status only);
  raised by the error rate and the resident memory, lowered only by the owner with a reason.
- **Admission**: memory budget for local model slots; a loaded model is shared.
- **Readiness**: under a systemd unit with `Type=notify` it reports `READY=1` and pings the
  watchdog while healthy.

## Profiles

`minimal` (the default) declares the neutral feed contract and keeps the latest public reading per
source and series:

```text
feed.sample  { source_id, series, value, unit, ts_source, quality: good | uncertain | bad }
feed.health  { source_id, state: up | stale | down, checked_at, detail? }
```

It includes a demo room sensor (`demoReadings`) for trying the companion without hardware.

## Modules

Features plug in as modules passed to `startCompanion({ modules })`:

```js
{
  id: 'notes', version: '1.0.0',
  egress: ['api.example.com:443'],      // granted only when the owner lists it too
  namespaces: ['notes'],                // the only vault namespaces it may open
  eventTypes: [], projections: [],
  routes: [{ method: 'GET', path: '/items/:id', access: 'member', handler }],   // served below /v1/notes/
  start(ctx) {}, stop() {},
}
```

`ctx` holds the kernel narrowed to what the module declared: `events`, `vault.namespace(ns)`,
`audit.append` (kinds starting with the module id), `brains` (the router), `scheduler`, `egress`
(its capability or null), `clock`, `timeZone`, `log`, `config` (`modules.<id>` of the
configuration) and the companion's public `identity`.

A route may also name `maxBody` (bytes, at most 64 MiB), `lane` (for the breaker) and `raw`: a
list of media types whose bodies it takes as bytes (a file upload, a recorded form) instead of
JSON. A handler answers with `{ body }` (JSON), `{ stream }` (server-sent events) or
`{ raw: { type, data, filename? } }` (bytes; with a file name as an attachment).

## Standard modules

`starpi-companion start` runs these modules (`standardModules()` for embedding). Each is
configured under `modules.<id>` of `config.json`; a module with nothing configured stays quiet.
Text people write (notes, documents, conversations, reminders, the inbox) is sealed in its own
vault namespace; the audit chain records ids, classes and counts, never the text.

| Module | Routes (below `/v1`) | What it does |
| --- | --- | --- |
| `retrieval` | `POST /retrieval/search`, `GET /retrieval/status` | the search index over notes and documents: BM25, plus vectors from an embedding server on this machine (`embeddings: { baseUrl: "http://127.0.0.1:11434/v1", model }`), fused with reciprocal rank fusion (chunking, BM25 and fusion of `@starpi/core`) |
| `memory` | `GET/POST /memory/notes`, `GET/PUT/DELETE /memory/notes/:id`, `POST /memory/recall` | notes added on purpose; recall ranks by match, use, spread over days and freshness (halving every `halfLifeDays`, 30); a pinned note does not fade |
| `docs` | `POST /docs?name=&class=` (raw file), `GET /docs`, `GET /docs/:id`, `GET /docs/:id/passages/:n`, `GET /docs/:id/file`, `PUT /docs/:id/class`, `DELETE /docs/:id` | PDF text layer (needs the optional peer `pdfjs-dist`), Word, Excel, PowerPoint, HTML, Markdown, CSV, JSON and text, read by `@starpi/core` in the background lane; original and text are sealed blobs |
| `ask` | `POST /ask` | one question, one JSON answer |
| `chat` | `POST /chat` (server-sent events), `GET /chat/conversations`, `GET/PUT/DELETE /chat/conversations/:id` | conversations with history; a conversation's data class only rises; turns of one conversation run one after the other (a turn sent while another runs waits for it, more than `waitingTurns` (4) waiting get 409 `conversation_busy`) |
| `mcp` | `POST /mcp`, `GET/POST /mcp/clients`, `DELETE /mcp/clients/:id` | an MCP server (2025-06-18) with the read-only tools `search_documents`, `read_excerpt`, `recall_notes`, `list_agenda`; MCP client tokens only (no cookie, no browser session, no Origin) |
| `connectors` | `GET /connectors`, `POST /connectors/:server/{refresh,approve,revoke}`, `GET /connectors/approvals`, `POST /connectors/approvals/:id` | tools of MCP servers on this machine for the chat: each tool description is pinned by SHA-256 and offered only with the pin the owner approved; a changed description needs a new approval; the list is read again before every call, and a call runs only when that fresh list carries the approved pin |
| `agenda` | `GET/POST /agenda`, `GET /agenda/upcoming`, `GET/PUT/DELETE /agenda/:id` | reminders (once, daily, weekly, monthly) in the item's, the module's or the companion's time zone, computed with `Intl` |
| `notify` | `GET /notify`, `GET /notify/stream`, `POST /notify/:id/read`, `POST /notify/read-all`, `DELETE /notify/:id` | the inbox; the app reads it over server-sent events while it is open (no push service); numbers only rise and are never handed out twice, so an app catching up with `?after=` misses nothing |
| `voice` | `GET /voice/v1/audio/voices`, `POST /voice/v1/audio/speech`, `POST /voice/v1/audio/transcriptions` | relays speech to the voice server on this machine (`url: "http://127.0.0.1:8000"`) |
| `feeds` | `GET /feeds`, `GET /feeds/latest`, `POST /feeds/import?source=` (CSV) | experimental and read-only: CSV imports and MQTT subscriptions to a broker on this machine (3.1.1 or 5; the client never publishes) as `feed.sample` / `feed.health` events; a subscription that hears nothing for `staleAfterS` after its last message or its (re)connection is `stale` |
| `setup` | `GET /setup`, `GET /setup/models` | first-start checks of the local model, embedding and voice servers, and model sizes the machine's memory holds |

**Answers through the gate.** `/v1/ask` and `/v1/chat` take `mode: "sources"` (default) or
`"free"`. In source mode the model gets the matching passages of documents, notes and the latest
feed readings as labelled sources (`[S1]`, `[S2]`, ...), and every answer runs through the sentence
gate of `@starpi/core`: a sentence whose number is not in the source it cites is withheld, so a feed
reading can be cited exactly as the feed reported it. A reading's source also gives its time in the
companion's time zone (24-hour time and the dates `2026-10-18` and `18.10.2026`), so a sentence may
name when it was measured in those forms; a bare day or year is not citable. Free mode keeps the gate's character and link
rules. Released units stream as `unit` events; the answer lists what was withheld and why, and the
sources each sentence cites. A turn's data class is the strictest of the request, the conversation
and its sources, and decides where the router may send it; secret content never reaches a prompt.

**Tools in the chat.** With `tools: true` the chat offers the approved connector tools. A model
calls one by replying `CALL {"tool": "<server>.<tool>", "arguments": {...}}`; the call is never
shown, its result becomes the source `[T1]`, and the model is asked again (at most four calls). A
tool approved with `calls: "ask"` waits for a person at every call; a call written after a tool
result always waits.

**Desktop MCP clients.** Create a client token as the owner (`POST /v1/mcp/clients`), save it in a
file only you can read (`chmod 600`) and let the client start the bridge:

```json
{ "mcpServers": { "starpi": { "command": "starpi-companion-mcp", "args": ["--token-file", "<absolute path>/mcp.token"] } } }
```

The bridge (`bin/mcp-stdio.mjs`) connects to `127.0.0.1` only; `--port` or `STARPI_COMPANION_PORT`
names the companion's port.

**Development.** The companion imports the built `@starpi/core`; run `npm run test:companion`
(and `npm run typecheck:companion`) from the repository root, which builds the core first.

## License

MIT, see `LICENSE`. Attributions of ideas from other open-source projects: `NOTICE` and `LICENSES/`.
