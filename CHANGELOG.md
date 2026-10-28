# Changelog

All notable changes to Starpi. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Demo recordings in the README (`docs/assets/video/`, MP4 with an animated WebP preview): the live
  demo from sample files to a verified receipt, the sentence gate on a stream, and
  `starpi-verify-receipt` on a signed and on an edited receipt; the `@starpi/core` README shows the
  two terminal clips and gains an example that gates an OpenAI Responses API stream.

### Fixed

- Settings → Memory no longer drops a note being typed or undoes a switch when the notes redraw.
- A question is being answered from the moment it leaves the composer, also while Auto decides its
  route: Stop shows, and a second question waits instead of starting a turn beside it.
- The source check parses numbers, excerpt headers, citation labels and sentence ends in linear time;
  long crafted text no longer makes it backtrack (CodeQL polynomial-redos). Results are unchanged.
- Settings › Trust and the receipt spec show the command-line check with `-p pdfjs-dist@6`, so a
  receipt that cites a PDF verifies; without it the PDF excerpt was reported as not reproduced.
- The CI examples in the `@starpi/core` README pin `@starpi/core@3` (they said `@2` or nothing), and
  the README's test counts are current (2,466 unit tests, 149 companion tests in 25 files).

## [3.0.0] - 2026-10-19

Starpi 3.0 is a new generation of the app: one AI layer for every provider, a chat with branches,
tools, voice and research, chats and files kept on the device, receipts signed on the device, a
source check that also compares relations, six interface languages, and a local companion that runs
on your own machine. What to change when you come from 2.x is in
[docs/MIGRATION-3.md](docs/MIGRATION-3.md).

### Breaking changes

- **Model choice replaces the compute modes.** `COMPUTE_MODES` (`council`, `client`, `local`,
  `nvidia`) give way to one picker value (`starpi_assistant_v1`): `auto`, `device`,
  `<provider>:<model>`, `local:*` or `companion:starpi-core`. A stored 2.x mode becomes a picker
  value once; the council is a chat action now, not a mode.
- **Chats live in IndexedDB.** Conversations are message trees in the app database; the 2.x chats
  in `localStorage` move there on the first start. The export format is `starpi.chat/v2`; the
  importer still reads `starpi.chat/v1`.
- **Receipts and the source check move to version 3.** Receipts are written as
  `starpi.receipt/v3` (verifiers of 2.x refuse them), the source check runs rules version 3, text
  extraction is `starpi-extract` 2, and `REASON_CODES` gains `relation_inverted` and
  `relation_unsupported`; code that switches exhaustively over reason codes must handle them.
- **Headers are generated, and the site is cross-origin isolated.** `vercel.json`'s headers come
  from `scripts/headers.json` (`npm run headers:gen`), and every response carries
  `Cross-Origin-Embedder-Policy: require-corp` with `Cross-Origin-Opener-Policy: same-origin`. A
  self-hosted copy that embeds cross-origin resources without CORP or CORS breaks.
- **The Python service is removed**: `backend/server.py` with `/api/brain/*`, its NVIDIA mirror
  and the EC2 scripts. `npm run nvidia:sync` is replaced by `npm run models:sync`.
- **Plaintext key storage and plaintext chat sync are removed.** Remembered keys move into the tab
  once (the passphrase vault keeps them across sessions); the `chat_history` table is no longer
  read or written, and conversations sync only end-to-end encrypted.
- **The workspace persists by default** (IndexedDB and the origin private file system), unless
  the user chooses "memory only".

### Added

#### AI layer and providers

- **One AI layer for every provider** (`src/js/ai/`): a provider contract with normalized stream
  events, a stream driver for wire and SDK adapters, and adapters for Anthropic (the official SDK,
  loaded on demand, with adaptive thinking, prompt caching, web search and append-only replay),
  OpenAI (Responses API, stateless with encrypted reasoning), Gemini (thinking levels and budgets,
  Google Search grounding), OpenAI-compatible providers with per-provider quirks (xAI, Groq, Mistral,
  DeepSeek, MiniMax, OpenRouter, NVIDIA, your own server) and the on-device engines.
- **MiniMax M3.1 Flash as the cloud base model** (released by MiniMax on 2026-10-19; facts as of
  2026-10-20): the `minimax` provider on its OpenAI-compatible API (`https://api.minimax.io`, models
  `MiniMax-M3.1-Flash` and `MiniMax-M3`, 1M-token context) and `minimax/minimax-m3.1-flash` at
  OpenRouter. Whenever it is set up (a MiniMax key of the user's, or the site's MiniMax pool on
  `MINIMAX_API_KEYS`), Auto, the purpose router and the privacy notice reach it first, on every
  kind of device; without it the order and the on-device defaults stay as they were. Its
  thinking cannot be switched off: it streams as `reasoning_content` into the answer's details,
  never into the answer text, and "thinking off" asks for `reasoning_effort: "low"`, never `none`.
  BYOK with the auto transport (relay allowlist: chat completions only), the key test as one small
  chat request (no model list and no key format are relied on, so there is no gitleaks rule), a fake
  flavor for the end-to-end suite and `npm run providers:ping -- --provider minimax`.
- **Self-hosted MiniMax M3 on your own server**: model names containing `minimax-m3` get their
  published 1M-token window unless the server reports its own (Ollama, llama.cpp, and now vLLM's
  `max_model_len`), their thinking is read from `reasoning_content` or `<think>` tags, they are
  never sent `reasoning_effort: "none"`, and the model picker marks them as needing a workstation or
  server (about 160 GB of memory for a 3-bit build). There is no WebGPU or WebAssembly preset; the
  M3.1 Flash weights are announced but not yet released.
- **Model catalog** (`src/js/ai/catalog/`): curated defaults per provider in `snapshot.json`
  (written by `npm run models:sync`), live model lists merged on top, capability guesses marked
  unverified, roles (fast, reasoning, vision, judge) and four strengths (max, super, auto, fast).
- **Purpose router and model wheel**: titles, OCR, graph extraction, council verdicts and other
  small jobs run along a fallback chain (the selected model, its role, the next provider, the
  device, a cached answer, a deterministic template); the wheel cools a model down after a 429,
  opens a circuit after repeated failures and marks models that are gone. Nothing switches
  silently: every call is recorded.
- **Transports**: direct with the user's key, a **stateless BYOK relay** for providers that block
  browsers (tried on its own after a blocked call and remembered per provider), the **site's key
  pools** (the MiniMax base model, and NVIDIA, Groq, Gemini and OpenRouter free models, no key in
  the browser) and devices on the user's network (always direct).
- **Key vault**: keys last for the tab by default; a passphrase keeps them in IndexedDB as AES-GCM
  ciphertext (PBKDF2-SHA-256, 600,000 iterations), locked after 30 minutes without activity.
  **Settings › Model providers and keys** tests a key with the provider's model list and shows
  error codes only, never provider text.
- **Extended thinking** (one switch) and **web search** per answer, with each provider's own
  lever; the model picker groups the models by device, companion, free pools, providers with a key
  and your own server, with status dots from `GET /api/health`.

#### Chat

- **A new chat thread**: an append-only message tree with branches (edit a question, regenerate
  with another model, the ‹ 2/3 › navigator), Continue after the length limit, streaming with
  reasoning shown in a collapsible block, usage and latency per answer.
- **Auto · Free · Grounded**: Auto routes each question without an extra model call (attachments,
  phrases that point at your sources, a keyword probe of the workspace; mixed answers mark which
  parts the sources hold). Every answer carries a provenance label (free, grounded, mixed, web,
  companion).
- **Context packs** for small and local models: a few short passages sized by the model's window,
  a stable prefix for the KV cache, short `[S#]`/`[F#]` labels expanded before the source check.
- **Attachments**: images (scaled on the device), PDFs (sent as they are to models that read them,
  else as text), Office documents, text and code, within a budget that follows the model's context.
- **Tools in free chat**: date and time, a calculator, workspace search, memory lookup and web
  search, each with a side-effect class; an **MCP client** (Streamable HTTP) with tool definitions
  pinned by SHA-256 and an approval card before a server's tool runs ("Always allow" only for
  read and low tools, and only while the pin stays the same); web search through
  Brave, Tavily or a self-hosted SearXNG for models without a search of their own, with a web check
  of the answer; **image generation** through the Images API.
- **Canvas** (a document view with versions and AI edits), **Compare** (one question to two to four
  models side by side) and **the council** (up to three drafts and a judge) in the conversation;
  their answers are adopted as branches of the question.
- **Rendering**: syntax highlighting (highlight.js) and math (KaTeX as MathML) loaded on demand,
  diagrams and HTML/SVG previews only in a sandboxed render frame, and code-block tools (copy,
  download, open in canvas, preview).
- **Conversations** in the sidebar: search, groups (pinned, today, previous 7 days, older),
  archive, rename, pin, move to project, export as Markdown or JSON, import, delete.
- **Memory, projects and assistants**: memory is off until switched on and stores only what the
  user keeps on purpose ("Remember this", a note in Settings, an accepted suggestion); notes are
  sealed with the vault key when a passphrase is set and go along with a question only (at most 8
  notes, 800 characters), never into the stored question. Projects keep chats together with their
  own instructions, model, files and memory scope; assistants are presets (instructions, model,
  tools, starters) with `starpi.assistant/v1` import and export. Custom instructions "About me" and
  "How to answer".
- **Device-only questions**: a question answered on this device (the device model, files of the
  workspace) stays there: never sent to a cloud model as history, never synced, and asked without
  web search or cloud tools.

#### Voice and Live

- **Dictation** with a chain of speech input sources (the browser, Gemini, OpenAI, Groq, a local
  voice server, the companion), each handing over to the next on failure, and a glossary of the
  user's own terms.
- **Read aloud** speaks only what a sentence gate released: a free answer through the free gate
  with the notice "not checked", a grounded answer through the source gate (a sentence with a
  number is spoken only when its cited excerpt holds that number), then how many sentences were
  withheld. Voices: the browser's, prebuilt Gemini voices, ElevenLabs premade voices, OpenAI voices
  and Piper voices of a local voice server; nothing can clone or upload a voice.
- **Live**: a full-screen voice conversation. Free mode streams to Gemini Live with a single-use
  ephemeral token from the site (the browser never holds a key); source mode runs as push-to-talk
  turns whose answers pass the source gate. An optional camera picture, taken only on a press.
- Speech routes with the site's keys (`/api/voice/speak`, `/transcribe`, `/voices`,
  `/live-token`) with per-IP limits and daily budgets.

#### Research

- **Research jobs**: a question becomes a plan of up to four search queries, a tool loop over your
  documents with three read-only tools and, if asked, up to four web search rounds; the documents
  part passes the sentence gate, the web part is judged as a whole, and the report (summary,
  details, sources, open questions) is stored with a receipt. Jobs survive a reload, run in one tab at a time (Web Locks, a heartbeat,
  stale jobs offer a retry of what is missing) and start from "Research this" on an answer.
- Without a key of the user's, research runs on the site's Gemini pool through
  `POST /api/research/step`, whose tool turns are HMAC-signed so a browser cannot forge what the
  model said. Optional stripping of e-mail addresses, phone numbers, IBANs, card numbers and IP
  addresses from web queries.

#### Source check, sentence gate and receipts

- **Source check version 3**: relations between values and events, within a statement and with the
  statement before it (changes, comparisons, order in time, carried-over values, shares). On two
  relation sets written for 3.0 it finds 32 of 32 and 23 of 24 planted relation errors, with no
  faithful statement marked weak or unsupported ([results](docs/eval/v3-relations.md)).
- **Second opinion** on request for a weak statement, from an entailment model on this device or
  from the AI judge: advisory, recorded in the receipt, never upgrading a verdict.
- **Sentence gate** (`src/js/core/gate.js`, the `starpi-gate` command): releases a streamed answer
  unit by unit, in sources, web or free mode, judging the canonical text that is shown and spoken
  (character allowlist, no links, every number backed by a cited excerpt, identifiers verbatim,
  joined digits refused). Read-aloud, Live, research reports and the companion speak or show only
  released units.
- **Receipt signing on the device**: Ed25519 (or ECDSA P-256) with a non-extractable key in
  IndexedDB, "Sign exported receipts" on by default, public key export as JWK or PEM, rotation;
  **receipts v3** add the signer, the gate's counts, second opinions, relations and OCR origins.
  `starpi-verify-receipt --require-signature`.
- **Languages**: the checks read English, German, French, Spanish, Italian and Turkish from
  language packs (French, Spanish, Italian and Turkish load after the first paint).

#### Workspace and files

- **Persistent workspace**: documents, chunks, vectors and the original bytes stay on the device
  (IndexedDB and OPFS) and the index is rebuilt at start; **Settings › Files on this device** shows
  the storage and offers "Forget all".
- **Semantic search on this device** (opt-in): multilingual-e5-small or MiniLM embeddings in a
  worker, int8 vectors, hybrid retrieval with reciprocal rank fusion; the shared library is ranked
  by a query vector, without sending the question.
- **Word, Excel, PowerPoint and HTML** files (`starpi-extract` 2), read without dependencies by a ZIP
  reader with bomb limits and a small XML reader; images are read with OCR only after consent, by a
  model that sees. `starpi-ground` reads the same formats.
- **Model download integrity**: every on-device model file is hashed in a worker and compared with
  `model-lock.json` (`npm run models:lock`, checked weekly in CI); a mismatch is deleted and refused,
  and **Settings › Trust** can allow one model to load unverified after a warning.
- **Benchmark history** with a history-aware recommendation, output budgets per device class
  (2,048 tokens for free answers on desktops, at most half the context window), a processor (WASM)
  benchmark without WebGPU and plain SVG charts.
- **Knowledge graph from workspace files**: entities and relations named by a model, each relation
  kept only when its cited chunk names both ends; a co-occurrence graph offline; resumable runs;
  results follow their files.

#### Conversations and sync

- **End-to-end encrypted chat sync** (optional): a sync secret wrapped with a passphrase
  (PBKDF2-SHA-256, 600,000 iterations), AES-GCM records padded to a multiple of 512 bytes with HMAC row ids,
  owner-only row level security (`chat_sync`, `chat_sync_keys`), deletions win over field changes,
  new messages win over deletions, device-only turns never synced, restore in a second browser
  with a one-time e-mail code.

#### Local companion (`@starpi/companion`)

- **Starpi's own local companion**: a loopback service on your machine (Node.js 22.13+,
  `node:sqlite`) with a sealed event store, an append-only audit chain with signed heads and
  anchors (it refuses to start on a rollback), a sealed vault with a key-encryption key in a file,
  systemd credentials or the macOS keychain, crypto-erase, sealed backups and bundles.
- **Zero egress by default**: an in-process guard over sockets, DNS and child processes; modules
  get a capability for the hosts the owner listed; on Linux the system unit adds `IPAddressDeny`
  and an egress splice outside the process.
- **Language models by data class**: public, personal, sensitive (local models only) and secret (no
  model); no silent switch between local and cloud.
- **Standard modules**: search (BM25 plus local embeddings, rank fusion), notes, documents,
  checked answers and conversations through the sentence gate, a read-only MCP server with a
  stdio bridge for desktop clients, pinned connector tools with approvals, agenda, inbox, a voice
  relay to a local voice server, setup checks and read-only feeds (CSV, MQTT).
- **Computer control, experimental and off by default**: consent, a 120-second mandate, a stop that
  is never refused, owner approvals for risky steps, block and allow lists; this release drives a
  simulated screen only.
- **Pairing with the browser**: Mode A (the companion serves the app from its loopback origin, an
  HttpOnly cookie plus a CSRF value) and Mode B (the hosted app, a token bound to its origin, Chrome's
  local network prompt). The browser keeps the secret sealed with a non-extractable key in the
  IndexedDB database `starpi-companion`, checks every signed audit head and shows a red banner on a
  rollback or fork until the user accepts the companion's current state.
- **The companion in the app**: a Companion tab and settings card, the retrieval source "Companion
  documents and notes" for grounded questions (a device-only question may take passages up to the
  class sensitive, other questions up to the user's ceiling, secret never), and the companion as a
  model of the chat: it gets the bare question, never the app's prompt, with the mode and the
  question's data class; its answers arrive already gated, are shown as released with their label,
  notice and withheld count, and stay on this device like the question asked there (never in the
  encrypted sync). Each branch of a thread is its own conversation on the companion (`after` on
  `POST /v1/chat`): asking again, changing a question or going on in another branch continues in a
  copy of the turns up to there. A Compare column asks it like the thread, without the app's tools;
  the council never seats it; Live asks it in free conversations only (a conversation from your
  sources with it picked ends before anything is retrieved); Auto asks it in free mode; a stopped
  companion answer is not kept, on either side.
- **Packaging**: systemd user and system units with readiness and a watchdog, the egress splice
  unit and a credential drop-in, a launchd agent, install and uninstall scripts, an offline bundle
  with `SHA256SUMS` (and an Ed25519 signature on request), and a local voice server (Whisper-class
  speech input, Piper voices) in Python.

#### Interface

- **A new shell**: a sidebar that collapses to a rail (a drawer on phones), **dark mode** (system,
  light or dark, applied before the first paint), a small UI kit, mount points that features render
  into, and a chat side panel (canvas, compare, research).
- **Six interface languages**: English, German, French, Spanish, Italian and Turkish, with
  dictionaries split into namespaces and loaded on demand; a language switch relabels the page in
  place. Answer purposes keep English instructions and name the answer language.

#### Server functions

- `api/relay.js` (the BYOK relay with a fixed upstream table), `api/pool.js` and
  `GET /api/models/pool` (site pools with round robin, failover until the first byte, key parking
  and per-key pacing), `GET /api/health` (booleans only), the speech routes and research steps,
  all behind an origin check, per-IP limits, optional daily budgets and an optional access code
  (`STARPI_ACCESS_CODE`). [docs/SERVER.md](docs/SERVER.md) describes them.

#### Tooling, CI and release

- `npm run verify` adds `headers:check`, `license:check` (a licence allowlist for every shipped
  package) and `eol:check` (an end-of-life register); `npm run hygiene:check` keeps private paths
  and internal identifiers out of the repository.
- CI jobs for the companion (Node 22 and 24, a systemd user-unit smoke test), the voice server,
  CodeQL, a workflow lint (actionlint, zizmor) and the weekly model lock; e2e runs against local
  provider fakes (`npm run fakes`).
- `npm run providers:ping` checks every provider and pool with real keys; `npm run eval:answers`
  measures answer quality per language.
- **Releases** publish `@starpi/core` and `@starpi/companion` to npm with provenance, attest every
  asset (`actions/attest-build-provenance`), sign `SHA256SUMS` and the companion's offline bundle
  keyless with cosign, and sign `SHA256SUMS` with Ed25519 when the release key is set up
  (`scripts/sign-release.mjs`).
- An end-to-end test opens a 2.1 profile (chats, remembered keys and settings in `localStorage`)
  with 3.0 and checks that everything moves once.

### Changed

- The first load stays below 2.1.0's (3 % less initial JavaScript) although the app does far more:
  the Supabase library, the knowledge graph view, the AI layer, the thread and every feature load
  after the first paint, and `verify:dist` holds the first load to a budget.
- The NVIDIA models are a pool of the AI layer; `POST /api/chat/nvidia` and `GET /api/models/nvidia`
  keep working for 2.x clients. `STARPI_ALLOWED_ORIGINS` and `STARPI_POOL_RPM_PER_IP` replace
  `NVIDIA_ALLOWED_ORIGINS` and `NVIDIA_RATE_LIMIT_PER_MINUTE` (still read).
- Pool allowlists follow `src/js/ai/catalog/pools.js`: Groq without Llama 4 Scout, OpenRouter with
  DeepSeek R1 and Qwen3 Coder (free), the Gemini pool on Gemini 2.5 Flash-Lite with an output cap
  of 4,096 tokens.
- The library publisher writes 384-dimensional multilingual-e5-small vectors (optional migration
  `20261101000000_embedding_384.sql`), the model the browser embeds its questions with.
- The app SBOM lists what the render frame bundles (mermaid and its tree) as shipped.
- On-device answers: a free answer may use the device's output budget (512 tokens on phones, 768 on
  small GPUs, 1,024 on laptops, 2,048 on desktops and strong GPUs), at most half the model's context
  window; a grounded answer keeps the preset's length within that budget. A smaller budget of 1,024
  tokens for free answers on strong GPUs was considered for 3.0 and not adopted: the half-window cap
  already keeps half the context for the conversation.
- `@starpi/core`, `@starpi/companion` and the app are 3.0.0; `CITATION.cff` follows.
- Dependencies: `@mlc-ai/web-llm` 0.2.86 (new model library hashes in `model-lock.json`),
  `@huggingface/transformers` 4.3.1 (same ONNX Runtime binary, `model-lock.json` unchanged), `lucide`
  1.56.0, `marked` 18.1.1, `dompurify` 3.4.17, `katex` 0.19.0 (also the override under mermaid; it
  reports missing glyphs through `strict`, which the app sets to `ignore`), `@supabase/supabase-js`
  2.117.3, `@playwright/test` 1.64.0, ruff 0.17.0, `actions/setup-node` 7.1.0,
  `actions/upload-artifact` 7.0.2, `actions/download-artifact` 8.0.2 and
  `github/codeql-action` 4.38.3.
- Dependabot raises the lower bound of a Python requirement range only when the range does not
  admit the new release (`increase-if-necessary`), so the library publisher keeps Python 3.11.
- The service worker also caches the lazy chunks a first visit loaded before it took control (the
  page names each one once a worker controls it, also a load that started before and finished after
  the worker took over), so an offline start no longer depends on the browser's HTTP cache;
  Chromium 156 no longer serves them from there offline.
- Migrations of one page wait for each other where Web Locks are missing, so two starts at once never
  run a migration twice.
- A model strength picked in Settings before the stored one was shown is no longer overwritten by it,
  so Save stores the pick it confirms.
- `.vercelignore` anchors the root folders it leaves out (`/tools/`, `/tests/`, `/backend/`,
  `/.github/`): the unanchored `tools/` also removed `src/js/ai/tools/` and `src/locales/tools/`, so
  every Vercel build since the tool runner failed. A unit test applies the file the way Vercel does
  and fails when it would remove anything the build or the functions read.

### Removed

- `backend/server.py` and its tests, the `/api/brain/*` routes, the NVIDIA mirror
  (`backend/core/nvidia_catalog.json`), the EC2 scripts (`backend/aws/`, `backend/remote_sync.sh`)
  and `npm run nvidia:sync` with `scripts/sync-nvidia-catalog.mjs`.
- Plaintext key storage ("remember keys") and the plaintext `chat_history` sync.

### Security

- Cross-origin isolation (COOP, COEP, CORP, `Origin-Agent-Cluster`) from one header source per
  build profile; the render and grounding frames run in opaque origins with their own CSP.
- The relay never takes a host from the browser (no SSRF), refuses keys in URLs, forwards an
  allowlist of headers and returns only an error identifier, never upstream text; the pools accept
  text and images only, no tools.
- Model files are pinned by SHA-256; tool definitions of MCP servers by SHA-256 of their canonical
  JSON; the companion pins connector tools the same way.
- [SECURITY.md](SECURITY.md) describes the new attack surfaces: the relay and pools, the speech and
  research routes, the key vault, loopback pairing, the companion's egress guard and its limits.

### Known limitations

- Answers grounded by a search API carry no receipt (receipt sources are workspace and knowledge
  base only); Gemini web turns offer no client tools; provider-side MCP (Anthropic, OpenAI) runs a
  server's allowed tools without asking per call; Compare and the council answer in the free route,
  and the council leaves out the on-device model.
- A new question typed into Compare for models on this device and your own server only stays on
  this device (no web search, no web, image or MCP tools); a thread question to your own server is
  not marked so.
- Grounded answers restored from history keep no excerpts, so read-aloud withholds their numbers.
- Vectors of a removed embedding model stay stored until another model is selected or the files
  are forgotten. A model file that was verified is checked again by URL and size only.
- Hashing a model file holds it in memory once more (about twice the largest file at the peak).
- `chat_sync` has no per-user quota; a passphrase cannot be changed yet (turn sync off and on).
- The web query stripper treats a run of 7 to 15 digits that starts with 0 as a phone number.
- Demo sample files exist in English and German only; the source-check sets for French, Spanish,
  Italian and Turkish are development sets. The Sources tab of the chat side panel is empty in
  3.0.
- The companion's egress guard runs in its process; only the Linux system unit adds a boundary
  outside it. Computer control drives a simulated screen only.

## [2.1.0] - 2026-10-14

### Added

- **Free chat and verified source mode.** A toggle in the message box switches between *Free chat*
  (a conversation without retrieval: up to 16 earlier turns, Markdown, code blocks, an attached file
  used as context) and *Verified source mode* (the source check, and a receipt for every answer with
  sources, as before). The choice is kept in this browser; source mode is the default. Quick
  prompts, sample questions and questions about a knowledge-graph entity always run in source mode.
  Free answers say that they were not checked against sources.
- **Device-adaptive model choice.** One picker in the header and in Settings lists every model,
  grouped as *Recommended for your device*, *In this browser (WebGPU/WASM)*, *NVIDIA NIM cloud (fast
  & free)* and *Other assistants*, with runtime, download size and warnings (needs WebGPU, needs a
  strong GPU, not set up). The device is classified from the WebGPU adapter, `deviceMemory` and the
  platform (`src/js/models/device.js`); the automatic choice never picks a 7–9B model and nothing is
  downloaded without a confirmation. Settings show hardware badges. Arrow keys switch only once they
  rest.
- **13 WebGPU presets in three tiers** (`src/js/webgpu/models.js`): T1 SmolLM2 360M and 1.7B,
  Qwen 2.5 0.5B and 1.5B, Llama 3.2 1B; T2 Gemma 2 2B, Llama 3.2 3B, Phi 3.5 mini, Qwen 2.5 3B; T3
  Mistral 7B v0.3, Qwen 2.5 7B, Llama 3.1 8B, Gemma 2 9B, each with its f16 and f32 build from the
  pinned WebLLM catalog. The README table is checked against that catalog.
- **A processor (WASM) runtime for browsers without WebGPU** (`src/js/wasm/`): Transformers.js
  4.3.0 runs SmolLM2 135M, SmolLM2 360M or Qwen 2.5 0.5B (8-bit ONNX, Hugging Face repositories
  pinned to a revision) in a Web Worker on a self-hosted, single-threaded ONNX Runtime
  (`/assets/ort-wasm-simd-threaded-<hash>.wasm`, loaded on first use). It works under the existing
  CSP, streams, stops at the next token, works offline once stored, and "Delete downloaded model
  data" removes it.
- **NVIDIA NIM cloud models through a server-side proxy.** `api/chat/nvidia.js` and
  `api/models/nvidia.js` (Vercel Functions) and the same routes in `backend/server.py` call 13
  models that NVIDIA offers as free endpoints with a pool of keys from `NVIDIA_API_KEYS`. Each
  request starts at the next key and fails over on 429, 5xx, timeouts and network errors until a
  stream starts; keys that fail are parked (429 for its Retry-After, 401/403 for 30 minutes). The
  chat route accepts only requests from the site's own pages (or from origins listed in
  `NVIDIA_ALLOWED_ORIGINS`; on the Python backend an origin in `BRAIN_ALLOWED_ORIGINS` or the API
  token), allowlisted models and bounded requests, limits each client address per minute, sets the
  upstream fields itself, never reads or returns upstream error bodies and logs keys by index only.
  Answers stream into the chat; in source mode they get the source check and a receipt
  (`answer.engine: "nvidia"`) like every other engine.
- `src/js/models/nvidia-catalog.js`: one allowlist with limits and timings for the app, the
  functions and the Python backend (`backend/core/nvidia_catalog.json`, written by
  `npm run nvidia:sync`); `npm run nvidia:ping` checks the endpoints without printing keys.
- **Chat tools:** a copy button on every code block, export of the current chat as Markdown or
  JSON (`starpi.chat/v1`), and deleting the current chat (also its synced messages).
- `npm run preview` and `npm run dev` serve the functions locally (`scripts/serve.mjs --functions`,
  only for localhost, IP addresses and `NVIDIA_ALLOWED_ORIGINS`).
- Tests: unit tests for the device classes, the model choices, the WASM catalog pins, the NVIDIA
  catalog, proxy, router and browser client, the stream parser, the chat export and the copy
  buttons; Python tests for the NVIDIA router and routes against shared validation vectors;
  end-to-end tests for both chat modes, NVIDIA answers with source check and receipt, the model
  picker and keyboard use.

### Changed

- Receipts record `wasm` and `nvidia` as engines (`docs/spec/receipts.md`); the receipt format is
  unchanged.
- Gemini receives the conversation in free chat; in source mode it still gets the question only.
- The build writes worker and runtime URLs into the sources before esbuild names the bundles, so a
  bundle's name always matches its content (browsers keep `/assets/*` for a year).
- `vercel.json` configures the two functions (300 s for the chat stream, 10 s for the model list).
- The architecture atlas has 130 diagrams (nine new: dual-mode chat, the NVIDIA browser client, the
  device tiers, the WASM runtime and five for the NVIDIA proxy); README, `SECURITY.md`, the
  walkthrough, the backend README and `CONTRIBUTING.md` describe the new parts.
- `@starpi/core` and the app are 2.1.0; the package API is unchanged. `CITATION.cff` follows.

### Security

- gitleaks rule `starpi-nvidia-api-key` (also for keys pasted with escaped underscores); the build
  check fails on any NVIDIA key in the bundles; a unit test scans the tracked files.
- The keys live only in the server environment (on Vercel a sensitive variable); the browser never
  sends an Authorization header to the proxy.
- `SECURITY.md` covers the proxy as a new surface, what each mode sends where, and its limits: the
  per-address limit and the key cooldowns are per instance, the Origin check stops other sites'
  pages but not scripts that forge headers, and pooling free keys must fit NVIDIA's terms.

## [2.0.0] - 2026-10-14

### Breaking changes

- **Receipts are written in format `starpi.receipt/v2`** (Merkle tree, inclusion proofs, optional
  signature). Verifiers of 1.x refuse them; `buildReceipt(draft, { schema: RECEIPT_SCHEMA_V1 })`
  still writes v1, and v1 receipts are still read and verified.
- **The source check runs version 2 of its rules** (`GROUNDING` = `starpi-grounding` 2) by
  default. Verdicts change: new reasons can mark statements weak, version numbers are compared as
  codes, and the value-context check reads the passage around each value instead of the section.
  `groundAnswer(blocks, sources, { version: 1 })` runs the rules of 1.x unchanged (byte-identical
  output, pinned by the golden tests), and receipts are recomputed with the version they record.
- **Two new reason codes**, `negation_inversion` and `name_context`, in reports, receipts, the
  JSON Schema and SARIF; code that switches over reason codes needs to handle them. A receipt in
  format v1 with one of them is refused.

### Added

- **Source check version 2** (`src/js/core/polarity.js`, `src/js/core/binding.js`), in English and
  German, deterministic and without dependencies, each statement checked on its own so receipts
  recompute it:
  - `negation_inversion` (weak): the statement drops, adds or reverses the negation of the excerpt
    clause it matches, also through opposites (enabled/disabled, allowed/prohibited,
    increased/decreased, un-/in-/dis- words, erlaubt/verboten, gestiegen/gesunken). Negations
    written differently count as the same meaning; "no later than", "not … until", "only after",
    ranges, questions and clauses with different numbers are not read as reversals.
  - `name_context` (weak): the passage the statement matches names someone or something else;
    titles ("Frau", "Mr"), the German genitive and hyphenated names are matched, names the
    question gave are not checked.
  - `fact_context` in version 2: the value's own passage without the section heading; a list part
    without a subject of its own shares the first part's words; version numbers ("firmware
    4.2.1", also date-shaped ones such as "4.2.10") are codes.
- **Receipts v2** (`src/js/core/merkle.js`, `src/js/core/signature.js`, `src/js/core/hash.js`): an
  RFC 6962 Merkle tree over the citations with an inclusion proof per citation
  (`verifyCitationProof`), Ed25519 or ECDSA P-256 signatures with WebCrypto (`signReceipt`,
  `verifyReceiptSignature`, `importPublicKey`, `publicKeyId`), statuses `valid`, `invalid`,
  `unsigned`, `key_mismatch` and `unsupported_algorithm`, and `trusted` only for a key the caller
  supplied. `docs/spec/receipt-v2.schema.json` and a rewritten `docs/spec/receipts.md`.
- **`starpi-ground`**, a second command of `@starpi/core`: checks a Markdown document of any length
  against source files and writes text, JSON or SARIF 2.1.0 (`--format`, `--output`, `--fail-on`,
  `--cite`), exit codes 0, 1 and 2; `checkDocument` and `toSarif` in the API. A GitHub Actions
  snippet with `upload-sarif` is in both READMEs.
- **App:** the source-check panel names the new reasons in English and German; the receipt
  dialog shows the Merkle root, verifies inclusion proofs and, with an optional public key, the
  signature. `starpi-verify-receipt --public-key` does the same on the command line.
- **Evaluation for 2.0:** `tests/fixtures/grounding/sources-v2.json` (technical specifications in
  English and German), `eval-v2-dev.json` (107 answers), `eval-v2-holdout.json` (104 answers,
  frozen by SHA-256 before any version 2 rule was written), `paraphrases.json` (854 faithful
  paraphrases from a red-team review), `docs/eval/v2-protocol.md` and `docs/eval/v2-results.md`
  (the one final measurement). `scripts/eval-source-check.mjs` gains `--sets`, `--grounding`,
  `--variants` and `--unblind`, and refuses a changed held-out file.
- `@starpi/core` exports `GROUNDING_VERSIONS`, `REASON_CODES`, `REASON_CODES_V1`, the receipt,
  Merkle and signature functions, `checkDocument`, `toSarif`, `describeReason` and
  `REASON_MESSAGES`.
- Tests: `merkle.test.mjs` (RFC 6962 vectors, an independent implementation for 0 to 64 leaves),
  `receipt-v2.test.mjs` (round trips, tampering, both signature algorithms, the receipt written by
  1.3.0), `ground.test.mjs`, `grounding-v2.test.mjs`; golden pins of version 2 on every answer
  set; end-to-end tests for the new reasons and for a v2 receipt with an ES256 signature.

### Changed

- The release workflow smoke-tests both commands of the packed tarball and a SARIF run.
- The panel's note says what the check compares; the README, the package README, the receipt
  specification, `SECURITY.md`, the walkthrough and the architecture atlas describe version 2.
- `@starpi/core` and the app are 2.0.0; `CITATION.cff` follows.

### Results

Measured once on the held-out set written for 2.0 (`docs/eval/v2-results.md`): version 2
detects 17 of 23 wrong names (version 1: 10), 20 of 24 correct values attached to the wrong thing
(13) and 16 of 23 reversed statements (0), and marks no statement of a faithful answer unsupported
in any set; statements of faithful answers marked weak there rise from 4 to 8 of 144. The targets
of 8 of 10 are reached for values, not for names (74 %) or negations (70 %).

## [1.3.0] - 2026-10-13

### Added

- **Dependency audit in CI.** A new `audit` job fails on any advisory in runtime npm dependencies
  and on any advisory in the backend requirements (`pip-audit`, pinned in
  `backend/requirements-dev.txt`). Advisories in development tooling are reported as a warning.
- **README model table is checked against the WebLLM catalog.** `tests/unit/models.test.mjs`
  compares the VRAM figures with `vram_required_MB` of the pinned catalog and the context window
  with the one the app requests.
- **"Reproduce the published numbers"** in the README: the commands and the test that pins each
  figure.
- `.mailmap` with the maintainer's canonical name and address.
- **`@starpi/core` ready for npm.** The package is a workspace of the root package (so
  `npm pack --workspace=@starpi/core` and `npm publish --workspace=@starpi/core` work), has the
  app's version (1.3.0, raised from 0.1.0; both are released together from now on), declares
  `publishConfig.access: public`, `main`, a `bin` path npm does not have to correct, and keywords
  for search. Its README covers installing from npm or from the release tarball with its
  checksum, every task with its function, chunking and BM25 search, the command line, the supply
  chain and versioning; every example in it was run against the packed tarball.
- **Release assets.** `release.yml` now builds the `@starpi/core` tarball and the SBOMs in a
  `prepare` job with read-only permissions, smoke-tests the tarball (file list, version banner, an
  offline install into an empty project, the exports, the `starpi-verify-receipt` command) and
  writes `SHA256SUMS`; the `release` job, the only one with write access, installs and runs
  nothing from the repository, checks the checksums and attaches `starpi-core-X.Y.Z.tgz`,
  `starpi-X.Y.Z.cdx.json`, `starpi-core-X.Y.Z.cdx.json` and `SHA256SUMS`. A tag pushed ahead of
  the release must point at the commit CI tested, and both packages must have the same version.
- **CycloneDX SBOMs.** `npm run sbom` (`scripts/sbom.mjs`, `scripts/lib/sbom.mjs`) writes
  CycloneDX 1.5 SBOMs of the app (every package in the lockfile, development tooling marked) and
  of `@starpi/core` (no components: the package has no dependencies) from `package-lock.json`,
  without installing anything. npm's random serial number and timestamp, directory-based names
  and a package listed twice under one `bom-ref` are normalized, so the files are byte-identical
  for one commit and one npm version; each document is checked before it is written. The CI
  `audit` job uploads them as the `sbom` artifact on every run; `tests/unit/sbom.test.mjs` covers
  the normalization and runs the command twice.
- **CI packs `@starpi/core` on every pull request** (`npm run pack:core` in the `frontend` job:
  a typed build and the list of published files), so a broken declaration fails before a
  release.
- **Documentation.** README sections *Use the checks in your own app* and *Ecosystem and
  downstream use*; a *Supply chain* section in `SECURITY.md` (SBOMs, audit gates, pins, release
  assets and how to check them); a *Releases* section in `CONTRIBUTING.md`; an issue template for
  `@starpi/core`.

### Changed

- `SECURITY.md`: email channel next to GitHub private advisories, disclosure targets
  (acknowledgement within 7 days, triage within 14, fix within 90) and a safe-harbor statement.
  The Code of Conduct lists the same address for enforcement reports.
- Copyright holder and package author use the maintainer's full name.
- `npm run typecheck` passes `--noEmit` explicitly.
- `source-map-js` 1.2.1 → 1.2.2 in the lockfile (development dependency, GHSA-68fv-2mgg-jv7q).
- npm `overrides` pin `katex` 0.18.11 under mermaid (GHSA-238p-pmpm-9mq7) and
  `postcss-selector-parser` 7.1.6 under Tailwind CSS 3 (GHSA-rj75-hqrm-r3gf). Both are
  development dependencies; the built `dist/` is byte-identical.
- Dependencies: `pdfjs-dist` 6.3.289 → 6.4.299, `lucide` 1.47.0 → 1.52.0, `dompurify` 3.4.15 →
  3.4.16, `@supabase/supabase-js` 2.117.0 → 2.117.2; development tooling `eslint` 10.11.0 →
  10.12.0, `globals` 17.12.0 → 17.13.0, `jsdom` 30.1.1 → 30.1.2, `mermaid` 12.0.0 → 12.1.0,
  `ruff` 0.16.8 → 0.16.10. The source-check evaluation output is
  unchanged.
- The architecture atlas and `CONTRIBUTING.md` describe the `audit` job (six CI jobs), the
  explicit `--noEmit`, and name mermaid 12.1.0 and ruff 0.16.10.
- `pack:core` runs `npm pack --workspace=@starpi/core --dry-run`; its `prepack` script builds the
  package once, with type declarations.
- `tests/unit/core-package.test.mjs` also checks that `files` covers every entry point, that the
  package is public, a workspace of the root and has the app's version (in `package.json` and in
  the lockfile), and that its `pdfjs-dist` peer range has the major version the app ships.
- `SECURITY.md`: supported versions for the web app and for `@starpi/core`; the package, its
  command and the release assets are in scope; release assets are checksummed, not signed (known
  limitation).
- Issue and pull request templates: a security pointer in the bug report, `@starpi/core` and
  release in the affected areas, `ruff format --check`, the dependency audit, `pack:core`, rule
  version bumps and a release checklist.
- The architecture atlas, `CONTRIBUTING.md`, `docs/WALKTHROUGH.md` and the README describe the
  SBOM steps, the dry-run pack, the two release jobs and 25 unit test files.

### Fixed

- README: the first answer set flags 48 of 49 changed values, not 47; the floor in
  `tests/unit/source-check-eval.test.mjs` is raised to match.
- `docs/WALKTHROUGH.md` counted 117 diagrams in the atlas; it has 118.

### Security

- The release job that holds `contents: write` still installs and runs no dependency code: the
  package is built and tested in a separate read-only job, and the assets are checked against
  `SHA256SUMS` before they are attached.
- `npm audit` reports GHSA-vfj7-8cjw-p6xm (braces 3.0.3, denial of service through deeply nested
  patterns, no patched release yet) in Tailwind CSS 3's file watcher and glob matching, which are
  development dependencies. The CSS build only expands the globs of `tailwind.config.js`, and
  nothing of them is shipped in `dist/`; the runtime audit reports no known vulnerabilities.

## [1.2.0] - 2026-09-27

### Added

- **Source check on every answer.** Each statement is compared with the excerpts it cites:
  numbers in English and German formats (also written as words), dates, times, weekdays, codes,
  quotations and wording, and names in English statements. Statements whose values are not in the
  cited excerpts are listed with the reason ("520,000 is not in [Doc: plan.md, Chunk: 1]"),
  highlighted, and their citations marked. A value the excerpt contains only next to other words
  ("75,000 EUR for infrastructure" when the excerpt says "95,000 EUR for infrastructure and 75,000
  EUR for training") is reported with the passage where it stands. Model answers are compared
  only with the part of each excerpt that reached the model. Deterministic, in the browser, no
  second model (`src/js/core/facts.js`, `src/js/core/grounding.js`, `src/js/rag/grounding-view.js`).
- **Answer receipts** (`starpi.receipt/v1`). A JSON file per answer with SHA-256 fingerprints of
  the source files and their extracted text, passage offsets and the source-check verdicts. The
  receipt dialog downloads receipts and verifies them against the original files in the ingest
  worker; `npm run verify:receipt` does the same on the command line. Format and verification
  levels are specified in [`docs/spec/receipts.md`](docs/spec/receipts.md), with a JSON Schema.
- **`@starpi/core`** (`packages/core`): the source check, receipts, text extraction, chunking and
  BM25 as a dependency-free ESM package with type declarations and a `starpi-verify-receipt`
  command, built from the app's own modules (`npm run build:core`).
- **Sample files.** *Try with sample files* reads a plan, a risk register (CSV) and kickoff notes
  (PDF) of a fictitious project into the workspace, in English or German, and suggests questions
  about them; *See the source check catch an error* shows a prepared answer with one wrong number.
- **Evaluation of the source check** (`npm run eval:source-check`) on 308 labelled answers about
  the sample data, faithful or with one planted error, including a held-out set written after the
  rules were fixed. Held out: no statement of 100 faithful answers marked unsupported (15 of 324
  weak), all 49 changed numbers, dates, times, weekdays and codes flagged; 4 of 10 wrong names,
  6 of 10 misplaced values and none of 10 negations flagged.
- **Accessibility.** Skip link, labelled landmarks, dialogs that keep and return focus, a keyboard
  list of the graph's entities, visible focus rings, and an axe scan of every view in the
  end-to-end tests.
- **Release workflow.** A GitHub release is created for the version in `package.json` once CI has
  passed on `main`, with the notes from `docs/releases/`.
- **Documentation.** Section 12 of the [architecture atlas](docs/ARCHITECTURE.md) on the source
  check, answer receipts and the sample files, every other section checked against the current
  code (117 diagrams), the receipt format in [`docs/spec/`](docs/spec/receipts.md), and a README
  that shows the source check, receipts and their evaluation.

### Changed

- **Knowledge-base search** (migration `20260924120000`): when no row contains every search term,
  `search_knowledge` returns the rows that share at least two of them, so questions in natural
  language find their passages instead of falling back to the newest documents.
- **Retrieval** keeps slots for both the workspace and the knowledge base, so many weak workspace
  hits no longer push out a strong knowledge-base hit; the model context always closes its excerpt
  fences; extractive answers quote only the excerpt that was delivered.
- **Service worker:** versioned by the content of the page, the assets, every public file and the
  worker itself; prunes assets of older builds; stores only the real page as the offline shell. A
  new worker takes over at once only when no page is open, so an open tab keeps its in-memory
  workspace.
- **Keys:** the build accepts Supabase publishable keys (`sb_publishable_…`) and refuses secret and
  service-role keys. Node.js 22.13 or newer.
- **First visit:** without a browser session the sidebar says *Public knowledge*, and actions that
  need one are disabled with an explanation instead of failing.

### Fixed

- A question that starts with a greeting ("Hi, what is the budget?") is answered from the
  sources; a file still being read belongs to the question it was attached to.
- The same file added twice is indexed once; a different file with the same name gets its own
  name, so a citation never points at an invented chunk number.
- Late replies no longer overwrite a citation or document opened after them; error messages
  follow a language switch; several files added at once are reported one by one.
- Synced chat history loads the newest messages, and on-device turns are merged by time.
- Phones and tablets: the knowledge graph scrolls and its labels no longer overlap, wide tables
  scroll inside the answer, the page title and mode selector fit, the message box grows with its
  text, and citation chips keep their chunk number visible.
- Testing an OpenRouter key that is typed but not saved yet uses that key.

### Security

- An answer quoted without a model that lists the names of workspace files (a greeting, the
  document list) stays on the device like the turns that use the files: never synced, never sent
  to a cloud provider or an own server as chat history.
- The Python backend runs with the service role, which bypasses RLS; its document list and search
  results are now limited to published rows, like the browser's.
- Receipts are validated against size and field limits and refused with members the format does
  not define; the app renders them as text only, and the command-line verifier escapes control and
  bidirectional characters. A receipt exported without excerpt texts quotes no excerpt text in its
  source-check reasons either.

## [1.1.0] - 2026-09-24

### Added

- **On-device workspace.** PDF, text, Markdown, JSON and CSV files are parsed in a dedicated
  worker (pdf.js without `eval` or font loading), split into 500-character chunks with a
  50-character overlap and exact offsets, and indexed with Okapi BM25 (k1 = 1.2, b = 0.75). Files
  live in memory only; nothing is uploaded.
- **Verifiable citations.** Every passage an answer is given carries a `[Doc: <name>, Chunk: <n>]`
  label. Only labels the app registered itself become citation buttons, and the drawer shows the
  exact chunk inside its source text, with offsets and score.
- **WebLLM engine in a dedicated Web Worker** with load sequencing, cancellation, quota checks,
  device-loss handling and a 32-bit fallback for adapters without `shader-f16`.
- **Diagnostics and benchmark.** WebGPU adapter report (vendor, architecture, limits,
  `shader-f16`) and a benchmark on the loaded model: warm-up, fixed prompt, time to first token
  and decode tokens per second.
- **English and German UI.** English by default, an instant EN | DE switch without a reload,
  dictionaries with identical keys, and language-specific system prompts. Lucide icons replace
  every emoji.
- **Anonymous Supabase sessions** with owner-based row level security, and full-text search
  through the `search_knowledge` RPC (migration `20260923000000`).
- **Build and quality gates.** esbuild and Tailwind build with a strict Content-Security-Policy and
  no inline code, verified after every build; unit tests, Playwright end-to-end tests on desktop
  and mobile, and CI jobs for the frontend, end-to-end, backend, database (PostgreSQL 16 with
  pgvector) and secret scanning.
- **Documentation.** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) with 87 diagrams checked
  against the code (copies in the README and guides stay in sync through `npm run docs:sync`), a
  [walkthrough](docs/WALKTHROUGH.md), [`backend/README.md`](backend/README.md), an animated
  pipeline overview in the README, a security policy and a code of conduct. CI renders every
  Mermaid block and fails on a diagram copy that differs from the atlas or on a broken link or
  anchor.

### Changed

- **Database** (migration `20260924000000`): published rows are read-only for browser roles,
  `brain_settings` is service role only, and CHECK constraints bound every text and JSON column the
  browser can write.
- **Rendering:** all Markdown passes through DOMPurify with a restrictive profile.
- **Privacy notices** state where the question goes in each mode, including the knowledge-base
  search.
- **Backend:** binds to loopback by default and requires a bearer token on any other interface.
  Request threads are no longer daemonic, so a shutdown finishes requests in flight. The service
  reads its `.env` itself instead of through systemd, so quotes and inline comments are parsed the
  same way everywhere, and the last assignment of a key wins.

### Fixed

- Chat turns that use the on-device workspace (the question, a named attachment and the answer)
  are never synced to Supabase.
- The local preview server, which also runs the end-to-end tests, applied the production headers
  only to `/`; scripts, workers and the manifest now get the CSP as in production.
- After *Clear workspace* or a worker crash, an earlier citation could open a newer file with the
  same id; document ids are now unique per worker.
- A superseded cache-only model load could reset the status of a newer load.
- *Settings saved* appeared even when the browser refused to store the settings.
- After an offline start the app never reconnected; it now retries when the browser is back
  online and with a growing delay.
- `http://[::1]` own-server URLs passed validation but were blocked by the CSP; they are now
  rejected with a clear message.
- `deploy_ec2.sh` generates `BRAIN_API_TOKEN` when missing, refuses to rewrite an unreadable
  `.env`, works when the file belongs to the service user, and fails when the health check does
  not answer.
- Chat history is restored on boot, and the knowledge graph is reachable on phones.

### Security

- Browser roles only see public rows or their own; chats are visible to their owner only, and
  browser roles cannot execute SECURITY DEFINER functions.
- Provider API keys stay in the browser tab unless the user opts in to keep them.
- The backend refuses requests forwarded by a reverse proxy when no token is set, bounds
  `Content-Length`, answers 408 on slow bodies and rejects non-finite embeddings.
- Development dependencies: Mermaid 12 pulled `lodash-es` 4.17.23 (GHSA-r5fr-rjxr-66jc,
  GHSA-f23m-r3pf-42rh); an npm override pins the patched 4.18.1. `npm audit` reports no known
  vulnerabilities.

## [1.0.0] - 2026-09-12

- First public release: knowledge base on Supabase with pgvector, knowledge graph, voice input,
  cloud and on-device (WebGPU) answers, and an installable PWA.

[Unreleased]: https://github.com/umutcantezgel-cpu/Starpi/compare/v3.0.0...HEAD
[3.0.0]: https://github.com/umutcantezgel-cpu/Starpi/compare/v2.1.0...v3.0.0
[2.1.0]: https://github.com/umutcantezgel-cpu/Starpi/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/umutcantezgel-cpu/Starpi/compare/v1.3.0...v2.0.0
[1.3.0]: https://github.com/umutcantezgel-cpu/Starpi/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/umutcantezgel-cpu/Starpi/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/umutcantezgel-cpu/Starpi/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/umutcantezgel-cpu/Starpi/releases/tag/v1.0.0
