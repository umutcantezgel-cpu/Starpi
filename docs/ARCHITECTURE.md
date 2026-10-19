# Starpi architecture

This atlas describes how Starpi works, one diagram per question a contributor or reviewer is likely
to ask. Every diagram was drawn from the source files listed under it and then checked against the
code line by line: names, guards, limits and failure paths are the ones in the code, not an
idealised design. When the code changes, change the diagram in the same pull request.

- **Rendering:** GitHub renders the diagrams. CI parses and renders every Mermaid block in the
  repository's Markdown files with the pinned Mermaid release (`tests/e2e/docs-diagrams.spec.mjs`),
  so a broken diagram fails the build.
- **Single source:** this file is the only place a diagram is edited. The README and the guides embed
  some of them as exact copies under the same `<!-- diagram: <id> -->` marker: `npm run docs:sync`
  refreshes the copies, and `tests/unit/docs.test.mjs` fails when a copy differs from this file.
- **Conventions:** dashed nodes and edges are optional, manual or outside Starpi's control. The model
  picker stores one value (`starpi_assistant_v1`, `AssistantValue` in `config.js`): `auto` (the best
  model that is set up), `device` (the model on this device), `<provider>:<model>` (one model of one
  provider, `nvidia:<id>` without a key being the site's pool), `local:*` (the first model of the
  user's own server) and `companion:starpi-core` (the paired local companion). The composer's modes
  are *Auto*, *Free* and *Grounded* (`auto`, `free`, `grounded`); a turn takes one of three routes
  (`free`, `mixed`, `grounded`, `ai/hybrid.js`). *On this device* means the providers `webgpu` and
  `wasm`. A provider is reached by one of the transports of `ai/catalog/providers.js`: `direct` from
  the browser, `auto` (direct, retried through the relay when the browser call is blocked), `relay`,
  `pool` (the site's keys) or `device` (a worker in the browser, the user's own server, the
  companion). The 2.x names `client`, `local`, `nvidia` and `council` survive only as the
  `ComputeMode` other modules still ask for, and as the values the 2.x migration reads.

## Contents

1. [System overview](#1-system-overview)
   - [System context and trust boundaries](#system-context-and-trust-boundaries)
   - [What leaves the device: connection state](#what-leaves-the-device-connection-state)
   - [What leaves the device: one chat turn](#what-leaves-the-device-one-chat-turn)
   - [Library publisher trust boundary](#library-publisher-trust-boundary)
   - [Frontend import graph (1 of 4): main.js and the first load](#frontend-import-graph-1-of-4-mainjs-and-the-first-load)
   - [Frontend import graph (2 of 4): the feature modules and what they load when mounted](#frontend-import-graph-2-of-4-the-feature-modules-and-what-they-load-when-mounted)
   - [Frontend import graph (3 of 4): chat thread and AI layer](#frontend-import-graph-3-of-4-chat-thread-and-ai-layer)
   - [Frontend import graph (4 of 4): source check, sentence gate, receipts and core/](#frontend-import-graph-4-of-4-source-check-sentence-gate-receipts-and-core)
   - [Shared infrastructure modules, their importers and npm packages](#shared-infrastructure-modules-their-importers-and-npm-packages)
   - [Bundle entry points, Web Workers and lazy imports](#bundle-entry-points-web-workers-and-lazy-imports)
2. [Boot and settings](#2-boot-and-settings)
   - [boot(): module start-up order](#boot-module-start-up-order)
   - [Boot-time changeEngine: cached model only, never a download](#boot-time-changeengine-cached-model-only-never-a-download)
   - [Opening the conversation store](#opening-the-conversation-store)
   - [saveSettings: model strength and a pending assistant pick](#savesettings-model-strength-and-a-pending-assistant-pick)
   - [Keys: the tab, the vault and its lock](#keys-the-tab-the-vault-and-its-lock)
   - [deleteHistory: deleting the chat history](#deletehistory-deleting-the-chat-history)
   - [Testing a key](#testing-a-key)
3. [Answering a question](#3-answering-a-question)
   - [A question in the thread](#a-question-in-the-thread)
   - [retrieve(): where the excerpts come from](#retrieve-where-the-excerpts-come-from)
   - [Workspace hits and mergeHits: slots per source and the pinned files](#workspace-hits-and-mergehits-slots-per-source-and-the-pinned-files)
   - [The runner: candidates, failover before the first text, and the quoted fallback](#the-runner-candidates-failover-before-the-first-text-and-the-quoted-fallback)
   - [Auto, Free and Grounded: how each route builds its request](#auto-free-and-grounded-how-each-route-builds-its-request)
   - [After rendering: source check, receipt draft and the stored turn](#after-rendering-source-check-receipt-draft-and-the-stored-turn)
   - [synthesizeAnswer: the extractive fallback](#synthesizeanswer-the-extractive-fallback)
   - [Answer modes: what leaves the device](#answer-modes-what-leaves-the-device)
   - [Compare and the council](#compare-and-the-council)
   - [Settings: what the model choice stores](#settings-what-the-model-choice-stores)
   - [Privacy notice under the chat input](#privacy-notice-under-the-chat-input)
   - [On-device model selection](#on-device-model-selection)
   - [Device tiers and the model pickers](#device-tiers-and-the-model-pickers)
   - [Context packs and the output budget of models on this device](#context-packs-and-the-output-budget-of-models-on-this-device)
4. [On-device workspace and citations](#4-on-device-workspace-and-citations)
   - [Keeping files on this device and searching by meaning](#keeping-files-on-this-device-and-searching-by-meaning)
   - [On-device workspace: from file drop to the document list](#on-device-workspace-from-file-drop-to-the-document-list)
   - [ingest() in the worker: fingerprint, duplicate check, unique name and DocumentInfo](#ingest-in-the-worker-fingerprint-duplicate-check-unique-name-and-documentinfo)
   - [extractText: checks, text, JSON, CSV, Office, HTML and images](#extracttext-checks-text-json-csv-office-html-and-images)
   - [csvToText: CSV rows as column: value lines](#csvtotext-csv-rows-as-column-value-lines)
   - [pdfToText: pdf.js loading, page loop and limits](#pdftotext-pdfjs-loading-page-loop-and-limits)
   - [Workspace RPCs: search, head, context, text, remove, clear](#workspace-rpcs-search-head-context-text-remove-clear)
   - [verify-receipt: re-checking an answer receipt against the original files](#verify-receipt-re-checking-an-answer-receipt-against-the-original-files)
   - [Worker crash, Clear workspace and restart](#worker-crash-clear-workspace-and-restart)
   - [chunkText: sliding windows with exact offsets](#chunktext-sliding-windows-with-exact-offsets)
   - [Chunk boundary helpers: findBreak and safeBoundary](#chunk-boundary-helpers-findbreak-and-safeboundary)
   - [BM25Index: tokenize, add, remove and search](#bm25index-tokenize-add-remove-and-search)
   - [Citation labels, scopes and the fenced context](#citation-labels-scopes-and-the-fenced-context)
   - [From hits to a citation in the drawer](#from-hits-to-a-citation-in-the-drawer)
   - [linkifyCitations and the Sources row](#linkifycitations-and-the-sources-row)
   - [Attaching files and images to a message](#attaching-files-and-images-to-a-message)
   - [Asking about an attached file](#asking-about-an-attached-file)
   - [Voice input: the dictation chain](#voice-input-the-dictation-chain)
5. [On-device inference](#5-on-device-inference)
   - [On-device engine status machine](#on-device-engine-status-machine)
   - [loadModel: probe, choice, cache and storage checks](#loadmodel-probe-choice-cache-and-storage-checks)
   - [loadModel: WebLLM import, model record and partial cache](#loadmodel-webllm-import-model-record-and-partial-cache)
   - [loadModel: worker creation, progress phases and generation guards](#loadmodel-worker-creation-progress-phases-and-generation-guards)
   - [Processor (WASM) runtime: loading, pinned downloads, generation and Stop](#processor-wasm-runtime-loading-pinned-downloads-generation-and-stop)
   - [Diagnostics & Benchmark tab: probe and runtime](#diagnostics--benchmark-tab-probe-and-runtime)
   - [Inference benchmark run and the benchmark history](#inference-benchmark-run-and-the-benchmark-history)
   - [Model download integrity](#model-download-integrity)
6. [Knowledge base views](#6-knowledge-base-views)
   - [Knowledge base tab: document list](#knowledge-base-tab-document-list)
   - [Knowledge base tab: document modal](#knowledge-base-tab-document-modal)
   - [Knowledge graph tab: loading, status and entity list](#knowledge-graph-tab-loading-status-and-entity-list)
   - [Knowledge graph tab: canvas drawing](#knowledge-graph-tab-canvas-drawing)
   - [Knowledge graph tab: selection and ask-entity](#knowledge-graph-tab-selection-and-ask-entity)
   - [Knowledge graph tab: new entities](#knowledge-graph-tab-new-entities)
7. [Languages, storage and offline](#7-languages-storage-and-offline)
   - [Locale boot and the language switch](#locale-boot-and-the-language-switch)
   - [How an element gets its translated text](#how-an-element-gets-its-translated-text)
   - [Tests that keep the dictionaries and keys consistent](#tests-that-keep-the-dictionaries-and-keys-consistent)
   - [localStorage, sessionStorage and the auth session](#localstorage-sessionstorage-and-the-auth-session)
   - [IndexedDB, OPFS and the caches](#indexeddb-opfs-and-the-caches)
   - [In-memory answer stores](#in-memory-answer-stores)
   - [Service worker fetch handler](#service-worker-fetch-handler)
   - [Service worker install, waiting and activate](#service-worker-install-waiting-and-activate)
   - [App update flow in the page](#app-update-flow-in-the-page)
8. [Supabase](#8-supabase)
   - [connect(): anonymous session and schema probe](#connect-anonymous-session-and-schema-probe)
   - [classifyError: mapping failures to error kinds](#classifyerror-mapping-failures-to-error-kinds)
   - [Database badge states (renderConnection)](#database-badge-states-renderconnection)
   - [Data access functions: callers, tables and failure paths](#data-access-functions-callers-tables-and-failure-paths)
   - [Encrypted chat sync](#encrypted-chat-sync)
   - [Supabase schema: knowledge base and knowledge graph](#supabase-schema-knowledge-base-and-knowledge-graph)
   - [Supabase schema: chat sync, chat history and settings](#supabase-schema-chat-sync-chat-history-and-settings)
   - [RLS decisions for documents, entities and relations](#rls-decisions-for-documents-entities-and-relations)
   - [RLS for sections, the chat tables and settings](#rls-for-sections-the-chat-tables-and-settings)
   - [RPC EXECUTE grants and size limits](#rpc-execute-grants-and-size-limits)
   - [search_knowledge: full matches first, then shared terms](#search_knowledge-full-matches-first-then-shared-terms)
   - [Migration apply order and guards](#migration-apply-order-and-guards)
   - [run_rls_tests.sh scenarios and assertions](#run_rls_testssh-scenarios-and-assertions)
   - [What rls_test.sql asserts, in order](#what-rls_testsql-asserts-in-order)
9. [Security layers](#9-security-layers)
   - [Untrusted content on its way to the DOM](#untrusted-content-on-its-way-to-the-dom)
   - [Source-check panel and answer receipts](#source-check-panel-and-answer-receipts)
   - [Worker isolation, RLS, key handling, CSP and the build gate](#worker-isolation-rls-key-handling-csp-and-the-build-gate)
   - [Publisher secrets, service role reads and CI supply chain](#publisher-secrets-service-role-reads-and-ci-supply-chain)
10. [Library publisher](#10-library-publisher)
    - [Publishing a file: sections, vectors and one atomic insert](#publishing-a-file-sections-vectors-and-one-atomic-insert)
    - [Vectors: the model of the browser, pinned and verified](#vectors-the-model-of-the-browser-pinned-and-verified)
    - [Service role reads: health, list, backfill and test-query](#service-role-reads-health-list-backfill-and-test-query)
11. [Build, test and deploy](#11-build-test-and-deploy)
    - [npm run build (scripts/build.mjs)](#npm-run-build-scriptsbuildmjs)
    - [Build output gate (verify-dist.mjs)](#build-output-gate-verify-distmjs)
    - [Dev watch mode and the local static server](#dev-watch-mode-and-the-local-static-server)
    - [Command-line tools beside the build](#command-line-tools-beside-the-build)
    - [CI jobs and the test layers they run](#ci-jobs-and-the-test-layers-they-run)
    - [Unit tests grouped by concern](#unit-tests-grouped-by-concern)
    - [Unit tests for the source check, receipts and sample files](#unit-tests-for-the-source-check-receipts-and-sample-files)
    - [End-to-end tests with mocked Supabase and diagnostics](#end-to-end-tests-with-mocked-supabase-and-diagnostics)
    - [End-to-end tests for the source check, receipts and accessibility](#end-to-end-tests-for-the-source-check-receipts-and-accessibility)
    - [CI workflow triggers, jobs and Dependabot](#ci-workflow-triggers-jobs-and-dependabot)
    - [Frontend and end-to-end jobs](#frontend-and-end-to-end-jobs)
    - [Backend, database, audit and secret-scanning jobs](#backend-database-audit-and-secret-scanning-jobs)
    - [Release workflow after CI](#release-workflow-after-ci)
    - [CI workflow and Vercel build of the PWA and the NVIDIA functions](#ci-workflow-and-vercel-build-of-the-pwa-and-the-nvidia-functions)
    - [Supabase schema: fresh install or ordered migrations](#supabase-schema-fresh-install-or-ordered-migrations)
12. [Source check, answer receipts and sample files](#12-source-check-answer-receipts-and-sample-files)
    - [Source check: from the rendered answer to the panel](#source-check-from-the-rendered-answer-to-the-panel)
    - [checkSentence: when a statement is checked, its reasons and its verdict](#checksentence-when-a-statement-is-checked-its-reasons-and-its-verdict)
    - [checkV2: negations, names and values in another place](#checkv2-negations-names-and-values-in-another-place)
    - [Facts: strict claims, lenient excerpts and how they are matched](#facts-strict-claims-lenient-excerpts-and-how-they-are-matched)
    - [Answer receipts: fingerprints, draft, dialog and download](#answer-receipts-fingerprints-draft-dialog-and-download)
    - [Receipts v2: Merkle tree, inclusion proofs and signature](#receipts-v2-merkle-tree-inclusion-proofs-and-signature)
    - [Deterministic citation verification and receipt flow](#deterministic-citation-verification-and-receipt-flow)
    - [Re-checking a receipt in the app and on the command line](#re-checking-a-receipt-in-the-app-and-on-the-command-line)
    - [starpi-ground: from arguments to exit code](#starpi-ground-from-arguments-to-exit-code)
    - [Sample files and the source-check demo](#sample-files-and-the-source-check-demo)
13. [NVIDIA cloud proxy](#13-nvidia-cloud-proxy)
    - [NVIDIA proxy: request guards and limits](#nvidia-proxy-request-guards-and-limits)
    - [NVIDIA proxy: key rotation and failover before the first byte](#nvidia-proxy-key-rotation-and-failover-before-the-first-byte)
    - [NVIDIA proxy: relaying the stream to the browser](#nvidia-proxy-relaying-the-stream-to-the-browser)
    - [One model allowlist for the app and the functions](#one-model-allowlist-for-the-app-and-the-functions)

## 1. System overview

Where each part of Starpi runs, which trust boundary it sits behind, and how the frontend modules depend on each other. The browser tab is the trusted zone; Supabase, the model providers, Starpi's server functions (relay, pools, speech and research), the paired local companion on the loopback interface, the optional library publisher, model downloads, search services and speech services are reached across explicit boundaries.

### System context and trust boundaries

The browser tab is the trusted zone. Its main thread runs the shell (main.js boot(), the feature registry and the views), the chat thread and its runner, the AI layer (contract, adapters, transports, router), the workspace client, the source check and the sentence gate, receipts and device signing, voice, Live, research jobs, the encrypted sync and the companion client. Web Workers do the heavy or untrusted work: starpi-ingest parses, chunks, indexes and keeps workspace files (IndexedDB and OPFS), starpi-webllm runs WebLLM on WebGPU, starpi-wasm runs Transformers.js with ONNX Runtime on the processor (up to four threads, as the page is cross-origin isolated), starpi-integrity hashes downloaded model files against `model-lock.json`, and an AudioWorklet (starpi-pcm) turns microphone audio into PCM for Live. Diagrams and HTML or SVG previews render in a sandboxed frame with an opaque origin (render-frame), and a provider's search suggestions in a second one (grounding-frame); neither can read the app's storage. Everything the app keeps lives in per-origin storage: the IndexedDB database `starpi` (conversations, files, vectors, receipts, signing keys, research jobs, benchmarks, model integrity, settings and the key vault), OPFS for large originals, the IndexedDB database `starpi-companion` for the sealed pairing secret, localStorage for preferences, sessionStorage for provider keys of the tab, and the Cache API buckets of WebLLM, Transformers.js and the service worker.

Vercel serves `dist/` with the header set of `scripts/headers.json` (profile `public`): a CSP without inline code, COOP `same-origin`, COEP `require-corp`, CORP, `Origin-Agent-Cluster`, HSTS and a Permissions-Policy. Its stateless functions hold the site's keys and nothing else: the relay forwards a request with the user's own key to a fixed table of provider hosts, the pools answer with a site key from an allowlist of models, the speech routes speak and transcribe with site keys and mint single-use Live tokens, the research step signs the model's tool turns, and health reports booleans. Supabase is reached with the public key plus an anonymous session JWT, so grants and RLS decide what each caller can read or write; it serves the shared library and the encrypted sync rows, and the 2.x plaintext `chat_history` table is only ever deleted from. Provider calls with a key of the user's go straight to the provider (Anthropic, OpenAI, Gemini, OpenRouter) or, for providers that refuse browser calls, through the relay. The paired companion and the user's own server run on the user's machine and are reached over loopback or the LAN, never through the site. The optional library publisher, a command line tool on a machine the operator controls, is the only component that holds the service_role key. Dashed nodes are services outside Starpi's control.

<!-- diagram: system-context-overview -->
```mermaid
flowchart LR
    subgraph device["User device: browser tab on www.starpi.app, cross-origin isolated, CSP enforced"]
        subgraph mainThread["Main thread, src/js"]
            boot["main.js boot(), features/registry.js,<br/>ui/sidebar.js, ui/theme.js, views"]
            thread["chat/thread.js + chat/runner.js<br/>Auto, Free, Grounded, branches,<br/>compare, council, canvas"]
            ai["ai/: contract, adapters, transports,<br/>router, purposes, keys and vault"]
            trust["core/: source check, sentence gate,<br/>receipts; trust/signing.js device key"]
            ws["rag/workspace.js client,<br/>rag/embed-client.js search by meaning"]
            voice["voice/, live/, research/<br/>speech queue takes released units only"]
            sync["sync/: encrypted sync engine,<br/>runs only when switched on"]
            comp["companion/client.js, pair.js<br/>audit head check"]
            sb["supabase.js, lazy supabase-lib.js<br/>public key and anonymous session"]
        end
        subgraph workers["Web Workers and worklet"]
            ingest["starpi-ingest: parse, chunk, BM25,<br/>vectors, files kept in IndexedDB and OPFS"]
            webllm["starpi-webllm: WebLLM on WebGPU"]
            wasm["starpi-wasm: Transformers.js, ONNX Runtime,<br/>up to 4 threads when crossOriginIsolated"]
            integ["starpi-integrity: SHA-256 of model files<br/>against model-lock.json"]
            pcm["starpi-pcm AudioWorklet"]
        end
        frames["render-frame and grounding-frame:<br/>sandboxed, opaque origin, no storage"]
        sw["sw.js: same-origin GET only"]
        subgraph stores["Per-origin storage"]
            idb[("IndexedDB starpi: conversations, nodes, blobs,<br/>docs, chunks, vectors, receipts, signingKeys,<br/>research, bench, modelIntegrity, settings, keyvault")]
            opfs[("OPFS: original files")]
            pairDb[("IndexedDB starpi-companion:<br/>sealed pairing secret")]
            web[("localStorage: preferences, picker value,<br/>2.x keys read once by the migration;<br/>sessionStorage: provider keys of the tab")]
            caches[("Cache API: WebLLM, transformers-cache,<br/>service worker shell and assets")]
        end
    end

    subgraph vercel["Vercel: dist/ with headers.json headers, stateless functions"]
        host["static files: COOP, COEP require-corp, CORP,<br/>CSP script-src self wasm-unsafe-eval"]
        relay["api/relay.js: user's key forwarded once<br/>to a fixed upstream table"]
        pool["api/pool.js, api/models/pool.js:<br/>site keys, model allowlists"]
        speech["api/voice/*: speak, transcribe,<br/>voices, single-use Live token"]
        research["api/research/step.js:<br/>signed tool turns"]
        health["api/health.js: booleans only;<br/>api/chat/nvidia.js for 2.x clients"]
    end

    subgraph supabase["Supabase: grants and RLS decide"]
        auth["Auth: anonymous session,<br/>email one-time code for sync"]
        rest["PostgREST: knowledge tables and RPCs,<br/>chat_sync, chat_sync_keys,<br/>legacy chat_history delete only"]
    end

    subgraph machine["User's machine"]
        companion["starpi-companion on 127.0.0.1:47821:<br/>paired browsers only, sealed vault,<br/>signed audit heads, zero egress by default"]
        ownServer["own Chat Completions server,<br/>local voice server"]
    end

    publisher["library publisher, operator machine:<br/>service_role key, no listener"]

    subgraph third["Third parties outside Starpi control"]
        providers["Anthropic, OpenAI, Gemini, OpenRouter"]
        blocked["xAI, Groq, Mistral, DeepSeek, NVIDIA,<br/>ElevenLabs, Brave, Tavily"]
        live["Gemini Live socket"]
        hosts["Hugging Face, raw.githubusercontent.com"]
        searx["SearXNG, MCP servers the user adds"]
        bspeech["browser speech services"]
    end

    host --> sw --> boot
    boot --> thread --> ai
    thread --> trust
    thread --> ws --> ingest
    ws -.->|"vectors on request"| wasm
    ai -->|"model on this device"| webllm
    ai -->|"processor model"| wasm
    webllm -.-> integ
    wasm -.-> integ
    trust --> frames
    voice --> pcm
    ingest --> idb
    ingest --> opfs
    ai -->|"keys"| web
    ai -->|"vault"| idb
    thread --> idb
    comp --> pairDb
    webllm --> caches
    wasm --> caches
    ai -->|"key in the provider header"| providers
    ai -->|"blocked call, user's key"| relay --> blocked
    ai -->|"no key: site pool"| pool --> blocked
    pool --> providers
    voice -->|"site speech"| speech --> providers
    voice -->|"Live token"| speech
    voice -.->|"WebSocket with the token"| live
    voice -->|"research step"| research --> providers
    ai --> health
    sb --> auth
    sb --> rest
    sync --> sb
    thread -->|"library search"| sb
    comp -->|"loopback, Mode A cookie or Mode B token"| companion
    ai -->|"direct, never through the site"| ownServer
    webllm -.->|"model files after a confirmation"| hosts
    wasm -.->|"pinned revisions"| hosts
    ai -.-> searx
    voice -.-> bspeech
    publisher -->|"service_role, reads public or ownerless rows"| rest

    classDef external stroke-dasharray: 5 5
    class providers,blocked,live,hosts,searx,bspeech external
```

<sub>Sources: [`src/js/main.js`](../src/js/main.js), [`src/js/features/registry.js`](../src/js/features/registry.js), [`src/js/chat/thread.js`](../src/js/chat/thread.js), [`src/js/chat/runner.js`](../src/js/chat/runner.js), [`src/js/ai/catalog/providers.js`](../src/js/ai/catalog/providers.js), [`src/js/ai/transport-select.js`](../src/js/ai/transport-select.js), [`src/js/ai/keys.js`](../src/js/ai/keys.js), [`src/js/store/schema.js`](../src/js/store/schema.js), [`src/js/store/opfs.js`](../src/js/store/opfs.js), [`src/js/companion/pair.js`](../src/js/companion/pair.js), [`src/js/rag/workspace.js`](../src/js/rag/workspace.js), [`src/js/rag/ingest.worker.js`](../src/js/rag/ingest.worker.js), [`src/js/wasm/worker.js`](../src/js/wasm/worker.js), [`src/js/models/integrity.worker.js`](../src/js/models/integrity.worker.js), [`src/js/voice/pcm-worklet.js`](../src/js/voice/pcm-worklet.js), [`src/js/supabase.js`](../src/js/supabase.js), [`src/js/sync/service.js`](../src/js/sync/service.js), [`src/sw.js`](../src/sw.js), [`scripts/headers.json`](../scripts/headers.json), [`scripts/build.mjs`](../scripts/build.mjs), [`api/relay.js`](../api/relay.js), [`api/_lib/relay/upstreams.js`](../api/_lib/relay/upstreams.js), [`api/pool.js`](../api/pool.js), [`api/voice/live-token.js`](../api/voice/live-token.js), [`api/research/step.js`](../api/research/step.js), [`api/health.js`](../api/health.js), [`packages/companion/src/server/http.js`](../packages/companion/src/server/http.js), [`backend/supabase/full_schema.sql`](../backend/supabase/full_schema.sql)</sub>

### What leaves the device: connection state

boot() awaits connect(), which loads the Supabase library on first use (a lazy entry of its own, with the same 12 s deadline as a request) and is safe to call repeatedly: concurrent callers share one attempt. A build the companion serves (profile `companion`) never loads the library and ends offline at once. When navigator.onLine is false, or the library does not load, connect() marks the connection offline without a request. Otherwise ensureSession() reuses a stored session; without one it reads the public auth settings and returns auth_disabled without a sign-in request when anonymous sign-ins are off, returns the timeout error when the settings request timed out, and otherwise calls signInAnonymously(). A probe then reads knowledge_documents for the is_public column; the result sets status, signedIn and hardened, and every change reaches the onConnectionChange listeners of main.js. run() switches a ready connection to offline when a later request fails with a network error or a timeout, and scheduleReconnect() repeats connect() on the online event or after 30 s, doubling up to 5 min. What a state allows: while offline, grounded questions answer from the workspace and registered sources only and knownTitles() returns none. Conversations are never written to Supabase in plaintext (chat-store.js CHAT_SYNC_ENABLED is false); the encrypted sync runs only after the user switched it on with a passphrase, and then it syncs once the connection is ready, a few seconds after a local change, every two minutes while the page is visible, when the browser is online again and when the tab comes back into view. Deleting chats waits for message writes still under way, clears the conversations on the device, deletes the rows a 2.x version may have stored in `chat_history` (skipped only when the connection is ready and canSyncChats() says nothing could have been stored) and, with sync on, writes deletion markers so other browsers delete the chats too.

<!-- diagram: system-context-egress-connection -->
```mermaid
flowchart TD
    boot["main.js boot(): await connect()<br/>concurrent callers share one attempt"]
    prof{"build profile companion?"}
    offLib["status offline at once,<br/>library never loaded, no retry"]
    onlineQ{"navigator.onLine false,<br/>or supabase-lib.js does not load in 12 s?"}
    noReq["status offline, signedIn false,<br/>hardened false"]
    sess{"ensureSession(): stored session?"}
    settingsQ{"GET /auth/v1/settings:<br/>anonymous_users false?"}
    authOff["authError auth_disabled,<br/>no sign-in request"]
    authTimeout["authError timeout,<br/>no sign-in request"]
    signIn["signInAnonymously()"]
    probe{"probe: select id, is_public<br/>from knowledge_documents limit 1"}
    offline["status offline"]
    legacy["status ready, hardened false"]
    hardened["status ready, hardened true"]
    retry["scheduleReconnect(): online event<br/>or 30 s, doubling up to 5 min"]
    boot --> prof
    prof -->|"yes"| offLib
    prof -->|"no"| onlineQ
    onlineQ -->|"yes"| noReq --> retry
    onlineQ -->|"no"| sess
    sess -->|"yes, or getSession fails"| probe
    sess -->|"no"| settingsQ
    settingsQ -->|"yes"| authOff --> probe
    settingsQ -->|"timed out"| authTimeout --> probe
    settingsQ -->|"no, not stated, other failure"| signIn --> probe
    probe -->|"network or timeout"| offline --> retry
    probe -->|"other error"| legacy
    probe -->|"ok"| hardened
    retry -.->|"connect() again"| onlineQ
    runQ{"run(): a later request fails<br/>with network or timeout?"}
    legacy --> runQ
    hardened --> runQ
    runQ -->|"yes: status offline"| retry

    listeners["onConnectionChange listeners of main.js:<br/>renderConnection, renderPrivacyNotice,<br/>refreshSyncStatus; sync/service.js kicks a sync"]
    offline -.-> listeners
    legacy -.-> listeners
    hardened -.-> listeners

    offUse["while offline: grounded questions use the workspace<br/>and registered sources, knownTitles() returns none"]
    offline -.-> offUse
    noReq -.-> offUse

    plain["chat-store.js: CHAT_SYNC_ENABLED false,<br/>conversations never written in plaintext"]
    syncOn{"Settings › Chat sync on,<br/>passphrase opened the sync key?"}
    rows["chat_sync and chat_sync_keys:<br/>ciphertext, opaque row ids, revisions,<br/>owner-only RLS; localOnly turns never included"]
    devOnly[("IndexedDB starpi only")]
    hardened -.-> syncOn
    syncOn -->|"yes, status ready"| rows
    syncOn -->|"no"| devOnly
    plain -.-> devOnly

    del["deleteChatHistory() or deleteSession(sid):<br/>settleWrites, conversations cleared on the device"]
    legacyQ{"status ready and<br/>canSyncChats() false?"}
    legacyDel["deleteOwnChats() or deleteChatSession(sid):<br/>own 2.x chat_history rows, RLS owner only;<br/>a failure is reported as a partial delete"]
    marks["sync on: flush deletion markers,<br/>other browsers delete the chats"]
    del --> legacyQ
    legacyQ -->|"yes: nothing could be stored"| marks
    legacyQ -->|"no, also offline or pending"| legacyDel --> marks
```

<sub>Sources: [`src/js/supabase.js`](../src/js/supabase.js), [`src/js/supabase-lib.js`](../src/js/supabase-lib.js), [`src/js/main.js`](../src/js/main.js), [`src/js/chat-store.js`](../src/js/chat-store.js), [`src/js/sync/service.js`](../src/js/sync/service.js), [`src/js/sync/sync.js`](../src/js/sync/sync.js), [`src/js/chat/thread.js`](../src/js/chat/thread.js), [`backend/supabase/migrations/20261102000000_chat_sync.sql`](../backend/supabase/migrations/20261102000000_chat_sync.sql)</sub>

### What leaves the device: one chat turn

sendQuestion() takes the composer's draft and the picker value, then fixes the route. An explicit mode wins (Free stays free, Grounded stays grounded); a question that must stay on this device (an AI edit of a canvas document from such an answer) goes the free route and is refused with a notice when no model here can answer it; the paired companion follows the mode control alone (Grounded asks it in sources mode, Free and Auto in free mode). Auto asks decideRoute() in ai/hybrid.js, without a model call: a registered classifier can only tighten the route, attached documents mean grounded, images alone stay free, no source at all keeps it free, a phrase or a file name that points at the sources or two words of a library title in a row mean grounded, and otherwise the workspace probe decides (score at least 0.45 with half the terms covered: grounded; at least 0.30: mixed; at least two matched terms either way; anything else free). Without a model the sources are quoted (grounded); with the Web toggle on and a model without its own search, a search API turns the question into web passages unless the question stays on this device. A grounded or mixed turn retrieves (workspace and registered sources always; the library with the question through search_knowledge, else 30 recent documents ranked here; a question asked with the model of this device ranks the library by a query vector made here, else by candidates fetched without the question), stores the question as local-only when it is device-only or used a workspace passage, and builds a fenced context. The runner asks the candidates in order (an explicit pick is one model; Auto takes the user's keys, the site's pools, the own server, then the model loaded here) and moves on only before the first text. Every model that is not on this device gets the history without the local-only turns and their questions. The answer is stored in IndexedDB as local-only when the question was device-only, used the workspace, or was quoted without a model naming a workspace file; questions to and answers of the companion are always local-only. The encrypted sync never takes a local-only turn.

<!-- diagram: system-context-egress-guards -->
```mermaid
flowchart TD
    ask(["sendQuestion(): draft, picker value,<br/>mode Auto, Free or Grounded"])
    held{"options.localOnly:<br/>content that stays here?"}
    refuse(["notice stays_on_device<br/>when no model here answers"])
    compQ{"picker value companion:*?"}
    compRoute["Grounded: sources mode,<br/>Free and Auto: free mode"]
    modeQ{"mode explicit?"}
    decide["decideRoute(), ai/hybrid.js:<br/>classifier only tightens; attachment: grounded;<br/>images only or no sources: free;<br/>phrase, file name, library title: grounded;<br/>probe 0.45 and coverage 0.5: grounded,<br/>0.30: mixed, else free; no model: grounded;<br/>Web toggle + search API: web passages,<br/>not for a device-only question"]
    route{"route?"}
    retrieve["retrieve(): workspace + registered sources<br/>(companion passages by data class)"]
    offlineQ{"connection offline?"}
    devQ{"picker value device<br/>or question held here?"}
    fts["search_knowledge with the question,<br/>first 1,000 chars; no rows: recentKnowledge(30)"]
    vec["libraryHitsByMeaning: query vector made here,<br/>else recentKnowledge(30) without the question"]
    storeQ["storeQuestion: localOnly =<br/>deviceOnly or a workspace passage used"]
    storeF["storeQuestion, free: localOnly = device,<br/>held, or asked of the companion"]
    cands["chatCandidates: explicit pick, or Auto:<br/>user keys, site pools, own server,<br/>loaded device model; held: only models here"]
    hist["shareable(): models not on this device get<br/>the path without localOnly turns and their questions"]
    run["runAnswer: next candidate only<br/>before the first text"]
    subgraph out["Leaves the device"]
        prov["provider direct, or relay with the user's key"]
        pools["site pool, text and images, no tools"]
        srv["own server, direct"]
        cmp["companion on loopback: bare question,<br/>mode and data class"]
        lib["Supabase: question or only a vector"]
        webs["search API: the query"]
    end
    dev["model on this device: nothing leaves"]
    saved[("IndexedDB starpi: answer localOnly when the question<br/>was, a workspace passage was used, or a quote names<br/>a workspace file; companion turns always")]
    syncQ{"encrypted sync on?"}
    synced["record without localOnly turns"]

    ask --> held
    held -->|"yes, no model here"| refuse
    held -->|"yes"| storeF
    held -->|"no"| compQ
    compQ -->|"yes"| compRoute --> cmp
    compQ -->|"no"| modeQ
    modeQ -->|"Free"| storeF
    modeQ -->|"Grounded"| retrieve
    modeQ -->|"Auto"| decide --> route
    route -->|"free"| storeF
    route -->|"mixed or grounded"| retrieve
    decide -.->|"web passages"| webs
    retrieve --> offlineQ
    offlineQ -->|"yes: workspace only"| storeQ
    offlineQ -->|"no"| devQ
    devQ -->|"no"| fts --> lib
    devQ -->|"yes"| vec --> lib
    fts --> storeQ
    vec --> storeQ
    storeQ --> cands
    storeF --> cands
    cands --> hist --> run
    run --> prov
    run --> pools
    run --> srv
    run --> dev
    run --> saved
    cmp --> saved
    saved --> syncQ
    syncQ -->|"yes"| synced
```

<sub>Sources: [`src/js/chat/thread.js`](../src/js/chat/thread.js), [`src/js/chat/runner.js`](../src/js/chat/runner.js), [`src/js/chat/hooks.js`](../src/js/chat/hooks.js), [`src/js/ai/hybrid.js`](../src/js/ai/hybrid.js), [`src/js/rag/hybrid.js`](../src/js/rag/hybrid.js), [`src/js/rag/embed-client.js`](../src/js/rag/embed-client.js), [`src/js/companion/tier.js`](../src/js/companion/tier.js), [`src/js/supabase.js`](../src/js/supabase.js), [`src/js/providers.js`](../src/js/providers.js), [`src/js/sync/payload.js`](../src/js/sync/payload.js)</sub>

### Library publisher trust boundary

The library publisher (section 10) is the only component that holds the service_role key. It runs as a command line tool on a machine the operator controls and opens no port, so there is no request to guard; what it guards are its reads, which the service role would otherwise let reach every row. The browser bundle never talks to it: the browser and the publisher meet only in the database, where RLS decides what the browser sees of the rows the publisher wrote.

<!-- diagram: system-context-publisher -->
```mermaid
flowchart LR
    subgraph op["Operator machine"]
        files[("Text and Markdown files")]
        env[("tools/library-publisher/.env<br/>SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,<br/>PUBLISHER_MODEL_DIR, optional LLM_*")]
        pub["python -m publisher<br/>publish, backfill, list, test-query,<br/>health, fetch-model<br/>no listener"]
        model[("Pinned model files<br/>multilingual-e5-small q8")]
    end
    subgraph supa["Supabase project"]
        rest["PostgREST /rest/v1"]
        rows[("knowledge_documents, knowledge_sections<br/>embedding_384")]
    end
    hf["Hugging Face<br/>pinned revision"]
    llm["Optional chat model<br/>LLM_BASE_URL, publish --structure only"]
    tab["Browser tab<br/>anon key and anonymous session, RLS"]

    files --> pub
    env --> pub
    model --> pub
    hf -.->|"fetch-model, SHA-256 checked"| model
    pub -.->|"--structure"| llm
    pub -->|"service_role key: rpc ingest_document_atomic,<br/>PATCH is_public and embedding_384,<br/>reads limited to is_public or no owner"| rest
    rest --> rows
    tab -->|"search_knowledge, match_knowledge_vector_384,<br/>public and own rows only"| rest

    classDef external stroke-dasharray: 5 5
    class hf,llm external
```

<sub>Sources: [`tools/library-publisher/publisher/cli_supabase.py`](../tools/library-publisher/publisher/cli_supabase.py), [`tools/library-publisher/publisher/config.py`](../tools/library-publisher/publisher/config.py), [`tools/library-publisher/publisher/supabase_service.py`](../tools/library-publisher/publisher/supabase_service.py), [`tools/library-publisher/publisher/model_files.py`](../tools/library-publisher/publisher/model_files.py), [`backend/supabase/full_schema.sql`](../backend/supabase/full_schema.sql)</sub>

### Frontend import graph (1 of 4): main.js and the first load

The numbers in this part come from esbuild's metafile of the production build (`STARPI_META_OUT=<file> npm run build`), not from reading imports by hand. The build bundles 261 inputs under `src/js/` (258 modules and three JSON files: the model catalog snapshot, the role candidates and the model lock), joined by 1,001 static imports and 113 lazy `import()` calls between them; the static graph has no cycles. main.js is the only main-thread entry and imports 27 modules directly. Its static closure, the first load, is 92 modules: the shell, the chat composer and its hooks, the 13 feature modules (each registers what it renders and loads its views later), the model pickers and the device probe, the workspace client, the source check with the English and German language packs, the receipt dialog and the voice entry. Everything else loads on demand: the chat thread and its runner, the AI layer's router, adapters and transports, the conversation store and its 2.x migration, settings views, research, Live, the companion view, the Supabase library, the rendering extras, pdf.js and the French, Spanish, Italian and Turkish language packs. The German pack stays in the first load on purpose: verdicts and the verification of receipts read every pack that a receipt may have been checked with, and `STOPWORDS` is a public export of `@starpi/core`. Every edge below is a static import of main.js; the labels name what main.js calls.

<!-- diagram: frontend-modules-overview -->
```mermaid
flowchart LR
    subgraph g0["Shell: frontend-modules-infrastructure and the views"]
        ui["ui.js<br/>switchTab, onTabOpen, renderConnection,<br/>renderLanguageSwitch, initChatAside"]
        ui__sidebar["ui/sidebar.js<br/>initSidebar, setNavVisible"]
        ui__theme["ui/theme.js<br/>initTheme"]
        ui__kit["ui/kit.js<br/>toast"]
        dialog["dialog.js<br/>openDialog, closeDialog"]
        messages["messages.js<br/>initMessages"]
    end
    subgraph g1["Chat and model choice: frontend-modules-chat"]
        chat["chat.js<br/>initChat, restoreHistory"]
        chat_store["chat-store.js<br/>refreshSyncStatus"]
        providers["providers.js<br/>initProviders: the AI layer when idle"]
        settings["settings.js<br/>initSettings, changeEngine,<br/>renderPrivacyNotice"]
        model_picker["model-picker.js<br/>initModelPicker"]
        engine_ui["engine-ui.js<br/>initEngineUi"]
        rag__citations["rag/citations.js<br/>initCitations"]
    end
    subgraph g2["Feature modules: frontend-modules-views"]
        features__index["features/index.js<br/>mountFeatures: 13 feature modules"]
    end
    subgraph g3["Tabs and views"]
        library["library.js<br/>initLibrary, loadDocuments"]
        graph_tab["graph-tab.js<br/>initGraphTab, graph.js on first open"]
        ingest["ingest.js<br/>initIngest"]
        voice["voice.js<br/>initVoice"]
        bench__bench_ui["bench/bench-ui.js<br/>initBenchUi, refreshDiagnostics"]
    end
    subgraph g4["Trust: frontend-modules-trust"]
        demo["demo.js<br/>initDemo"]
        rag__receipts["rag/receipts.js<br/>initReceipts"]
        core__lang__index["core/lang/index.js<br/>loadShippedLanguages: fr, es, it, tr<br/>after the first paint"]
    end
    subgraph g5["Infrastructure"]
        dom["dom.js<br/>installDelegation, onAction, onChange"]
        i18n__index["i18n/index.js<br/>initI18n, setLocale, onLocaleChange"]
        icons["icons.js<br/>refreshIcons"]
        state["state.js<br/>getAssistant"]
        supabase["supabase.js<br/>connect, onConnectionChange"]
    end
    main["main.js<br/>boot(), registerServiceWorker()"]

    main --> bench__bench_ui
    main --> chat_store
    main --> chat
    main --> demo
    main --> core__lang__index
    main --> dialog
    main --> dom
    main --> engine_ui
    main --> features__index
    main --> graph_tab
    main --> i18n__index
    main --> icons
    main --> ingest
    main --> library
    main --> messages
    main --> model_picker
    main --> rag__citations
    main --> rag__receipts
    main --> providers
    main --> settings
    main --> state
    main --> supabase
    main --> ui
    main --> ui__kit
    main --> ui__sidebar
    main --> ui__theme
    main --> voice
```

<sub>Sources: [`src/js/main.js`](../src/js/main.js), [`scripts/build.mjs`](../scripts/build.mjs)</sub>

### Frontend import graph (2 of 4): the feature modules and what they load when mounted

features/index.js imports the 13 feature modules for their registrations, and main.js mounts them into the shell's 18 mount points (features/registry.js `MOUNT_POINTS`) once at boot; a failing mount is logged and does not stop the others. The feature modules are small and in the first load. What they render or run, the views, the conversation list, the canvas, compare and council panels, research jobs, the sync engine, the Live sheet, the companion view and the trust and tools settings, is imported lazily (dashed) when the feature mounts or is first used. They reach the chat only through its seams (chat/hooks.js, voice/hooks.js), never by editing the thread. The edges are every import of the feature modules except the infrastructure modules (i18n, dom, ui/kit, icons, config, storage, state, store/schema), which frontend-modules-infrastructure counts; the labels name the mount points each one fills.

<!-- diagram: frontend-modules-views -->
```mermaid
flowchart LR
    subgraph g0["Feature modules, in the first load (features/index.js)"]
        features__canvas["features/canvas.js<br/>chat-aside-canvas, chat-aside-compare"]
        features__companion["features/companion.js<br/>tab-companion, companionSettings"]
        features__conversations["features/conversations.js<br/>chat-sidebar"]
        features__live["features/live.js<br/>liveSheet, composerExtras"]
        features__memory["features/memory.js<br/>memorySettings, chatToolbarExtras"]
        features__providers["features/providers.js<br/>providerSettings"]
        features__research["features/research.js<br/>tab-research, chat-aside-research"]
        features__sources["features/sources.js<br/>chat-aside-sources, empty in 3.0"]
        features__sync["features/sync.js<br/>syncSettings"]
        features__tools["features/tools.js<br/>toolSettings"]
        features__trust["features/trust.js<br/>trustSettings"]
        features__voice["features/voice.js<br/>voiceSettings, composerExtras"]
        features__workspace["features/workspace.js<br/>workspaceSettings"]
    end
    subgraph g1["Seams they register with"]
        features__registry["features/registry.js<br/>registerFeature, MOUNT_POINTS"]
        chat__hooks["chat/hooks.js"]
        voice__hooks["voice/hooks.js"]
        code_blocks["code-blocks.js"]
        ui["ui.js"]
        chat_store["chat-store.js"]
        ai__keys["ai/keys.js"]
        rag__workspace["rag/workspace.js"]
        rag__embed_client["rag/embed-client.js"]
        store__quota["store/quota.js"]
        bench__diagnostics["bench/diagnostics.js"]
    end
    subgraph g2["Loaded when a feature mounts or is first used"]
        chat__canvas["chat/canvas.js"]
        chat__compare["chat/compare.js"]
        chat__council_view["chat/council-view.js"]
        chat__thread["chat/thread.js"]
        companion__pair["companion/pair.js"]
        companion__tier["companion/tier.js"]
        companion__view["companion/view.js"]
        chat__sidebar["chat/sidebar.js"]
        live__sheet["live/sheet.js"]
        chat__context["chat/context.js"]
        settings__memory_view["settings/memory-view.js"]
        ai__transport_select["ai/transport-select.js"]
        settings__providers_view["settings/providers-view.js"]
        research__jobs["research/jobs.js"]
        research__deep["research/deep.js"]
        research__runtime["research/runtime.js"]
        research__view["research/view.js"]
        sync__service["sync/service.js"]
        sync__settings_view["sync/settings-view.js"]
        supabase["supabase.js"]
        chat__tools["chat/tools.js"]
        ai__mcp__view["ai/mcp/view.js"]
        trust__settings_view["trust/settings-view.js"]
        trust__model_integrity_view["trust/model-integrity-view.js"]
        voice__settings_view["voice/settings-view.js"]
    end

    features__canvas --> code_blocks
    features__canvas --> chat__hooks
    features__canvas --> ui
    features__canvas --> features__registry
    features__canvas -.-> chat__canvas
    features__canvas -.-> chat__compare
    features__canvas -.-> chat__council_view
    features__canvas -.-> chat__thread
    features__companion --> chat__hooks
    features__companion --> features__registry
    features__companion -.-> companion__pair
    features__companion -.-> companion__tier
    features__companion -.-> companion__view
    features__conversations --> chat_store
    features__conversations --> features__registry
    features__conversations -.-> chat__sidebar
    features__live --> features__registry
    features__live -.-> live__sheet
    features__memory --> chat__hooks
    features__memory --> features__registry
    features__memory -.-> chat__context
    features__memory -.-> settings__memory_view
    features__providers --> ai__keys
    features__providers --> features__registry
    features__providers -.-> ai__transport_select
    features__providers -.-> settings__providers_view
    features__research --> features__registry
    features__research -.-> research__jobs
    features__research -.-> research__deep
    features__research -.-> research__runtime
    features__research -.-> research__view
    features__sources --> features__registry
    features__sync --> features__registry
    features__sync -.-> sync__service
    features__sync -.-> sync__settings_view
    features__sync -.-> supabase
    features__tools --> features__registry
    features__tools -.-> chat__tools
    features__tools -.-> ai__mcp__view
    features__tools -.-> ai__keys
    features__trust --> features__registry
    features__trust -.-> trust__settings_view
    features__trust -.-> trust__model_integrity_view
    features__voice --> features__registry
    features__voice --> voice__hooks
    features__voice -.-> voice__settings_view
    features__workspace --> bench__diagnostics
    features__workspace --> rag__embed_client
    features__workspace --> rag__workspace
    features__workspace --> store__quota
    features__workspace --> features__registry
```

<sub>Sources: [`src/js/features/index.js`](../src/js/features/index.js), [`src/js/features/registry.js`](../src/js/features/registry.js), [`src/js/features/canvas.js`](../src/js/features/canvas.js), [`src/js/features/companion.js`](../src/js/features/companion.js), [`src/js/features/conversations.js`](../src/js/features/conversations.js), [`src/js/features/live.js`](../src/js/features/live.js), [`src/js/features/memory.js`](../src/js/features/memory.js), [`src/js/features/providers.js`](../src/js/features/providers.js), [`src/js/features/research.js`](../src/js/features/research.js), [`src/js/features/sources.js`](../src/js/features/sources.js), [`src/js/features/sync.js`](../src/js/features/sync.js), [`src/js/features/tools.js`](../src/js/features/tools.js), [`src/js/features/trust.js`](../src/js/features/trust.js), [`src/js/features/voice.js`](../src/js/features/voice.js), [`src/js/features/workspace.js`](../src/js/features/workspace.js)</sub>

### Frontend import graph (3 of 4): chat thread and AI layer

chat.js is in the first load and imports chat/thread.js lazily, so the thread (97 KiB) and the AI layer behind it load after the first paint. The thread imports the runner, the conversation store and tree, the composer and attachments, the answer labels, Auto's route decision (ai/hybrid.js) and the context packs (ai/context-pack.js), the retrieval and citation modules, the source check's view and receipts, the web check and the on-device engine; it reaches the router, the OCR hook, the benchmark rates, the sentence gate and the model choices lazily. The runner installs the AI layer (adapters, the transport resolver, the router's world) and asks ai/index.js complete(), which drives one adapter over one transport (ai/stream.js, ai/transport.js). providers.js keeps the state of keys, pools, the own server and the companion, and loads the runner when the layer is first needed. The edges are every import of chat.js, chat/thread.js, chat/runner.js, providers.js, ai/index.js and ai/router.js, without the infrastructure modules; section 14 describes the layer itself.

<!-- diagram: frontend-modules-chat -->
```mermaid
flowchart LR
    subgraph g0["Chat thread"]
        chat["chat.js"]
        chat__thread["chat/thread.js"]
        chat__runner["chat/runner.js"]
        chat__hooks["chat/hooks.js"]
        chat__store["chat/store.js"]
        chat__tree["chat/tree.js"]
        chat__composer["chat/composer.js"]
        chat__actions["chat/actions.js"]
        chat__attachments["chat/attachments.js"]
        chat__answer_labels["chat/answer-labels.js"]
        chat__image_view["chat/image-view.js"]
        chat__mode_control["chat/mode-control.js"]
        chat_export["chat-export.js"]
        chat_store["chat-store.js"]
        chat_stream["chat-stream.js"]
    end
    subgraph g1["AI layer"]
        providers["providers.js"]
        ai__index["ai/index.js"]
        ai__router["ai/router.js"]
        ai__purposes["ai/purposes.js"]
        ai__roles["ai/roles.js"]
        ai__wheel["ai/wheel.js"]
        ai__contract["ai/contract.js"]
        ai__stream["ai/stream.js"]
        ai__sse["ai/sse.js"]
        ai__stop_reason["ai/stop-reason.js"]
        ai__transport["ai/transport.js"]
        ai__transport_select["ai/transport-select.js"]
        ai__errors["ai/errors.js"]
        ai__keys["ai/keys.js"]
        ai__thinking["ai/thinking.js"]
        ai__model_selection["ai/model-selection.js"]
        ai__health_client["ai/health-client.js"]
        ai__hybrid["ai/hybrid.js"]
        ai__context_pack["ai/context-pack.js"]
        ai__catalog__models["ai/catalog/models.js"]
        ai__catalog__pools["ai/catalog/pools.js"]
        ai__catalog__providers["ai/catalog/providers.js"]
        ai__adapters__index["ai/adapters/index.js"]
        ai__adapters__companion["ai/adapters/companion.js"]
        ai__quirks__local["ai/quirks/local.js"]
    end
    subgraph g2["Retrieval, prompts and answers"]
        retrieval["retrieval.js"]
        synthesizer["synthesizer.js"]
        prompts["prompts.js"]
        rag__citations["rag/citations.js"]
        rag__workspace["rag/workspace.js"]
        rag__embed_client["rag/embed-client.js"]
        rag__web_check["rag/web-check.js"]
        rag__ocr_hook["rag/ocr-hook.js"]
        supabase["supabase.js"]
    end
    subgraph g3["Trust"]
        core__grounding["core/grounding.js"]
        core__gate["core/gate.js"]
        rag__grounding_view["rag/grounding-view.js"]
        rag__receipts["rag/receipts.js"]
    end
    subgraph g4["Engines and models"]
        webgpu__engine["webgpu/engine.js"]
        webgpu__models["webgpu/models.js"]
        engine_ui["engine-ui.js"]
        models__bench_rates["models/bench-rates.js"]
        models__choices["models/choices.js"]
        models__nvidia_catalog["models/nvidia-catalog.js"]
        models__wasm_catalog["models/wasm-catalog.js"]
    end
    subgraph g5["Features the thread calls"]
        features__voice["features/voice.js"]
        features__research["features/research.js"]
    end

    chat --> chat_store
    chat --> chat__actions
    chat --> chat__composer
    chat --> chat__hooks
    chat --> chat__mode_control
    chat --> features__research
    chat --> features__voice
    chat --> providers
    chat -.-> chat__thread
    chat -.-> chat_export
    chat__thread --> chat_store
    chat__thread --> chat_stream
    chat__thread --> core__grounding
    chat__thread --> engine_ui
    chat__thread --> providers
    chat__thread --> prompts
    chat__thread --> rag__citations
    chat__thread --> rag__embed_client
    chat__thread --> rag__grounding_view
    chat__thread --> rag__receipts
    chat__thread --> rag__web_check
    chat__thread --> rag__workspace
    chat__thread --> retrieval
    chat__thread --> supabase
    chat__thread --> synthesizer
    chat__thread --> webgpu__engine
    chat__thread --> webgpu__models
    chat__thread --> ai__thinking
    chat__thread --> ai__context_pack
    chat__thread --> ai__hybrid
    chat__thread --> ai__keys
    chat__thread --> features__voice
    chat__thread --> chat__actions
    chat__thread --> ai__adapters__companion
    chat__thread --> chat__answer_labels
    chat__thread --> chat__attachments
    chat__thread --> chat__composer
    chat__thread --> chat__image_view
    chat__thread --> chat__hooks
    chat__thread --> chat__runner
    chat__thread --> chat__tree
    chat__thread -.-> chat__store
    chat__thread -.-> ai__router
    chat__thread -.-> rag__ocr_hook
    chat__thread -.-> models__bench_rates
    chat__thread -.-> core__gate
    chat__thread -.-> models__choices
    chat__runner --> ai__adapters__index
    chat__runner --> ai__catalog__models
    chat__runner --> ai__catalog__pools
    chat__runner --> ai__catalog__providers
    chat__runner --> ai__errors
    chat__runner --> ai__health_client
    chat__runner --> ai__index
    chat__runner --> ai__keys
    chat__runner --> ai__model_selection
    chat__runner --> ai__quirks__local
    chat__runner --> ai__router
    chat__runner --> ai__transport_select
    chat__runner --> ai__wheel
    chat__runner --> providers
    chat__runner --> webgpu__engine
    providers --> ai__catalog__providers
    providers --> ai__catalog__pools
    providers --> ai__keys
    providers --> models__nvidia_catalog
    providers --> models__wasm_catalog
    providers --> webgpu__models
    providers -.-> chat__runner
    ai__index --> ai__contract
    ai__index --> ai__errors
    ai__index --> ai__stream
    ai__index --> ai__stop_reason
    ai__index --> ai__sse
    ai__index --> ai__transport
    ai__router --> ai__catalog__models
    ai__router --> ai__contract
    ai__router --> ai__health_client
    ai__router --> ai__index
    ai__router --> ai__model_selection
    ai__router --> ai__purposes
    ai__router --> ai__roles
    ai__router --> ai__thinking
    ai__router --> ai__wheel
    ai__router -.-> synthesizer
```

<sub>Sources: [`src/js/chat.js`](../src/js/chat.js), [`src/js/chat/thread.js`](../src/js/chat/thread.js), [`src/js/chat/runner.js`](../src/js/chat/runner.js), [`src/js/providers.js`](../src/js/providers.js), [`src/js/ai/index.js`](../src/js/ai/index.js), [`src/js/ai/router.js`](../src/js/ai/router.js)</sub>

### Frontend import graph (4 of 4): source check, sentence gate, receipts and core/

The modules of core/ are the code `@starpi/core` publishes: the source check (labels, sentences, facts, negations, bindings, relations and grounding), the sentence gate (canonical text, release units, spoken digits and the gate), and receipts (hashes, the Merkle tree, signatures and the receipt format), plus the language packs. core/ imports nothing from the app except rag/bm25.js and rag/chunker.js, which the ingestion worker shares, so the same files run in the page, in the worker and in Node. core/lang/index.js imports the English and German packs statically and the four others with `import()`; loadShippedLanguages() (main.js, after the first paint) and a receipt that names one of them load the rest. The app modules on the left use core/: rag/grounding-view.js renders the source check, rag/receipts.js builds and verifies receipts (core/receipt.js and trust/signing.js lazily, when a receipt is opened), rag/web-check.js and chat/answer-labels.js check and label web and mixed answers, demo.js runs the prepared check, and retrieval.js and synthesizer.js label excerpts. The edges are every import among these 35 modules.

<!-- diagram: frontend-modules-trust -->
```mermaid
flowchart LR
    subgraph g0["App modules"]
        demo["demo.js"]
        synthesizer["synthesizer.js"]
        retrieval["retrieval.js"]
        rag__citations["rag/citations.js"]
        rag__grounding_view["rag/grounding-view.js"]
        rag__receipts["rag/receipts.js"]
        rag__web_check["rag/web-check.js"]
        chat__answer_labels["chat/answer-labels.js"]
        trust__signing["trust/signing.js"]
    end
    subgraph g1["core/: source check"]
        core__labels["core/labels.js"]
        core__sentences["core/sentences.js"]
        core__facts["core/facts.js"]
        core__entail["core/entail.js"]
        core__binding["core/binding.js"]
        core__polarity["core/polarity.js"]
        core__relations["core/relations.js"]
        core__grounding["core/grounding.js"]
        core__number_words["core/number-words.js"]
    end
    subgraph g2["core/: sentence gate"]
        core__canonical["core/canonical.js"]
        core__release["core/release.js"]
        core__spoken["core/spoken.js"]
        core__gate["core/gate.js"]
    end
    subgraph g3["core/: receipts"]
        core__hash["core/hash.js"]
        core__merkle["core/merkle.js"]
        core__signature["core/signature.js"]
        core__receipt["core/receipt.js"]
    end
    subgraph g4["core/lang: en and de in the first load, fr, es, it, tr lazy"]
        core__lang__index["core/lang/index.js"]
        core__lang__en["core/lang/en.js"]
        core__lang__de["core/lang/de.js"]
        core__lang__fr["core/lang/fr.js"]
        core__lang__es["core/lang/es.js"]
        core__lang__it["core/lang/it.js"]
        core__lang__tr["core/lang/tr.js"]
    end
    subgraph g5["Shared with the ingestion worker"]
        rag__bm25["rag/bm25.js"]
        rag__chunker["rag/chunker.js"]
    end

    demo --> rag__citations
    demo --> rag__grounding_view
    demo --> retrieval
    synthesizer --> core__sentences
    synthesizer --> retrieval
    retrieval --> core__labels
    retrieval --> core__sentences
    rag__citations --> retrieval
    rag__grounding_view --> core__entail
    rag__grounding_view --> core__grounding
    rag__grounding_view --> core__labels
    rag__grounding_view --> rag__citations
    rag__receipts --> core__grounding
    rag__receipts -.-> core__receipt
    rag__receipts -.-> trust__signing
    rag__web_check --> core__gate
    rag__web_check --> core__grounding
    rag__web_check --> core__labels
    chat__answer_labels --> core__grounding
    chat__answer_labels --> rag__grounding_view
    trust__signing --> core__receipt
    trust__signing --> core__signature
    core__sentences --> core__lang__index
    core__facts --> rag__bm25
    core__facts --> core__lang__index
    core__facts --> core__labels
    core__entail --> core__facts
    core__entail --> core__sentences
    core__binding --> core__facts
    core__binding --> rag__bm25
    core__binding --> core__sentences
    core__polarity --> core__facts
    core__polarity --> core__lang__index
    core__polarity --> core__sentences
    core__relations --> core__facts
    core__relations --> core__sentences
    core__grounding --> core__facts
    core__grounding --> rag__bm25
    core__grounding --> core__binding
    core__grounding --> core__polarity
    core__grounding --> core__labels
    core__grounding --> core__relations
    core__grounding --> core__sentences
    core__canonical --> core__lang__index
    core__number_words --> core__facts
    core__number_words --> core__lang__index
    core__release --> core__labels
    core__release --> core__sentences
    core__spoken --> core__facts
    core__spoken --> core__lang__index
    core__spoken --> core__number_words
    core__gate --> core__canonical
    core__gate --> core__facts
    core__gate --> core__labels
    core__gate --> core__lang__index
    core__gate --> core__number_words
    core__gate --> core__release
    core__gate --> core__spoken
    core__merkle --> core__hash
    core__signature --> core__hash
    core__receipt --> rag__chunker
    core__receipt --> core__facts
    core__receipt --> core__grounding
    core__receipt --> core__hash
    core__receipt --> core__merkle
    core__receipt --> core__signature
    core__lang__index --> core__lang__de
    core__lang__index --> core__lang__en
    core__lang__index -.-> core__lang__fr
    core__lang__index -.-> core__lang__es
    core__lang__index -.-> core__lang__it
    core__lang__index -.-> core__lang__tr
    rag__bm25 --> core__lang__index
```

<sub>Sources: [`src/js/core/grounding.js`](../src/js/core/grounding.js), [`src/js/core/gate.js`](../src/js/core/gate.js), [`src/js/core/receipt.js`](../src/js/core/receipt.js), [`src/js/core/lang/index.js`](../src/js/core/lang/index.js), [`src/js/rag/grounding-view.js`](../src/js/rag/grounding-view.js), [`src/js/rag/receipts.js`](../src/js/rag/receipts.js), [`src/js/rag/web-check.js`](../src/js/rag/web-check.js), [`src/js/chat/answer-labels.js`](../src/js/chat/answer-labels.js), [`src/js/trust/signing.js`](../src/js/trust/signing.js), [`src/js/demo.js`](../src/js/demo.js), [`packages/core/src/index.js`](../packages/core/src/index.js)</sub>

### Shared infrastructure modules, their importers and npm packages

Nine modules are imported from almost everywhere, and the four diagrams above leave them out. The counts are static importers among the 261 inputs, by area. i18n/index.js also imports the English dictionaries (`src/locales/index.js`: the root file and every namespace in English, the fallback for every key); the other languages are lazy chunks of their own, one per root file and namespace. Only six npm packages reach the main thread: lucide (icons.js) and marked with DOMPurify (render.js) in the first load; @anthropic-ai/sdk (the Anthropic adapter), @mlc-ai/web-llm (webgpu/engine.js) and pdfjs-dist (rag/parser.js, inside the ingestion worker) by `import()`; @supabase/supabase-js through the lazy entry supabase-lib.js, and highlight.js, KaTeX and a second DOMPurify profile through the lazy entry render-extras.js. @huggingface/transformers runs only in the processor worker, and mermaid only in the sandboxed render frame (a classic bundle of public/render-frame.js, outside this graph).

<!-- diagram: frontend-modules-infrastructure -->
```mermaid
flowchart LR
    subgraph infra["Infrastructure modules: static importers by area"]
        i18n["i18n/index.js: 66<br/>top level 17, chat 15, voice 7, features 4,<br/>rag 3, ai 3, ui 3, bench 3, others 11"]
        dom["dom.js: 43<br/>top level 15, chat 8, voice 3, ui 3, bench 3, others 11"]
        kit["ui/kit.js: 35<br/>chat 10, voice 5, top level 4, others 16"]
        icons["icons.js: 32<br/>chat 12, top level 9, rag 3, features 3, others 5"]
        config["config.js: 22<br/>top level 9, chat 6, others 7"]
        storage["storage.js: 22<br/>ai 8, top level 3, others 11"]
        schema["store/schema.js: 17<br/>chat 5, models 4, ai 2, rag 2, others 4"]
        state["state.js: 16<br/>top level 7, chat 5, others 4"]
        render["render.js: 14<br/>top level 7, chat 6, research 1"]
    end
    subgraph pkgs["npm packages on the main thread"]
        lucide["lucide"]
        marked["marked"]
        purify["dompurify"]
    end
    subgraph lazy["Lazy entries and lazy packages"]
        sblib["supabase-lib.js: @supabase/supabase-js"]
        extras["render-extras.js: highlight.js, katex, dompurify"]
        sdk["ai/adapters/anthropic.js: @anthropic-ai/sdk"]
        web["webgpu/engine.js: @mlc-ai/web-llm"]
        pdf["rag/parser.js: pdfjs-dist, in the ingestion worker"]
    end
    locales[("src/locales: English in the bundle,<br/>other languages lazy, per root and namespace")]
    idb["store/idb.js"]
    icons --> lucide
    render --> marked
    render --> purify
    render -.->|"import() of __STARPI_RENDER_EXTRAS_URL__"| extras
    kit --> icons
    kit --> i18n
    dom --> icons
    render --> i18n
    state --> config
    state --> storage
    schema --> idb
    i18n --> locales
```

<sub>Sources: [`src/js/i18n/index.js`](../src/js/i18n/index.js), [`src/js/dom.js`](../src/js/dom.js), [`src/js/ui/kit.js`](../src/js/ui/kit.js), [`src/js/icons.js`](../src/js/icons.js), [`src/js/config.js`](../src/js/config.js), [`src/js/storage.js`](../src/js/storage.js), [`src/js/store/schema.js`](../src/js/store/schema.js), [`src/js/state.js`](../src/js/state.js), [`src/js/render.js`](../src/js/render.js), [`src/js/render-extras.js`](../src/js/render-extras.js), [`src/js/supabase-lib.js`](../src/js/supabase-lib.js), [`scripts/build.mjs`](../scripts/build.mjs)</sub>

### Bundle entry points, Web Workers and lazy imports

scripts/build.mjs bundles eight module entries with esbuild (`splitting: true`): main.js, the four workers (webgpu/worker.js, rag/ingest.worker.js, wasm/worker.js, models/integrity.worker.js), the PCM AudioWorklet, the Supabase library (supabase-lib.js) and the rendering extras (render-extras.js), plus the CSS entry. Classic scripts are built apart: theme-boot.js, render-blocking in `<head>` so the theme applies before the first paint; public/render-frame.js and public/grounding-frame.js, one file each because a sandboxed frame has an opaque origin and loads only its own exact-path script (the frame bundle's licences are checked, and mermaid is listed in the SBOM as shipped); and sw.js, written with the build version and the precache list. Nothing imports a worker: the code that needs one starts it from a URL the build writes into a placeholder (`__STARPI_*_URL__`), and the build bundles again until those URLs match the outputs. The processor worker is started for three reasons: a processor (WASM) model (webgpu/engine.js), search by meaning (rag/embed-client.js) and the on-device second opinion (wasm/nli.js). A build plugin maps onnxruntime-web/webgpu and onnxruntime-common to onnxruntime-web/wasm, so one ONNX Runtime without `new Function` ships, and its binary is copied to a hashed `/assets` URL. The service worker precaches the page, the CSS, main.js and its static chunks, the ingestion worker, the Latin font and the public files; the rest is cached on first use. Dashed edges are worker starts, the worklet, lazy `import()` calls (grouped by the area they load) and fetches. scripts/build-core.mjs builds `@starpi/core` (packages/core/src/index.js, scripts/verify-receipt.mjs, scripts/ground.mjs and scripts/gate.mjs) apart from the app.

<!-- diagram: frontend-modules-workers -->
```mermaid
flowchart TD
    subgraph classic["Classic scripts"]
        themeboot["theme-boot.js in head:<br/>theme before the first paint"]
        rframe["public/render-frame.js: mermaid, previews,<br/>sandboxed frame, connect-src none"]
        gframe["public/grounding-frame.js:<br/>search suggestions, sandboxed frame"]
        sw["src/sw.js to dist/sw.js:<br/>version, precache list"]
    end
    subgraph mainEntry["entry main: src/js/main.js, 92 modules in the first load"]
        main["main.js"]
        engine["webgpu/engine.js"]
        workspace["rag/workspace.js"]
        embed["rag/embed-client.js"]
        nli["wasm/nli.js, lazy"]
        integrity["models/integrity.js, lazy"]
        capture["voice/capture.js"]
        render["render.js"]
        sbmod["supabase.js"]
        langs["core/lang/index.js"]
    end
    subgraph lazyAreas["Lazy chunks of the main entry"]
        lzChat["chat/thread.js, runner, store, migrate-v1,<br/>canvas, compare, council, context, tools"]
        lzAi["ai/router.js, purposes, adapters, search,<br/>@anthropic-ai/sdk"]
        lzFeat["settings, sync, research, Live, companion,<br/>trust and tools views"]
        lzLang["core/lang fr, es, it, tr;<br/>locale roots and namespaces"]
        lzLock["models/model-lock.json"]
    end
    subgraph ingestEntry["entry ingest-worker: Worker starpi-ingest"]
        iw["rag/ingest.worker.js, workspace-core.js,<br/>store/schema.js, core/lang/index.js"]
        parser["rag/parser.js, rag/formats/*"]
        pdf["pdfjs-dist legacy build"]
    end
    subgraph llmEntry["entry webllm-worker: Worker starpi-webllm"]
        ww["webgpu/worker.js: @mlc-ai/web-llm"]
    end
    subgraph wasmEntry["entry wasm-worker: Worker starpi-wasm"]
        wsw["wasm/worker.js: @huggingface/transformers,<br/>models/wasm-catalog.js, embed-catalog.js"]
    end
    subgraph intEntry["entry integrity-worker: Worker starpi-integrity"]
        iwk["models/integrity.worker.js,<br/>integrity-hash.js"]
    end
    pcm["entry pcm-worklet: AudioWorklet starpi-pcm"]
    sblib["entry supabase: supabase-lib.js,<br/>not precached"]
    extras["entry render-extras: highlight.js, KaTeX,<br/>second sanitizer"]
    ort[("/assets/ort-wasm-simd-threaded-hash.wasm")]
    webllmPkg["@mlc-ai/web-llm chunk"]

    main -.->|"serviceWorker.register"| sw
    main --> engine
    main --> workspace
    main --> render
    main --> sbmod
    main --> langs
    main -.-> lzChat
    lzChat -.-> lzAi
    main -.-> lzFeat
    langs -.-> lzLang
    workspace -.->|"new Worker"| iw
    iw --> parser
    parser -.->|"import()"| pdf
    engine -.->|"new Worker: WebGPU preset"| ww
    engine -.->|"new Worker: processor model"| wsw
    engine -.->|"import() in loadWebLLM"| webllmPkg
    ww --> webllmPkg
    embed -.->|"new Worker: query and file vectors"| wsw
    nli -.->|"new Worker: second opinion"| wsw
    wsw -.->|"fetched on first load"| ort
    engine -.-> integrity
    embed -.-> integrity
    nli -.-> integrity
    integrity -.->|"new Worker"| iwk
    integrity -.-> lzLock
    capture -.->|"audioWorklet.addModule"| pcm
    sbmod -.->|"import() with a 12 s deadline"| sblib
    render -.->|"import() for highlighting and math"| extras
```

<sub>Sources: [`scripts/build.mjs`](../scripts/build.mjs), [`scripts/build-core.mjs`](../scripts/build-core.mjs), [`src/js/main.js`](../src/js/main.js), [`src/js/theme-boot.js`](../src/js/theme-boot.js), [`src/js/webgpu/engine.js`](../src/js/webgpu/engine.js), [`src/js/rag/workspace.js`](../src/js/rag/workspace.js), [`src/js/rag/embed-client.js`](../src/js/rag/embed-client.js), [`src/js/wasm/nli.js`](../src/js/wasm/nli.js), [`src/js/models/integrity.js`](../src/js/models/integrity.js), [`src/js/voice/capture.js`](../src/js/voice/capture.js), [`src/js/render.js`](../src/js/render.js), [`src/js/supabase.js`](../src/js/supabase.js), [`src/js/core/lang/index.js`](../src/js/core/lang/index.js), [`src/js/rag/ingest.worker.js`](../src/js/rag/ingest.worker.js), [`src/js/webgpu/worker.js`](../src/js/webgpu/worker.js), [`src/js/wasm/worker.js`](../src/js/wasm/worker.js), [`src/js/models/integrity.worker.js`](../src/js/models/integrity.worker.js), [`src/js/voice/pcm-worklet.js`](../src/js/voice/pcm-worklet.js), [`public/render-frame.js`](../public/render-frame.js), [`public/grounding-frame.js`](../public/grounding-frame.js), [`src/sw.js`](../src/sw.js)</sub>

## 2. Boot and settings

What happens between the first byte of `index.html` and a usable chat, how the stored model choice is applied without a download, how the conversation store opens (with the one-time move of 2.x data), and how settings, keys and the vault, key tests and the deletion of the chat history work.

### boot(): module start-up order

theme-boot.js, a classic script in `<head>`, applies the stored theme (system, light or dark) before the first paint. main.js boot() then runs initI18n first, so the stored language (or English) is applied before any module renders text; a stored language other than English has its dictionary loaded before main.js runs. It installs the delegated click and change dispatcher and builds the shell: initTheme, initSidebar (a rail that collapses, a drawer on phones), renderLanguageSwitch (the six-language select that replaces the static EN/DE buttons of the pre-boot markup) and initChatAside (the chat side panel). It registers switch-tab and set-locale, the lazy onTabOpen hooks of the library and the diagnostics tab, and runs the init functions in order: initMessages, initProviders (which sets up the AI layer once the page is idle and again whenever keys, pools or the own server change), initSettings, initModelPicker (after the settings, so the pickers show the stored choice first and the device's groups later), initEngineUi, initChat, initLibrary, initIngest, initGraphTab, initVoice, initBenchUi, initCitations, initDemo and initReceipts. mountFeatures() then mounts every feature registration into its mount point (not awaited; a failing mount is logged). refreshIcons, detectAndDisplayDevice and registerServiceWorker follow, and loadShippedLanguages() loads the French, Spanish, Italian and Turkish packs of the source check after the first paint. boot() subscribes to onConnectionChange before connect(), so later reconnects reach the same listener (renderConnection, renderPrivacyNotice, refreshSyncStatus). changeEngine(getAssistant(), interactive false) is started with void and never downloads; connect() and restoreHistory() are awaited in sequence. A throw inside boot() skips the remaining steps, and reportUnexpected only logs it.

<!-- diagram: boot-sequence-overview -->
```mermaid
sequenceDiagram
    autonumber
    participant Head as theme-boot.js in head
    participant Main as main.js boot()
    participant Shell as i18n, dom.js, ui/theme.js,<br/>ui/sidebar.js, ui.js
    participant Init as init functions
    participant Feat as features/registry.js
    participant Lang as core/lang/index.js
    participant Set as settings.js
    participant Sb as supabase.js
    participant Chat as chat.js

    Head->>Head: stored theme applied before the first paint
    Main->>Shell: initI18n(), installDelegation()
    Main->>Shell: initTheme(), initSidebar(), renderLanguageSwitch(), initChatAside()
    Main->>Shell: onAction switch-tab, set-locale, onTabOpen library and bench
    Main->>Init: initMessages, initProviders (AI layer when idle),<br/>initSettings, initModelPicker, initEngineUi, initChat
    Main->>Init: initLibrary, initIngest, initGraphTab, initVoice,<br/>initBenchUi, initCitations, initDemo, initReceipts
    Main-)Feat: mountFeatures(shell services), not awaited
    Note over Feat: every registration renders into its mount point,<br/>a failing mount is logged and the others go on
    Main->>Shell: refreshIcons(), detectAndDisplayDevice()
    Main->>Main: registerServiceWorker(): register /sw.js on load,<br/>compare build-manifest.json on controllerchange
    Main-)Lang: loadShippedLanguages(): fr, es, it, tr after the first paint
    Main->>Sb: onConnectionChange(renderConnection,<br/>renderPrivacyNotice, refreshSyncStatus)
    Main-)Set: changeEngine(getAssistant(), interactive false)
    Note over Set: cached model only, never a download,<br/>see boot-sequence-engine-restore
    Main->>Sb: await connect()
    Sb-->>Main: connection state
    Main->>Shell: renderConnection(state)
    Main->>Chat: await restoreHistory()
    Note over Chat: opens the conversation store and shows<br/>the current conversation, see boot-sequence-conversation-store
```

<sub>Sources: [`src/js/main.js`](../src/js/main.js), [`src/js/theme-boot.js`](../src/js/theme-boot.js), [`src/js/ui/theme.js`](../src/js/ui/theme.js), [`src/js/ui/sidebar.js`](../src/js/ui/sidebar.js), [`src/js/ui.js`](../src/js/ui.js), [`src/js/i18n/index.js`](../src/js/i18n/index.js), [`src/js/dom.js`](../src/js/dom.js), [`src/js/providers.js`](../src/js/providers.js), [`src/js/features/registry.js`](../src/js/features/registry.js), [`src/js/core/lang/index.js`](../src/js/core/lang/index.js), [`src/js/settings.js`](../src/js/settings.js), [`src/js/supabase.js`](../src/js/supabase.js), [`src/js/chat.js`](../src/js/chat.js)</sub>

### Boot-time changeEngine: cached model only, never a download

state.js has already read the stored picker value (`starpi_assistant_v1`) when the module loaded; a profile of 2.x without one gets it once from `starpi_compute_mode` (`council` becomes `auto`, `client` becomes `device`, `local` becomes `local:*`, `nvidia` becomes `nvidia:<stored model>`), and the normalised values are written back. At boot changeEngine applies that value with interactive false. parsePickerValue (models/choices.js) accepts `auto`, `device`, an on-device preset (`webgpu:<key>`, `wasm:<key>`), `local:*`, `companion:starpi-core`, and `<provider>:<model>` for a known provider (an NVIDIA model only from its allowlist); anything else leaves the pickers on the stored choice. For `device`, startLocalEngine calls loadModel with onlyIfCached true and no confirmDownload callback: the device probe (high-performance adapter, 10 s deadline) and chooseModel (the stored preference; `auto` takes the benchmark history into account and picks a processor model without WebGPU) decide the model, and a model whose files are missing resolves false before WebLLM is imported or a worker starts. A cached model has its stored files checked against `model-lock.json` before a runtime reads them (section 5), then loads; a model that is only partly cached resolves false with status idle. In no case is model data downloaded. A failure rejects with an EngineError that engine-ui.js turns into a notice. `local:*` probes the own server's model list (GET /v1/models, 4 s) and shows the result in the engine dot and the status line. Every other value only shows whether the model can be reached now (renderReach: a key, a pool with keys, a paired companion) without a request.

<!-- diagram: boot-sequence-engine-restore -->
```mermaid
sequenceDiagram
    autonumber
    participant Main as main.js boot()
    participant St as state.js
    participant Set as settings.js changeEngine
    participant Ch as models/choices.js
    participant EUI as engine-ui.js
    participant Eng as webgpu/engine.js
    participant Int as models/integrity.js
    participant Prov as providers.js
    participant UI as ui.js

    Note over St: at module load: starpi_assistant_v1, or once from the 2.x<br/>starpi_compute_mode (council auto, client device, local local:*,<br/>nvidia nvidia:model), normalised values written back
    Main->>Set: changeEngine(getAssistant(), interactive false)
    Set->>Ch: parsePickerValue(value, stored NVIDIA model)
    alt not a valid value
        Set->>Set: syncPickerValue(), false
    else valid
        Set->>St: setAssistant(preference or assistant)
        Set->>Set: syncPickerValue(), renderPrivacyNotice()
        Set->>EUI: renderEngineState(getEngineState())
        alt assistant is device
            alt engine.isReady()
                Set->>UI: setEngineDot(ok)
            else
                Set->>EUI: startLocalEngine(interactive false)
                EUI->>Eng: loadModel(preference, benchmark history, onlyIfCached true)
                Eng->>Eng: probe within 10 s, chooseModel(hw, preference, history)
                alt WebGPU preset without WebGPU
                    Eng-->>EUI: rejects EngineError unsupported or no-adapter
                    EUI->>UI: notice engine.notice_unavailable_title
                else files missing: certainlyNotCached or wasmCacheStatus not full
                    Eng-->>EUI: false, no import, no worker
                else cached
                    Eng->>Eng: teardown(), status loading
                    Eng->>Int: checkModelFiles before a runtime reads them
                    alt a stored file does not match model-lock.json
                        Int-->>Eng: file deleted, EngineError integrity
                        Eng-->>EUI: rejects, status error, notice
                    else WebGPU model only partly cached (hasModelInCache false)
                        Eng-->>EUI: false, status idle
                    else
                        Eng->>Eng: new Worker starpi-wasm or starpi-webllm, load from the cache
                        Eng-->>EUI: true, status ready, no ready notice
                    end
                end
                opt not loaded and status idle
                    Set->>UI: setEngineDot(off)
                end
            end
        else assistant is local:*
            Set->>UI: setEngineDot(busy)
            Set->>Prov: probeLocalServer(getLlmUrl()): GET /v1/models, 4 s
            Prov-->>Set: reachable, model ids kept per server
            Set->>UI: setEngineDot(ok or warn), status.ready or status.server_unreachable
        else auto, a provider or pool model, or the companion
            Set->>Set: renderReach(): destinationOf(value) from routeOf(provider)
            Set->>UI: setEngineDot(ok, or off when nothing can answer)
        end
    end
    Set-->>Main: stored flag, discarded (void)
```

<sub>Sources: [`src/js/main.js`](../src/js/main.js), [`src/js/state.js`](../src/js/state.js), [`src/js/config.js`](../src/js/config.js), [`src/js/settings.js`](../src/js/settings.js), [`src/js/models/choices.js`](../src/js/models/choices.js), [`src/js/engine-ui.js`](../src/js/engine-ui.js), [`src/js/webgpu/engine.js`](../src/js/webgpu/engine.js), [`src/js/models/integrity.js`](../src/js/models/integrity.js), [`src/js/wasm/client.js`](../src/js/wasm/client.js), [`src/js/providers.js`](../src/js/providers.js), [`src/js/ui.js`](../src/js/ui.js)</sub>

### Opening the conversation store

restoreHistory() loads the chat thread (chat/thread.js, a lazy chunk) and shows the current conversation; the chat session id in `starpi_chat_session_id` is the id of a conversation. The thread asks chat-store.js for the store, which imports chat/store.js on first use, and openChatStore() runs the start-up migrations once per page: store/migrate.js holds a Web Lock while it works and records a marker per migration in the `settings` store, so each runs once per browser profile. The first, `local-chats-v1`, turns every chat that 2.x kept in `starpi_local_chats_v1` into a conversation with one linear thread, in one transaction with its marker and with ids derived from the legacy data, so a repeat after an interrupted run finds its own records; every message keeps its on-device flag (`localOnly`), so a turn that stayed on the device in 2.x is never sent to a cloud model as history later. The second, `legacy-keys-v1`, moves the provider keys 2.x remembered in plaintext into the tab's session storage and removes them and the remember switch from localStorage (the key store does the same on its first use). A migration that fails is tried again on the next start, and the ones after it wait. showConversation() then loads the conversation's active path from IndexedDB and renders it; notices shown since boot stay below it, and an answer still being written in that conversation keeps streaming under its question. Nothing is merged with a server copy: the encrypted sync (section 8) writes into the same store through its change events, and the thread follows such changes on screen.

<!-- diagram: boot-sequence-conversation-store -->
```mermaid
sequenceDiagram
    autonumber
    participant Main as main.js boot()
    participant Chat as chat.js restoreHistory
    participant Th as chat/thread.js
    participant CS as chat-store.js
    participant Store as chat/store.js
    participant Mig as chat/migrate-v1.js, store/migrate.js
    participant DB as IndexedDB starpi
    participant LS as localStorage

    Main->>Chat: await restoreHistory()
    Chat->>Th: import() the thread
    Th->>Th: showConversation(currentSessionId(), keepNotices)
    Th->>CS: chatData()
    CS->>Store: import(), openChatStore()
    Store->>Mig: runStartupMigrations(), once per page
    Mig->>Mig: Web Lock, markers migration:* in settings
    opt marker local-chats-v1 missing
        Mig->>LS: read starpi_local_chats_v1
        Mig->>DB: conversations and nodes with the marker in one transaction,<br/>ids from the legacy data, localOnly kept
        Mig->>LS: remove the legacy chats
    end
    opt marker legacy-keys-v1 missing
        Mig->>LS: move starpi_gemini_key, starpi_openrouter_key to sessionStorage,<br/>remove starpi_remember_keys, set starpi_vault_hint
    end
    Note over Mig: a failed migration runs again next start,<br/>the ones after it wait
    Store-->>Th: the store, notify all when chats were imported
    Th->>DB: loadThread(id): the active path
    Th->>Th: resetMessages(), renderNode per message
    Th->>Th: notices shown since boot appended again,<br/>a live answer of this conversation kept below its question
```

<sub>Sources: [`src/js/chat.js`](../src/js/chat.js), [`src/js/chat/thread.js`](../src/js/chat/thread.js), [`src/js/chat-store.js`](../src/js/chat-store.js), [`src/js/chat/store.js`](../src/js/chat/store.js), [`src/js/chat/migrate-v1.js`](../src/js/chat/migrate-v1.js), [`src/js/store/migrate.js`](../src/js/store/migrate.js), [`src/js/ai/keys.js`](../src/js/ai/keys.js), [`src/js/store/schema.js`](../src/js/store/schema.js), [`tests/e2e/migration.spec.mjs`](../tests/e2e/migration.spec.mjs)</sub>

### saveSettings: model strength and a pending assistant pick

Keys, the vault, the relay switch and the own server's address moved to Settings › Model providers and keys (settings/providers-view.js, next section); the Save button of the general settings keeps two things. The model strength (max, super, auto or fast: ai/model-selection.js, which Auto and provider picks follow) is stored again when it differs from the stored one or when the browser refused it when it was picked. The assistant pickers apply a pick when it is made, so Save calls changeEngine only when the settings picker shows another value than the stored choice (a keyboard pick that has not settled yet); re-applying the shown recommendation would turn a stored `auto` into a fixed model. The alert says settings.saved_toast only when every write was stored, otherwise settings.save_failed. The own server's address is saved in the providers card after normalizeServerUrl: `https` anywhere, `http` only for loopback hosts, no user or password, query and fragment dropped.

<!-- diagram: settings-flow-save -->
```mermaid
flowchart TD
    save(["Save in Settings"])
    strengthQ{"cfgStrength valid and different from the stored<br/>strength, or the last pick was not stored?"}
    setStrength["model-selection.js setModelStrength(value)<br/>strengthUnsaved = not stored"]
    pickQ{"cfgComputeMode shows another value<br/>than currentPickerValue()?"}
    change["changeEngine(value, interactive true)<br/>may ask to download an on-device model"]
    allQ{"every write stored?"}
    ok(["alert settings.saved_toast"])
    fail(["alert settings.save_failed"])
    save --> strengthQ
    strengthQ -->|"yes"| setStrength --> pickQ
    strengthQ -->|"no"| pickQ
    pickQ -->|"yes"| change --> allQ
    pickQ -->|"no"| allQ
    allQ -->|"yes"| ok
    allQ -->|"no"| fail

    url(["providers card: own server address"])
    norm{"normalizeServerUrl: parses, https or<br/>http on a loopback host, no credentials?"}
    keep["setLlmUrl(url without query and fragment)"]
    err(["the field shows provider.invalid_url,<br/>insecure_url or credentials_in_url"])
    url --> norm
    norm -->|"yes"| keep
    norm -->|"no"| err
```

<sub>Sources: [`src/js/settings.js`](../src/js/settings.js), [`src/js/ai/model-selection.js`](../src/js/ai/model-selection.js), [`src/js/model-picker.js`](../src/js/model-picker.js), [`src/js/settings/providers-view.js`](../src/js/settings/providers-view.js), [`src/js/providers.js`](../src/js/providers.js), [`src/js/state.js`](../src/js/state.js)</sub>

### Keys: the tab, the vault and its lock

A key typed into Settings › Model providers and keys lives in the tab's session storage by default and is gone when the tab closes. With a passphrase (at least 8 characters) the vault keeps every key it holds as one AES-GCM-256 record in the `keyvault` store of the app database; the AES key is derived with PBKDF2-SHA-256 (600,000 iterations, a 16-byte random salt) as a non-extractable CryptoKey that lives in memory only. Creating the vault moves every key of the tab into it. Unlocking derives the key again and reads the record afresh (another tab may have replaced it); locking by hand or after 30 minutes without activity drops the key and the decrypted keys from memory. setKey stores a key either in the tab or, with keep-in-vault, in the unlocked vault, and removes the other copy. MCP bearer tokens, the voice and search services and the site's access code have slots of their own in the same store. While the vault is unlocked, other features can seal their own text with its key, bound to their purpose; the saved notes of the memory do. Keys are never written in plaintext outside session storage, never exported, synced or put into receipts and logs, and a transport sets the provider's auth header itself. changeEngine applies a picked model (refused while an answer is being written, because unloading the model would cut it off; an interactive pick of an on-device model may ask to download it). Delete downloaded model data unloads the engine, deletes the processor models' cache and every WebLLM model of the catalog, and resets the integrity records, so a new download is hashed again.

<!-- diagram: settings-flow-keys-vault -->
```mermaid
flowchart TD
    typed(["key typed in a provider row"])
    remember{"keep in vault?"}
    session[("sessionStorage of the tab")]
    vaultQ{"vault state?"}
    vault[("IndexedDB starpi, keyvault store:<br/>one AES-GCM-256 record, salt, iv, PBKDF2-SHA-256<br/>600,000 iterations")]
    mem["non-extractable AES key and the<br/>decrypted keys, in memory only"]
    locked(["store error locked: unlock first"])
    typed --> remember
    remember -->|"no"| session
    remember -->|"yes"| vaultQ
    vaultQ -->|"unlocked"| vault
    vaultQ -->|"locked or none"| locked
    session -.->|"setKey removes the vault copy"| vault

    pass(["passphrase entered"])
    stateQ{"vault exists?"}
    create["at least 8 characters: random salt, derive key,<br/>move every key of the tab into the new record"]
    open["read the record again, derive the key,<br/>decrypt; wrong passphrase: no change"]
    pass --> stateQ
    stateQ -->|"no"| create --> mem
    stateQ -->|"yes"| open --> mem
    mem --> vault
    idle["30 minutes without activity, or Lock now"]
    idle -->|"drop key and keys"| mem
    seal["seal(purpose, text): memory notes,<br/>bound to their purpose, while unlocked"]
    mem --> seal
    forget(["Forget all keys"]) -->|"tab copies and the vault record deleted"| vault

    legacy(["2.x plaintext keys in localStorage"])
    legacy -->|"migrateLegacyKeys: moved once, remember switch removed,<br/>vault hint suggests a passphrase"| session

    del(["Delete downloaded model data"])
    del --> unload["unloadModel()"] --> caches["delete transformers-cache and every<br/>WebLLM catalog model, forgetVerified()"]
```

<sub>Sources: [`src/js/ai/keys.js`](../src/js/ai/keys.js), [`src/js/storage.js`](../src/js/storage.js), [`src/js/settings/providers-view.js`](../src/js/settings/providers-view.js), [`src/js/store/migrate.js`](../src/js/store/migrate.js), [`src/js/settings.js`](../src/js/settings.js), [`src/js/webgpu/engine.js`](../src/js/webgpu/engine.js), [`src/js/models/integrity.js`](../src/js/models/integrity.js)</sub>

### deleteHistory: deleting the chat history

The delete-chat-history button is refused with settings.delete_history_busy while an answer is being written, because the running turn would be stored again. Otherwise it asks for confirmation (a stronger text when the encrypted sync is on, since the deletion also reaches the synced copy and the other browsers) and calls deleteChatHistory in chat-store.js. It waits for message writes still under way and marks their sessions as deleted, so a write that ends later cannot store a deleted chat again; it notes the ids of every conversation when sync is on, clears every conversation in IndexedDB and starts a new session id. It then deletes what a 2.x version may have stored in the plaintext `chat_history` table: nothing when the connection is ready and canSyncChats() is false, otherwise deleteOwnChats() (own rows only, by RLS; a failure counts as partial). With sync on, the sync hook writes deletion markers for the noted conversations now, so other browsers delete them too; it reports a failure when that failed or a conversation came back because another browser added messages to it. The chat on screen is reset whatever happened, and the alert says done or partial. Delete this chat in the conversation list does the same for one conversation (deleteSession).

<!-- diagram: settings-flow-delete-history -->
```mermaid
flowchart TD
    btn(["Delete chat history"])
    busy{"isChatBusy()?"}
    refuse(["alert settings.delete_history_busy"])
    confirm{"confirm: delete_history_confirm,<br/>or the synced text when sync is on"}
    stop(["nothing deleted"])
    settle["settleWrites(): wait for pending writes,<br/>mark their sessions deleted"]
    note["sync on: note every conversation id,<br/>archived ones included"]
    clear["store.clearConversations() in IndexedDB;<br/>a failure counts as partial"]
    newSession["startNewSession()"]
    legacyQ{"connection ready and<br/>canSyncChats() false?"}
    legacyDel["deleteOwnChats(): 2.x chat_history rows of this user,<br/>RLS owner only; failure counts as partial"]
    syncQ{"sync hook bound?"}
    flush["flush(deleted): write deletion markers now;<br/>false when it failed or a chat came back"]
    reset["resetConversation()"]
    result{"local, legacy and sync all ok?"}
    done(["alert settings.delete_history_done"])
    partial(["alert delete_history_partial,<br/>or the synced variant"])
    btn --> busy
    busy -->|"yes"| refuse
    busy -->|"no"| confirm
    confirm -->|"cancel"| stop
    confirm -->|"ok"| settle --> note --> clear --> newSession --> legacyQ
    legacyQ -->|"yes: nothing could be stored"| syncQ
    legacyQ -->|"no, also offline or pending"| legacyDel --> syncQ
    syncQ -->|"yes"| flush --> reset
    syncQ -->|"no"| reset
    reset --> result
    result -->|"yes"| done
    result -->|"no"| partial
```

<sub>Sources: [`src/js/settings.js`](../src/js/settings.js), [`src/js/chat-store.js`](../src/js/chat-store.js), [`src/js/chat/store.js`](../src/js/chat/store.js), [`src/js/sync/service.js`](../src/js/sync/service.js), [`src/js/sync/sync.js`](../src/js/sync/sync.js), [`src/js/supabase.js`](../src/js/supabase.js), [`src/js/chat.js`](../src/js/chat.js)</sub>

### Testing a key

The Test button of a provider row tests the key typed into the row (without saving it) or, with an empty field, the stored one; the own server row tests its address after normalizeServerUrl, with an optional key. testKey (ai/transport-select.js) builds the transport a call would take, without the site's pools: direct, auto (direct, retried through the relay when the browser blocks the call), or the relay. When no transport fits (the relay is switched off for a provider that needs it), the result is the code cors, else auth. The test asks the provider's model list (GET /models) with a timeout; a 2xx answer is ok and names the route that answered (direct or relay). Any other answer is reduced to an error code (fromHttp: auth, quota, rate_limited, not_found, server and others), and a thrown error to the code toAiError gives (network, timeout, cors, aborted). The provider's error text is never shown or kept: the row shows the code and the translated text of `ai.error.<code>`. Afterwards the row statuses are refreshed.

<!-- diagram: settings-flow-test-key -->
```mermaid
sequenceDiagram
    autonumber
    participant Row as providers-view.js runKeyTest
    participant Keys as ai/keys.js
    participant TS as ai/transport-select.js testKey
    participant Tr as transport: direct, auto or relay
    participant Up as provider or /api/relay

    Row->>Row: key = typed value, else keys.getKey(id)
    alt no key and not the own server
        Row->>Row: report key.empty
    else
        opt own server
            Row->>Row: normalizeServerUrl(address), a failure is shown at once
        end
        Row->>Row: report test.running
        Row->>TS: testKey(id, key, baseUrl, access code)
        TS->>TS: selectTransport(id, key, pool false)
        alt no transport
            TS-->>Row: ok false, code cors (relay off) or auth
        else
            TS->>Tr: GET modelsPath, provider auth header, timeout
            Tr->>Up: direct, auto retries through the relay when blocked
            alt 2xx
                Up-->>TS: model list, body cancelled
                TS-->>Row: ok true, via direct or relay
                Row->>Row: report test.ok_direct or test.ok_relay
            else error status
                TS->>TS: fromHttp(status, headers, a short snippet) to an AiError code
                TS-->>Row: ok false, code
                Row->>Row: report test.failed with the code and ai.error.code, never the provider text
            else thrown
                TS->>TS: toAiError(err): network, timeout, cors, aborted
                TS-->>Row: ok false, code
            end
        end
        Row->>Row: refreshStatuses()
    end
```

<sub>Sources: [`src/js/settings/providers-view.js`](../src/js/settings/providers-view.js), [`src/js/ai/transport-select.js`](../src/js/ai/transport-select.js), [`src/js/ai/transport.js`](../src/js/ai/transport.js), [`src/js/ai/errors.js`](../src/js/ai/errors.js), [`src/js/ai/keys.js`](../src/js/ai/keys.js), [`src/js/providers.js`](../src/js/providers.js)</sub>

## 3. Answering a question

What happens from Send to a stored answer: the route a question takes (Auto, Free, Grounded), where its excerpts come from, how the runner picks and streams a model, how the source check and the receipt follow, what leaves the device per model, compare and the council, and how models on this device are chosen and sized.

### A question in the thread

sendQuestion() (chat/thread.js) takes the composer's draft (text and attachments, read by the ingestion worker for files) or a question from elsewhere (a suggested question, a graph entity, the canvas) and the picker value. A turn runs inside withTurn(): one at a time, with Stop and the busy state around it; a failure becomes a notice from i18n only. The route comes first (Auto's decision, the explicit mode, or the companion's rule; see what-leaves-the-device in section 1). The free route stores the question at once, with a context block of the date, time and time zone and the notes of registered hooks, then answerFree() asks chatCandidates() and streams the answer through the runner; the registered tool runner may run the calls the model stopped for (with approval cards in the bubble) and the answer goes on after them. The grounded and mixed routes go to answerGrounded(), which retrieves first and stores the question only after retrieval shows whether it stays on this device. A turn writes to the conversation it started in (turnConversation()), also when the user opens another chat meanwhile; the answer node records the provider, model, route, usage, stop reason, label, attempts and, for a grounded answer, the source-check counts. The first answer of a conversation may give it a title, asked only of the provider that answered (never for an answer that stays on this device).

<!-- diagram: chat-request-lifecycle -->
```mermaid
flowchart TD
    send(["sendQuestion(options): composer draft<br/>or a question from elsewhere"])
    busyQ{"a turn running?"}
    busyOut(["status.busy, nothing sent"])
    draft["takeDraft(): text up to 8,000 chars,<br/>attachments read for the request"]
    route["route: explicit mode, Auto's decideRoute(),<br/>companion by the mode control,<br/>held content: free"]
    turn["withTurn(): AbortController, busy state,<br/>turn bound to this conversation"]
    freeQ{"route free?"}
    storeF["storeQuestion: parts with attachment blobs,<br/>context block (date, time, zone, hook notes),<br/>localOnly when device, held or companion"]
    answerF["answerFree(): chatCandidates(value, vision),<br/>held: only models here, else notice"]
    stream["streamAnswer(): runAnswer along the candidates,<br/>read-aloud through the gate while it streams"]
    tools["tool runner (setToolRunner): calls the model<br/>stopped for, approvals in the bubble"]
    grounded["answerGrounded(): retrieve, store the question,<br/>request, stream, source check, receipt draft"]
    node[("appendNode: answer with provider, model, route,<br/>usage, label, attempts, localOnly, meta")]
    title["first answer: title_chat purpose,<br/>only the provider that answered"]
    notice(["failure: notice from i18n, the reason in the console"])
    send --> busyQ
    busyQ -->|"yes"| busyOut
    busyQ -->|"no"| draft --> route --> turn --> freeQ
    freeQ -->|"yes"| storeF --> answerF --> stream --> tools --> node
    freeQ -->|"mixed or grounded"| grounded --> node
    node -.-> title
    turn -.->|"throws, not aborted"| notice
```

<sub>Sources: [`src/js/chat/thread.js`](../src/js/chat/thread.js), [`src/js/chat/composer.js`](../src/js/chat/composer.js), [`src/js/chat/attachments.js`](../src/js/chat/attachments.js), [`src/js/chat/runner.js`](../src/js/chat/runner.js), [`src/js/chat/hooks.js`](../src/js/chat/hooks.js), [`src/js/chat/store.js`](../src/js/chat/store.js), [`src/js/ai/hybrid.js`](../src/js/ai/hybrid.js), [`src/js/ai/router.js`](../src/js/ai/router.js)</sub>

### retrieve(): where the excerpts come from

retrieve() runs the workspace search and the registered retrieval sources (registerRetrievalSource: the companion's documents and notes, each source with a 5 s deadline) at the same time. The workspace search covers the conversation's scope (setWorkspaceScope, a project's files) plus the files attached to the question, or only the files a question names (docIds: an entity found in some files, which also leaves the library and the sources out). A workspace-only question (a suggested question about the sample files) stops there. While the connection is offline the library is skipped. A question that may leave the device sends the question to search_knowledge (the first 1,000 characters, 6 rows) and falls back to the 30 newest documents ranked in the browser when that finds nothing or fails. A device-only question (the model of this device, or a question held here) ranks the library by a query vector made on this device (libraryHitsByMeaning, when search by meaning is on and the optional vector migration is installed); without one, the 30 newest documents are fetched without the question and ranked in the browser. mergeHits() then joins the workspace hits with the sources' and the library's (next section); the limit is 6 plus 3 per attached file, at most 15. The method line names the parts that answered (workspace, library by full text, by meaning or by keyword, offline).

<!-- diagram: chat-request-retrieve -->
```mermaid
flowchart TD
    start(["retrieve(query, focus, workspaceOnly, deviceOnly, docIds)"])
    ws["retrieveWorkspace(query, focus, docIds):<br/>scope = docIds, else setWorkspaceScope of the<br/>conversation, plus the attached files"]
    src{"workspaceOnly or docIds?"}
    sources["sourceHits(query, deviceOnly): registered sources,<br/>5 s each, failures dropped"]
    none["no sources, no library"]
    wsOnly{"workspaceOnly?"}
    wsOut(["workspace hits only, up to the limit"])
    off{"connection offline?"}
    offOut(["mergeHits(workspace, sources), method retrieval.offline"])
    dev{"deviceOnly?"}
    fts["searchKnowledge(query): search_knowledge,<br/>first 1,000 chars, 6 rows"]
    ftsQ{"rows found?"}
    ftsOut(["mergeHits(workspace, sources + rows), retrieval.fts"])
    recent["recentKnowledge(30), rankHitsLocally(query, 6)<br/>method retrieval.keyword with the reason"]
    vec["libraryHitsByMeaning(query, 6): query embedding<br/>on this device, match_knowledge_vector_384"]
    vecQ{"hits?"}
    vecOut(["mergeHits(..., vector hits), workspace.retrieval_vector"])
    local["recentKnowledge(30) without the question,<br/>ranked in the browser, retrieval.local"]
    start --> ws
    start --> src
    src -->|"no"| sources
    src -->|"yes"| none
    ws --> wsOnly
    wsOnly -->|"yes"| wsOut
    wsOnly -->|"no"| off
    off -->|"yes"| offOut
    off -->|"no"| dev
    dev -->|"no"| fts --> ftsQ
    ftsQ -->|"yes"| ftsOut
    ftsQ -->|"no rows or error"| recent
    dev -->|"yes"| vec --> vecQ
    vecQ -->|"yes"| vecOut
    vecQ -->|"no"| local
```

<sub>Sources: [`src/js/chat/thread.js`](../src/js/chat/thread.js), [`src/js/chat/hooks.js`](../src/js/chat/hooks.js), [`src/js/retrieval.js`](../src/js/retrieval.js), [`src/js/rag/embed-client.js`](../src/js/rag/embed-client.js), [`src/js/companion/tier.js`](../src/js/companion/tier.js), [`src/js/supabase.js`](../src/js/supabase.js), [`src/js/config.js`](../src/js/config.js)</sub>

### Workspace hits and mergeHits: slots per source and the pinned files

searchWorkspace resolves empty without asking the ingestion worker when the workspace has no documents or the query is blank. Otherwise the worker ranks with BM25, or, when search by meaning is on and the files have vectors, with BM25 and the cosine similarity of a query vector fused by reciprocal rank fusion (k 60, 50 candidates per ranking), and returns the top 6 chunks. Without an attached file every hit is kept in rank order. Each attached file pins up to 3 of its matching chunks, or its first 3 chunks (score 0) when none matched, in front of the hits from other files; any worker error drops all workspace hits. mergeHits keeps the pinned hits, then gives the other side (registered sources and the library) the larger of half the remaining slots (rounded up) and the slots the other workspace hits cannot fill, but never more than it has hits, and fills the rest with workspace hits. The order is pinned hits, other workspace hits, then the other side, so neither crowds out the other.

<!-- diagram: chat-request-workspace-merge -->
```mermaid
flowchart TD
    Start(["retrieveWorkspace(query, focus, docIds)"]) --> Empty{"searchWorkspace(query, 6):<br/>documents in scope and query not blank?"}
    Empty -->|"no"| None["resolves empty on the main thread,<br/>worker not asked"]
    Empty -->|"yes"| Rank{"vectors stored and<br/>a query vector made here?"}
    Rank -->|"no"| Bm25["worker search: BM25 top 6 with score above 0"]
    Rank -->|"yes"| Hybrid["worker searchHybrid: BM25 and cosine,<br/>reciprocal rank fusion k 60, top 6"]
    None --> Focus{"files attached to this question?"}
    Bm25 --> Focus
    Hybrid --> Focus
    Focus -->|"no"| Plain["hits = found chunks via workspaceHit,<br/>pinned = 0"]
    Focus -->|"yes, per file"| InFile{"found chunks<br/>from that file?"}
    InFile -->|"yes"| Best["its first 3 found chunks"]
    InFile -->|"no"| Head["firstChunks(docId, 3), score 0"]
    Best --> Pin["hits = pinned chunks of every attached file,<br/>then found chunks of other files"]
    Head --> Pin
    Bm25 -.->|"worker rejects or crashes"| Fail["hits empty, pinned 0"]
    Hybrid -.->|"worker rejects or crashes"| Fail
    Plain --> Merge
    Pin --> Merge
    Fail --> Merge
    Merge(["mergeHits(workspace, sources + library, limit, pinned)<br/>limit = 6 + min(3 per attached file, 9)"]) --> Kept["kept = first min(pinned, limit) workspace hits,<br/>rest = the other workspace hits, room = limit - kept"]
    Kept --> FromKb["fromOther = min(other hits,<br/>max(room - rest, ceil(room / 2)))"]
    FromKb --> FromWs["fromWorkspace = min(rest, room - fromOther)"]
    FromWs --> Out["kept, then the first fromWorkspace of rest,<br/>then the first fromOther of the other side"]
    Out --> Ex1["no file, limit 6: 6 workspace and 6 library hits give 3 + 3,<br/>2 workspace hits give 2 + 4"]
    Out --> Ex2["one file, limit 9: 3 pinned, room 6,<br/>3 hits from other files and 6 library hits give 3 + 3 + 3"]
```

<sub>Sources: [`src/js/chat/thread.js`](../src/js/chat/thread.js), [`src/js/retrieval.js`](../src/js/retrieval.js), [`src/js/rag/workspace.js`](../src/js/rag/workspace.js), [`src/js/rag/ingest.worker.js`](../src/js/rag/ingest.worker.js), [`src/js/rag/hybrid.js`](../src/js/rag/hybrid.js), [`src/js/rag/bm25.js`](../src/js/rag/bm25.js), [`src/js/config.js`](../src/js/config.js)</sub>

### The runner: candidates, failover before the first text, and the quoted fallback

chatCandidates() turns the picker value into the models a question may go to: an explicit pick is that one model on its route; Auto is the user's keys first (the model the chosen strength names, else the provider's balanced model), then the site's pools that have keys, then the own server, then the model already loaded on this device (never a download). A question with images goes only to models that see; the companion answers only when it is picked. runAnswer() asks them in order: a call that fails before any text or reasoning arrived (auth, quota, rate limit, a model gone, a bad request, context length, server, timeout, network, a bad response, CORS, a cut stream) moves on to the next candidate; once text arrived the answer belongs to that model, and Stop keeps what arrived. Every call is recorded in attempts and the model wheel hears every outcome (a cooldown after 429, a circuit after repeated failures). An answer paused by the server (Anthropic pause_turn) is sent again with its content, at most five times, and merged. The adapter streams over one transport: direct, auto (direct, retried through the relay once when the browser blocks the call, and remembered per provider), relay, pool (the site's keys) or device (the workers, the own server, the companion). In the grounded route, no candidate, a failure without text or an empty answer ends in synthesizeAnswer(), which quotes the excerpts; the free route ends in a notice instead.

<!-- diagram: chat-request-answer-dispatch -->
```mermaid
flowchart TD
    value(["picker value"])
    cands["chatCandidates(value, vision)"]
    pickQ{"Auto?"}
    one["the picked model on its route<br/>(device only once loaded or loadable)"]
    auto["keys: strength model, else balanced<br/>then site pools with keys, then own server,<br/>then the model loaded on this device"]
    vis["images: only models that see"]
    run["runAnswer(candidates, build per model)"]
    next{"next candidate?"}
    callStream["adapter.stream over the transport:<br/>direct, auto with relay retry, relay, pool, device"]
    first{"text or reasoning arrived?"}
    fail["error code in NEXT_CANDIDATE:<br/>attempt recorded, wheel.failed"]
    owns["the answer belongs to this model,<br/>Stop keeps what arrived"]
    pause{"stop reason pause_turn?"}
    again["send again with the content, at most 5 times,<br/>parts merged"]
    done(["result, target, attempts"])
    noneLeft(["no answer: error of the last attempt"])
    gq{"grounded route?"}
    synth(["synthesizeAnswer(): quotes the excerpts,<br/>engine synthesizer"])
    noticeF(["free route: notice, nothing stored"])
    value --> cands --> pickQ
    pickQ -->|"no"| one --> vis
    pickQ -->|"yes"| auto --> vis
    vis --> run --> next
    next -->|"yes"| callStream --> first
    first -->|"no, failed"| fail --> next
    first -->|"yes"| owns --> pause
    pause -->|"yes"| again --> pause
    pause -->|"no"| done
    next -->|"no"| noneLeft --> gq
    gq -->|"yes"| synth
    gq -->|"no"| noticeF
```

<sub>Sources: [`src/js/chat/runner.js`](../src/js/chat/runner.js), [`src/js/providers.js`](../src/js/providers.js), [`src/js/ai/index.js`](../src/js/ai/index.js), [`src/js/ai/transport-select.js`](../src/js/ai/transport-select.js), [`src/js/ai/transport.js`](../src/js/ai/transport.js), [`src/js/ai/wheel.js`](../src/js/ai/wheel.js), [`src/js/ai/errors.js`](../src/js/ai/errors.js), [`src/js/ai/model-selection.js`](../src/js/ai/model-selection.js), [`src/js/synthesizer.js`](../src/js/synthesizer.js), [`src/js/chat/thread.js`](../src/js/chat/thread.js)</sub>

### Auto, Free and Grounded: how each route builds its request

A free request (freeRequest) has the stable free system prompt plus the notes of registered system hooks, the history the model may see (shareable(): models not on this device never get the local-only turns or their questions), and the question with its attachments and the notes for this request (registerRequestNotes: saved memory notes, at most 8, never stored with the question). For Anthropic the history goes whole (the server compacts it past 100,000 tokens); for others it is trimmed to the model's context minus the answer. The answer may use half the model's context, at most 4,096 tokens on the site's pools, 4,096 on the own server and 16,000 in the cloud; on this device the adapter applies the device's output budget. With the Web toggle on, a model that can search searches by itself (not on the pools). A grounded request has the last 4 shareable turns. Models with a large window (32,768 tokens and more, in the cloud or on a pool) get the fenced excerpts in the system prompt (buildContext, at most 9,000 characters, each excerpt at most 1,600). Models on this device, the own server, models with a smaller window and every mixed answer get a context pack (ai/context-pack.js) sized by the window: small (up to 4k tokens) 3 passages of 600 characters, mid (up to 16k) 6 of 1,600, large up to 12 passages and 24,000 characters. The pack keeps a stable order for a server's KV cache (the fixed instruction as the system prompt, the earlier turns, then the `<<<SOURCES>>>` block with the question), labels passages [S1] and facts [F1], and expandLabels() rewrites those to the canonical labels before the source check, the receipt and storage. A mixed answer takes at most 3 passages and may add general knowledge; its checked parts are marked. On the site's pools every request is fitted to the pool's limits. What reached the model of each excerpt (full, partial or omitted) comes from the pack's coverage or from the fenced context parsed back, and the source check reads it.

<!-- diagram: chat-routes-requests -->
```mermaid
flowchart TD
    q(["question on its route"])
    r{"route"}
    subgraph free["Free: freeRequest"]
        fsys["system: free prompt + system hook notes"]
        fhist["history: shareable(path) for the model;<br/>Anthropic whole, others trimmed to the window"]
        fq["question + attachments + request notes<br/>(memory, at most 8, not stored)"]
        fout["maxOutputTokens: half the window, at most<br/>4,096 pool, 4,096 own server, 16,000 cloud;<br/>device: the output budget in the adapter"]
        fweb["Web toggle: the model's own search,<br/>not on the site's pools"]
    end
    subgraph gr["Grounded and mixed: groundedRequest"]
        ghist["history: last 4 shareable turns"]
        packQ{"mixed, on this device, own server,<br/>or window under 32,768 tokens?"}
        fenced["system prompt with the fenced excerpts:<br/>buildContext, 9,000 chars, 1,600 per excerpt"]
        pack["context pack: small 3 x 600, mid 6 x 1,600,<br/>large 12 passages, 24,000 chars;<br/>instruction, turns, then the SOURCES block + question;<br/>labels S1 and F1"]
        expand["expandLabels(): canonical labels before<br/>the check, the receipt and storage"]
        cov["coverage per excerpt: full, partial, omitted"]
    end
    fit["site pool: fitPoolRequest to the pool's limits"]
    q --> r
    r -->|"free"| fsys --> fhist --> fq --> fout
    fq -.-> fweb
    r -->|"grounded or mixed"| ghist --> packQ
    packQ -->|"no"| fenced --> cov
    packQ -->|"yes"| pack --> expand --> cov
    fout --> fit
    cov --> fit
```

<sub>Sources: [`src/js/chat/thread.js`](../src/js/chat/thread.js), [`src/js/ai/context-pack.js`](../src/js/ai/context-pack.js), [`src/js/retrieval.js`](../src/js/retrieval.js), [`src/js/prompts.js`](../src/js/prompts.js), [`src/js/ai/thinking.js`](../src/js/ai/thinking.js), [`src/js/ai/adapters/on-device.js`](../src/js/ai/adapters/on-device.js), [`src/js/ai/catalog/pools.js`](../src/js/ai/catalog/pools.js), [`src/js/core/grounding.js`](../src/js/core/grounding.js)</sub>

### After rendering: source check, receipt draft and the stored turn

When a grounded answer has a citation scope, the label under it says "checking" while the source check runs after the stream. Its sources are the excerpts with the part that reached the model (the pack's coverage, the fenced context parsed back, or every excerpt in full for a quoted answer), and "given" is the question plus the user's last 4 turns (what the user said may be repeated without a source, the model's own earlier answers may not). A mixed answer gets its checked statements marked (applyMixedMarks); every other grounded answer gets applyGrounding with the current rules (version 3: values, negations, bindings and relations), whose AI-judge second opinion is offered only for answers that may leave the device. An answer that rests on web passages is checked and labelled but gets no receipt, because a web passage is what the search said about a page and the receipt format has no place for it. For the others a receipt draft is built in memory: the answer, engine and language, the question, the source-check report, every citation with its document fingerprint and chunk span, the sentence gate's counts in sources mode, the relations the check found, and whatever registered receipt hooks add; it becomes a signed `starpi.receipt/v3` file only when the user exports it (section 12). A free answer that searched the web is checked as far as its citations allow (rag/web-check.js: checked against quoted page text, segments checked by the gate in web mode, cited, or none). The answer node stores the label (grounded, mixed, web, free), the counts and localOnly (device-only, a workspace passage used, or a quoted answer naming a workspace file).

<!-- diagram: chat-request-source-check -->
```mermaid
flowchart TD
    ans(["answer text after expandLabels(), message element, scope"])
    scopeQ{"citation scope?"}
    noCheck(["no check, stored as is"])
    label["renderAnswerLabel(checking)"]
    cov["sources: excerpt label, doc, heading, the delivered text<br/>and state (full, partial, omitted)"]
    given["given: the question and the user's last 4 turns"]
    mixedQ{"mixed answer with a model?"}
    mixed["applyMixedMarks: checked statements marked"]
    check["applyGrounding: rules version 3,<br/>second opinion only when not localOnly"]
    webQ{"any web passage?"}
    noRcpt["no receipt: checked and labelled only"]
    draft["receipt draft: answer, engine, locale, question,<br/>report, citations with fingerprints and spans"]
    gate["gateCounts: sentence gate in sources mode,<br/>released and withheld"]
    rel["receiptAdvisory(report): relations"]
    hooks["registerReceiptHook additions"]
    btn["receipt button; export signs a v3 file"]
    store[("appendNode: label, grounding counts,<br/>sources, localOnly, meta")]
    ans --> scopeQ
    scopeQ -->|"no"| noCheck
    scopeQ -->|"yes"| label --> cov --> given --> mixedQ
    mixedQ -->|"yes"| mixed --> webQ
    mixedQ -->|"no"| check --> webQ
    webQ -->|"yes"| noRcpt --> store
    webQ -->|"no"| draft --> gate --> rel --> hooks --> btn --> store
```

<sub>Sources: [`src/js/chat/thread.js`](../src/js/chat/thread.js), [`src/js/rag/grounding-view.js`](../src/js/rag/grounding-view.js), [`src/js/chat/answer-labels.js`](../src/js/chat/answer-labels.js), [`src/js/rag/web-check.js`](../src/js/rag/web-check.js), [`src/js/rag/receipts.js`](../src/js/rag/receipts.js), [`src/js/core/grounding.js`](../src/js/core/grounding.js), [`src/js/core/gate.js`](../src/js/core/gate.js), [`src/js/core/receipt.js`](../src/js/core/receipt.js), [`src/js/chat/hooks.js`](../src/js/chat/hooks.js)</sub>

### synthesizeAnswer: the extractive fallback

synthesizeAnswer never generates text: it builds Markdown from the used hits and their citations, and only the grounded route uses it (a free answer has no excerpts to quote): when no model is set up, every candidate failed before the first text, or the answer came back empty. Its document list joins the titles of the used hits with the known titles (workspace file names plus knownTitles(), which calls listDocuments unless the connection is offline and caches the titles for 60 s only after a successful read) and shows up to 8 of them followed by "and n more". A greeting-only message gets synth.greeting with that list, and a request for the list itself (DOC_LIST_REQUEST, such as "Which documents are available?") gets the list, or the unreachable text when the knowledge base could not be searched and no title is known. Otherwise it quotes up to 4 sentences that share a search term with the question, each with the label of its excerpt; the last sentence of an excerpt cut at 1600 chars is left out. When no sentence shares a term (for example "Summarize the attached file"), it quotes the first 2 quotable sentences of each passage, at most 4, the attached file first. Only when nothing is quotable does it answer with the unreachable or the no-hits text. When modelAvailable is false, every answer ends with synth.footer_no_model.

<!-- diagram: chat-request-synthesizer -->
```mermaid
flowchart TD
    In(["synthesizeAnswer(query, hits, citations, knownTitles,<br/>modelAvailable, kbUnavailable, focusName)"]) --> Titles["document list: titles of the hits + known titles, unique<br/>shows 8, then synth.more_documents<br/>empty: synth.kb_unavailable_short when kbUnavailable,<br/>else synth.no_documents"]
    Titles --> Greet{"isGreeting(query)?<br/>only a greeting, or who are you,<br/>what can you do"}
    Greet -->|"yes"| GreetOut["synth.greeting,<br/>synth.available_documents and the list"]
    Greet -->|"no"| DocList{"DOC_LIST_REQUEST?<br/>e.g. Which documents are available?"}
    DocList -->|"yes"| DocUnav{"kbUnavailable and<br/>no title known?"}
    DocUnav -->|"yes"| Unav["synth.kb_unavailable_heading<br/>and synth.kb_unavailable_body"]
    DocUnav -->|"no"| DocOut["synth.documents_heading with the count,<br/>then the list"]
    DocList -->|"no"| Quot["quotable text per hit: the excerpt as given,<br/>an excerpt cut at 1600 chars loses its last sentence"]
    Quot --> Facts["extractSentences(query, quotable, 4):<br/>sentences of 16 to 399 chars with at least 5 words,<br/>no lower-case fragment at a workspace chunk start,<br/>scored by shared query terms, best first"]
    Facts --> HasFacts{"any sentence shares<br/>a term?"}
    HasFacts -->|"yes"| FactsOut["synth.facts_heading, one line per sentence:<br/>document title, sentence, excerpt label"]
    HasFacts -->|"no"| Open["first 2 quotable sentences per passage,<br/>at most 4, the attached file first"]
    Open --> HasOpen{"any sentence?"}
    HasOpen -->|"yes, file attached"| FileOut["synth.file_heading with the file name,<br/>lines with excerpt labels"]
    HasOpen -->|"yes, no file"| Closest["synth.closest_heading, synth.closest_note,<br/>lines with excerpt labels"]
    HasOpen -->|"no"| KbChk{"kbUnavailable?"}
    KbChk -->|"yes"| Unav
    KbChk -->|"no"| NoHits["synth.no_hits_heading, synth.no_hits_body,<br/>synth.available_documents and the list"]
    Done(["Markdown, engine synthesizer<br/>modelAvailable false: synth.footer_no_model appended"])
    GreetOut --> Done
    DocOut --> Done
    Unav --> Done
    FactsOut --> Done
    FileOut --> Done
    Closest --> Done
    NoHits --> Done
```

<sub>Sources: [`src/js/synthesizer.js`](../src/js/synthesizer.js), [`src/js/chat/thread.js`](../src/js/chat/thread.js), [`src/js/retrieval.js`](../src/js/retrieval.js), [`src/js/core/sentences.js`](../src/js/core/sentences.js), [`src/js/supabase.js`](../src/js/supabase.js), [`src/locales/en.json`](../src/locales/en.json)</sub>

### Answer modes: what leaves the device

What leaves the device depends on the model that answers, not only on the mode. A model on this device (WebLLM on WebGPU or Transformers.js on the processor) gets everything in its worker: nothing of the question leaves, the library is ranked by a query vector made here or by candidates fetched without the question, and there is no web search and no cloud tool. A provider with the user's key gets the request direct from the browser, or through the relay for providers that refuse browser calls (the relay forwards once and keeps nothing); the site's pools get the same request with a site key from the allowlist (text and images, no tools); the own server gets it direct, never through the site; the paired companion gets the bare question with its mode and data class over the loopback interface. In the grounded route the request carries the excerpts and the last 4 shareable turns, and the question goes to the library search (full text) unless it stays on this device; in the free route it carries the shareable history, the question and its attachments. With no model (or after a failure) the excerpts are quoted, and only the question went to the library search. Local-only turns (device, workspace passages, quoted answers naming a workspace file, the companion's turns) are never part of another model's history and never enter the encrypted sync.

<!-- diagram: modes-privacy-data-egress -->
```mermaid
flowchart TD
    ask(["question with the picked model and the composer's mode"])
    who{"who answers?"}
    subgraph dev["Stays in this browser"]
        dWorker["starpi-webllm or starpi-wasm: system, excerpts<br/>or attachments, history and question in the worker"]
        dLib["library: query vector made here,<br/>else 30 newest documents without the question"]
        dNo["no web search, no cloud tools, no title request"]
        quote["synthesizeAnswer: quotes the excerpts,<br/>no model"]
    end
    subgraph net["Sent over the network"]
        prov["provider with the user's key: direct (Anthropic,<br/>OpenAI, Gemini, OpenRouter) or through the relay<br/>(xAI, Groq, Mistral, DeepSeek, NVIDIA key)"]
        pool["site pool: text and images, no tools,<br/>allowlisted model, site key"]
        srv["own server: direct, https or loopback http"]
        comp["companion: bare question, mode, data class,<br/>loopback; answer arrives gated"]
        lib["Supabase search_knowledge: the question,<br/>first 1,000 chars"]
        web["search API or the provider's web search:<br/>the query, not for device-only questions"]
        hf["model files after a confirmation: Hugging Face,<br/>raw.githubusercontent.com, ONNX Runtime from /assets"]
    end
    grounded{"grounded or mixed route?"}
    gPayload["excerpts + last 4 shareable turns + question"]
    fPayload["shareable history + question + attachments"]
    hist["shareable(): local-only turns and their questions<br/>never go to a model not on this device"]
    saved[("IndexedDB: localOnly turns stay;<br/>encrypted sync takes the others only")]

    ask --> who
    who -->|"model on this device"| dWorker
    dWorker -.-> dLib
    dWorker -.-> dNo
    dWorker -.->|"not cached, after a confirmation"| hf
    who -->|"provider with a key"| grounded
    who -->|"site pool"| grounded
    who -->|"own server"| grounded
    who -->|"companion"| comp
    who -->|"no model or a failure, grounded"| quote
    grounded -->|"yes"| gPayload --> lib
    grounded -->|"no"| fPayload
    gPayload --> hist
    fPayload --> hist
    hist --> prov
    hist --> pool
    hist --> srv
    fPayload -.->|"Web toggle"| web
    quote -.->|"question to the library search"| lib
    dWorker --> saved
    prov --> saved
    pool --> saved
    srv --> saved
    comp --> saved
    quote --> saved
```

<sub>Sources: [`src/js/chat/thread.js`](../src/js/chat/thread.js), [`src/js/chat/runner.js`](../src/js/chat/runner.js), [`src/js/ai/catalog/providers.js`](../src/js/ai/catalog/providers.js), [`src/js/ai/transport-select.js`](../src/js/ai/transport-select.js), [`src/js/ai/catalog/pools.js`](../src/js/ai/catalog/pools.js), [`src/js/ai/adapters/companion.js`](../src/js/ai/adapters/companion.js), [`src/js/companion/tier.js`](../src/js/companion/tier.js), [`src/js/rag/embed-client.js`](../src/js/rag/embed-client.js), [`src/js/supabase.js`](../src/js/supabase.js), [`src/js/synthesizer.js`](../src/js/synthesizer.js), [`src/js/sync/payload.js`](../src/js/sync/payload.js), [`src/js/webgpu/engine.js`](../src/js/webgpu/engine.js), [`src/js/wasm/worker.js`](../src/js/wasm/worker.js)</sub>

### Compare and the council

Both run in the chat side panel and ask several models the same question at once, always in the free route. thread.js prepareQuestion() builds the question once: a stored one (Compare or Council on a message takes the answer's question) or a new one typed there or taken from the composer, with the context block and the notes for this request; for each model it builds the request the thread's free route would send, with the history that model may see. A question that stays on this device builds no request for other models (the code stays_on_device). Compare asks 2 to 4 models, each in its own column through runAnswer with that one model and no fallback, with its own Stop, time, tokens and a cost hint; the tool runner runs each column's tool calls with their approval cards there. A new question for models here and the own server only is marked as staying on this device: it is offered only the tools that keep it here and goes to no search service (a thread question to the own server is not marked so: the decision keeps the privacy-first default for Compare). A compare column asks the paired companion the way the thread does (the bare question, sources or free mode, the question's data class, no app tools; a stopped answer is not kept). Each finished column is labelled like a free answer (presentAnswer on the fields of freeAnswerInput), and "Continue with this" makes it the newest branch under the question (adoptAnswer). The council (ai/council.js) seats up to three members from different providers, each pinned without fallback and limited to 120 s per draft, and a judge, the strongest model that is not a member, chooses a draft or merges them; with fewer than two valid drafts the best draft stands. The model on this device and the companion take no part, and a question that stays on this device is not sent to a council. The result becomes an answer under the question, labelled with how it was decided, and keeps a bounded copy of the drafts and the judge's reasons.

<!-- diagram: chat-compare-council -->
```mermaid
flowchart TD
    start(["Compare or Council: a stored question,<br/>or a new one from the panel or the composer"])
    prep["thread.js prepareQuestion(): the question node,<br/>context block, request notes once,<br/>build(target) = the free route's request"]
    stays{"question stays on this device?"}
    which{"panel"}
    subgraph cmp["Compare: 2 to 4 columns"]
        models["models from the picker's choices,<br/>different providers first;<br/>device models only when loaded"]
        col["per column: runAnswer(one model, no fallback),<br/>own Stop, time, tokens, cost hint"]
        compCol["companion column: bare question, sources or free,<br/>data class, no app tools, stopped answer not kept"]
        heldCol["new question for models here and the own server only:<br/>stays on this device, no search service,<br/>only tools that keep it here"]
        toolsC["tool runner per column, approvals in the column"]
        present["presentAnswer(freeAnswerInput): not checked,<br/>stop note, cited pages and their web check"]
        adopt(["Continue with this: adoptAnswer, newest branch"])
    end
    subgraph cou["Council: ai/council.js"]
        seat["up to 3 members from different providers, pinned,<br/>120 s per draft; no device model, no companion"]
        judge["judge: strongest model that is not a member,<br/>council_judge purpose: chosen, reasons, merged"]
        few{"fewer than 2 valid drafts,<br/>or the judge fails?"}
        best["best valid draft stands, the result says why"]
        result(["answer under the question: judge's choice, merged,<br/>or best draft; bounded copy of drafts and reasons"])
    end
    refuse(["notice: stays_on_device"])
    start --> prep --> stays
    stays -->|"yes, council"| refuse
    stays -->|"yes, compare"| heldCol --> col
    stays -->|"no"| which
    which -->|"compare"| models --> col
    models -.-> compCol --> present
    col --> toolsC --> present --> adopt
    which -->|"council"| seat --> judge --> few
    few -->|"yes"| best --> result
    few -->|"no"| result
```

<sub>Sources: [`src/js/chat/compare.js`](../src/js/chat/compare.js), [`src/js/chat/council-view.js`](../src/js/chat/council-view.js), [`src/js/ai/council.js`](../src/js/ai/council.js), [`src/js/ui/council-panel.js`](../src/js/ui/council-panel.js), [`src/js/chat/thread.js`](../src/js/chat/thread.js), [`src/js/chat/runner.js`](../src/js/chat/runner.js), [`src/js/features/canvas.js`](../src/js/features/canvas.js)</sub>

### Settings: what the model choice stores

The picker value is the only model choice the app stores (`starpi_assistant_v1`); a preset picked on this device stores `device` plus the preset in `starpi_webgpu_model`, and an NVIDIA pick also remembers its model. The strength and a pinned model go to `starpi_model_strength_v1` and `starpi_model_pinned_v1`. The own server's address (`starpi_llm_url`) passes normalizeServerUrl first: `https` anywhere, `http` only for `localhost` and `127.0.0.1`, no user name or password, query and fragment dropped; the browser shows its local-network prompt for loopback addresses from the hosted app. The relay switch is `starpi_relay_fallback` (on unless switched off), and the route a provider with transport auto took last is remembered per provider (`starpi_transport_<id>`), so a provider that needs the relay goes there at once. Keys are not settings: they live in the tab or in the vault (section 2). Every write goes through storage.js, which never throws: a browser that refuses storage keeps the choice for the page and the save reports it.

<!-- diagram: modes-privacy-settings-storage -->
```mermaid
flowchart TD
    pick(["picker value"])
    setA["state.js setAssistant()"]
    devQ{"webgpu:key or wasm:key?"}
    pref[("starpi_webgpu_model: the preset,<br/>assistant stored as device")]
    nvQ{"nvidia:model?"}
    nv[("starpi_nvidia_model")]
    asst[("starpi_assistant_v1, and the 2.x<br/>starpi_compute_mode kept in step")]
    pick --> setA --> devQ
    devQ -->|"yes"| pref --> asst
    devQ -->|"no"| nvQ
    nvQ -->|"yes"| nv --> asst
    nvQ -->|"no"| asst

    strength(["strength or pinned model"]) --> sel[("starpi_model_strength_v1,<br/>starpi_model_pinned_v1")]

    url(["own server address"])
    norm{"normalizeServerUrl: https, or http on<br/>localhost or 127.0.0.1; no credentials"}
    llm[("starpi_llm_url without query and fragment")]
    bad(["provider.invalid_url, insecure_url<br/>or credentials_in_url"])
    url --> norm
    norm -->|"ok"| llm
    norm -->|"no"| bad

    relay(["relay switch"]) --> rs[("starpi_relay_fallback: absent = on, 0 = off")]
    auto(["auto provider answered"]) --> tr[("starpi_transport_id: direct or relay")]
    keys(["provider keys"]) -.->|"not settings: tab or vault"| vault[("sessionStorage or IndexedDB keyvault")]
```

<sub>Sources: [`src/js/state.js`](../src/js/state.js), [`src/js/config.js`](../src/js/config.js), [`src/js/ai/model-selection.js`](../src/js/ai/model-selection.js), [`src/js/providers.js`](../src/js/providers.js), [`src/js/ai/transport-select.js`](../src/js/ai/transport-select.js), [`src/js/storage.js`](../src/js/storage.js), [`src/js/ai/keys.js`](../src/js/ai/keys.js), [`src/js/settings/providers-view.js`](../src/js/settings/providers-view.js)</sub>

### Privacy notice under the chat input

renderPrivacyNotice() (settings.js) writes one line under the composer for the picked model and the composer's mode, and re-renders when the mode, the assistant, the providers or the sync change. destinationOf() resolves the picker value: `device` (or Auto with only the loaded model), the own server, the companion, a provider with a key, a site pool, or none. Free mode says what goes where without sources; Auto and Grounded say what source mode sends. The companion's line follows the mode control alone (Grounded answers from its documents and notes, Free and Auto from general knowledge). When the encrypted sync is on and the question may leave the browser, a second line says the conversation is also kept in the synced copy; with the companion it says instead that questions to the companion and its answers stay on this device and are not part of the synced copy.

<!-- diagram: modes-privacy-notice -->
```mermaid
flowchart TD
    render(["renderPrivacyNotice(): on mode, assistant,<br/>providers and sync changes"])
    dest{"destinationOf(getAssistant())"}
    free{"mode Free?"}
    devK["lock: privacy.local / privacy.free_local"]
    srvK["server: privacy.server / privacy.free_server,<br/>host of the own server"]
    cmpK["plug: Grounded privacy.companion,<br/>Free and Auto privacy.free_companion"]
    poolK["cloud: chat-thread.privacy.pool / free_pool,<br/>provider name"]
    keyK["cloud: chat-thread.privacy.key / free_key,<br/>provider name"]
    noneK["library: privacy.extractive / privacy.free_no_model"]
    syncQ{"destination not device and<br/>encrypted sync on?"}
    synced["second line: chat-thread.privacy.history_synced"]
    unsynced["companion: chat-thread.privacy.companion_unsynced,<br/>its questions and answers are not synced"]
    out(["icon and text set with setText, re-translated on a language switch"])
    render --> dest
    dest -->|"device"| devK
    dest -->|"local"| srvK
    dest -->|"companion"| cmpK
    dest -->|"pool"| poolK
    dest -->|"key"| keyK
    dest -->|"none"| noneK
    free -.->|"picks the free_ key"| devK
    devK --> syncQ
    srvK --> syncQ
    cmpK --> syncQ
    poolK --> syncQ
    keyK --> syncQ
    noneK --> syncQ
    syncQ -->|"yes, not companion"| synced --> out
    syncQ -->|"yes, companion"| unsynced --> out
    syncQ -->|"no"| out
```

<sub>Sources: [`src/js/settings.js`](../src/js/settings.js), [`src/js/providers.js`](../src/js/providers.js), [`src/js/chat-store.js`](../src/js/chat-store.js), [`src/js/state.js`](../src/js/state.js), [`src/locales/en.json`](../src/locales/en.json), [`src/locales/chat-thread/en.json`](../src/locales/chat-thread/en.json)</sub>

### On-device model selection

Both assistant pickers, engineSelector in the header and cfgComputeMode in the settings, offer the on-device presets as values webgpu:key and wasm:key; picking one runs changeEngine, which stores the ref in starpi_webgpu_model with the picker value `device` (the value auto stays until the user picks a model) and loads the model interactively. normalizePreference keeps auto and known refs, turns a bare 2.0 key such as qwen-3b into webgpu:qwen-3b and any other value into auto. loadModel probes the device with the high-performance adapter and a 10 s deadline and chooseModel resolves the preference: a manual ref always wins, and auto follows recommendModels (device-tier-selector) with the benchmark history, which picks a processor (WASM) model when there is no WebGPU, never a T3 preset, and steps down a rung when the pick measured slow on this device class. A WebGPU preset with no WebGPU is not swapped for a processor model: the load fails with the probe's error (unsupported or no-adapter). WebGPU presets load the q4f16_1 build when the adapter has shader-f16, else the q4f32_1 build; T1 presets use a 2,048-token context window, T2 and T3 presets 4,096, phones at most 2,048, and the prefill chunk is 128 on phones, else 512 at 4,096 tokens and 256 below; a grounded answer keeps the preset's 512 tokens within the device's output budget, and a free answer may use the whole budget (see the last part of this section). WASM models run with a 2,048-token window and a prefill chunk of 256, answer with 384 tokens unless the benchmark measured them faster, need no GPU memory and report none. The approximate download (300 MB to 5.3 GB for the 13 WebGPU presets, 140 to 520 MB for the 3 WASM models, plus 15 MB of ONNX Runtime counted for every WASM download) drives the confirm dialog and the 1.2x quota check, and the WebGPU badge shows WebLLM vram_required_MB for the chosen build (values from the pinned @mlc-ai/web-llm 0.2.85). The same runtime and model id reuse the loaded engine. A cached model's stored files are checked against model-lock.json before a runtime reads them, and new downloads before the model answers (section 5). A model that is certainly not cached is settled before anything is torn down, the WebLLM library is imported or a worker starts: a start-up load resolves false, an interactive one checks the quota, asks (a T3 preset first warns that it needs several GB of GPU memory), and requests persistent storage; a WASM model counts as missing unless its config, tokenizer and weights are all in transformers-cache, and a partly cached WebGPU model gets the same consent after the import. A declined download resolves false, and every error ends in status error with a notice from startLocalEngine unless the load was cancelled.

<!-- diagram: model-selection-choose-model -->
```mermaid
flowchart TD
    Pick["model picker: engineSelector or cfgComputeMode<br/>value webgpu:key or wasm:key,<br/>applied at once, arrow keys after 700 ms of rest<br/>changeEngine: setModelPreference, starpi_webgpu_model,<br/>another model loaded or loading: unloadModel()"]
    Pref["preference = normalizePreference(starpi_webgpu_model)<br/>auto, webgpu:key or wasm:key, a bare 2.0 key<br/>becomes webgpu:key, unknown values become auto"]
    Start(["startLocalEngine: loadModel with getModelPreference()<br/>and the benchmark history; boot: onlyIfCached, no download;<br/>chat answer, benchmark, a pick: interactive"])
    Probe["probeDevice with the high-performance adapter, 10 s deadline<br/>hw: isMobile, deviceMemoryGB, maxBufferSize, hasF16,<br/>webgpu, maxStorageBufferBindingSize, vendor, architecture<br/>no adapter or no answer: webgpu false, maxBufferSize 0"]
    PrefQ{"chooseModel: preference is auto?"}
    Auto["ref = recommendModels(hw, history).local, reason auto<br/>never a T3 preset, a WASM model without WebGPU,<br/>a rung lower when measured slow, see device-tier-selector"]
    Manual["ref = preference, reason manual<br/>no hardware check for the ref"]
    Runtime{"ref is wasm:key?"}
    Wasm["WASM choice: modelId = the Hugging Face repo,<br/>pinned revision, dtype q8, tier t1, f16 false,<br/>vramMB null, context 2048, prefill 256,<br/>384 tokens unless measured faster, 140 to 520 MB"]
    NoGpu{"WebGPU preset and<br/>the probe found no WebGPU?"}
    Unsup["EngineError from the probe:<br/>unsupported or no-adapter"]
    F16{"hasF16 and webgpu?"}
    Id16["modelId = spec.f16, a q4f16_1 build<br/>e.g. Qwen2.5-3B-Instruct-q4f16_1-MLC"]
    Id32["modelId = spec.f32, a q4f32_1 build<br/>e.g. Qwen2.5-3B-Instruct-q4f32_1-MLC"]
    Ctx["chatOptions: context_window_size = 2048 for T1,<br/>4096 for T2 and T3, at most 2048 on phones<br/>prefill_chunk_size 128 on phones, else 512<br/>at 4096 and 256 below, preset answers 512 tokens"]
    Same{"engine loaded with the same<br/>runtime and modelId?"}
    Reuse(["reuse it, resolve true"])
    Missing{"WASM: wasmCacheStatus is not full<br/>WebGPU: certainlyNotCached, no tensor-cache.json<br/>for the model in webllm/model"}
    Silent(["resolve false, state unchanged,<br/>no import, no worker"])
    Agree["agreeToDownload: checkQuota needs 1.2 x<br/>approxDownloadMB, plus 15 MB of ONNX Runtime<br/>for WASM, free when the quota is known,<br/>confirmDownload: engine.confirm_large for T3,<br/>engine.confirm_download or confirm_download_wasm,<br/>engine.confirm_save_data with Save-Data,<br/>then navigator.storage.persist, best effort"]
    LoadW["teardown, status loading, stored files checked,<br/>new Worker starpi-wasm, WasmEngineClient.load,<br/>new files checked, see wasm-runtime-load"]
    Load["teardown, status loading, import web-llm<br/>modelId not in prebuiltAppConfig: EngineError unknown,<br/>stored files checked against model-lock.json"]
    Partial{"not certainly missing, but<br/>hasModelInCache false?<br/>index cached, shards missing"}
    Declined(["status idle, resolve false"])
    Create["CreateWebWorkerMLCEngine(worker, modelId,<br/>initProgressCallback, chatOptions)"]
    ReadyW(["status ready, badge engine.ram_ready<br/>with the model label, memory not reported"])
    Ready(["status ready, vramMB = round(record.vram_required_MB)<br/>badge engine.vram_ready: label, f16 or f32,<br/>about vramMB / 1024 GB VRAM<br/>engine.vram_ready_no_size without a size"])
    Fail(["loadModel catch: teardown, status error, rethrow<br/>startLocalEngine: notice engine.error.kind<br/>unless cancelled, resolves false;<br/>integrity or unverified: file deleted or refused"])

    Pick --> Pref --> Start --> Probe --> PrefQ
    PrefQ -->|"yes"| Auto
    PrefQ -->|"no"| Manual
    Auto --> Runtime
    Manual --> Runtime
    Runtime -->|"yes"| Wasm --> Same
    Runtime -->|"no, webgpu:key"| NoGpu
    NoGpu -->|"yes"| Unsup --> Fail
    NoGpu -->|"no"| F16
    F16 -->|"yes"| Id16
    F16 -->|"no"| Id32
    Id16 --> Ctx
    Id32 --> Ctx
    Ctx --> Same
    Same -->|"yes"| Reuse
    Same -->|"no"| Missing
    Missing -->|"yes, onlyIfCached"| Silent
    Missing -->|"yes, interactive"| Agree
    Agree -.->|"declined"| Silent
    Agree -.->|"quota too small"| Fail
    Agree -->|"agreed, WASM"| LoadW
    Agree -->|"agreed, WebGPU"| Load
    Missing -->|"no, WASM fully cached"| LoadW
    Missing -->|"no or not known, WebGPU"| Load
    LoadW --> ReadyW
    LoadW -.->|"network, quota or worker error"| Fail
    Load --> Partial
    Partial -->|"yes: onlyIfCached,<br/>or agreeToDownload declined"| Declined
    Partial -->|"no, or agreed"| Create
    Partial -.->|"quota too small"| Fail
    Load -.->|"import fails: code-download,<br/>not in the build: unknown"| Fail
    Create --> Ready
    Create -.->|"network, quota, device-lost,<br/>out-of-memory or other error"| Fail
```

<sub>Sources: [`src/js/webgpu/models.js`](../src/js/webgpu/models.js), [`src/js/webgpu/engine.js`](../src/js/webgpu/engine.js), [`src/js/models/device.js`](../src/js/models/device.js), [`src/js/models/wasm-catalog.js`](../src/js/models/wasm-catalog.js), [`src/js/wasm/client.js`](../src/js/wasm/client.js), [`src/js/engine-ui.js`](../src/js/engine-ui.js), [`src/js/state.js`](../src/js/state.js), [`src/js/settings.js`](../src/js/settings.js), [`src/js/models/choices.js`](../src/js/models/choices.js), [`src/js/models/integrity.js`](../src/js/models/integrity.js), [`src/js/models/bench-history.js`](../src/js/models/bench-history.js), [`src/js/bench/bench-ui.js`](../src/js/bench/bench-ui.js), [`src/js/config.js`](../src/js/config.js), [`src/locales/en.json`](../src/locales/en.json), [`package.json`](../package.json)</sub>

### Device tiers and the model pickers

Until the device is known, both pickers show the static options of index.html: Auto, On-device (automatic) and Own server. When the page is idle, model-picker.js calls getDeviceProbe once (the browser's default adapter, because filling a menu should not wake a discrete GPU; no adapter within 2.5 s counts as no WebGPU) and reads the benchmark history (a short timeout). classifyDevice sorts the device into one of six classes, and recommendModels maps the class to the preset auto resolves to, stepped down a rung when that preset measured below 8 tokens per second on this device class, and to a larger suggestion: a preset that measured above 20 tokens per second, or the 7B preset on a desktop-pro device. Auto never picks a T3 preset, because browsers report no GPU memory and cap `navigator.deviceMemory` at 8 GB; without WebGPU it picks a processor (WASM) model by memory. assistantGroups lists every value once: Recommended (Auto, the device's pick, the suggestion, and the site's default free model: NVIDIA first, then the other pools), On this device (the WebGPU presets by tier and the processor models), the paired companion (only while paired; a stored choice of an unpaired one stays visible, disabled), Free through the site's pools (only pools with keys, for providers the user has no key for), one group per provider the user has a key for (the snapshot merged with the provider's live model list), and the own server (its first model, then the models it listed). WebGPU presets are marked needs WebGPU on a device without it and T3 presets needs a strong GPU unless the device is desktop-pro. A stored value no group offers stays visible in its group, a pool model the site no longer serves disabled and marked not set up. Both pickers are rebuilt on a language switch, a provider or pool change and a new model list, and a pick applies through changeEngine (after 700 ms of rest for arrow keys; refused while an answer is being written). Nothing is downloaded without consent: a new installation starts with Auto.

<!-- diagram: device-tier-selector -->
```mermaid
flowchart TD
    Static(["index.html: static options auto, device, local:*"])
    Idle["initModelPicker: when the page is idle"]
    Probe["getDeviceProbe(): default adapter, once,<br/>no adapter within 2.5 s counts as no WebGPU"]
    Hist["benchmark history, short timeout:<br/>median tok/s per preset and device class"]
    State["providerState(): keys, site pools and their models,<br/>own server and its models, companion paired"]
    Static --> Idle
    Idle --> Probe
    Idle --> Hist
    Idle --> State

    Cls{"classifyDevice(hw)"}
    CPU["cpu-only: no WebGPU"]
    MOB["mobile"]
    LOW["low: buffer under 1 GiB<br/>or memory under 8 GB"]
    PRO["desktop-pro: strong GPU"]
    LAP["laptop: memory hidden"]
    DESK["desktop: memory 8 GB or more"]
    Probe --> Cls
    Cls --> CPU
    Cls --> MOB
    Cls --> LOW
    Cls --> PRO
    Cls --> LAP
    Cls --> DESK

    Rec["recommendModels(hw, history): local = auto pick, never T3<br/>cpu-only: wasm smollm2-135m, smollm2-360m or qwen-0.5b by memory<br/>mobile and low: webgpu llama-1b<br/>others: qwen-1.5b with memory hidden, else qwen-3b<br/>measured under 8 tok/s: one rung lower, again while slow<br/>suggestion: largest preset above 20 tok/s, or qwen-7b on desktop-pro"]
    CPU --> Rec
    MOB --> Rec
    LOW --> Rec
    PRO --> Rec
    LAP --> Rec
    DESK --> Rec
    Hist --> Rec

    Groups["assistantGroups(state): every value once<br/>1 Recommended: Auto, the pick, the suggestion, the site's default free model<br/>2 On this device: WebGPU presets T1 to T3, processor models<br/>3 Companion: only while paired, a stored unpaired choice disabled<br/>4 Free (via Starpi): pools with keys, providers without a user key<br/>5 one group per provider with a key: snapshot plus live list<br/>6 Own server: first model, then its listed models"]
    Warn["warnings: needs WebGPU on cpu-only,<br/>needs a strong GPU for T3 unless desktop-pro,<br/>a stored pool model no longer served: not set up"]
    Rec --> Groups
    State --> Groups
    Warn -.- Groups

    Render["renderModelPickers: engineSelector and cfgComputeMode,<br/>optgroups, auto shown as its pick,<br/>settings badges: GPU support, memory, device class"]
    Groups --> Render
    Again["rebuilt on a language switch, provider, pool<br/>or model list changes"]
    Again -.-> Render
    PickQ{"user picks a value"}
    Render --> PickQ
    PickQ -->|"mouse or touch"| CE
    PickQ -->|"arrow keys"| Settle["after 700 ms of rest, on Enter or on blur"] --> CE
    CE["changeEngine(value, interactive true),<br/>refused while an answer is being written"]
    CE --> Load{"on-device model, not cached?"}
    Load -->|"yes"| Consent(["confirmDownload before any download"])
    Load -->|"no"| Use(["loaded from the cache, or a provider,<br/>pool, own server or companion used"])
```

<sub>Sources: [`src/js/models/device.js`](../src/js/models/device.js), [`src/js/models/choices.js`](../src/js/models/choices.js), [`src/js/model-picker.js`](../src/js/model-picker.js), [`src/js/models/bench-history.js`](../src/js/models/bench-history.js), [`src/js/webgpu/engine.js`](../src/js/webgpu/engine.js), [`src/js/webgpu/models.js`](../src/js/webgpu/models.js), [`src/js/models/wasm-catalog.js`](../src/js/models/wasm-catalog.js), [`src/js/ai/catalog/pools.js`](../src/js/ai/catalog/pools.js), [`src/js/providers.js`](../src/js/providers.js), [`src/js/settings.js`](../src/js/settings.js), [`src/index.html`](../src/index.html)</sub>

### Context packs and the output budget of models on this device

A model on this device answers within an output budget per device class (models/device.js OUTPUT_BUDGETS): 512 tokens without WebGPU and on phones, 768 on small GPUs (class low), 1,024 on laptops, 2,048 on desktops and strong GPUs, always at most half the model's context window, so the conversation keeps the other half. A processor (WASM) model keeps 384 tokens unless the benchmark measured it faster on this device: then it may fill a minute of decoding, in steps of 64 tokens, up to the class's budget. answerTokens() gives a free answer the whole budget and a grounded answer the preset's 512 tokens within it (localAnswerTokens reads the measured rate first, with a 300 ms limit). A smaller budget of 1,024 tokens for free answers on strong GPUs was considered for 3.0 and not adopted: the half-window cap already keeps half the context for the conversation. A grounded or mixed question to a model on this device always gets a context pack (ai/context-pack.js usesPack): the pack's size follows the model's window (a T1 preset's 2,048 tokens gives the small pack: 3 passages of 600 characters; 4,096 still counts as small), the instruction is fixed per mode and language, and packMessages() keeps the earlier turns from the newest backwards while they fit, each cut to 600 characters in a small pack (2,400 otherwise), dropping a leading answer. The pack's coverage tells the source check which passages reached the model in full, cut or not at all. A free question goes as the thread builds it: the history trimmed to the window, and the adapter caps the answer at the budget. The engine streams in its worker; Stop interrupts it, and an answer that is not ready, empty or fails falls back like any other model (the grounded route quotes the sources).

<!-- diagram: model-selection-prompt-budget -->
```mermaid
flowchart TD
    q(["question to a model on this device"])
    cls["device class of the loaded model"]
    table["OUTPUT_BUDGETS: cpu-only 512, mobile 512, low 768,<br/>laptop 1,024, desktop 2,048, desktop-pro 2,048"]
    rt{"runtime?"}
    wasmQ{"processor model measured?"}
    w384["384 tokens"]
    wFast["measured tok/s x 60 s, in steps of 64,<br/>at least 384, at most the class budget"]
    webgpu["the class budget"]
    half["at most half the context window"]
    route{"route?"}
    freeB["free: the whole budget<br/>(the adapter caps the answer)"]
    groundB["grounded: min(preset 512, budget)"]
    pack["context pack: size by the window (2,048 and 4,096: small,<br/>3 passages of 600 chars), fixed instruction,<br/>SOURCES block with the question"]
    turns["packMessages: earlier turns newest first while they fit,<br/>600 chars each in a small pack, 2,400 otherwise"]
    hist["free: thread's history trimmed to the window"]
    gen["engine.generate in starpi-webllm or starpi-wasm,<br/>Stop: interrupt()"]
    cov["coverage per passage for the source check"]
    q --> cls --> table --> rt
    rt -->|"wasm"| wasmQ
    wasmQ -->|"no"| w384 --> half
    wasmQ -->|"yes"| wFast --> half
    rt -->|"webgpu"| webgpu --> half
    half --> route
    route -->|"free"| freeB --> hist --> gen
    route -->|"grounded or mixed"| groundB --> pack --> turns --> gen
    pack -.-> cov
```

<sub>Sources: [`src/js/models/device.js`](../src/js/models/device.js), [`src/js/webgpu/models.js`](../src/js/webgpu/models.js), [`src/js/models/bench-rates.js`](../src/js/models/bench-rates.js), [`src/js/ai/adapters/on-device.js`](../src/js/ai/adapters/on-device.js), [`src/js/ai/context-pack.js`](../src/js/ai/context-pack.js), [`src/js/chat/thread.js`](../src/js/chat/thread.js), [`src/js/webgpu/engine.js`](../src/js/webgpu/engine.js)</sub>

## 4. On-device workspace and citations

Files added to the workspace, or attached to a message, are parsed, chunked and indexed in a dedicated worker and kept on the device; they are never uploaded. Only the excerpts an answer needs leave the device, and only with a model that is not on this device: a provider, a site pool, the own server or the companion get them, labelled with their file name, together with the question. A question asked with the model of this device, and every turn that used a workspace passage, stays on the device and is never part of another model's history or of the encrypted sync. Retrieved chunks are labelled `[Doc: <name>, Chunk: <n>]`; only labels the app registered itself become clickable citations. The worker also records a SHA-256 fingerprint of each file and of its extracted text; answer receipts copy them, so that a cited excerpt can later be reproduced from the same file.

### Keeping files on this device and searching by meaning

The worker runs rag/workspace-core.js, which keeps every document in the app database (store/schema.js) unless the user chose "Memory only": a `docs` record with the fingerprints and the extractor and chunker identity, every chunk with its exact offsets in `chunks`, int8 vectors in `vectors`, and the original bytes and the extracted text in the file store (store/opfs.js: OPFS, or the database's blobs). Files are written first and the records last, in one transaction, so a record never points to missing files; a document whose files are gone is dropped when the worker starts. On start the worker rebuilds the BM25 index from the stored chunks and reads a document's text back only when the citation drawer or a receipt check needs it. The first file asks "Keep files on this device after reload?" in the workspace card; until it is answered files are kept, and the first kept file asks the browser once to protect the site's data (store/quota.js requestPersistence). "Forget all" (the workspace card and Settings → Files on this device) and Clear workspace delete every document, chunk, vector and file. A receipt check without picked files uses the stored originals; picked files are checked on their own.

Semantic search on this device is off until the user turns it on in Settings (desktop-class devices are offered it in the workspace card once files are there). It then loads an embedding model of models/embed-catalog.js (multilingual-e5-small by default, pinned to the revision and files the shared library's vectors were computed with) in a WASM worker of its own (wasm/worker.js embed, rag/embed-client.js), embeds every chunk without a vector in batches of 16 ("passage: " prefix, mean pooling, L2-normalised), and stores the vectors int8-quantised with their scale. A question is embedded with the "query: " prefix; workspace.js asks the worker for searchHybrid when the workspace has vectors and the question's vector arrives within 2 s (retrieval.js searchWithQueryVector), which fuses the BM25 top 50 and the cosine top 50 with reciprocal rank fusion (k = 60, rag/hybrid.js fuseRrf); otherwise it searches with BM25 alone. In on-device mode the same vector ranks the shared library through match_knowledge_vector_384, so the question text stays on the device. workspaceProbe(question) returns the normalised best BM25 score and the share of the question's terms in the best chunk for the Auto mode.

### On-device workspace: from file drop to the document list

Files dropped on dropZone or picked in workspaceFileInput go through addFiles one at a time; names outside WORKSPACE_EXTENSIONS are rejected on the main thread and the rest are structured-cloned to the lazily created module worker (its URL patched in by scripts/build.mjs) in an ingest request. The status line keeps one line per finished file and shows the current file's progress below them: reading while the worker fingerprints the file, then parsing, chunking and indexing. A file whose fingerprint and chunk settings match a document already in this worker is not indexed again: the worker returns that document with duplicate true and the list stays unchanged. Otherwise the worker extracts the text, chunks it with chunkText (500/50, no caller overrides them), gives the document a unique name and the id ws-instanceId-N and adds the chunks to its BM25Index. A ParseError returns as ok false with its code (any other exception as internal) and is reported as workspace.error_<code>; a worker error or messageerror event rejects every pending request with worker_crashed and resets the workspace; success appends the document and re-renders workspaceList.

<!-- diagram: workspace-ingestion-sequence -->
```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as ingest.js
    participant WS as rag/workspace.js
    participant W as ingest.worker.js
    participant P as parser.js
    participant CH as chunker.js
    participant IX as bm25.js BM25Index

    Note over UI,WS: chat/composer.js (a document attached to a message) and demo.js loadSamples<br/>also call addToWorkspace(file), without the extension filter or progress
    User->>UI: drop on dropZone, or pick in workspaceFileInput
    loop addFiles, one file at a time, each awaited
        alt name does not match WORKSPACE_EXTENSIONS
            UI-->>User: report line workspace.error_unsupported_type, next file
        else pdf, txt, md, markdown, json, csv or log
            UI-->>User: report lines plus workspace.progress_parsing 0 of 1
            UI->>WS: addToWorkspace(file, onProgress)
            WS->>W: request() posts id, type ingest, payload file (structured clone)
            Note over WS,W: getWorker() creates the module worker starpi-ingest on first use,<br/>its URL is the hashed ingest-worker entry patched in by scripts/build.mjs
            W-->>WS: progress reading 0 of 1
            Note over UI,WS: each progress message calls onProgress: the current line becomes<br/>workspace.progress_ plus stage, reading shows Fingerprinting
            W->>W: fileSha256 of the file bytes, or null,<br/>then the duplicate check, see workspace-ingestion-worker
            alt same fileSha256 and chunk settings as a document in this worker
                W-->>WS: ok true, that DocumentInfo with duplicate true
                WS-->>UI: returned without changing docs or calling notify()
                UI-->>User: report line workspace.duplicate with the existing name
            else a new file
                W-->>WS: progress parsing 0 of 1
                W->>P: extractText(file, onPage)
                opt PDF
                    P-->>W: onPage(i, pages) after each page
                    W-->>WS: progress parsing i of pages
                end
                alt extractText or a later step of ingest throws
                    P-->>W: ParseError with a code, or another exception
                    W-->>WS: ok false, error code (internal if not a ParseError), message, details
                    WS-->>UI: reject WorkspaceError(code)
                    UI-->>User: report line workspace.error_ plus code, unlisted codes as internal
                else worker error or messageerror event
                    W--xWS: error event, no reply
                    WS-->>UI: failAll rejects with worker_crashed, reset() drops the worker
                    UI-->>User: report line workspace.error_worker_crashed, see workspace-ingestion-reset
                else text extracted
                    P-->>W: text, kind, pages, pdf.js version for PDFs
                    W->>W: textSha256 = SHA-256 of the normalized text
                    W-->>WS: progress chunking 0 of 1
                    W->>W: name = uniqueName(file.name), numbered when the name is taken
                    W->>CH: chunkText(text), chunkSize 500, chunkOverlap 50
                    CH-->>W: chunks with index, start, end, text
                    W->>W: docId = ws-instanceId-N, instanceId random per worker
                    W-->>WS: progress indexing 0 of chunk count
                    W->>IX: add(chunks) with docId, docName = the unique name, chunkIndex
                    W->>W: documents.set(docId, DocumentInfo plus full text)
                    W-->>WS: progress indexing n of n
                    W-->>WS: ok true, DocumentInfo
                    WS->>UI: docs = docs plus doc, notify() runs the onWorkspaceChange listener renderWorkspace()
                    UI-->>User: workspaceList row per document, report line workspace.added
                end
            end
        end
        Note over UI: after each file show(null) leaves the report lines without a progress line
    end
```

<sub>Sources: [`src/js/ingest.js`](../src/js/ingest.js), [`src/js/chat/composer.js`](../src/js/chat/composer.js), [`src/js/demo.js`](../src/js/demo.js), [`src/js/rag/workspace.js`](../src/js/rag/workspace.js), [`src/js/rag/ingest.worker.js`](../src/js/rag/ingest.worker.js), [`src/js/rag/parser.js`](../src/js/rag/parser.js), [`src/js/rag/chunker.js`](../src/js/rag/chunker.js), [`src/js/rag/bm25.js`](../src/js/rag/bm25.js), [`scripts/build.mjs`](../scripts/build.mjs), [`src/index.html`](../src/index.html), [`src/locales/en.json`](../src/locales/en.json)</sub>

### ingest() in the worker: fingerprint, duplicate check, unique name and DocumentInfo

The worker fingerprints the file before parsing, because pdf.js takes ownership of (detaches) the buffer it reads: fileSha256 is the SHA-256 of the file bytes, or null without crypto.subtle or when the file is larger than MAX_FILE_BYTES (extractText then rejects it: too_large, or unsupported_type when the extension is not supported). A document already in this worker with the same fileSha256 and the same chunk size and overlap is returned with duplicate true and is not parsed or indexed again; the check covers only the current worker, so after a remove, Clear workspace or a crash the same file is indexed anew. A file that is not a duplicate but whose name is taken gets the first free name of the form report (2).pdf, so every citation label names exactly one document. textSha256 is the SHA-256 of the extracted, normalized text as UTF-8; it has no null fallback, because sha256Hex calls crypto.subtle directly, so without it the ingest fails as internal. The DocumentInfo also records the byte size, the extractor (starpi-extract version 1, plus the pdf.js version for PDFs) and the chunker (starpi-chunk version 1 with size and overlap); answer receipts copy these fields.

<!-- diagram: workspace-ingestion-worker -->
```mermaid
flowchart TD
    start(["ingest(id, payload) in ingest.worker.js"]) --> pRead["progress reading 0 of 1"]
    pRead --> subtleQ{"crypto.subtle available and<br/>file.size at most MAX_FILE_BYTES 25 MiB?"}
    subtleQ -->|"yes"| fsha["fileSha256 = sha256Hex(await file.arrayBuffer())<br/>taken before parsing: pdf.js detaches the buffer it reads"]
    subtleQ -->|"no"| fnull["fileSha256 = null"]
    fsha --> opts["size = payload.chunkSize, 500 when not given<br/>overlap = payload.chunkOverlap, 50 when not given<br/>no caller sets them"]
    fnull --> opts
    opts --> dupQ{"fileSha256 set and a document in this worker<br/>with the same fileSha256, chunker.size<br/>and chunker.overlap?"}
    dupQ -->|"yes"| dup(["return a copy of its DocumentInfo without the text,<br/>duplicate true, nothing is parsed or indexed"])
    dupQ -->|"no"| parse["progress parsing 0 of 1<br/>extractText(file, onPage), see workspace-ingestion-extract-text"]
    parse -->|"throws"| perr(["ParseError code, or internal:<br/>the worker replies ok false"])
    parse -->|"text, kind, pages, pdfjs"| tsha["textSha256 = sha256Hex(text)<br/>the normalized text as UTF-8"]
    tsha -->|"crypto.subtle missing: TypeError"| perr
    tsha --> pChunk["progress chunking 0 of 1"]
    pChunk --> nameQ{"file.name already used by<br/>a document in this worker?"}
    nameQ -->|"no"| keepName["name = file.name"]
    nameQ -->|"yes"| numName["name = stem (n) ext with the first free n from 2<br/>report.pdf becomes report (2).pdf, a name without<br/>a dot after its first character gets the suffix at the end"]
    keepName --> chunk
    numName --> chunk
    chunk["chunks = chunkText(text, chunkSize size, chunkOverlap overlap)"] --> docId["docId = ws-instanceId-N, N = nextId++<br/>instanceId = crypto.randomUUID() once per worker"]
    docId --> add["progress indexing 0 of chunk count<br/>index.add: docId, docName name, chunkIndex, start, end, text"]
    add --> info["DocumentInfo: docId, name, kind, chars, chunks, pages,<br/>bytes = file.size, fileSha256, textSha256,<br/>extractor = starpi-extract version 1 plus pdfjs,<br/>chunker = starpi-chunk version 1 plus size and overlap"]
    info --> keep["documents.set(docId, DocumentInfo plus the text)<br/>progress indexing n of n"]
    keep --> ok(["return DocumentInfo: the worker replies ok true"])
```

<sub>Sources: [`src/js/rag/ingest.worker.js`](../src/js/rag/ingest.worker.js), [`src/js/rag/parser.js`](../src/js/rag/parser.js), [`src/js/rag/chunker.js`](../src/js/rag/chunker.js), [`src/js/core/receipt.js`](../src/js/core/receipt.js), [`src/js/rag/workspace.js`](../src/js/rag/workspace.js)</sub>

### extractText: checks, text, JSON, CSV, Office, HTML and images

extractText rejects unsupported extensions and files above MAX_FILE_BYTES (25 MiB) before reading anything. PDFs go to pdfToText; Word, Excel and PowerPoint files (DOCX, XLSX, PPTX) to the dependency-free readers of rag/formats, which open the ZIP package with zip.js and read its XML with a small parser; HTML pages to html.js, which runs and loads nothing (scripts, styles and embedded objects are skipped; headings, lists and tables keep their structure); images (PNG, JPEG, GIF, WebP) to image.js; every other type is decoded incrementally with TextDecoderStream, cancelling the reader once the text exceeds MAX_TEXT_CHARS (5,000,000). The ZIP reader treats an archive as untrusted: before anything is inflated it refuses more than 10,000 entries, an entry above 64 MiB, more than 160 MiB in all, a compression ratio above 200 for entries over 1 MiB and entries whose data overlap; an entry that inflates beyond its declared size is stopped at once, every CRC-32 is checked, and a name with an absolute path, a drive letter, `..` or control characters is unreadable. The XML parser decodes only the five predefined entities and character references, never expands the entity declarations of a DOCTYPE, and refuses nesting deeper than 256 levels; failures are zip_bomb, invalid_document or encrypted_document. The Office and HTML readers stop at MAX_TEXT_CHARS too. An image holds no text the extractor can read: without an OCR hook it fails with needs_ocr, and the workspace asks the user whether a model that can see may read that one file (rag/ocr-hook.js, purpose ocr_image); with consent the hook sends the image to that model and the recognised text is indexed like any other, the provider and model recorded for receipts. JSON is flattened into path: value lines; CSV with a usable header row becomes one `column: value; column: value` line per row. Every result is normalized (BOM, line endings, control characters) and rejected as empty when only whitespace remains. The extractor identity (`starpi-extract` version 2) is recorded in each document; version 2 added the Office and HTML formats and keeps the text of every earlier format byte for byte, so receipts of version 1 still verify.

<!-- diagram: workspace-ingestion-extract-text -->
```mermaid
flowchart TD
    start(["extractText(file, onPage, ocr) in the worker"]) --> ext["ext = extensionOf(file.name), lowercased"]
    ext --> supQ{"ext in SUPPORTED_EXTENSIONS or IMAGE_EXTENSIONS?<br/>txt, md, markdown, csv, log, json, pdf,<br/>docx, xlsx, pptx, html, htm; png, jpg, jpeg, gif, webp"}
    supQ -->|"no"| eType["unsupported_type"]
    supQ -->|"yes"| sizeQ{"file.size above 25 MiB?"}
    sizeQ -->|"yes"| eBig["too_large"]
    sizeQ -->|"no"| kindQ{"ext?"}
    kindQ -->|"pdf"| pdf["pdfToText, see workspace-ingestion-pdf"]
    kindQ -->|"docx, xlsx, pptx"| office["formats/docx.js, xlsx.js, pptx.js:<br/>zip.js package, xml.js parser, maxChars 5,000,000"]
    office --> zipQ{"ZIP limits: 10,000 entries, 64 MiB per entry,<br/>160 MiB in all, ratio 200 above 1 MiB,<br/>no overlap, CRC-32, safe names?"}
    zipQ -->|"no"| eZip["zip_bomb, invalid_document<br/>or encrypted_document"]
    zipQ -->|"yes"| xmlQ{"XML: DOCTYPE entities never expanded,<br/>depth at most 256?"}
    xmlQ -->|"no"| eZip
    xmlQ -->|"yes"| norm
    kindQ -->|"html, htm"| html["decodeHtmlBytes, htmlToText: scripts and styles skipped,<br/>headings, lists and tables kept, maxChars 5,000,000"]
    html --> norm
    kindQ -->|"image"| img["imageToText: type from the bytes, size read"]
    img --> ocrQ{"OCR hook for this file<br/>(the user agreed)?"}
    ocrQ -->|"no"| eOcr["needs_ocr with purpose ocr_image:<br/>the workspace asks for consent"]
    ocrQ -->|"yes"| ocr["hook: image to a model that can see,<br/>recognised text, provider and model recorded"]
    ocr --> norm
    kindQ -->|"json, csv, txt, md, log"| read["streamToText: TextDecoderStream,<br/>cancelled above 5,000,000 chars: too_large"]
    read --> typeQ{"ext?"}
    typeQ -->|"json"| flat["JSON.parse, flattenJson: path: value lines;<br/>invalid_json on a parse error"]
    typeQ -->|"csv"| csv["csvToText: column: value lines,<br/>see workspace-ingestion-csv"]
    typeQ -->|"txt, md, log"| norm
    flat --> norm
    csv --> norm
    pdf --> norm
    norm["normalizeText: BOM, line endings, control characters"]
    norm --> emptyQ{"only whitespace?"}
    emptyQ -->|"yes"| eEmpty["empty"]
    emptyQ -->|"no"| ok(["text, kind, pages and pdfjs for a PDF;<br/>EXTRACTOR starpi-extract version 2"])
```

<sub>Sources: [`src/js/rag/parser.js`](../src/js/rag/parser.js), [`src/js/rag/formats/zip.js`](../src/js/rag/formats/zip.js), [`src/js/rag/formats/xml.js`](../src/js/rag/formats/xml.js), [`src/js/rag/formats/ooxml.js`](../src/js/rag/formats/ooxml.js), [`src/js/rag/formats/docx.js`](../src/js/rag/formats/docx.js), [`src/js/rag/formats/xlsx.js`](../src/js/rag/formats/xlsx.js), [`src/js/rag/formats/pptx.js`](../src/js/rag/formats/pptx.js), [`src/js/rag/formats/html.js`](../src/js/rag/formats/html.js), [`src/js/rag/formats/image.js`](../src/js/rag/formats/image.js), [`src/js/rag/ocr-hook.js`](../src/js/rag/ocr-hook.js), [`src/js/rag/ingest.worker.js`](../src/js/rag/ingest.worker.js)</sub>

### csvToText: CSV rows as column: value lines

csvToText picks the delimiter that occurs most often in the first line (comma, semicolon or tab, the earlier one in that order on a tie) and returns the text unchanged when none occurs. parseCsv splits the text with RFC 4180 quoting (a quoted field may contain the delimiter, doubled quotes and line breaks) and drops rows whose fields are all blank. The header row is usable only when every trimmed column name is non-empty and not made only of digits, dots, commas, hyphens and whitespace, no two names are equal ignoring case, and every row has as many fields as the header; otherwise the text stays as it is. Each data row then becomes one line of `column: value` pairs joined by a semicolon and a space, with whitespace in values collapsed and empty values left out, so each row reads as one statement.

<!-- diagram: workspace-ingestion-csv -->
```mermaid
flowchart TD
    start(["csvToText(text), called with the normalized text"]) --> first["firstLine = text up to the first newline"]
    first --> delim["count commas, semicolons and tabs in firstLine<br/>delimiter = the most frequent,<br/>on a tie the first of comma, semicolon, tab"]
    delim --> zeroQ{"count 0?"}
    zeroQ -->|"yes"| same(["return text unchanged"])
    zeroQ -->|"no"| parse["parseCsv(text, delimiter): RFC 4180 quoting,<br/>a quote opens only at the start of a field,<br/>a doubled quote inside becomes one quote,<br/>quoted fields may hold the delimiter and line breaks"]
    parse --> blank["drop rows whose fields are all blank"]
    blank --> rowsQ{"at least 2 rows?"}
    rowsQ -->|"no"| same
    rowsQ -->|"yes"| header["header = the first row, names trimmed"]
    header --> usableQ{"every name non-empty and not only digits,<br/>dots, commas, hyphens and whitespace,<br/>names unique ignoring case,<br/>every row as long as the header?"}
    usableQ -->|"no, e.g. numeric or duplicate names, ragged rows"| same
    usableQ -->|"yes"| rows["each data row: header name with its value,<br/>whitespace in values collapsed and trimmed,<br/>empty values left out"]
    rows --> line["pairs written as column: value,<br/>joined by a semicolon and a space"]
    line --> drop["rows without any value dropped,<br/>lines joined with a newline"]
    drop --> out(["return the converted text"])
```

<sub>Sources: [`src/js/rag/parser.js`](../src/js/rag/parser.js)</sub>

### pdfToText: pdf.js loading, page loop and limits

pdfToText imports the pdf.js legacy build on first use (the pdf.js worker module first, so parsing runs in the ingestion worker's own thread; the legacy build carries polyfills for newer built-ins) and caches that promise. A failed import is not cached: the promise is reset, the file fails with pdf_reader and the next PDF tries again. A PasswordException becomes encrypted_pdf and any other open failure invalid_pdf; at most MAX_PDF_PAGES (2000) pages are read, each page reports progress through onPage, and the text is rejected as too_large once the page texts exceed 5,000,000 characters. Page-read failures are not ParseErrors and reach the UI as internal, and task.destroy() runs in a finally block only after the document has opened. The result carries the pdf.js version string.

<!-- diagram: workspace-ingestion-pdf -->
```mermaid
flowchart TD
    start(["pdfToText(buffer, onPage)"]) --> load["loadPdfjs(): pdfjsPromise ??= import of<br/>pdfjs-dist/legacy/build/pdf.worker.mjs, then pdf.mjs,<br/>so pdf.js parses in this worker's thread"]
    load --> loadQ{"imports resolve?"}
    loadQ -->|"no"| eImport["pdf_reader with the import error message<br/>pdfjsPromise = null, the next PDF imports again"]
    loadQ -->|"yes, the promise stays cached"| open["getDocument: data as Uint8Array, disableFontFace,<br/>useSystemFonts false, isOffscreenCanvasSupported false,<br/>stopAtErrors false, verbosity ERRORS"]
    open --> openQ{"await task.promise"}
    openQ -->|"PasswordException"| eEnc["encrypted_pdf"]
    openQ -->|"any other error"| eBad["invalid_pdf<br/>message from pdf.js"]
    openQ -->|"resolved"| pages["pages = min(numPages, MAX_PDF_PAGES 2000)<br/>later pages are never read"]
    pages --> page["page i: getPage, getTextContent,<br/>append each item.str, a newline after hasEOL,<br/>otherwise a space unless item.str is empty<br/>or ends in whitespace, items without str skipped"]
    page -->|"getPage or getTextContent throws"| ePage["not a ParseError: code internal"]
    page --> clean["page.cleanup(), drop spaces and tabs before newlines,<br/>trim, keep the page text when not empty"]
    clean --> lenQ{"summed page text length above<br/>MAX_TEXT_CHARS 5,000,000?"}
    lenQ -->|"yes"| eLong["too_large<br/>details max 5000000"]
    lenQ -->|"no"| onPage["onPage(i, pages): the worker posts<br/>progress parsing i of pages"]
    onPage -->|"i below pages"| page
    onPage -->|"last page"| finished(["return text = page texts joined by a blank line,<br/>pages, and pdfjs = the pdf.js version"])
    fin["finally: await task.destroy()<br/>only once the document has opened"]
    eLong -.->|"finally"| fin
    ePage -.->|"finally"| fin
    finished -.->|"finally"| fin

    subgraph sg_perr["ParseError: the worker replies ok false with this code"]
        eImport
        eEnc
        eBad
        eLong
    end
```

<sub>Sources: [`src/js/rag/parser.js`](../src/js/rag/parser.js), [`src/js/rag/ingest.worker.js`](../src/js/rag/ingest.worker.js), [`src/locales/en.json`](../src/locales/en.json)</sub>

### Workspace RPCs: search, head, context, text, remove, clear

Every workspace call goes through request(), which posts {id, type, payload} to the worker and settles on the reply with the same id. searchWorkspace resolves to an empty list without sending anything when there are no documents or the query is blank; the worker clamps topK to 1..50 (default 5), head counts to 1..10 (default 3) and the context pad to 0..2000 (default 300, workspace.js sends 400). The thread (chat/thread.js) asks for the top 6 (LIMITS.retrievalRows) and for the first 3 chunks of an attached file when none of the hits comes from it, and reads the whole text of a document attached to a message once (getDocumentText), which the attachment then keeps; the workspace search form and the demo's check answer ask for 5. context and text reply with code empty for an unknown docId while head replies with an empty list, and the thread swallows any retrieval rejection. clearWorkspace rejects pending calls with cleared and sends the worker's clear request, which empties memory and deletes the stored documents; an ingest that started before the clear is cancelled with cleared. The remaining request type besides ingest, verify-receipt, is shown in workspace-ingestion-verify-receipt.

<!-- diagram: workspace-ingestion-rpcs -->
```mermaid
sequenceDiagram
    autonumber
    participant ING as ingest.js
    participant CHAT as chat/thread.js
    participant CIT as rag/citations.js
    participant WS as rag/workspace.js
    participant W as ingest.worker.js
    participant IX as bm25.js BM25Index

    Note over WS,W: request() posts id, type, payload and settles on the<br/>ok true or ok false reply with the same id,<br/>progress messages only call onProgress
    CHAT->>WS: retrieveWorkspace calls searchWorkspace(prompt, LIMITS.retrievalRows 6)
    Note over ING,CHAT: the ingest.js search form and demo.js showCheckDemo<br/>call searchWorkspace(query, 5)
    alt docs empty or blank query
        WS-->>CHAT: empty list, no request is sent
    else documents present
        WS->>W: search, query and topK
        W->>IX: search(query, topK), topK = Number(topK) or 5, clamped to 1..50
        IX-->>W: hits with a score above 0, best first
        W-->>WS: docId, docName, chunkIndex, start, end, text, score, matchedTerms
        WS-->>CHAT: WorkspaceHit list
    end
    opt a file is attached and none of the hits comes from it
        CHAT->>WS: firstChunks(docId, 3)
        WS->>W: head, count clamped to 1..10 (default 3)
        W-->>WS: first index entries of docId, score 0, empty list for an unknown docId
        WS-->>CHAT: pinned in front of the hits, see chat-request-workspace-merge
    end
    Note over CHAT,WS: any rejection here is caught, logged with console.warn,<br/>and the chat continues without workspace hits
    opt a document attached to a message: storeQuestion
        CHAT->>WS: getDocumentText(docId)
        WS->>W: text, docId
        W-->>WS: name and full text
        Note over CHAT: kept as the attachment's text, fitted to the model's budget<br/>when a model gets the question, see attachments-voice-ask
        Note over CHAT,WS: a rejection is ignored, the text is read from the blob when needed
    end
    CIT->>WS: getChunkContext(docId, start, end)
    WS->>W: context, pad 400 (worker uses Number(pad) or 300, clamped to 0..2000)
    alt docId in documents
        W-->>WS: before, match, after, start, end (clamped to the text), length
    else unknown docId
        W-->>WS: ok false, code empty
    end
    ING->>WS: getDocumentText(docId) from the workspace-to-form button
    WS->>W: text, docId
    W-->>WS: name and full text, or ok false with code empty
    WS-->>ING: resolves or rejects, copyToForm fills the ingest form<br/>(workspace.truncated above LIMITS.ingestContentChars 200000)<br/>or shows workspace.error_empty
    ING->>WS: removeFromWorkspace(docId) from the workspace-remove button
    WS->>W: remove, docId
    W->>IX: remove(docId), df and totalLength reduced
    W-->>WS: removed chunk count, documents entry deleted
    WS->>ING: docs filtered, notify() re-renders the list
    ING->>WS: clearWorkspace() after window.confirm
    WS->>WS: failAll rejects pending requests with cleared
    WS->>W: clear
    W->>IX: clear(), documents, vectors and stored copies deleted
    WS->>ING: docs emptied, notify()
    ING->>ING: workspaceResults emptied, status workspace.cleared
    Note over W,IX: rag/receipts.js sends verify-receipt through verifyReceiptFiles,<br/>see workspace-ingestion-verify-receipt
```

<sub>Sources: [`src/js/rag/workspace.js`](../src/js/rag/workspace.js), [`src/js/rag/ingest.worker.js`](../src/js/rag/ingest.worker.js), [`src/js/rag/bm25.js`](../src/js/rag/bm25.js), [`src/js/ingest.js`](../src/js/ingest.js), [`src/js/chat/thread.js`](../src/js/chat/thread.js), [`src/js/demo.js`](../src/js/demo.js), [`src/js/rag/citations.js`](../src/js/rag/citations.js), [`src/js/rag/receipts.js`](../src/js/rag/receipts.js), [`src/js/config.js`](../src/js/config.js), [`src/js/prompts.js`](../src/js/prompts.js)</sub>

### verify-receipt: re-checking an answer receipt against the original files

The receipt dialog's verify mode reads the chosen receipt file (at most RECEIPT_LIMITS.bytes, 2,000,000 bytes), parses it as JSON on the main thread, reads an optional public key of the signer (a JWK or PEM file of at most MAX_KEY_BYTES, 16,384 bytes) as text and sends both with the chosen original files to the ingestion worker, because extraction and chunking are too heavy for the UI thread; nothing is added to the workspace. The worker validates the receipt as starpi.receipt/v2 or v1 with its size limits, each format with its own list of members (a v1 receipt with a Merkle tree, a proof or a signature is refused) and of reason codes (REASON_CODES_V1 for v1, REASON_CODES for v2), and replies with the first invalid path instead of throwing; a key that importPublicKey cannot read ends the check with invalidKey. It takes the first 20 chosen files (MAX_VERIFY_FILES) and skips any of them above MAX_FILE_BYTES. For a v2 receipt verifyReceipt first recomputes the Merkle root, checks every inclusion proof and the signature, if there is one, against the chosen key or else the key embedded in the receipt (receipts-merkle-signature). For each workspace citation that carries a file fingerprint it looks for a provided file with the same SHA-256, extracts that file once with the worker's own extractText, and compares the text fingerprint, the passage at the recorded offsets and the chunk bounds that chunkText gives with the recorded size and overlap; a file that cannot be extracted adds a warning and leaves those three checks empty. A match shows that the cited excerpt can be reproduced from the same file under the recorded rules. The source-check verdicts are then recomputed on the excerpt texts in the receipt, or, when a text was left out or does not match its fingerprint, on the matching passage, unless the excerpt was truncated or never reached the model; for a partly delivered excerpt only its first deliveredChars characters count, and without deliveredChars that excerpt counts as unavailable; a statement is not recomputed when one of its cited excerpts, or of the other excerpts its reasons name, is unavailable, and the verdicts are recomputed with the rules version the receipt records. The app does not sign receipts, and a signature checked only with the key embedded in the receipt shows that the receipt is unchanged since signing, not who signed it; the check does not show what a model saw or that the answer's reasoning is right. Section 12 (receipts-verify) draws the same check in more detail, with the recomputed source check and the command-line script.

<!-- diagram: workspace-ingestion-verify-receipt -->
```mermaid
flowchart TD
    vStart(["verify-receipt button in the receipt dialog"]) --> hasQ{"a file chosen in receiptFile?"}
    hasQ -->|"no"| needR["receipt.verify_need_receipt"]
    hasQ -->|"yes"| sizeQ{"receiptFile.size above<br/>RECEIPT_LIMITS.bytes 2,000,000?"}
    sizeQ -->|"yes"| invSize["receipt.verify_invalid, reason size"]
    sizeQ -->|"no"| jsonQ{"JSON.parse of its text succeeds?"}
    jsonQ -->|"no"| invJson["receipt.verify_invalid, reason JSON"]
    jsonQ -->|"yes"| keySize{"a key file chosen in receiptPublicKey<br/>above MAX_KEY_BYTES 16384?"}
    keySize -->|"yes"| badSize["receipt.verify_bad_key, reason size"]
    keySize -->|"no"| send["receipt.verify_running, then verifyReceiptFiles:<br/>request verify-receipt with the receipt,<br/>the files chosen in receiptSources and<br/>the key file's text, or null without one"]
    send -.->|"rejects, e.g. worker crash or Clear workspace"| rej["receipt.verify_invalid with the error message"]
    send --> valQ{"validateReceipt in the worker: schema starpi.receipt/v2 or v1,<br/>only the members of that format, field types, hex fingerprints,<br/>size limits, reason codes from REASON_CODES, for v1 from<br/>REASON_CODES_V1, for v2 a merkle record and a proof<br/>per citation, a signature with alg, keyId, publicKey and value?"}
    valQ -->|"no"| inv["reply invalid with error and path<br/>receipt.verify_invalid, reason error (path)"]
    valQ -->|"yes"| keyQ{"key text sent?"}
    keyQ -->|"yes"| impQ{"importPublicKey reads it: a public JWK<br/>or PEM SPKI key, Ed25519 or P-256,<br/>a JWK with a private member d refused?"}
    impQ -->|"no"| badKey["reply invalidKey with the error message,<br/>receipt.verify_bad_key, nothing verified"]
    impQ -->|"yes"| files
    keyQ -->|"no"| files["the first MAX_VERIFY_FILES 20 chosen files,<br/>any above MAX_FILE_BYTES skipped, the rest read into bytes,<br/>nothing is added to the workspace"]
    files --> hashes["verifyReceipt with publicKey: idMatches from the receipt hash,<br/>answerMatches from the answer hash"]
    hashes --> v2Q{"schema starpi.receipt/v2?"}
    v2Q -->|"yes"| tree["Merkle root recomputed from the citations, every<br/>inclusion proof checked, signature status valid, invalid,<br/>unsigned, key_mismatch or unsupported_algorithm,<br/>see receipts-merkle-signature"]
    v2Q -->|"no, v1"| noTree["merkle and signature null,<br/>proof null for every citation"]
    tree --> byHash["provided files keyed by the SHA-256 of their bytes"]
    noTree --> byHash
    byHash --> exc["next citation: an excerpt text in the receipt that<br/>does not match its recorded SHA-256 adds a warning"]
    exc --> citQ{"workspace source with a document,<br/>a chunk and a fileSha256?"}
    citQ -->|"no, e.g. knowledge base"| nv["file not_verifiable"]
    citQ -->|"yes"| fileQ{"a provided file with that fileSha256?"}
    fileQ -->|"no"| miss["file missing"]
    fileQ -->|"yes"| extr["file match: extractText on a File named document.<br/>plus the recorded kind, e.g. document.pdf,<br/>once per fingerprint"]
    extr --> extrQ{"extraction succeeds?"}
    extrQ -->|"no"| extrErr["the error message becomes a warning,<br/>text, passage and chunk stay unchecked"]
    extrQ -->|"yes"| tCheck["text: match when its SHA-256 equals textSha256,<br/>else version_differs when the extractor id or version differ,<br/>or both pdf.js versions are known and differ, else mismatch;<br/>a version difference also adds a warning"]
    tCheck --> pCheck["passage at the recorded start and end: match when<br/>its SHA-256 equals the recorded chunk or excerpt hash,<br/>moved when the receipt's excerpt text matches its hash<br/>and, whitespace collapsed and a final ellipsis dropped,<br/>occurs in the text, else mismatch"]
    pCheck --> cCheck["chunk: chunkText with the recorded size and overlap,<br/>match when the chunk at the recorded index has the same<br/>start and end, else version_differs when the recorded<br/>chunker id or version differ, else mismatch;<br/>a RangeError counts as no match"]
    nv --> moreQ
    miss --> moreQ
    extrErr --> moreQ
    cCheck --> moreQ{"more citations?"}
    moreQ -->|"yes"| exc
    moreQ -->|"no"| report(["VerifyReport: schema, passages that match of citations marked verifiable,<br/>merkle and signature results and a proof flag per citation for v2,<br/>source-check verdicts recomputed with the recorded rules version<br/>on the excerpt texts or matching passages,<br/>a partly delivered excerpt only on its first deliveredChars characters,<br/>skipping statements whose cited or other named excerpts are unknown,<br/>compared with the recorded ones, warnings, shown by renderReport,<br/>see receipts-verify"])
```

<sub>Sources: [`src/js/rag/receipts.js`](../src/js/rag/receipts.js), [`src/js/rag/workspace.js`](../src/js/rag/workspace.js), [`src/js/rag/ingest.worker.js`](../src/js/rag/ingest.worker.js), [`src/js/core/receipt.js`](../src/js/core/receipt.js), [`src/js/core/signature.js`](../src/js/core/signature.js), [`src/js/rag/parser.js`](../src/js/rag/parser.js), [`src/js/rag/chunker.js`](../src/js/rag/chunker.js), [`src/index.html`](../src/index.html), [`src/locales/en.json`](../src/locales/en.json)</sub>

### Worker crash, Clear workspace and restart

A worker error or messageerror event ends in failAll plus reset(): every pending request rejects with worker_crashed, the worker is terminated and the document list is emptied; the next request starts a worker that restores the stored documents. A confirmed Clear workspace rejects pending requests with cleared and then deletes every document in the running worker and on this device. Each caller handles the rejection in its own way (a status line, a chat notice, the demo's error notice, retrieval without workspace hits, citation.note_missing, a receipt check message, a logged error; the workspace search form does not catch it). The next request starts a fresh worker with a new random instanceId and an empty document map, so its document ids (ws-instanceId-n) never repeat an earlier one, an old citation span always ends in citation.note_missing, and a file added again is indexed anew instead of being reported as a duplicate.

<!-- diagram: workspace-ingestion-reset -->
```mermaid
flowchart TD
    crash(["worker error or messageerror event<br/>for example the worker script fails to load"])
    failCrash["console.error, then<br/>failAll(WorkspaceError worker_crashed)"]
    clickClear(["workspace-clear button"])
    confirmQ{"window.confirm(workspace.clear_confirm)?"}
    keepAll(["nothing changes"])
    failClear["clearWorkspace(): failAll(WorkspaceError cleared),<br/>then the worker's clear request deletes every document<br/>from memory and from this device"]
    reset["reset(): worker.terminate(), worker = null"]
    docsQ{"docs non-empty?"}
    emptyDocs["docs = [], notify()<br/>renderWorkspace shows workspaceEmpty"]
    idle["no worker: documents, chunks and index are gone"]
    uiClear["ingest.js empties workspaceResults,<br/>status workspace.cleared"]
    pending["every pending request rejects with that WorkspaceError"]
    rIngest["addFiles: report line workspace.error_worker_crashed<br/>or workspace.error_cleared, the report replaces<br/>workspace.cleared, then the next file"]
    rAttach["chat readAttachment, if still the current attachment:<br/>chip removed, workspace.error_title notice"]
    rDemo["demo.js loadSamples: its loading notice<br/>turns into demo.error_title with the reason"]
    rChat["chat retrieveWorkspace: console.warn,<br/>the answer gets no workspace hits"]
    rCtx["citation drawer: citation.note_missing,<br/>unless another citation was opened since"]
    rVerify["receipt verify: receipt.verify_invalid<br/>with the error message"]
    rText["copyToForm: status workspace.error_empty"]
    rRemove["workspace-remove and the demo's check answer:<br/>rejection logged by reportUnexpected"]
    rSearch["workspace search form: the rejection is not caught,<br/>the browser reports it as unhandled"]
    fresh(["next request(): getWorker() starts a fresh worker,<br/>empty index and documents, new random instanceId, nextId = 1"])
    reuse["new files get ws-instanceId-1, ws-instanceId-2:<br/>an old citation span never matches them<br/>and shows citation.note_missing,<br/>a file added again is not a duplicate"]

    crash --> failCrash
    failCrash --> reset
    clickClear --> confirmQ
    confirmQ -->|"no"| keepAll
    confirmQ -->|"yes"| failClear
    failClear --> emptyDocs
    failCrash -.->|"rejects"| pending
    failClear -.->|"rejects"| pending
    pending --> rIngest
    pending --> rAttach
    pending --> rDemo
    pending --> rChat
    pending --> rCtx
    pending --> rVerify
    pending --> rText
    pending --> rRemove
    pending --> rSearch
    reset --> docsQ
    docsQ -->|"yes"| emptyDocs
    docsQ -->|"no"| idle
    emptyDocs --> idle
    idle -->|"clear path, when clearWorkspace returns"| uiClear
    idle --> fresh
    fresh --> reuse
```

<sub>Sources: [`src/js/rag/workspace.js`](../src/js/rag/workspace.js), [`src/js/rag/ingest.worker.js`](../src/js/rag/ingest.worker.js), [`src/js/ingest.js`](../src/js/ingest.js), [`src/js/chat.js`](../src/js/chat.js), [`src/js/demo.js`](../src/js/demo.js), [`src/js/rag/citations.js`](../src/js/rag/citations.js), [`src/js/rag/receipts.js`](../src/js/rag/receipts.js), [`src/js/dom.js`](../src/js/dom.js), [`src/locales/en.json`](../src/locales/en.json)</sub>

### chunkText: sliding windows with exact offsets

chunkText validates its options first: chunkSize (default 500) and chunkOverlap (default 50) must be non-negative integers, the size at least 1 and the overlap smaller than the size, otherwise it throws a RangeError; a non-string or empty text gives no chunks. Ingestion passes the size and overlap from the ingest payload, which no caller sets, so 500 and 50 always apply and are recorded with CHUNKER (starpi-chunk version 1) in the document's chunker field; verifyReceipt calls chunkText with the size and overlap recorded in a receipt and treats a RangeError as a failed chunk check. Each window ends at min(start + size, text.length), is pulled back to a paragraph, sentence or whitespace break in its last quarter unless it is the final window, and is moved to a safe boundary. Chunk bounds are trimmed of whitespace, whitespace-only windows are skipped, and each chunk text is exactly text.slice(start, end) of its trimmed bounds. The next window starts overlap characters before the end, but at least at start + 1 and on a safe boundary, so the loop always advances; the start = end fallback cannot be reached.

<!-- diagram: chunk-bm25-chunktext -->
```mermaid
flowchart TD
    start(["chunkText(text, options)"]) --> opts["size = chunkSize, 500 when undefined or null<br/>overlap = chunkOverlap, 50 when undefined or null<br/>ingestion always uses 500 and 50,<br/>verifyReceipt passes the values recorded in a receipt"]
    opts --> intQ{"size, then overlap:<br/>an integer and not negative?"}
    intQ -->|"no"| errInt["RangeError: chunkSize or chunkOverlap<br/>must be a non-negative integer"]
    intQ -->|"yes"| minQ{"size below 1?"}
    minQ -->|"yes"| errMin["RangeError: chunkSize must be at least 1"]
    minQ -->|"no"| ovQ{"overlap at least size?"}
    ovQ -->|"yes"| errOv["RangeError: chunkOverlap must be<br/>smaller than chunkSize"]
    ovQ -->|"no"| textQ{"text is a string with length above 0?"}
    textQ -->|"no"| none(["return no chunks"])
    textQ -->|"yes"| init["start = 0"]
    init --> loopQ{"start below text.length?"}
    loopQ -->|"no"| done(["return chunks"])
    loopQ -->|"yes"| hard["end = min(start + size, text.length)"]
    hard --> tailQ{"end below text.length?"}
    tailQ -->|"yes"| fb["end = findBreak(text, start, end, size)<br/>paragraph, sentence or whitespace break in the<br/>last floor(size / 4) characters, 125 by default"]
    tailQ -->|"no, final window"| sb
    fb --> sb["end = safeBoundary(text, end, start)<br/>never splits a surrogate pair<br/>or detaches a combining mark"]
    sb --> trim["s = start, e = end<br/>move s forward and e back past whitespace"]
    trim --> keepQ{"e greater than s?"}
    keepQ -->|"yes"| push["push index = chunks.length, start s, end e,<br/>text = text.slice(s, e), exact source offsets"]
    keepQ -->|"no, whitespace-only window"| lastQ
    push --> lastQ{"end at or past text.length?"}
    lastQ -->|"yes"| done
    lastQ -->|"no"| step["next = safeBoundary(text,<br/>max(end - overlap, start + 1), start)"]
    step --> progQ{"next greater than start?"}
    progQ -->|"yes, always"| setNext["start = next<br/>consecutive windows share about overlap characters"]
    progQ -->|"no, defensive fallback, unreachable"| setEnd["start = end"]
    setNext --> loopQ
    setEnd --> loopQ
```

<sub>Sources: [`src/js/rag/chunker.js`](../src/js/rag/chunker.js), [`src/js/rag/ingest.worker.js`](../src/js/rag/ingest.worker.js), [`src/js/rag/workspace.js`](../src/js/rag/workspace.js), [`src/js/core/receipt.js`](../src/js/core/receipt.js)</sub>

### Chunk boundary helpers: findBreak and safeBoundary

findBreak only looks at the last floor(size / 4) characters before hardEnd (125 for size 500, never before start + 1). It prefers the last double newline, then the last sentence punctuation followed by whitespace inside that window, then the last whitespace, and cuts at hardEnd only when none exists. safeBoundary steps a position back while it would split a UTF-16 surrogate pair or detach a combining mark, and steps forward from the original position instead when it reaches the lower limit. Positions at the very start or end of the text are always safe.

<!-- diagram: chunk-bm25-boundaries -->
```mermaid
flowchart TD
    subgraph sg_fb["findBreak(text, start, hardEnd, size)"]
        fbFrom["from = max(start + 1, hardEnd - floor(size / 4))<br/>window = text.slice(from, hardEnd)<br/>size 500: the last 125 characters"]
        fbPara{"window contains two newlines in a row?"}
        fbSent{"sentence end in the window: . ! ? or the single<br/>characters U+2026 ellipsis or U+3002 full stop,<br/>followed by whitespace before hardEnd?"}
        fbSpace{"any whitespace character in the window?"}
        rPara(["from + index of the last two newlines + 2<br/>break right after them"])
        rSent(["position right after the last<br/>sentence punctuation"])
        rSpace(["position after the last whitespace"])
        rHard(["hardEnd, hard cut"])
        fbFrom --> fbPara
        fbPara -->|"yes"| rPara
        fbPara -->|"no"| fbSent
        fbSent -->|"yes"| rSent
        fbSent -->|"no"| fbSpace
        fbSpace -->|"yes"| rSpace
        fbSpace -->|"no"| rHard
    end
    subgraph sg_sb["safeBoundary(text, pos, min)"]
        sbBack["p = pos, step back while p above min<br/>and isUnsafeBoundary(text, p)"]
        sbMinQ{"p equals min?"}
        sbFwd["p = pos, step forward while p below text.length<br/>and isUnsafeBoundary(text, p)"]
        sbRet(["return p"])
        sbBack --> sbMinQ
        sbMinQ -->|"yes, cannot move back"| sbFwd
        sbMinQ -->|"no"| sbRet
        sbFwd --> sbRet
    end
    subgraph sg_un["isUnsafeBoundary(text, pos)"]
        unEdge{"pos at or below 0,<br/>or at or above text.length?"}
        unLow{"charCodeAt(pos) is a low surrogate,<br/>0xDC00 to 0xDFFF?"}
        unMark{"code point at pos is a combining mark,<br/>Unicode category M?"}
        unSafe(["false, safe boundary"])
        unUnsafe(["true, unsafe boundary"])
        unEdge -->|"yes"| unSafe
        unEdge -->|"no"| unLow
        unLow -->|"yes, the pair would be split"| unUnsafe
        unLow -->|"no"| unMark
        unMark -->|"yes, the mark would be detached"| unUnsafe
        unMark -->|"no"| unSafe
    end
    sbBack -.->|"calls"| unEdge
    sbFwd -.->|"calls"| unEdge
```

<sub>Sources: [`src/js/rag/chunker.js`](../src/js/rag/chunker.js)</sub>

### BM25Index: tokenize, add, remove and search

bm25.js imports nothing. Its own tokenize applies NFKC and lowercasing, keeps runs of letters, marks and digits that start with a letter or digit, and drops tokens shorter than 2 characters and stopwords: STOPWORDS is the union of the exported STOPWORDS_EN and STOPWORDS_DE lists, which core/facts.js imports together with tokenize for the source check (retrieval.js keeps a separate tokenizer for knowledge base ranking). add records per-chunk term frequencies, one df increment per distinct term and the total token length, and remove reverses exactly that for one docId. search scores every chunk with Okapi BM25 (k1 = 1.2, b = 0.75, avgdl = totalLength / N or 1 when that is 0) and the always-positive idf ln(1 + (N - df + 0.5) / (df + 0.5)), keeps positive scores, sorts by score and then entry order, and returns the top K (the worker clamps K to 1..50, default 5); the worker's clear request exists but is never sent.

<!-- diagram: chunk-bm25-index -->
```mermaid
flowchart TD
    subgraph sg_tok["tokenize(text), defined in bm25.js itself"]
        tIn{"non-empty string?"}
        tNone["no tokens"]
        tNorm["normalize NFKC, then toLowerCase"]
        tRuns["match runs that start with a letter or digit<br/>and continue with letters, marks or digits"]
        tKeep["keep tokens of length 2 or more that are not in<br/>STOPWORDS = STOPWORDS_EN plus STOPWORDS_DE"]
        tIn -->|"no"| tNone
        tIn -->|"yes"| tNorm
        tNorm --> tRuns
        tRuns --> tKeep
    end
    subgraph sg_add["add(chunks), for each chunk"]
        aTok["tokens = tokenize(chunk.text)"]
        aTf["tf = count of each term in the chunk"]
        aDf["df of each distinct term += 1"]
        aPush["entries.push chunk with tf and length = token count<br/>totalLength += length"]
        aTok --> aTf
        aTf --> aDf
        aDf --> aPush
    end
    subgraph sg_rm["remove(docId) and clear()"]
        rEach["each entry of docId: removed += 1,<br/>totalLength -= its length"]
        rDf["df of each term in its tf -= 1,<br/>term deleted when it reaches 0"]
        rKeep["entries = entries of other documents, order kept<br/>return removed count"]
        rClear["clear(): entries, df and totalLength reset"]
        rEach --> rDf
        rDf --> rKeep
    end
    subgraph sg_search["search(query, topK)"]
        sTerms["terms = distinct tokenize(query)"]
        sGuard{"any terms, any entries<br/>and topK above 0?"}
        sEmpty(["no hits"])
        sIdf["N = entries.length, avgdl = totalLength / N, or 1 when that is 0<br/>idf(t) = ln(1 + (N - df + 0.5) / (df + 0.5)), always positive"]
        sScore["for each entry and each term with tf above 0:<br/>score += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * length / avgdl))<br/>k1 = 1.2, b = 0.75, the term is added to matchedTerms"]
        sPos{"score above 0?<br/>true for every chunk holding a query term"}
        sDrop["entry not returned"]
        sKeep["keep chunk, score, matchedTerms<br/>and the entry position"]
        sSort["sort by score descending,<br/>ties by entry position ascending"]
        sTop(["return the first topK hits"])
        sTerms --> sGuard
        sGuard -->|"no"| sEmpty
        sGuard -->|"yes"| sIdf
        sIdf --> sScore
        sScore --> sPos
        sPos -->|"no"| sDrop
        sPos -->|"yes"| sKeep
        sKeep --> sSort
        sSort --> sTop
    end
    subgraph sg_wk["ingest.worker.js requests"]
        wk(["search: topK = Number(topK) or 5,<br/>clamped to 1..50"])
        wkAdd(["ingest: chunks with docId ws-instanceId-N,<br/>docName = the unique name, chunkIndex, start, end, text"])
        wkRm(["remove: docId"])
        wkClear(["clear: handled but never sent,<br/>clearWorkspace terminates the worker instead"])
        wkHead(["head: the first count entries of docId<br/>in entry order, score 0, no scoring"])
    end
    facts(["core/facts.js imports tokenize,<br/>STOPWORDS_EN and STOPWORDS_DE"])
    wk --> sTerms
    wkAdd --> aTok
    wkRm --> rEach
    wkClear --> rClear
    wkHead -.->|"reads entries"| aPush
    aTok -.->|"calls"| tIn
    sTerms -.->|"calls"| tIn
    facts -.->|"calls"| tIn
    aDf -.->|"df and totalLength feed"| sIdf
```

<sub>Sources: [`src/js/rag/bm25.js`](../src/js/rag/bm25.js), [`src/js/rag/ingest.worker.js`](../src/js/rag/ingest.worker.js), [`src/js/rag/workspace.js`](../src/js/rag/workspace.js), [`src/js/core/facts.js`](../src/js/core/facts.js)</sub>

### Citation labels, scopes and the fenced context

assignCitations gives every hit a label [Doc: <name>, Chunk: <n>] built with labelName and citationLabel from core/labels.js (retrieval.js re-exports citationLabel and CITATION_PATTERN). Workspace chunks keep their real chunkIndex + 1, knowledge base sections are numbered per normalized title in order of appearance, and a label already used gets chunk += 1000 until it is unique. Excerpts are cut with safeSlice at excerptChars (1600 in chat and in the demo's check answer, 100000 in the workspace search form; one UTF-16 unit earlier when the cut would split a surrogate pair) and marked truncated; each citation keeps its documentId and, for a workspace chunk, a span with docId, chunkIndex and character offsets. registerCitations stores the list under a scope id (null when empty) and deletes the oldest scope once more than MAX_SCOPES (200) exist. For models with a large window the thread (chat/thread.js answerGrounded) then builds the fenced context with buildContext (maxChars LIMITS.contextCharsCloud, 9000); models on this device, the own server and small models get a context pack instead (section 3). In the fenced context every excerpt gets an opening and a closing fence with its position number, and when the budget runs out an excerpt's text is cut with an ellipsis, never its fences. An excerpt is skipped when less than 120 characters (or less than its own length, if shorter) would be left for its text; a later, shorter excerpt can still fit.

<!-- diagram: citations-assign-and-context -->
```mermaid
flowchart TD
    callers(["assignCitations(hits, limits), limits.excerptChars:<br/>chat/thread.js answerGrounded, demo.js showCheckDemo:<br/>LIMITS.excerptChars 1600<br/>ingest.js runWorkspaceSearch: 100000"])
    nextHit["next hit, in the given order<br/>in chat: pinned file chunks, other workspace hits, knowledge base"]
    name["doc = labelName(documentTitle) from core/labels.js<br/>runs of square brackets and line breaks become a space,<br/>whitespace collapsed, trimmed, empty becomes Document"]
    wsQ{"hit.workspace set?"}
    wsChunk["chunk = workspace.chunkIndex + 1<br/>the real 1-based chunk number"]
    kbChunk["chunk = perDoc counter + 1<br/>counter keyed by the normalized name, so sections<br/>are numbered per title in order of appearance"]
    label["label = citationLabel(doc, chunk)<br/>[Doc: doc, Chunk: chunk]"]
    dupQ{"label already used?"}
    bump["chunk += 1000, rebuild the label<br/>the drawer later shows this bumped number"]
    rec["used.add(label), truncated = content longer than excerptChars<br/>text = content, cut by safeSlice at excerptChars plus an ellipsis,<br/>one unit earlier instead of splitting a surrogate pair<br/>heading without leading hash marks, score = rank"]
    srcQ{"hit.workspace set?"}
    wsSpan["source workspace, documentId = docId<br/>span = docId, chunkIndex, start, end"]
    kbSpan["source knowledge, documentId of the<br/>knowledge document, span null"]
    moreQ{"more hits?"}
    reg["registerCitations(citations)"]
    emptyQ{"list empty?"}
    nullScope["return null<br/>no citation buttons, no Sources row"]
    store["id = c plus ++scopeSeq<br/>scopes.set(id, citations)"]
    evictQ{"scopes.size above MAX_SCOPES 200?"}
    evict["delete the oldest scope<br/>its buttons no longer open anything"]
    callerQ{"caller?"}
    wsList(["ingest.js: one result row per hit with a citationButton<br/>badge, or the plain file name when the scope is null"])
    demoOut(["demo.js: a fixed answer text written for the demo<br/>with these labels, in the language of the sample set<br/>found complete in the workspace, the interface language first,<br/>appendMessage with the scope, then the source check with applyGrounding"])
    ctx["chat/thread.js: buildContext(citationList,<br/>maxChars LIMITS.contextCharsCloud 9000)<br/>for citation n: opening fence EXCERPT n with the label<br/>and the heading, closing fence END EXCERPT n"]
    roomQ{"room left for the text after both fences and,<br/>from the second block on, a blank-line separator:<br/>below min(120, text length)?"}
    skip["excerpt left out, number n is not reused,<br/>the next citation is tried"]
    cutQ{"text longer than the room?"}
    cut["text cut by safeSlice to room - 1 characters,<br/>one fewer instead of splitting a surrogate pair,<br/>trailing whitespace removed, plus an ellipsis"]
    whole["whole excerpt text"]
    join["blocks joined with a blank line"]
    prompt(["context in the system prompt under Knowledge base excerpts:<br/>excerpts are data, cite the header label exactly as written,<br/>an empty context becomes a no-matching-excerpts line"])

    callers --> nextHit
    nextHit --> name
    name --> wsQ
    wsQ -->|"yes, on-device chunk"| wsChunk
    wsQ -->|"no, knowledge base"| kbChunk
    wsChunk --> label
    kbChunk --> label
    label --> dupQ
    dupQ -->|"yes, e.g. a file and a knowledge base<br/>document share the name"| bump
    bump --> dupQ
    dupQ -->|"no"| rec
    rec --> srcQ
    srcQ -->|"yes"| wsSpan
    srcQ -->|"no"| kbSpan
    wsSpan --> moreQ
    kbSpan --> moreQ
    moreQ -->|"yes"| nextHit
    moreQ -->|"no"| reg
    reg --> emptyQ
    emptyQ -->|"yes"| nullScope
    emptyQ -->|"no"| store
    store --> evictQ
    evictQ -->|"yes"| evict
    evictQ -->|"no"| callerQ
    evict --> callerQ
    nullScope --> callerQ
    callerQ -->|"workspace search form"| wsList
    callerQ -->|"demo check answer"| demoOut
    callerQ -->|"chat"| ctx
    ctx --> roomQ
    roomQ -->|"yes"| skip
    roomQ -->|"no"| cutQ
    cutQ -->|"yes"| cut
    cutQ -->|"no"| whole
    skip --> join
    cut --> join
    whole --> join
    join --> prompt
```

<sub>Sources: [`src/js/retrieval.js`](../src/js/retrieval.js), [`src/js/core/labels.js`](../src/js/core/labels.js), [`src/js/core/sentences.js`](../src/js/core/sentences.js), [`src/js/rag/citations.js`](../src/js/rag/citations.js), [`src/js/chat.js`](../src/js/chat.js), [`src/js/ingest.js`](../src/js/ingest.js), [`src/js/demo.js`](../src/js/demo.js), [`src/js/rag/grounding-view.js`](../src/js/rag/grounding-view.js), [`src/js/prompts.js`](../src/js/prompts.js), [`src/js/config.js`](../src/js/config.js)</sub>

### From hits to a citation in the drawer

answerGrounded (chat/thread.js) turns the hits into citations, registers them under a scope and builds the fenced context or a context pack; a model answers with the labels, or, when there is no usable model answer, synthesizeAnswer quotes up to 4 sentences, each followed by its excerpt label. messages.js renders the answer with renderMarkdown, linkifyCitations turns only registered labels into open-citation buttons and attachSources adds a Sources row; the source check and the receipt button follow (see chat-request-source-check). openCitation looks the citation up in its scope, fills in the metadata, shows the excerpt at once in a mark and opens citationModal through dialog.js, which focuses the close button, keeps Tab inside the dialog, closes it on Escape and returns focus to the chip. For a workspace citation it then asks the worker for up to 400 characters of context on each side of the span and scrolls only the excerpt box to the mark; a reply that arrives after another citation was opened, or after the dialog was closed, is ignored. An unknown docId keeps the excerpt with citation.note_missing; document ids carry a random per-worker prefix, so after Clear workspace or a crash an old span can never open a newer file's text.

<!-- diagram: citations-answer-to-drawer -->
```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Chat as chat/thread.js answerGrounded
    participant Ret as retrieval.js
    participant Cit as rag/citations.js
    participant Dlg as dialog.js
    participant Gen as model or synthesizer.js
    participant Msg as messages.js
    participant WS as rag/workspace.js
    participant W as ingest.worker.js

    Note over Chat: used = the retrieved hits, or none for a greeting without an attached file
    Chat->>Ret: assignCitations(used, excerptChars 1600)
    Ret-->>Chat: citations with label, doc, chunk, source, heading, text, truncated, score, documentId, span
    Chat->>Cit: registerCitations(citations)
    Cit-->>Chat: scope id, or null when there are none
    Chat->>Ret: buildContext(citations, maxChars 9000)
    Ret-->>Chat: fenced EXCERPT blocks, each header carries its label
    alt a model answers (a provider, a site pool, the own server or on this device)
        Chat->>Gen: system prompt with the citation rules and the context
        Gen-->>Chat: answer text that cites labels
    else no model, a failed model or empty text
        Chat->>Gen: synthesizeAnswer with used hits and the citation list
        Gen-->>Chat: up to 4 quoted sentences, each followed by its excerpt label
    end
    Chat->>Msg: a streamed answer: stream.finalize(text, citations scope),<br/>a quoted answer: appendMessage(text, citations scope)
    Note over Chat,Msg: pack labels S1 and F1 are expanded to the canonical labels first
    Msg->>Cit: linkifyCitations(content rendered by renderMarkdown, scope), then citationSources(scope)
    Cit-->>Msg: open-citation buttons for registered labels only, Sources badge row
    Note over Chat,Msg: then the source check and the receipt button, see chat-request-source-check
    User->>Cit: click open-citation, data-arg is scope and index
    alt scope evicted or index unknown
        Cit-->>User: nothing opens
    else citation found
        Cit->>Cit: fill doc, source, chunk, score, offsets, then token = ++openSeq
        Cit->>Cit: the excerpt in a mark, note citation.loading_context<br/>for a workspace citation, else citation.note_knowledge
        Cit->>Dlg: openDialog(citationModal), trigger the chip, initial focus the close button
        Dlg-->>User: citationModal shown, Tab stays inside, Escape closes it
        alt source knowledge, span null
            Note over Cit: no worker request, the stored excerpt is all there is
        else source workspace, span set
            Cit->>WS: getChunkContext(span.docId, span.start, span.end)
            WS->>W: context, pad 400, a new worker is started if none runs
            alt the worker has a document with that docId
                W-->>WS: before, match, after, start, end, length
                WS-->>Cit: context
                alt token still equals openSeq and the dialog is open
                    Cit-->>User: before, match in a mark, after, ellipsis where cut, note citation.note_workspace
                else another citation was opened or the dialog was closed
                    Cit->>Cit: reply ignored
                end
            else no such docId
                W-->>WS: ok false, code empty
                WS-->>Cit: reject WorkspaceError, also on a worker crash or clear
                Cit-->>User: excerpt stays, note citation.note_missing unless another citation was opened
            end
        end
    end
    User->>Dlg: close-citation button or Escape
    Dlg-->>User: closeDialog hides the modal, focus returns to the chip if it is still in the page
    Note over WS,W: ids are ws-instanceId-n with a random instanceId<br/>per worker, so after Clear workspace or a crash<br/>an old span never matches a newer file
```

<sub>Sources: [`src/js/chat/thread.js`](../src/js/chat/thread.js), [`src/js/ai/context-pack.js`](../src/js/ai/context-pack.js), [`src/js/retrieval.js`](../src/js/retrieval.js), [`src/js/rag/citations.js`](../src/js/rag/citations.js), [`src/js/dialog.js`](../src/js/dialog.js), [`src/js/messages.js`](../src/js/messages.js), [`src/js/synthesizer.js`](../src/js/synthesizer.js), [`src/js/render.js`](../src/js/render.js), [`src/js/rag/workspace.js`](../src/js/rag/workspace.js), [`src/js/rag/ingest.worker.js`](../src/js/rag/ingest.worker.js), [`src/index.html`](../src/index.html), [`src/locales/en.json`](../src/locales/en.json)</sub>

### linkifyCitations and the Sources row

linkifyCitations works on content already sanitized by renderMarkdown (no button tags, no data attributes) and returns at once without a live scope, so answers without citations and answers restored from history keep their labels as plain text. It collects the text nodes containing [Doc: outside links, code, pre and buttons (a citation button never becomes part of a model-written link), matches CITATION_PATTERN and rebuilds each label with citationLabel to compare it with the registered labels. Only registered labels are replaced by DOM-built buttons; unknown labels stay text, so a model cannot fabricate a clickable source. Each button holds an icon, the document name and the chunk number in separate spans, so a long name can be cut while the number stays visible, and takes its aria-label from citation.open. attachSources then adds the citationSources badge row, title-only badges for restored history, or nothing.

<!-- diagram: citations-linkify -->
```mermaid
flowchart TD
    lkStart(["linkifyCitations(root, scope)<br/>from appendMessage or stream.finalize"])
    purify["root holds renderMarkdown output: DOMPurify<br/>removed button tags and data attributes"]
    scopeQ{"scope set and still in scopes?"}
    noop(["return at once: labels stay plain text<br/>no citations, or history restored without a scope"])
    walk["TreeWalker collects text nodes containing [Doc:<br/>rejecting nodes inside a, code, pre or button"]
    nodeQ{"next collected text node?"}
    match{"next CITATION_PATTERN match in it?<br/>[Doc: name, Chunk: 1 to 6 digits], from core/labels.js"}
    find["findIndex: citationLabel(name, Number(n)) normalizes the name,<br/>then looks for that exact label in the scope"]
    knownQ{"label registered in the scope?"}
    keep["match stays text<br/>a fabricated label is never clickable"]
    btn["citationButton(scope, index, inline): DOM-built button,<br/>data-action open-citation, data-arg scope:index,<br/>aria-label citation.open with doc and chunk,<br/>icon file-text or database, a citation-chip-doc span<br/>with the name, a citation-chip-num span with the chunk"]
    changedQ{"any match replaced in this node?"}
    replace["node.replaceWith(fragment of text and buttons)"]
    icons["refreshIcons(root)"]
    attach["attachSources(bubble, opts)"]
    rowQ{"citationSources(scope) returns a row?<br/>needs a live scope with citations"}
    sources["Sources row: chat.sources label<br/>plus one badge button per citation"]
    srcQ{"opts.sources given?<br/>only for restored history"}
    fallback["title-only sourcesBlock badges"]
    noRow(["no Sources row"])

    lkStart --> purify
    purify --> scopeQ
    scopeQ -->|"no"| noop
    scopeQ -->|"yes"| walk
    walk --> nodeQ
    nodeQ -->|"yes"| match
    match -->|"yes"| find
    find --> knownQ
    knownQ -->|"no, index -1"| keep
    knownQ -->|"yes"| btn
    keep --> match
    btn --> match
    match -->|"no more"| changedQ
    changedQ -->|"yes"| replace
    changedQ -->|"no, node left as it is"| nodeQ
    replace --> nodeQ
    nodeQ -->|"no more"| icons
    icons --> attach
    noop --> attach
    attach --> rowQ
    rowQ -->|"yes"| sources
    rowQ -->|"no"| srcQ
    srcQ -->|"yes"| fallback
    srcQ -->|"no"| noRow
```

<sub>Sources: [`src/js/rag/citations.js`](../src/js/rag/citations.js), [`src/js/core/labels.js`](../src/js/core/labels.js), [`src/js/messages.js`](../src/js/messages.js), [`src/js/render.js`](../src/js/render.js), [`src/js/retrieval.js`](../src/js/retrieval.js), [`src/js/chat.js`](../src/js/chat.js), [`src/locales/en.json`](../src/locales/en.json)</sub>

### Attaching files and images to a message

The composer (chat/composer.js) takes files from the paperclip, a paste or a drop, up to 10 per message, and prepares each on this device with chat/attachments.js while its chip shows it is being read. kindOf() sorts a file by its type and name: an image (JPEG, PNG, WebP, GIF), a PDF, a text file (prose, data and source code, up to 8 MB read whole) or a document (DOCX, XLSX, PPTX, HTML, read by rag/parser.js); anything else is refused. An image is drawn onto a canvas at most 1,568 pixels on the long edge and stored as JPEG at quality 0.85, unless it is already a small JPEG. A document or a PDF is also added to the on-device workspace (addToWorkspace), so a grounded question can search it and pin its passages. Send waits for every attachment that is still being read, and the composer checks that the chosen model can take them: an image with a model that cannot see disables Send and says why. Nothing here leaves the device; the thread decides what is sent where.

<!-- diagram: attachments-voice-attach -->
```mermaid
flowchart TD
    in(["paperclip, paste or drop"])
    countQ{"more than 10 attachments<br/>in the draft?"}
    refuse(["notice chat-thread.composer.too_many,<br/>the first ones up to 10 are kept"])
    kind{"kindOf(file)"}
    img["image: downscaleImage, at most 1,568 px on the long edge,<br/>JPEG 0.85, a small JPEG stays as it is"]
    pdf["PDF: kept as it is; text extracted on demand"]
    text["text file up to 8 MB: read whole"]
    doc["DOCX, XLSX, PPTX, HTML: text by rag/parser.js<br/>on demand"]
    none(["refused: not a file the chat can use"])
    ws["documents and PDFs: addToWorkspace(file),<br/>docId and chunks kept with the attachment"]
    chip["chip: reading, then ready"]
    send{"Send pressed"}
    wait["wait for every attachment being read"]
    vision{"an image and a model<br/>that cannot see?"}
    block(["Send disabled with the reason"])
    draft(["takeDraft(): text and PreparedAttachment list"])
    in --> countQ
    countQ -->|"yes"| refuse --> kind
    countQ -->|"no"| kind
    kind -->|"image"| img --> chip
    kind -->|"pdf"| pdf --> ws
    kind -->|"text"| text --> chip
    kind -->|"document"| doc --> ws
    kind -->|"other"| none
    ws --> chip
    chip --> send --> wait --> vision
    vision -->|"yes"| block
    vision -->|"no"| draft
```

<sub>Sources: [`src/js/chat/composer.js`](../src/js/chat/composer.js), [`src/js/chat/attachments.js`](../src/js/chat/attachments.js), [`src/js/rag/workspace.js`](../src/js/rag/workspace.js), [`src/js/rag/parser.js`](../src/js/rag/parser.js), [`src/js/config.js`](../src/js/config.js)</sub>

### Asking about an attached file

storeQuestion() keeps every attachment as a blob owned by the question node (IndexedDB `blobs`), so a branch, a regenerate or a reload can send it again; the text of a document the workspace already read is taken from there instead of parsing the file twice. When a question goes to a model, userMessage() turns each part into what the model can take: an image as an image part when the model sees (else its name in brackets); a PDF as a file part for a model that reads PDFs, when it is at most 3 MB and not on a site pool; every other file as text fenced as a file (attachmentSection), within a budget that follows the model's context (a fifth of it, at least 2,000 and at most 120,000 characters; 12,000 when the context is unknown), cut at the same place every time so a replayed turn stays the same. An attachment this browser does not have (a conversation restored through the sync, which carries no attachments) goes as its name, and a notice names the files left out. In the grounded route an attached document routes Auto to grounded and its passages are pinned in front of the other hits (chat-request-workspace-merge); a question with only images stays free and needs a model that sees. A question with attachments that stays on this device keeps them here too.

<!-- diagram: attachments-voice-ask -->
```mermaid
sequenceDiagram
    autonumber
    participant Th as chat/thread.js
    participant DB as IndexedDB blobs and nodes
    participant WS as rag/workspace.js
    participant At as chat/attachments.js
    participant M as model request

    Th->>DB: storeQuestion: putBlob per attachment, owner = the question
    opt a document the workspace read
        Th->>WS: getDocumentText(docId), kept as the attachment's text
    end
    Th->>DB: appendNode(question with image and file parts)
    Note over Th: Auto: an attached document means grounded,<br/>only images stay free and need a model that sees
    loop each part, when a model gets the question (userMessage)
        alt image
            alt the model sees
                Th->>DB: blob as base64
                Th->>M: image part
            else
                Th->>M: the image's name in brackets
            end
        else PDF, the model reads PDFs, at most 3 MB, not a site pool
            Th->>M: file part application/pdf
        else any other file
            Th->>At: attachmentText: plain text, or extractText on demand
            Th->>Th: fitText within textBudget(caps): a fifth of the context,<br/>2,000 to 120,000 chars, 12,000 when unknown
            Th->>M: attachmentSection(name, text), fenced as a file
        end
        opt the blob is not in this browser (restored by the sync)
            Th->>M: the name only, noted as left out
        end
    end
```

<sub>Sources: [`src/js/chat/thread.js`](../src/js/chat/thread.js), [`src/js/chat/attachments.js`](../src/js/chat/attachments.js), [`src/js/chat/store.js`](../src/js/chat/store.js), [`src/js/rag/workspace.js`](../src/js/rag/workspace.js), [`src/js/prompts.js`](../src/js/prompts.js), [`src/js/ai/hybrid.js`](../src/js/ai/hybrid.js), [`src/js/config.js`](../src/js/config.js)</sub>

### Voice input: the dictation chain

The microphone button starts the first speech input source of the chain (voice/stt.js): the user's pick first, then the browser, Gemini, OpenAI, Groq, a voice server on the user's machine and the companion, each counted only when it can run now (a key, the site's offer, a server address, a pairing). For a question that stays on this device (the model of this device is picked) only sources that keep audio on the user's machines count, plus the browser where it recognises on the device (`processLocally`). The browser's own recognition writes while the user speaks and ends at the pause; when it is missing, refused or its service fails, dictation records instead and the next sources transcribe the recording (a 16 kHz WAV), each handing over to the next on failure, with the user's glossary of names and terms. The text lands after what the message box holds, and audio is never stored. Section 16 describes the sources, read-aloud and Live.

<!-- diagram: attachments-voice-voice -->
```mermaid
flowchart TD
    mic(["microphone button"])
    chain["sttChain: the pick first, then browser, Gemini, OpenAI,<br/>Groq, local voice server, companion; available ones only"]
    devQ{"question stays on this device?"}
    local["only sources on the user's machines,<br/>the browser only with processLocally"]
    first{"first source"}
    browser["browser recognition writes while speaking,<br/>ends at the pause"]
    fail{"missing, refused or failed?"}
    record["record a 16 kHz WAV until the second press<br/>or the time limit"]
    next["transcribeWithFallback: next source,<br/>not configured, refused, rate limited or unreachable hands over"]
    text(["text after what the box holds, audio not stored"])
    none(["notice: no source could transcribe"])
    mic --> chain --> devQ
    devQ -->|"yes"| local --> first
    devQ -->|"no"| first
    first -->|"browser"| browser --> fail
    fail -->|"no"| text
    fail -->|"yes"| record
    first -->|"another source"| record
    record --> next
    next -->|"a source answered"| text
    next -->|"none left"| none
```

<sub>Sources: [`src/js/voice/stt.js`](../src/js/voice/stt.js), [`src/js/voice/dictation.js`](../src/js/voice/dictation.js), [`src/js/voice/recognition.js`](../src/js/voice/recognition.js), [`src/js/voice/capture.js`](../src/js/voice/capture.js), [`src/js/voice/catalog.js`](../src/js/voice/catalog.js), [`src/js/voice/sources/index.js`](../src/js/voice/sources/index.js)</sub>

## 5. On-device inference

The on-device engine runs a WebGPU preset with WebLLM or a processor (WASM) model with Transformers.js, each in its own Web Worker. Loads are sequenced so a superseded load can never change the engine status, and a load settles the cheap questions first: when a model is not cached, a start-up load stops before the WebLLM library is imported or a worker starts, and an interactive load asks for download consent before the library is imported or any model data is downloaded. Every model file is checked against its pinned SHA-256 before the model answers. The benchmark runs on the loaded engine, after an interactive load when none is ready, on WebGPU or, without it, on the processor, measures time to first token and decode speed, and keeps every run in a history that the model recommendation reads.

### On-device engine status machine

webgpu/engine.js keeps a single status of idle, loading, ready or error for both runtimes, a WebGPU preset in the WebLLM worker or a processor (WASM) model in the Transformers.js worker, and notifies onEngineChange listeners on every setState. loadModel does the device probe, the model choice and the cache check before it enters loading. A WebGPU preset on a device without WebGPU, or a failed quota check for a model that is not cached, goes straight to error. A non-interactive load that finds the model not cached (a WASM model counts as not cached unless all of its files are) and a declined download for such a model resolve false without any setState, so the status stays what it was. Otherwise loadModel tears down and enters loading, and it returns to idle from there when a WebGPU model that the cheap check could not rule out turns out not to be fully cached and the load is non-interactive or the download is declined, or when unloadModel cancels it by bumping loadSeq. Load failures and fatal generation errors (device-lost, out-of-memory) tear the worker down and land in error, from which a new loadModel or unloadModel recovers. generate and runBenchmark are guarded by the ready status and a single generating flag for both runtimes, and every caller checks isReady before loading.

<!-- diagram: webgpu-lifecycle-states -->
```mermaid
stateDiagram-v2
    [*] --> idle
    state "error (EngineError kept in state.error)" as error_state
    idle --> loading : loadModel, probe ok, cache check and consent passed, teardown, seq still current
    error_state --> loading : loadModel retry, same checks passed, teardown
    ready --> loading : loadModel for another runtime or modelId, checks passed, teardown first
    ready --> ready : loadModel for the same runtime and modelId, engine reused, resolves true
    idle --> idle : not cached and onlyIfCached, or download declined, resolves false without setState
    idle --> error_state : WebGPU preset without WebGPU (unsupported or no-adapter), or checkQuota quota (never enters loading)
    error_state --> error_state : loadModel again, probe or checkQuota fails, or not cached with onlyIfCached or a declined download keeps the old error
    loading --> idle : WebGPU model not ruled out but hasModelInCache false, onlyIfCached or declined, seq current
    loading --> idle : unloadModel cancels (loadSeq+1, abortPending cancelled, teardown)
    loading --> ready : CreateWebWorkerMLCEngine or WasmEngineClient.load resolved and seq current
    loading --> error_state : run threw with seq current, teardown, classifyEngineError
    ready --> error_state : generate or runBenchmark failed with device-lost or out-of-memory (loadSeq+1, teardown)
    ready --> idle : unloadModel (unload button, another on-device model picked, deleteCachedModels)
    error_state --> idle : unloadModel
    note right of loading
        A run whose seq is no longer loadSeq resolves false without setState.
        Its worker is terminated by the teardown in unloadModel,
        or by the run itself when the engine arrives after seq changed.
        Concurrent loadModel calls share one loadPromise.
        loadWebLLM drops a rejected import, so the next load imports again.
    end note
    note right of ready
        generate and runBenchmark throw not-loaded unless ready,
        and busy while the generating flag is set.
        Other generation errors are rethrown, status stays ready.
        the thread, the benchmark and changeEngine check isReady first,
        so no caller runs loadModel from ready today.
    end note
    note left of error_state
        EngineErrors from the probe (unsupported, no-adapter),
        checkQuota (quota) and the model lookup (unknown) pass through.
        Other failures are classified in this order as quota, device-lost,
        out-of-memory, code-download, network, unsupported or unknown.
        cancelled never lands here.
    end note
```

<sub>Sources: [`src/js/webgpu/engine.js`](../src/js/webgpu/engine.js), [`src/js/wasm/client.js`](../src/js/wasm/client.js), [`src/js/engine-ui.js`](../src/js/engine-ui.js), [`src/js/settings.js`](../src/js/settings.js), [`src/js/chat.js`](../src/js/chat.js), [`src/js/bench/bench-ui.js`](../src/js/bench/bench-ui.js)</sub>

### loadModel: probe, choice, cache and storage checks

Concurrent loadModel calls share one loadPromise, and every new load takes a sequence number plus an aborted promise that unloadModel can reject. The engine probes the device with the high-performance adapter and a 10 s deadline: a missing navigator.gpu, a failing or empty requestAdapter or no answer in time gives a profile without WebGPU and keeps the probe's EngineError (unsupported or no-adapter). models.js chooseModel picks the model for the hardware and preference; a WebGPU preset then needs WebGPU, and a processor (WASM) model needs none. WebGPU presets take the q4f32_1 build only when the adapter lacks shader-f16; there is no runtime f16 to f32 retry. An engine that already runs the same runtime and model id is reused. Otherwise the cache check runs without importing WebLLM or starting a worker: for a WebGPU preset certainlyNotCached looks in the Cache Storage cache webllm/model for the model's tensor-cache.json entry and answers true only when the cache or the entry is missing (false when there is no Cache API or the check throws), and for a WASM model wasmCacheStatus counts the model as missing unless config.json, tokenizer.json and the ONNX weights are all in transformers-cache, also when that cache cannot be read. For a missing model, a non-interactive load resolves false at once, and an interactive load runs agreeToDownload: checkQuota (a 1.2 factor on the approximate download size, plus 15 MB of ONNX Runtime for a WASM model), then the window.confirm download dialog, and only after consent requestPersistence. Neither exit calls setState, and every throw ends in the loadPromise catch.

<!-- diagram: webgpu-lifecycle-load-prepare -->
```mermaid
sequenceDiagram
    autonumber
    participant UI as engine-ui.js startLocalEngine
    participant Eng as webgpu/engine.js loadModel
    participant GPU as navigator.gpu
    participant Mod as webgpu/models.js
    participant CS as Cache Storage webllm/model or transformers-cache
    participant Sto as navigator.storage

    UI->>Eng: loadModel(preference, onlyIfCached, confirmDownload)
    Note over UI,Eng: interactive loads pass confirmDownload,<br/>non-interactive loads set onlyIfCached
    alt loadPromise already set
        Eng-->>UI: the shared loadPromise
    end
    Eng->>Eng: seq = ++loadSeq, aborted promise via abortPending
    Eng->>GPU: probeDevice: requestAdapter(high-performance), raced against 10 s
    alt navigator.gpu.requestAdapter missing
        Eng->>Eng: no WebGPU, keeps EngineError unsupported
    else requestAdapter throws, returns null or does not answer in 10 s
        Eng->>Eng: no WebGPU, keeps EngineError no-adapter
    else adapter
        GPU-->>Eng: adapter, limits, features, info
    end
    Eng->>Eng: hw = isMobile via detectMobile, navigator.deviceMemory,<br/>maxBufferSize, hasF16 from shader-f16, webgpu,<br/>maxStorageBufferBindingSize, vendor, architecture
    Eng->>Mod: chooseModel(hw, preference)
    Mod-->>Eng: WASM choice, or WebGPU choice with the q4f16_1 id if hasF16, else the q4f32_1 id
    Note over Eng,Mod: f32 is chosen up front from the adapter features,<br/>a failed f16 load is never retried as f32
    alt WebGPU choice and no WebGPU
        Eng->>Eng: throw the kept EngineError, no switch to a WASM model
    end
    alt engine set with the same runtime and modelId
        Eng-->>UI: true (reuse)
    end
    alt WASM choice
        Eng->>CS: wasmCacheStatus: caches.has transformers-cache, then match<br/>config.json, tokenizer.json and the weights at the pinned revision
        CS-->>Eng: missing unless all three are there, also when the cache cannot be read
    else WebGPU choice
        Eng->>CS: certainlyNotCached(modelId)
        Note over Eng,CS: caches.has webllm/model, then cache.match for<br/>huggingface.co/mlc-ai/modelId/resolve/main/tensor-cache.json
        alt no webllm/model cache, or no tensor-cache.json entry
            CS-->>Eng: missing true
        else entry found, no Cache API, or the check throws
            CS-->>Eng: missing false, hasModelInCache decides after the import
        end
    end
    opt missing
        alt onlyIfCached
            Eng-->>UI: false, no setState, no import and no worker
        else agreeToDownload(choice, options)
            Eng->>Sto: checkQuota(max(approxDownloadMB, plus 15 MB for WASM, 1)), no check without estimate()
            Sto-->>Eng: quota, usage
            alt quota above 0 and free MB below 1.2 x requiredMB
                Eng->>Eng: throw EngineError quota (requiredMB, freeMB)
            end
            Eng->>UI: confirmDownload(choice) via window.confirm, when given
            Note over UI: engine.confirm_large first for a T3 preset,<br/>engine.confirm_download, or confirm_download_wasm with the runtime MB,<br/>engine.confirm_save_data when navigator.connection.saveData is set
            alt declined
                UI-->>Eng: false
                Eng-->>UI: false, no setState
            end
            Eng->>Sto: requestPersistence(), persist() best effort, errors ignored
            Eng->>Eng: return false if seq is stale
        end
    end
    Note over Eng: then teardown and status loading, see loadModel: WebLLM import,<br/>model record and partial cache, or wasm-runtime-load for a WASM model
    Note over UI,Eng: every throw lands in the loadPromise catch. A stale seq resolves false,<br/>else teardown, classifyEngineError, status error and reject
```

<sub>Sources: [`src/js/webgpu/engine.js`](../src/js/webgpu/engine.js), [`src/js/engine-ui.js`](../src/js/engine-ui.js), [`src/js/webgpu/models.js`](../src/js/webgpu/models.js), [`src/js/wasm/client.js`](../src/js/wasm/client.js), [`src/js/models/wasm-catalog.js`](../src/js/models/wasm-catalog.js)</sub>

### loadModel: WebLLM import, model record and partial cache

For a WebGPU preset (a WASM model continues in wasm-runtime-load), after the cache check the load tears down any previous engine, checks its sequence number again and enters loading with phase init and the model's label. loadWebLLM keeps one import promise for the WebLLM module and drops it when the import rejects, so the next load imports again; classifyEngineError turns a failed dynamic import (a message with "dynamically imported module" or "Importing a module script failed") into code-download unless quota, device-lost or out-of-memory matches first, and the engine.error.code-download message asks the user to reload the page (a code comment in loadWebLLM notes that the browser may keep the failed import until a reload). The model id must exist in prebuiltAppConfig.model_list. hasModelInCache runs only when certainlyNotCached did not already report the model missing. A model it reports as not cached (for example an index without all shards) gets the same consent as a fresh download, but because the load is already in loading, a non-interactive load or a declined download sets idle before resolving false.

<!-- diagram: webgpu-lifecycle-load-import -->
```mermaid
sequenceDiagram
    autonumber
    participant UI as engine-ui.js startLocalEngine
    participant Eng as webgpu/engine.js loadModel
    participant Lib as web-llm module
    participant Sto as navigator.storage

    Note over Eng: probe, model choice and cache check done, engine not reused,<br/>a WebGPU preset, a WASM model goes to wasm-runtime-load
    Eng->>Eng: teardown(), return false if seq is stale
    Eng->>Eng: setState loading, error null, model null, progress 0, phase init, label
    Eng->>Lib: Promise.race(loadWebLLM(), aborted)
    Note over Eng,Lib: loadWebLLM shares one import promise across loads
    alt import rejects
        Lib-->>Eng: error
        Eng->>Eng: webllmModule = null, so the next load imports again
        Eng->>Eng: throw, classified as code-download when the message matches<br/>dynamically imported module or Importing a module script failed<br/>and quota, device-lost or out-of-memory did not match first
    else unloadModel rejects aborted
        Eng->>Eng: throw EngineError cancelled, the stale run resolves false
    end
    Lib-->>Eng: module, return false if seq is stale
    Eng->>Lib: find modelId in prebuiltAppConfig.model_list
    alt no record
        Eng->>Eng: throw EngineError unknown (reason modelId)
    end
    alt missing from the cache check
        Eng->>Eng: cached false, hasModelInCache skipped, agreeToDownload already passed
    else not ruled out
        Eng->>Lib: hasModelInCache(modelId)
        Lib-->>Eng: cached, false if the check throws
    end
    opt not cached and not missing, for example an index without all shards
        alt onlyIfCached
            Eng->>Eng: setState idle if seq is current
            Eng-->>UI: false
        else agreeToDownload(choice, options)
            Eng->>Sto: checkQuota, throws EngineError quota when free space is short
            Eng->>UI: confirmDownload(choice) via window.confirm, when given
            alt declined
                Eng->>Eng: setState idle if seq is current
                Eng-->>UI: false
            end
            Eng->>Sto: requestPersistence(), best effort
        end
        Eng->>Eng: return false if seq is stale
    end
    Note over Eng: continue with new Worker, see the worker diagram below
    Note over UI,Eng: every throw lands in the loadPromise catch. A stale seq resolves false,<br/>else teardown, classifyEngineError, status error and reject
```

<sub>Sources: [`src/js/webgpu/engine.js`](../src/js/webgpu/engine.js), [`src/js/engine-ui.js`](../src/js/engine-ui.js), [`src/locales/en.json`](../src/locales/en.json)</sub>

### loadModel: worker creation, progress phases and generation guards

For a WebGPU preset, loadModel creates a dedicated module worker (worker.js with WebWorkerMLCEngineHandler) with new Worker and passes it to CreateWebWorkerMLCEngine, which builds the WebWorkerMLCEngine client and sends reload to the worker; loadModel races that promise against the abort promise. Each progress report is mapped by classifyProgress onto init, download, cache, shaders or finalizing and rendered by engine-ui.js as `engine.progress.<phase>` with a percentage. Cancelling or unloading terminates the worker and returns to idle, an engine created after its load was superseded is terminated, success stores vramMB and resolves true, and failures are classified and shown as a localized notice. generate and runBenchmark, the same for a WASM model behind WasmEngineClient, reject with not-loaded unless the engine is ready and with busy while a generation runs; during a run a device-lost or out-of-memory error tears the engine down into error (teardown tries unload for up to 2 s before terminate), and other errors leave it ready. A generate error reaches the on-device adapter (ai/adapters/on-device.js) as a failed stream: before any text the runner treats it like any failed model (the grounded route then quotes the sources), after text the answer keeps what arrived; Stop aborts the request, which calls interrupt and so interruptGenerate, which for a WASM model also skips generations still queued in its worker.

<!-- diagram: webgpu-lifecycle-load-worker -->
```mermaid
sequenceDiagram
    autonumber
    participant C as ai/adapters/on-device.js, bench/measure.js
    participant UI as engine-ui.js
    participant Eng as webgpu/engine.js
    participant Lib as web-llm module
    participant W as worker.js starpi-webllm

    Note over Eng,W: a WebGPU preset, a WASM model loads in wasm-runtime-load
    Eng->>W: new Worker(WORKER_URL, type module, name starpi-webllm)
    Eng->>Lib: race CreateWebWorkerMLCEngine(w, modelId, initProgressCallback, chatOptions) vs aborted
    Lib->>W: reload(modelId, chatOptions) to WebWorkerMLCEngineHandler
    loop each InitProgressReport
        W-->>Lib: initProgressCallback message
        Lib-->>Eng: initProgressCallback(report)
        Eng->>Eng: if seq current, progress with classifyProgress(text)
        Eng-->>UI: onEngineChange, banner engine.progress.phase and percent
    end
    Note over Eng: Fetching param cache or Start to fetch params = download<br/>Loading model from cache = cache, text with shader = shaders<br/>Finish loading = finalizing, anything else = init
    alt user cancels (cancel-webgpu or unload-webgpu)
        UI->>Eng: unloadModel()
        Eng->>Eng: loadSeq+1, abortPending(cancelled), loadPromise null
        Eng->>W: teardown() terminate (no engine yet)
        Eng-->>UI: status idle
        UI->>UI: notice engine.notice_cancelled_title or engine.notice_unloaded_title
        Note over Eng: the aborted race rejects, the stale run resolves false
    else engine created but seq stale
        Eng->>W: w.terminate()
        Eng-->>UI: resolves false, no setState
    else engine created and seq current
        Lib-->>Eng: WebWorkerMLCEngine
        Eng->>Eng: engine set, status ready, vramMB from vram_required_MB
        Eng-->>UI: resolves true, ready notice if interactive
    else run threw and seq current
        Eng->>W: teardown() terminate
        Eng->>Eng: classifyEngineError, status error
        Eng-->>UI: reject EngineError
        UI->>UI: errorNotice engine.error.kind unless cancelled, return false
    end
    Note over C,UI: the thread and the benchmark first call startLocalEngine(interactive true)<br/>unless isReady(), false means no local generation
    C->>Eng: generate() or runBenchmark()
    alt status not ready or no engine
        Eng-->>C: EngineError not-loaded
    else generating flag set
        Eng-->>C: EngineError busy
    else ready and no generation running, generating = true
        Eng->>W: chat.completions.create(stream true)
        opt Stop aborts the request (the adapter's abort signal)
            C->>Eng: interrupt()
            Eng->>W: interruptGenerate()
        end
        alt stream fails with device-lost or out-of-memory
            Eng->>Eng: loadSeq+1, loadPromise null
            Eng->>W: teardown() interruptGenerate, unload() or 2 s timeout, terminate
            Eng-->>C: status error, classified EngineError
        else stream fails with another error
            Eng-->>C: classified EngineError, status stays ready
        else success
            Eng-->>C: text or BenchmarkRun, generating reset
        end
    end
    Note over C: on error before any text the runner asks the next candidate, the grounded route quotes the sources,<br/>the benchmark shows engine.error.kind. A ready WASM engine takes the same calls through WasmEngineClient
```

<sub>Sources: [`src/js/webgpu/engine.js`](../src/js/webgpu/engine.js), [`src/js/webgpu/worker.js`](../src/js/webgpu/worker.js), [`src/js/engine-ui.js`](../src/js/engine-ui.js), [`src/js/ai/adapters/on-device.js`](../src/js/ai/adapters/on-device.js), [`src/js/bench/measure.js`](../src/js/bench/measure.js), [`src/index.html`](../src/index.html), [`src/js/wasm/client.js`](../src/js/wasm/client.js)</sub>

### Processor (WASM) runtime: loading, pinned downloads, generation and Stop

A processor (WASM) model runs Transformers.js 4.3.0 in its own module worker, starpi-wasm, behind WasmEngineClient, which offers the part of WebLLM's engine API that webgpu/engine.js uses, so loading, streaming, Stop, the benchmark and unloading work the same for both runtimes. Before the worker starts, wasmCacheStatus and the download consent have settled whether anything may be downloaded (loadModel: probe, choice, cache and storage checks). The worker loads only an exact catalog entry (repository, revision and dtype q8) and sends every download of Transformers.js through its own env.fetch, which accepts only files of that repository at the pinned revision (a request for the main revision, which Transformers.js 4.3 makes for tokenizer_config.json, is pinned too), answers from transformers-cache when the file is stored, so a stored model also loads offline, and otherwise fetches the pinned URL from huggingface.co; Transformers.js stores what it downloads in transformers-cache. ONNX Runtime is the WASM build bundled into the worker. Its binary comes from the app's own /assets under a content-hashed name, it runs on one thread because the app is not cross-origin isolated, and its WASM cache is off, because a cached runtime would become a blob: module that script-src 'self' blocks. Progress reports become the share of the catalog's file sizes, in the phase download or cache, and finalizing once every file is there. Requests run one after another in the worker; generate streams one delta per token, and every forward pass first waits for one macrotask, so a Stop message is handled while a generation runs: interruptGenerate posts interrupt with the newest request id, which stops the running generation at its next token and skips generations still queued up to that id, and the client ends its stream at once. Errors cross the worker boundary as name and message only, and a worker that fails to start rejects every pending request as a failed module import, which classifyEngineError reports as code-download.

<!-- diagram: wasm-runtime-load -->
```mermaid
sequenceDiagram
    autonumber
    participant Eng as webgpu/engine.js loadModel
    participant Cli as wasm/client.js WasmEngineClient
    participant W as wasm/worker.js starpi-wasm
    participant TF as Transformers.js and ONNX Runtime
    participant CS as Cache API transformers-cache
    participant HF as huggingface.co
    participant App as same origin /assets

    Note over Eng: WASM choice, wasmCacheStatus and any consent done,<br/>see loadModel: probe, choice, cache and storage checks
    Eng->>Eng: teardown(), setState loading, phase init, label
    Eng->>W: new Worker(WASM_WORKER_URL, type module, name starpi-wasm)
    Note over W: at start: allowLocalModels false, useBrowserCache true,<br/>cacheKey transformers-cache, useWasmCache false,<br/>wasmPaths = the hashed ONNX Runtime binary, numThreads 1, proxy false
    Eng->>Cli: race WasmEngineClient.load(worker, source, onProgress) vs aborted
    Cli->>W: load with id, repo, revision and dtype
    W->>W: findWasmSource: an exact catalog entry or an error, unload the previous model
    W->>TF: AutoTokenizer and AutoModelForCausalLM from_pretrained,<br/>pinned revision, dtype q8, device wasm
    loop every file Transformers.js requests
        TF->>W: env.fetch(url)
        W->>W: pinnedWasmUrl: this repository, the pinned revision or main mapped to it,<br/>plain path segments, anything else throws a TypeError
        W->>CS: caches.match the pinned URL
        alt stored
            CS-->>W: the file, also offline
        else not stored
            W->>HF: GET the pinned URL
            HF-->>W: the file, kept by Transformers.js in transformers-cache
        end
        W-->>Cli: progress with file, loaded bytes and done
        Cli-->>Eng: share of the catalog file sizes, stage files, then session
        Eng->>Eng: phase download when the model was missing, else cache,<br/>finalizing once every file is there
    end
    TF->>App: GET /assets/ort-wasm-simd-threaded-hash.wasm, 14.3 MB
    App-->>TF: ONNX Runtime binary, allowed by script-src wasm-unsafe-eval
    W->>W: yieldBetweenTokens: every forward pass first awaits setTimeout 0
    W-->>Cli: ready
    alt unloadModel cancelled the load
        Eng->>Eng: the aborted race rejects, teardown terminates the worker
    else seq is stale
        Eng->>W: terminate, resolve false
    else load error, e.g. a blocked URL, a network error or quota
        W-->>Cli: error with name and message only
        Cli-->>Eng: rejects, classifyEngineError, status error
    else ready
        Eng->>Eng: engine = client, status ready, model = choice,<br/>badge engine.ram_ready, no memory figure
    end

    Note over Eng,W: generation, the same calls as for WebLLM
    Eng->>Cli: chat.completions.create with messages, max_tokens, temperature, stream true
    Cli->>W: generate with id, role and content of each message, maxTokens, temperature, ignoreEos
    alt id at most interruptedUpTo, stopped while it was queued
        W-->>Cli: done with zero tokens
    else runs after the requests before it
        W->>TF: apply_chat_template, generate with TextStreamer<br/>and InterruptableStoppingCriteria, sampling when temperature is above 0
        loop each token
            W-->>Cli: delta text
            Cli-->>Eng: chunk with choices delta content
        end
        W-->>Cli: done with prompt_tokens and completion_tokens
    end
    opt Stop pressed: engine.interrupt()
        Eng->>Cli: interruptGenerate()
        Cli->>W: interrupt upTo the newest id, handled at once, outside the queue
        W->>TF: stopping criteria interrupted, the generation ends at its next token
        Cli-->>Eng: the stream ends at once
    end
    opt unload, another model picked or Delete downloaded model data
        Eng->>Cli: unload(), 2 s at most
        Cli->>W: unload, dispose the model, unloaded
        Eng->>W: terminate
    end
    Note over Cli,W: a worker that fails to start rejects every pending request<br/>with Importing a module script failed, reported as code-download
```

<sub>Sources: [`src/js/wasm/client.js`](../src/js/wasm/client.js), [`src/js/wasm/worker.js`](../src/js/wasm/worker.js), [`src/js/models/wasm-catalog.js`](../src/js/models/wasm-catalog.js), [`src/js/webgpu/engine.js`](../src/js/webgpu/engine.js), [`src/js/engine-ui.js`](../src/js/engine-ui.js), [`scripts/build.mjs`](../scripts/build.mjs), [`vercel.json`](../vercel.json), [`package.json`](../package.json)</sub>

### Diagnostics & Benchmark tab: probe and runtime

bench/bench-ui.js is the part of the tab in the first load: its action and the refresh hook. Opening the tab loads bench/bench-tab.js (with the history view, the history store and the charts) and runs refreshDiagnostics, which calls probeWebGPU: unsupported when navigator.gpu or requestAdapter is missing, no-adapter when requestAdapter (high-performance) throws or returns null, and otherwise the adapter info, those of the reported limits that are finite numbers and the sorted features. The tab always shows the logical cores, and the memory only when navigator.deviceMemory is set; adapter fields, shader-f16 support and the limits appear only with WebGPU. benchRuntime() then decides what the benchmark can measure here: WebGPU models when an adapter answered, processor (WASM) models otherwise, and nothing without WebAssembly; the button is disabled only while a run is in progress, before the first probe, or when neither runtime exists. The history card shows the runs of this device class and the recommendation they give.

<!-- diagram: benchmark-diagnostics-probe -->
```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Tabs as ui.js switchTab
    participant UI as bench/bench-ui.js
    participant Tab as bench/bench-tab.js
    participant Eng as webgpu/engine.js
    participant M as bench/measure.js
    participant H as bench/history-view.js

    User->>Tabs: switch-tab bench
    Tabs->>UI: onTabOpen hook, refreshDiagnostics()
    UI->>Tab: import() on first use, refreshDiagnostics()
    Tab->>Eng: probeWebGPU()
    alt navigator.gpu or requestAdapter missing
        Eng-->>Tab: supported false, unsupported
    else requestAdapter(high-performance) throws or returns null
        Eng-->>Tab: supported false, no-adapter
    else adapter
        Eng-->>Tab: supported true, adapter info, finite limits, sorted features, hw
    end
    Tab->>Tab: memory and cores, adapter fields and limits only with WebGPU
    Tab->>M: benchRuntime(probe): webgpu, else wasm with WebAssembly, else none
    Tab->>Tab: renderRunner: disabled while running, before a probe,<br/>or without a runtime, hint names the model to measure
    Tab->>H: mount on first use, render the runs of this device class
```

<sub>Sources: [`src/js/bench/bench-ui.js`](../src/js/bench/bench-ui.js), [`src/js/bench/bench-tab.js`](../src/js/bench/bench-tab.js), [`src/js/bench/measure.js`](../src/js/bench/measure.js), [`src/js/bench/diagnostics.js`](../src/js/bench/diagnostics.js), [`src/js/bench/history-view.js`](../src/js/bench/history-view.js), [`src/js/webgpu/engine.js`](../src/js/webgpu/engine.js), [`src/js/main.js`](../src/js/main.js), [`src/js/ui.js`](../src/js/ui.js)</sub>

### Inference benchmark run and the benchmark history

A run is refused while an answer is being written (isChatBusy). measureModel() loads the selected model when none is ready (startLocalEngine interactive, so the download question appears as for a chat; a declined or failed load ends the run) and times the load from the moment the engine starts loading. runBenchmark() then resets the chat, sends a warm-up of at most 8 tokens, resets again and times one streamed request for exactly 128 tokens (ignore_eos, temperature 0, usage included), on WebGPU or on the processor (WASM) runtime. computeBenchmarkMetrics derives the time to first token, the decode rate over the tokens after the first, the total latency and the engine's prefill rate. A completed run, and a run that failed with device-lost or out-of-memory after the model was loaded, is recorded in the `bench` store (models/bench-history.js): model id, preset, runtime, device class, browser, tokens per second, first-token time, load time and failures. The history view charts the median decode rate per model against the two thresholds (8 and 20 tokens per second), lists the runs with a trend line, exports them as JSON and can clear them. recommendModels reads the same history: a pick that decodes below 8 tokens per second on this device class steps down a rung, and a larger preset above 20 is suggested, never picked. The answer paths read only the median rate of the loaded processor model (models/bench-rates.js, 300 ms at most), which may raise its output budget above 384 tokens.

<!-- diagram: benchmark-run -->
```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Tab as bench/bench-tab.js
    participant Chat as chat.js isChatBusy
    participant M as bench/measure.js
    participant EUI as engine-ui.js
    participant Eng as webgpu/engine.js
    participant Diag as bench/diagnostics.js
    participant Hist as models/bench-history.js
    participant Dev as models/device.js

    User->>Tab: run-benchmark
    alt running, or an answer is being written
        Tab-->>User: ignored, or hint busy
    else
        Tab->>M: measureModel(engine, load, outputTokens 128)
        opt engine not ready
            M->>EUI: startLocalEngine(interactive true): download question as in the chat
            EUI-->>M: loaded, or false (declined or failed): status declined
            Note over M: loadMs from the first loading state to ready
        end
        M->>Eng: runBenchmark(128 tokens, onPhase)
        Eng->>Eng: resetChat, warm-up 8 tokens, resetChat
        Eng->>Eng: one streamed request, 128 tokens, ignore_eos, temperature 0
        alt completed
            Eng-->>M: BenchmarkRun: runtime, f16, token counts, times, engine stats
            M->>Diag: computeBenchmarkMetrics: TTFT, decode tok/s, total, prefill
            M-->>Tab: done, recordable
        else failed
            Eng-->>M: EngineError
            M-->>Tab: failed, recordable only for device-lost or out-of-memory
        end
        opt recordable
            Tab->>Hist: record(model, metrics, loadMs): bench store
            Tab->>Dev: recommendModels(hw, history): step down under 8 tok/s,<br/>suggest a larger preset above 20 tok/s
            Tab->>Tab: history chart, table, trend line
        end
    end
```

<sub>Sources: [`src/js/bench/bench-tab.js`](../src/js/bench/bench-tab.js), [`src/js/bench/measure.js`](../src/js/bench/measure.js), [`src/js/bench/diagnostics.js`](../src/js/bench/diagnostics.js), [`src/js/bench/history-view.js`](../src/js/bench/history-view.js), [`src/js/models/bench-history.js`](../src/js/models/bench-history.js), [`src/js/models/bench-rates.js`](../src/js/models/bench-rates.js), [`src/js/models/device.js`](../src/js/models/device.js), [`src/js/webgpu/engine.js`](../src/js/webgpu/engine.js), [`src/js/engine-ui.js`](../src/js/engine-ui.js), [`src/js/chat.js`](../src/js/chat.js)</sub>

### Model download integrity

Every file an on-device runtime stores in Cache Storage (WebLLM's webllm/config, webllm/model and webllm/wasm; Transformers.js's transformers-cache) is hashed and compared with `src/js/models/model-lock.json`, which `npm run models:lock` (scripts/models-lock.mjs) writes from the model hosts: SHA-256 and size of every config, tokenizer, parameter shard and model library, of the processor, search and entailment models' files, and of the self-hosted ONNX Runtime binary. models/integrity.js and the lock (a lazy chunk of its own) load only when a model loads. Stored files are checked before a runtime reads them, and new downloads right after the load, before the model answers. Hashing runs in a worker of its own (starpi-integrity), one file at a time, because a shard can be a few hundred MB; `crypto.subtle.digest` does not stream, so the worker holds the file once more while it hashes, about twice the largest file at the peak (512 MB for the processor model qwen-0.5b's ONNX file). A file that matches is remembered in the `modelIntegrity` store by URL and size, so later loads only compare its size (an in-place change of the same size is not hashed again; Delete downloaded model data resets these records). A file that does not match its pinned hash is deleted and the load is refused (integrity), so the next load downloads it afresh; a file the lock does not name refuses the load as unverified. WebLLM downloads its presets at `main`, so a model may change upstream after a release: Settings › Trust › Model downloads shows the result of each check and offers "Load unverified (upstream changed)" per model, which keeps the files, records the check as override and loads with a warning. A weekly workflow (model-lock.yml) runs `npm run models:lock -- --check` against the hosts, and a unit test fails until the lock matches the catalogs and the WebLLM version. Vectors of an embedding model that was removed stay stored until another model is selected or the files are forgotten.

<!-- diagram: model-download-integrity -->
```mermaid
flowchart TD
    load(["loadModel or the embedding/entailment model starts"])
    lazy["import models/integrity.js and the lock chunk"]
    stored["checkModelFiles before a runtime reads stored files"]
    scope["files of this model in Cache Storage:<br/>webllm/config, webllm/model, webllm/wasm, transformers-cache"]
    known{"URL and size remembered<br/>as verified in modelIntegrity?"}
    sizeOk["compare the size only"]
    hash["starpi-integrity worker: SHA-256 of the cache entry,<br/>one file at a time, about 2x the file in memory"]
    lockQ{"lock entry for the URL?"}
    match{"hash and size match?"}
    ok["saveCheck verified, remember URL and size"]
    allow{"user allowed this model<br/>to load unverified?"}
    del["delete the file, IntegrityError mismatch:<br/>EngineError integrity, nothing loads"]
    unv["IntegrityError unverified: refused"]
    over["keep the file, check recorded as override,<br/>load with a warning"]
    fresh["after the load: new downloads checked the same way,<br/>before the model answers"]
    reset(["Delete downloaded model data: caches deleted,<br/>forgetVerified() clears the records"])
    weekly(["model-lock.yml weekly: models:lock --check;<br/>unit test: the lock matches the catalogs"])
    load --> lazy --> stored --> scope --> known
    known -->|"yes"| sizeOk --> ok
    known -->|"no"| hash --> lockQ
    lockQ -->|"no"| allow
    lockQ -->|"yes"| match
    match -->|"yes"| ok
    match -->|"no"| allow
    allow -->|"yes"| over
    allow -->|"no, mismatch"| del
    allow -->|"no, not in the lock"| unv
    ok --> fresh
    over --> fresh
    reset -.-> known
    weekly -.-> lockQ
```

<sub>Sources: [`src/js/models/integrity.js`](../src/js/models/integrity.js), [`src/js/models/integrity.worker.js`](../src/js/models/integrity.worker.js), [`src/js/models/integrity-hash.js`](../src/js/models/integrity-hash.js), [`src/js/models/integrity-state.js`](../src/js/models/integrity-state.js), [`src/js/models/model-lock.json`](../src/js/models/model-lock.json), [`src/js/trust/model-integrity-view.js`](../src/js/trust/model-integrity-view.js), [`src/js/webgpu/engine.js`](../src/js/webgpu/engine.js), [`src/js/rag/embed-client.js`](../src/js/rag/embed-client.js), [`scripts/models-lock.mjs`](../scripts/models-lock.mjs), [`.github/workflows/model-lock.yml`](../.github/workflows/model-lock.yml)</sub>

## 6. Knowledge base views

The library and the knowledge graph read Supabase with the browser's anonymous session when there is one, and with the anon key alone otherwise. The select policies return rows that are public or owned by that session, so RLS decides which rows each visitor sees. Every query these views send goes through run() in supabase.js, which maps errors with classifyError and never rejects; a network or timeout failure while the connection is ready switches the app to offline and schedules a reconnect. The shared client aborts each request after 12 s (TIMEOUTS_MS.supabase) and has postgrest retries turned off. library.js and graph.js do not look at the connection state before they query, so an offline app still tries each request. Writing an entity needs a session: renderConnection in ui.js disables every `data-requires-session` button unless the connection is ready, signed in and on the hardened schema, except while it is still pending.

### Knowledge base tab: document list

Opening the library tab (or the reload-documents button) runs loadDocuments, which shows a loading line and then one of three states: a red alert from describeDataError when listDocuments fails, an empty state whose CTA switches to the ingest tab, or one view-doc card per document (newest first, up to 200). A card shows the title cut to two lines, a type badge from sourceBadge (translated for the four types the app writes, the stored value otherwise), the summary or the start of the raw text, up to three tags (leaving out the internal auto-ingest tag and a tag that repeats the type, the two tags ingest adds), and the creation date. loadDocuments has no request token, so when two loads overlap the one that finishes last fills the list. dataErrorKey turns each error kind into an i18n key; describeDataError translates it once, and callers that need the text to follow a language switch pass the key to setText instead.

<!-- diagram: knowledge-views-library -->
```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as ui.js switchTab
    participant Lib as library.js
    participant SB as supabase.js
    participant DB as Supabase with RLS

    User->>UI: switch-tab library, from the nav or the mobile nav
    UI->>Lib: onTabOpen hook from main.js calls loadDocuments()
    Note over User,Lib: the reload-documents button also calls loadDocuments()
    Lib-->>User: docsList shows library.loading
    Lib->>SB: listDocuments()
    SB->>DB: knowledge_documents select id, title, source_type, summary,<br/>raw_content, tags, created_at, order created_at desc, limit 200
    Note over DB: select policy: is_public or owner_id = auth.uid()
    DB-->>SB: rows or error
    SB-->>Lib: Result, error mapped by classifyError
    alt res.ok is false
        Lib-->>User: red role=alert message with describeDataError(res.error)
    else zero documents
        Lib-->>User: library.empty plus CTA library.empty_cta, switch-tab ingest
    else documents found
        Lib-->>User: one view-doc card button per document, data-arg = document id
        Note over Lib: title escaped, at most 2 lines<br/>sourceBadge(source_type, default text): meeting_notes, file, chat, text<br/>get ingest.cat_meeting, cat_file, cat_chat, cat_text, other values shown as stored<br/>summary, else first 150 chars of raw_content, else library.no_summary<br/>up to 3 tags, leaving out auto-ingest and a tag equal to source_type<br/>formatDate(created_at)
    end
    Note over Lib: dataErrorKey: network or timeout give data.error_unreachable,<br/>missing_schema or missing_function give data.error_missing_schema,<br/>forbidden, not_found and auth_disabled get their own keys,<br/>unknown and not_signed_in give data.error_other with the message
```

<sub>Sources: [`src/js/library.js`](../src/js/library.js), [`src/js/supabase.js`](../src/js/supabase.js), [`src/js/config.js`](../src/js/config.js), [`src/js/ui.js`](../src/js/ui.js), [`src/js/main.js`](../src/js/main.js), [`src/js/ingest.js`](../src/js/ingest.js), [`src/index.html`](../src/index.html), [`backend/supabase/migrations/20260923000000_harden_rls_anonymous_auth.sql`](../backend/supabase/migrations/20260923000000_harden_rls_anonymous_auth.sql)</sub>

### Knowledge base tab: document modal

Clicking a card calls viewDocument, which resets the title, meta line and content, opens docModal through dialog.js with the card as the trigger, and takes a new request token from viewSeq before it calls getDocument. getDocument queries the document row and its knowledge_sections in parallel (RLS returns sections only for a document the visitor may read); a missing row is reported as not_found and a failed sections query just yields no sections. When the reply arrives, it is dropped if the token is no longer the latest or the dialog has been closed, so a late reply cannot fill a dialog that was reopened for another document. An error is written with setText, so its text follows a language switch; on success the title and meta are set, then the summary (as a quote) and the sections, or raw_content, are rendered through renderMarkdown, which sanitizes with DOMPurify. dialog.js keeps Tab inside the open dialog, closes the topmost dialog on Escape and returns focus to the card when it is still in the page.

<!-- diagram: knowledge-views-library-document -->
```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Lib as library.js viewDocument
    participant Dlg as dialog.js
    participant SB as supabase.js
    participant DB as Supabase with RLS
    participant R as render.js

    User->>Lib: click card, view-doc with data-arg = document id
    Note over Lib: returns at once if docModal, modalDocTitle,<br/>modalDocMeta or modalDocContent is missing
    Lib->>Lib: setText title library.document, meta library.loading_document,<br/>content emptied and its data-i18n removed
    Lib->>Dlg: openDialog(docModal, trigger = the card)
    Dlg-->>User: modal shown, focus on its first focusable control, the close button
    Lib->>Lib: viewSeq incremented, token = viewSeq
    Lib->>SB: getDocument(id)
    par document row
        SB->>DB: knowledge_documents eq id, maybeSingle
    and sections
        SB->>DB: knowledge_sections heading, markdown_content,<br/>eq document_id, order section_index
    end
    Note over DB: sections are visible only when the parent document<br/>is public or owned by this session
    alt document query failed
        SB-->>Lib: ok false with the classified error
    else no row returned
        SB-->>Lib: ok false, kind not_found, Document not found or not shared.
    else row found
        SB-->>Lib: doc plus sections, empty list if the sections query failed
    end
    alt token is not viewSeq or isDialogOpen(docModal) is false
        Lib->>Lib: reply dropped, the dialog was closed or reopened for another document
    else res.ok is false
        Lib-->>User: title stays library.document, meta cleared,<br/>content = setText with dataErrorKey(res.error), follows a language switch
    else ok
        Lib-->>User: title = doc.title, meta = library.meta with date, time and section count
        Lib->>R: renderMarkdown: summary as a quote headed library.summary,<br/>then each section markdown_content, else raw_content or library.no_content
        R-->>Lib: marked output sanitized by DOMPurify
        Lib-->>User: modalDocContent shows the rendered content
    end
    alt close-doc-modal button
        User->>Lib: closeDocModal()
        Lib->>Dlg: closeDialog(docModal)
    else Escape
        User->>Dlg: keydown Escape closes the topmost dialog
    end
    Dlg-->>User: docModal hidden, focus back to the card if it is still in the page
```

<sub>Sources: [`src/js/library.js`](../src/js/library.js), [`src/js/dialog.js`](../src/js/dialog.js), [`src/js/supabase.js`](../src/js/supabase.js), [`src/js/render.js`](../src/js/render.js), [`src/js/i18n/index.js`](../src/js/i18n/index.js), [`src/index.html`](../src/index.html), [`backend/supabase/migrations/20260923000000_harden_rls_anonymous_auth.sql`](../backend/supabase/migrations/20260923000000_harden_rls_anonymous_auth.sql)</sub>

### Knowledge graph tab: loading, status and entity list

graph.js loads with the graph tab: graph-tab.js imports it when the tab first opens (it is used nowhere else) and handles the tab's reload-graph and open-entity-modal buttons, and a view that does not load leaves the data.error_unreachable text in #graphStatus. loadKnowledgeGraph runs when the graph tab opens, on reload-graph and after an entity is saved, and fetches entities and relations in parallel. If the entity query fails the graph is empty and the describeDataError text becomes the status; a failed relations query is ignored and only drops the edges; zero entities give graph.empty. The status message is stored as a closure, so each redraw translates it again. Selection is reset, then renderGraph checks that the canvas has a size, rebuilds the entity list (one button per entity, the keyboard and screen-reader way into the graph; when a list button had focus, focus moves to the new button of the same entity) and shows empty and error states as text in the #graphStatus element (role status) instead of drawing them on the canvas. Locale changes and window resizes redraw only while the graph tab is visible. Loads have no request token: when two overlap, the one that finishes last sets the graph, and the first to finish already hides the loader.

<!-- diagram: knowledge-views-graph-load -->
```mermaid
flowchart TD
    Trigger(["Graph tab opened via onTabOpen graph,<br/>reload-graph button or a saved entity"]) --> ShowLoader["loadKnowledgeGraph()<br/>show graphLoading"]
    ShowLoader --> Fetch["Promise.all: listEntities() and listRelations()<br/>knowledge_entities order name, limit 500<br/>knowledge_relations limit 2000"]
    Fetch --> EntOk{"entRes.ok?"}
    EntOk -->|"no"| ErrState["graph = no entities, no relations<br/>emptyMessage = closure over describeDataError(entRes.error)"]
    EntOk -->|"yes"| RelOk{"relRes.ok?"}
    RelOk -->|"yes"| WithRel["graph = entities + relations"]
    RelOk -->|"no, ignored silently"| NoRel["graph = entities, relations = empty list"]
    WithRel --> Empty{"no entities?"}
    NoRel --> Empty
    Empty -->|"yes"| EmptyMsg["emptyMessage = closure over t graph.empty"]
    Empty -->|"no"| NoMsg["emptyMessage = null"]
    ErrState --> Reset
    EmptyMsg --> Reset
    NoMsg --> Reset["selectedId = null<br/>showEntityDetails(null): graph.details_badge, graph.details_empty"]
    Reset --> RenderCall["renderGraph()"]
    RenderCall --> Hide["finally: hide graphLoading"]
    RenderCall -.-> Guard

    subgraph sg_render["renderGraph(): guard, entity list and status"]
        Guard{"graphCanvas, 2d context<br/>and non-zero size?"}
        Guard -->|"no, e.g. tab hidden"| Skip(["return: canvas, entity list<br/>and graphStatus unchanged"])
        Guard -->|"yes"| Scale["scale canvas by devicePixelRatio<br/>clearRect, reset positions map"]
        Scale --> List["renderEntityList(): one select-entity button per entity<br/>in graphEntityList, name via textContent,<br/>aria-pressed true on the selected one,<br/>focus in the list moves to the new button with the same id"]
        List --> ListLabel["graphEntityListLabel hidden<br/>when there are no entities"]
        ListLabel --> HasEnt{"graph.entities empty?"}
        HasEnt -->|"yes"| Status["graphStatus shown with emptyMessage()<br/>or graph.empty, computed on every draw<br/>so it follows the language, nothing drawn"]
        HasEnt -->|"no"| Hidden["graphStatus hidden"]
        Hidden --> Canvas(["canvas drawing, see the next diagram"])
    end

    Locale(["onLocaleChange or window resize"]) --> Visible{"tab-graph visible?"}
    Visible -->|"yes, renderGraph()"| Guard
    Visible -->|"no"| Ignore(["no redraw"])
```

<sub>Sources: [`src/js/graph.js`](../src/js/graph.js), [`src/js/supabase.js`](../src/js/supabase.js), [`src/js/library.js`](../src/js/library.js), [`src/js/main.js`](../src/js/main.js), [`src/index.html`](../src/index.html)</sub>

### Knowledge graph tab: canvas drawing

With at least one entity, renderGraph lays the entities out on a circle (radius 0.36 of the smaller canvas side, first entity at the top) and then places text so that it does not collide. Nodes reserve a square each; names are placed next, the selected node's name first, below the node or above it, shortened with an ellipsis when neither spot is free, and drawn in full below the node even if it overlaps when no shortened form fits either. Relation lines come next, then their relation_type labels on white pills: with a node selected only its relations get a label, and a label that would cover a node, a name or an earlier label at all three tried spots is left out (every relation is still listed in the entity details). Nodes and names are drawn last, each name over a light halo so that a line passing behind it stays readable. Names reach the canvas only through fillText and strokeText, never as HTML.

<!-- diagram: knowledge-views-graph-canvas -->
```mermaid
flowchart TD
    Start(["renderGraph() with at least one entity"]) --> Layout["circle layout around the canvas centre<br/>radius = 0.36 x min(width, height)<br/>angle = index / count x 2 pi - pi / 2, first entity at the top"]
    Layout --> Taken["taken boxes: a square around each node,<br/>half side 22, 28 for the selected node"]
    Taken --> NameOrder["names: selected entity first, then the others in list order<br/>11px, bold when selected, weight 600 otherwise"]
    NameOrder --> Try["for each entity try the full name, then cuts ending in an ellipsis,<br/>down to min(6, name length) characters"]
    Try --> Pos{"text box free of every taken box<br/>below the node at y + r + 5,<br/>or else above it at y - r - 18?<br/>r = 18, or 22 when selected"}
    Pos -->|"yes, first free spot"| Place["name placed there,<br/>its box added to taken"]
    Pos -->|"no spot for any cut"| Fallback["full name below the node,<br/>its box added to taken"]
    Place --> Lines
    Fallback --> Lines["each relation with both endpoints placed:<br/>straight line, amber and 2.5 px when it touches selectedId,<br/>light grey and 1.5 px otherwise"]
    Lines --> Sort["labels: relations touching the selected node first"]
    Sort --> Sel{"a node is selected and<br/>the relation does not touch it?"}
    Sel -->|"yes"| NoLabel(["no label"])
    Sel -->|"no"| Pill["pill for relation_type: 10px monospace,<br/>width = text + 8, height 14"]
    Pill --> Spot{"free spot at 0.5, 0.38 or 0.62<br/>of the line, tried in that order?"}
    Spot -->|"yes"| DrawPill["white pill, amber border when selected,<br/>label drawn, box added to taken"]
    Spot -->|"no, all three overlap"| Skipped(["label left out, the relation<br/>is still listed in the entity details"])
    DrawPill --> Nodes
    NoLabel --> Nodes
    Skipped --> Nodes["each entity: when selected, a translucent disc of radius r + 6<br/>in the type colour behind the circle<br/>circle r = 18 filled white, or r = 22 filled yellow when selected<br/>stroke in the entity_type colour, amber when selected,<br/>project blue for unknown types"]
    Nodes --> Initials["first two characters of the name,<br/>upper case, centred in the circle"]
    Initials --> Name["placed name drawn over a light halo stroke 3 px wide"]
```

<sub>Sources: [`src/js/graph.js`](../src/js/graph.js)</sub>

### Knowledge graph tab: selection and ask-entity

A canvas click selects the first node within 25 px; the buttons in the entity list select the same way by id; the redraw rebuilds the list, and renderEntityList moves keyboard focus from the replaced button to the new button of the same entity. selectEntity redraws the graph and shows the details: type badge, description, outgoing edges (listing target names) and incoming edges (listing source names); a click on empty canvas clears the selection. The ask-entity button switches to the chat tab and submits graph.ask_prompt through submitChat, which drops the question with status.busy while an earlier question is still in progress (being answered, or waiting for a file that is still being read). Otherwise submitChat clears the chat input box, so an unsent draft there is lost, and a file attached in the chat input goes along with the question. submitChat gets chatMode grounded, so the question is always answered in verified source mode, and the composer toggle switches to it when it showed free chat. From there the question takes the normal source-mode path of the current mode (section 3), so the entity name goes wherever a typed question would.

<!-- diagram: knowledge-views-graph-interactions -->
```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Canvas as graphCanvas click handler
    participant G as graph.js
    participant UI as ui.js
    participant Chat as chat.js

    alt pointer on the canvas
        User->>Canvas: click at x, y
        Canvas->>G: hit test the positions map in entity order,<br/>Math.hypot up to 25 px, first match wins
    else keyboard or screen reader
        User->>G: select-entity button in graphEntityList, data-arg = entity id
    end
    alt a node was hit or a list button used
        G->>G: selectEntity(id): selectedId = id, renderGraph()
        Note over G: the redraw labels only the relations of this node<br/>and rebuilds the entity list with its button aria-pressed,<br/>focus in the list moves to the new button with the same id
        G-->>User: showEntityDetails(entity), the empty state if the id is gone
        Note over G: badge graph.type_ + entity_type, raw type if no key<br/>swatch in the type colour, name, description or graph.no_description<br/>graph.connections with the count of both directions<br/>outgoing: source is the entity, lists target names, sr-only graph.outgoing<br/>incoming: target is the entity, lists source names, sr-only graph.incoming<br/>unknown ids show graph.unknown_entity, none shows graph.no_edges<br/>an ask-entity button labelled graph.ask
    else click on empty canvas
        G->>G: selectedId = null, renderGraph()
        G-->>User: showEntityDetails(null): graph.details_badge, graph.details_empty
    end

    User->>G: ask-entity, data-arg = entity name
    G->>UI: switchTab(chat)
    UI-->>User: chat tab shown, sidebar closed when the window is under 768 px wide
    G->>Chat: submitChat(t graph.ask_prompt with the name, chatMode grounded)
    alt busy: an earlier question is being answered or waits for its file
        Chat-->>User: status.busy, the question is dropped
    else idle
        Note over Chat: waits for a file still being read,<br/>clears the chat input box, sends a file attached there with the question
        Note over Chat: chatMode grounded: the toggle switches to verified source mode
        Chat-->>User: regular source-mode flow answers in the chat tab
    end
```

<sub>Sources: [`src/js/graph.js`](../src/js/graph.js), [`src/js/ui.js`](../src/js/ui.js), [`src/js/chat.js`](../src/js/chat.js), [`src/index.html`](../src/index.html)</sub>

### Knowledge graph tab: new entities

The New entity and Save buttons carry `data-requires-session`, so renderConnection disables them unless the connection is ready with a session and the hardened schema (they stay enabled while the connection is still pending). Unlike the ingest tab, the graph tab has no `.session-note`, so nothing there says why the buttons are disabled. The entity modal opens through dialog.js with focus in the name field. Saving validates the name, falls back to the project type for unknown types and calls insertEntity; RLS accepts the row only as a private row owned by this session, and CHECK constraints from the 20260924000000 migration cap name, type and description at 500, 64 and 5000 characters, above the 200 and 2000 the client cuts to. A failure alerts graph.save_failed with describeDataError and leaves the modal open (a network or timeout failure while the connection is ready also switches the app to offline, which disables both buttons until a reconnect); success closes the modal and reloads the graph. saveEntity has no in-flight guard, so a second click during the insert sends a second insert. openDialog gets clearEntityForm as its onClose callback, and closeDialog runs it on every close (the X and Cancel buttons, Escape, a successful save), so each close clears the name and description while the type select keeps its value.

<!-- diagram: knowledge-views-graph-new-entity -->
```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as ui.js renderConnection
    participant G as graph.js
    participant Dlg as dialog.js
    participant SB as supabase.js
    participant DB as knowledge_entities with RLS

    Note over UI: canWrite = status ready and signedIn and hardened<br/>data-requires-session buttons, here New entity and Save,<br/>are disabled when canWrite is false and the status is not pending
    alt New entity disabled
        Note over User,G: dom.js has no disabled check of its own, it relies on<br/>the browser not activating a disabled button<br/>the graph tab shows no session-note explaining why
    else enabled
        User->>G: open-entity-modal
        G->>Dlg: openDialog(entityModal, trigger = the button,<br/>initialFocus = newEntityName, onClose = clearEntityForm)
        Dlg-->>User: modal shown, focus in the name field
    end
    User->>G: save-entity
    Note over G: name trimmed and cut to 200 chars, description to 2000<br/>a type outside project, person, metric, tech, regulation becomes project<br/>no in-flight guard, a second click sends a second insert
    alt name is empty
        G-->>User: alert graph.name_required, modal stays open
    else name given
        G->>SB: insertEntity(name, entityType, description)
        SB->>DB: insert name, entity_type, description
        Note over DB: owner_id defaults to auth.uid()<br/>knowledge_entities_insert_own checks<br/>owner_id = auth.uid() and is_public = false<br/>CHECK limits: name 500, entity_type 64, description 5000
        DB-->>SB: ok or error
        SB-->>G: Result, error mapped by classifyError
        alt res.ok is false
            G-->>User: alert graph.save_failed + describeDataError, modal open, input kept
            Note over UI,G: a network or timeout failure while the status is ready makes run()<br/>set it to offline, so renderConnection disables New entity and Save until a reconnect
        else inserted
            G->>Dlg: closeEntityModal(): closeDialog(entityModal)
            Dlg->>G: modal hidden, onClose runs clearEntityForm()
            G->>G: name and description cleared, the type select keeps its value
            Dlg-->>User: focus back to New entity
            G->>G: await loadKnowledgeGraph()
            G-->>User: graph reloaded, selection reset
        end
    end
    alt close-entity-modal, the X or Cancel button
        User->>G: closeEntityModal()
        G->>Dlg: closeDialog(entityModal)
    else Escape
        User->>Dlg: keydown Escape closes the topmost dialog
    end
    Dlg->>G: entityModal hidden, onClose runs clearEntityForm()
    G->>G: name and description cleared, the type select keeps its value
    Dlg-->>User: focus back to New entity if it is still in the page
```

<sub>Sources: [`src/js/graph.js`](../src/js/graph.js), [`src/js/dialog.js`](../src/js/dialog.js), [`src/js/ui.js`](../src/js/ui.js), [`src/js/dom.js`](../src/js/dom.js), [`src/js/supabase.js`](../src/js/supabase.js), [`src/js/library.js`](../src/js/library.js), [`src/js/main.js`](../src/js/main.js), [`src/index.html`](../src/index.html), [`backend/supabase/migrations/20260923000000_harden_rls_anonymous_auth.sql`](../backend/supabase/migrations/20260923000000_harden_rls_anonymous_auth.sql), [`backend/supabase/migrations/20260924000000_lock_published_rows.sql`](../backend/supabase/migrations/20260924000000_lock_published_rows.sql)</sub>

## 7. Languages, storage and offline

Six interface languages with dictionaries loaded on demand, what the app keeps where in the browser (web storage, IndexedDB, OPFS, caches and memory), and how the service worker keeps the app usable offline and updates it.

### Locale boot and the language switch

The dictionaries live in `src/locales`: a root file per language (`<lang>.json`) and one file per namespace (`<ns>/<lang>.json`, 18 namespaces such as `chat-thread`, `providers`, `voice`, `companion` or `sync`), whose keys are reached as `<ns>.<key>` and merged into the root dictionary; a key may be defined only once. English is part of the app bundle and the fallback for every key another language lacks; German, French, Spanish, Italian and Turkish are lazy chunks, one per root file and namespace. i18n/index.js reads `starpi_locale` when it loads and, with top-level await, loads that language before main.js runs, so t() is synchronous and the first render is already in the right language; a language that cannot be loaded (offline before its files were cached) falls back to English. initI18n sets `html lang` and translates the document. The language switch is a select of the six languages, each named in itself (renderLanguageSwitch replaces the two static EN/DE buttons of the pre-boot markup); setLocale switches at once when the language is loaded, otherwise when its files arrive, unless a later choice came first, persists the choice, re-runs applyTranslations and calls every onLocaleChange listener, without a reload. Views that render formatted numbers or text built with t() subscribe (the model pickers, the engine banner, the graph, the workspace, the benchmark, the conversation list, projects, assistants, memory, canvas, council, research, Live and the companion view). The language packs of the source check (core/lang) are separate: English and German are in the first load, the other four load after the first paint (loadShippedLanguages). Answer purposes keep their English instructions and name the answer language.

<!-- diagram: i18n-boot-and-switch -->
```mermaid
flowchart TD
    load(["i18n/index.js loads, before main.js runs"])
    stored["readStoredLocale(): starpi_locale if one of<br/>en, de, fr, es, it, tr; else en"]
    enQ{"English?"}
    fetchLang["loadLocale(lang): root file and the 18 namespace files,<br/>lazy chunks, buildDictionary merges them"]
    okQ{"loaded?"}
    fallback["current = en, keys show English"]
    boot["initI18n(): html lang, applyTranslations(document)"]
    sel(["language select: six languages named in themselves"])
    set["setLocale(lang): request number recorded"]
    loadedQ{"dictionary loaded?"}
    wait["loadLocale(lang), switch only if still<br/>the latest request and it loaded"]
    apply["apply(): starpi_locale written (a failure is ignored),<br/>html lang, applyTranslations, onLocaleChange listeners"]
    views["views with formatted numbers or t() text re-render:<br/>pickers, engine banner, graph, workspace, bench,<br/>conversations, projects, memory, canvas, council,<br/>research, Live, companion view"]
    packs["core/lang: en and de in the first load,<br/>fr, es, it, tr after the first paint (loadShippedLanguages)"]
    load --> stored --> enQ
    enQ -->|"yes"| boot
    enQ -->|"no"| fetchLang --> okQ
    okQ -->|"yes"| boot
    okQ -->|"no"| fallback --> boot
    sel --> set --> loadedQ
    loadedQ -->|"yes"| apply
    loadedQ -->|"no"| wait --> apply
    apply --> views
    boot -.-> packs
```

<sub>Sources: [`src/js/i18n/index.js`](../src/js/i18n/index.js), [`src/locales/index.js`](../src/locales/index.js), [`src/js/ui.js`](../src/js/ui.js), [`src/js/main.js`](../src/js/main.js), [`src/js/core/lang/index.js`](../src/js/core/lang/index.js), [`src/js/ai/purposes.js`](../src/js/ai/purposes.js), [`src/index.html`](../src/index.html)</sub>

### How an element gets its translated text

Keys reach the runtime through data-i18n attributes in markup and HTML templates, through setText (which records the key and its params on the element so later language switches re-translate it), through attributes that modules set directly, or through direct t() calls. applyTranslations, run by initI18n, setLocale and messages.js resetMessages, parses data-i18n-params as JSON and writes only textContent and the placeholder, title and aria-label attributes; direct t() results go into confirm and alert dialogs, status texts, prompts, quoted answers or HTML templates built with the UI kit's escaping. t() looks the dotted key up in the dictionary of its locale argument, which defaults to the current language, then in English, then returns the key itself, so a missing entry stays visible; demo.js passes a locale, so the prepared demo answer uses the language of the sample set in the workspace. With params it first resolves plural forms {name:one|other} (the one word when String(params[name]) is exactly 1) and then replaces {name} placeholders, both only for names present in params; hasKey checks one dictionary without fallback. Numbers, dates and speech recognition use the language's Intl tag (en-US, de-DE, fr-FR, es-ES, it-IT, tr-TR).

<!-- diagram: i18n-translate-and-fallback -->
```mermaid
flowchart TD
    subgraph sg_keys["Where keys come from"]
        markup["index.html and HTML templates<br/>data-i18n, data-i18n-placeholder, data-i18n-title, data-i18n-aria"]
        settext["setText(el, key, params): records key and params on the element"]
        attrset["setAttribute of data-i18n-aria and data-i18n-params by a module"]
        direct["t(key, params) called directly: dialogs, status texts,<br/>prompts, quoted answers, kit templates;<br/>demo.js adds the sample set's language"]
    end
    settext --> attrs["annotated element"]
    markup --> attrs
    attrset --> attrs
    callers(["initI18n and setLocale on document,<br/>messages.js resetMessages on the chat list"]) --> apply
    attrs --> apply["applyTranslations(root)"]
    apply --> parse{"data-i18n-params a valid JSON object?"}
    parse -->|"yes"| withParams["params = parsed object"]
    parse -->|"no"| noParams["params = undefined"]
    withParams --> tcall
    noParams --> tcall
    settext -->|"immediately"| tcall
    direct --> tcall
    tcall["t(key, params, locale = current)"] --> lk1{"key resolves in the dictionary of locale?"}
    lk1 -->|"yes"| tmpl["template"]
    lk1 -->|"no"| lk2{"resolves in English?"}
    lk2 -->|"yes"| tmpl
    lk2 -->|"no"| keyself["the key itself"]
    keyself --> tmpl
    tmpl --> hasP{"params given?"}
    hasP -->|"no"| out["translated string"]
    hasP -->|"yes"| plural["plural forms {name:one|other}"] --> interp["{name} placeholders"] --> out
    out -->|"applyTranslations or setText"| write["textContent, placeholder, title or aria-label, never innerHTML"]
    out -->|"direct callers"| writeDirect["dialog text, textContent, answer text,<br/>or escaped inside a kit template"]
    subgraph sg_intl["Language-aware formatting"]
        fmtN["formatNumber: Intl.NumberFormat"]
        fmtD["formatDate: Intl.DateTimeFormat"]
        rec["speech recognition language"]
        intl["getIntlLocale(): en-US, de-DE, fr-FR, es-ES, it-IT, tr-TR"]
    end
    fmtN --> intl
    fmtD --> intl
    rec --> intl
```

<sub>Sources: [`src/js/i18n/index.js`](../src/js/i18n/index.js), [`src/locales/index.js`](../src/locales/index.js), [`src/locales/en.json`](../src/locales/en.json), [`src/js/messages.js`](../src/js/messages.js), [`src/js/ui/kit.js`](../src/js/ui/kit.js), [`src/js/demo.js`](../src/js/demo.js), [`src/js/voice/recognition.js`](../src/js/voice/recognition.js)</sub>

### Tests that keep the dictionaries and keys consistent

tests/unit/i18n.test.mjs checks the layout first: every namespace directory is registered with its English file bundled, every shipped language has a root file and only prepared languages do, a namespace never redefines a root key, and namespace keys stay under their namespace. German and every other language must have exactly the keys of English (root and namespaces), the same placeholders, every plural form kept and flat, no empty values, and fewer than 15 percent of entries identical to English. It collects every key used in the source (data-i18n attributes, t() and setText calls, and the key families the code assembles at runtime), requires more than 250 of them, and requires each to resolve in every language without fallback. It pins t() (the default, a lookup in another language, interpolation, unknown keys, plural forms in every language), that each language is named in itself for the switch, the fallback to English key by key, that unshipped languages cannot be chosen, that a missing file loads to false, that concurrent loads share one request, and buildDictionary's merge. tests/unit/actions.test.mjs rejects emoji in the source and any static aria-label in index.html without data-i18n-aria (the pre-boot EN/DE buttons, named in their own language, excepted). The end-to-end tests check the English default, a switch to German without a reload that persists, six languages with switches to French and Turkish, and namespace strings that load with the language.

<!-- diagram: i18n-test-guards -->
```mermaid
flowchart TD
    subgraph unit["tests/unit/i18n.test.mjs"]
        layout["layout: namespaces registered, English bundled,<br/>root file per shipped language, keys defined once,<br/>namespace keys under their namespace"]
        parity["every language: the keys of English, same placeholders,<br/>plural forms kept and flat, no empty values,<br/>under 15 percent identical to English"]
        used["used keys: data-i18n, t(), setText and runtime families;<br/>more than 250; each resolves in every language"]
        tbeh["t(): default, other language, interpolation, unknown key,<br/>plural forms in every language"]
        load["loadLocale: English fallback key by key, unshipped not selectable,<br/>missing files load to false, one shared request; buildDictionary"]
    end
    subgraph act["tests/unit/actions.test.mjs"]
        emoji["no emoji in src"]
        aria["static aria-label needs data-i18n-aria,<br/>except the lang-tagged EN/DE pre-boot buttons"]
    end
    subgraph e2e["end-to-end"]
        e1["app.spec: English default, German without a reload, kept on reload"]
        e2["app.spec: six languages, French and Turkish without a reload"]
        e3["shell.spec: namespace strings load with the language"]
    end
    fail(["CI fails"])
    layout -.-> fail
    parity -.-> fail
    used -.-> fail
    tbeh -.-> fail
    load -.-> fail
    emoji -.-> fail
    aria -.-> fail
    e1 -.-> fail
    e2 -.-> fail
    e3 -.-> fail
```

<sub>Sources: [`tests/unit/i18n.test.mjs`](../tests/unit/i18n.test.mjs), [`tests/unit/actions.test.mjs`](../tests/unit/actions.test.mjs), [`tests/e2e/app.spec.mjs`](../tests/e2e/app.spec.mjs), [`tests/e2e/shell.spec.mjs`](../tests/e2e/shell.spec.mjs), [`src/locales/index.js`](../src/locales/index.js)</sub>

### localStorage, sessionStorage and the auth session

Preferences live in localStorage, all under `starpi_` names: the picker value (`starpi_assistant_v1`, with `starpi_compute_mode` kept in step for code that still asks for the 2.x mode), the on-device preset (`starpi_webgpu_model`), the NVIDIA model (`starpi_nvidia_model`), the composer's mode (`starpi_chat_mode`), the Web toggle (`starpi_web_search_v1`), the strength and a pinned model, the own server's address, the relay switch and the route each auto provider took last, thinking per answer, the language, the theme and the sidebar (both read by theme-boot.js before the first paint), voice settings, search by meaning, research preferences, the tools switched on, tool approvals, MCP servers, the search service, unsent drafts per conversation, the router's small answer cache, the vault hint and the companion link marker and retrieval ceiling. The chat session id (`starpi_chat_session_id`) names the open conversation. `starpi_local_chats_v1` and the plaintext key names of 2.x are read once by the migration and then removed. Provider keys never go to localStorage: a key of the tab lives in sessionStorage (`starpi_key_<slot>`, or the 2.x name for Gemini and OpenRouter) and is gone with the tab; the vault is in IndexedDB. The Supabase auth session (`starpi-auth`) is in localStorage, written by the Supabase client. Every write goes through storage.js, which returns false instead of throwing when storage is missing, blocked or full; the app then keeps the value for the page.

<!-- diagram: client-storage-web-storage -->
```mermaid
flowchart LR
    subgraph ls["localStorage, per origin"]
        model[("model choice: starpi_assistant_v1, starpi_compute_mode,<br/>starpi_webgpu_model, starpi_nvidia_model,<br/>starpi_model_strength_v1, starpi_model_pinned_v1")]
        chat[("chat: starpi_chat_mode, starpi_web_search_v1, starpi_thinking_v1,<br/>starpi_chat_session_id, starpi_chat_drafts_v1, starpi_ai_cache_v1")]
        net[("reach: starpi_llm_url, starpi_relay_fallback,<br/>starpi_transport_id per auto provider")]
        shell[("shell: starpi_locale, starpi_theme, starpi_sidebar")]
        feat[("features: starpi_voice_v1, starpi_semantic_search,<br/>starpi_research_prefs_v1, starpi_tools_v1,<br/>starpi_tool_approvals_v1, starpi_mcp_servers_v1, starpi_search_v1")]
        comp[("companion: starpi_companion_linked,<br/>starpi_companion_source")]
        misc[("starpi_vault_hint; starpi-auth (Supabase session)")]
        legacy[("2.x, read once then removed: starpi_local_chats_v1,<br/>starpi_gemini_key, starpi_openrouter_key, starpi_remember_keys")]
    end
    subgraph ss["sessionStorage, per tab"]
        keys[("provider and service keys: starpi_key_slot,<br/>or starpi_gemini_key and starpi_openrouter_key")]
    end
    themeboot["theme-boot.js before the first paint"] --> shell
    state["state.js, model-selection.js"] --> model
    thread["thread, composer, mode control, router"] --> chat
    providers["providers view, transport-select.js"] --> net
    keysjs["ai/keys.js"] --> keys
    keysjs --> misc
    migrate["store/migrate.js, once"] --> legacy
    legacy -.->|"chats into IndexedDB, keys into the tab"| keys
    sb["Supabase client"] --> misc
    storage["storage.js: never throws,<br/>false when refused"] -.-> ls
    storage -.-> ss
```

<sub>Sources: [`src/js/config.js`](../src/js/config.js), [`src/js/state.js`](../src/js/state.js), [`src/js/storage.js`](../src/js/storage.js), [`src/js/ai/keys.js`](../src/js/ai/keys.js), [`src/js/ai/model-selection.js`](../src/js/ai/model-selection.js), [`src/js/ai/transport-select.js`](../src/js/ai/transport-select.js), [`src/js/ai/thinking.js`](../src/js/ai/thinking.js), [`src/js/ai/router.js`](../src/js/ai/router.js), [`src/js/chat/context.js`](../src/js/chat/context.js), [`src/js/theme-boot.js`](../src/js/theme-boot.js), [`src/js/voice/settings.js`](../src/js/voice/settings.js), [`src/js/rag/embed-client.js`](../src/js/rag/embed-client.js), [`src/js/companion/tier.js`](../src/js/companion/tier.js), [`src/js/store/migrate.js`](../src/js/store/migrate.js), [`src/js/supabase.js`](../src/js/supabase.js)</sub>

### IndexedDB, OPFS and the caches

The app database `starpi` (store/schema.js, version 1, one upgrade step per version) holds everything the app keeps: conversations and their message nodes (a tree per conversation), blobs (attachments, generated images, small originals), projects, assistants, memory notes (sealed with the vault key when a passphrase is set), canvas artifacts, workspace documents with their chunks and vectors (the ingestion worker writes them), signing keys (non-extractable CryptoKeys of the device), research jobs, benchmark runs, model integrity records, settings (migration markers, integrity results, the sync state) and the key vault. Large originals and extracted texts go to OPFS (store/opfs.js), or to the database's blobs where OPFS is missing. store/quota.js reads the storage estimate for Settings › Files on this device and asks once for persistent storage when the first file is kept. The pairing secret of the companion is in a database of its own, `starpi-companion`, sealed with a non-extractable AES-GCM key. The service worker caches same-origin GET responses in `starpi-shell-<version>` (the app shell of one build) and `starpi-assets` (hashed /assets files fetched on a miss, kept across updates while the new build still lists them). WebLLM keeps model files in webllm/model, webllm/wasm and webllm/config and Transformers.js in transformers-cache; their names do not start with `starpi-`, so an update never deletes them, and Delete downloaded model data does. "Forget all" in the workspace and Settings deletes every document, chunk, vector and file.

<!-- diagram: client-storage-caches-memory -->
```mermaid
flowchart TD
    subgraph idb["IndexedDB starpi (store/schema.js)"]
        conv[("conversations, nodes, blobs")]
        org[("projects, assistants, memory, artifacts")]
        ws[("docs, chunks, vectors")]
        trust[("signingKeys, keyvault")]
        jobs[("research, bench, modelIntegrity, settings")]
    end
    opfs[("OPFS: originals and extracted texts<br/>(blobs where OPFS is missing)")]
    pair[("IndexedDB starpi-companion: sealed pairing secret")]
    subgraph cache["Cache Storage"]
        shell[("starpi-shell-version: app shell")]
        assets[("starpi-assets: hashed /assets files on a miss")]
        webllm[("webllm/model, webllm/wasm, webllm/config")]
        tf[("transformers-cache")]
    end
    thread["chat/store.js, thread"] --> conv
    feat["projects.js, assistants.js, ai/memory.js, canvas.js"] --> org
    worker["ingestion worker: workspace-core.js"] --> ws
    worker --> opfs
    sign["trust/signing.js, ai/keys.js"] --> trust
    others["research/jobs.js, bench-history.js, integrity.js,<br/>store/migrate.js, sync/sync.js"] --> jobs
    pairjs["companion/pair.js"] --> pair
    sw["sw.js"] --> shell
    sw --> assets
    eng["WebLLM in starpi-webllm"] --> webllm
    tfw["Transformers.js in starpi-wasm"] --> tf
    quota["store/quota.js: estimate, persist() once<br/>when the first file is kept"] -.-> idb
    forget(["Forget all: documents, chunks, vectors, files"]) -.-> ws
    forget -.-> opfs
    del(["Delete downloaded model data"]) -.-> webllm
    del -.-> tf
    upd(["sw activate: other starpi- caches deleted,<br/>assets no longer listed removed"]) -.-> assets
```

<sub>Sources: [`src/js/store/schema.js`](../src/js/store/schema.js), [`src/js/store/idb.js`](../src/js/store/idb.js), [`src/js/store/opfs.js`](../src/js/store/opfs.js), [`src/js/store/quota.js`](../src/js/store/quota.js), [`src/js/rag/workspace-core.js`](../src/js/rag/workspace-core.js), [`src/js/chat/store.js`](../src/js/chat/store.js), [`src/js/trust/signing.js`](../src/js/trust/signing.js), [`src/js/companion/pair.js`](../src/js/companion/pair.js), [`src/js/models/integrity.js`](../src/js/models/integrity.js), [`src/sw.js`](../src/sw.js), [`src/js/webgpu/engine.js`](../src/js/webgpu/engine.js)</sub>

### In-memory answer stores

Some things exist only in main-thread memory and are gone on reload. The citation registry (rag/citations.js) holds the citations of at most 200 retrievals, workspace searches or demo answers, and the receipt drafts (rag/receipts.js) at most 50; in both the oldest is evicted first, and New chat clears neither, so a citation whose scope was evicted no longer opens and a Receipt button whose draft was evicted does nothing. The source check adds the ranges of statements that need review to the CSS highlight `starpi-review` where the Highlight API exists; resetMessages clears it. The thread keeps, for at most 50 answers, what read-aloud needs (the label, the excerpts the gate takes, a web grounding), and the decoded data of attachments it already read. Conversations themselves are not in memory: every turn is in IndexedDB, and a grounded answer restored from history keeps its text, sources and counts but no excerpts, so read-aloud withholds its numbers and no receipt can be built again. providers.js remembers the models the own server listed per address, the runner the live model lists of the providers with keys, and chat-store.js the message writes still under way, so a delete can wait for them.

<!-- diagram: client-storage-answer-memory -->
```mermaid
flowchart TD
    subgraph mem["Main-thread memory, gone on reload"]
        scopes[("rag/citations.js scopes: at most 200, oldest evicted")]
        drafts[("rag/receipts.js drafts: at most 50, oldest evicted")]
        hl[("CSS highlight starpi-review")]
        readable[("thread readable answers: at most 50,<br/>label, gate excerpts, web grounding")]
        blobs[("thread blob data cache: attachment base64 and text")]
        models[("providers.js server models per address,<br/>runner live model lists")]
        writes[("chat-store.js pending writes, deleted sessions")]
    end
    answer["grounded answer with citations"] --> scopes
    answer --> drafts
    answer --> hl
    answer --> readable
    search["workspace search, demo answer"] --> scopes
    store[("IndexedDB: the turns themselves")]
    answer --> store
    restored(["answer restored from history: text, sources, counts,<br/>no excerpts, no receipt, read-aloud withholds numbers"])
    store -.-> restored
    scopes -.->|"evicted: nothing opens"| open(["citation dialog"])
    drafts -.->|"evicted: button does nothing"| rcpt(["receipt dialog"])
    readable -.-> speak(["read aloud through the gate"])
    writes -.-> del(["delete waits for the writes"])
    reset(["New chat, resetMessages"]) -->|"clearGroundingHighlights"| hl
    reset -.->|"not cleared"| scopes
    reset -.->|"not cleared"| drafts
```

<sub>Sources: [`src/js/rag/citations.js`](../src/js/rag/citations.js), [`src/js/rag/receipts.js`](../src/js/rag/receipts.js), [`src/js/rag/grounding-view.js`](../src/js/rag/grounding-view.js), [`src/js/chat/thread.js`](../src/js/chat/thread.js), [`src/js/messages.js`](../src/js/messages.js), [`src/js/providers.js`](../src/js/providers.js), [`src/js/chat/runner.js`](../src/js/chat/runner.js), [`src/js/chat-store.js`](../src/js/chat-store.js)</sub>

### Service worker fetch handler

sw.js only handles same-origin GET requests; everything else (Supabase, Hugging Face model files, provider APIs, non-GET requests such as the relay, pool and research POSTs) bypasses the worker and is never stored by it (WebLLM and Transformers.js keep model files in their own caches). Navigations are network-first with a deadline of NAVIGATION_DEADLINE_MS (3,500 ms): the network response is returned when it comes first, and after the deadline or a network error the cached / from starpi-shell-VERSION answers whatever path was navigated; with no cached shell the page waits for the network or the navigation fails. Only a navigation of / whose response is cacheable, not redirected and text/html is stored, under /, and only while the cached shell has not been served for that navigation: a response that arrives after the deadline answered from the cache is returned to no one and not stored, because the assets of that HTML were never loaded. /assets/* files and PRECACHE entries are cache-first across all caches, and a miss is stored in starpi-assets only for /assets/* paths, the WASM worker and the ONNX Runtime binary included, while other same-origin paths such as /sw.js, /build-manifest.json, GET /api/health and GET /api/models/pool go straight to the network. At runtime only ok, basic, status 200 responses without no-store in Cache-Control are cached; the install-time precache relies on cache.addAll, which rejects any response that is not ok.

<!-- diagram: service-worker-fetch -->
```mermaid
flowchart TD
    F(["fetch event in sw.js"]) --> M{"request.method is GET?"}
    M -->|"no, e.g. POST /api/pool"| NET["Not handled: no respondWith,<br/>the browser goes to the network"]
    M -->|"yes"| O{"url.origin equals<br/>self.location.origin?"}
    O -->|"no: Supabase, Hugging Face,<br/>provider APIs"| NET
    O -->|"yes"| NAV{"request.mode is navigate?"}
    NAV -->|"yes"| NF["networkFirstNavigation:<br/>fetch(event.request)"]
    NF -->|"response arrives, whenever"| SH{"servedCache still false,<br/>pathname is / and isShellHtml:<br/>cacheable, not redirected,<br/>Content-Type text/html?"}
    SH -->|"yes"| PUT1["event.waitUntil: put a clone<br/>under / in starpi-shell-VERSION"]
    SH -->|"no: e.g. a PDF, an icon, a redirect<br/>or the cached shell was already served"| SKIP1["not stored"]
    NF --> RACE{"Promise.race: network or<br/>NAVIGATION_DEADLINE_MS 3500?"}
    RACE -->|"network response first"| RET1(["return the network response"])
    RACE -->|"deadline first"| DL{"caches.match / with<br/>cacheName starpi-shell-VERSION?"}
    DL -->|"hit"| RET2(["servedCache = true, return the cached shell,<br/>waitUntil keeps the network request alive"])
    DL -->|"miss"| WAITNET["await the network response"]
    WAITNET -->|"response"| RET1
    WAITNET -->|"network error"| FB
    RACE -->|"network error first"| FB{"caches.match / with<br/>cacheName starpi-shell-VERSION?"}
    FB -->|"hit"| RET3(["return the cached shell<br/>for any navigated path"])
    FB -->|"miss"| ERR1(["rethrow: navigation fails"])
    NAV -->|"no"| AS{"pathname starts with /assets/<br/>or is listed in PRECACHE?"}
    AS -->|"no: e.g. /sw.js, /build-manifest.json,<br/>GET /api/health"| NET
    AS -->|"yes: e.g. hashed chunks, fonts, the WASM worker,<br/>the ONNX Runtime binary, /manifest.webmanifest,<br/>/icons/ and /samples/ files"| CF["cacheFirstAsset:<br/>caches.match(event.request)<br/>across all caches"]
    CF -->|"hit"| RET4(["return the cached response"])
    CF -->|"miss"| NF2["fetch(event.request)"]
    NF2 --> C2{"cacheable(response) and<br/>pathname starts with /assets/?"}
    C2 -->|"yes"| PUT2["event.waitUntil: put a clone<br/>in starpi-assets"]
    PUT2 --> RET5(["return the network response"])
    C2 -->|"no"| RET5
    NF2 -->|"network error"| ERR2(["request fails: no fallback"])
    CR["cacheable(response), runtime only:<br/>response.ok, type basic, status 200<br/>and Cache-Control without no-store"]
    SH -.- CR
    C2 -.- CR
    HDR["vercel.json in production:<br/>/assets/(.*) public, max-age=31536000, immutable<br/>/ and /index.html no-cache, still cacheable<br/>/sw.js no-cache, no-store, must-revalidate"]
    CR -.- HDR
```

<sub>Sources: [`src/sw.js`](../src/sw.js), [`scripts/build.mjs`](../scripts/build.mjs), [`vercel.json`](../vercel.json)</sub>

### Service worker install, waiting and activate

scripts/build.mjs injects three values into dist/sw.js: VERSION, a 12-character hash from buildVersion over the rewritten index.html, the sorted asset URLs, every public file and the sw.js template itself; the deduplicated app-shell PRECACHE list; and ASSETS, the URL of every esbuild output except .map and .LEGAL.txt files, plus the hashed ONNX Runtime binary. The caches are named starpi-shell-VERSION and starpi-assets, and verify-dist.mjs, run by npm run verify and in CI, fails when the version does not match the dist contents, the ingest worker is not precached, /index.html is precached, or the WASM worker, the ONNX Runtime binary or the Supabase library is precached. Install precaches the shell (only / bypasses the HTTP cache) and a failed request fails the install. It then calls skipWaiting only when clients.matchAll finds no window client, controlled or not, because an open page may run an older build whose code reloads itself when the worker changes, which would clear its in-memory workspace. On a first install there is no active worker, so the new one activates anyway; on an update with a page open it waits until no open page uses the old worker, or until a page posts a SKIP_WAITING message, which the current main.js never sends. Activate deletes only caches whose names start with starpi- other than the two current ones, which leaves the WebLLM caches and transformers-cache alone, removes starpi-assets entries that the new build no longer lists, and claims the open clients, whose pages then decide themselves whether to offer a reload.

<!-- diagram: service-worker-lifecycle -->
```mermaid
flowchart TD
    subgraph sg_build["scripts/build.mjs writes dist/sw.js and dist/build-manifest.json"]
      V["VERSION = buildVersion: first 12 hex chars of sha256 over<br/>the rewritten index.html, the sorted asset URLs without .map<br/>and .LEGAL.txt, each public file URL and bytes, the src/sw.js template"]
      P["PRECACHE: /, app CSS, main JS, ingest worker,<br/>Latin font, static imports of main, public files, deduplicated"]
      AL["ASSETS: every esbuild output URL under /assets/,<br/>without .map and .LEGAL.txt, plus the ONNX Runtime binary"]
      BM["build-manifest.json: version, entries mainJs, workerJs,<br/>ingestWorkerJs, wasmWorkerJs, ortWasm, appCss,<br/>assets, public, precache"]
    end
    subgraph sg_verify["scripts/verify-dist.mjs (npm run verify:dist, CI)"]
      VD{"version recomputes from dist, sw.js carries it without placeholders,<br/>every precache file exists, ingest worker precached,<br/>/index.html, the WASM worker and the ONNX Runtime<br/>binary not precached?"}
    end
    BM --> VD
    VD -->|"no"| VF(["verify-dist fails"])
    V --> NAMES["SHELL_CACHE = starpi-shell-VERSION<br/>ASSET_CACHE = starpi-assets"]
    TRIG(["main.js registers /sw.js after window load, or a browser<br/>update check finds a changed sw.js"]) --> I1
    NAMES --> I1
    P --> I2
    subgraph sg_install["install event"]
      I1["caches.open(SHELL_CACHE)"] --> I2["cache.addAll(PRECACHE),<br/>only / as a Request with cache reload"]
      I2 -->|"all stored"| I3["self.clients.matchAll<br/>type window, includeUncontrolled true"]
      I3 --> I4{"no window client open?"}
      I4 -->|"yes"| I5["self.skipWaiting()"]
      I4 -->|"no"| I6["installed without skipWaiting"]
    end
    I2 -->|"a request fails"| IF(["waitUntil rejects:<br/>install fails, the new worker is discarded"])
    I5 --> A1
    I6 --> W1{"an active worker<br/>exists already?"}
    W1 -->|"no: first install"| A1
    W1 -->|"yes: an update"| WAIT["waiting: the old worker keeps<br/>controlling the open pages"]
    WAIT -->|"no open page uses the old worker any more"| A1
    WAIT -->|"a page posts type SKIP_WAITING,<br/>the current main.js never does"| MSG["message event: self.skipWaiting()"]
    MSG --> A1
    subgraph sg_activate["activate event"]
      A1["caches.keys()"] --> A2{"key starts with starpi-<br/>and is neither SHELL_CACHE<br/>nor ASSET_CACHE?"}
      A2 -->|"yes"| A3["caches.delete(key):<br/>older shell caches and any other starpi- cache"]
      A2 -->|"no"| A4["kept: current caches and other caches<br/>such as webllm/model, webllm/config, webllm/wasm"]
      A3 --> A5["open ASSET_CACHE, delete each entry<br/>whose pathname is not in ASSETS"]
      A4 --> A5
      A5 --> A6["self.clients.claim()"]
    end
    AL --> A5
    A6 --> CC(["controllerchange in each open page it claims,<br/>see the app update flow"])
```

<sub>Sources: [`src/sw.js`](../src/sw.js), [`scripts/build.mjs`](../scripts/build.mjs), [`scripts/lib/build-version.mjs`](../scripts/lib/build-version.mjs), [`scripts/verify-dist.mjs`](../scripts/verify-dist.mjs), [`tests/unit/build-version.test.mjs`](../tests/unit/build-version.test.mjs), [`src/js/main.js`](../src/js/main.js)</sub>

### App update flow in the page

registerServiceWorker, called from boot() in main.js, records the src of the page's module script under /assets/, registers the reload-app and dismiss-update actions and a controllerchange listener, and registers /sw.js with scope / after window load; a registration error only logs a warning. controllerchange fires in a page when an activating worker claims it, which happens on the first install. On an update the new worker skips waiting only when no window is open at install time, so no page is left to claim, or when a page posts SKIP_WAITING, which the current main.js never does. Otherwise it waits while any page uses the old worker, open pages get no controllerchange, and the navigations that follow are still served network-first by the old worker. On controllerchange a page fetches /build-manifest.json with cache no-store (sw.js lets that path through to the network) and unhides #updateBanner at the top of the page only when entries.mainJs differs from its own script, so a first install or a page that already runs the new build shows nothing, and an offline or failed check shows nothing either. Reload reloads only the tab it was clicked in, so other tabs keep their in-memory workspaces and drafts, and the close button (dismiss-update) hides the banner.

<!-- diagram: service-worker-update-flow -->
```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Banner as updateBanner
    participant Main as main.js registerServiceWorker
    participant Nav as navigator.serviceWorker
    participant New as new sw.js worker
    participant Net as network

    Note over Main: called from boot() after the init calls
    Main->>Main: return early if serviceWorker is not in navigator
    Main->>Main: currentMain = src of the module script under /assets/, else null
    Main->>Main: onAction reload-app and dismiss-update
    Main->>Nav: listen for controllerchange
    Note over Main: registration waits for the window load event
    Main->>Nav: register /sw.js with scope /
    alt registration rejects
        Nav-->>Main: error
        Main->>Main: console.warn service worker registration failed
    else registered
        Note over Nav,New: first visit, or the browser finds a changed sw.js
        Nav->>New: install: precache the shell, then clients.matchAll type window
        alt first install, no active worker yet
            New->>New: activates at once, a window is open so skipWaiting is not called
        else update while a window is open
            New->>New: installed, waiting, the old worker keeps the open pages
            Note over New: activates once no open page uses the old worker,<br/>or on a SKIP_WAITING message, which the current main.js never sends,<br/>open pages get no controllerchange in the first case
        else update with no window open
            New->>New: skipWaiting, then activates
        end
        New->>New: activate: delete old starpi- caches, prune starpi-assets, clients.claim
        Nav->>Main: controllerchange, only in open pages the new worker claims:<br/>first install, or after a SKIP_WAITING message
        Main->>Net: fetch /build-manifest.json with cache no-store (not handled by sw.js)
        alt response ok, currentMain set and entries.mainJs differs from it
            Main->>Banner: setHidden false, the banner appears at the top
        else same mainJs (first install or page already current), not ok, invalid JSON or offline
            Main->>Main: nothing shown
        end
    end
    alt User clicks Reload
        User->>Banner: click Reload
        Banner->>Main: document click delegation, data-action reload-app
        Main->>Main: window.location.reload in this tab only
    else User clicks the close button
        User->>Banner: click the x button (aria-label from app.close)
        Banner->>Main: data-action dismiss-update
        Main->>Banner: setHidden true
    end
    Note over Main,New: other open tabs are never reloaded by the app, their workspaces and drafts stay in memory
```

<sub>Sources: [`src/js/main.js`](../src/js/main.js), [`src/js/dom.js`](../src/js/dom.js), [`src/sw.js`](../src/sw.js), [`scripts/build.mjs`](../scripts/build.mjs), [`src/index.html`](../src/index.html)</sub>

## 8. Supabase

The browser connects with the public key and an anonymous session; grants and row level security decide every read and write. Supabase serves the shared library and the end-to-end encrypted chat sync; the 2.x plaintext chat table is only deleted from. The migrations are idempotent and are tested on PostgreSQL 16 with pgvector in CI.

### connect(): anonymous session and schema probe

The Supabase client is created once, on first use (connect() or the first query), from the library's lazy entry, with the anon key, a persisted session under storageKey starpi-auth (detectSessionInUrl false), a fetch wrapper that aborts every request after 12000 ms and db retry false, so postgrest-js does not repeat a timed-out or failed read. A build the companion serves (profile companion) never loads the library: connect() ends offline at once without a retry, and every query answers as if the network were gone. Otherwise connect() first reads navigator.onLine: when the browser reports offline it sets status offline without any request and calls scheduleReconnect(). Because that branch has no await, scheduleReconnect() clears connectPromise before connect() stores the promise, so connectPromise keeps this settled offline result and every later retry() gets it back without a new attempt. Otherwise connect() loads the library first. A load gets the same 12000 ms as a request: client() races the import against that deadline, so a stalled network cannot keep connect(), boot() and every query that shares the pending load waiting. When the load fails (no network, or the file is gone after a deploy) classifyError reads the failure as network, and a passed deadline (a TimeoutError) as timeout; either way connect() sets status offline with that error as authError and probeError and calls scheduleReconnect(), and the next load asks for the file under another URL (?attempt=n), because a browser keeps a failed module import for the life of the page. An import cannot be cancelled: when a load that ran out of time still arrives, the next attempt uses it instead of downloading the file again, and an attempt still waiting for its own download finishes with it as well. Then ensureSession() restores the session with getSession(); without one anonymousSignInsEnabled() reads GET /auth/v1/settings through the same 12000 ms fetch wrapper. When external.anonymous_users is false, ensureSession() returns auth_disabled without a sign-in request; when that request throws and classifyError calls it a timeout, ensureSession() returns the timeout error, also without a sign-in request; in every other case (the flag is true, the response is not ok, the JSON cannot be read, the flag is not a boolean, or the request throws any other error, a network failure included) it calls signInAnonymously(). The probe select id, is_public on knowledge_documents always runs, as role anon when there is no session. A network or timeout probe error yields status offline and scheduleReconnect(), which clears connectPromise and, unless a retry is already pending, calls connect() again on the window online event or after 30 s, doubling per attempt up to 5 min; anything else yields status ready with signedIn = no authError and hardened = probe.ok and resets the backoff. updateConnection calls the listeners (main.js: renderConnection, renderPrivacyNotice, refreshSyncStatus; sync/service.js kicks a sync when the status is ready and sync is on), then boot() renders the state once more and awaits restoreHistory(), which opens the conversation store on the device (section 2) and asks Supabase nothing. A later retry reaches only the listeners and never restores history again.

<!-- diagram: supabase-connection-connect -->
```mermaid
sequenceDiagram
    autonumber
    participant Boot as main.js boot()
    participant Sb as supabase.js connect()
    participant Lib as supabase-lib.js, lazy build entry
    participant Auth as sb.auth and the auth settings endpoint
    participant DB as PostgREST
    participant L as onConnectionChange listener
    participant UI as ui.js renderConnection
    participant CS as chat-store.js, chat.js
    participant Win as window timer and online event

    Note over Sb: No client at module load: client() creates it on first use,<br/>by connect() or by any query through run()
    Note over Sb: Initial state is status pending, signedIn false,<br/>hardened false, authError null, probeError null
    Boot->>Sb: onConnectionChange(listener)
    Boot->>Sb: await connect()
    alt build profile companion
        Sb->>Sb: updateConnection status offline, kind network, no library, no retry
        Sb-->>Boot: ConnectionState, status offline
    else connectPromise already set
        Sb-->>Boot: the same promise, no new attempt
        Note over Sb: boot() calls connect() once. A retry() finds a promise here<br/>only after the navigator.onLine false branch below
    else navigator.onLine is false
        Sb->>Sb: updateConnection with status offline, signedIn false, hardened false,<br/>authError and probeError kind network, The browser is offline
        Sb->>L: listener(connection), the same renders as below
        Sb->>Sb: scheduleReconnect() sets connectPromise = null and, unless a timer<br/>is pending, a retry timer and an online listener
        Note over Sb: No await before this point: connect() stores the settled promise<br/>afterwards, so connectPromise stays set and later retries start no attempt
        Sb-->>Boot: ConnectionState, status offline
    else no attempt running, the browser online, and the library does not load
        Sb->>Lib: client(): import() of its URL (?attempt=n after a failed or timed-out load),<br/>raced against a 12000 ms deadline
        Lib-->>Sb: import error, or no module before the deadline (TimeoutError)
        Sb->>Sb: clientPromise = null, failedLoads + 1, updateConnection with status offline,<br/>signedIn false, hardened false, authError and probeError = classifyError(error),<br/>kind network or timeout
        Sb->>L: listener(connection), the same renders as below
        Sb->>Sb: scheduleReconnect(), the same timer and online listener as below
        Note over Sb,Lib: A timed-out import cannot be cancelled. If it still arrives, the next<br/>attempt uses it instead of downloading the file again
        Sb-->>Boot: ConnectionState, status offline
    else no attempt running, the browser online, and the library loads
        opt no client yet
            Sb->>Lib: client(): import() of its URL, raced against a 12000 ms deadline,<br/>no request when a timed-out load has arrived since
            Lib-->>Sb: createClient
            Sb->>Sb: createClient(SUPABASE_URL, SUPABASE_ANON_KEY) once:<br/>persistSession, autoRefreshToken, detectSessionInUrl false,<br/>storageKey starpi-auth, global fetch = fetchWithTimeout (12000 ms),<br/>db retry false
        end
        Sb->>Auth: ensureSession() calls getSession()
        alt error returned or thrown
            Auth-->>Sb: error
            Sb->>Sb: authError = classifyError(error)
        else data.session exists
            Auth-->>Sb: session, authError null
        else no session
            Sb->>Auth: anonymousSignInsEnabled(), GET /auth/v1/settings<br/>with the apikey header, fetchWithTimeout 12000 ms
            alt external.anonymous_users is false
                Auth-->>Sb: false
                Sb->>Sb: authError kind auth_disabled, code anonymous_provider_disabled,<br/>no sign-in request
            else the request throws and classifyError gives timeout
                Auth-->>Sb: that DataError
                Sb->>Sb: authError = the timeout error,<br/>no sign-in request
            else true, response not ok, JSON unreadable, flag not a boolean,<br/>or another thrown error, also network
                Sb->>Auth: signInAnonymously()
                alt error returned or thrown
                    Auth-->>Sb: error
                    Sb->>Sb: authError = classifyError(error)
                else anonymous session created
                    Auth-->>Sb: session, authError null
                end
            end
        end
        Note over Sb,DB: The probe also runs when authError is set,<br/>then without a user JWT, as role anon
        Sb->>DB: run() select id, is_public from knowledge_documents limit 1
        alt probe fails
            DB-->>Sb: error, e.g. 42703 when is_public is missing
            Sb->>Sb: probeError = classifyError(error)
        else probe ok
            DB-->>Sb: rows, the is_public column exists
        end
        Sb->>Sb: updateConnection(status, signedIn, authError, hardened, probeError)
        Note over Sb: status offline if the probe kind is network or timeout, else ready<br/>signedIn = authError is null, hardened = probe.ok,<br/>probeError null when the probe succeeded
        loop each listener in connectionListeners
            Sb->>L: listener(connection)
            L->>UI: renderConnection(state)
            L->>L: renderPrivacyNotice() from settings.js
            L->>CS: void refreshSyncStatus()
            Note over L,CS: refreshSyncStatus writes the sync line from the encrypted sync's state,<br/>no request
        end
        alt status offline
            Sb->>Sb: scheduleReconnect() sets connectPromise = null
            opt no retryTimer pending
                Sb->>Win: setTimeout(retry, min(30000 x 2^offlineAttempts, 300000) ms), addEventListener online
                Note over Sb,Win: offlineAttempts + 1, so 30 s, 60 s, 120 s, 240 s, then 5 min
            end
        else status ready
            Sb->>Sb: offlineAttempts = 0
        end
        Sb-->>Boot: ConnectionState
    end
    Boot->>UI: renderConnection(state)
    Boot->>CS: await restoreHistory(): the conversation store in IndexedDB, no Supabase request
    opt later, after an offline result or a run() request that switched ready to offline
        Win->>Sb: retry() on the online event or timer: clearTimeout, remove online listener, void connect()
        Note over Sb,CS: a new attempt as above, unless connectPromise is still set. The badge stays Offline<br/>until it settles, then the listener re-renders badge, privacy notice and sync status.<br/>restoreHistory() is not called again
    end
```

<sub>Sources: [`src/js/supabase.js`](../src/js/supabase.js), [`src/js/supabase-lib.js`](../src/js/supabase-lib.js), [`src/js/main.js`](../src/js/main.js), [`src/js/ui.js`](../src/js/ui.js), [`src/js/chat-store.js`](../src/js/chat-store.js), [`src/js/chat.js`](../src/js/chat.js), [`src/js/settings.js`](../src/js/settings.js), [`src/js/config.js`](../src/js/config.js), [`src/js/signals.js`](../src/js/signals.js), [`backend/supabase/full_schema.sql`](../backend/supabase/full_schema.sql)</sub>

### classifyError: mapping failures to error kinds

classifyError checks its rules in a fixed order, so a timeout or network failure wins over any database code: abort and timeout signals first, then fetch and network failures (including a library chunk that does not load), then disabled anonymous sign-ins, then the answers of the email sign-in the encrypted sync uses to reach one account from several browsers (an expired or wrong code, an address already taken, no account, email sign-in off, an invalid address, a rate limit), then conflicts (a unique row exists already, or the sync's revision guard refused a stale write: 23505, 40001 or HTTP 409), then PGRST202 (missing function), missing table or column codes, and finally 42501, PGRST301 and HTTP 401 or 403; everything else is unknown. A probe error in connect() decides offline, Migration pending or Restricted; network and timeout from any later request that goes through run() switch a ready connection to offline; an ensureSession error of any kind only clears signedIn. Three errors are built without classifyError: the network error of the offline browser (or of a build the companion serves), auth_disabled when the auth settings report anonymous sign-ins off, and not_found from getDocument().

<!-- diagram: supabase-connection-classify-error -->
```mermaid
flowchart TD
    input["err from supabase-js, auth-js, fetch or a failed import,<br/>returned or thrown via run(), ensureSession(),<br/>anonymousSignInsEnabled() or the sync and email calls"]
    norm["message, code, name, status;<br/>message regexes case-insensitive"]
    input --> norm
    norm --> qTimeout{"TimeoutError, AbortError, timed out,<br/>signal is aborted?"}
    qTimeout -->|"yes"| kTimeout(["timeout"])
    qTimeout -->|"no"| qNetwork{"Failed to fetch, NetworkError, Load failed, fetch failed,<br/>ERR_*, a dynamically imported module that failed?"}
    qNetwork -->|"yes"| kNetwork(["network"])
    qNetwork -->|"no"| qAuth{"anonymous sign-ins disabled?"}
    qAuth -->|"yes"| kAuth(["auth_disabled"])
    qAuth -->|"no"| qEmail{"email sign-in codes:<br/>otp_expired, invalid_otp; email_exists, user_already_exists;<br/>otp_disabled, signup_disabled, user_not_found;<br/>email_provider_disabled; email_address_invalid;<br/>over_email_send_rate_limit, over_request_rate_limit, 429"}
    qEmail -->|"yes"| kEmail(["invalid_code, email_taken, no_account,<br/>email_disabled, invalid_email or rate_limited"])
    qEmail -->|"no"| qConflict{"23505, 40001 or status 409?"}
    qConflict -->|"yes"| kConflict(["conflict"])
    qConflict -->|"no"| qFn{"PGRST202?"}
    qFn -->|"yes"| kFn(["missing_function"])
    qFn -->|"no"| qSchema{"42P01, PGRST205, 42703 or PGRST204?"}
    qSchema -->|"yes"| kSchema(["missing_schema"])
    qSchema -->|"no"| qForbidden{"42501, PGRST301, 401 or 403?"}
    qForbidden -->|"yes"| kForbidden(["forbidden"])
    qForbidden -->|"no"| kUnknown(["unknown"])

    subgraph sg_effect["Effect"]
        eOffline["probe error in connect(): status offline, reconnect later"]
        eRunOffline["later request while ready: status offline, reconnect later"]
        eMigration["probe error: ready, not hardened, badge Migration pending"]
        eRestricted["probe error: ready, not hardened, badge Restricted"]
        eAuth["ensureSession error: signedIn false, badge Public knowledge"]
        eSync["sync: conflict merges the newer row and writes again;<br/>email kinds are shown in the sync settings"]
    end
    kTimeout -.-> eOffline
    kNetwork -.-> eOffline
    kTimeout -.-> eRunOffline
    kNetwork -.-> eRunOffline
    kSchema -.-> eMigration
    kFn -.-> eRestricted
    kForbidden -.-> eRestricted
    kUnknown -.-> eRestricted
    kAuth -.-> eAuth
    kConflict -.-> eSync
    kEmail -.-> eSync
```

<sub>Sources: [`src/js/supabase.js`](../src/js/supabase.js), [`src/js/sync/sync.js`](../src/js/sync/sync.js), [`src/js/sync/settings-view.js`](../src/js/sync/settings-view.js), [`src/js/ui.js`](../src/js/ui.js), [`src/js/library.js`](../src/js/library.js)</sub>

### Database badge states (renderConnection)

dbStatusBadge and settingsDbBadge start as Connecting from the index.html markup; renderConnection first runs when connect() has a result, through the listener and once more from boot(). It shows Offline for status offline, and for status ready Live, Public knowledge, Migration pending or Restricted depending on hardened, signedIn and the probe error kind, with the badge class, the detail line, the settingsDbAuth text and the project ref. The buttons marked data-requires-session (Save to knowledge base, New entity and Save in the entity dialog) stay enabled only in Live. The sync line in Settings comes from refreshSyncStatus: "This device only" while the encrypted sync is off, else its own state (on with the number of conversations, waiting for the network, or needs attention); no request counts rows any more. A ready state is not final: a later request through run() that fails with network or timeout switches to Offline, and scheduleReconnect() repeats connect() on the online event or after 30 s, doubling up to 5 min (after the offline-browser branch the retry gets that settled attempt back, so Offline stays until a reload).

<!-- diagram: supabase-connection-badge-states -->
```mermaid
stateDiagram-v2
    state "Connecting (index.html markup)" as connecting
    state "Offline (tone off)" as offline
    state "status ready" as ready {
        state ready_choice <<choice>>
        state "Live (tone ok)" as live
        state "Public knowledge (tone ok)" as public_kb
        state "Migration pending (tone warn)" as migration_pending
        state "Restricted (tone warn)" as restricted
        live : badge-ok, detail status.detail_live
        live : settingsDbAuth status.rls_session
        public_kb : badge-ok, detail status.detail_public
        public_kb : settingsDbAuth status.rls_disabled or status.no_session
        migration_pending : badge-warn, detail status.detail_setup
        migration_pending : settingsDbAuth status.migration_needed
        restricted : badge-warn, detail status.detail_setup
        restricted : settingsDbAuth status.probe_error with the code or kind
        [*] --> ready_choice
        ready_choice --> live : hardened and signedIn
        ready_choice --> public_kb : hardened, not signedIn
        ready_choice --> migration_pending : not hardened, missing_schema
        ready_choice --> restricted : not hardened, any other probe error
        note right of live
            Only Live enables the data-requires-session buttons.
            The encrypted sync needs a session too; it syncs
            only while switched on and the status is ready.
        end note
    }
    connecting : badge-muted, detail status.detail_connecting
    offline : badge-muted, detail status.detail_offline
    [*] --> connecting : page load
    connecting --> offline : offline browser, companion build, library or probe network or timeout
    connecting --> ready : status ready
    ready --> offline : a later request gets network or timeout
    offline --> ready : a retry gets status ready
    note left of offline
        retrieve() skips the library while offline.
        The sync line is "This device only" while sync is off,
        else the sync's own state (on, waiting, attention).
    end note
```

<sub>Sources: [`src/js/ui.js`](../src/js/ui.js), [`src/js/supabase.js`](../src/js/supabase.js), [`src/js/chat-store.js`](../src/js/chat-store.js), [`src/js/sync/service.js`](../src/js/sync/service.js), [`src/js/main.js`](../src/js/main.js), [`src/index.html`](../src/index.html)</sub>

### Data access functions: callers, tables and failure paths

Every exported query of supabase.js resolves to a Result ({ ok, data } or { ok, error }) and never rejects. run() loads the library on first use, awaits the supabase-js request, passes a returned or thrown error through classifyError and, when the kind is network or timeout while the status is ready, switches the connection to offline and schedules a reconnect. Each request aborts after 12,000 ms and is not retried by postgrest-js. Reads run through RLS as anon or as the signed-in user, and the browser writes only rows that RLS makes its own and private. The library is reached for retrieval (full text, a 384-dimension query vector for device-only questions, or recent documents ranked in the browser), document titles, the library tab, saving a document, the knowledge graph and its entities; the encrypted sync reads and writes `chat_sync` and `chat_sync_keys`, and the email sign-in lets a second browser reach the same account. The 2.x plaintext `chat_history` table is only deleted from (own rows, by owner id).

<!-- diagram: supabase-data-access -->
```mermaid
flowchart TD
    subgraph sg_callers["Callers"]
        cRetrieve["chat/thread.js retrieve(): searchKnowledge, else<br/>recentKnowledge(30); device-only: libraryHitsByMeaning,<br/>else recentKnowledge(30) without the question"]
        cTitles["thread knownTitles() and Auto's titles,<br/>cached 60 s, none while offline"]
        cLibrary["library.js, the document modal"]
        cIngest["ingest.js submitIngest()"]
        cGraph["graph.js"]
        cSync["sync/service.js engine, sync/settings-view.js"]
        cDelete["chat-store.js deleteChatHistory, deleteSession"]
    end
    subgraph sg_fns["supabase.js exports"]
        fSearch["searchKnowledge(query, 6): rpc search_knowledge,<br/>query_text cut to 1,000 chars"]
        fVec["matchKnowledgeVector(vector, 6): rpc match_knowledge_vector_384,<br/>384 values rounded to 6 decimals, 1 to 20 rows"]
        fRecent["recentKnowledge(limit): documents with their sections"]
        fList["listDocuments(), getDocument(id)"]
        fInsDoc["insertDocument(input): document and one section,<br/>no vectors from the browser"]
        fGraph["listEntities(), listRelations(), insertEntity()"]
        fSync["syncAccount, getSyncKeyEnvelope, putSyncKeyEnvelope,<br/>listSyncRevisions, fetchSyncRows, writeSyncRow, deleteSyncData"]
        fEmail["sendEmailCode, verifyEmailCode, signOutAccount"]
        fDel["deleteOwnChats(), deleteChatSession(sid)"]
    end
    subgraph sg_db["PostgREST and Auth with the public key, RLS"]
        tRpc["search_knowledge, match_knowledge_vector_384"]
        tDocs["knowledge_documents, knowledge_sections"]
        tGraph["knowledge_entities, knowledge_relations"]
        tSync["chat_sync, chat_sync_keys"]
        tAuth["Auth: email one-time code"]
        tChat["chat_history: delete own rows only"]
    end
    cRetrieve --> fSearch
    cRetrieve --> fVec
    cRetrieve --> fRecent
    cTitles --> fList
    cLibrary --> fList
    cIngest --> fInsDoc
    cGraph --> fGraph
    cSync --> fSync
    cSync --> fEmail
    cDelete --> fDel
    fSearch --> tRpc
    fVec --> tRpc
    fRecent --> tDocs
    fList --> tDocs
    fInsDoc --> tDocs
    fGraph --> tGraph
    fSync --> tSync
    fEmail --> tAuth
    fDel --> tChat
    run["run(request): client() loads the library, classifyError on failure,<br/>network or timeout while ready: status offline, reconnect"]
    sg_fns -.- run
    msgs["dataErrorKey in library.js for the views: unreachable, missing schema,<br/>forbidden, not found, auth disabled, other"]
    run -.- msgs
```

<sub>Sources: [`src/js/supabase.js`](../src/js/supabase.js), [`src/js/chat/thread.js`](../src/js/chat/thread.js), [`src/js/rag/embed-client.js`](../src/js/rag/embed-client.js), [`src/js/library.js`](../src/js/library.js), [`src/js/ingest.js`](../src/js/ingest.js), [`src/js/graph.js`](../src/js/graph.js), [`src/js/sync/service.js`](../src/js/sync/service.js), [`src/js/sync/settings-view.js`](../src/js/sync/settings-view.js), [`src/js/chat-store.js`](../src/js/chat-store.js)</sub>

### Encrypted chat sync

Sync is off until the user turns it on in Settings with a passphrase of at least 12 characters. Without a key envelope on the server, the browser makes a 32-byte sync secret and derives two non-extractable keys from it with HKDF-SHA-256 (AES-GCM-256 for records, HMAC-SHA-256 for row ids); the secret is wrapped with a key derived from the passphrase (PBKDF2-SHA-256, 600,000 iterations, a random 16-byte salt) and the envelope goes to `chat_sync_keys`. With an envelope (sync is on in another browser of the same account) the passphrase opens it, which is how a second browser restores the conversations; reaching the same account from another browser needs Email sign-in with a one-time code. The opened keys and the revision each row had when this device last synced are the sync state in the app database. A sync reads the revisions of all rows (ids and numbers only), fetches and merges the rows that are newer (sync/payload.js), and writes every conversation that changed here as the next revision; a write names the revision it builds on (an insert for a new row, else an update of the row at exactly that revision); a write that finds the row moved on changes nothing and counts as a conflict, as does an insert of a row that exists, so the newer row is merged in and written again. The row guard also refuses a revision that does not grow. Records are built from a field allowlist: local-only turns (and questions whose only answers are local-only), attachments, receipts, project and assistant links and every key stay out; a title that may come from such a turn is replaced. Each record is JSON padded to a multiple of 512 bytes and encrypted under a fresh IV, with the key id, row id and revision as additional data, so the server cannot move a record to another row or revision. Merging: messages are append-only and merge as a union; changed conversation fields of this device win over older remote ones; new messages win over a deletion, and a deletion wins over changed fields. Deleting a conversation writes a deletion marker so other browsers delete it too. Turning sync off with deletion removes the key envelope first, then the rows; until that finished every sync retries it. Syncs never overlap (a queue in the tab, a Web Lock across tabs). The table has no per-user quota, and the passphrase cannot be changed without turning sync off and on again.

<!-- diagram: supabase-chat-sync -->
```mermaid
flowchart TD
    on(["Settings: turn sync on with a passphrase, at least 12 chars"])
    sess{"signed-in session?"}
    noSess(["no_session: sign in, Email one-time code<br/>for a second browser"])
    env{"key envelope in chat_sync_keys?"}
    create["new 32-byte secret; HKDF: AES-GCM-256 records key,<br/>HMAC-SHA-256 row id key; wrap with PBKDF2-SHA-256<br/>600,000 iterations, 16-byte salt; putSyncKeyEnvelope"]
    open["open the envelope with the passphrase;<br/>wrong passphrase: no change"]
    state[("sync state in IndexedDB settings: keys (non-extractable),<br/>account, per row: revision, hash, base fields, node ids")]
    cycle["cycle (queued in the tab, Web Lock across tabs)"]
    revs["listSyncRevisions: row ids and revisions only"]
    fetch["fetchSyncRows for rows newer than the state"]
    dec["decrypt: AES-GCM, AAD = key id, row id, revision"]
    merge["merge (payload.js): message union; this device's changed<br/>fields win; new messages beat a deletion;<br/>a deletion beats changed fields"]
    apply[("conversation store: applyPayload")]
    build["changed conversations: buildPayload from an allowlist,<br/>no localOnly turns, attachments, receipts, links or keys"]
    enc["JSON padded to 512 bytes, fresh 12-byte IV,<br/>AES-GCM with AAD; row id = HMAC(conversation id)"]
    write["writeSyncRow(row, baseRev): insert for a new row,<br/>else update where rev = baseRev"]
    guard{"row updated or inserted?<br/>(row guard: revision grows, owner and id fixed)"}
    conflict["conflict: no row at baseRev, an existing row,<br/>or 40001; fetch the newer row, merge, write again"]
    done(["revision stored in the state"])
    delMark(["deleted here: deletion marker written,<br/>other browsers delete the conversation"])
    off(["turn off with deletion: envelope deleted first,<br/>then the rows; retried until done"])
    on --> sess
    sess -->|"no"| noSess
    sess -->|"yes"| env
    env -->|"no"| create --> state
    env -->|"yes"| open --> state
    state --> cycle --> revs --> fetch --> dec --> merge --> apply
    apply --> build --> enc --> write --> guard
    guard -->|"yes"| done
    guard -->|"no"| conflict --> merge
    build -.-> delMark
    cycle -.-> off
```

<sub>Sources: [`src/js/sync/sync.js`](../src/js/sync/sync.js), [`src/js/sync/crypto.js`](../src/js/sync/crypto.js), [`src/js/sync/payload.js`](../src/js/sync/payload.js), [`src/js/sync/service.js`](../src/js/sync/service.js), [`src/js/sync/settings-view.js`](../src/js/sync/settings-view.js), [`src/js/supabase.js`](../src/js/supabase.js), [`src/js/chat/store.js`](../src/js/chat/store.js), [`backend/supabase/migrations/20261102000000_chat_sync.sql`](../backend/supabase/migrations/20261102000000_chat_sync.sql)</sub>

### Supabase schema: knowledge base and knowledge graph

Four of the eight public Starpi tables plus auth.users (drawn as auth_users), as full_schema.sql creates them. Each knowledge_sections row belongs to exactly one knowledge_documents row and is deleted with it. Both tables have a generated German tsvector column fts with a GIN index, and sections hold a nullable vector(1536) embedding with an HNSW cosine index. knowledge_documents, knowledge_entities and knowledge_relations have owner_id (default auth.uid(), null for service role rows, set null when the user is deleted) and is_public (default false; rows that existed before migration 20260923000000 were set public). knowledge_relations points at two knowledge_entities rows through nullable source_entity_id and target_entity_id with on delete cascade. The global UNIQUE (name, entity_type) on entities is dropped. The max limits are CHECK constraints added NOT VALID (characters unless noted), and databases upgraded from the older full_schema.sql keep legacy columns such as knowledge_relations.document_id.

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
        vector embedding_384 "vector(384), nullable, multilingual-e5-small, HNSW cosine"
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

<sub>Sources: [`backend/supabase/full_schema.sql`](../backend/supabase/full_schema.sql), [`backend/supabase/migrations/20260923000000_harden_rls_anonymous_auth.sql`](../backend/supabase/migrations/20260923000000_harden_rls_anonymous_auth.sql), [`backend/supabase/migrations/20260924000000_lock_published_rows.sql`](../backend/supabase/migrations/20260924000000_lock_published_rows.sql)</sub>

### Supabase schema: chat sync, chat history and settings

chat_sync holds one row per synced conversation and user: the primary key (user_id, conv_id), user_id defaulting to auth.uid() and cascading when the auth user is deleted, conv_id 32 characters of base64url (an HMAC of the conversation id), a revision above 0, a 16-character base64 IV and base64 ciphertext of at most 2,800,000 characters; the server stamps updated_at. chat_sync_keys holds one row per user: a key id, the KDF (only PBKDF2-SHA256), 600,000 to 10,000,000 iterations, the salt, the IV and the wrapped key. The trigger chat_sync_guard (SECURITY INVOKER, empty search_path, callable by no API role) keeps a row's owner and id fixed, lets the revision only grow (40001 otherwise) and sets updated_at. Both tables come with the optional migration 20261102000000 and with full_schema.sql. chat_history is the plaintext table of 2.x: 3.0 never reads or writes it and only deletes the rows an earlier version stored; its owner_id is not null and cascades with the auth user, and its CHECK constraints stay (role, session_id 1 to 128 characters, content at most 20,000 for new rows). brain_settings has a text primary key, the seeded keys llm_config and rag_config, and is reachable by the service role only.

<!-- diagram: db-schema-chat-settings -->
```mermaid
erDiagram
    auth_users {
        uuid id PK "Supabase auth.users"
    }
    chat_sync {
        uuid user_id PK "PK 1, FK, default auth.uid(), on delete cascade"
        text conv_id PK "PK 2, 32 chars base64url, HMAC of the conversation id"
        bigint rev "not null, above 0, only grows"
        text iv "16 chars base64"
        text ciphertext "base64, 24 to 2800000 chars, AES-GCM"
        timestamptz updated_at "set by chat_sync_guard"
    }
    chat_sync_keys {
        uuid user_id PK "FK, default auth.uid(), on delete cascade"
        text key_id "22 chars base64url"
        text kdf "PBKDF2-SHA256"
        int iterations "600000 to 10000000"
        text salt "24 chars base64"
        text iv "16 chars base64"
        text wrapped_key "64 chars base64"
        timestamptz created_at "default now()"
    }
    chat_history {
        uuid id PK "2.x, no longer read or written"
        text session_id "1 to 128 chars"
        text role "user, assistant or system"
        text content "max 20000 chars for new rows"
        jsonb sources "max 64 KiB"
        jsonb metadata "max 64 KiB"
        timestamptz created_at "default now()"
        uuid owner_id FK "not null, own rows still deleted on delete"
    }
    brain_settings {
        text key PK "seeded llm_config and rag_config"
        jsonb value "not null"
        text description
        timestamptz updated_at "not null, default now()"
    }
    auth_users ||--o{ chat_sync : "user_id, on delete cascade"
    auth_users ||--o| chat_sync_keys : "user_id, on delete cascade"
    auth_users ||--o{ chat_history : "owner_id, on delete cascade"
```

<sub>Sources: [`backend/supabase/migrations/20261102000000_chat_sync.sql`](../backend/supabase/migrations/20261102000000_chat_sync.sql), [`backend/supabase/full_schema.sql`](../backend/supabase/full_schema.sql), [`backend/supabase/migrations/20260923000000_harden_rls_anonymous_auth.sql`](../backend/supabase/migrations/20260923000000_harden_rls_anonymous_auth.sql), [`backend/supabase/migrations/20260924000000_lock_published_rows.sql`](../backend/supabase/migrations/20260924000000_lock_published_rows.sql)</sub>

### RLS decisions for documents, entities and relations

anon only has SELECT and sees public rows. authenticated, the browser after anonymous sign-in, sees rows that are public or its own. service_role bypasses RLS and is the only role that can set is_public. Inserts and updates must keep the row own and private (WITH CHECK, 42501 otherwise), a relation also needs both endpoint entities to exist and be visible to the writer, and a write that passes RLS can still fail a size CHECK with 23514. Since the published-row lock, UPDATE and DELETE only reach own private rows, so a published row, even the caller's own, is left alone with 0 affected rows. Private rows of other users and ownerless private rows (written by the service role or left by a deleted user) are invisible to both browser roles. Because the service role bypasses RLS, the library publisher (tools/library-publisher, supabase_service.py) limits its document list, its backfill and its vector matches itself to rows that are public or have no owner.

<!-- diagram: rls-access-knowledge-rows -->
```mermaid
flowchart TD
    req["Request on knowledge_documents,<br/>knowledge_entities or knowledge_relations"]
    role{"Database role?"}
    req --> role
    role -->|"service_role, library publisher key"| svc["RLS bypassed, select, insert, update, delete<br/>on every row, only role that can publish<br/>or unpublish (is_public), size CHECKs still apply"]
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
    brainApi["Library publisher, tools/library-publisher supabase_service.py:<br/>document list, backfill and vector matches<br/>limited to is_public or owner_id null (SHARED_ROWS)"]
    names -.- role
    lock -.- usingChk
    svc -.- brainApi
```

<sub>Sources: [`backend/supabase/full_schema.sql`](../backend/supabase/full_schema.sql), [`backend/supabase/migrations/20260923000000_harden_rls_anonymous_auth.sql`](../backend/supabase/migrations/20260923000000_harden_rls_anonymous_auth.sql), [`backend/supabase/migrations/20260924000000_lock_published_rows.sql`](../backend/supabase/migrations/20260924000000_lock_published_rows.sql), [`backend/supabase/tests/rls_test.sql`](../backend/supabase/tests/rls_test.sql), [`tools/library-publisher/publisher/supabase_service.py`](../tools/library-publisher/publisher/supabase_service.py)</sub>

### RLS for sections, the chat tables and settings

chat_sync and chat_sync_keys are owner-only for authenticated (user_id = auth.uid() in every policy: select, insert, update and delete of chat_sync; select, insert and delete of chat_sync_keys, whose row is replaced by delete and insert, never updated) and closed to anon; the migration drops any other policy on them, because policies are OR-ed. knowledge_sections have no owner column. A section is visible when its parent document is visible (knowledge_sections_select_visible_document), and browser writes need a parent that is own and private, so the sections of a published document are read-only too. chat_history is owner-only for authenticated (select, insert and delete of own rows, no UPDATE at all), completely closed to anon, and bounded by CHECK constraints that fail with 23514; the browser's deleteOwnChats() also filters by its own owner_id, which RLS enforces anyway. brain_settings has RLS enabled with no policy and no anon or authenticated grant, so only the service role can read or change it.

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

    subgraph sg_chat["chat_history, 2.x: owner only, the app only deletes own rows"]
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
    subgraph sg_sync["chat_sync and chat_sync_keys, owner only"]
        yReq["Sync request"]
        yRole{"Role?"}
        yReq --> yRole
        yRole -->|"service_role"| ySvc["RLS bypassed, all rows"]
        yRole -->|"anon"| yAnon["Error 42501, no grant, no policy"]
        yRole -->|"authenticated"| yOwn{"user_id = auth.uid()?<br/>user_id defaults to auth.uid()"}
        yOwn -->|"no: read"| yHide["other users' rows invisible,<br/>update and delete affect 0 rows"]
        yOwn -->|"no: insert for another user"| yErr["Error 42501"]
        yOwn -->|"yes"| yOp{"Operation?"}
        yOp -->|"chat_sync_keys update"| yNoUpd["Error 42501: the key row<br/>is replaced by delete and insert"]
        yOp -->|"chat_sync insert or update"| yGuard{"chat_sync_guard: owner and id kept,<br/>revision grows; format CHECKs?"}
        yGuard -->|"yes"| yOk["Row written, updated_at = now()"]
        yGuard -->|"revision not newer"| y40001["Error 40001"]
        yGuard -->|"format"| y23514["Error 23514"]
        yOp -->|"select, delete"| yRw["own rows only"]
    end
    sg_settings ~~~ sg_chat
    sg_chat ~~~ sg_sync
    sg_sync ~~~ sg_sections
```

<sub>Sources: [`backend/supabase/full_schema.sql`](../backend/supabase/full_schema.sql), [`backend/supabase/migrations/20260923000000_harden_rls_anonymous_auth.sql`](../backend/supabase/migrations/20260923000000_harden_rls_anonymous_auth.sql), [`backend/supabase/migrations/20260924000000_lock_published_rows.sql`](../backend/supabase/migrations/20260924000000_lock_published_rows.sql), [`backend/supabase/migrations/20261102000000_chat_sync.sql`](../backend/supabase/migrations/20261102000000_chat_sync.sql), [`backend/supabase/tests/rls_test.sql`](../backend/supabase/tests/rls_test.sql), [`src/js/supabase.js`](../src/js/supabase.js)</sub>

### RPC EXECUTE grants and size limits

All five RPCs run as SECURITY INVOKER with an empty search_path, so the caller's RLS decides which rows they return or write. full_schema.sql drops every overload of the five names before it creates them, 20260923000000 those of the first four; 20260924120000 replaces search_knowledge in place with create or replace, keeps its signature and applies the same revoke and grant again, and the optional 20261101000000 does the same for ingest_document_atomic (which then also stores embedding_384) and creates match_knowledge_vector_384. search_knowledge and match_knowledge_vector_384 are executable by anon, authenticated and service_role, match_knowledge_sections and match_knowledge_hybrid by authenticated and service_role, and ingest_document_atomic by service_role only. Any other call fails with 42501. CHECK constraints bound the text and JSON columns the browser can write, and the chat sync tables accept only opaque, well-formed values (validated constraints, not NOT VALID). The trigger function chat_sync_guard is revoked from every API role. The _max_length and _max_size constraints are added NOT VALID, so they apply to new and updated rows of every role, while legacy rows are not scanned.

<!-- diagram: rls-access-functions-limits -->
```mermaid
flowchart TD
    anon["anon"]
    authn["authenticated"]
    svc["service_role"]

    subgraph sg_fns["RPCs, SECURITY INVOKER, search_path empty, arrows are EXECUTE grants"]
        sk["search_knowledge<br/>(query_text, match_count default 6)<br/>German full text, rows with every term first,<br/>else rows sharing at least two terms or the only one,<br/>match_count clamped to 1 to 20,<br/>blank or null query returns none"]
        mks["match_knowledge_sections<br/>(query_embedding, match_threshold default 0.25,<br/>match_count default 5)<br/>vector search, 1 to 50 rows"]
        mkh["match_knowledge_hybrid<br/>(query_text, query_embedding,<br/>match_count default 5, rrf_k default 60)<br/>RRF of top 25 vector and top 25 full-text ranks,<br/>1 to 50 rows"]
        mkv["match_knowledge_vector_384, optional migration<br/>(query_embedding, match_count default 6,<br/>match_threshold default 0)<br/>cosine ranking on embedding_384, 1 to 20 rows,<br/>null query returns none, other dimensions 22023"]
        ing["ingest_document_atomic<br/>(doc_title, doc_summary, doc_tags,<br/>doc_source_type, doc_source_name,<br/>doc_raw_content, sections_data)<br/>new document is private, owner_id null,<br/>embedding and embedding_384 per section optional,<br/>22023 if sections_data is not a JSON array"]
    end

    anon --> sk
    anon --> mkv
    authn --> sk
    authn --> mks
    authn --> mkh
    authn --> mkv
    svc --> sk
    svc --> mks
    svc --> mkh
    svc --> mkv
    svc --> ing

    invoker["Runs as the caller, so table RLS<br/>limits rows to what the caller can see,<br/>service_role bypasses RLS.<br/>full_schema.sql and 20260923000000 drop every overload<br/>before create, so no older SECURITY DEFINER variant stays.<br/>20260924120000 and 20261101000000 use<br/>create or replace, same signatures"]
    sk -.- invoker
    mks -.- invoker
    mkh -.- invoker
    mkv -.- invoker
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
    ckSync["chat_sync and chat_sync_keys format CHECKs, validated:<br/>conv_id 32 base64url, iv 16 base64, ciphertext base64 up to 2800000,<br/>rev above 0; key_id, salt, iv, wrapped_key formats,<br/>kdf PBKDF2-SHA256, iterations 600000 to 10000000"]
    ckNote --- ckSync
    ckOld["Validated chat_history checks, inline in full_schema.sql<br/>and added by 20260923000000: role user, assistant or system,<br/>session_id 1 to 128 chars, content 100000 chars,<br/>sources and metadata 65536 bytes"]
    ckChat -.- ckOld
    invoker ~~~ sg_checks
```

<sub>Sources: [`backend/supabase/full_schema.sql`](../backend/supabase/full_schema.sql), [`backend/supabase/migrations/20260923000000_harden_rls_anonymous_auth.sql`](../backend/supabase/migrations/20260923000000_harden_rls_anonymous_auth.sql), [`backend/supabase/migrations/20260924000000_lock_published_rows.sql`](../backend/supabase/migrations/20260924000000_lock_published_rows.sql), [`backend/supabase/migrations/20260924120000_search_knowledge_shared_terms.sql`](../backend/supabase/migrations/20260924120000_search_knowledge_shared_terms.sql), [`backend/supabase/tests/rls_test.sql`](../backend/supabase/tests/rls_test.sql), [`backend/supabase/README.md`](../backend/supabase/README.md)</sub>

### search_knowledge: full matches first, then shared terms

search_knowledge is the only RPC the browser calls (searchKnowledge in supabase.js, with the question cut to 1000 characters and match_count 6). Since migration 20260924120000, which full_schema.sql matches, it returns only the rows that contain every term of the websearch_to_tsquery query whenever at least one visible row does. Only when none does, it returns rows that share at least two of the query's terms, or the only term when there is one. Shared terms are the lexemes of to_tsvector('german', query_text) without one-letter lexemes and 39 English function words, and the count of shared terms ranks these rows. In that fallback a document stands in for its sections only when it has none. Because the function runs as the caller, RLS limits both the sections and the documents it reads, in both modes. When it returns no rows or fails, retrieve() in chat.js ranks recentKnowledge(30) in the browser instead.

<!-- diagram: supabase-search-knowledge -->
```mermaid
flowchart TD
    rpcCall["search_knowledge(query_text, match_count default 6)<br/>SECURITY INVOKER, RLS of the caller on<br/>knowledge_sections and knowledge_documents"]
    blank{"query_text null or blank after btrim?"}
    none(["no rows"])
    rpcCall --> blank
    blank -->|"yes"| none
    blank -->|"no"| words["lexemes = to_tsvector german of query_text<br/>without one-letter lexemes and 39 English function words:<br/>a, about, an, and, are, as, at, be, by, can, did, do, does,<br/>for, from, has, have, how, in, is, it, its, of, on, or, that,<br/>the, there, this, to, was, what, when, where, which, who,<br/>why, will, with"]
    words --> query["all_terms = websearch_to_tsquery german of query_text<br/>any_term = the lexemes joined with OR<br/>min_shared = least of 2 and the number of lexemes"]
    query --> secHits["section_hits: sections whose fts matches<br/>all_terms or any_term, with the parent title and tags"]
    query --> docHits["document_hits: documents whose fts matches all_terms or any_term,<br/>with the first section by section_index, created_at or null section fields,<br/>markdown_content from that section, else summary,<br/>else the first 2000 chars of raw_content"]
    perRow["per hit: has_all = fts matches all_terms,<br/>all_rank = ts_rank_cd of fts and all_terms,<br/>shared = number of query lexemes in fts,<br/>any_rank = ts_rank_cd of fts and any_term"]
    secHits --> perRow
    docHits --> perRow
    perRow --> strict{"any hit with has_all?"}
    strict -->|"yes, strict mode"| keepStrict["keep hits with has_all,<br/>score = all_rank"]
    strict -->|"no, shared-term mode"| keepShared["keep hits with shared at least min_shared,<br/>document hits only when the document has no sections,<br/>score = shared + any_rank / (1 + any_rank),<br/>so the number of shared terms decides first"]
    dedupe["drop a document hit when a kept section<br/>of the same document exists"]
    keepStrict --> dedupe
    keepShared --> dedupe
    dedupe --> order["order by score desc, document_title, section_index<br/>limit greatest(1, least(coalesce(match_count, 6), 20))"]
    order --> out(["section_id, document_id, document_title, heading,<br/>markdown_content, tags, rank = score"])
    out --> browser["searchKnowledge maps rows to hits with rank,<br/>retrieve() uses them when there is at least one,<br/>with no rows or an error it ranks recentKnowledge(30) in the browser"]
    tests["rls_test.sql as anon: a question without a full match returns the rows<br/>sharing two terms, English function words do not count,<br/>one shared term of several returns nothing, private rows stay hidden,<br/>a full match wins over rows sharing more terms, a document with<br/>sections gives no document hit, one without sections does"]
    keepShared -.- tests
```

<sub>Sources: [`backend/supabase/migrations/20260924120000_search_knowledge_shared_terms.sql`](../backend/supabase/migrations/20260924120000_search_knowledge_shared_terms.sql), [`backend/supabase/full_schema.sql`](../backend/supabase/full_schema.sql), [`backend/supabase/tests/rls_test.sql`](../backend/supabase/tests/rls_test.sql), [`backend/supabase/README.md`](../backend/supabase/README.md), [`src/js/supabase.js`](../src/js/supabase.js), [`src/js/chat.js`](../src/js/chat.js), [`src/js/config.js`](../src/js/config.js)</sub>

### Migration apply order and guards

A new project gets full_schema.sql, an existing database gets every migrations/*.sql file in file-name order (five files, the last two optional), either by hand or through apply_migration.py (no argument means full_schema.sql, --migrations stops at the first failed file, exit 2 for setup errors and exit 1 for SQL errors). Each SQL file is its own transaction whose preconditions raise an exception and roll back only that file: full_schema.sql refuses a pre-hardening schema, 20260923000000 refuses a database without the Starpi tables, 20260924000000 refuses to run before 20260923000000 (missing owner_id / is_public or tables), and 20260924120000 refuses a database without search_knowledge(text, integer), knowledge_sections or knowledge_documents; it does not check that 20260924000000 ran. 20261101000000 refuses a database without the hardened knowledge tables, search_knowledge and ingest_document_atomic, and 20261102000000 needs only auth.users and auth.uid(), so it may run before or after the others. All files are idempotent, but re-running 20260923000000 on its own drops the 20260924000000 policies, opens brain_settings to anon and authenticated for reading again and puts back the older search_knowledge that only returns full matches, so the whole set is always re-run. 20260924120000 ends with commit and, unlike the other files, sends no notify pgrst.

<!-- diagram: migrations-tests-apply-order -->
```mermaid
flowchart TD
    target{"Which database?"}
    tool["apply_migration.py, DATABASE_URL from the environment<br/>no file argument: full_schema.sql, otherwise the given files in order<br/>--migrations: sorted migrations/*.sql, stops at the first failed file<br/>--dry-run: prints target and files, exit 0 without connecting<br/>client: psycopg, else psycopg2, else psql"]
    toolErr["exit 2: DATABASE_URL unset or not postgresql://,<br/>files together with --migrations, SQL file not found,<br/>no Postgres client, or psql meta-commands in a file<br/>sent through psycopg or psycopg2"]
    toolFail["exit 1: SQL or connection error,<br/>nothing from that file committed, later files not run"]
    target -->|"new Supabase project"| fs0
    target -->|"live project or install from an earlier<br/>schema.sql / full_schema.sql"| m1a
    tool -.->|"default"| fs0
    tool -.->|"--migrations"| m1a
    tool -.-> toolErr
    tool -.-> toolFail

    subgraph sg_fs["full_schema.sql, one transaction"]
        fs0["create extension if not exists vector with schema public"]
        fs1{"vector in schema public and<br/>auth.users, auth.uid() present?"}
        fs2{"knowledge_documents, knowledge_entities,<br/>knowledge_relations or chat_history<br/>exists without owner_id?"}
        fs3["create table if not exists, 16 size CHECKs NOT VALID<br/>only if the name is new, create index if not exists,<br/>drop every policy, create the 19 policies,<br/>drop every RPC overload and recreate SECURITY INVOKER,<br/>search_knowledge as in 20260924120000,<br/>embedding_384, its index and match_knowledge_vector_384<br/>as in 20261101000000, chat_sync and chat_sync_keys<br/>as in 20261102000000, revoke all, then grant per role"]
    end
    fs0 --> fs1
    fs1 -->|"yes"| fs2
    fs2 -->|"no"| fs3

    subgraph sg_m1["20260923000000_harden_rls_anonymous_auth.sql, one transaction, lock_timeout 15s"]
        m1a{"vector in schema public and<br/>auth.users, auth.uid() present?"}
        m1b{"knowledge_documents, knowledge_sections<br/>and chat_history exist?"}
        m1c["create missing brain_settings, knowledge_entities, knowledge_relations<br/>add columns if not exists, is_public added with default true<br/>only when the column is new, then default false"]
        m1d["delete chat_history rows without owner_id,<br/>owner_id NOT NULL default auth.uid(), chat CHECKs"]
        m1e["drop every policy on the six tables, including unexpected ones,<br/>create 19 owner-based policies plus brain_settings_select_all,<br/>drop every RPC overload, recreate SECURITY INVOKER<br/>with search_path empty and the full-match-only search_knowledge,<br/>revoke all then grant per role"]
    end
    m1a -->|"yes"| m1b
    m1b -->|"yes"| m1c
    m1c --> m1d --> m1e

    subgraph sg_m2["20260924000000_lock_published_rows.sql, one transaction, lock_timeout 15s"]
        m2a{"knowledge_documents, knowledge_entities,<br/>knowledge_relations have owner_id and is_public,<br/>knowledge_sections, chat_history, brain_settings exist?"}
        m2b["recreate update / delete policies with not is_public,<br/>section writes only for an own, private parent document"]
        m2c["brain_settings: drop every policy,<br/>revoke all from public, anon, authenticated"]
        m2d["16 size CHECKs NOT VALID,<br/>added only when the constraint name does not exist"]
    end
    m1e -->|"notify pgrst, commit,<br/>then the next file in file-name order"| m2a
    m2a -->|"yes"| m2b --> m2c --> m2d

    subgraph sg_m3["20260924120000_search_knowledge_shared_terms.sql, one transaction, lock_timeout 15s"]
        m3a{"search_knowledge(text, integer),<br/>knowledge_sections and<br/>knowledge_documents exist?"}
        m3b["create or replace search_knowledge, same signature:<br/>full matches first, else rows sharing terms,<br/>revoke all, grant execute to anon, authenticated, service_role"]
    end
    m2d -->|"notify pgrst, commit,<br/>then the next file in file-name order"| m3a
    m3a -->|"yes"| m3b

    subgraph sg_m4["20261101000000_embedding_384.sql, optional, one transaction, lock_timeout 15s"]
        m4a{"knowledge tables with owner_id and is_public,<br/>search_knowledge and<br/>ingest_document_atomic exist?"}
        m4b["add column if not exists embedding_384 vector(384),<br/>column comment, HNSW cosine index if not exists,<br/>create or replace match_knowledge_vector_384,<br/>EXECUTE for anon, authenticated, service_role,<br/>create or replace ingest_document_atomic with embedding_384"]
    end
    m3b -->|"commit, then the next file in file-name order"| m4a
    m4a -->|"yes"| m4b

    abortVec["raise exception: vector extension not in public<br/>or not a Supabase database"]
    abortOld["raise exception: older Starpi schema,<br/>apply migrations/ in file-name order instead"]
    abortFresh["raise exception: Starpi tables not found,<br/>use full_schema.sql for a fresh install"]
    abortOrder["raise exception: apply<br/>20260923000000_harden_rls_anonymous_auth.sql first"]
    abortSearch["raise exception: public.search_knowledge not found,<br/>apply 20260923000000 and 20260924000000 first"]
    abortSchema["raise exception: Starpi knowledge schema not found,<br/>apply the three earlier migrations first"]
    rollback(["That file's transaction is rolled back: nothing from it<br/>is committed, files applied before it stay committed"])
    fs1 -->|"no"| abortVec
    m1a -->|"no"| abortVec
    fs2 -->|"yes"| abortOld
    m1b -->|"no"| abortFresh
    m2a -->|"no"| abortOrder
    m3a -->|"no"| abortSearch
    m4a -->|"no"| abortSchema
    abortVec --> rollback
    abortOld --> rollback
    abortFresh --> rollback
    abortOrder --> rollback
    abortSearch --> rollback
    abortSchema --> rollback

    fsDone(["notify pgrst, reload schema, then commit<br/>running all migrations afterwards changes nothing"])
    m3Done(["commit, this file sends no notify pgrst"])
    fs3 --> fsDone
    m3b --> m3Done
    m4Done(["notify pgrst, reload schema, then commit"])
    m4b --> m4Done

    subgraph sg_m5["20261102000000_chat_sync.sql, optional, one transaction, lock_timeout 15s"]
        m5a{"auth.users and auth.uid() present?"}
        m5b["create chat_sync and chat_sync_keys if not exists with format CHECKs,<br/>chat_sync_guard trigger, RLS on, unexpected policies dropped,<br/>owner-only policies for authenticated,<br/>revoke all, grants to authenticated and service_role"]
    end
    m4Done -->|"then the next file in file-name order"| m5a
    m5a -->|"yes"| m5b
    m5a -->|"no"| abortVec
    m5Done(["notify pgrst, reload schema, then commit"])
    m5b --> m5Done
    rerun["Re-running 20260923000000 alone drops the 20260924000000 policies,<br/>restores brain_settings_select_all with the SELECT grant to anon<br/>and authenticated, and the full-match-only search_knowledge:<br/>always re-run the whole set"]
    rerun -.- m1e
```

<sub>Sources: [`backend/supabase/README.md`](../backend/supabase/README.md), [`backend/supabase/apply_migration.py`](../backend/supabase/apply_migration.py), [`backend/supabase/full_schema.sql`](../backend/supabase/full_schema.sql), [`backend/supabase/migrations/20260923000000_harden_rls_anonymous_auth.sql`](../backend/supabase/migrations/20260923000000_harden_rls_anonymous_auth.sql), [`backend/supabase/migrations/20260924000000_lock_published_rows.sql`](../backend/supabase/migrations/20260924000000_lock_published_rows.sql), [`backend/supabase/migrations/20260924120000_search_knowledge_shared_terms.sql`](../backend/supabase/migrations/20260924120000_search_knowledge_shared_terms.sql), [`backend/supabase/migrations/20261101000000_embedding_384.sql`](../backend/supabase/migrations/20261101000000_embedding_384.sql), [`backend/supabase/migrations/20261102000000_chat_sync.sql`](../backend/supabase/migrations/20261102000000_chat_sync.sql)</sub>

### run_rls_tests.sh scenarios and assertions

run_rls_tests.sh starts a throwaway PostgreSQL cluster on a Unix socket, loads stub_supabase.sql into one database per scenario and runs its steps in order; the first failing step fails that scenario. A migrations step applies every migrations/*.sql file in file-name order, today the five files. The upgrade scenarios (live, legacy_v2, legacy_v1) apply all migrations twice to prove idempotency, the fresh scenarios cover full_schema.sql via apply_migration.py and a schema.sql plus full_schema.sql re-run, and the guard scenarios pass only when full_schema.sql, 20260924000000 or 20261101000000 fails on the live shape; no scenario runs 20260924120000 alone against a database that lacks search_knowledge. Finally pg_dump output of live, fresh and fresh_rerun must be identical, so full_schema.sql has to carry the same search_knowledge, embedding_384 column, index and functions and the same chat sync tables, trigger and policies as the migrations; any failed group exits 1, setup problems exit 2, and the work directory is removed unless PGTEST_KEEP=1.

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
    scen["run_scenario NAME: create database starpi_NAME, run the steps in order<br/>every scenario starts with stub_supabase.sql: roles anon, authenticated, service_role,<br/>auth.users, auth.uid(), Supabase default grants, sentinel objects of the other app<br/>migrations step: every migrations/*.sql in file-name order<br/>first failing step: FAIL, log tail printed, next scenario"]
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
        guardVectors["guard_vectors: live_shape.sql,<br/>then 20261101000000_embedding_384.sql must fail"]
    end
    scen --> live
    scen --> v2
    scen --> v1
    scen --> fresh
    scen --> rerunS
    scen --> guard
    scen --> guardOrder
    scen --> guardVectors

    aIdem["Second migrations run succeeds on the upgraded schema:<br/>idempotent on the live shape and both earlier schema versions"]
    aRls["rls_test.sql: 270 checks, 277 with legacy=true<br/>catalog, tenant isolation, published-row lock, size limits,<br/>RPCs including the search_knowledge shared-term fallback,<br/>match_knowledge_vector_384 and the encrypted chat sync"]
    aPost["post_rerun_check.sql, 14 checks: a further migrations run keeps<br/>ownership, visibility, chat rows, the published-row lock,<br/>size limits and brain_settings closed to A and anon"]
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
    guardVectors --> aGuard

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

<sub>Sources: [`backend/supabase/tests/run_rls_tests.sh`](../backend/supabase/tests/run_rls_tests.sh), [`backend/supabase/tests/stub_supabase.sql`](../backend/supabase/tests/stub_supabase.sql), [`backend/supabase/tests/rls_test.sql`](../backend/supabase/tests/rls_test.sql), [`backend/supabase/tests/post_rerun_check.sql`](../backend/supabase/tests/post_rerun_check.sql), [`backend/supabase/README.md`](../backend/supabase/README.md), [`backend/supabase/apply_migration.py`](../backend/supabase/apply_migration.py)</sub>

### What rls_test.sql asserts, in order

rls_test.sql runs as superuser, service_role, anon and two anonymous users A and B, switching roles the way PostgREST does, and stops at the first failing check. It checks the catalog (policies, constraints, RPC security, privilege matrices), then tenant isolation in both directions, per-column size limits (SQLSTATE 23514) and permission errors (42501). As anon it also checks how search_knowledge ranks, including the fallback to rows that share terms with a question. It also checks that published rows are read-only for their owner, and the cascade and auth-user deletion paths. Then it checks the 384-dimension vectors: the column and its index, match_knowledge_vector_384 for every role and ingest_document_atomic with embedding_384. The encrypted chat sync follows: RLS, the exact policy set and privilege matrix, the guard trigger, revisions that only grow, the format checks, one key row per user replaced by delete and insert, isolation between A and B, anon locked out, and the deletion of an auth user removing their encrypted rows and key. With legacy=true it adds 7 checks on rows that existed before the migration (277 instead of 270 checks).

<!-- diagram: migrations-tests-rls-assertions -->
```mermaid
flowchart TD
    helpers["Helpers in schema rls_test: expect_ok, expect_error with default SQLSTATE 42501,<br/>expect_count, expect_affected, expect_true, expect_none<br/>roles switched like PostgREST: SET ROLE plus request.jwt.claim.sub<br/>first failing check raises FAIL and psql stops with ON_ERROR_STOP"]
    catalog["Catalog, superuser: RLS on all six tables, exactly the 19 expected policies,<br/>no policy with qual or with_check true, exactly the 16 size-limit constraints,<br/>4 RPCs SECURITY INVOKER with search_path pinned, table privilege matrix,<br/>function EXECUTE matrix, other app objects untouched, embedding nullable"]
    isLegacy{"legacy=true?"}
    legacy["Legacy rows: legacy document kept, public, no owner,<br/>ownerless chat rows deleted, legacy entities and relations public,<br/>oversized legacy row survives NOT VALID limits,<br/>updating it fails with 23514 until it fits"]
    service["service_role: inserts public and private documents, sections, a public entity,<br/>ingest_document_atomic stores a private document without owner,<br/>match_knowledge_sections finds the ingested section,<br/>match_knowledge_hybrid ranks the Budgetplanung section first,<br/>sees private rows, reads brain_settings"]
    userA["User A: owner_id defaults to auth.uid(), is_public to false,<br/>cannot insert public or foreign-owned rows, publish or hand over,<br/>cannot change public documents or add sections to them,<br/>per-column limits fail with 23514, exact limits accepted,<br/>chat role, content 20000, sources 64 KiB, session_id 1 to 128, no chat UPDATE,<br/>RPCs skip private service rows, no ingest_document_atomic, no brain_settings"]
    userB["User B: sees none of A's documents, sections, entities,<br/>relations or chat rows, shared session id stays per owner,<br/>cannot update or delete A's rows, cannot link to A's private entity"]
    aVsB["A against B: the same isolation in the other direction,<br/>both users' rows intact afterwards"]
    anon["anon: no chat_history access, only public documents, sections and entities,<br/>no writes, no brain_settings"]
    anonSearch["anon, search_knowledge: denser German match first, ranks descending,<br/>websearch AND, OR, phrases and stemming,<br/>a question without a full match returns the rows sharing two terms,<br/>English function words do not count, one shared term of several gives none,<br/>fallback hides private rows, a full match wins over more shared terms,<br/>shared terms spread over a sectioned document give no document hit,<br/>shared terms of a document without sections return that document,<br/>a document without sections is a hit with null section fields,<br/>private service and user documents hidden, empty, blank or null query gives none,<br/>match_count default 6, capped at 20, below 1 gives 1 row"]
    legacyAnon["legacy=true: anon finds the legacy public document"]
    anonExec["anon: no EXECUTE on ingest_document_atomic,<br/>match_knowledge_sections or match_knowledge_hybrid"]
    vectors["384-dimension vectors: embedding_384 is a nullable vector(384) with an HNSW cosine index,<br/>match_knowledge_vector_384 SECURITY INVOKER, EXECUTE for anon, authenticated, service_role, not PUBLIC,<br/>ingest_document_atomic stores embedding_384, an empty array stores null,<br/>another length fails with 22000 and stores nothing,<br/>A and B rank public and own sections only, never each other's or ownerless rows,<br/>A cannot change embedding_384 of a published section, anon cannot write it,<br/>anon: ranked by similarity, match_threshold filters, match_count clamped to 1 and 20,<br/>null query gives none, another dimension fails with 22023,<br/>service_role reaches every row, test documents removed"]
    publish["Publishing: service_role publishes the ingested document,<br/>its sections become visible to anon and to A's vector search,<br/>A deletes own session and own draft document"]
    locked["Published rows read-only for the owner: A edits own private section,<br/>entity and relation, service_role publishes them, then A cannot update,<br/>unpublish or delete own published document, entity or relation,<br/>and cannot add, update, move or delete sections of the published document"]
    cascade["Cleanup: deleting a document cascades to its sections,<br/>deleting an auth user removes their chat rows, their encrypted<br/>sync rows and key, and leaves their knowledge rows private without owner"]
    notice(["raise notice rls_test: N checks passed<br/>the runner greps it into the PASS line"])

    helpers --> catalog --> isLegacy
    isLegacy -->|"yes"| legacy --> service
    isLegacy -->|"no"| service
    service --> userA --> userB --> aVsB --> anon --> anonSearch
    anonSearch -.->|"legacy=true"| legacyAnon
    legacyAnon -.-> anonExec
    syncChecks["chat sync: RLS on, exact policies and privileges, chat_sync_guard invoker and not callable,<br/>A stores and advances a row, a stale base revision changes nothing, the revision cannot go back,<br/>id and owner fixed, format checks refuse plain ids, IVs, plain text, oversize, revision 0,<br/>one key row per user, replaced by delete and insert, iterations and KDF and sizes checked,<br/>B cannot read, overwrite or delete A's rows or key, anon locked out"]
    anonSearch --> anonExec --> vectors --> publish --> locked --> syncChecks --> cascade --> notice
```

<sub>Sources: [`backend/supabase/tests/rls_test.sql`](../backend/supabase/tests/rls_test.sql), [`backend/supabase/tests/post_rerun_check.sql`](../backend/supabase/tests/post_rerun_check.sql)</sub>

## 9. Security layers

The defences a hostile document, model answer, tool result, receipt file, web page or network response has to get through: the generated response headers with cross-origin isolation, DOMPurify and the second sanitizer of the rendering extras, the sandboxed frames, the citation registry, the source-check panel and the receipt verifier, the key vault, the database policies, the guards of the server functions (section 13) and the release pipeline.

### Untrusted content on its way to the DOM

Every untrusted input reaches the page through one of a few controls. Markdown from a model, the library, tool results or stored conversations goes through renderMarkdown: marked, then DOMPurify with the html profile, data-* and aria-* attributes off, style, class (except `language-*` on code in pre and the math placeholders), id and srcset forbidden, and images, media, forms, buttons and frames forbidden; a link hook keeps only http:, https: and mailto: links, never a protocol-relative one, and opens them with rel noopener noreferrer nofollow. Highlighting and math come from the lazy chunk render-extras.js and run on the sanitized output: highlight.js reads the code's textContent and its output passes a second DOMPurify instance that keeps only `<span class="hljs-…">`; KaTeX writes MathML that passes a third instance (html and MathML profiles, no style, class, id, href or src). Diagrams and HTML or SVG previews never render in the app's DOM: they go by postMessage to the render frame, sandboxed with allow-scripts only (an opaque origin with `connect-src 'none'`, user scripts only after a click), and a provider's search suggestions go to the grounding frame (an opaque origin, no app script). Values inside HTML templates of the UI kit are escaped, values inside generated Markdown with escapeMarkdown; other values are set as textContent, and localized texts with setText. Citation buttons are created only for labels registered from real excerpts, never inside a link, code, pre or another button; code-block tools (copy, download, open in canvas, preview) are added after sanitizing with DOM APIs, and the source check skips pre and every button that is not a citation. Provider and server errors reach the page only as i18n texts chosen by their error code. Excerpts, tool results, web passages and the companion's passages reach models fenced as data, which mitigates prompt injection without preventing it.

<!-- diagram: security-layers-render -->
```mermaid
flowchart LR
    subgraph sg_in["Untrusted input"]
        inModel["Model output: streamed and final answers,<br/>reasoning, tool results, web passages"]
        inDb["Library rows, search results, graph entities"]
        inStore["Stored conversations and synced records"]
        inWs["Workspace files: names and extracted text"]
        inPrev["Code blocks: HTML, SVG, mermaid"]
        inSugg["A provider's search suggestions HTML"]
        inErr["Provider, server and parser errors"]
    end
    subgraph sg_ctl["Controls in the browser"]
        cRender["render.js renderMarkdown: marked, then DOMPurify<br/>html profile, no data-* or aria-*, FORBID style, class, id, srcset,<br/>img, media, form, input, button, textarea, select, iframe, object, embed;<br/>class kept only for language-* on code in pre and math placeholders"]
        cLink["afterSanitizeAttributes on links: http, https, mailto only,<br/>never protocol-relative, target _blank, rel noopener noreferrer nofollow"]
        cExtras["render-extras.js, lazy: highlight.js output through a second<br/>DOMPurify (span with hljs-* classes only); KaTeX MathML through<br/>a third (no style, class, id, href, src)"]
        cFrame["render-frame: sandbox allow-scripts, opaque origin,<br/>connect-src none, content by postMessage,<br/>user scripts only after a click"]
        cGFrame["grounding-frame: opaque origin, own script only,<br/>no remote resources"]
        cCite["citations.js: buttons only for registered labels,<br/>built with DOM APIs, skipped inside a, code, pre, button"]
        cTools["code-blocks.js: tools added after sanitizing with DOM APIs;<br/>the source check skips pre and non-citation buttons"]
        cText["textContent, setText and kit templates with escaping"]
        cCodes["errors shown only as i18n texts by error code"]
        cFence["excerpts, tool results, web and companion passages<br/>fenced as data in prompts"]
        cDeleg["dom.js: one delegated click and change listener,<br/>no inline handlers"]
    end
    subgraph sg_thr["Threat stopped"]
        tXss["Script execution: script tags, on* attributes,<br/>javascript: or data: links"]
        tAction["Stored content triggering UI actions via data-action"]
        tTrack["Beacons and UI spoofing via images, media,<br/>styles, forms and buttons"]
        tTab["Reverse tabnabbing and referrer leaks"]
        tFrame["A preview reading app storage or the network"]
        tFake["Fabricated clickable citations"]
        tProvider["Provider text with markup or secrets on the page"]
        tPrompt["Prompt injection from documents and pages:<br/>mitigated, not prevented"]
    end
    inModel --> cRender
    inDb --> cRender
    inStore --> cRender
    inModel --> cCite
    inWs --> cText
    inDb --> cText
    inPrev --> cFrame
    inSugg --> cGFrame
    inErr --> cCodes
    inDb --> cFence
    inWs --> cFence
    inModel --> cFence
    cRender --> cLink
    cRender --> cExtras
    cRender --> cTools
    cRender --> tXss
    cRender --> tAction
    cRender --> tTrack
    cLink --> tTab
    cExtras --> tXss
    cFrame --> tFrame
    cGFrame --> tFrame
    cCite --> tFake
    cTools --> tFake
    cText --> tXss
    cCodes --> tProvider
    cDeleg --> tXss
    cFence -.-> tPrompt
```

<sub>Sources: [`src/js/render.js`](../src/js/render.js), [`src/js/render-extras.js`](../src/js/render-extras.js), [`src/js/code-blocks.js`](../src/js/code-blocks.js), [`public/render-frame.js`](../public/render-frame.js), [`public/grounding-frame.js`](../public/grounding-frame.js), [`src/js/rag/citations.js`](../src/js/rag/citations.js), [`src/js/ui/kit.js`](../src/js/ui/kit.js), [`src/js/dom.js`](../src/js/dom.js), [`src/js/i18n/index.js`](../src/js/i18n/index.js), [`src/js/retrieval.js`](../src/js/retrieval.js), [`src/js/ai/context-pack.js`](../src/js/ai/context-pack.js), [`scripts/headers.json`](../scripts/headers.json)</sub>

### Source-check panel and answer receipts

The source-check panel and the receipt dialog show text taken from answers, excerpts and receipt files, so both are built with DOM APIs, setText and textContent, never with HTML strings. applyGrounding reads the answer after renderMarkdown and linkifyCitations: a button counts as a citation only when it carries data-action open-citation and an index in this answer's scope, and since DOMPurify forbids buttons and data-* attributes, only citationButton can make one; other label-like text is reported (unknown_citation when it names no given excerpt, label_mismatch when it resolves to one). Nothing compared gives a neutral bar, never the green check, and statements that need review are marked with the CSS Custom Highlight API, which changes no DOM. The AI judge of the second opinion sends statements and excerpts to a provider only for an answer explicitly allowed to leave the device (fail closed); the entailment model on the device is the other choice. Both are advisory: recorded in the receipt, never releasing or upgrading anything. The app writes `starpi.receipt/v3`: with "Sign exported receipts" (on by default) the receipt names the device key as its signer inside its id and is signed with it (Ed25519, or ECDSA P-256 where WebCrypto lacks Ed25519); the key is non-extractable and only its handle is in IndexedDB, it is never synced or exported, and Settings › Trust exports its public key as a JWK or PEM, rotates or deletes it. A receipt is JSON from anywhere: the dialog refuses files over 2,000,000 bytes and text that JSON.parse rejects, and validateReceipt refuses members its format does not define, reason codes outside its version's list, malformed Merkle records and proofs, signatures and signers of the wrong form, and v3 members beyond their limits, before at most 20 chosen files (25 MiB each at most) are matched by SHA-256 on the device. A public key chosen in the dialog is refused above 16,384 bytes and read only as a public JWK or PEM (a private member is refused). verifyReceipt recomputes the Merkle root and every inclusion proof; a signature counts for the signer only when the verifier supplies that signer's public key, and a v3 receipt whose signer is named but whose signature was removed or swapped fails. `starpi-verify-receipt` applies the same limits, can require a signature, and escapes control and bidirectional characters in its report. Receipts of v1 and v2 still verify.

<!-- diagram: security-layers-check-receipts -->
```mermaid
flowchart LR
    subgraph sg_in["Untrusted input"]
        iAns["Rendered answer after renderMarkdown<br/>and linkifyCitations"]
        iExc["Cited excerpts and document names"]
        iRcpt["Receipt file chosen in the dialog"]
        iFiles["Original files for verification"]
        iKey["Signer's public key, in the dialog or --public-key"]
        iCli["Receipt and files for starpi-verify-receipt"]
    end
    subgraph sg_ctl["Controls"]
        cBlocks["blocksFromElement: a button counts only with data-action<br/>open-citation and this scope; other labels become badcite:<br/>unknown_citation or label_mismatch"]
        cPanel["panel built with createElement and setText,<br/>neutral bar when nothing was compared, disclaimer in every panel"]
        cHl["CSS highlight starpi-review: Range objects, no DOM change"]
        cSecond["second opinion: AI judge only for answers allowed to leave<br/>the device (fail closed), else the entailment model here;<br/>advisory, recorded, never releases or upgrades"]
        cSign["trust/signing.js: device key Ed25519 or ES256, non-extractable,<br/>handle in IndexedDB, never synced; signer inside the v3 id;<br/>public key exported as JWK or PEM"]
        cSize["dialog: over 2,000,000 bytes or invalid JSON refused"]
        cValid["validateReceipt (worker): v1, v2 or v3 schema, unknown members<br/>refused, reason codes of the version, Merkle and proof forms,<br/>signature and signer forms, v3 limits: 500 second opinions,<br/>500 relations, gate counts; failure: nothing verified"]
        cKey["public key over 16,384 bytes refused; importPublicKey:<br/>public JWK or PEM for Ed25519 or P-256, private member refused"]
        cSig["verifyReceipt: Merkle root and proofs recomputed;<br/>signature checked against the supplied key; a named signer<br/>without its signature fails"]
        cRead["worker: at most 20 files, 25 MiB each,<br/>matched by SHA-256, re-extracted, nothing uploaded"]
        cDraft["drafts in memory only (50), exported on request,<br/>question and excerpts optional"]
        cCli["verify-receipt CLI: same limits, --require-signature,<br/>control and bidi characters escaped"]
    end
    subgraph sg_thr["Threat stopped"]
        tXss["Markup from answers, excerpts or receipt fields"]
        tFake["A label the answer was not given counted as a source"]
        tDom["Rewriting the sanitized DOM, inline styles"]
        tLeak["Statements or excerpts sent to a judge<br/>for an answer that stays on the device"]
        tDos["Oversized or malformed receipts"]
        tForge["A receipt changed after signing, a removed or swapped<br/>signature, or a signature by another key passing"]
        tPriv["A private key handed in as the public key"]
        tKeyLeak["The signing key leaving the device"]
        tTerm["Receipt strings rewriting the terminal report"]
        tClaim["A match or a receipt read as proof of truth:<br/>stated, not prevented"]
    end
    iAns --> cBlocks --> cPanel
    iExc --> cPanel
    cBlocks --> cHl
    cBlocks --> tFake
    cPanel --> tXss
    cHl --> tDom
    cPanel --> cSecond --> tLeak
    cDraft --> cSign --> tKeyLeak
    iRcpt --> cSize --> tDos
    iRcpt --> cValid --> tDos
    cValid --> cSig
    iKey --> cKey --> tPriv
    cKey --> cSig --> tForge
    iFiles --> cRead --> cSig
    iCli --> cCli --> tTerm
    cCli --> tDos
    cPanel -.-> tClaim
    cDraft -.-> tClaim
```

<sub>Sources: [`src/js/rag/grounding-view.js`](../src/js/rag/grounding-view.js), [`src/js/core/grounding.js`](../src/js/core/grounding.js), [`src/js/core/entail.js`](../src/js/core/entail.js), [`src/js/rag/citations.js`](../src/js/rag/citations.js), [`src/js/rag/receipts.js`](../src/js/rag/receipts.js), [`src/js/trust/signing.js`](../src/js/trust/signing.js), [`src/js/core/receipt.js`](../src/js/core/receipt.js), [`src/js/core/signature.js`](../src/js/core/signature.js), [`src/js/core/merkle.js`](../src/js/core/merkle.js), [`src/js/rag/ingest.worker.js`](../src/js/rag/ingest.worker.js), [`scripts/verify-receipt.mjs`](../scripts/verify-receipt.mjs), [`docs/spec/receipts.md`](spec/receipts.md)</sub>

### Worker isolation, RLS, key handling, CSP and the build gate

Every response carries one header set generated from `scripts/headers.json` per build profile (public on Vercel, self-host, test, and the companion's build): a CSP without `unsafe-inline` or `unsafe-eval` (only `wasm-unsafe-eval` for the WebAssembly runtimes), COOP `same-origin` and COEP `require-corp` (cross-origin isolation, which gives the processor runtime its threads), CORP `same-origin`, Origin-Agent-Cluster, X-Frame-Options DENY, `frame-ancestors 'none'`, Referrer-Policy no-referrer, HSTS and a Permissions-Policy (microphone and camera for this origin; the companion's build without the camera). The companion's build talks to its own origin only. `npm run headers:check` keeps vercel.json equal to the source, and verify-dist fails a build that breaks the CSP, references missing files, ships a key, exceeds its first-load budget or is served with other headers. Untrusted files are parsed in the ingestion worker within size limits, with pdf.js without eval or font loading and Office files through a ZIP reader with limits against ZIP bombs. Provider keys stay in the tab or in the AES-GCM vault and go only to their provider or through the relay; site keys exist only in the server environment, and the server functions check the origin, a per-IP rate limit, optional budgets and an access code before anything else. The relay reaches only its fixed upstream table and returns error identifiers, never upstream text. Model files are hashed against the lock before they run, and the processor worker fetches only catalog repositories at their pinned revisions. Turns that stayed on the device never enter another model's history or the encrypted sync; RLS limits sync rows to their owner and private knowledge rows to their creator, and the build refuses a secret or service-role key. The service worker caches only same-origin GET responses that are cacheable.

<!-- diagram: security-layers-platform -->
```mermaid
flowchart LR
    subgraph sg_in["Untrusted input"]
        iFile["Workspace files and attachments"]
        iKeys["Provider keys typed by the user;<br/>site keys of the operator"]
        iReq["Requests to the server functions<br/>from other sites, scripts and floods"]
        iUrl["Own server address"]
        iNet["Responses from providers, model hosts, Supabase"]
        iDb["Supabase access with the public key"]
        iSlip["Markup that slips past sanitizing"]
        iDist["dist/ build output"]
        iOrigin["Other sites: framing, opener windows, network attackers"]
    end
    subgraph sg_ctl["Controls"]
        cWorker["starpi-ingest worker: parse, chunk, index off the main thread,<br/>25 MiB and 5,000,000 chars, pdf.js without eval or fonts,<br/>ZIP limits and XML without entity expansion"]
        cLocal["localOnly turns: never another model's history,<br/>never in the encrypted sync"]
        cVault["ai/keys.js: session storage or the vault (AES-GCM-256,<br/>PBKDF2-SHA-256 600,000, lock after 30 min), keys only in<br/>the provider's auth header, never in URLs, logs or receipts"]
        cGuards["api/_lib guards: origin check, per-IP limit, access code<br/>after the limit, daily budgets; relay: fixed upstreams, 4 MB,<br/>header allowlist, no redirects, error identifiers only;<br/>pools: allowlisted models, text and images, no tools"]
        cNorm["normalizeServerUrl: https, or http on localhost or 127.0.0.1,<br/>no credentials"]
        cPin["model-lock.json: SHA-256 before a model runs;<br/>processor worker fetches pinned revisions only"]
        cRls["RLS: chat_sync and chat_sync_keys owner only,<br/>private knowledge rows for their creator, published rows read-only,<br/>build refuses sb_secret_ and non-anon JWTs"]
        cSw["sw.js: same-origin GET only, cacheable responses only"]
        cCsp["headers.json per profile: script-src self wasm-unsafe-eval,<br/>style-src self, frame-src self, media-src none,<br/>object-src, base-uri, form-action, frame-ancestors none,<br/>connect-src per profile (companion: self only)"]
        cIso["COOP same-origin, COEP require-corp, CORP same-origin,<br/>Origin-Agent-Cluster, X-Frame-Options DENY, HSTS,<br/>Referrer-Policy no-referrer, Permissions-Policy"]
        cVerify["verify-dist: CSP compatibility, no inline code or eval,<br/>assets present, no key in bundles, first-load budget,<br/>headers of the profile identical on every file except the frames;<br/>headers:check keeps vercel.json equal to the source"]
    end
    subgraph sg_thr["Threat stopped"]
        tFreeze["Frozen UI, exhausted memory, ZIP bombs"]
        tLeak["Device-only content sent or synced"]
        tKey["Keys persisted in plaintext, in URLs or bundles"]
        tAbuse["Quota abuse of the site's keys, an open proxy, SSRF"]
        tUrl["Cleartext to remote hosts, credentials in URLs"]
        tModel["Changed or foreign model files"]
        tTenant["Reading other users' rows, editing published rows"]
        tCache["Private responses in CacheStorage"]
        tXss["Injected or inline script, exfiltration"]
        tFrame["Clickjacking, cross-window access, downgrade"]
        tRegress["A build that weakens the policy or ships a key"]
    end
    iFile --> cWorker --> tFreeze
    iFile --> cLocal --> tLeak
    iKeys --> cVault --> tKey
    iKeys --> cVerify
    iReq --> cGuards --> tAbuse
    iUrl --> cNorm --> tUrl
    iNet --> cPin --> tModel
    iNet --> cSw --> tCache
    iDb --> cRls --> tTenant
    iSlip --> cCsp --> tXss
    iOrigin --> cIso --> tFrame
    iDist --> cVerify --> tRegress
    cVerify --> tKey
```

<sub>Sources: [`scripts/headers.json`](../scripts/headers.json), [`scripts/lib/headers.mjs`](../scripts/lib/headers.mjs), [`scripts/verify-dist.mjs`](../scripts/verify-dist.mjs), [`scripts/gen-headers.mjs`](../scripts/gen-headers.mjs), [`src/js/rag/ingest.worker.js`](../src/js/rag/ingest.worker.js), [`src/js/rag/parser.js`](../src/js/rag/parser.js), [`src/js/rag/formats/zip.js`](../src/js/rag/formats/zip.js), [`src/js/ai/keys.js`](../src/js/ai/keys.js), [`api/_lib/guards.js`](../api/_lib/guards.js), [`api/_lib/relay/handler.js`](../api/_lib/relay/handler.js), [`api/_lib/pool/handler.js`](../api/_lib/pool/handler.js), [`src/js/providers.js`](../src/js/providers.js), [`src/js/models/integrity.js`](../src/js/models/integrity.js), [`src/js/wasm/worker.js`](../src/js/wasm/worker.js), [`src/js/chat/thread.js`](../src/js/chat/thread.js), [`src/js/sync/payload.js`](../src/js/sync/payload.js), [`src/sw.js`](../src/sw.js), [`scripts/lib/supabase-key.mjs`](../scripts/lib/supabase-key.mjs), [`backend/supabase/full_schema.sql`](../backend/supabase/full_schema.sql)</sub>

### Publisher secrets, service role reads and CI supply chain

The library publisher is a command line tool on a machine the operator controls: it holds the service_role key, opens no port, reads only `.md` and `.txt` files within limits, keeps its own reads to public or ownerless rows (the service role bypasses RLS) and pins its embedding model files by revision, size and SHA-256. CI runs with read-only permissions, actions pinned to commit SHAs, `persist-credentials: false` and `npm ci --ignore-scripts`; gitleaks scans the tree and every pull request, `npm audit` fails on runtime advisories and `pip-audit` on the publisher's, the licence gate checks every shipped package (and the companion's tree its own), the end-of-life register warns a year ahead, the public hygiene check keeps private paths and internal identifiers out, CodeQL and a workflow lint (actionlint, zizmor) run on every change, and a weekly workflow checks the model lock. The release workflow runs after CI succeeded on a push to main: a job without write access or secrets packs `@starpi/core` and `@starpi/companion`, builds the companion's offline bundle, smoke-tests the core tarball and writes the SBOMs and `SHA256SUMS`; a signing job, which installs nothing, attests every asset (actions/attest-build-provenance), signs `SHA256SUMS` and the offline bundle keyless with Sigstore and, when the release key is configured, signs `SHA256SUMS` with Ed25519; the release job is the only one with `contents: write`; and the publish job releases both packages to npm from the very tarballs of the release, with provenance.

<!-- diagram: security-layers-backend-ci -->
```mermaid
flowchart LR
    subgraph sg_in["Untrusted input"]
        iFiles["Files handed to the publisher"]
        iModel["Model files from Hugging Face"]
        iSecret["Publisher secrets: service role key"]
        iRepo["Commits, pull requests, npm and pip dependencies,<br/>workflow files"]
        iAssets["Release assets on their way to users"]
    end
    subgraph sg_ctl["Controls"]
        cCli["publisher: command line only, no listener"]
        cSource["read_source: md or txt, UTF-8, 200,000 chars,<br/>fields clipped to the CHECK limits"]
        cShared["service role reads limited to public or ownerless rows"]
        cPins["model_files.py: revision, size and SHA-256 pinned,<br/>checked on every load"]
        cLeaks["gitleaks on the tree and every pull request"]
        cAudit["npm audit (runtime), pip-audit, licence gate,<br/>companion dependency and licence checks, eol register,<br/>public hygiene"]
        cLint["CodeQL, actionlint and zizmor on every change;<br/>model-lock.yml weekly"]
        cSupply["permissions contents read, SHA-pinned actions,<br/>persist-credentials false, npm ci --ignore-scripts"]
        cPrep["release prepare: no write, no secrets: pack core and companion,<br/>offline bundle, core smoke test, SBOMs, SHA256SUMS"]
        cSign["release sign: installs nothing; attest-build-provenance,<br/>cosign keyless for SHA256SUMS and the bundle,<br/>Ed25519 SHA256SUMS.sig when the key exists"]
        cRel["release: the only contents write job, checks SHA256SUMS,<br/>creates the release from package.json's version"]
        cPub["publish: npm --provenance from the release tarballs,<br/>core then companion, published versions skipped"]
    end
    subgraph sg_thr["Threat stopped"]
        tRemote["Remote use of the service role key"]
        tPrivate["Private browser rows read through the service role"]
        tModel["Vectors from a replaced model"]
        tKeys["Secrets in git history or logs"]
        tVuln["Dependencies with advisories or unknown licences"]
        tSupply["Install scripts, moved tags, a persisted token,<br/>write access where dependency code runs"]
        tAsset["An asset changed after the build, or packages that<br/>do not match the release"]
    end
    iSecret --> cCli --> tRemote
    iFiles --> cSource
    cShared --> tPrivate
    iModel --> cPins --> tModel
    iRepo --> cLeaks --> tKeys
    iRepo --> cAudit --> tVuln
    iRepo --> cLint --> tSupply
    iRepo --> cSupply --> tSupply
    iRepo --> cPrep --> cSign --> cRel --> cPub
    iAssets --> cSign
    cSign --> tAsset
    cPub --> tAsset
```

<sub>Sources: [`tools/library-publisher/publisher/cli_supabase.py`](../tools/library-publisher/publisher/cli_supabase.py), [`tools/library-publisher/publisher/supabase_service.py`](../tools/library-publisher/publisher/supabase_service.py), [`tools/library-publisher/publisher/model_files.py`](../tools/library-publisher/publisher/model_files.py), [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), [`.github/workflows/release.yml`](../.github/workflows/release.yml), [`.github/workflows/codeql.yml`](../.github/workflows/codeql.yml), [`.github/workflows/workflow-lint.yml`](../.github/workflows/workflow-lint.yml), [`.github/workflows/model-lock.yml`](../.github/workflows/model-lock.yml), [`scripts/sign-release.mjs`](../scripts/sign-release.mjs), [`scripts/license-gate.mjs`](../scripts/license-gate.mjs), [`scripts/public-hygiene.mjs`](../scripts/public-hygiene.mjs)</sub>

## 10. Library publisher

`tools/library-publisher/` is a Python command line tool that fills the shared library in Supabase: it splits text and Markdown files into heading-based sections, gives every section a 384-dimensional multilingual-e5-small vector (the model the browser uses for its query vectors) and stores document and sections with the service role key. It replaces the HTTP service of earlier releases: the app never called its /api/brain/* routes, and `node scripts/serve.mjs --functions` serves the app together with the routes of `api/` for hosts without Vercel. The browser reads what the publisher wrote through RLS: keyword search with search_knowledge, and, with the optional migration 20261101000000, vector ranking with match_knowledge_vector_384.

### Publishing a file: sections, vectors and one atomic insert

publish reads each file (UTF-8 .md, .markdown, .txt or .text, at most 200000 characters), keeps its text as written unless --structure asks the chat model at LLM_BASE_URL for a cleaned-up Markdown version (any failure falls back to the original), derives the title from the first level-1 heading and the summary from the first plain paragraph, splits the Markdown with chunk_markdown and embeds each section as "passage: " plus document title, heading and text. ingest_document_atomic stores the document and all its sections in one transaction, so a failure leaves nothing behind; the new document is private and has no owner until --public publishes it. A file that cannot be read or stored is reported and the next file goes on; the exit status is 1 when any file failed.

<!-- diagram: publisher-pipeline -->
```mermaid
flowchart TD
    cli(["python -m publisher publish FILE ...<br/>--public, --tag, --structure,<br/>--no-vectors, --dry-run"])
    cfgQ{"--dry-run, or SUPABASE_URL and<br/>SUPABASE_SERVICE_ROLE_KEY set?"}
    noCfg["error, exit 1"]
    modelQ{"--no-vectors, or load_embedder succeeds?<br/>tokenizer.json and onnx/model_quantized.onnx<br/>match their pins, onnxruntime, tokenizers<br/>and numpy installed"}
    noModel["error with the fetch-model and<br/>--no-vectors hints, exit 1"]
    readQ{"read_source: supported suffix, UTF-8,<br/>not empty, at most 200000 characters?"}
    skip["error for this file,<br/>counted, the next file goes on"]
    structQ{"--structure?"}
    llm["structure_raw_content<br/>POST LLM_BASE_URL/chat/completions, neutral prompt:<br/>keep every fact, write in the source language<br/>None on any failure, the text is used as written"]
    derive["title: first level-1 heading, else first line, else file name<br/>summary: first plain paragraph, at most 300 characters<br/>tags: --tag, source_type markdown or text,<br/>source_name: the file name without its directory"]
    chunk["chunk_markdown: a new section at every heading # to ####<br/>outside code fences, heading text without the markers,<br/>at most 1500 characters, longer text continues<br/>under the same heading, Overview before the first heading"]
    embed["E5Embedder.embed_passages<br/>passage: + title, heading unless the section starts with it,<br/>section text, one text per model run,<br/>384 finite floats of unit length per section"]
    dryQ{"--dry-run?"}
    print["print file, title, sections, vectors"]
    rpc["POST /rest/v1/rpc/ingest_document_atomic<br/>fields clipped to the CHECK limits,<br/>embedding_384 sent only for 384 finite numbers"]
    pubQ{"--public?"}
    patch["PATCH knowledge_documents is_public true,<br/>exactly one row returned"]
    priv["document private, owner_id null,<br/>hint printed at the end"]
    fail["SupabaseError: HTTP status and PostgREST code,<br/>never the key, migration hint for<br/>PGRST202, PGRST204, 42703 and 42883"]
    done(["one JSON line per file,<br/>exit 0, or 1 when a file failed"])

    cli --> cfgQ
    cfgQ -->|"no"| noCfg
    cfgQ -->|"yes"| modelQ
    modelQ -->|"no"| noModel
    modelQ -->|"yes, for each file"| readQ
    readQ -->|"no"| skip
    readQ -->|"yes"| structQ
    structQ -->|"yes"| llm
    structQ -->|"no"| derive
    llm -->|"result or None"| derive
    derive --> chunk
    chunk -->|"unless --no-vectors"| embed
    chunk -->|"--no-vectors"| dryQ
    embed --> dryQ
    dryQ -->|"yes"| print
    dryQ -->|"no"| rpc
    rpc -->|"new document id"| pubQ
    rpc -->|"HTTP or network error"| fail
    pubQ -->|"yes"| patch
    pubQ -->|"no"| priv
    patch -->|"error"| fail
    patch --> done
    priv --> done
    print --> done
    fail --> skip
    skip --> done
```

<sub>Sources: [`tools/library-publisher/publisher/cli_supabase.py`](../tools/library-publisher/publisher/cli_supabase.py), [`tools/library-publisher/publisher/pipeline.py`](../tools/library-publisher/publisher/pipeline.py), [`tools/library-publisher/publisher/chunker.py`](../tools/library-publisher/publisher/chunker.py), [`tools/library-publisher/publisher/structurer.py`](../tools/library-publisher/publisher/structurer.py), [`tools/library-publisher/publisher/embedder.py`](../tools/library-publisher/publisher/embedder.py), [`tools/library-publisher/publisher/supabase_service.py`](../tools/library-publisher/publisher/supabase_service.py), [`backend/supabase/migrations/20261101000000_embedding_384.sql`](../backend/supabase/migrations/20261101000000_embedding_384.sql)</sub>

### Vectors: the model of the browser, pinned and verified

The publisher and the browser must use the same model, or the stored passage vectors and the browser's query vectors would not be comparable. fetch-model downloads tokenizer.json and the q8 export onnx/model_quantized.onnx of Xenova/multilingual-e5-small (the ONNX export of intfloat/multilingual-e5-small) at a pinned revision, writes each file to a .part file and renames it only when its size and SHA-256 match the pin; load_embedder checks the pins again before every load. E5Embedder prefixes passages with "passage: " and questions with "query: ", truncates at 512 tokens, averages the last hidden states over the attention mask and L2-normalises the result, as Transformers.js does with pooling mean and normalize true. Each text runs alone: the q8 export quantises activations per run, so in a batch a vector would depend slightly on its neighbours and on the padding. A test compares the vectors with ones that Transformers.js 4.3.0 computed for the same texts (cosine similarity above 0.99; the two ONNX Runtime builds round slightly differently).

<!-- diagram: publisher-vectors -->
```mermaid
flowchart LR
    hub[("Hugging Face<br/>Xenova/multilingual-e5-small<br/>at the pinned revision")]
    fetch["fetch-model<br/>tokenizer.json, onnx/model_quantized.onnx<br/>.part file, size and SHA-256 checked,<br/>then renamed, kept when already valid"]
    dir[("PUBLISHER_MODEL_DIR<br/>default tools/library-publisher/models/<br/>multilingual-e5-small, git-ignored")]
    load["load_embedder<br/>pins checked again, tokenizers truncation 512,<br/>ONNX Runtime CPU session"]
    emb["E5Embedder.embed<br/>prefix, tokens, one run per text,<br/>input_ids, attention_mask, token_type_ids zeros,<br/>last_hidden_state mean over the mask, L2 norm<br/>shape and finiteness checked"]
    col[("knowledge_sections.embedding_384<br/>vector(384), HNSW cosine index")]
    rpc["match_knowledge_vector_384<br/>SECURITY INVOKER, anon may call it,<br/>RLS decides the visible rows"]
    tab["Browser tab, on-device mode<br/>Transformers.js, same model and q8 weights:<br/>query: + question, mean pooling, normalize"]
    ref["Test fixture e5_transformers_js.json<br/>Transformers.js 4.3.0 vectors,<br/>cosine above 0.99 required"]

    hub -->|"HTTPS, redirects followed"| fetch
    fetch --> dir
    dir --> load
    load --> emb
    emb -->|"passage: + section, publish and backfill"| col
    emb -->|"query: + question, test-query"| rpc
    tab -->|"query vector only, never the question text"| rpc
    rpc -->|"cosine similarity, best first"| col
    ref -.->|"PUBLISHER_TEST_MODEL_DIR set"| emb
```

<sub>Sources: [`tools/library-publisher/publisher/model_files.py`](../tools/library-publisher/publisher/model_files.py), [`tools/library-publisher/publisher/embedder.py`](../tools/library-publisher/publisher/embedder.py), [`tools/library-publisher/publisher/tests/test_embedder.py`](../tools/library-publisher/publisher/tests/test_embedder.py), [`tools/library-publisher/publisher/tests/fixtures/e5_transformers_js.json`](../tools/library-publisher/publisher/tests/fixtures/e5_transformers_js.json), [`backend/supabase/migrations/20261101000000_embedding_384.sql`](../backend/supabase/migrations/20261101000000_embedding_384.sql)</sub>

### Service role reads: health, list, backfill and test-query

The service role bypasses RLS, so every read of the publisher names the rows it may touch: SHARED_ROWS, published documents and documents without an owner (the ones the service role wrote). backfill embeds the sections of such documents whose embedding_384 is still null, 50 per page in id order, and continues behind the last id so that a section that fails is not retried in the same run; private rows of browser sessions are never read. test-query embeds a question and keeps only the matches of shared documents, since match_knowledge_vector_384 called with the service role sees every row.

<!-- diagram: publisher-service-role -->
```mermaid
flowchart TD
    health["health<br/>GET knowledge_documents select id, limit 1<br/>GET knowledge_sections select id, embedding_384<br/>exit 0 only when both answer"]
    list["list --limit N<br/>GET knowledge_documents, or SHARED_ROWS,<br/>newest first, without raw_content"]
    backfill["backfill --limit, --dry-run<br/>GET knowledge_sections embedding_384 is null,<br/>knowledge_documents!inner(title),<br/>knowledge_documents.or SHARED_ROWS,<br/>order id, 50 per page, id greater than the last"]
    embed["embed_passages: passage: + title, heading, text"]
    patch["PATCH knowledge_sections id eq<br/>embedding_384, return minimal,<br/>skipped with --dry-run"]
    query["test-query QUESTION --count N<br/>embed_query: query: + question"]
    rpc["POST rpc/match_knowledge_vector_384<br/>query_embedding, match_count, match_threshold"]
    filter["GET knowledge_documents id in the matches,<br/>or SHARED_ROWS, matches of other documents dropped"]
    missing["42703 or PGRST202: hint to apply<br/>20261101000000_embedding_384.sql"]
    shared[("Shared library: is_public true or owner_id null")]
    private[("Private rows of browser sessions:<br/>owner_id set, is_public false, never read")]

    health -->|"column missing"| missing
    list --> shared
    backfill --> shared
    backfill --> embed
    embed --> patch
    query --> rpc
    rpc --> filter
    filter --> shared
    rpc -->|"function missing"| missing
    shared ~~~ private
```

<sub>Sources: [`tools/library-publisher/publisher/cli_supabase.py`](../tools/library-publisher/publisher/cli_supabase.py), [`tools/library-publisher/publisher/supabase_service.py`](../tools/library-publisher/publisher/supabase_service.py), [`backend/supabase/full_schema.sql`](../backend/supabase/full_schema.sql)</sub>

## 11. Build, test and deploy

How the static bundle is built and verified, which command-line tools sit beside the build, which tests guard which behaviour, what CI runs on pushes and pull requests to main, how a GitHub release is created, and how the frontend and the database are deployed.

### npm run build (scripts/build.mjs)

When build.mjs loads, it reads APP_VERSION from package.json and calls assertPublicKey from scripts/lib/supabase-key.mjs on the Supabase key. A blank key, a secret key (sb_secret_), a string that is neither a publishable key (sb_publishable_) nor a JWT with a readable payload, and a JWT whose role is not anon each throw an uncaught error before anything else runs. buildOnce then compiles Tailwind into .build/tailwind.css and bundles six esbuild entries (main, webllm-worker, ingest-worker, wasm-worker, supabase, app CSS) into content-hashed files with code splitting, inlining the Supabase URL, the key and APP_VERSION. Two esbuild plugins shape the bundle: ort-wasm-only resolves onnxruntime-web/webgpu and onnxruntime-common, which Transformers.js imports, to onnxruntime-web/wasm, and starpi-asset-urls writes the worker URLs and the ONNX Runtime binary URL into the sources while esbuild loads them, so every output is hashed with its final content. Because a worker's name depends on its content, which can hold another URL (the WASM worker holds the binary's), the build removes dist/ and bundles again until the written URLs equal the outputs, which takes three passes, and fails after four; each pass copies the ONNX Runtime binary from the onnxruntime-web package that was bundled to /assets/ort-wasm-simd-threaded-hash.wasm. It then copies public/ and rewrites the two %STARPI_ placeholders in index.html. buildVersion from scripts/lib/build-version.mjs hashes the page, the asset URLs (the binary included), every public file and the sw.js template into a 12-character version, and dist/sw.js receives that version, the precache list (the page, its CSS and JS, the ingest worker, the Latin font and the public files, never the WASM worker, the binary or the Supabase library) and the list of hashed assets. build-manifest.json records the version, the entries, the assets, the public files and the precache list. Tailwind or esbuild errors, esbuild warnings, a missing entry output, a placeholder in no source file, URLs that do not settle and any placeholder left unresolved each abort the build with exit code 1.

<!-- diagram: build-pipeline-build -->
```mermaid
flowchart TD
    START(["npm run build: node scripts/build.mjs<br/>also the Vercel buildCommand"]) --> ENV["SUPABASE_URL and SUPABASE_ANON_KEY from<br/>STARPI_SUPABASE_URL and STARPI_SUPABASE_ANON_KEY,<br/>else the public project defaults"]
    ENV --> APPV["APP_VERSION: the version field of package.json"]
    APPV --> AK{"assertPublicKey at module load,<br/>scripts/lib/supabase-key.mjs"}
    AK -->|"blank, or starts with sb_secret_"| FAILTOP(["uncaught Error outside main():<br/>Node prints it with the stack, exit code 1"])
    AK -->|"JWT payload not readable,<br/>or JWT role is not anon, e.g. service_role"| FAILTOP
    AK -->|"sb_publishable_ key or anon JWT:<br/>main() calls buildOnce"| TMPD["create .build/"]
    TMPD --> TW["tailwindcss -c tailwind.config.js<br/>-i src/styles/app.css -o .build/tailwind.css --minify<br/>content: src/index.html and src/js JS files"]
    TW -->|"exit status not 0"| FAIL
    TW -->|"ok, pass 1 without URLs"| PASS["remove dist/, clear the placeholders seen"]
    PASS --> ESB
    subgraph sg_esb["esbuild.build into dist/assets"]
      E1["main: src/js/main.js"]
      E2["webllm-worker: src/js/webgpu/worker.js"]
      E3["ingest-worker: src/js/rag/ingest.worker.js"]
      E5["wasm-worker: src/js/wasm/worker.js"]
      E6["supabase: src/js/supabase-lib.js,<br/>the Supabase library, loaded on first use"]
      E4["app: src/styles/entry.css<br/>Plus Jakarta Sans font faces + .build/tailwind.css"]
      ORT["plugin ort-wasm-only: onnxruntime-web/webgpu and<br/>onnxruntime-common resolve to onnxruntime-web/wasm,<br/>one ONNX Runtime without new Function"]
      URLS["plugin starpi-asset-urls: onLoad of src/js files writes<br/>this pass's URLs over __STARPI_WEBLLM_WORKER_URL__,<br/>__STARPI_INGEST_WORKER_URL__, __STARPI_WASM_WORKER_URL__,<br/>__STARPI_ORT_WASM_URL__ and __STARPI_SUPABASE_LIB_URL__,<br/>none in pass 1"]
      ESB["bundle, splitting, esm, minify, target es2022,<br/>chrome113, safari17, firefox121, linked sourcemaps<br/>and legal comments, entries name-hash, chunks chunk-hash,<br/>fonts as files, define inlines __STARPI_SUPABASE_URL__,<br/>__STARPI_SUPABASE_ANON_KEY__ and __STARPI_VERSION__"]
      E1 --> ESB
      E2 --> ESB
      E3 --> ESB
      E5 --> ESB
      E6 --> ESB
      E4 --> ESB
      ORT -.- ESB
      URLS -.- ESB
    end
    ESB -->|"build error"| FAIL
    ESB --> WARN{"esbuild warnings?"}
    WARN -->|"yes: warnings are errors"| FAIL
    WARN -->|"no"| RES["resolveUrls: hashed URLs of the three workers<br/>and the Supabase library, copyOrtWasm: ort-wasm-simd-threaded.wasm from the<br/>onnxruntime-web dist that was bundled, written to<br/>/assets/ort-wasm-simd-threaded-sha256 16 hex.wasm"]
    RES -->|"no output for an entry,<br/>onnxruntime-web/wasm not bundled"| FAIL
    RES --> SETTLED{"every URL equals the one<br/>written into this pass?"}
    SETTLED -->|"no, pass 4"| FAIL
    SETTLED -->|"no, passes 1 to 3: next pass<br/>with these URLs, settles in pass 3"| PASS
    SETTLED -->|"yes"| META{"metafile present and all five<br/>entry outputs found, every<br/>placeholder seen in a source file?"}
    META -->|"no"| FAIL
    META -->|"yes"| PUB["copyPublic: public/ copied into dist/,<br/>file list kept for the version and the precache"]
    PUB --> HTML["src/index.html: %STARPI_APP_CSS% and<br/>%STARPI_MAIN_JS% set to the hashed URLs"]
    HTML --> HCHK{"any %STARPI_ left?"}
    HCHK -->|"yes"| FAIL
    HCHK -->|"no"| WHTML["write dist/index.html"]
    WHTML --> VER["buildVersion, scripts/lib/build-version.mjs:<br/>sha256 over index.html, the sorted asset URLs<br/>without .map and .LEGAL.txt plus the ONNX Runtime binary,<br/>each public file as URL plus bytes, then the src/sw.js<br/>template, first 12 hex chars"]
    VER --> SHELL["precache shell: /, app CSS, main JS, ingest worker,<br/>the Latin plus-jakarta-sans woff2 when present,<br/>static imports of main, public files,<br/>/index.html, the WASM worker, the binary<br/>and the Supabase library are not listed"]
    SHELL --> SW["src/sw.js: __STARPI_BUILD_VERSION__ gets the version,<br/>__STARPI_PRECACHE__ the deduplicated shell,<br/>__STARPI_ASSETS__ the sorted asset URLs"]
    SW --> SCHK{"any __STARPI_ left?"}
    SCHK -->|"yes"| FAIL
    SCHK -->|"no"| WSW["write dist/sw.js"]
    WSW --> MAN["write dist/build-manifest.json: version, entries<br/>mainJs, workerJs, ingestWorkerJs, wasmWorkerJs,<br/>ortWasm, appCss, supabaseJs, then assets,<br/>public, precache"]
    MAN --> DONE(["log built main JS, app CSS,<br/>version and duration"])
    FAIL(["main().catch prints the message,<br/>process.exit(1)"])
```

<sub>Sources: [`scripts/build.mjs`](../scripts/build.mjs), [`scripts/lib/build-version.mjs`](../scripts/lib/build-version.mjs), [`scripts/lib/supabase-key.mjs`](../scripts/lib/supabase-key.mjs), [`package.json`](../package.json), [`tailwind.config.js`](../tailwind.config.js), [`src/styles/entry.css`](../src/styles/entry.css), [`src/index.html`](../src/index.html), [`src/sw.js`](../src/sw.js), [`src/js/config.js`](../src/js/config.js), [`src/js/webgpu/engine.js`](../src/js/webgpu/engine.js), [`src/js/rag/workspace.js`](../src/js/rag/workspace.js), [`src/js/wasm/worker.js`](../src/js/wasm/worker.js), [`src/js/supabase.js`](../src/js/supabase.js), [`vercel.json`](../vercel.json)</sub>

### Build output gate (verify-dist.mjs)

verify-dist.mjs reads build-manifest.json and index.html and runs every check, collecting problems instead of stopping at the first one; only a missing or unparsable file crashes it early. It enforces CSP-compatible HTML (no inline scripts, styles or handlers, only /assets/ scripts and stylesheets, no javascript: URLs) and checks that every referenced and precached file exists. For the service worker it requires the build version and no placeholder in sw.js, a non-empty list of public files, and a version that buildVersion recomputes to the same value from dist/index.html, the listed assets, the listed public files and the src/sw.js template. The ingest worker must be precached, /index.html must not be, and the app CSS must keep the ::highlight(starpi-review) rule that the source check uses. No JS asset may keep a placeholder, new Function or bare eval, and no JS asset, nor index.html, sw.js or build-manifest.json, may contain an NVIDIA API key (nvapi- followed by at least 20 key characters, backslashes included, so keys pasted with Markdown escapes are found too). The processor (WASM) runtime must load on first use only: the WASM worker and the ONNX Runtime binary must exist, the binary under a 16-hex-digit hashed /assets name, with the WebAssembly magic bytes, listed in the assets and referenced by a script, and neither of them, nor the Supabase library, nor any precached script that carries Transformers.js or ONNX Runtime, may be in the precache. vercel.json must carry a Content-Security-Policy without unsafe-inline or unsafe-eval. Any problem prints the list and exits 1.

<!-- diagram: build-pipeline-verify-dist -->
```mermaid
flowchart TD
    START(["npm run verify:dist: node scripts/verify-dist.mjs<br/>after npm run build in npm run verify and CI"]) --> READ["read dist/build-manifest.json<br/>and dist/index.html"]
    READ -->|"missing file or invalid JSON, here or in a later read:<br/>sw.js, public files, src/sw.js, app CSS,<br/>JS assets, vercel.json"| CRASH(["uncaught error: non-zero exit"])
    READ --> C1
    subgraph sg_html["1. index.html works under script-src self and style-src self"]
      C1["every script tag has a src under /assets/<br/>and no inline content"]
      C2["no style block and no inline style attribute"]
      C3["no on* event handler attributes"]
      C4["every rel=stylesheet link href is under /assets/"]
      C5["no javascript: URL"]
      C1 --> C2 --> C3 --> C4 --> C5
    end
    C5 --> R1
    subgraph sg_refs["2. references resolve"]
      R1["every root-relative src and href in index.html<br/>and every precache entry, except /,<br/>is a file in dist/"]
    end
    R1 --> S1
    subgraph sg_sw["3. service worker and build version"]
      S1["dist/sw.js has no __STARPI_ placeholder"]
      S2["dist/sw.js contains manifest.version"]
      S3["manifest.public lists at least one file"]
      S4["buildVersion over dist/index.html, manifest.assets,<br/>the dist/ copies of manifest.public and src/sw.js<br/>equals manifest.version"]
      S1 --> S2 --> S3 --> S4
    end
    S4 --> K1
    subgraph sg_shell["offline shell and app CSS"]
      K1["precache contains entries.ingestWorkerJs"]
      K2["precache does not contain /index.html,<br/>/ is the only shell page"]
      K3["the app CSS contains ::highlight(starpi-review)"]
      K1 --> K2 --> K3
    end
    K3 --> J1
    subgraph sg_js["4. every .js file in manifest.assets"]
      J1["no __STARPI_ placeholder"]
      J2["no new Function( call"]
      J3["no bare eval( call,<br/>obj.eval( is not matched"]
      J4["no NVIDIA API key: nvapi- and 20 or more<br/>key characters or backslashes, also checked<br/>in index.html, sw.js and build-manifest.json"]
      J1 --> J2 --> J3 --> J4
    end
    J4 --> W1
    subgraph sg_wasm["5. processor (WASM) runtime loads on first use"]
      W1["entries.wasmWorkerJs exists"]
      W2["entries.ortWasm matches /assets/ort-wasm-simd-threaded-<br/>16 hex digits .wasm, exists, starts with the<br/>WebAssembly magic bytes, is in manifest.assets"]
      W3["neither is in the precache, a script references the binary,<br/>no precached script carries the Transformers.js<br/>download path or the binary name"]
      W1 --> W2 --> W3
    end
    W3 --> P1
    subgraph sg_csp["6. production CSP in vercel.json"]
      P1["a Content-Security-Policy header exists"]
      P2["no 'unsafe-inline' or 'unsafe-eval'<br/>('wasm-unsafe-eval' passes)"]
      P1 --> P2
    end
    P2 --> Q{"any problem collected?"}
    Q -->|"yes"| FAIL(["print verify-dist: N problem(s)<br/>with the list, exit 1"])
    Q -->|"no"| OK(["verify-dist: OK with version,<br/>asset count and precache count"])
```

<sub>Sources: [`scripts/verify-dist.mjs`](../scripts/verify-dist.mjs), [`scripts/lib/build-version.mjs`](../scripts/lib/build-version.mjs), [`package.json`](../package.json), [`vercel.json`](../vercel.json), [`scripts/build.mjs`](../scripts/build.mjs), [`src/styles/app.css`](../src/styles/app.css)</sub>

### Dev watch mode and the local static server

npm run dev runs the build with --watch --serve: after the first build (whose failure exits 1) it watches src/ and public/ with a 120 ms debounce, where rebuild errors are logged and never stop the watcher, and it spawns serve.mjs on port 3000 with --functions. npm run preview runs the same server with --functions, and the Playwright webServer runs it on STARPI_E2E_PORT (default 4173) without --functions, so the end-to-end tests never reach NVIDIA even when NVIDIA_API_KEYS is set and mock /api/* themselves. serve.mjs only serves an existing dist/ on 127.0.0.1. It applies the vercel.json header rules in file order, with (.*) as the only wildcard: every path gets the CSP and security headers, hashed assets are immutable, and /, /index.html, /sw.js and /manifest.webmanifest add their own rules, so previews and the e2e suite, workers included, run under the production CSP. With --functions, /api/chat/nvidia and /api/models/nvidia run the Vercel function modules from api/ in the same process: only for a Host that is localhost, an IP address or a host named in NVIDIA_ALLOWED_ORIGINS (a page whose name was rebound to this machine gets 403 host_not_allowed and never the developer's keys), with forwarding headers from the client dropped and x-real-ip set from the socket, the request body passed as a stream, the response streamed with backpressure and the function's request aborted when the client goes away. Files resolve as path, path.html or path/index.html inside dist/; misses return 404, HEAD returns no body, and exceptions return 500, or close the connection when a streamed response has already begun. Extensions missing from its MIME table, such as the .pdf, .csv and .md sample files, are served as application/octet-stream, while .wasm is application/wasm.

<!-- diagram: build-pipeline-dev-server -->
```mermaid
flowchart TD
    DEV(["npm run dev:<br/>build.mjs --watch --serve"]) --> B1["buildOnce: same steps as npm run build"]
    B1 -->|"first build fails"| X1(["process.exit(1)"])
    B1 -->|"ok"| WATCH["fs.watch src/ and public/ recursively"]
    WATCH --> SPAWN["--serve: spawn node scripts/serve.mjs<br/>--port 3000 --functions"]
    WATCH -->|"file change"| DEB["debounce 120 ms, then buildOnce<br/>(dist/ is removed and rebuilt)"]
    DEB -->|"ok"| LOGR["log rebuilt with the new version"]
    DEB -->|"error"| LOGE["console.error, keep watching"]
    PREV(["npm run preview:<br/>serve.mjs --port 3000 --functions"]) --> SRV
    SPAWN --> SRV
    PW(["Playwright webServer: serve.mjs --port STARPI_E2E_PORT,<br/>default 4173, without --functions,<br/>reuses a running server only outside CI,<br/>waits up to 30 s for /"]) --> SRV
    SRV["serve.mjs on 127.0.0.1 serves the existing dist/,<br/>it never builds"] --> RULES["header rules from vercel.json via toRegExp:<br/>(.*) is the only wildcard, the rest is literal,<br/>every matching rule applies in file order"]
    RULES --> REQ{"request pathname"}
    REQ -->|"every path, rule /(.*)"| H1["CSP, nosniff, X-Frame-Options, Referrer-Policy,<br/>COOP, HSTS, Permissions-Policy"]
    REQ -->|"/, /index.html, /sw.js,<br/>/manifest.webmanifest"| H2["plus the exact-source rule: Cache-Control,<br/>Service-Worker-Allowed or Content-Type"]
    REQ -->|"/assets/(.*)"| H3["plus Cache-Control: public,<br/>max-age=31536000, immutable"]
    H1 --> FN
    H2 --> FN
    H3 --> FN
    FN{"--functions and the path is<br/>/api/chat/nvidia or /api/models/nvidia?"}
    FN -->|"yes"| HOST{"Host is localhost, an IP address<br/>or a host of NVIDIA_ALLOWED_ORIGINS?"}
    HOST -->|"no, e.g. a rebound DNS name"| F403(["403 host_not_allowed"])
    HOST -->|"yes"| METH{"the module exports<br/>the request method?"}
    METH -->|"no, e.g. HEAD"| F405(["405 Method not allowed"])
    METH -->|"yes"| RUN["Request: client forwarding headers dropped,<br/>x-real-ip from the socket, body as a stream,<br/>aborted when the client closes"]
    RUN --> HANDLER["POST or GET handler from api/,<br/>handleChat or handleModels with<br/>runtimeDeps from the environment"]
    HANDLER --> FOUT(["status and headers of the function,<br/>body streamed with backpressure,<br/>reader cancelled when the client goes away"])
    FN -->|"no"| RES
    RES{"resolveFile: path, path.html or<br/>path/index.html inside dist/?<br/>/ maps to /index.html"}
    RES -->|"none, or outside dist/"| NF(["404 Not found"])
    RES -->|"found"| CT["Content-Type from the MIME table unless a rule<br/>already set it, .wasm application/wasm,<br/>application/octet-stream for other extensions<br/>such as .pdf, .csv and .md"]
    CT --> HEAD{"HEAD request?"}
    HEAD -->|"yes"| HEND(["end without a body"])
    HEAD -->|"no"| STREAM(["stream the file"])
    RES -->|"exception, e.g. malformed<br/>percent-encoding"| E500(["500 with the error text,<br/>or the connection closed when<br/>a function response had begun"])
```

<sub>Sources: [`scripts/build.mjs`](../scripts/build.mjs), [`scripts/serve.mjs`](../scripts/serve.mjs), [`api/chat/nvidia.js`](../api/chat/nvidia.js), [`api/models/nvidia.js`](../api/models/nvidia.js), [`api/_lib/handlers.js`](../api/_lib/handlers.js), [`package.json`](../package.json), [`playwright.config.mjs`](../playwright.config.mjs), [`tests/e2e/fixtures.mjs`](../tests/e2e/fixtures.mjs), [`vercel.json`](../vercel.json)</sub>

### Command-line tools beside the build

Seven more npm scripts sit outside the build and deploy path; of them, CI runs pack:core directly in the frontend job and sbom in the audit job, and release.yml runs both. verify:receipt checks an answer receipt against the original files with the extraction and chunking code the app uses: it matches files by their SHA-256 fingerprint, not by name, re-extracts them, compares the passage at the recorded offsets and the recorded chunk, and recomputes the source check, with the rules version the receipt records, for every statement whose cited excerpts, and the other excerpts its reasons name, are available, using only the first deliveredChars characters of an excerpt that reached the model in part. For a starpi.receipt/v2 receipt it also recomputes the Merkle root, checks every inclusion proof and checks the signature, if there is one, against the public key given with --public-key (a JWK or PEM file) or else the key embedded in the receipt. It exits 0 when every workspace excerpt was reproduced and the tree and any signature are valid, 1 when something does not match, a file is missing, the root or an inclusion proof fails, the signature is invalid, made with another key or cannot be checked, or a --public-key was given and the receipt is not validly signed with it, and 2 on a usage error, a key file importPublicKey refuses or an invalid receipt, which includes a member or reason code the format does not define. In the text report, strings from the receipt and the given file names (labels, the creation time, the engine, file names in the checks and warnings) are printed with control and bidirectional characters escaped, so a crafted receipt cannot rewrite report lines in a terminal. The app does not sign receipts, so a pass on one of them shows that the cited excerpts can be reproduced from the given files; it does not prove that the receipt is authentic, what a model saw, or that the answer is right. build:core bundles the @starpi/core package (an npm workspace of the root package, which declares Node.js 22.13 or newer and has the app's version) from the app's own modules, including the same verifier and starpi-ground (scripts/ground.mjs, which has no npm script of its own, see source-check-ground-cli) as packaged commands, and pack:core runs npm pack --workspace=@starpi/core --dry-run, whose prepack script runs build:core with type declarations, and lists the package contents without publishing anything; release.yml packs the same way into a real tarball. sbom (scripts/sbom.mjs) writes CycloneDX SBOMs of the app and of @starpi/core from package-lock.json with npm sbom --package-lock-only, without installing anything, and scripts/lib/sbom.mjs makes them deterministic and validates them before they are written. eval:source-check measures the source check on labelled answers with either version of the rules, leaving out the held-out sets (holdout and v2holdout) unless --unblind is given and refusing a v2 held-out file whose SHA-256 differs from the one committed before the version 2 rules were written (docs/eval/v2-protocol.md), and docs:sync copies atlas diagrams into the Markdown files that embed them. nvidia:ping is a maintainer tool that CI never runs, because it spends real quota: it reads NVIDIA_API_KEYS the way the proxy does (exit 2 without a valid key), asks GET /v1/models once which allowlisted ids exist, sends one small streamed request per model, moving to the next key on 429, and prints only id, status, first-byte time and whether reasoning and content arrived, never a key, header or body; it exits 1 when a model fails, an id is not listed or the list cannot be read. The unit tests run verify-receipt.mjs, ground.mjs, build-core.mjs, sbom.mjs and the evaluation.

<!-- diagram: build-pipeline-cli-tools -->
```mermaid
flowchart TD
    subgraph sg_receipt["npm run verify:receipt: scripts/verify-receipt.mjs receipt.json [file ...] [--public-key key] [--json]"]
      V1{"options known, --public-key with a file,<br/>receipt path given and readable,<br/>at most RECEIPT_LIMITS.bytes 2000000,<br/>JSON, and validateReceipt passes:<br/>limits, types, no unknown member or reason code?"}
      VK{"no --public-key, or importPublicKey<br/>reads the file as a JWK or PEM public key?"}
      V2{"every given file readable?"}
      V3["verifyReceipt with EXTRACTOR and extractText<br/>from src/js/rag/parser.js and the public key:<br/>v2 Merkle root, inclusion proofs and signature,<br/>file by SHA-256 fingerprint, extracted text,<br/>passage at the recorded offsets, chunk rebuilt,<br/>source check recomputed with the recorded rules version<br/>for statements whose excerpts are available, a partly<br/>delivered excerpt cut to its recorded deliveredChars"]
      V4{"receipt id and answer hash match,<br/>every workspace excerpt has file match<br/>and passage match, no excerpt differs<br/>from its recorded fingerprint, root and every proof<br/>valid, signature valid or unsigned, and valid<br/>with the given key when there is one?"}
      V1 -->|"yes"| VK
      VK -->|"yes"| V2
      V2 -->|"yes"| V3 --> V4
    end
    V1 -->|"no"| X2(["usage message on stderr, exit 2"])
    VK -->|"no"| X2
    V2 -->|"no"| X2
    V4 -->|"no"| X1(["report, exit 1"])
    V4 -->|"yes"| X0(["report, exit 0"])
    REP["report: ok or FAIL per check, the Merkle line or<br/>n/a for format v1, the signature line, knowledge-base<br/>excerpts n/a, N/M workspace excerpts reproduced,<br/>verdicts that now differ, or JSON with --json;<br/>control and bidi characters in receipt strings<br/>and file names printed as escapes in the text report"]
    V4 -.- REP
    subgraph sg_core["npm run build:core: scripts/build-core.mjs [--out dir] [--no-types]"]
      C1["remove and recreate the output directory,<br/>default packages/core/dist"]
      C2["esbuild: packages/core/src/index.js to index.js,<br/>platform neutral, es2022, pdfjs-dist external"]
      C3["esbuild: scripts/verify-receipt.mjs to verify-receipt.js<br/>and scripts/ground.mjs to ground.js, the bins<br/>starpi-verify-receipt and starpi-ground,<br/>platform node, target node20, pdfjs-dist external;<br/>packages/core/package.json engines: node 22.13 or newer"]
      C4["unless --no-types: tsc -p packages/core/tsconfig.build.json<br/>into types/, then index.d.ts"]
      C1 --> C2 --> C3 --> C4
    end
    PACK["npm run pack:core, also in the CI frontend job:<br/>npm pack --workspace=@starpi/core --dry-run,<br/>its prepack script runs build-core.mjs"] --> C1
    SBOM["npm run sbom [--out dir]: scripts/sbom.mjs,<br/>npm sbom --package-lock-only for the app and for<br/>--workspace @starpi/core, normalized and validated<br/>by scripts/lib/sbom.mjs, CI audit job and release.yml"]
    TSBOM["sbom.test.mjs: two runs of scripts/sbom.mjs<br/>write identical files"] -.-> SBOM
    TCORE["core-package.test.mjs: build-core.mjs --out a temp dir<br/>--no-types, both commands start with a shebang,<br/>the bundle checks an answer and builds a receipt,<br/>the bundled verify-receipt.js reproduces it with a valid tree,<br/>the bundled ground.js writes SARIF with missing_fact, exit 1,<br/>and exits 2 without arguments, package.json: both bins,<br/>files cover every entry point, public, a workspace,<br/>the app's version"] -.-> C1
    TREC["receipt.test.mjs and receipt-v2.test.mjs run verify-receipt.mjs:<br/>exit 0 with the file, 1 without it, 2 for another schema<br/>and for no arguments; with v2 receipts: tree and signature<br/>lines, exit 1 for another key, an unsigned receipt with a key,<br/>a forged signature or a broken proof, 2 for a private key,<br/>the 1.3.0 receipt still exit 0"] -.-> V1
    EV["npm run eval:source-check [--sets list] [--grounding 1 or 2]<br/>[--variants] [--unblind] [--json]: labelled answers in eval.json,<br/>eval-v2-dev.json, eval-v2-holdout.json and paraphrases.json<br/>against the sample files, kb-sample.json, sources-v2.json and<br/>the paraphrase sources, per set dev, holdout, v2dev, v2holdout<br/>and paraphrases: false alarms, planted errors caught,<br/>flagged or missed; holdout and v2holdout only with --unblind,<br/>eval-v2-holdout.json checked against eval-v2-holdout.sha256"]
    TEV["source-check-eval.test.mjs: thresholds on the same<br/>summarize results for rules versions 1 and 2,<br/>see the unit tests below"] -.->|"imports loadItems, loadV2Items,<br/>loadParaphrases, loadCorpora, summarize"| EV
    DS["npm run docs:sync: copy each diagram of docs/ARCHITECTURE.md<br/>into the Markdown files that embed its id,<br/>with --check change nothing and exit 1 on an outdated copy,<br/>an unknown id exits 1 in both modes"]
    TDOC["docs.test.mjs: every embedded copy<br/>equals the atlas diagram"] -.- DS
    NP["npm run nvidia:ping: scripts/nvidia-ping.mjs, maintainer only,<br/>not in CI, real quota: NVIDIA_API_KEYS parsed like the proxy,<br/>exit 2 without a valid key, GET /v1/models once,<br/>one streamed request per allowlisted model, max_tokens 256,<br/>next key on 429, prints id, status, first-byte ms,<br/>reasoning and content flags only, exit 1 on any failure"]
```

<sub>Sources: [`package.json`](../package.json), [`scripts/verify-receipt.mjs`](../scripts/verify-receipt.mjs), [`src/js/core/receipt.js`](../src/js/core/receipt.js), [`src/js/core/signature.js`](../src/js/core/signature.js), [`scripts/ground.mjs`](../scripts/ground.mjs), [`scripts/build-core.mjs`](../scripts/build-core.mjs), [`packages/core/package.json`](../packages/core/package.json), [`packages/core/src/index.js`](../packages/core/src/index.js), [`scripts/eval-source-check.mjs`](../scripts/eval-source-check.mjs), [`tests/fixtures/grounding/eval-v2-holdout.sha256`](../tests/fixtures/grounding/eval-v2-holdout.sha256), [`docs/eval/v2-protocol.md`](eval/v2-protocol.md), [`scripts/sync-diagrams.mjs`](../scripts/sync-diagrams.mjs), [`scripts/sbom.mjs`](../scripts/sbom.mjs), [`scripts/lib/sbom.mjs`](../scripts/lib/sbom.mjs), [`tests/unit/receipt.test.mjs`](../tests/unit/receipt.test.mjs), [`tests/unit/receipt-v2.test.mjs`](../tests/unit/receipt-v2.test.mjs), [`tests/unit/sbom.test.mjs`](../tests/unit/sbom.test.mjs), [`tests/unit/core-package.test.mjs`](../tests/unit/core-package.test.mjs), [`tests/unit/source-check-eval.test.mjs`](../tests/unit/source-check-eval.test.mjs), [`tests/unit/docs.test.mjs`](../tests/unit/docs.test.mjs), [`scripts/nvidia-ping.mjs`](../scripts/nvidia-ping.mjs), [`tests/unit/nvidia-catalog.test.mjs`](../tests/unit/nvidia-catalog.test.mjs)</sub>

### CI jobs and the test layers they run

The CI workflow runs six jobs on pushes and pull requests to main (and on manual dispatch). The frontend job runs lint, typecheck, the node:test unit suite of 38 files with 479 tests (including the documentation test, a build of @starpi/core into a temporary directory, two runs of the SBOM generator and the NVIDIA proxy with injected fetch and real timers), a typed build and dry-run pack of @starpi/core, the production build and verify-dist, then uploads dist, which the e2e job reuses to run Playwright under the production headers: the app spec, the trust spec with its axe accessibility scan, the model picker and chat mode specs with a mocked NVIDIA proxy, and the Mermaid render gate, 94 test runs on two projects. The backend job lints, byte-compiles and runs the offline unittest suite of the library publisher, 76 tests, on Python 3.11 and 3.13. The database job installs PostgreSQL 16 with pgvector and runs the RLS harness, whose rls_test.sql has 220 checks in the fresh and fresh_rerun scenarios and 227 in the three scenarios seeded with legacy rows. The audit job runs npm audit on the lockfile, failing on any advisory in a runtime dependency and only warning about development tooling, and pip-audit on the library publisher's requirements, then writes CycloneDX SBOMs of the app and of @starpi/core from the lockfile and uploads them, and the secrets job scans the tree, and on pull requests the new commits, with a checksum-verified gitleaks. npm run verify repeats the frontend gate locally.

<!-- diagram: test-strategy-ci-gates -->
```mermaid
flowchart LR
    trig(["CI workflow: push to main, pull_request to main,<br/>workflow_dispatch, permissions contents read,<br/>concurrency cancels the older run"])

    subgraph jobFront["Job frontend: Node 22, npm ci --ignore-scripts"]
        lint["npm run lint<br/>ESLint, eslint.config.mjs"]
        tc["npm run typecheck<br/>tsc -p tsconfig.json --noEmit"]
        unit["npm test<br/>node --test on the 38 tests/unit/*.test.mjs files, 479 tests,<br/>docs.test.mjs, core-package.test.mjs, sbom.test.mjs<br/>and nvidia-proxy.test.mjs included"]
        pack["npm run pack:core<br/>typed build of @starpi/core, npm pack --dry-run"]
        build["npm run build<br/>scripts/build.mjs"]
        verify["npm run verify:dist<br/>scripts/verify-dist.mjs: dist/ is CSP-compatible,<br/>referenced assets exist, sw.js carries the recomputed version"]
        art[("artifact dist, kept 3 days")]
    end

    subgraph jobE2e["Job e2e, needs frontend"]
        dl["download artifact dist,<br/>npx playwright install --with-deps chromium"]
        pw["npm run test:e2e<br/>app.spec.mjs 17 tests, trust.spec.mjs 13,<br/>models.spec.mjs 8 and modes.spec.mjs 8,<br/>on desktop-chromium and mobile-chromium,<br/>docs-diagrams.spec.mjs skipped on mobile, mermaid 12.1.0,<br/>94 test runs in all"]
        rep[("on failure: playwright-report<br/>and test-results, kept 7 days")]
    end

    subgraph jobBack["Job backend, library publisher, matrix Python 3.11 and 3.13"]
        ruff["ruff check tools/library-publisher backend,<br/>ruff format --check tools/library-publisher backend"]
        comp["python -m compileall -q tools/library-publisher backend"]
        ut["python -m unittest discover in tools/library-publisher, 76 tests<br/>chunker, config, structurer, e5 prefixes, mean pooling and<br/>L2 norm with a fake session, pinned model files with a fake hub,<br/>Supabase payloads, shared-row filters and errors,<br/>pipeline and every command against MockTransport<br/>the test against the real model is skipped without<br/>PUBLISHER_TEST_MODEL_DIR"]
    end

    subgraph jobDb["Job database"]
        apt["apt-get install postgresql-16,<br/>postgresql-16-pgvector"]
        rls["bash backend/supabase/tests/run_rls_tests.sh<br/>PG_BIN /usr/lib/postgresql/16/bin<br/>live, fresh, fresh_rerun, legacy_v2, legacy_v1,<br/>guard, guard_order, guard_vectors, schema parity via pg_dump<br/>rls_test.sql: 220 checks, 227 with legacy rows"]
    end

    subgraph jobAudit["Job audit"]
        npmRt["npm audit --omit=dev --audit-level=low<br/>any advisory in a runtime dependency fails"]
        npmAll["npm audit --audit-level=high<br/>development tooling: warning only"]
        pipAud["pip-audit -r backend/requirements-dev.txt<br/>any advisory fails"]
        sbom["npm run sbom, also after a failed audit step<br/>CycloneDX 1.5 SBOMs of the app and of @starpi/core<br/>from package-lock.json, artifact sbom, kept 30 days"]
    end

    subgraph jobSec["Job secrets"]
        gl["gitleaks 8.30.1 download,<br/>sha256sum -c checksum"]
        glDir["gitleaks dir . --config .gitleaks.toml<br/>--redact --exit-code 1"]
        glPr["gitleaks git over BASE_SHA..HEAD_SHA<br/>commits of the pull request"]
    end

    local["Local gate npm run verify:<br/>lint, typecheck, test, build, verify:dist"]

    trig --> lint
    trig --> ruff
    trig --> apt
    trig --> npmRt
    trig --> gl
    lint --> tc --> unit --> pack --> build --> verify --> art
    art -->|"built once, reused"| dl --> pw
    pw -.->|"failure"| rep
    ruff --> comp --> ut
    apt --> rls
    npmRt --> npmAll --> pipAud --> sbom
    gl --> glDir
    glDir -->|"pull_request only"| glPr
    local -.->|"same steps as"| lint
```

<sub>Sources: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), [`package.json`](../package.json), [`tools/library-publisher/publisher/tests/test_cli.py`](../tools/library-publisher/publisher/tests/test_cli.py), [`tools/library-publisher/publisher/tests/test_embedder.py`](../tools/library-publisher/publisher/tests/test_embedder.py), [`backend/supabase/tests/run_rls_tests.sh`](../backend/supabase/tests/run_rls_tests.sh), [`backend/supabase/tests/rls_test.sql`](../backend/supabase/tests/rls_test.sql), [`scripts/verify-dist.mjs`](../scripts/verify-dist.mjs), [`playwright.config.mjs`](../playwright.config.mjs), [`tests/unit/docs.test.mjs`](../tests/unit/docs.test.mjs), [`tests/unit/core-package.test.mjs`](../tests/unit/core-package.test.mjs), [`tests/unit/nvidia-proxy.test.mjs`](../tests/unit/nvidia-proxy.test.mjs), [`tests/e2e/app.spec.mjs`](../tests/e2e/app.spec.mjs), [`tests/e2e/trust.spec.mjs`](../tests/e2e/trust.spec.mjs), [`tests/e2e/models.spec.mjs`](../tests/e2e/models.spec.mjs), [`tests/e2e/modes.spec.mjs`](../tests/e2e/modes.spec.mjs), [`tests/e2e/docs-diagrams.spec.mjs`](../tests/e2e/docs-diagrams.spec.mjs)</sub>

### Unit tests grouped by concern

npm test runs the 38 tests/unit/*.test.mjs files (479 tests) with the built-in node:test runner in the frontend CI job; 26 of them are grouped here, the other 12 in the next diagram. Security and UI contract tests cover the sanitizer (on a real jsdom DOM), server URL validation (http only for localhost and 127.0.0.1), the CSP and build settings in vercel.json, handler and icon coverage, and dictionary parity including keys built at run time and plural forms. Retrieval tests pin exact BM25 scores, chunk boundaries, parser error codes (with a generated PDF from tests/fixtures/pdf.mjs) and CSV rows, citation labels, context fences that are never cut and the merge of workspace and knowledge-base hits, and grounded offline answers. Model tests pin the prompts of both chat modes and the fitting of NVIDIA requests, the 13 WebGPU presets and their test-coupled README table, the device classes and recommendations, the picker groups, the pinned WASM catalog with its README table, its download pins and the WASM-only ONNX Runtime bundle, and the benchmark metrics. Chat tests pin the SSE parser and stream assembler, the NVIDIA browser client with its error mapping and partial answers, the chat export and the code copy buttons. The NVIDIA proxy tests run the guards, the shared validation vectors in backend/test_fixtures/nvidia_validation.json, the key router with injected fetch and real but short timers, the stream relay and the Vercel wiring, and the catalog tests check the README table against the catalog and scan every tracked file for NVIDIA keys. Build tests pin buildVersion, assertPublicKey, the typecheck coverage of every @ts-check module and every server module under api/, and the CycloneDX SBOMs (deterministic, valid, one entry per package, @starpi/core without dependencies), and docs.test.mjs keeps every documentation diagram single-sourced in docs/ARCHITECTURE.md and checks relative links and heading anchors in every Markdown file.

<!-- diagram: test-strategy-unit -->
```mermaid
flowchart LR
    runner(["npm test: node --test tests/unit/*.test.mjs, 38 files, 479 tests<br/>CI job frontend, also inside npm run verify<br/>26 files here, 12 in the next diagram"])

    subgraph gSec["Security and UI contracts"]
        render["render.test.mjs, real DOM via jsdom<br/>escapeHtml, renderMarkdown drops scripts, handlers, styles,<br/>images, iframes, javascript: and data: links, data-*, class, id,<br/>https links get rel noopener noreferrer nofollow,<br/>escapeMarkdown, sanitizeModelNames on whole words"]
        config["config.test.mjs, constants from setup.mjs<br/>normalizeServerUrl: https anywhere, http only on localhost<br/>and 127.0.0.1, http://[::1] rejected, normalizeMode,<br/>normalizeChatMode, callGemini in both chat modes, classifyError,<br/>vercel.json CSP: script-src self wasm-unsafe-eval, no unsafe-*,<br/>object-src, frame-ancestors, base-uri none, img-src without https:,<br/>output dist, npm ci --ignore-scripts, microphone self"]
        actions["actions.test.mjs, static scan of src/<br/>every data-action and data-change has a handler and vice versa,<br/>no inline on* attributes, lucide icons bundled exactly as used,<br/>no emoji, icon-only buttons named, aria-labels translatable"]
        i18n["i18n.test.mjs<br/>en.json and de.json: same keys and placeholders, no empty values,<br/>German differs, every key used in src/ resolves without fallback,<br/>also keys built at run time, e.g. engine errors, a source check<br/>reason for every code in REASON_CODES, receipt checks,<br/>sample questions, voice errors, t() interpolation, key fallback,<br/>singular for a count of 1, plural otherwise"]
    end

    subgraph gRag["Workspace, retrieval and offline answers"]
        parser["parser.test.mjs with tests/fixtures/pdf.mjs makePdf<br/>extensions, BOM and control characters, JSON flattening,<br/>UTF-8 split across stream chunks, PDF text via pdf.js,<br/>error codes for unsupported, empty and broken files,<br/>CSV quoting, header rows as column: value lines"]
        chunker["chunker.test.mjs<br/>500-character windows with 50 overlap,<br/>paragraph, sentence, word boundaries,<br/>surrogate pairs kept, linear time, invalid options"]
        bm25["bm25.test.mjs<br/>tokenize, exact Okapi BM25 with k1 1.2 and b 0.75,<br/>idf, saturation, ties, topK, removal equals never added"]
        retrieval["retrieval.test.mjs<br/>rankHitsLocally, distinctSources, citation labels,<br/>excerpt truncation, buildContext fencing and size limit,<br/>no fence left open at any budget, cut excerpts end with an ellipsis,<br/>mergeHits: slot split, a strong knowledge-base hit kept,<br/>pinned hits of an attached file kept"]
        synth["synthesizer.test.mjs<br/>splitSentences, answers only with source sentences<br/>and cites each, admits no match, lists documents,<br/>isGreeting, escapes titles against Markdown links,<br/>describeTrace, describeChatTrace"]
    end

    subgraph gModel["Prompts, models, device tiers and diagnostics"]
        prompts["prompts.test.mjs<br/>identity per language, grounding, prompt-injection<br/>and citation rules, context block, readiness prompt,<br/>free-chat rules, the attached file fenced as data,<br/>historyWindow, excerptForChat, fitNvidiaMessages:<br/>oldest pairs first, UTF-8 byte budget, excerpts cut last<br/>with their closing lines, cutFenced, WebLLM load progress"]
        models["models.test.mjs<br/>13 presets only from the pinned WebLLM prebuilt list,<br/>f32 fallback, VRAM and tier classes, context limits,<br/>README WebGPU table, normalizePreference migrates 2.0 keys,<br/>chooseModel: WASM without WebGPU, explicit runtimes kept,<br/>never T3 automatically, detectMobile, budgetPrompt turnChars"]
        device["device.test.mjs<br/>classifyDevice for every class, recommendModels<br/>per class, hardwareBadges with keys in every locale,<br/>pure model modules touch no browser globals"]
        choices["choices.test.mjs<br/>parseAssistantChoice refuses values the pickers never offer,<br/>choiceValue, group order with every preset once,<br/>recommended and pro picks, NVIDIA group per proxy state,<br/>optionParts order, keys in both locales,<br/>model names never in the locale files"]
        wasmcat["wasm-catalog.test.mjs<br/>pinned revisions and every downloaded file,<br/>sizes and context, cache name outside starpi-,<br/>pinnedWasmUrl refuses other repos and revisions,<br/>README WASM table, Transformers.js pinned exactly,<br/>a WASM-only ONNX Runtime bundle the CSP allows"]
        diag["diagnostics.test.mjs<br/>computeBenchmarkMetrics: TTFT and decode throughput<br/>from timestamps, no throughput it did not measure,<br/>formatBytes, BYTE_LIMITS"]
    end

    subgraph gChat["Chat streaming, export and the answer runner"]
        cstream["chat-stream.test.mjs<br/>createSseParser at every chunk boundary, CRLF and CR,<br/>multi-line data, a final unterminated event, too long throws,<br/>assembler: content, reasoning in a think block, tags split<br/>over deltas, finish_reason and DONE, only an error code kept,<br/>size limit, splitReasoning, splitStreamingText"]
        nvclient["chat-runner.test.mjs<br/>runAnswer asks the next model only while nothing was answered,<br/>every call is an attempt the wheel hears, a paused answer is<br/>sent back with its content and merged into one answer,<br/>continuations capped, merged citations shifted"]
        cexport["chat-export.test.mjs<br/>chatToJson schema starpi.chat/v1 without internal fields,<br/>chatToMarkdown with engine labels and closed code fences,<br/>exportFileName dated and safe"]
        codeb["code-blocks.test.mjs, jsdom<br/>one copy button per code block, idempotent,<br/>source-check blocks unchanged, clipboard copy<br/>without the trailing newline, selection fallback"]
    end

    subgraph gNv["NVIDIA proxy and catalog"]
        nvproxy["nvidia-proxy.test.mjs<br/>parseKeys, parseOrigins, the shared validation vectors,<br/>no catalog extra overrides a validated field, key router:<br/>round robin, failover on 429, 5xx, 408, network, timeouts and<br/>empty streams, cooldowns, 401 and 403 parked, 503 and 504,<br/>no failover on 4xx, a budget-shortened timeout parks nothing,<br/>deadline, client abort, keys logged by index; relayStream ends;<br/>handleChat guards in order, rate limit, SSE headers;<br/>handleModels; Vercel exports, 405, vercel.json timings"]
        nvcat["nvidia-catalog.test.mjs<br/>unique ids with the default, frozen, the proxy answers<br/>before the browser gives up, normalizeNvidiaModel,<br/>publicCatalog without upstream extras, README T4 table<br/>matches the catalog,<br/>gitleaks rule finds plain and escaped keys,<br/>no NVIDIA key in any tracked file"]
    end

    subgraph gBuild["Build scripts and type checking"]
        bver["build-version.test.mjs<br/>buildVersion is 12 hex chars, stable under reordering,<br/>changes with a public file, the page, an asset URL<br/>or the service worker template"]
        skey["supabase-key.test.mjs<br/>assertPublicKey accepts sb_publishable_ keys and anon JWTs,<br/>refuses sb_secret_ keys, service_role JWTs,<br/>other strings and the empty string"]
        tcov["typecheck-coverage.test.mjs<br/>every src/js module that starts with the @ts-check comment<br/>is in the include list of tsconfig.json,<br/>more than 30 such modules, and every server module under api/"]
        sbomt["sbom.test.mjs, helpers from scripts/lib/sbom.mjs<br/>uuidV5 against the RFC 9562 example, duplicate bom-refs<br/>merged, root and workspace named by package, serial from<br/>the content, validator catches dangling edges, scripts/sbom.mjs<br/>twice gives identical files, @starpi/core lists no component"]
    end

    subgraph gDocs["Documentation"]
        docs["docs.test.mjs, helpers from scripts/markdown.mjs<br/>every mermaid block in docs/ARCHITECTURE.md has a unique<br/>diagram id marker, other Markdown files embed a diagram<br/>only as an exact copy under the same marker,<br/>relative links in every Markdown file resolve to existing files<br/>and their #anchors to existing headings,<br/>helper tests: backtick and tilde fences, link targets,<br/>GitHub heading anchors"]
    end

    runner --> render
    runner --> config
    runner --> actions
    runner --> i18n
    runner --> parser
    runner --> chunker
    runner --> bm25
    runner --> retrieval
    runner --> synth
    runner --> prompts
    runner --> models
    runner --> device
    runner --> choices
    runner --> wasmcat
    runner --> diag
    runner --> cstream
    runner --> nvclient
    runner --> cexport
    runner --> codeb
    runner --> nvproxy
    runner --> nvcat
    runner --> bver
    runner --> skey
    runner --> tcov
    runner --> sbomt
    runner --> docs
```

<sub>Sources: [`tests/unit/render.test.mjs`](../tests/unit/render.test.mjs), [`tests/unit/config.test.mjs`](../tests/unit/config.test.mjs), [`tests/unit/setup.mjs`](../tests/unit/setup.mjs), [`tests/unit/actions.test.mjs`](../tests/unit/actions.test.mjs), [`tests/unit/i18n.test.mjs`](../tests/unit/i18n.test.mjs), [`src/js/core/grounding.js`](../src/js/core/grounding.js), [`tests/unit/parser.test.mjs`](../tests/unit/parser.test.mjs), [`tests/unit/chunker.test.mjs`](../tests/unit/chunker.test.mjs), [`tests/unit/bm25.test.mjs`](../tests/unit/bm25.test.mjs), [`tests/unit/retrieval.test.mjs`](../tests/unit/retrieval.test.mjs), [`tests/unit/synthesizer.test.mjs`](../tests/unit/synthesizer.test.mjs), [`tests/unit/prompts.test.mjs`](../tests/unit/prompts.test.mjs), [`tests/unit/models.test.mjs`](../tests/unit/models.test.mjs), [`tests/unit/device.test.mjs`](../tests/unit/device.test.mjs), [`tests/unit/choices.test.mjs`](../tests/unit/choices.test.mjs), [`tests/unit/wasm-catalog.test.mjs`](../tests/unit/wasm-catalog.test.mjs), [`tests/unit/diagnostics.test.mjs`](../tests/unit/diagnostics.test.mjs), [`tests/unit/chat-stream.test.mjs`](../tests/unit/chat-stream.test.mjs), [`tests/unit/chat-runner.test.mjs`](../tests/unit/chat-runner.test.mjs), [`tests/unit/chat-export.test.mjs`](../tests/unit/chat-export.test.mjs), [`tests/unit/code-blocks.test.mjs`](../tests/unit/code-blocks.test.mjs), [`tests/unit/nvidia-proxy.test.mjs`](../tests/unit/nvidia-proxy.test.mjs), [`tests/unit/nvidia-catalog.test.mjs`](../tests/unit/nvidia-catalog.test.mjs), [`backend/test_fixtures/nvidia_validation.json`](../backend/test_fixtures/nvidia_validation.json), [`tests/unit/build-version.test.mjs`](../tests/unit/build-version.test.mjs), [`tests/unit/supabase-key.test.mjs`](../tests/unit/supabase-key.test.mjs), [`tests/unit/typecheck-coverage.test.mjs`](../tests/unit/typecheck-coverage.test.mjs), [`tests/unit/sbom.test.mjs`](../tests/unit/sbom.test.mjs), [`scripts/lib/sbom.mjs`](../scripts/lib/sbom.mjs), [`tests/fixtures/pdf.mjs`](../tests/fixtures/pdf.mjs), [`package.json`](../package.json), [`tests/unit/docs.test.mjs`](../tests/unit/docs.test.mjs), [`scripts/markdown.mjs`](../scripts/markdown.mjs)</sub>

### Unit tests for the source check, receipts and sample files

Twelve of the unit test files cover the source check, answer receipts, starpi-ground, the sample files and the @starpi/core package. The source check tests pin how facts are read (numbers, dates, times, weekdays, codes, version numbers, spelled numbers, quotations) and how each statement is compared with the excerpts it cites, including in rendered answers; grounding-v2.test.mjs pins the version 2 checks of negations, names and values in another place and that version 1 still gives its old verdicts. The evaluation test fails when a rule change makes a published result on the labelled answers worse, for either rules version: more faithful statements flagged, or fewer planted errors flagged in any category. None of this shows that an answer is correct: the check only compares values and wording with the cited excerpts. The receipt tests cover building, validating and verifying receipts of both formats (including members and reason codes a format does not define, and a partly delivered excerpt recomputed on its delivered part), the Merkle tree against the RFC 6962 test vectors, Ed25519 and ES256 signatures, the exit codes of verify-receipt.mjs, the receipt written by Starpi 1.3.0 and the two JSON Schemas in docs/spec, and the golden test pins extraction, chunking and source-check output, including every verdict and reason of version 1 on the 308 labelled answers and of version 2 on every answer set, to the rule versions that receipts record. ground.test.mjs covers checkDocument, the SARIF output and starpi-ground, the demo test answers each sample question from the sample files and requires the answer to pass the source check without a flagged statement, and the core-package test builds and uses the package the way a consumer would.

<!-- diagram: test-strategy-unit-trust -->
```mermaid
flowchart LR
    runner(["same npm test run, 12 of the 38 files"])

    subgraph gCheck["Source check"]
        facts["facts.test.mjs<br/>parseNumber with English and German separators,<br/>extractFacts: numbers with scale words, percent and currency,<br/>approximations, ISO, German and English dates, times,<br/>weekdays, codes, numbers written as words, also right after and,<br/>quotations, indexSource and lookupFact across formats<br/>and languages, 4.05. read as a decimal and as a date,<br/>codes with or without a hyphen, typographic dashes in codes,<br/>folding and inflection"]
        grounding["grounding.test.mjs<br/>sentences with offsets, German day.month dates kept inside,<br/>groundAnswer: supported statements,<br/>changed numbers, dates, weekdays and codes named,<br/>citation inheritance, facts elsewhere or in no excerpt,<br/>facts from the question, approximations, unknown labels,<br/>bad labels on a Sources line, English times such as 10.00 am,<br/>excerpts that did not reach the model, names missing,<br/>a name only in the question: from_conversation,<br/>a value next to other words: fact_context,<br/>size limit, contextCoverage, resolveLabel"]
        gv2["grounding-v2.test.mjs<br/>GROUNDING starpi-grounding 2, GROUNDING_VERSIONS 1 and 2,<br/>version 3 throws; negations dropped, added or reversed in<br/>English and German: negation_inversion, always weak, none for<br/>negations written differently, time conditions, ranges,<br/>restrictions, questions or clauses with other numbers;<br/>a name the excerpt has in another place: name_context,<br/>not for titles, genitives, hyphenated names, names from<br/>the question or a statement joining two passages, the same<br/>whatever other excerpts were given; values next to other<br/>words: fact_context; version numbers read as codes;<br/>version 1 verdicts unchanged; receipts recompute both<br/>versions, format v1 refuses the version 2 reason codes"]
        gview["grounding-view.test.mjs, jsdom<br/>blocks from rendered paragraphs, lists and tables, code skipped,<br/>items of a loose list inherit the lead-in's citations,<br/>summary bar, only the flagged citation button marked<br/>with aria-describedby, neutral grounding-none bar with<br/>the shield icon when nothing was compared,<br/>works without the CSS Custom Highlight API,<br/>extractive answers never flagged"]
        seval["source-check-eval.test.mjs, rules versions 1 and 2<br/>on sets dev, holdout and paraphrases, version 2 also on v2dev<br/>and v2holdout, the held-out file checked against its SHA-256:<br/>no statement of a faithful answer unsupported, faithful<br/>statements marked weak at most as published, version 2:<br/>0 in dev and v2dev, 16 in holdout, 8 in v2holdout,<br/>27 in paraphrases; per category at least the published<br/>number of planted errors marked weak or unsupported,<br/>e.g. version 2 negation 24 in v2dev and 16 in v2holdout;<br/>in dev and holdout every date, time and weekday error unsupported"]
    end

    subgraph gReceipt["Receipts and pinned rules"]
        receipt["receipt.test.mjs<br/>SHA-256 over UTF-8, canonical JSON, fingerprints,<br/>offsets, verdicts, id over the rest, optional texts left out,<br/>validateReceipt rejections incl. unknown members and reason codes,<br/>verifyReceipt: passages reproduced, missing or modified file,<br/>edited receipt, changed chunking rules, a partly delivered<br/>excerpt recomputed on its deliveredChars, skipped without them,<br/>reason passages left out with the excerpts,<br/>over 20 reasons (20 kept), a long statement<br/>and a long title still give a valid receipt,<br/>verify-receipt.mjs exit codes 0, 1 and 2,<br/>docs/spec/receipt.schema.json for v1 and receipt-v2.schema.json<br/>for v2 accept the receipts built in their format and reject<br/>what validateReceipt rejects, their reason codes equal<br/>REASON_CODES_V1 and REASON_CODES, the v2 schema<br/>describes signed receipts of both algorithms"]
        rv2["receipt-v2.test.mjs<br/>v2 by default: a root over one leaf per citation and<br/>a proof in each, one citation checked against the root alone,<br/>the same root without excerpt texts and question, v1 on request,<br/>verifyReceipt reports the root, the proofs and an edited citation;<br/>Ed25519 and ES256: valid with the embedded key, trusted with<br/>the signer's key as CryptoKey, JWK or PEM, also checked<br/>with node:crypto, every edit after signing invalid, a re-signed<br/>receipt key_mismatch for the signer's key; malformed trees,<br/>proofs and signatures and v2 members in v1 refused;<br/>the receipt of Starpi 1.3.0 still verifies; verify-receipt.mjs<br/>with --public-key: exit 0, 1 and 2"]
        merkle["merkle.test.mjs<br/>Certificate Transparency test vectors, root and every<br/>audit path equal to an independent implementation<br/>for 0 to 64 leaves, a proof for another leaf, position,<br/>size or root, or a changed path, rejected;<br/>hex and base64url encoded canonically"]
        golden["golden.test.mjs<br/>SHA-256 pins of extracted text and chunk bounds,<br/>verdicts on a fixed answer, SHA-256 of the verdicts and<br/>reasons of version 1 for all 308 labelled answers and<br/>of version 2 for the 2930 statements of every answer set,<br/>per EXTRACTOR, CHUNKER and GROUNDING version:<br/>changed output needs a version bump"]
    end

    subgraph gDemo["Documents, sample files and the package"]
        ground["ground.test.mjs<br/>checkDocument: line and column of every statement,<br/>labels or every excerpt, a long document split at headings<br/>with the Sources line in each part, an oversized paragraph<br/>reported as not checked; SARIF: a rule per reason code worded<br/>like en.json, one result per statement to review, fingerprints<br/>that survive a moved line; starpi-ground: a directory read<br/>like the app, --fail-on, labels, SARIF to a file, exit 2 on<br/>bad arguments, escaped control characters"]
        demo["demo.test.mjs<br/>English and German sample files match the list in demo.js,<br/>the sample questions launch, budget and risks find their facts,<br/>the extractive answer has at least 2 supported and<br/>no weak or unsupported statements"]
        core["core-package.test.mjs<br/>build-core.mjs into a temp dir with --no-types, both commands,<br/>exports equal packages/core/src/index.js, only pdfjs-dist imported,<br/>the bundle checks an answer and builds a valid receipt,<br/>the bundled verify-receipt.js reproduces it with a valid tree,<br/>the bundled ground.js writes SARIF and exits 1, or 2 without<br/>arguments, package.json name, exports, both bins, no dependencies<br/>of any kind, files cover every entry point, publishConfig public,<br/>workspace of the root, same version as the app<br/>and in the lockfile, pdfjs-dist peer major as the app's"]
    end

    runner --> facts
    runner --> grounding
    runner --> gv2
    runner --> gview
    runner --> seval
    runner --> receipt
    runner --> rv2
    runner --> merkle
    runner --> golden
    runner --> ground
    runner --> demo
    runner --> core
```

<sub>Sources: [`tests/unit/facts.test.mjs`](../tests/unit/facts.test.mjs), [`tests/unit/grounding.test.mjs`](../tests/unit/grounding.test.mjs), [`tests/unit/grounding-v2.test.mjs`](../tests/unit/grounding-v2.test.mjs), [`tests/unit/grounding-view.test.mjs`](../tests/unit/grounding-view.test.mjs), [`tests/unit/source-check-eval.test.mjs`](../tests/unit/source-check-eval.test.mjs), [`tests/unit/receipt.test.mjs`](../tests/unit/receipt.test.mjs), [`tests/unit/receipt-v2.test.mjs`](../tests/unit/receipt-v2.test.mjs), [`tests/unit/merkle.test.mjs`](../tests/unit/merkle.test.mjs), [`tests/unit/golden.test.mjs`](../tests/unit/golden.test.mjs), [`tests/unit/ground.test.mjs`](../tests/unit/ground.test.mjs), [`tests/unit/demo.test.mjs`](../tests/unit/demo.test.mjs), [`tests/unit/core-package.test.mjs`](../tests/unit/core-package.test.mjs), [`scripts/eval-source-check.mjs`](../scripts/eval-source-check.mjs), [`tests/fixtures/grounding/eval.json`](../tests/fixtures/grounding/eval.json), [`tests/fixtures/receipts/v1.3.0-receipt.json`](../tests/fixtures/receipts/v1.3.0-receipt.json), [`docs/spec/receipt.schema.json`](../docs/spec/receipt.schema.json), [`docs/spec/receipt-v2.schema.json`](../docs/spec/receipt-v2.schema.json), [`src/js/demo.js`](../src/js/demo.js)</sub>

### End-to-end tests with mocked Supabase and diagnostics

Playwright serves the built dist/ through scripts/serve.mjs on STARPI_E2E_PORT (default 4173) without --functions, which applies the vercel.json headers to every path, and runs app.spec.mjs (17 tests), trust.spec.mjs (13 tests), models.spec.mjs (8 tests), modes.spec.mjs (8 tests) and the Mermaid render gate on a desktop and a mobile Chromium project, 94 test runs in all. mockSupabase answers every *.supabase.co request with two independent flags, hardened (otherwise a pre-migration project) and anonymousAuth, reports through auth/v1/settings whether anonymous sign-ins are on, and seeds a document with hostile markup; mockNvidia stands in for Starpi's NVIDIA proxy on /api/models/nvidia and /api/chat/nvidia with the published catalog, streamed answers in the proxy's SSE form or a given error, and records each request body and its Authorization header, which must be absent; without it the server answers 404, which the app reads as no proxy. The diagnostics fixture fails a test on any CSP violation, page error, unexpected console error or request to a host other than 127.0.0.1 and the mocked Supabase, so no test reaches NVIDIA or downloads a model. The workspace tests check that a question answered from workspace files or about an attached file stays in localStorage with its answer while chats sync, that a citation made before Clear workspace never opens a file added afterwards, and that a batch reports every file, refuses the same file twice and renames a different file with the same name. Two settings tests check that the save dialog confirms only what the browser stored, an offline-start test checks that the app reconnects on the online event and then syncs chats, and three tests without WebGPU check that a WebGPU preset is refused with a reason, that the processor model offered instead downloads nothing without consent, and that the diagnostics report the missing support. models.spec.mjs emulates a desktop with or without a WebGPU adapter and checks the picker groups, the recommendation, the T3 warning, the WASM fallback and the 2.0 migration, the settings mirror with badges in both languages, the NVIDIA group per proxy state, the refusal to switch during an answer and the settling of arrow keys. modes.spec.mjs checks the chat mode toggle, free chat with code copy and history, an attached file sent once and never as history, the chat export and delete, and NVIDIA answers in both modes, including a receipt with engine nvidia, the fallback when the proxy has no keys and a rate-limit notice without server text. docs-diagrams.spec.mjs renders every Mermaid block in the repository Markdown with mermaid 12.1.0, skipped on the mobile project.

<!-- diagram: test-strategy-e2e -->
```mermaid
flowchart TD
    job(["CI job e2e: npm run test:e2e<br/>against the dist artifact from job frontend"])
    cfg["playwright.config.mjs: testDir tests/e2e, timeout 45 s, retries 0,<br/>forbidOnly in CI, serviceWorkers block, trace retain-on-failure,<br/>port STARPI_E2E_PORT, default 4173"]
    serve["webServer: node scripts/serve.mjs --port on 127.0.0.1,<br/>without --functions: /api/* gives 404 unless mocked,<br/>serves dist/ with the vercel.json headers on every path,<br/>so pages and workers run under the real CSP"]
    desk["project desktop-chromium<br/>Desktop Chrome, 1280 x 800"]
    mob["project mobile-chromium<br/>Pixel 7"]
    job --> cfg
    cfg --> serve
    cfg --> desk
    cfg --> mob

    subgraph fx["tests/e2e/fixtures.mjs"]
        mock["mockSupabase with hardened and anonymousAuth flags<br/>routes *.supabase.co: auth/v1/settings with anonymous_users,<br/>signup, knowledge_documents, sections, rpc/search_knowledge,<br/>entities, relations, chat_history, any other path 404 PGRST000<br/>not hardened: 42703 on is_public, PGRST202, PGRST205<br/>no anonymous auth: signup 422 anonymous_provider_disabled<br/>MALICIOUS_DOC and its section: img onerror, script, onmouseover,<br/>javascript: link, remote beacon image"]
        mocknv["mockNvidia: GET /api/models/nvidia with publicCatalog,<br/>configured or not, POST /api/chat/nvidia as an SSE stream<br/>of reasoning and content deltas, or a given error,<br/>records bodies and the Authorization header<br/>useNvidia: stored mode nvidia and a model"]
        diagx["diagnostics fixture<br/>securitypolicyviolation logged as CSP_VIOLATION,<br/>pageerror and console.error collected, 4xx resource logs ignored,<br/>requests outside 127.0.0.1 and *.supabase.co aborted and recorded,<br/>the test fails unless the list is empty"]
    end

    subgraph app["app.spec.mjs, 17 tests, both projects"]
        direction LR
        s1["Migration pending, anonymous sign-ins disabled:<br/>CSP and nosniff on index.html, sw.js, manifest and a script,<br/>hashed assets immutable, Migration pending badge,<br/>answer without a model, with a citation, This device only,<br/>no chat_history requests, no emoji, icons aria-hidden"]
        s2["Hostile database content: card shows the markup as text,<br/>no img and no javascript: link in the modal, window.__xss undefined"]
        s3["Graph tables missing: honest empty state"]
        s4["Own server http://evil.example/v1 rejected,<br/>starpi_llm_url not stored"]
        sSave["Saving settings, 2 tests: own server http://127.0.0.1:11434/v1,<br/>dialog Settings saved. and starpi_llm_url stored,<br/>Storage.setItem throwing: dialog Some settings could not be saved"]
        s5["Hardened schema: two chat_history POSTs with<br/>Bearer test-access-token, no owner_id in the body,<br/>search_knowledge RPC used"]
        sOff["Offline start: *.supabase.co aborted as internetdisconnected,<br/>badge Offline, online event, badge Live,<br/>then question and answer give two chat_history POSTs,<br/>net::ERR_INTERNET_DISCONNECTED console errors required,<br/>removed, then no other diagnostics"]
        s6["No WebGPU, 3 tests: webgpu:llama-1b marked needs WebGPU,<br/>picked anyway: on-device mode explained, question ranked<br/>in the browser, no search RPC or chat POST; the recommended<br/>wasm: model asks once with the 15 MB runtime, declined:<br/>nothing loads, answer quoted; benchmark shows WebGPU not supported"]
        s7["i18n: English default, German without a reload,<br/>German kept after reload, starpi_locale stored"]
        s8["Workspace: notes.md and a makePdf plan.pdf indexed in the worker,<br/>1 page and 1 chunk, BM25 scores, cited answer opens the drawer<br/>on the chunk, file text never sent to Supabase,<br/>question and answer kept in starpi_local_chats_v1,<br/>no chat_history POST although chats sync"]
        s9["Attached orion-roadmap.md while chats sync:<br/>question and answer kept in starpi_local_chats_v1,<br/>no chat_history POST"]
        s10["Citation of alpha.md, Clear workspace, beta.md added:<br/>the old citation shows the file-missing note<br/>and its own excerpt, never the new file"]
        sBatch["Batch of photo.png and notes.md: both reported,<br/>the same notes.md again: already in the workspace,<br/>same name with other text: listed as notes (2).md"]
        s11["Unsupported photo.png rejected with a clear message"]
    end

    subgraph models["models.spec.mjs, 8 tests, both projects"]
        direction LR
        m1["8 GB desktop with WebGPU: Recommended for your device<br/>first with webgpu:qwen-3b, recommended, mode stays council,<br/>a WASM pick asks once, declined, stored as the choice"]
        m2["T3 gemma-9b: needs a strong GPU, the confirm<br/>starts with the free GPU memory warning"]
        m3["no WebGPU: a wasm: model recommended,<br/>webgpu:qwen-1.5b marked needs WebGPU,<br/>stored 2.0 value qwen-1.5b migrated"]
        m4["settings picker mirrors the header, its own labels,<br/>badges WebGPU with f16, 8 GB RAM, desktop,<br/>German group labels and option text after a switch"]
        m5["NVIDIA proxy with keys: offered models in their group,<br/>the default in Recommended, every value once,<br/>a pick stores mode nvidia and the model"]
        m6["no proxy: 404, NVIDIA group hidden, a stored<br/>NVIDIA model shown disabled, status line says so"]
        m7["switch refused with models.switch_busy while<br/>an answer streams, the picker shows the stored choice"]
        m8["arrow keys: applied once they rest,<br/>not at every step"]
    end

    subgraph modes["modes.spec.mjs, 8 tests, both projects"]
        direction LR
        c1["toggle: grounded by default, free remembered across<br/>reloads, placeholder and privacy notice follow,<br/>German labels, a quick prompt switches back to grounded"]
        c2["free chat with a mocked OpenRouter: code block<br/>with Copy and Copied, free note, no source check or receipt,<br/>history sent, no search_knowledge request"]
        c3["free chat with an attached file: fenced as FILE once,<br/>never resent as history, nothing synced"]
        c4["chat menu: Markdown and JSON export starpi.chat/v1,<br/>Delete this chat removes the session from<br/>chat_history and this browser"]
        c5["NVIDIA free chat: streamed answer, reasoning only in the<br/>details, model, messages, max_tokens and temperature 0.7 only,<br/>no Authorization header, history without the reasoning"]
        c6["NVIDIA source mode: excerpts sent at temperature 0.2,<br/>source check ok, receipt with answer.engine nvidia"]
        c7["proxy without keys: notice not set up,<br/>answer quoted from the sources, no chat request"]
        c8["429 with Retry-After 7: please wait 7 s,<br/>server text never shown"]
    end

    trust["trust.spec.mjs, 13 tests, both projects:<br/>sample files, source check, receipts, privacy,<br/>session without sign-in, axe scan and keyboard,<br/>see the next diagram"]

    docs["docs-diagrams.spec.mjs, skipped on the mobile project<br/>every mermaid block in repository Markdown parses and renders<br/>with the pinned mermaid 12.1.0, securityLevel strict,<br/>in a blank page via setContent: no app page, no diagnostics fixture"]

    serve --> app
    serve --> models
    serve --> modes
    serve --> trust
    desk --> app
    mob --> app
    desk --> models
    mob --> models
    desk --> modes
    mob --> modes
    desk --> trust
    mob --> trust
    desk --> docs
    mock -->|"per test: mockSupabase"| app
    mock -->|"per test"| models
    mock -->|"per test"| modes
    mock -->|"every test: hardened"| trust
    mocknv -->|"NVIDIA tests"| models
    mocknv -->|"NVIDIA tests"| modes
    diagx -->|"every test"| app
    diagx -->|"every test"| models
    diagx -->|"every test"| modes
    diagx -->|"every test"| trust
```

<sub>Sources: [`playwright.config.mjs`](../playwright.config.mjs), [`tests/e2e/fixtures.mjs`](../tests/e2e/fixtures.mjs), [`tests/e2e/app.spec.mjs`](../tests/e2e/app.spec.mjs), [`tests/e2e/models.spec.mjs`](../tests/e2e/models.spec.mjs), [`tests/e2e/modes.spec.mjs`](../tests/e2e/modes.spec.mjs), [`tests/e2e/trust.spec.mjs`](../tests/e2e/trust.spec.mjs), [`tests/e2e/docs-diagrams.spec.mjs`](../tests/e2e/docs-diagrams.spec.mjs), [`tests/fixtures/pdf.mjs`](../tests/fixtures/pdf.mjs), [`scripts/serve.mjs`](../scripts/serve.mjs), [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)</sub>

### End-to-end tests for the source check, receipts and accessibility

trust.spec.mjs runs 13 tests on both projects, each with a hardened mockSupabase and the diagnostics fixture. Model answers come from routes for the Gemini and OpenRouter APIs that the spec registers after the diagnostics route; Playwright tries later routes first, so these two hosts are answered instead of aborted. The tests load the sample files in one click and require a sample answer to pass the source check, show the check flagging the deliberate error of the demo, and check that a mocked model answer with a changed number and weekday gets both named, that one which reverses its excerpt and puts a name where the excerpt has another one gets both reasons as weak, without a flagged chip, and that the same facts in German formats pass. Three chat tests cover a question that starts with a greeting, a wide table that must not scroll the conversation sideways, and a message box that grows with multi-line input. They download a starpi.receipt/v2 receipt whose file fingerprint equals the SHA-256 of the file and whose Merkle root the dialog previews, verify it in the dialog against the original (Merkle root and proofs valid, not signed), sign it outside the app with ES256 and check it with the signer's public key and with another key, verify it against a changed copy, keep a turn about an attached file out of the history sent to a cloud provider, and show the published knowledge without a browser session. An axe scan of six views must find no serious or critical violation, and a keyboard test checks that the attach button is two Shift+Tab presses from the message box, that focus stays inside the open citation drawer and that Escape returns it to the citation chip.

<!-- diagram: test-strategy-e2e-trust -->
```mermaid
flowchart TD
    run(["trust.spec.mjs: 13 tests on desktop-chromium and mobile-chromium,<br/>mockSupabase hardened, diagnostics fixture on every test"])

    subgraph mocks["model mocks in the spec"]
        gem["mockGemini: starpi_gemini_key in sessionStorage,<br/>generativelanguage.googleapis.com answers a fixed text"]
        orr["starpi_openrouter_key in sessionStorage,<br/>openrouter.ai answers Noted. and records each body"]
    end

    subgraph sSamples["sample files, 2 tests"]
        t1["load-samples, Sample files ready within 20 s,<br/>sample budget question: 480,000 EUR, bar grounding-ok,<br/>N/N statements match their cited excerpts, no flagged chip,<br/>no knowledge-base title in the answer"]
        t2["demo-check: deliberate error, bar grounding-review and open,<br/>2/3 statements match, 520,000 is not in the nebula-plan.md label,<br/>one flagged chip, one range in CSS.highlights starpi-review"]
    end

    subgraph sChat["chat, 3 tests"]
        t3["greeting plus question on the samples:<br/>480,000 EUR, bar grounding-ok"]
        t4["mocked Gemini table with 8 columns:<br/>chatMessages scrolls sideways by at most 1 px"]
        t5["four-line question: the message box<br/>grows by more than 30 px"]
    end

    subgraph sCheck["source check on model answers, 3 tests"]
        t6["attached budget.md, mocked answer with 520,000 EUR and Friday:<br/>1/3 statements match, 520,000 and Friday each named<br/>as not in the budget.md label, 2 flagged chips"]
        t6b["attached spec.md, mocked answer: Power over Ethernet<br/>is supported, Marcus Hale owns the specification,<br/>Port 8443 serves the admin interface: 1/3 statements match,<br/>the spec.md label says the opposite and names someone<br/>or something else here, not Marcus Hale, badge 2 partly,<br/>no flagged chip"]
        t7["mocked German answer with 480.000 € and<br/>dienstags um 10:00 Uhr: bar grounding-ok, 2/2 statements"]
    end

    subgraph sReceipt["answer receipts, 1 test"]
        t8["open-receipt shows 1 workspace, download receipt.json:<br/>schema starpi.receipt/v2, fileSha256 equals<br/>the SHA-256 of budget.md, receiptRoot shows<br/>the first 16 hex chars of merkle.root"]
        t9["verify in the dialog with receiptFile and receiptSources:<br/>1/1 workspace excerpts reproduced from your files,<br/>exact passage found in budget.md, Merkle root reproduced,<br/>2/2 inclusion proofs valid, Not signed."]
        t9b["signReceipt in the test with a new ECDSA P-256 key,<br/>its public JWK chosen in receiptPublicKey: signed with<br/>the public key you chose, ES256 and the key id,<br/>another key's JWK: not with the public key you chose"]
        t10["key cleared, the unsigned receipt again,<br/>480,000 changed to 520,000 in the file:<br/>none of the chosen files has the recorded fingerprint,<br/>Escape closes, focus back on open-receipt"]
        t8 --> t9 --> t9b --> t10
    end

    subgraph sPriv["privacy and session, 2 tests"]
        t11["OpenRouter: after a turn on the attached salary.md,<br/>the second request's messages contain<br/>neither Jane Roe nor 187,500"]
        t12["anonymous sign-ins off: badge Public knowledge,<br/>auth/v1/settings read, no auth/v1/signup request,<br/>Published documents, ingestBtn disabled, session note shown"]
    end

    subgraph sA11y["accessibility, 2 tests"]
        t13["axe with wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa<br/>on chat, library, graph, ingest, bench and settings<br/>after demo-check: no serious or critical violation"]
        t14["two Shift+Tab from chatInput reach pick-chat-file,<br/>4 Tab presses stay inside citationModal,<br/>Escape returns focus to the citation chip"]
    end

    run --> sSamples
    run --> sChat
    run --> sCheck
    run --> sReceipt
    run --> sPriv
    run --> sA11y
    gem -.-> t4
    gem -.-> sCheck
    orr -.-> t11
```

<sub>Sources: [`tests/e2e/trust.spec.mjs`](../tests/e2e/trust.spec.mjs), [`tests/e2e/fixtures.mjs`](../tests/e2e/fixtures.mjs), [`playwright.config.mjs`](../playwright.config.mjs), [`package.json`](../package.json), [`src/js/core/receipt.js`](../src/js/core/receipt.js), [`src/js/rag/receipts.js`](../src/js/rag/receipts.js), [`src/locales/en.json`](../src/locales/en.json)</sub>

### CI workflow triggers, jobs and Dependabot

The CI workflow runs on pushes and pull requests to main (the default branch) and on manual dispatch, with read-only contents permission and one concurrency group per PR or ref that cancels older runs. Five jobs start in parallel: frontend, the backend matrix (the library publisher on Python 3.11 and 3.13), database, audit and secrets. e2e runs only after frontend succeeds, because it needs the dist artifact that frontend uploads, and besides the app, trust, models and modes specs it renders every Mermaid block in the repository's Markdown. Every completed CI run on main starts the separate Release workflow, whose jobs only run when that CI run passed and was triggered by a push; the Release workflow can also be dispatched by hand, and then its jobs run only on main. Dependabot opens weekly update PRs for npm (dev dependencies grouped, Tailwind majors ignored), pip in /tools/library-publisher and GitHub Actions, and those PRs go through the same workflow.

<!-- diagram: ci-workflow-overview -->
```mermaid
flowchart TD
    subgraph sg_dependabot["dependabot.yml: weekly update PRs"]
      D1["npm at /: at most 5 open PRs,<br/>development deps grouped as dev-tooling,<br/>tailwindcss major updates ignored"]
      D2["pip at /tools/library-publisher: at most 3 open PRs"]
      D3["github-actions at /: at most 3 open PRs"]
    end
    subgraph sg_on["CI workflow triggers"]
      T1(["push to main"])
      T2(["pull_request to main"])
      T3(["workflow_dispatch"])
    end
    sg_dependabot -->|"update PRs against main,<br/>the default branch"| T2
    sg_on --> CFG["permissions: contents read<br/>concurrency group ci-(workflow)-(PR number or ref),<br/>cancel-in-progress: a newer run cancels the older one"]
    CFG --> FE["frontend: Frontend (lint, typecheck, unit tests, build)<br/>15 min, packs @starpi/core as a dry run,<br/>uploads the dist artifact"]
    CFG --> BE["backend: Library publisher (Python 3.11) and (Python 3.13)<br/>10 min, matrix with fail-fast false"]
    CFG --> DB["database: Database migration and RLS tests<br/>(PostgreSQL 16 + pgvector), 15 min"]
    CFG --> AUD["audit: Dependency audit (npm audit, pip-audit)<br/>10 min, Node 22 and Python 3.12,<br/>uploads the CycloneDX SBOMs as artifact sbom"]
    CFG --> SEC["secrets: Secret scanning (gitleaks)<br/>5 min, gitleaks 8.30.1"]
    FE -->|"needs: frontend succeeded"| E2E["e2e: End-to-end (Playwright, production headers)<br/>20 min, app, trust, models and modes specs plus<br/>rendering of every Mermaid block in the Markdown files"]
    FE -->|"frontend failed"| SKIP["e2e is skipped"]
    FE --> RES{"every job succeeded?"}
    E2E --> RES
    BE --> RES
    DB --> RES
    AUD --> RES
    SEC --> RES
    SKIP --> RES
    RES -->|"yes"| GREEN(["CI run passes"])
    RES -->|"no: a step exited non-zero<br/>or a job hit its timeout"| RED(["CI run fails"])
    GREEN -->|"run triggered by a push to main"| REL["release.yml via workflow_run, started by every<br/>completed CI run on main, its jobs run only here<br/>or on a manual dispatch on main:<br/>GitHub release for the package.json version<br/>with the @starpi/core tarball, SBOMs and SHA256SUMS"]
    NOTE["every job: ubuntu-24.04, actions pinned by commit SHA,<br/>checkout with persist-credentials false"]
    CFG -.- NOTE
```

<sub>Sources: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), [`.github/workflows/release.yml`](../.github/workflows/release.yml), [`.github/dependabot.yml`](../.github/dependabot.yml), [`tests/e2e/trust.spec.mjs`](../tests/e2e/trust.spec.mjs), [`tests/e2e/docs-diagrams.spec.mjs`](../tests/e2e/docs-diagrams.spec.mjs)</sub>

### Frontend and end-to-end jobs

The frontend job installs from the lockfile without install scripts, then runs lint, typecheck, the 38 unit test files, pack:core (a typed build of @starpi/core and npm pack --dry-run, so a broken type declaration or package file list fails the pull request, not the release), the production build and verify:dist, and uploads dist (kept 3 days, and the upload errors if there are no files); any failing step fails the job and skips e2e. e2e downloads that same dist, installs Chromium and runs Playwright against scripts/serve.mjs on port 4173 (STARPI_E2E_PORT can change it) without the NVIDIA functions, with service workers blocked, test.only forbidden on CI and no retries. Its specs exercise the app under the production headers (every response, workers included, carries the CSP) with a mocked Supabase, check the source check, receipts and accessibility with mocked model APIs and axe, the model pickers and the chat modes with a mocked NVIDIA proxy, and parse and render every Mermaid block in the Markdown files with mermaid 12.1.0, skipped on the mobile project. If any e2e step fails, playwright-report and test-results are uploaded for 7 days.

<!-- diagram: ci-frontend-e2e -->
```mermaid
flowchart TD
    subgraph sg_fe["frontend job: Frontend (lint, typecheck, unit tests, build)"]
      F1["actions/checkout v7.0.1, persist-credentials false"]
      F2["actions/setup-node v7.0.0: Node 22, npm cache"]
      F3["npm ci --ignore-scripts"]
      F4["npm run lint: eslint ."]
      F5["npm run typecheck: tsc -p tsconfig.json --noEmit"]
      F6["npm test: node --test tests/unit/*.test.mjs,<br/>38 files, 479 tests"]
      F6b["npm run pack:core: npm pack --workspace=@starpi/core<br/>--dry-run, prepack builds it with type declarations"]
      F7["npm run build: scripts/build.mjs"]
      F8["npm run verify:dist: CSP compatibility,<br/>assets, service worker and build version"]
      F9["actions/upload-artifact v7.0.1: dist,<br/>kept 3 days, if-no-files-found error"]
      F1 --> F2 --> F3 --> F4 --> F5 --> F6 --> F6b --> F7 --> F8 --> F9
    end
    sg_fe -->|"any step exits non-zero"| FEFAIL(["frontend fails, later steps skipped,<br/>e2e skipped"])
    F9 -->|"needs: frontend"| G1
    subgraph sg_e2e["e2e job: End-to-end (Playwright, production headers)"]
      G1["checkout, setup-node 22,<br/>npm ci --ignore-scripts"]
      G2["actions/download-artifact v8.0.1: dist into dist/"]
      G3["npx playwright install --with-deps chromium"]
      G4["npm run test:e2e: playwright test"]
      G1 --> G2 --> G3 --> G4
    end
    PWC["playwright.config.mjs: testDir tests/e2e,<br/>webServer node scripts/serve.mjs --port 4173<br/>or STARPI_E2E_PORT, without --functions,<br/>projects desktop-chromium and mobile-chromium,<br/>serviceWorkers block, forbidOnly on CI, retries 0,<br/>list + html reporter on CI, trace retain-on-failure"]
    G4 -.- PWC
    SPECS["app.spec.mjs: the app under the production CSP,<br/>with a mocked Supabase<br/>trust.spec.mjs: sample files, source check, receipts,<br/>privacy, axe scan via @axe-core/playwright<br/>models.spec.mjs and modes.spec.mjs: model pickers,<br/>chat modes, export, NVIDIA with a mocked proxy<br/>docs-diagrams.spec.mjs: every mermaid block in the<br/>Markdown files parses and renders with mermaid 12.1.0,<br/>skipped on mobile-chromium"]
    G4 -.- SPECS
    G4 -->|"all tests passed"| EOK(["e2e passes"])
    sg_e2e -->|"any step fails"| G5["if failure(): upload-artifact playwright-report<br/>with playwright-report/ and test-results/, kept 7 days"]
    G5 --> EFAIL(["e2e fails"])
```

<sub>Sources: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), [`package.json`](../package.json), [`playwright.config.mjs`](../playwright.config.mjs), [`scripts/serve.mjs`](../scripts/serve.mjs), [`tests/e2e/app.spec.mjs`](../tests/e2e/app.spec.mjs), [`tests/e2e/trust.spec.mjs`](../tests/e2e/trust.spec.mjs), [`tests/e2e/fixtures.mjs`](../tests/e2e/fixtures.mjs), [`tests/e2e/docs-diagrams.spec.mjs`](../tests/e2e/docs-diagrams.spec.mjs)</sub>

### Backend, database, audit and secret-scanning jobs

The backend job tests the library publisher once per Python version (3.11, 3.13) with fail-fast off: it installs tools/library-publisher/requirements-dev.txt (with the optional ONNX Runtime stack), runs ruff check, ruff format --check and a byte-compile over tools/library-publisher and backend, and the offline unittest suite of 76 tests in tools/library-publisher, any of which fails its leg. The database job installs PostgreSQL 16 with pgvector and runs run_rls_tests.sh, which starts a throwaway cluster, runs eight scenarios (five apply the schema or the four migration files and run rls_test.sql, while guard, guard_order and guard_vectors only require a file to refuse the database) plus a schema-parity diff, and exits 1 if any of them failed and 2 on a setup error; rls_test.sql has 220 checks in fresh and fresh_rerun and 227 in live, legacy_v2 and legacy_v1, which are seeded with legacy rows. The audit job needs no npm install: npm audit reads package-lock.json and fails on any advisory in a runtime dependency (--omit=dev --audit-level=low); a second npm audit over the whole tree at high severity only emits a warning annotation, because the advisories it can report are in build and test tooling that is not shipped in dist/. It then installs backend/requirements-dev.txt on Python 3.12, which includes the library publisher's requirements, and runs pip-audit, pinned there, over them; any advisory fails the job. Last, unless the run was cancelled, npm run sbom writes the CycloneDX SBOMs of the app and of @starpi/core from the lockfile, again without an npm install (scripts/sbom.mjs imports only Node built-ins and calls npm sbom --package-lock-only), checks them and uploads them as the sbom artifact for 30 days; an invalid document fails the job. The secrets job downloads gitleaks 8.30.1, verifies its pinned SHA-256, scans the working tree with the default rules plus the custom rule starpi-nvidia-api-key (NVIDIA keys, also with Markdown escapes), and on pull requests also scans the commits between the base and head SHAs. A failed download, a checksum mismatch or any leak fails the job.

<!-- diagram: ci-backend-database-secrets -->
```mermaid
flowchart TD
    subgraph sg_be["backend job, library publisher, once per Python 3.11 and 3.13"]
      B1["checkout, actions/setup-python v7.0.0 with pip cache<br/>keyed on tools/library-publisher/requirements*.txt"]
      B2["python -m pip install -r tools/library-publisher/requirements-dev.txt<br/>(httpx, numpy, onnxruntime, tokenizers,<br/>ruff 0.16.10 and pip-audit 2.10.1)"]
      B3["Lint: ruff check tools/library-publisher backend --no-cache"]
      B4["Lint: ruff format --check tools/library-publisher backend"]
      B5["python -m compileall -q tools/library-publisher backend"]
      B6["python -m unittest discover -v<br/>in tools/library-publisher, 76 tests,<br/>offline, httpx MockTransport, no model download"]
      B1 --> B2 --> B3 --> B4 --> B5 --> B6
    end
    sg_be -->|"install error, lint error, unformatted file,<br/>syntax error or failing test"| BFAIL(["that matrix leg fails,<br/>the other leg keeps running"])
    subgraph sg_db["database job"]
      D1["checkout"]
      D2["sudo apt-get update, then apt-get install<br/>postgresql-16 postgresql-16-pgvector"]
      D3["bash backend/supabase/tests/run_rls_tests.sh<br/>with PG_BIN=/usr/lib/postgresql/16/bin"]
      D4["throwaway cluster: initdb, pg_ctl start<br/>on a Unix socket, port 55432"]
      D5["scenarios live, fresh, fresh_rerun, legacy_v2,<br/>legacy_v1, guard, guard_order, the three<br/>migrations/*.sql files in file-name order,<br/>rls_test.sql 191 checks, 198 with legacy=true<br/>in live, legacy_v2 and legacy_v1,<br/>a failed scenario is counted and the rest still run"]
      D6["schema parity: pg_dump public schemas of<br/>live, fresh and fresh_rerun must be identical"]
      D1 --> D2 --> D3 --> D4 --> D5 --> D6
    end
    D2 -->|"apt error"| DFAIL(["database fails"])
    D6 --> DX{"run_rls_tests.sh exit code"}
    DX -->|"0: all scenarios and schema parity pass"| DOK(["database passes"])
    DX -->|"1: a scenario or schema parity failed"| DFAIL
    DX -->|"2: setup error, e.g. PG binaries or pgvector<br/>missing, no migrations, initdb or start failed"| DFAIL
    subgraph sg_audit["audit job"]
      A1["checkout, actions/setup-node v7.0.0: Node 22"]
      A2{"npm audit --omit=dev --audit-level=low<br/>reports an advisory in a runtime dependency?"}
      A3["npm audit --audit-level=high over the whole tree,<br/>a finding only emits a warning annotation"]
      A4["actions/setup-python v7.0.0: Python 3.12,<br/>pip install -r backend/requirements-dev.txt,<br/>which includes the publisher requirements"]
      A5{"pip-audit -r backend/requirements-dev.txt<br/>reports an advisory?"}
      A6{"if not cancelled: npm run sbom,<br/>npm sbom --package-lock-only, normalized,<br/>both documents valid?"}
      A7["actions/upload-artifact v7.0.1: sbom,<br/>kept 30 days, if-no-files-found error"]
      A1 --> A2
      A2 -->|"no"| A3 --> A4 --> A5
      A5 -->|"no"| A6
      A6 -->|"yes"| A7
    end
    A2 -->|"yes"| AFAIL(["audit fails"])
    A4 -->|"install error"| AFAIL
    A5 -->|"yes"| AFAIL
    A6 -->|"no"| AFAIL
    A7 --> AOK(["audit passes"])
    ANOTE["the SBOM steps also run after a failed audit step,<br/>the job still fails"]
    A6 -.- ANOTE
    subgraph sg_sec["secrets job"]
      S1["checkout with fetch-depth 0"]
      S2["curl -f the gitleaks 8.30.1 linux_x64 tarball<br/>into RUNNER_TEMP, under set -euo pipefail"]
      S3{"sha256sum -c matches<br/>the pinned checksum?"}
      S7["tar extracts the gitleaks binary"]
      S4{"gitleaks dir . --config .gitleaks.toml<br/>--redact --exit-code 1 finds a leak?"}
      S5{"event is pull_request?"}
      S6{"gitleaks git . with log-opts<br/>BASE_SHA..HEAD_SHA finds a leak?"}
      S1 --> S2 --> S3
      S3 -->|"yes"| S7 --> S4
      S4 -->|"no"| S5
      S5 -->|"yes"| S6
    end
    GL[".gitleaks.toml: default rules, custom rule<br/>starpi-nvidia-api-key for nvapi- keys, also escaped,<br/>allowlists for the public anon JWT and for<br/>generated paths such as dist/ and node_modules/"]
    S4 -.- GL
    S2 -->|"download fails"| SFAIL(["secrets fails"])
    S3 -->|"no"| SFAIL
    S4 -->|"yes"| SFAIL
    S6 -->|"yes"| SFAIL
    S5 -->|"no: push or workflow_dispatch"| SOK(["secrets passes"])
    S6 -->|"no"| SOK
```

<sub>Sources: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), [`backend/supabase/tests/run_rls_tests.sh`](../backend/supabase/tests/run_rls_tests.sh), [`backend/supabase/tests/rls_test.sql`](../backend/supabase/tests/rls_test.sql), [`backend/requirements-dev.txt`](../backend/requirements-dev.txt), [`.gitleaks.toml`](../.gitleaks.toml)</sub>

### Release workflow after CI

release.yml publishes a GitHub release for the version in package.json, with the @starpi/core tarball, the CycloneDX SBOMs of the app and of the package, and SHA256SUMS as assets. It starts when the CI workflow completes on main (workflow_run) or by manual dispatch, which takes no inputs, and its jobs run for a dispatch on main or for a CI run that succeeded and was triggered by a push. The prepare job has read-only permissions (contents, and actions to look up CI runs): it checks out the commit CI tested (for a dispatch, the head of main), reads the version from package.json with node -p, requires it to be three dot-separated numbers, and ends successfully without a release when docs/releases/vX.Y.Z.md does not exist or the release vX.Y.Z is already published. Otherwise it requires, for a dispatch, a successful push-triggered CI run of that commit, packages/core/package.json to have the same version, and a tag vX.Y.Z, if one was pushed ahead, to point at the tested commit, then installs from the lockfile without install scripts, packs @starpi/core (its prepack script runs build-core.mjs with type declarations), writes the SBOMs with npm run sbom, smoke-tests the tarball (its file list with dist/verify-receipt.js and dist/ground.js, the version in the bundle banner, an offline install into an empty project, the exported functions, both commands without arguments, and starpi-ground on a plan and an answer with a changed budget, which must exit 1 and write SARIF 2.1.0 with one missing_fact result) and writes SHA256SUMS over the three files, which it uploads as an artifact. The release job needs prepare, is the only job with contents: write and installs and runs nothing from the repository: it checks out the commit only for the notes file, downloads the artifact, checks SHA256SUMS, ends successfully if the release was published in the meantime, fails on a draft release left by an interrupted upload (gh uploads assets to a draft and publishes it at the end), and otherwise gh release create tags that commit (or keeps the pushed tag), titles the release Starpi vX.Y.Z, uses the notes file, marks it as latest and attaches the four files. The release concurrency group never cancels a running release. The workflow deploys nothing and does not publish to npm: the maintainer publishes the attached tarball (CONTRIBUTING.md, Releases).

<!-- diagram: ci-release-workflow -->
```mermaid
flowchart TD
    T1(["workflow_run: CI completed,<br/>branches main"])
    T2(["workflow_dispatch,<br/>no inputs"])
    T1 --> IF{"job condition: a dispatch with github.ref<br/>refs/heads/main, or CI concluded success<br/>and was triggered by a push?"}
    T2 --> IF
    IF -->|"no: the CI run did not succeed, or was started<br/>by a pull request or a manual dispatch of CI,<br/>or the dispatch ran on another branch"| SKIP(["jobs skipped, nothing released"])
    subgraph sg_prep["prepare job: contents read, ubuntu-24.04, 15 min"]
      CO["checkout workflow_run.head_sha, else github.sha,<br/>persist-credentials false"]
      VER["version: node -p the version field<br/>of the checked-out package.json"]
      VCHK{"three dot-separated numbers, X.Y.Z?"}
      NOTES{"docs/releases/vX.Y.Z.md exists?"}
      VIEW{"gh release view vX.Y.Z<br/>finds a published release?"}
      LOCK{"for a dispatch: CI passed on a push of the commit,<br/>packages/core/package.json has X.Y.Z,<br/>and a pushed tag vX.Y.Z, if any,<br/>points at the tested commit?"}
      BUILD["setup-node 22 without cache, npm ci --ignore-scripts,<br/>npm pack --workspace=@starpi/core into release-assets,<br/>prepack runs build-core.mjs,<br/>npm run sbom -- --out release-assets"]
      SMOKE{"smoke test: package.json, README.md, LICENSE,<br/>dist/index.js, index.d.ts, verify-receipt.js and ground.js<br/>in the tarball, banner version, offline npm install<br/>into an empty project, groundAnswer, blocksFromMarkdown,<br/>checkDocument, toSarif, buildReceipt, signReceipt,<br/>verifyReceipt, verifyReceiptSignature, chunkText and<br/>BM25Index exported as functions, starpi-verify-receipt and<br/>starpi-ground exit 2 without arguments, starpi-ground on<br/>an answer of 520,000 EUR against a plan of 480,000 EUR<br/>exits 1 and writes SARIF 2.1.0 with only missing_fact?"}
      SUMS["sha256sum of the tarball and both SBOMs<br/>into SHA256SUMS, upload-artifact release-assets"]
      CO --> VER --> VCHK
      VCHK -->|"yes"| NOTES
      NOTES -->|"yes"| VIEW
      VIEW -->|"no"| LOCK
      LOCK -->|"yes"| BUILD --> SMOKE
      SMOKE -->|"yes"| SUMS
    end
    IF -->|"yes"| CO
    VCHK -->|"no"| ERR(["error annotation: not a version number,<br/>exit 1, job fails"])
    NOTES -->|"no"| NONE(["nothing to release for X.Y.Z, exit 0,<br/>release job skipped"])
    VIEW -->|"yes"| EXISTS(["Release vX.Y.Z already exists, exit 0,<br/>release job skipped"])
    LOCK -->|"no"| ERR2(["error annotation: no green CI run,<br/>other package version or tag elsewhere,<br/>job fails"])
    SMOKE -->|"no"| ERR3(["error annotation, job fails,<br/>nothing released"])
    subgraph sg_rel["release job: needs prepare, contents write, 10 min"]
      RCO["checkout of the same commit for the notes file only,<br/>nothing installed or run from it"]
      DL["actions/download-artifact v8.0.1: release-assets"]
      CHK{"sha256sum -c SHA256SUMS passes?"}
      AGAIN{"gh release view vX.Y.Z --json isDraft:<br/>published, a draft, or none?"}
      CREATE["gh release create vX.Y.Z with GH_TOKEN github.token<br/>--target TARGET_SHA, --title Starpi vX.Y.Z,<br/>--notes-file the release notes, --latest,<br/>starpi-core-X.Y.Z.tgz, starpi-X.Y.Z.cdx.json,<br/>starpi-core-X.Y.Z.cdx.json, SHA256SUMS"]
      RCO --> DL --> CHK
      CHK -->|"yes"| AGAIN
      AGAIN -->|"none"| CREATE
    end
    SUMS --> RCO
    CHK -->|"no"| FAIL(["job fails, nothing released"])
    AGAIN -->|"published"| LATE(["Release vX.Y.Z already exists, exit 0"])
    AGAIN -->|"draft"| DRAFT(["error annotation: delete the draft<br/>of an interrupted upload, re-run"])
    CREATE -->|"ok"| DONE(["Created release vX.Y.Z at TARGET_SHA"])
    CREATE -->|"gh fails, set -euo pipefail"| FAIL
    CONC["workflow permissions contents read,<br/>concurrency group release, cancel-in-progress false"]
    CONC -.- IF
    NOTE["no deploy step and no npm publish:<br/>the Vercel build is triggered outside this repository,<br/>the maintainer publishes the attached tarball to npm"]
    DONE -.- NOTE
```

<sub>Sources: [`.github/workflows/release.yml`](../.github/workflows/release.yml), [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), [`package.json`](../package.json), [`packages/core/package.json`](../packages/core/package.json), [`scripts/sbom.mjs`](../scripts/sbom.mjs), [`CONTRIBUTING.md`](../CONTRIBUTING.md), [`docs/releases/v1.3.0.md`](../docs/releases/v1.3.0.md)</sub>

### CI workflow and Vercel build of the PWA and the NVIDIA functions

Pushes and pull requests to main (and manual dispatch) run six CI jobs: frontend (lint, typecheck, unit tests, a dry-run pack of @starpi/core, build, verify:dist), e2e on the built dist under the vercel.json headers, backend (the library publisher) on Python 3.11 and 3.13, the database migration and RLS suite, a dependency audit (npm audit, pip-audit) with CycloneDX SBOMs and gitleaks secret scanning. Neither ci.yml nor release.yml has a deploy step, so the Vercel build is triggered by settings of the Vercel project outside this repo and nothing in the repo makes it wait for CI. .vercelignore leaves the database files, the library publisher, the tests, the workflows, env files, node_modules and build and test output out of the deployment, but keeps api/ and src/, because the functions import the NVIDIA catalog from src/ (a unit test checks that). vercel.json installs with npm ci --ignore-scripts, builds with npm run build (which stops on a blank or secret Supabase key and on a JWT whose role is not anon) into dist, deploys api/chat/nvidia.js (maxDuration 300 s with supportsCancellation, so a browser that goes away stops the function) and api/models/nvidia.js (maxDuration 10 s) as Node.js functions, and sets a strict CSP, nosniff, X-Frame-Options DENY, COOP, HSTS and Permissions-Policy on all paths, plus immutable caching for assets/ and no-cache for sw.js, the root and index.html. NVIDIA_API_KEYS, and optionally NVIDIA_RATE_LIMIT_PER_MINUTE and NVIDIA_ALLOWED_ORIGINS, are environment variables of the Vercel project, the keys marked sensitive, for Production and Preview. Vercel binds environment variables to a deployment when it is created, so a key added later reaches only deployments created after it; without a valid key the models route reports configured false and the chat route answers 503 nvidia_not_configured.

<!-- diagram: deployment-ci-vercel -->
```mermaid
flowchart TD
    Push(["git push to main"])
    PR(["pull request to main<br/>or workflow_dispatch"])
    subgraph sg_ci["GitHub Actions: .github/workflows/ci.yml"]
        Conc["permissions contents read<br/>concurrency per PR or ref, cancel-in-progress"]
        FE["frontend job, Node 22<br/>npm ci --ignore-scripts, lint, typecheck,<br/>npm test, npm run pack:core,<br/>npm run build, npm run verify:dist<br/>uploads the dist artifact"]
        E2E["e2e job, needs frontend<br/>npm ci --ignore-scripts, downloads dist,<br/>installs Chromium, npm run test:e2e<br/>app, trust, models, modes and Mermaid docs specs,<br/>Supabase and the NVIDIA proxy mocked<br/>playwright-report uploaded on failure"]
        BE["backend job, library publisher, Python 3.11 and 3.13<br/>pip install tools/library-publisher/requirements-dev.txt<br/>ruff check, ruff format --check,<br/>compileall, unittest discover"]
        DBJ["database job<br/>PostgreSQL 16 and pgvector<br/>backend/supabase/tests/run_rls_tests.sh"]
        AUD["audit job<br/>npm audit: no advisory in runtime dependencies<br/>pip-audit on backend/requirements-dev.txt<br/>npm run sbom: CycloneDX SBOMs, artifact sbom"]
        SEC["secrets job<br/>gitleaks 8.30.1, sha256 verified, NVIDIA key rule<br/>working tree, plus PR commits on pull_request"]
    end
    Push --> Conc
    PR --> Conc
    Conc --> FE
    Conc --> BE
    Conc --> DBJ
    Conc --> AUD
    Conc --> SEC
    FE -->|"dist artifact"| E2E
    sg_ci -.->|"CI passed on a push to main"| REL["release.yml: GitHub release with the<br/>@starpi/core tarball, SBOMs and SHA256SUMS,<br/>no deploy step, no npm publish"]
    Push -.->|"trigger set in the Vercel project, not in this repo<br/>no workflow deploys, nothing waits for CI"| VIg
    subgraph sg_vercel["Vercel build from vercel.json"]
        VIg[".vercelignore leaves out backend/, tools/, tests/, .github/,<br/>.env*, node_modules/, dist/, .build/,<br/>playwright-report/, test-results/,<br/>keeps api/ and src/"]
        VI["installCommand<br/>npm ci --ignore-scripts"]
        VB["buildCommand npm run build = scripts/build.mjs<br/>STARPI_SUPABASE_URL, STARPI_SUPABASE_ANON_KEY<br/>or the compiled-in defaults<br/>stops on a blank or sb_secret_ key and on a JWT<br/>whose role is not anon, accepts sb_publishable_ keys<br/>esbuild warnings fail the build"]
        VO[("outputDirectory dist<br/>framework null, cleanUrls true")]
        VF["functions: api/chat/nvidia.js maxDuration 300,<br/>supportsCancellation true, api/models/nvidia.js<br/>maxDuration 10, Node.js, import the catalog from src/"]
        VE[("project environment, bound when a deployment<br/>is created: NVIDIA_API_KEYS sensitive, Production<br/>and Preview, NVIDIA_RATE_LIMIT_PER_MINUTE and<br/>NVIDIA_ALLOWED_ORIGINS optional")]
        VIg --> VI --> VB --> VO
        VIg --> VF
        VE -.->|"read by runtimeDeps"| VF
    end
    VO --> Site(["PWA at www.starpi.app"])
    VF --> Api(["same-origin /api/models/nvidia and<br/>/api/chat/nvidia, keys only on the server,<br/>503 nvidia_not_configured without a valid key"])
    Site -.->|"the browser calls them without a key"| Api
    subgraph sg_headers["Response headers from vercel.json"]
        HCsp["all paths: Content-Security-Policy<br/>default-src 'self'<br/>script-src 'self' 'wasm-unsafe-eval'<br/>style-src, font-src, worker-src, manifest-src 'self'<br/>img-src 'self' data: blob:<br/>connect-src 'self' data: https: wss://*.supabase.co<br/>http://localhost:* http://127.0.0.1:*<br/>media-src, object-src, frame-src 'none'<br/>base-uri, form-action, frame-ancestors 'none'"]
        HSec["all paths<br/>X-Content-Type-Options nosniff, X-Frame-Options DENY<br/>Referrer-Policy strict-origin-when-cross-origin<br/>Cross-Origin-Opener-Policy same-origin<br/>Strict-Transport-Security max-age=63072000<br/>Permissions-Policy microphone=(self), camera=(),<br/>geolocation=(), payment=(), usb=(), serial=(), hid=()"]
        HCache["Cache-Control<br/>assets/*: public, max-age=31536000, immutable<br/>sw.js: no-cache, no-store, must-revalidate<br/>and Service-Worker-Allowed /<br/>root and index.html: no-cache<br/>function answers set no-store themselves"]
        HMan["manifest.webmanifest<br/>Content-Type application/manifest+json"]
    end
    Site --> HCsp
    Site --> HSec
    Site --> HCache
    Site --> HMan
    FE -.->|"verify:dist requires a CSP<br/>without unsafe-inline or unsafe-eval,<br/>and no NVIDIA key in the bundles"| HCsp
    E2E -.->|"Playwright webServer: scripts/serve.mjs<br/>on port 4173 applies the vercel.json headers"| sg_headers
```

<sub>Sources: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), [`.github/workflows/release.yml`](../.github/workflows/release.yml), [`vercel.json`](../vercel.json), [`.vercelignore`](../.vercelignore), [`api/chat/nvidia.js`](../api/chat/nvidia.js), [`api/models/nvidia.js`](../api/models/nvidia.js), [`api/_lib/handlers.js`](../api/_lib/handlers.js), [`api/_lib/env.js`](../api/_lib/env.js), [`README.md`](../README.md), [`package.json`](../package.json), [`scripts/build.mjs`](../scripts/build.mjs), [`scripts/lib/supabase-key.mjs`](../scripts/lib/supabase-key.mjs), [`scripts/verify-dist.mjs`](../scripts/verify-dist.mjs), [`scripts/serve.mjs`](../scripts/serve.mjs), [`playwright.config.mjs`](../playwright.config.mjs), [`tests/unit/nvidia-proxy.test.mjs`](../tests/unit/nvidia-proxy.test.mjs), [`tests/e2e/docs-diagrams.spec.mjs`](../tests/e2e/docs-diagrams.spec.mjs)</sub>

### Supabase schema: fresh install or ordered migrations

A new project gets full_schema.sql, an existing one the four migrations in file-name order: 20260923000000_harden_rls_anonymous_auth.sql, 20260924000000_lock_published_rows.sql, 20260924120000_search_knowledge_shared_terms.sql, then the optional 20261101000000_embedding_384.sql. Each file first checks its preconditions and raises an exception otherwise: full_schema.sql refuses an older schema, the first migration needs vector in public, Supabase auth and the Starpi tables, the second refuses a database without the first, and the third needs search_knowledge(text, integer) and the two knowledge tables, the fourth the hardened knowledge tables, search_knowledge and ingest_document_atomic. Every file runs in a single transaction; full_schema.sql, the first two migrations and the fourth end with notify pgrst to reload the schema, the third does not. An operator applies the files by hand through the SQL editor, a psql loop, apply_migration.py --migrations or supabase db push; no workflow touches the live project. Re-running only the first migration drops and recreates the policies and search_knowledge, which undoes the policy part of the second and the search change of the third, so the whole set is always re-run, and the CI database job checks on a throwaway cluster that fresh and upgraded schemas are identical.

<!-- diagram: deployment-supabase-migrations -->
```mermaid
flowchart TD
    Pre["prerequisites, set by hand<br/>anonymous sign-ins enabled<br/>vector extension in schema public<br/>run as the table owner postgres"] --> Backup["pg_dump --data-only backup of the<br/>knowledge_*, chat_history and brain_settings tables"]
    Backup --> Kind{"new or existing project?"}
    Kind -->|"new project"| Full["full_schema.sql"]
    Full --> FullG{"vector in public, auth.users and auth.uid() exist,<br/>no Starpi table without owner_id?"}
    FullG -->|"no"| FullStop["raise exception, nothing committed<br/>older schema: apply migrations/ instead"]
    FullG -->|"yes"| Tx
    Kind -->|"existing project"| M1["migrations/20260923000000_harden_rls_anonymous_auth.sql<br/>owner-based RLS for anonymous sign-ins<br/>deletes ownerless chat_history rows"]
    M1 --> M1G{"vector in public, auth.users and auth.uid() exist,<br/>knowledge_documents, knowledge_sections<br/>and chat_history exist?"}
    M1G -->|"no"| M1Stop["raise exception, nothing committed<br/>no Starpi tables: use full_schema.sql"]
    M1G -->|"yes, then in file-name order"| M2["migrations/20260924000000_lock_published_rows.sql<br/>published rows read-only for browser roles<br/>brain_settings service role only, size limits NOT VALID"]
    M2 --> M2G{"owner_id and is_public on documents,<br/>entities and relations, and knowledge_sections,<br/>chat_history, brain_settings exist?"}
    M2G -->|"no"| M2Stop["raise exception, nothing committed<br/>apply 20260923000000 first"]
    M2G -->|"yes, then"| M3["migrations/20260924120000_search_knowledge_shared_terms.sql<br/>search_knowledge: rows with every term first, otherwise<br/>rows sharing at least two terms, or one term<br/>when the query has only one"]
    M3 --> M3G{"search_knowledge(text, integer),<br/>knowledge_sections and<br/>knowledge_documents exist?"}
    M3G -->|"no"| M3Stop["raise exception, nothing committed<br/>apply 20260923000000 and 20260924000000 first"]
    M3G -->|"yes, then"| M4["migrations/20261101000000_embedding_384.sql, optional<br/>embedding_384 vector(384) with an HNSW index,<br/>match_knowledge_vector_384 for anon and signed-in users,<br/>ingest_document_atomic stores embedding_384"]
    M4 --> M4G{"hardened knowledge tables, search_knowledge<br/>and ingest_document_atomic exist?"}
    M4G -->|"no"| M4Stop["raise exception, nothing committed<br/>apply the three earlier migrations first"]
    M4G -->|"yes"| Tx
    Full -.->|"migrations afterwards change nothing"| M1
    subgraph sg_tools["ways to apply, all run by hand"]
        T1["SQL editor, one file after the other"]
        T2["psql -X -v ON_ERROR_STOP=1 loop over<br/>migrations/*.sql, break at the first failure"]
        T3["apply_migration.py with DATABASE_URL<br/>no argument: full_schema.sql<br/>--migrations: file-name order, stops at the first failure<br/>psycopg, psycopg2 or psql, exit 1 SQL error, 2 setup"]
        T4["supabase db push after copying the files<br/>into the CLI project's supabase/migrations/"]
    end
    sg_tools --> Tx["each file: begin, one transaction,<br/>lock_timeout 15s in the migrations, commit<br/>notify pgrst reload schema in full_schema.sql<br/>and every migration but the third"]
    Tx --> DB[("Supabase Postgres and PostgREST")]
    DB --> Verify["verify with Supabase security advisors<br/>and the verification queries"]
    Rerun["re-running 20260923000000 alone drops and recreates<br/>the policies and search_knowledge: it undoes the policy part<br/>of 20260924000000 and the search of 20260924120000,<br/>always re-run the whole set"] -.-> M1
    CIdb["CI database job: run_rls_tests.sh on a throwaway<br/>PostgreSQL 16 and pgvector cluster, never the live project<br/>every migrations file in file-name order, guard checks,<br/>rls_test.sql 220 checks, 227 with legacy rows,<br/>fresh vs upgraded pg_dump"] -.->|"tests"| Tx
    PWA(["browser PWA, anon key and RLS"]) --> DB
    Publisher(["library publisher, service role key"]) --> DB
```

<sub>Sources: [`backend/supabase/README.md`](../backend/supabase/README.md), [`backend/supabase/apply_migration.py`](../backend/supabase/apply_migration.py), [`backend/supabase/full_schema.sql`](../backend/supabase/full_schema.sql), [`backend/supabase/migrations/20260923000000_harden_rls_anonymous_auth.sql`](../backend/supabase/migrations/20260923000000_harden_rls_anonymous_auth.sql), [`backend/supabase/migrations/20260924000000_lock_published_rows.sql`](../backend/supabase/migrations/20260924000000_lock_published_rows.sql), [`backend/supabase/migrations/20260924120000_search_knowledge_shared_terms.sql`](../backend/supabase/migrations/20260924120000_search_knowledge_shared_terms.sql), [`backend/supabase/migrations/20261101000000_embedding_384.sql`](../backend/supabase/migrations/20261101000000_embedding_384.sql), [`backend/supabase/tests/run_rls_tests.sh`](../backend/supabase/tests/run_rls_tests.sh), [`backend/supabase/tests/rls_test.sql`](../backend/supabase/tests/rls_test.sql), [`README.md`](../README.md), [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)</sub>

## 12. Source check, answer receipts and sample files

Every new answer with citations gets a source check and a receipt draft, both on the device; the fixed demo answer gets only the check. The logic lives in pure modules under src/js/core (no DOM; they run in the browser, in workers and in Node, and @starpi/core re-exports them). The source check compares the numbers, dates, times, weekdays, codes, quotations and wording of each statement with the excerpts it cites; version 2 of its rules (starpi-grounding 2, the current one; version 1 can still be run) also reports, in the excerpts' language, a statement that reverses a negation of its excerpt and a name or value that the excerpt puts next to something else. It is a deterministic heuristic, not a second model, and a match never proves a statement correct. An answer receipt is starpi.receipt/v2 JSON with a Merkle tree over its citations: it shows that the cited workspace excerpts can be reproduced from the same files and that each citation belongs to the receipt, and it does not prove what a model saw or that the answer's reasoning is right. The app does not sign receipts; a deployment can sign one with signReceipt from @starpi/core, and only a verifier who has the signer's public key learns who signed it. starpi-ground runs the same source check on a Markdown document against source files for scripts and CI. The sample files let a new user try the check and the receipts without any setup.

### Source check: from the rendered answer to the panel

After an answer with a citation scope is rendered, chat.js passes applyGrounding one source per excerpt, carrying the text that actually reached the model. For the extractive synthesizer that is the excerpt as given; for a model answer it is what contextCoverage parses back from the context that was sent, marked full, partial or omitted. given holds the question and the user's messages among the last 4 conversation entries, never the model's own earlier answers, and citedOnly (extractive answers) makes the check ignore statements without their own marker. blocksFromElement reads the rendered DOM, not the Markdown, so a citation counts only when it is a citation button of this answer's scope; other label-like text becomes a bad citation. groundAnswer runs the current rules, version 2 (GROUNDING.version), since the app passes no other version; it skips answers with more than 20,000 characters of text, links markers to statements, skips answers with more than 300 statements and runs checkSentence on each one (next two diagrams). The result is a details panel under the answer that lists the flagged statements with one reason line per reason, unsupported ones first, and opens by itself when a statement is unsupported. Its colour and shield icon follow the worst verdict; when nothing was compared (the answer was too long, or every checked statement stayed unchecked) the bar is neutral grey with a plain shield, never the green one. Citation buttons of unsupported statements are flagged and point to their list item with aria-describedby. Where the browser supports the CSS Custom Highlight API, those statements are also highlighted without changing the DOM. Every panel ends with the disclaimer that a match does not prove a statement correct.

<!-- diagram: source-check-pipeline -->
```mermaid
flowchart TD
    sIn(["chat.js submitChat: rendered messageEl, a citation scope,<br/>the same chat session still shown"]) --> sEng{"answer.engine is synthesizer?"}
    sEng -->|"yes"| sFull["every excerpt delivered full,<br/>text = the excerpt as given"]
    sEng -->|"no, a model answered"| sCov["contextCoverage(citationList, deliveredContext or context):<br/>the EXCERPT n blocks of the context that was sent give<br/>full, partial without the ellipsis, or omitted"]
    sFull --> sApply
    sCov --> sApply
    sDemo(["demo.js showCheckDemo: excerpts delivered full,<br/>no given, citedOnly off"]) -.-> sApply
    sApply["applyGrounding(messageEl): scope, sources with label, doc,<br/>heading, delivered text and state, given = the prompt and the<br/>user messages among the last 4 conversation entries,<br/>citedOnly = synthesizer answer"]
    sApply --> sSlot{".message-content and .message-provenance<br/>present and sources not empty?"}
    sSlot -->|"no"| sNull(["returns null, no panel"])
    sSlot -->|"yes"| sBlocks["blocksFromElement: one block per p, li, h1 to h6, tr,<br/>blockquote, dd, dt, pre skipped, br as a line break,<br/>td and th cells joined with a separator,<br/>kind p, li, heading, row, header-row or other"]
    sBlocks --> sBtn{"button with data-action open-citation<br/>and data-arg of this answer's scope?"}
    sBtn -->|"yes"| sCite["cite segment, chip position recorded"]
    sBtn -->|"no"| sIgn["other buttons ignored"]
    sBlocks --> sLoose["text matching LOOSE_LABEL_PATTERN: badcite,<br/>resolveLabel by document name and chunk number"]
    sBlocks --> sLead["list item, or the first paragraph of a loose list item,<br/>whose list follows a block ending in a colon:<br/>leadIn = that block"]
    sCite --> sSize
    sLoose --> sSize
    sLead --> sSize
    sSize{"groundAnswer, rules version GROUNDING.version 2:<br/>text segments over THRESHOLDS.maxChars 20000 characters?"}
    sSize -->|"yes"| sSkip["skipped too_long"]
    sSize -->|"no"| sAssoc["associate: sentenceSpans per block, no statement ends at the dot<br/>of an ordinal, a day.month date such as 1.6. or a known abbreviation,<br/>a marker belongs to the last statement that starts before it,<br/>a statement without one inherits from the next cited statement<br/>of its block, then the previous one, then its lead-in up to 4 hops,<br/>then the markers and bad labels of contentless blocks<br/>such as a Sources line"]
    sAssoc --> sMany{"more than maxSentences 300 statements?"}
    sMany -->|"yes"| sSkip
    sMany -->|"no"| sIdx["indexSource per excerpt over text, doc and heading<br/>with the same rules version, no index for an omitted excerpt,<br/>given indexed, answer language from guessLanguage"]
    sIdx --> sCheck["checkSentence per statement,<br/>see source-check-verdicts and source-check-v2-checks"]
    sCheck --> sCount["counts supported, weak, unsupported, unchecked,<br/>neutral statements not counted"]
    sCount --> sAny{"anything counted, unchecked or skipped?"}
    sSkip --> sAny
    sAny -->|"no"| sQuiet(["report returned, no panel"])
    sAny -->|"yes"| sBar["details.grounding-bar replaces the .message-provenance content:<br/>grounding-review and shield-alert when a statement is unsupported,<br/>else grounding-partial and shield-question-mark when one is weak,<br/>else grounding-ok and shield-check when statements were compared,<br/>else grounding-none and shield"]
    sBar --> sSum["summary: grounding.title, then grounding.too_long,<br/>grounding.summary ok of total, or grounding.only_unchecked,<br/>badges grounding.review n and grounding.partial n"]
    sSum --> sList["ol.grounding-list: unsupported first, then weak, in answer order,<br/>li id grd-n-i, n per panel, i the statement index,<br/>grounding.statement cut to 160 chars,<br/>one grounding.reason_code line per reason, citation badges"]
    sList --> sNotes["grounding.unchecked n when statements were not compared,<br/>grounding.disclaimer in every panel"]
    sNotes --> sOpen["details opened when a statement is unsupported"]
    sOpen --> sChips["each citation button belongs to the last statement of its block<br/>that starts before it, else the first, if that one is unsupported:<br/>class citation-chip-flag, aria-describedby = id of its list item"]
    sChips --> sHl{"Highlight and CSS.highlights available?"}
    sHl -->|"yes"| sMark["a Range per unsupported statement in the<br/>starpi-review highlight, no DOM change, no inline style"]
    sHl -->|"no"| sNoMark["no highlight, the flagged list<br/>stays the accessible channel"]
    sMark --> sRet(["report returned to chat.js for the receipt draft"])
    sNoMark --> sRet
    sReset(["resetMessages: new chat, deleted or restored history"]) -.-> sClear["clearGroundingHighlights"]
```

<sub>Sources: [`src/js/chat.js`](../src/js/chat.js), [`src/js/rag/grounding-view.js`](../src/js/rag/grounding-view.js), [`src/js/core/grounding.js`](../src/js/core/grounding.js), [`src/js/core/sentences.js`](../src/js/core/sentences.js), [`src/js/core/labels.js`](../src/js/core/labels.js), [`src/js/rag/citations.js`](../src/js/rag/citations.js), [`src/js/messages.js`](../src/js/messages.js), [`src/js/demo.js`](../src/js/demo.js), [`src/styles/app.css`](../src/styles/app.css), [`src/locales/en.json`](../src/locales/en.json)</sub>

### checkSentence: when a statement is checked, its reasons and its verdict

checkSentence first decides whether a statement is checked at all. Headings and table header rows without their own marker, statements without their own marker in extractive answers, statements with no citation, no bad label and no fact, and statements with no fact, fewer than 3 content words and no bad label of their own are neutral: they are not counted and not written to a receipt. For every other statement it collects reasons, each at level weak or unsupported: bad labels, cited excerpts that did not fit into the model's context, each fact looked up in the cited delivered excerpts and then in the other excerpts and in what the user said, word overlap and names of English statements missing from the excerpts. Then the rules version decides: version 1 compares each value found with the words next to it (fact_context), and version 2, the default, runs checkV2 when every cited delivered excerpt is in the statement's language or either language is unknown: a reversed negation, a name in another place and its own fact_context rule, all weak (next diagram). One unsupported reason makes the statement unsupported and any other reason makes it weak. A cited statement without reasons is supported when it had facts or measured overlap, and unchecked otherwise, which in practice means a statement without facts whose excerpts are all in another language.

<!-- diagram: source-check-verdicts -->
```mermaid
flowchart TD
    vIn(["checkSentence(statement, ctx)"]) --> vFacts["extractFacts with ctx.version, GROUNDING.version 2<br/>by default, and contentTokens of the statement text"]
    vFacts --> vN1{"heading or header-row<br/>without its own marker?"}
    vN1 -->|"yes"| vNeutral(["neutral: not counted,<br/>left out of the receipt"])
    vN1 -->|"no"| vN2{"citedOnly, an extractive answer,<br/>and no own marker?"}
    vN2 -->|"yes"| vNeutral
    vN2 -->|"no"| vN3{"no citation, no bad label of its own<br/>or inherited, no fact?"}
    vN3 -->|"yes"| vNeutral
    vN3 -->|"no"| vN4{"no fact, fewer than minContentTokens 3<br/>content words, no bad label of its own?"}
    vN4 -->|"yes"| vNeutral
    vN4 -->|"no"| vBad["each bad label, its own or inherited: label_mismatch, weak,<br/>when resolveLabel found an excerpt of this answer,<br/>which then counts as cited, else unknown_citation, unsupported"]
    vBad --> vDel{"citations, but none of the cited<br/>excerpts delivered and some omitted?"}
    vDel -->|"yes"| vND["not_delivered, unsupported"]
    vDel -->|"no"| vFact
    vND --> vFact
    vFact{"each fact: lookupFact in the delivered cited<br/>excerpts, approxTolerance 0.05"}
    vFact -->|"exact"| vFound["found, a value other than a quotation<br/>is checked later for fact_context"]
    vFact -->|"approx"| vApprox["approximate, weak,<br/>found = the number in the excerpt"]
    vFact -->|"neither"| vOther{"exact or approx in another<br/>delivered excerpt?"}
    vOther -->|"yes"| vElse["fact_elsewhere, weak, when the statement cites a<br/>delivered excerpt, else uncited_found, weak"]
    vOther -->|"no"| vGiven{"exact in given: the question<br/>and recent user messages?"}
    vGiven -->|"yes"| vConv["from_conversation, weak"]
    vGiven -->|"no"| vQuote{"a quotation?"}
    vQuote -->|"yes"| vQM["quote_missing: weak when 80 percent of its<br/>words are there, else unsupported"]
    vQuote -->|"no"| vMiss["missing_fact, unsupported, with a delivered cited excerpt,<br/>uncited_missing, unsupported, without citations,<br/>no further reason when all cited excerpts were omitted"]
    vFound --> vWords
    vApprox --> vWords
    vElse --> vWords
    vConv --> vWords
    vQM --> vWords
    vMiss --> vWords
    vWords{"delivered cited excerpts and at least<br/>3 content words?"}
    vWords -->|"no"| vNames
    vWords -->|"yes"| vLang{"language of the statement, else of the answer,<br/>differs from every known language of the cited excerpts?"}
    vLang -->|"yes"| vCross["crossLanguage: facts only, overlap, names,<br/>fact_context and checkV2 skipped"]
    vLang -->|"no"| vOverlap["overlap = share of content words found with tokenMatches,<br/>below supportedOverlap 0.5: low_overlap, weak"]
    vOverlap --> vNames["English statement with delivered excerpts: a capitalised word that<br/>opens no sentence, list item, cell or clause, is no fact, weekday,<br/>month or stopword, and is in no cited delivered excerpt:<br/>from_conversation, weak, when it is in given, else name_missing, weak"]
    vNames --> vVer{"rules version?"}
    vVer -->|"1"| vCtx["version 1 fact_context, weak: a found value stands only in passages<br/>of the cited excerpts that share none of the words next to it in the<br/>statement, counting words found in at most half the passages, while<br/>a passage without the value shares them, the excerpt's heading<br/>counting as part of every passage, its document name not,<br/>found = the first such passage, at most 160 chars"]
    vVer -->|"2"| vSame{"delivered cited excerpts, not crossLanguage,<br/>and each of them in the statement's language,<br/>or either language unknown?"}
    vSame -->|"yes"| vV2["checkV2, see source-check-v2-checks:<br/>negation_inversion, name_context and<br/>version 2 fact_context, each weak"]
    vSame -->|"no"| vVerdict
    vCross --> vVerdict
    vCtx --> vVerdict
    vV2 --> vVerdict
    vVerdict{"verdict"}
    vVerdict -->|"a reason at level unsupported"| vU(["unsupported"])
    vVerdict -->|"any other reason"| vW(["weak"])
    vVerdict -->|"no reason, no citation"| vW2(["weak, reason uncited_found added"])
    vVerdict -->|"no reason, cited, facts or overlap"| vS(["supported"])
    vVerdict -->|"no reason, cited, no fact, no overlap"| vC(["unchecked"])
```

<sub>Sources: [`src/js/core/grounding.js`](../src/js/core/grounding.js), [`src/js/core/facts.js`](../src/js/core/facts.js), [`src/js/rag/bm25.js`](../src/js/rag/bm25.js), [`src/locales/en.json`](../src/locales/en.json)</sub>

### checkV2: negations, names and values in another place

Version 2 of the rules adds three checks to every statement that cites delivered excerpts in its own language (or in an unknown one). Each compares the statement only with the delivered excerpts it cites, never with other statements or with excerpts it does not cite, so a receipt that leaves other excerpts out still recomputes it. Each gives a weak reason, never an unsupported one: a lexical reading cannot tell every restatement from a contradiction, and a flag means open the source and check. The negation check (core/polarity.js) rewrites statement and excerpt sentences into a canonical form, in which "disabled" reads as "not enabled" and "prohibited" as "not allowed", splits them into clauses and anchors each negator to the word it negates; a statement clause that matches an excerpt clause in its words, in both directions, and in its numbers, but differs in the parity of its negations is reported as negation_inversion, quoting the excerpt sentence. The name check (core/binding.js) splits statement and excerpts into units at semicolons and conjunctions and reports name_context when the excerpt unit that best matches the statement's other words has a different name in place of the statement's, unless every such name of the statement stands in another excerpt unit that shares two of those words, so a statement that joins two passages is not flagged. Names are found without a list: capitalised words inside an English sentence, runs of two or more capitalised words, CamelCase and all-capital words, and capitalised words the excerpts themselves use as names. The value check replaces version 1's fact_context rule: a value of a statement part is reported when the passages holding it share fewer of the part's words than another passage with a value of the same kind, by the margins below. The thresholds were chosen on the development sets (docs/eval/v2-protocol.md).

<!-- diagram: source-check-v2-checks -->
```mermaid
flowchart TD
    wIn(["checkV2(statement text, delivered cited excerpts, ctx), from checkSentence<br/>with version 2, lang = the statement's language, else the answer's"])
    wIn --> nQ{"statement ends with a question mark?"}
    subgraph sg_neg["negationInversion: core/polarity.js"]
        nCanon["canonicalText of the statement and of each excerpt sentence: fold,<br/>isn't and can't as is not and can not, neither ... nor as not ... or not,<br/>it is not true that as one negation; disabled, prohibited, rejected,<br/>failed, decreased, listed un-, in-, im-, il-, ir- and dis- words and<br/>-less words as notx before the positive word, German deaktiviert,<br/>verboten, gesunken, listed un-, in-, il- and ir- words and -los<br/>words likewise;<br/>no later than, not only, nicht nur and whether or not lose their<br/>negator; in a clause with a time condition such as until, before,<br/>bevor or bis, or next to a clause that starts with one,<br/>negators are dropped unless it is a range"]
        nClauses["clausesOf with merge: split at sentence ends, semicolons, colons,<br/>commas and at and, or, but, while, because, und, oder, weil and others,<br/>a part with fewer than 2 content words joined to the next one"]
        nProfile["profileClause: content tokens without stopwords and qualifiers<br/>such as still, yet, noch; each negator anchored to the next<br/>content word, or to the previous one at the end of the clause"]
        nMatch{"another statement clause of at least POLARITY.minShared 2 tokens<br/>with excerpt clauses that hold at least 2 and minShare 0.6 of them,<br/>whose own tokens are at least minBack 0.5 in the statement clause<br/>and which hold every number of the statement clause?"}
        nDiff{"every best match, by matched tokens: the same restriction<br/>as the statement, only, solely, nur, erst and the like in both<br/>sentences or in neither, and polarityDiffers: the parity of the<br/>negators anchored on shared words differs, and so does<br/>the parity of all negators?"}
        nCanon --> nClauses --> nProfile --> nMatch
        nMatch -->|"yes"| nDiff
        nDiff -->|"no"| nMatch
    end
    nQ -->|"no"| nCanon
    nDiff -->|"yes"| nR["negation_inversion, weak, cites that excerpt,<br/>found = the sentence of the first best match without a<br/>leading separator or closing punctuation, at most 160 chars"]
    nQ -->|"yes"| mUnits
    nMatch -->|"no"| mUnits
    nR --> mUnits
    subgraph sg_name["misplacedName: core/binding.js"]
        mUnits["unitsOf each cited excerpt in its own language: sentences cut at<br/>semicolons, at a comma before and, but, while, und, aber, während<br/>and others, and at while, whereas, während, wobei; a table row<br/>with 2 or more column: value parts stays one record"]
        mNames["capitalised words without stopwords, months, weekdays and titles<br/>such as Mr, Dr, Frau; name-like in a run of 2 or more, in CamelCase<br/>or all capitals, or in English when not opening the sentence;<br/>nameLexicon = the name-like words of all cited units"]
        mCand{"another statement unit, then another comma piece of a unit<br/>whose pieces all have at least 2 content words, with candidate<br/>names: its names and its capitalised words in the lexicon,<br/>less names the question or the conversation gave?"}
        mHas{"an excerpt unit with every one of these names that shares<br/>at least BINDING.minShared 2 and minShare 0.6 of the statement<br/>unit's words, a name of several words counting once?"}
        mBest{"a best excerpt unit that lacks a name of the statement, has a name<br/>of its own instead, holds at least 2 and 0.6 of the statement's other<br/>words and more than the best unit before it, and whose own other<br/>words are at least minBack 0.6 in the statement, minBackRecord 0.3<br/>for a table row?"}
        mHome{"every missing name is in another excerpt unit<br/>that shares BINDING.home 2 of the statement's other words?"}
        mUnits --> mNames --> mCand
        mCand -->|"yes"| mHas
        mHas -->|"yes: this unit is supported"| mCand
        mHas -->|"no"| mBest
        mBest -->|"no"| mCand
        mBest -->|"yes"| mHome
        mHome -->|"yes: the statement joins two passages"| mCand
    end
    mHome -->|"no"| mR["name_context, weak, fact = the name's run of capitalised words<br/>as the statement writes it, cites that excerpt,<br/>found = the excerpt unit, at most 160 chars, no further unit"]
    mCand -->|"no"| vPass
    mR --> vPass
    subgraph sg_val["misplacedValues: core/binding.js"]
        vPass["valuePassages of each cited excerpt without its heading: sentences,<br/>also cut after a version number, split by valueParts version 2;<br/>bare: no words of its own, or a table row; short: one value and<br/>fewer than 2 other words; lead: the first part, for a later part with<br/>fewer than 3 words the first part does not have, not after a semicolon"]
        vParts{"another part of valueParts(statement, 2): cut between two values<br/>at the last conjunction, semicolon or dash between them,<br/>at a bare comma only when there is none?"}
        vTell{"the part has facts other than quotations and telling words:<br/>content words without facts, currency and unit words,<br/>found in at most half of all passages?"}
        vFact{"another fact of the part, not a four-digit number from 1900<br/>to 2100, that passages hold exactly, none of them short?"}
        vRel{"a passage without it that holds another value of the same kind,<br/>not one of the part's own, and scores at least BINDING.minRelated 2<br/>and margin 2 more than the best holder, or at least 1 while the<br/>holders score 0? score = telling words plus the part's other values<br/>found, a bare holder scored by its sentence, one with a lead also<br/>with the lead's words when the part repeats one of its own<br/>words the lead does not have, or it has none"}
        vPass --> vParts
        vParts -->|"yes"| vTell
        vTell -->|"no"| vParts
        vTell -->|"yes"| vFact
        vFact -->|"no"| vParts
        vFact -->|"yes"| vRel
        vRel -->|"no"| vFact
    end
    vRel -->|"yes"| vR["fact_context, weak, fact = the value, cites the excerpt<br/>of the best scored holder, found = that passage,<br/>at most 160 chars"]
    vR --> vFact
    vParts -->|"no"| wOut(["reasons appended to checkSentence's reasons, all weak:<br/>a statement with no other reason becomes weak,<br/>never unsupported"])
```

<sub>Sources: [`src/js/core/grounding.js`](../src/js/core/grounding.js), [`src/js/core/polarity.js`](../src/js/core/polarity.js), [`src/js/core/binding.js`](../src/js/core/binding.js), [`src/js/core/facts.js`](../src/js/core/facts.js), [`src/js/core/sentences.js`](../src/js/core/sentences.js), [`src/locales/en.json`](../src/locales/en.json), [`docs/eval/v2-protocol.md`](eval/v2-protocol.md)</sub>

### Facts: strict claims, lenient excerpts and how they are matched

facts.js reads facts in two modes. extractFacts reads an answer statement strictly and records only what it is sure of, taking the dominant reading of a number; indexSource reads an excerpt leniently and records every plausible reading. A fact copied verbatim, or rewritten between English and German formats, therefore matches, while a changed value does not. Version 2 of the rules, the default of both functions, also reads version numbers with three or four dotted parts (4.2.1, v3.9.4) as codes, where version 1 read 3.9.4 am as the number 3.9 and the time 4 am. Quotation words, codes, month names, content words and the excerpt word sequence go through the same fold on both sides. lookupFact answers exact, approx (numbers only: within 5 percent when the statement says the value is approximate, or equal once rounded to the digits written with a scale word), partial (quotations only, 80 percent of the words) or null. Word overlap uses tokenMatches, which tolerates inflection and German compounds. guessLanguage decides between English and German from function words; when a statement and all its cited excerpts are in different languages, only the facts are compared.

<!-- diagram: source-check-facts -->
```mermaid
flowchart TD
    fFold["fold, used on both sides for quotation words, code values, month names,<br/>content tokens and the word sequence, not for the raw text: NFKC,<br/>soft hyphens and PDF line-break hyphens removed, lower case, ae, oe,<br/>ue and ss for umlauts and sharp s, quotation marks and dashes unified"]
    subgraph sg_claim["extractFacts(statement): claim mode, strict"]
        fC0["citation labels blanked, then each kind in this order,<br/>quotes, version numbers, dates, times and codes masked once found"]
        fC1["quote: 3 to 300 chars between German, English,<br/>straight or French quotation marks, at least 2 words"]
        fCV["version 2 only, version number as a code: 3 or 4 parts of<br/>1 to 4 digits joined by dots, an optional v, value v:4.2.1 without<br/>leading zeros; not when the later parts all have 3 digits, as in<br/>4.480.000, nor when it could be a date, as 10.4.12, unless a v or<br/>a word such as version, firmware, release, build or patch precedes;<br/>a date written d.m.yy also gets the version reading"]
        fC2["date: 2026-09-14, 14.09.2026, 14.09.26, 14. September 2026,<br/>14 September 2026, September 14, 2026, September 2026,<br/>9/14/2026 read both ways when ambiguous, 09/2026,<br/>14.09. and am 14.09., 14.09. also read as the number 14.09,<br/>impossible dates dropped"]
        fC3["time: 10:00 with optional Uhr, h, am or pm,<br/>10.00 Uhr, 10.30 pm, 10 am, 10 Uhr"]
        fC4["weekday: English and German names, plural s allowed,<br/>month: full name only after in, by, until, bis, seit, early,<br/>end of and similar words, lowercase may skipped as a verb"]
        fC5["code: letters and digits mixed as in Q3, A320, v2, or a prefix of<br/>1 to 6 letters, a hyphen, also a typographic hyphen or en dash,<br/>digits as in R-02, ISO-27001, the hyphen dropped, digits followed by letters, as 480k, 10kg, 3rd, are no code"]
        fC6["number: 480,000, 480.000, 1.234,56, 3 100, a single separator<br/>before exactly 3 digits groups thousands, k, Tsd., Mio.,<br/>million, Mrd. and bn scale it, a unit, percent or currency<br/>marks it as a quantity, the value itself carries no unit"]
        fC7["not a claim: a lone integer below 10 without a unit,<br/>list numbering, ordinals, a number glued to a word"]
        fC8["approx when a word such as about, around, roughly, nearly, over,<br/>up to, circa, rund, etwa, knapp, über or bis zu, or a tilde, stands<br/>before it, a scale word records the significant digits written"]
        fC9["spelled numbers, English and German: ten to ninety always,<br/>two to nine only before a unit word, hundred never, skipped as part<br/>of a larger number: next to another number word, directly or joined<br/>by and or und, as in twenty-five or a hundred and twenty, or next<br/>to a digit, while twenty in drivers and twenty trucks still counts"]
        fCT["contentTokens: BM25 tokens without stopwords, folded, without<br/>words such as according, source, about or million,<br/>without tokens that contain a digit"]
    end
    subgraph sg_src["indexSource(excerpt, doc, heading): source mode, every reading"]
        fS0["version 2 only: version numbers first, read and masked<br/>as in claim mode, then the version reading of every<br/>d.m.yy triple left, which is still read as a date as well"]
        fS1["dates: full date, day and month, month and year, month,<br/>the year as a plain number, the day and month not,<br/>14.09. also as the number 14.09"]
        fS2["times with the hour as a number, weekdays,<br/>every full month name, no preposition needed"]
        fS3["codes, plus neighbouring word and number pairs:<br/>ISO 27001 and Q 3 index as ISO27001 and Q3"]
        fS4["numbers with both readings of 480.000, scaled and unscaled,<br/>number words anywhere, every number kept for approx"]
        fS5["content tokens, their first 5 letters, the folded<br/>word sequence, language en, de or null"]
    end
    fFold -.-> fC0
    fFold -.-> fS0
    fC0 --> fC1 --> fCV --> fC2 --> fC3 --> fC4 --> fC5 --> fC6
    fC6 --> fC7
    fC6 --> fC8
    fC6 --> fC9
    fS0 --> fS1 --> fS2 --> fS3 --> fS4 --> fS5
    fC9 --> fLook
    fS4 --> fLook
    fLook{"lookupFact(fact, index)"}
    fLook -->|"quote"| fQuote["exact when the folded phrase is in the word sequence,<br/>partial when 80 percent of its words are, else null"]
    fLook -->|"a reading of the fact is in the index"| fExact["exact"]
    fLook -->|"number without a matching reading"| fNum{"a source number within 5 percent while the statement<br/>says about, or equal once rounded to the digits<br/>written with a scale word, as 4.5 million for 4,480,000?"}
    fNum -->|"yes"| fApprox["approx, detail = the source number"]
    fNum -->|"no"| fNull["null"]
    fLook -->|"other kinds without a matching reading"| fNull
    fCT --> fTok
    fS5 --> fTok["tokenMatches(token, index): the same token, or 5 or more letters<br/>sharing a prefix of at least max(5, longer length minus 4),<br/>or a German compound: a token of 8 or more letters contains<br/>a long source token, or the reverse"]
    fTok --> fOver["overlap and names in checkSentence"]
    fS5 --> fLang["guessLanguage: words in only the English or only the German<br/>stopword list, umlauts and sharp s count for German,<br/>a one-sided signal, or at least 2 and twice the other, else null"]
    fLang --> fCross["statement language differs from every cited excerpt:<br/>facts only, so 28.08.2026 still matches August 28, 2026<br/>and 480.000 matches 480,000"]
```

<sub>Sources: [`src/js/core/facts.js`](../src/js/core/facts.js), [`src/js/core/grounding.js`](../src/js/core/grounding.js), [`src/js/core/labels.js`](../src/js/core/labels.js), [`src/js/rag/bm25.js`](../src/js/rag/bm25.js)</sub>

### Answer receipts: fingerprints, draft, dialog and download

A receipt relies on fingerprints taken when a file is added. The ingestion worker hashes the file bytes before parsing, because pdf.js detaches the buffer it reads, then hashes the extracted text and records the extractor and chunker ids and versions with the chunk size and overlap. After the source check, chat.js keeps a receipt draft in main-thread memory. The draft holds the answer, the question, the check report and, for each citation, its delivered state and excerpt, for a partly delivered excerpt how many of its first characters reached the model (deliveredChars), plus the document fingerprints and chunk offsets of workspace excerpts. Nothing is written to storage. The Receipt button opens the export dialog, which previews the receipt id, the Merkle root and the counts and lets the user leave out the question or the excerpt texts; without the excerpt texts, the passages and numbers that check reasons quote from them (found of fact_context, approximate, fact_elsewhere, negation_inversion and name_context) are left out too. Download builds the receipt again in the starpi.receipt/v2 format, keeping at most the first 20 reasons of each statement, puts one Merkle leaf per citation into a tree with an inclusion proof in each citation (receipts-merkle-signature), computes its id as the SHA-256 of the canonical JSON of everything but the id and a signature, and saves it as a JSON file on the device. The id changes with any edit to the contents, but whoever edits a receipt can compute a new id and a new tree: the app does not sign receipts, and anyone can write a well-formed receipt.

<!-- diagram: receipts-build-and-download -->
```mermaid
sequenceDiagram
    autonumber
    actor User
    participant WS as rag/workspace.js
    participant W as ingest.worker.js
    participant Chat as chat.js
    participant RV as rag/receipts.js
    participant RC as core/receipt.js
    participant B as Browser
    User->>WS: add a file, addToWorkspace(file)
    WS->>W: ingest request with the File
    W->>W: fileSha256 = sha256Hex of the file bytes, taken before parsing<br/>because pdf.js detaches the buffer it reads, null without<br/>crypto.subtle or above MAX_FILE_BYTES 25 MiB
    alt same fileSha256, chunk size and overlap already indexed
        W-->>WS: the existing document with duplicate true
    else new file
        W->>W: extractText gives text, kind, pages and the pdf.js version<br/>textSha256 = sha256Hex of the extracted text<br/>chunkText, size 500 and overlap 50 by default, exact offsets
        W-->>WS: DocumentInfo with bytes, fileSha256, textSha256, chars, pages,<br/>extractor starpi-extract 1 with pdfjs, chunker starpi-chunk 1 with size and overlap
    end
    Note over User,Chat: later an answer with citations is rendered and source-checked
    Chat->>RV: storeReceiptDraft with createdAt, APP_VERSION, answer text, engine,<br/>locale, question, grounding report or null and per citation label, doc,<br/>heading, source, delivered, deliveredChars = the length of the delivered<br/>part of a partial excerpt that starts the excerpt, excerpt text, truncated, knowledge documentId, workspace document fields<br/>found by span docId, chunk index, start, end
    RV->>RV: id r1, r2 and so on in a Map of at most 50 drafts,<br/>the oldest dropped, never stored
    RV-->>Chat: draft id
    Chat->>Chat: receiptButton(id) appended to .message-provenance,<br/>data-action open-receipt, label receipt.button
    User->>RV: Receipt button, open-receipt
    alt draft no longer in memory
        RV-->>User: nothing opens
    else draft found
        RV->>B: openDialog receiptModal in export mode, title receipt.title,<br/>receipt.proves and receipt.not_proves shown
        RV->>RC: preview, buildReceipt(draft, includeQuestion, includeExcerpts)
        RC-->>RV: receipt
        RV->>B: receiptId = first 16 hex chars of the id,<br/>receiptRoot = first 16 hex chars of merkle.root, a dash without one,<br/>receipt.counts with workspace and knowledge
    end
    User->>RV: toggle receiptIncludeQuestion or receiptIncludeExcerpts
    RV->>RC: preview again, a result overtaken by a newer preview is dropped
    User->>RV: download-receipt
    RV->>RC: buildReceipt(draft, options)
    RC->>RC: per citation excerpt sha256, excerpt text or null,<br/>verifiable = workspace with fileSha256 and chunk,<br/>chunk sha256 null when the excerpt was truncated,<br/>deliveredChars kept when the excerpt is partial and it is an integer
    RC->>RC: grounding with the report's algorithm, starpi-grounding 2,<br/>counts and statements without neutral ones, at most 20 reasons each,<br/>found of fact_context, approximate, fact_elsewhere, negation_inversion<br/>and name_context dropped without excerpt texts, question null when left out
    RC->>RC: schema starpi.receipt/v2 unless options.schema asks for v1:<br/>merkleTree over citationLeafHash of each citation, proof per citation,<br/>merkle with alg sha256-rfc6962, size and root
    RC->>RC: id = sha256Hex of canonicalJson of the body without id and signature,<br/>keys sorted, no whitespace, undefined members dropped,<br/>schema and id written first
    RC-->>RV: receipt
    RV->>B: Blob of JSON.stringify with 2-space indent, application/json,<br/>object URL, download name starpi-receipt-first 12 hex chars.json
    B-->>User: file saved on this device, object URL revoked after 1000 ms
```

<sub>Sources: [`src/js/rag/workspace.js`](../src/js/rag/workspace.js), [`src/js/rag/ingest.worker.js`](../src/js/rag/ingest.worker.js), [`src/js/rag/parser.js`](../src/js/rag/parser.js), [`src/js/rag/chunker.js`](../src/js/rag/chunker.js), [`src/js/chat.js`](../src/js/chat.js), [`src/js/rag/receipts.js`](../src/js/rag/receipts.js), [`src/js/core/receipt.js`](../src/js/core/receipt.js), [`src/js/core/merkle.js`](../src/js/core/merkle.js), [`src/js/core/hash.js`](../src/js/core/hash.js), [`src/index.html`](../src/index.html), [`src/locales/en.json`](../src/locales/en.json), [`docs/spec/receipts.md`](spec/receipts.md)</sub>

### Receipts v2: Merkle tree, inclusion proofs and signature

A starpi.receipt/v2 receipt puts its citations into a Merkle tree as RFC 6962 defines it for Certificate Transparency, with SHA-256. Each citation is one leaf, hashed from its canonical JSON without its proof and with the excerpt reduced to its hash and truncated flag, so a receipt exported without excerpt texts has the same root. Each citation carries its audit path, so one citation can be checked against the root without the others (verifyCitationProof). The id is the hash of everything but the id and the signature. A signature is optional and never made by the app: signReceipt in @starpi/core signs, with Ed25519 or ECDSA P-256 (ES256) through WebCrypto, a fixed prefix and the canonical JSON of the algorithm, the id, the key id and the Merkle record, and embeds the public key as a JWK; the key id is the SHA-256 of the key's SubjectPublicKeyInfo. Verifying recomputes the root and every proof, and checks the signature with the public key the verifier gives, or else with the embedded one, which shows only that the receipt is unchanged since it was signed, not who signed it. A v1 receipt has no tree and no signature.

<!-- diagram: receipts-merkle-signature -->
```mermaid
flowchart TD
    subgraph sg_build["buildReceipt, schema starpi.receipt/v2 unless v1 is asked for"]
        bLeaf["citationLeafHash per citation, in answer order: canonicalJson of the<br/>citation without proof, its excerpt reduced to sha256 and truncated,<br/>merkleLeafHash = SHA-256 of the byte 0x00 and that UTF-8 text"]
        bTree["merkleTree, RFC 6962: an interior node is SHA-256 of the byte 0x01,<br/>the left and the right hash; a range of more than 1 leaf is split<br/>at the largest power of two below its size;<br/>no citations: SHA-256 of the empty string"]
        bProof["proof in each citation: its audit path from the sibling up to<br/>the child of the root, at most RECEIPT_LIMITS.proof 6 hashes"]
        bHead["merkle = alg sha256-rfc6962, size = number of citations, root;<br/>id = sha256Hex of canonicalJson without id and signature"]
        bLeaf --> bTree --> bProof --> bHead
    end
    bProof -.-> bOne["verifyCitationProof(citation, index, merkle):<br/>one citation, also without its excerpt text,<br/>checked against the root without the others"]
    subgraph sg_sign["signReceipt(receipt, privateKey, publicKey?), outside the app"]
        sChk{"schema v2 with merkle, and the id and the root<br/>and size recomputed from the contents match?"}
        sKey{"private CryptoKey Ed25519 or ECDSA P-256, and a public key<br/>given or exported from the extractable private key,<br/>for the same algorithm?"}
        sMsg["keyId = SHA-256 of the public key's SPKI in DER;<br/>signed bytes = UTF-8 of starpi.receipt/v2 signature, a line break<br/>and canonicalJson of alg, id, keyId and merkle"]
        sVal{"crypto.subtle.sign, then crypto.subtle.verify<br/>with the public key accepts the value?"}
        sOut["signature: alg Ed25519 or ES256, keyId, publicKey as a JWK<br/>with kty, crv, x and for ES256 y, value base64url of the<br/>64-byte signature, r then s for ES256; signing again replaces it"]
        sChk -->|"yes"| sKey
        sKey -->|"yes"| sMsg --> sVal
        sVal -->|"yes"| sOut
    end
    bHead -.->|"optional"| sChk
    sChk -->|"no"| sErr(["error thrown, nothing signed"])
    sKey -->|"no"| sErr
    sVal -->|"no"| sErr
    subgraph sg_ver["verifyReceipt(receipt, files, tools, publicKey?)"]
        vV2{"schema starpi.receipt/v2?"}
        vTree["leaves and tree recomputed: rootMatches when the root and the<br/>number of citations equal merkle.root and merkle.size,<br/>proof per citation = verifyMerkleProof(leaf, index, size, proof, root),<br/>the algorithm of RFC 9162, validProofs = how many lead to the root"]
        vSig{"signature present?"}
        vAlg{"alg Ed25519 or ES256?"}
        vImp{"importPublicKey of the given key, else of the embedded JWK?"}
        vGiven{"a key given by the verifier?"}
        vKid{"same algorithm, and the SHA-256 of its SPKI<br/>equals signature.keyId?"}
        vVal{"value decodes to 64 bytes, and crypto.subtle.verify<br/>accepts it over the signed bytes?"}
        vSame{"verifyReceiptSignature: the id and the Merkle root<br/>recomputed from the contents still match?"}
        vV2 -->|"yes"| vTree --> vSig
        vSig -->|"yes"| vAlg
        vAlg -->|"yes"| vImp
        vImp -->|"imported"| vGiven
        vGiven -->|"yes"| vKid
        vVal -->|"yes"| vSame
    end
    sOut -.->|"signed receipt"| vV2
    bHead -.->|"unsigned receipt"| vV2
    vV2 -->|"no, v1"| rV1(["merkle and signature null, proof null per citation"])
    vSig -->|"no"| rUns(["unsigned"])
    vAlg -->|"no"| rAlg(["unsupported_algorithm"])
    vImp -->|"NotSupportedError, e.g. no Ed25519 in this browser"| rAlg
    vImp -->|"other error with the embedded key"| rInv(["invalid, trusted false"])
    vImp -->|"other error with a given key"| rThrow(["thrown; the worker and verify-receipt.mjs<br/>import the key first: invalidKey or exit 2"])
    vGiven -->|"no"| vKidE{"embedded key: same algorithm, and the SHA-256<br/>of its SPKI equals signature.keyId?"}
    vKid -->|"no"| rMis(["key_mismatch"])
    vKid -->|"yes"| vVal
    vKidE -->|"yes"| vVal
    vKidE -->|"no"| rInv
    vVal -->|"no"| rInv
    vSame -->|"no"| rInv
    vSame -->|"yes, a given key"| rTrust(["valid, trusted: signed with the verifier's key"])
    vSame -->|"yes, the embedded key"| rEmb(["valid, not trusted: unchanged since signing,<br/>not who signed"])
    rShow["shown by renderReport: receipt.merkle_ok or merkle_failed with<br/>valid of n proofs, check_proof_invalid per failed proof, format_v1,<br/>signature_trusted, signature_embedded, signature_key_mismatch,<br/>signature_invalid, signature_unsupported, signature_unsigned, or<br/>signature_unsigned_key when a key was chosen; verify-receipt.mjs<br/>exits 1 unless the root and every proof are valid, the status is<br/>valid or unsigned, and, with --public-key, valid and trusted"]
    vTree -.- rShow
```

<sub>Sources: [`src/js/core/receipt.js`](../src/js/core/receipt.js), [`src/js/core/merkle.js`](../src/js/core/merkle.js), [`src/js/core/signature.js`](../src/js/core/signature.js), [`src/js/core/hash.js`](../src/js/core/hash.js), [`src/js/rag/receipts.js`](../src/js/rag/receipts.js), [`src/js/rag/ingest.worker.js`](../src/js/rag/ingest.worker.js), [`scripts/verify-receipt.mjs`](../scripts/verify-receipt.mjs), [`src/locales/en.json`](../src/locales/en.json), [`docs/spec/receipts.md`](spec/receipts.md)</sub>

### Deterministic citation verification and receipt flow

The verification pipeline links an on-screen answer back to source file bytes through four deterministic layers (L0 to L3). During ingestion, `chunkText` records exact UTF-16 code unit offsets `[start, end]` alongside `fileSha256` and `textSha256`. After the answer is rendered, `applyGrounding` runs `groundAnswer`, which compares the facts of each statement (`extractFacts`) with the cited excerpts (`indexSource`) and, with rules version 2, checks negations, names and values in another place (`checkV2`), without a second model. chat.js keeps the result in a receipt draft; to export it, `buildReceipt` records citation offsets and source-check findings, puts one leaf per citation into an RFC 6962 Merkle tree, serializes the receipt as canonical JSON (keys sorted by UTF-16 code units, no whitespace, undefined members dropped, which for the strings, integers, booleans, nulls, arrays and objects of a receipt equals RFC 8785) and computes `id = sha256Hex(canonicalJson(body))` over everything but the id and a signature. During verification, in the ingestion worker or in scripts/verify-receipt.mjs, `validateReceipt` checks the structure against strict limits before anything is read, and `verifyReceipt` recomputes the Merkle root, the inclusion proofs and any signature, identifies source files by hash rather than file name, checks each passage against the original text and recomputes the verdicts with the rules version the receipt records.

<!-- diagram: citation-verification-receipt-flow -->
```mermaid
sequenceDiagram
    autonumber
    participant UI as chat.js and rag/receipts.js
    participant GW as rag/grounding-view.js
    participant CG as core/grounding.js
    participant CR as core/receipt.js
    participant VR as ingest.worker.js or verify-receipt.mjs
    Note over UI,CG: 1. Answer and source check
    UI->>GW: applyGrounding(messageEl, { scope, sources, given, citedOnly })
    GW->>CG: groundAnswer(blocks from the rendered DOM, sources, { given, citedOnly })
    CG->>CG: associate markers with statements, extractFacts (strict claims), indexSource (lenient excerpts)
    CG->>CG: checkSentence per statement, with version 2 also checkV2, verdicts supported, weak, unsupported or unchecked
    CG-->>GW: GroundingReport (algorithm starpi-grounding 2, counts, statements, reasons)
    GW-->>UI: report, kept with storeReceiptDraft
    Note over UI,CR: 2. Receipt assembly
    UI->>CR: buildReceipt(draft, { includeQuestion, includeExcerpts }) for the preview and the download
    CR->>CR: anchor citations with document fingerprints and chunk offsets [start, end]
    CR->>CR: Merkle tree with one leaf per citation, a proof in each citation, merkle root
    CR->>CR: canonicalJson(body without id and signature), id = sha256Hex of it
    CR-->>UI: starpi.receipt/v2 JSON, not signed by the app
    Note over UI,VR: 3. Four-tier deterministic verification
    UI->>VR: verifyReceiptFiles(receipt, files, publicKey) from the receipt dialog, or the command line
    VR->>CR: validateReceipt: schema v2 or v1, bounds, allowed members and reason codes
    VR->>CR: verifyReceipt(receipt, files, { extract, extractor }, { publicKey })
    CR->>CR: v2 only: Merkle root and inclusion proofs recomputed, signature status
    CR->>CR: L0 File Check: sha256Hex(fileBytes) == document.fileSha256
    CR->>CR: L1 Text Check: sha256Hex(extractedText) == document.textSha256
    CR->>CR: L2 Passage Check: extractedText.slice(start, end) hashes to chunk.sha256, or excerpt.sha256
    CR->>CR: L3 Chunk Check: chunkText(text, size, overlap) reproduces [start, end]
    CR->>CG: checkSentence per recorded statement, with the rules version the receipt records
    CR-->>VR: VerifyReport (idMatches, merkle, signature, L0 to L3 per citation, reproduced of verifiable)
    VR-->>UI: renderReport in the dialog, or the command-line report and exit code
```

<sub>Sources: [`src/js/core/receipt.js`](../src/js/core/receipt.js), [`src/js/core/grounding.js`](../src/js/core/grounding.js), [`src/js/core/facts.js`](../src/js/core/facts.js), [`src/js/core/merkle.js`](../src/js/core/merkle.js), [`src/js/core/hash.js`](../src/js/core/hash.js), [`src/js/rag/chunker.js`](../src/js/rag/chunker.js), [`src/js/rag/grounding-view.js`](../src/js/rag/grounding-view.js), [`src/js/rag/receipts.js`](../src/js/rag/receipts.js), [`src/js/rag/ingest.worker.js`](../src/js/rag/ingest.worker.js), [`src/js/chat.js`](../src/js/chat.js), [`scripts/verify-receipt.mjs`](../scripts/verify-receipt.mjs), [`docs/spec/receipts.md`](spec/receipts.md)</sub>

### Re-checking a receipt in the app and on the command line

A receipt can be re-checked in the receipt dialog, where the ingestion worker does the work, or with scripts/verify-receipt.mjs in Node, which runs the same core/receipt.js, extraction and chunking code. Both read starpi.receipt/v2 and v1 receipts, validate the receipt before reading any source file, refusing members and reason codes its format does not define, accept an optional public key of the signer, and match the given files by SHA-256, never by name. For a v2 receipt verifyReceipt first recomputes the Merkle root and every inclusion proof and checks the signature, if there is one (receipts-merkle-signature). For each workspace citation verifyReceipt checks four levels: L0 a file with the recorded fingerprint, L1 the recorded text fingerprint after extraction, L2 the passage at the recorded offsets (moved when the excerpt occurs elsewhere once whitespace is collapsed), and L3 the chunk bounds that chunking gives today. Knowledge-base citations are listed as not verifiable and never counted as reproduced. The source check is then recomputed from the receipt's excerpts, for a partly delivered excerpt on its first deliveredChars characters, with the rules version the receipt records (version 1 for receipts of Starpi 1.x, version 2 for this release; an unknown id or version is recomputed with the current rules and a warning), and compared with the recorded verdicts; a statement is skipped when an excerpt it cites, or one a reason names as the other place of a value, has no usable text. A full match shows only that the cited excerpts can be reproduced from these files under the recorded rules; it does not show what a model saw or that the answer is right, and it shows who wrote the receipt only for a receipt signed with the public key the verifier supplied.

<!-- diagram: receipts-verify -->
```mermaid
flowchart TD
    subgraph sg_app["In the app"]
        rA0(["receipt dialog, opened by open-receipt-verify in the workspace<br/>panel or by a Receipt button, verify-receipt: receiptFile,<br/>the files chosen in receiptSources and an optional<br/>public key in receiptPublicKey"])
        rA1{"receipt chosen, at most RECEIPT_LIMITS.bytes<br/>2000000, JSON.parse succeeds, a key file<br/>at most MAX_KEY_BYTES 16384?"}
        rA2["receipt.verify_need_receipt, receipt.verify_invalid<br/>with reason size or JSON, or receipt.verify_bad_key<br/>with reason size"]
        rA3["receipt.verify_running, verifyReceiptFiles sends verify-receipt<br/>with the key file's text to the ingest worker,<br/>a rejection shows receipt.verify_invalid with its message"]
        rAK{"no key text, or importPublicKey in the worker reads it?"}
        rAK2["reply invalidKey: receipt.verify_bad_key<br/>with the error message"]
        rA4["worker reads the first MAX_VERIFY_FILES 20 files,<br/>files above MAX_FILE_BYTES skipped"]
    end
    subgraph sg_cli["Command line"]
        rB0(["node scripts/verify-receipt.mjs receipt.json file ...<br/>--public-key key --json, npm run verify:receipt,<br/>or starpi-verify-receipt from @starpi/core,<br/>the same script bundled, Node 22.13 or later"])
        rB1{"options known, receipt path given, readable,<br/>at most 2000000 bytes and JSON?"}
        rB2(["usage message on stderr, exit 2"])
        rBK{"no --public-key, or importPublicKey reads<br/>the file as a JWK or PEM public key?"}
        rB3{"every file path readable?"}
        rB4["files named by basename"]
    end
    rA0 --> rA1
    rA1 -->|"no"| rA2
    rA1 -->|"yes"| rA3
    rB0 --> rB1
    rB1 -->|"no"| rB2
    rA3 --> rVal
    rB1 -->|"yes"| rVal
    rVal{"validateReceipt: schema starpi.receipt/v2 or v1, only the members<br/>of that format, field types, SHA-256 hex, at most 64 citations,<br/>500 statements of at most 20,000 chars, 20 reasons each with a code<br/>from REASON_CODES, for v1 from REASON_CODES_V1, labels and document<br/>names at most 600 chars, other strings bounded, deliveredChars only<br/>on a partial excerpt, the four counts as integers, citation indexes<br/>in range; v2: merkle alg, size and root, a proof of at most<br/>6 hashes per citation, an optional signature of the defined form?"}
    rVal -->|"no: unsupported_version, not_a_receipt,<br/>or the first bad field with its path"| rInv["app: receipt.verify_invalid with error and path,<br/>CLI: not a valid Starpi receipt"]
    rInv -.->|"CLI"| rB2
    rVal -->|"yes, app"| rAK
    rAK -->|"no"| rAK2
    rAK -->|"yes"| rA4
    rVal -->|"yes, CLI"| rBK
    rBK -->|"no"| rB2
    rBK -->|"yes"| rB3
    rB3 -->|"no"| rB2
    rB3 -->|"yes"| rB4
    rA4 --> rVR
    rB4 --> rVR
    rVR["verifyReceipt with extractText and EXTRACTOR of rag/parser.js<br/>and the public key: idMatches = hash of canonicalJson without id<br/>and signature equals id, answerMatches = the answer text hashes<br/>to answer.sha256, for v2 the Merkle root, a proof flag per citation<br/>and the signature status, see receipts-merkle-signature,<br/>files keyed by the SHA-256 of their bytes, not by name"]
    rVR --> rEx["per citation: excerptConsistent when the excerpt text hashes to<br/>excerpt.sha256, null without text, false adds a warning"]
    rEx --> rWs{"workspace citation with a document,<br/>a chunk and a fileSha256?"}
    rWs -->|"no, e.g. a knowledge-base excerpt"| rNV["file not_verifiable"]
    rWs -->|"yes"| rL0{"L0 file: a given file with that fingerprint?"}
    rL0 -->|"no"| rMiss["file missing"]
    rL0 -->|"yes"| rRead["file match, extracted once per fingerprint, the file type<br/>taken from the recorded kind, not from the file name,<br/>an extraction error becomes a warning and ends this citation"]
    rRead --> rVer["extractor id or version differ, or both pdf.js versions are<br/>known and differ: warning that names both versions"]
    rVer --> rL1["L1 text: SHA-256 equals textSha256: match,<br/>else version_differs when the versions differ, else mismatch"]
    rL1 --> rL2{"L2 passage: the text from start to end hashes to chunk.sha256,<br/>or to excerpt.sha256 when that is null?"}
    rL2 -->|"yes"| rPM["passage match"]
    rL2 -->|"no, but the consistent excerpt occurs in<br/>the text once whitespace is collapsed"| rPMo["passage moved"]
    rL2 -->|"no"| rPMm["passage mismatch"]
    rPM --> rL3
    rPMo --> rL3
    rPMm --> rL3
    rL3["L3 chunk: chunkText with the recorded size and overlap gives the<br/>same bounds at chunk.index: match, else version_differs when<br/>the chunker id or version changed, else mismatch"]
    rNV --> rSum
    rMiss --> rSum
    rL3 --> rSum
    rSum["reproduced = passages that match,<br/>verifiable = citations marked verifiable"]
    rSum --> rG["with a grounding record: the recorded version when the id is<br/>starpi-grounding and GROUNDING_VERSIONS 1 and 2 has it, else<br/>version 2 and a warning naming both, checkSentence per recorded<br/>statement with that version on the consistent excerpt texts,<br/>else on the matching passage of an excerpt neither omitted nor truncated,<br/>for a partial excerpt only its first deliveredChars, none without that field,<br/>given = the recorded question, a statement skipped when an excerpt<br/>it cites or a reason names in other has no text, differing verdicts listed,<br/>needsConversation when a reason is from_conversation"]
    rG --> rOut{"where?"}
    rOut -->|"app"| rApp["renderReport: receipt.summary, id and answer lines,<br/>merkle_ok, merkle_failed or format_v1, the signature line,<br/>check_knowledge, check_file, check_passage, check_text<br/>and check_chunk lines, check_proof_invalid per failed proof,<br/>grounding_same or grounding_differs,<br/>grounding_conversation, warnings as plain text"]
    rOut -->|"CLI"| rCli["ok or FAIL lines for the hashes, the Merkle root and the<br/>signature, n/a for format v1, one ok, FAIL or n/a line per citation<br/>with inclusion proof invalid where it fails, reproduced of verifiable,<br/>recomputed verdicts and warn lines, control and bidi characters<br/>in receipt strings, file names and warnings shown escaped, or with<br/>--json one JSON object with ok, receipt id and the report"]
    rCli --> rExit{"id and answer match, every workspace citation<br/>has file match and passage match, no excerpt<br/>contradicts its fingerprint, root and every proof valid,<br/>signature valid or unsigned, and valid and trusted<br/>when --public-key was given?"}
    rExit -->|"yes"| rE0(["exit 0"])
    rExit -->|"no, moved and missing included"| rE1(["exit 1"])
```

<sub>Sources: [`src/js/rag/receipts.js`](../src/js/rag/receipts.js), [`src/js/rag/workspace.js`](../src/js/rag/workspace.js), [`src/js/rag/ingest.worker.js`](../src/js/rag/ingest.worker.js), [`src/js/core/receipt.js`](../src/js/core/receipt.js), [`src/js/core/signature.js`](../src/js/core/signature.js), [`src/js/core/merkle.js`](../src/js/core/merkle.js), [`src/js/core/grounding.js`](../src/js/core/grounding.js), [`src/js/rag/parser.js`](../src/js/rag/parser.js), [`src/js/rag/chunker.js`](../src/js/rag/chunker.js), [`scripts/verify-receipt.mjs`](../scripts/verify-receipt.mjs), [`packages/core/package.json`](../packages/core/package.json), [`package.json`](../package.json), [`src/locales/en.json`](../src/locales/en.json)</sub>

### starpi-ground: from arguments to exit code

starpi-ground (scripts/ground.mjs, packaged as the starpi-ground command of @starpi/core) runs the source check on a Markdown document, such as an answer, release notes or generated documentation, against source files, for scripts and CI. It reads the sources the way the app does (Markdown, text, CSV, logs and JSON, PDF when the optional pdfjs-dist is installed), chunks them with the app's chunker and labels each chunk like a workspace excerpt, with the relative path instead of the file name when two files share a name. checkDocument compares each statement with the excerpts its citation labels name or, in a document without labels, with every excerpt; it splits a document above the source check's limits at headings, and then between blocks, into sections that each fit, and reports a part that still does not fit as not checked, never as passed. The report is text, JSON or SARIF 2.1.0 for code scanning, and the exit code says whether a statement reached the --fail-on level. As in the app, a finding means: open the source and check; a pass does not prove the document correct.

<!-- diagram: source-check-ground-cli -->
```mermaid
flowchart TD
    gArgs(["starpi-ground from @starpi/core, or node scripts/ground.mjs:<br/>--answer file.md, --source file or directory, repeatable,<br/>--format text, json or sarif, --output file,<br/>--fail-on unsupported, weak or never, --cite auto, labels or all,<br/>each as --name value or --name=value"])
    gArgs --> gHelp{"--help or -h, else --version, anywhere?"}
    gHelp -->|"yes"| gInfo(["the usage line, or the version of<br/>packages/core/package.json, on stdout, exit 0"])
    gHelp -->|"no"| gParse{"every argument known and with a non-empty value,<br/>format, fail-on and cite one of their choices,<br/>--answer and at least one --source given?"}
    gParse -->|"no"| gUsage(["starpi-ground: the reason and the usage line<br/>on stderr, exit 2"])
    gParse -->|"yes"| gRead{"the answer readable as UTF-8, each source a file of a<br/>SUPPORTED_EXTENSIONS type or a directory, at least one<br/>supported file, each readable, at most MAX_FILE_BYTES 25 MiB,<br/>and extractText succeeds on it?"}
    gRead -->|"no"| gUsage
    gRead -->|"yes"| gSrc["CRLF in the answer made LF; a directory adds its supported files<br/>below it, sorted by name, hidden entries and node_modules skipped,<br/>a file named twice read once; extractText as in the app, chunkText<br/>500 and 50, one source per chunk labelled Doc: file name, Chunk: n,<br/>the relative path when two files share a name, delivered full"]
    gSrc --> gDoc["checkDocument: blocksFromMarkdown, one block per non-empty line<br/>with its line number, labels of the sources as cite segments, other<br/>label-like text as badcite; mode labels with --cite labels, or with<br/>auto when the document has a label, else all: one more block<br/>citing every excerpt"]
    gDoc --> gFit{"all blocks within THRESHOLDS.maxChars 20000 characters<br/>and maxSentences 300 statements?"}
    gFit -->|"yes"| gOne["one section"]
    gFit -->|"no"| gSplit["units from heading to heading packed into sections<br/>while they fit, a unit that does not fit split between<br/>blocks, answer-wide Sources lines added to every section"]
    gOne --> gGround
    gSplit --> gGround
    gGround["groundAnswer per section with the current rules, version 2;<br/>a section it skips as too_long recorded with its first and last line,<br/>else every statement that is not neutral counted, with its line<br/>and its column in UTF-16 code units"]
    gGround --> gFmt{"--format?"}
    gFmt -->|"text, the default"| gText["per weak or unsupported statement: path:line:column, the verdict<br/>and the statement cut to 200 chars, one describeReason line per<br/>reason; a not checked line per skipped part; the counts; a note<br/>when statements were compared across languages; control and<br/>bidi characters escaped"]
    gFmt -->|"json"| gJson["ok, tool, answer, mode, algorithm, the files with their<br/>chunk counts, sections, counts, skipped and every statement<br/>with line, column, verdict, cited labels and reasons<br/>with their message"]
    gFmt -->|"sarif"| gSarif["toSarif: SARIF 2.1.0, columnKind utf16CodeUnits, one rule per<br/>reason code plus too_long, one result per weak statement, level<br/>warning, and per unsupported one, level error, ruleId = its first<br/>unsupported reason, else its first, startLine and startColumn,<br/>partialFingerprints starpiStatement/v1 = SHA-256 of rule id and<br/>statement; an error result too_long per skipped part"]
    gText --> gOut
    gJson --> gOut
    gSarif --> gOut
    gOut{"--output given?"}
    gOut -->|"no"| gStdout["report on stdout"]
    gOut -->|"yes"| gWrite{"file written?"}
    gWrite -->|"no"| gUsage
    gWrite -->|"yes"| gFail
    gStdout --> gFail
    gFail{"--fail-on never, or no skipped part and no unsupported<br/>statement, and with --fail-on weak no weak one either?"}
    gFail -->|"yes"| gE0(["exit code 0"])
    gFail -->|"no"| gE1(["exit code 1"])
```

<sub>Sources: [`scripts/ground.mjs`](../scripts/ground.mjs), [`src/js/core/document.js`](../src/js/core/document.js), [`src/js/core/sarif.js`](../src/js/core/sarif.js), [`src/js/core/grounding.js`](../src/js/core/grounding.js), [`src/js/core/labels.js`](../src/js/core/labels.js), [`src/js/rag/parser.js`](../src/js/rag/parser.js), [`src/js/rag/chunker.js`](../src/js/rag/chunker.js), [`scripts/build-core.mjs`](../scripts/build-core.mjs), [`packages/core/package.json`](../packages/core/package.json), [`tests/unit/ground.test.mjs`](../tests/unit/ground.test.mjs)</sub>

### Sample files and the source-check demo

The sample files describe a fictitious project (plan, risk register and kickoff notes). They are same-origin static files under public/samples, in German when the interface language is German and in English otherwise. loadSamples fetches each file and adds it to the on-device workspace like a dropped file, skipping names that are already there; nothing is uploaded. The three suggested questions search only the workspace and always run in verified source mode, switching the chat mode toggle to it. The check demo shows a fixed answer that states one wrong number, labelled as written for the demo and not generated, with citations that point at the real sample chunks, and runs the same source check on it. Its language follows the sample set that is in the workspace, preferring the interface language, and it is neither stored nor given a receipt.

<!-- diagram: sample-files-demo -->
```mermaid
flowchart TD
    dBtn(["load-samples: button in the welcome card<br/>or in the on-device workspace panel"]) --> dBusy{"loading already?"}
    dBusy -->|"yes"| dIgnore["ignored"]
    dBusy -->|"no"| dStart["loading = true, switchTab chat,<br/>info notice demo.loading, demo.loading_body"]
    dStart --> dLoc{"getLocale is de?"}
    dLoc -->|"yes"| dDe["samples/de: nebula-projektplan.md,<br/>nebula-risiken.csv, nebula-kickoff.pdf"]
    dLoc -->|"no"| dEn["samples/en: nebula-plan.md,<br/>nebula-risks.csv, nebula-kickoff.pdf"]
    dDe --> dEach
    dEn --> dEach
    dEach{"next file: a workspace document<br/>with that name already?"}
    dEach -->|"yes, skipped"| dMore
    dEach -->|"no"| dFetch{"fetch /samples/path from the same origin,<br/>res.ok?"}
    dFetch -->|"no, Error HTTP status"| dErr
    dFetch -->|"yes"| dAdd["addToWorkspace(new File from the blob), type text/markdown,<br/>text/csv or application/pdf by extension"]
    dAdd --> dDup{"ingest worker: same fileSha256 and<br/>chunk settings already indexed?"}
    dDup -->|"yes"| dDupR["duplicate true, not listed twice"]
    dDup -->|"no"| dIdx["parsed, chunked and indexed in worker memory,<br/>nothing uploaded"]
    dAdd -.->|"rejects"| dErr
    dDupR --> dMore
    dIdx --> dMore
    dMore{"more files?"}
    dMore -->|"yes"| dEach
    dMore -->|"no"| dReady["notice becomes demo.loaded_title,<br/>demo.loaded_body with the three names"]
    dErr["notice becomes demo.error_title,<br/>demo.error_body with the reason"]
    dReady --> dQs["buttons demo.q_launch, demo.q_budget, demo.q_risks:<br/>quick-prompt, data-arg key_question, data-scope workspace,<br/>and demo.check with data-action demo-check"]
    dReady --> dFin(["loading = false"])
    dErr --> dFin
    dQs -->|"a question"| dAsk["submitChat(t(key_question), workspaceOnly true,<br/>chatMode grounded: the toggle switches to it)"]
    dAsk --> dRet["retrieve: workspace hits only,<br/>the knowledge base is not searched"]
    dRet --> dAns(["answer in the active mode with citations,<br/>source check and Receipt button"])
    dQs -->|"demo.check"| dShow["showCheckDemo: language = the first sample set whose three<br/>files are all in the workspace, the interface language first,<br/>else the interface language"]
    dShow --> dFind["searchWorkspace(t of demo.flawed_find_budget, _meeting and<br/>_launch in that language, top 5), first hit from a file of that set each"]
    dFind --> dFound{"all three found?"}
    dFound -->|"no"| dMissing(["warn notice demo.check_missing"])
    dFound -->|"yes"| dCit["hits deduplicated by docId and chunkIndex, workspaceHit,<br/>assignCitations with excerptChars 1600,<br/>registerCitations, no scope: nothing shown"]
    dCit --> dMsg["user message demo.check, assistant message demo.flawed_answer<br/>in that language with the three labels escaped, badge<br/>demo.flawed_badge: written for this demo, not generated"]
    dMsg --> dText["fixed text: budget 520,000 EUR, 520.000 € in German, where the<br/>plan says 480,000, steering group every Tuesday at 10:00,<br/>public launch 12 May 2027"]
    dText --> dCheck["applyGrounding: every excerpt delivered full,<br/>no given, citedOnly off"]
    dCheck --> dResult(["2/3 statements match, 520,000 is not in the cited plan excerpt:<br/>missing_fact, unsupported, panel opened, one flagged citation chip,<br/>one highlight where supported, no receipt draft, nothing persisted"])
```

<sub>Sources: [`src/js/demo.js`](../src/js/demo.js), [`src/index.html`](../src/index.html), [`src/js/chat.js`](../src/js/chat.js), [`src/js/rag/workspace.js`](../src/js/rag/workspace.js), [`src/js/rag/ingest.worker.js`](../src/js/rag/ingest.worker.js), [`src/js/retrieval.js`](../src/js/retrieval.js), [`src/js/rag/citations.js`](../src/js/rag/citations.js), [`src/js/rag/grounding-view.js`](../src/js/rag/grounding-view.js), [`public/samples/en/nebula-plan.md`](../public/samples/en/nebula-plan.md), [`public/samples/de/nebula-projektplan.md`](../public/samples/de/nebula-projektplan.md), [`src/locales/en.json`](../src/locales/en.json), [`src/locales/de.json`](../src/locales/de.json), [`tests/e2e/trust.spec.mjs`](../tests/e2e/trust.spec.mjs)</sub>

## 13. NVIDIA cloud proxy

NVIDIA mode answers through Starpi's own proxy: two Vercel Functions under api/ (on an operator's own host served by node scripts/serve.mjs --functions) keep a pool of NVIDIA API keys in the server environment, accept chat requests only from the app's own pages, check every request against one shared model allowlist and fixed limits, and relay NVIDIA's event stream to the browser, moving to the next key until one delivers the first byte. The browser never holds a key and sends none. The proxy keeps no conversation and logs no request or answer content: its log lines name a key by its index, with a status or a cooldown, and count malformed key entries. The per-IP limit and the key cooldowns live in one function instance or one server process, so they are best effort, and the Origin check stops other websites' pages, not scripts that forge headers.

### NVIDIA proxy: request guards and limits

Each route file exports its handler (POST for the chat route, GET for the models route) and, for the other common methods (GET or POST, PUT, PATCH, DELETE and OPTIONS), an answer of 405 method_not_allowed with Allow. POST /api/chat/nvidia then runs handleChat, whose guards come in a fixed order, each refusing with a flat JSON body {error, field?} that carries Cache-Control no-store and nosniff. A request whose Origin is listed in NVIDIA_ALLOWED_ORIGINS passes the origin check; otherwise a Sec-Fetch-Site other than same-origin gives 403 cross_site_request, a missing Origin 403 origin_required, and an Origin whose host differs from the request's Host (X-Forwarded-Host first, as the platform sets it) 403 origin_not_allowed. Next a fixed one-minute window per client address (x-real-ip, else the first X-Forwarded-For entry) allows NVIDIA_RATE_LIMIT_PER_MINUTE requests, 20 by default, and answers 429 rate_limited with Retry-After; without a valid key in NVIDIA_API_KEYS the route answers 503 nvidia_not_configured before it reads any body. The body is read with a 256 KiB cap: a declared size above the cap gives 413 before the media type is checked (415 unless application/json), then the bytes actually read are capped (413), decoded as strict UTF-8 and parsed (400 invalid_json), and must be an object (400 json_body_must_be_object). validateChatRequest accepts only an allowlisted model (400 model_not_allowed), 1 to 40 messages with role system (first only), user or assistant and string content of at most 24,000 UTF-16 code units each and 64,000 in all, the last one a non-blank user message, an integer max_tokens of at least 1, a temperature from 0 to 2 and a top_p above 0 up to 1 (400 invalid_field with the field otherwise). The upstream body is built from these fields alone: the model's fixed upstream extras first (for the default model, thinking switched off), then model, the messages with role and content only, max_tokens capped at the model's maxOutputTokens, stream true and the optional temperature and top_p, so tools, n, stop, stream settings and every other client field are dropped. GET /api/models/nvidia answers the public catalog and whether keys are configured, and never a key or a key count.

<!-- diagram: nvidia-proxy-guards -->
```mermaid
flowchart TD
    Req(["request to api/chat/nvidia.js or api/models/nvidia.js<br/>on Vercel or serve.mjs --functions"])
    Meth{"method of the request"}
    E405["405 method_not_allowed, Allow POST or GET,<br/>exported for the other common methods"]
    Models["GET /api/models/nvidia: handleModels,<br/>publicCatalog(router not null): configured, version,<br/>defaultModel, limits, models without upstream extras"]
    Req --> Meth
    Meth -->|"another method"| E405
    Meth -->|"GET on the models route"| Models
    Meth -->|"POST on the chat route"| Allowed

    Allowed{"Origin is listed in<br/>NVIDIA_ALLOWED_ORIGINS?"}
    Site{"Sec-Fetch-Site present<br/>and not same-origin?"}
    HasOrigin{"Origin header present?"}
    SameHost{"Origin is http or https and its host<br/>equals X-Forwarded-Host, else Host?"}
    E403a["403 cross_site_request"]
    E403b["403 origin_required"]
    E403c["403 origin_not_allowed"]
    Allowed -->|"yes"| Rate
    Allowed -->|"no"| Site
    Site -->|"yes"| E403a
    Site -->|"no"| HasOrigin
    HasOrigin -->|"no"| E403b
    HasOrigin -->|"yes"| SameHost
    SameHost -->|"no"| E403c
    SameHost -->|"yes"| Rate

    Rate{"limiter.hit(client address):<br/>x-real-ip, else the first X-Forwarded-For entry,<br/>more than NVIDIA_RATE_LIMIT_PER_MINUTE, default 20,<br/>in this one-minute window of this instance?"}
    E429["429 rate_limited,<br/>Retry-After until the window ends"]
    Keys{"a router exists: NVIDIA_API_KEYS holds at least<br/>one key of nvapi- and 64 characters?"}
    E503["503 nvidia_not_configured"]
    Rate -->|"yes"| E429
    Rate -->|"no"| Keys
    Keys -->|"no"| E503
    Keys -->|"yes"| Body

    Body{"readJsonBody, cap 262144 bytes:<br/>declared Content-Length within the cap,<br/>media type application/json,<br/>bytes read within the cap, strict UTF-8,<br/>JSON.parse ok, an object?"}
    E4xx["413 payload_too_large, 415 unsupported_media_type,<br/>400 invalid_json or json_body_must_be_object"]
    Body -->|"no"| E4xx
    Body -->|"yes"| Valid

    Valid{"validateChatRequest: model is a string<br/>and in the allowlist, 1 to 40 messages,<br/>system only first, 24000 code units each,<br/>64000 in all, last one a non-blank user message,<br/>max_tokens an integer of 1 or more,<br/>temperature 0 to 2, top_p above 0 up to 1?"}
    E400["400 model_not_allowed, or<br/>400 invalid_field with the field"]
    Upstream["upstream body: model upstream extras first,<br/>then model, messages with role and content only,<br/>max_tokens = min(requested or defaultMaxTokens,<br/>model maxOutputTokens, 4096), stream true,<br/>temperature and top_p when given, nothing else"]
    Valid -->|"no"| E400
    Valid -->|"yes"| Upstream
    Upstream --> Router(["router.open, see nvidia-proxy-failover"])

    Refuse["every refusal: flat JSON error and field,<br/>Content-Type application/json, Cache-Control no-store,<br/>nosniff, Retry-After on 429 and 503"]
    E429 -.- Refuse
    E400 -.- Refuse
```

<sub>Sources: [`api/chat/nvidia.js`](../api/chat/nvidia.js), [`api/models/nvidia.js`](../api/models/nvidia.js), [`api/_lib/handlers.js`](../api/_lib/handlers.js), [`api/_lib/guards.js`](../api/_lib/guards.js), [`api/_lib/env.js`](../api/_lib/env.js), [`api/_lib/nvidia-request.js`](../api/_lib/nvidia-request.js), [`src/js/models/nvidia-catalog.js`](../src/js/models/nvidia-catalog.js), [`backend/test_fixtures/nvidia_validation.json`](../backend/test_fixtures/nvidia_validation.json), [`tests/unit/nvidia-proxy.test.mjs`](../tests/unit/nvidia-proxy.test.mjs)</sub>

### NVIDIA proxy: key rotation and failover before the first byte

The key router of the Vercel Functions starts each request at the next key (round robin over the whole pool) and skips keys whose cooldown has not ended; when every key is cooling it answers 503 all_keys_exhausted at once, without an upstream request, with Retry-After until the first key is free (1 to 300 s). Each attempt sends the upstream body to NVIDIA's chat completions endpoint with that key as Bearer token, redirects refused, and waits for the first non-empty chunk of a text/event-stream for at most 20 s, or for the time left of the 25 s failover budget, which runs from the start of the request. A 429 parks the key for its Retry-After (delta seconds or an HTTP date, 20 s without one, clamped to 1 to 300 s), a 401 or 403 for 30 minutes, and a 408, a 5xx, a network error, a timeout or a stream that ends or stalls before its first byte for 10 s; then the next key is tried. An attempt that timed out only because the budget had less than 20 s left parks nothing, because it says nothing about the key. A 404 gives 502 model_unavailable and any other answer, a 200 that is not an event stream included, 502 upstream_rejected, without failover, because another key would get the same answer. Upstream bodies are cancelled unread and never echoed, and a log line names only the key index, the reason and the cooldown. When the budget or the keys run out, 504 upstream_timeout says that every attempt timed out (or the budget was spent before the first one), otherwise 503 all_keys_exhausted. Once the first byte has arrived the response is committed and there is no failover.

<!-- diagram: nvidia-proxy-failover -->
```mermaid
flowchart TD
    Start(["router.open(body, signal, deadline):<br/>deadline = request start + failoverBudgetMs 25 s"])
    Order["order: rotate from the cursor, cursor + 1 per request,<br/>keep keys whose cooldownUntil has passed"]
    Empty{"any key not cooling?"}
    Exh0["503 all_keys_exhausted at once, no upstream request,<br/>Retry-After = soonest cooldown end, 1 to 300 s"]
    Next{"next key in the order"}
    Gone{"client signal aborted?"}
    Closed["499 client_closed: the browser left,<br/>nobody reads the answer"]
    Cooling{"parked meanwhile by a<br/>concurrent request?"}
    Budget{"budget = deadline - now<br/>above 0?"}
    Fetch["fetch POST integrate.api.nvidia.com/v1/chat/completions,<br/>Authorization Bearer key, Accept text/event-stream,<br/>redirect error, timer min(attemptTimeoutMs 20 s, budget)"]
    Net{"fetch throws:<br/>network error or the timer fired?"}
    Status{"upstream status"}
    First{"200 text/event-stream and a first<br/>non-empty chunk before the timer?"}
    Commit(["commit: first chunk and reader to the relay,<br/>see nvidia-proxy-stream, no failover after this"])
    C429["429: cooldown = Retry-After in seconds or an HTTP date,<br/>default 20 s, clamped to 1 to 300 s"]
    CAuth["401 or 403: key parked for 30 min"]
    CTr["408, 5xx, network error, timeout,<br/>empty or stalled stream: cooldown 10 s"]
    Short{"a timeout of an attempt that<br/>the budget had cut below 20 s?"}
    NoPark["key not parked"]
    Park["cooldownUntil = now + cooldown,<br/>log key i of n, reason, cooling s,<br/>never the key or a body"]
    Fatal["404: 502 model_unavailable<br/>any other status, a 200 that is not SSE included:<br/>502 upstream_rejected, no failover,<br/>body cancelled unread, log key i got status"]
    AllT{"every attempt timed out,<br/>or the budget ran out before the first?"}
    E504["504 upstream_timeout"]
    E503["503 all_keys_exhausted<br/>Retry-After = soonest cooldown end, 1 to 300 s"]

    Start --> Order --> Empty
    Empty -->|"no"| Exh0
    Empty -->|"yes"| Next
    Next -->|"a key"| Gone
    Gone -->|"yes"| Closed
    Gone -->|"no"| Cooling
    Cooling -->|"yes, skip it"| Next
    Cooling -->|"no"| Budget
    Budget -->|"no"| AllT
    Budget -->|"yes"| Fetch --> Net
    Net -->|"client aborted"| Closed
    Net -->|"yes"| CTr
    Net -->|"no, a response"| Status
    Status -->|"200"| First
    First -->|"yes"| Commit
    First -->|"no"| CTr
    Status -->|"429"| C429
    Status -->|"401, 403"| CAuth
    Status -->|"408, 500 to 599"| CTr
    Status -->|"404 or other"| Fatal
    C429 --> Park
    CAuth --> Park
    CTr --> Short
    Short -->|"yes"| NoPark
    Short -->|"no"| Park
    Park --> Next
    NoPark --> Next
    Next -->|"none left"| AllT
    AllT -->|"yes"| E504
    AllT -->|"no"| E503
```

<sub>Sources: [`api/_lib/nvidia-router.js`](../api/_lib/nvidia-router.js), [`api/_lib/handlers.js`](../api/_lib/handlers.js), [`src/js/models/nvidia-catalog.js`](../src/js/models/nvidia-catalog.js), [`tests/unit/nvidia-proxy.test.mjs`](../tests/unit/nvidia-proxy.test.mjs)</sub>

### NVIDIA proxy: relaying the stream to the browser

After the commit handleChat answers 200 with text/event-stream, Cache-Control no-store, no-transform, nosniff and X-Accel-Buffering no, and relayStream passes the upstream bytes through unchanged, starting with the first chunk; the proxy does not parse the events, so reasoning_content and content deltas reach callNvidia as NVIDIA sent them. Every read may wait at most 30 s (idleTimeoutMs) and never past the hard deadline, 240 s (streamMaxMs) after the request started, which ends well before the function's maxDuration of 300 s, and the relayed bytes may not exceed 4 MiB. A failure after the first byte can no longer change the HTTP status, so a silent upstream or the deadline ends the stream with an SSE event of code stream_timeout, too many bytes with stream_too_large and a read error with upstream_interrupted; the event starts with a blank line, which ends any event the upstream left half-written. Every end cancels the upstream reader and aborts the upstream request, and so does a Stop in the tab: the cancelled response stream stops the relay, and with supportsCancellation Vercel also aborts the function's request signal, which the router's attempt still listens to. The browser's own limits (35 s to the first byte, 40 s between reads, 255 s in all) are each longer than the proxy's, so the proxy's error normally arrives first; unit tests pin these inequalities and the vercel.json durations.

<!-- diagram: nvidia-proxy-stream -->
```mermaid
sequenceDiagram
    autonumber
    participant Tab as Browser tab callNvidia
    participant Fn as api/chat/nvidia.js handleChat
    participant R as nvidia-router.js
    participant NIM as integrate.api.nvidia.com
    participant Rel as nvidia-stream.js relayStream

    Tab->>Fn: POST /api/chat/nvidia, same origin, JSON, no key
    Fn->>Fn: guards, rate limit, keys, body and validation, see nvidia-proxy-guards
    Fn->>R: open with the upstream body, deadline = request start + 25 s
    R->>NIM: POST stream true, Bearer key n
    NIM-->>R: 429 with Retry-After
    R->>R: key n parked for Retry-After, log line with the key index only
    R->>NIM: POST stream true, Bearer key of the next index
    NIM-->>R: 200 text/event-stream, first non-empty chunk
    R-->>Fn: commit, the first chunk and the reader
    Fn->>Rel: relayStream, idle 30 s, hard deadline start + min of 240 s and 297 s, 4 MiB
    Rel-->>Tab: 200 text/event-stream, no-store, no-transform, X-Accel-Buffering no, the first chunk
    loop each pull until the stream ends
        Rel->>NIM: read, at most 30 s and never past the hard deadline
        NIM-->>Rel: bytes with content or reasoning_content deltas
        Rel-->>Tab: the same bytes, size counted
    end
    alt upstream finishes
        NIM-->>Rel: data DONE, then the end of the body
        Rel-->>Tab: close
    else no bytes within 30 s, or the hard deadline
        Rel-->>Tab: blank line, data error code stream_timeout, close
        Rel->>NIM: reader cancelled, request aborted
    else more than 4 MiB relayed
        Rel-->>Tab: blank line, data error code stream_too_large, close
        Rel->>NIM: reader cancelled, request aborted
    else read error
        Rel-->>Tab: blank line, data error code upstream_interrupted, close
        Rel->>NIM: reader cancelled, request aborted
    else Stop in the tab or the connection closes
        Tab-->>Rel: response stream cancelled
        Rel->>NIM: reader cancelled, request aborted
    end
    Note over Tab,Fn: browser limits 35 s to the first byte, 40 s between reads<br/>and 255 s in all, each longer than the proxy's, so its error arrives first
```

<sub>Sources: [`api/_lib/nvidia-stream.js`](../api/_lib/nvidia-stream.js), [`api/_lib/handlers.js`](../api/_lib/handlers.js), [`api/_lib/nvidia-router.js`](../api/_lib/nvidia-router.js), [`api/chat/nvidia.js`](../api/chat/nvidia.js), [`vercel.json`](../vercel.json), [`src/js/providers.js`](../src/js/providers.js), [`src/js/models/nvidia-catalog.js`](../src/js/models/nvidia-catalog.js), [`tests/unit/nvidia-proxy.test.mjs`](../tests/unit/nvidia-proxy.test.mjs), [`tests/unit/nvidia-catalog.test.mjs`](../tests/unit/nvidia-catalog.test.mjs)</sub>

### One model allowlist for the app and the functions

src/js/models/nvidia-catalog.js is the single source of the NVIDIA models (13 entries with id, label, vendor, reasoning and vision flags, output token limits and fixed upstream extras), the default model, the request limits, the proxy timings and cooldowns, and the browser timeouts derived from them; it is deep-frozen, so no importer can change it at run time. esbuild bundles it into the app, where the pickers list its models, state.js normalizes starpi_nvidia_model against it, prompts.js fits requests to its limits and providers.js takes its timeouts. The Vercel Functions import it from src/ for validation, the router and the public catalog, so .vercelignore keeps src/. nvidia-catalog.test.mjs fails when the README's T4 table does not list the same models with the same names and reasoning flags in the same order, or when a timing would let the browser give up before the proxy. GET /api/models/nvidia publishes the models without their upstream extras, and the browser offers only the models the proxy lists. npm run nvidia:ping, run by a maintainer with real keys before the list changes, checks every allowlisted id against NVIDIA's live API.

<!-- diagram: nvidia-proxy-allowlist -->
```mermaid
flowchart LR
    Cat["src/js/models/nvidia-catalog.js<br/>NVIDIA_CATALOG, deep-frozen: version 1, upstream URL,<br/>defaultModel, 13 models, limits, proxy timings,<br/>NVIDIA_CLIENT_TIMEOUTS derived: first byte 35 s,<br/>idle 40 s, total 255 s, models 6 s"]

    subgraph app["esbuild bundle, the browser"]
        Pick["models/choices.js and settings.js<br/>picker values nvidia:id, allowlist check"]
        State["state.js normalizeNvidiaModel<br/>starpi_nvidia_model"]
        Fit["prompts.js fitNvidiaMessages<br/>NVIDIA_LIMITS"]
        Prov["providers.js callNvidia, parseNvidiaCatalog<br/>NVIDIA_CLIENT_TIMEOUTS, model labels"]
    end

    subgraph fns["Vercel Functions, api/_lib"]
        Req["nvidia-request.js validateChatRequest<br/>findNvidiaModel, NVIDIA_LIMITS"]
        Rt["nvidia-router.js<br/>NVIDIA_PROXY, NVIDIA_UPSTREAM_URL"]
        Hd["handlers.js publicCatalog,<br/>idle, stream and size limits"]
    end

    Pub["GET /api/models/nvidia<br/>models without upstream extras"]
    Readme["README.md T4 table<br/>id, name, reasoning"]
    Test["nvidia-catalog.test.mjs: README table,<br/>timing inequalities, frozen, ids unique,<br/>labels outside the i18n key shape"]
    Ping["npm run nvidia:ping, maintainer only:<br/>GET /v1/models and one streamed request<br/>per allowlisted id, real keys and quota"]

    Cat --> Pick
    Cat --> State
    Cat --> Fit
    Cat --> Prov
    Cat -->|"imported from src/,<br/>kept by .vercelignore"| Req
    Cat --> Rt
    Cat --> Hd
    Hd --> Pub
    Pub -->|"the offered models"| Prov
    Test -.->|"checks"| Readme
    Test -.->|"checks"| Cat
    Ping -.->|"live check before a change"| Cat
```

<sub>Sources: [`src/js/models/nvidia-catalog.js`](../src/js/models/nvidia-catalog.js), [`src/js/models/choices.js`](../src/js/models/choices.js), [`src/js/settings.js`](../src/js/settings.js), [`src/js/state.js`](../src/js/state.js), [`src/js/prompts.js`](../src/js/prompts.js), [`src/js/providers.js`](../src/js/providers.js), [`api/_lib/nvidia-request.js`](../api/_lib/nvidia-request.js), [`api/_lib/nvidia-router.js`](../api/_lib/nvidia-router.js), [`api/_lib/handlers.js`](../api/_lib/handlers.js), [`scripts/nvidia-ping.mjs`](../scripts/nvidia-ping.mjs), [`.vercelignore`](../.vercelignore), [`README.md`](../README.md), [`tests/unit/nvidia-catalog.test.mjs`](../tests/unit/nvidia-catalog.test.mjs)</sub>
