# Starpi

Browser-native knowledge assistant: on-device LLM inference with WebGPU, private on-device
document search with verifiable citations, retrieval over a Supabase Postgres knowledge base
protected by Row Level Security, and an optional Python ingestion backend with pgvector
embeddings. The interface is in English by default and switches to German with one click.

**Deployment:** [https://www.starpi.app](https://www.starpi.app) · **New here?** Start with the
[walkthrough](docs/WALKTHROUGH.md), then the [architecture atlas](docs/ARCHITECTURE.md) ·
[Changelog](CHANGELOG.md)

## Overview

Starpi answers questions about a company knowledge base (documents, meeting notes, a small
knowledge graph) and about files the user adds to an on-device workspace. The browser retrieves
relevant passages, labels each one `[Doc: <name>, Chunk: <n>]`, and then produces an answer in one
of four ways:

| Mode | Where the model runs | What leaves the device |
| --- | --- | --- |
| **On-device** | In the browser. [WebLLM](https://github.com/mlc-ai/web-llm) runs in a dedicated Web Worker on WebGPU. | Nothing. Candidate documents are fetched without the question and ranked in the browser. Chat history stays in `localStorage`. |
| **Cloud assistant** | Google Gemini or OpenRouter, with **your own** API key | The question and the retrieved excerpts go to the chosen provider. The question is searched with Postgres full-text search. |
| **Own server** | Any Chat Completions-compatible endpoint (`/v1/chat/completions`: MLX, Ollama, vLLM) at `https://…` or `http://localhost` | The question and the retrieved excerpts go to that server. The question is also searched with Postgres full-text search. |
| **Extractive fallback** | No model | Quotes matching sentences from the sources verbatim, each with its citation. Used when no key or model is available; it never invents content. |

Chat history is synchronised to Supabase only when the browser has an anonymous session **and**
the hardened RLS schema is installed, so every row is visible to its owner only. Otherwise it
stays on the device. A chat turn that uses the on-device workspace (the question and its answer)
is never synchronised.

System prompts follow the interface language: the on-device model is told *"You are Starpi, a
high-performance on-device AI assistant. Respond in English unless the user explicitly prompts in
another language."* (or the German equivalent), followed by grounding, prompt-injection and
citation rules (`src/js/prompts.js`).

### On-device workspace and citations

**Add knowledge → On-device workspace** accepts PDF, TXT, Markdown, JSON and CSV files (drag and
drop or file picker, up to 25 MB each). A dedicated worker (`src/js/rag/ingest.worker.js`)
extracts the text (PDF via a pinned, lazily loaded pdf.js; text via a streaming UTF-8 decoder;
JSON flattened into `path: value` lines), splits it into 500-character windows with 50 characters
of overlap that end on paragraph, sentence or word boundaries, and indexes the chunks with Okapi
BM25 (`k1 = 1.2`, `b = 0.75`, English and German stopwords). Documents live in the worker's memory
only and disappear on reload; nothing is uploaded.

Every answer registers the exact excerpts it was given. Citation labels in the answer become
buttons only when they match one of those excerpts, so a model cannot invent a clickable source.
The citation drawer shows the document, chunk number, BM25 score, character offsets and the chunk
highlighted inside the extracted text.

### Diagnostics and benchmark

The **Diagnostics** tab lists the WebGPU adapter (vendor, architecture, device), `shader-f16`
support, the relevant limits (buffer sizes, compute workgroup limits) and adapter features. The
benchmark runs on the loaded on-device model: one warm-up request, then a fixed prompt of about 64
tokens that generates exactly 128 tokens (`ignore_eos`). It reports the measured time to first
token, decode throughput (tokens after the first divided by the time after it), WebLLM's prefill
throughput and the total time. Without WebGPU the tab says so instead of showing numbers.

### Languages

English is the default for every visitor; the **EN | DE** switch in the header changes the
language instantly, without a reload, and the choice is kept in `localStorage`. Strings live in
`src/locales/en.json` and `src/locales/de.json`; markup references them with `data-i18n`,
`data-i18n-placeholder`, `data-i18n-title` and `data-i18n-aria`, and code uses `t()` / `setText()`
from `src/js/i18n/index.js`. Unit tests require identical keys and placeholders in both files and
check that every key used by the UI exists.

## Architecture

The [architecture atlas](docs/ARCHITECTURE.md) documents every subsystem with diagrams checked
against the code: boot, chat, retrieval and citations, the WebGPU engine, storage, the service
worker, the database and its policies, the backend, build, tests and deployment. The overview below
shows where each part runs and which trust boundary it sits behind; dashed nodes are services
outside Starpi's control.

<!-- diagram: system-context-overview -->
```mermaid
flowchart LR
    subgraph device["User device: browser tab on www.starpi.app, CSP enforced"]
        subgraph mainThread["Main thread, src/js"]
            boot["main.js boot()<br/>chat.js, settings.js, UI modules"]
            sbClient["supabase.js createClient<br/>anon key compiled in, build refuses other roles<br/>fetchWithTimeout 12 s"]
            provJs["providers.js<br/>callGemini, callOpenRouter,<br/>callLocalServer, probeLocalServer"]
            engineJs["webgpu/engine.js<br/>loadModel, generate, unloadModel"]
            wsJs["rag/workspace.js<br/>request(type, payload)"]
        end
        subgraph llmWorker["Web Worker starpi-webllm"]
            mlc["webgpu/worker.js<br/>WebWorkerMLCEngineHandler<br/>inference on WebGPU"]
        end
        subgraph ingestWorker["Web Worker starpi-ingest"]
            ingest["rag/ingest.worker.js<br/>extractText with pdf.js, chunkText,<br/>BM25Index in worker memory only"]
        end
        sw["sw.js service worker<br/>same-origin GET only,<br/>cross-origin requests bypass it"]
        subgraph browserStores["Per-origin browser storage"]
            ls[("localStorage<br/>starpi_local_chats_v1, starpi_chat_session_id,<br/>starpi_compute_mode, starpi_webgpu_model,<br/>starpi_llm_url, starpi_remember_keys,<br/>starpi_locale, starpi-auth session")]
            ss[("sessionStorage<br/>Gemini and OpenRouter keys for this tab,<br/>in localStorage instead if remember is on")]
            swCache[("CacheStorage<br/>starpi-shell-VERSION, starpi-assets-VERSION")]
            modelCache[("Cache API owned by WebLLM<br/>webllm/model, webllm/config, webllm/wasm")]
        end
    end

    subgraph vercel["Vercel static hosting"]
        host["dist/: index.html, hashed /assets/*, sw.js<br/>vercel.json headers on every path:<br/>CSP script-src self and wasm-unsafe-eval,<br/>connect-src self, data:, https:, wss://*.supabase.co,<br/>http://localhost:* and http://127.0.0.1:*<br/>HSTS, COOP same-origin, X-Frame-Options DENY,<br/>nosniff, Referrer-Policy, Permissions-Policy"]
    end

    subgraph supabase["Supabase project: access decided by roles and RLS"]
        auth["Auth<br/>anonymous sign-in, session JWT"]
        rest["PostgREST<br/>/rest/v1 tables and /rest/v1/rpc"]
        subgraph pg["Postgres, RLS enabled on every table"]
            tables[("knowledge_documents, knowledge_entities,<br/>knowledge_relations: read is_public or owner_id = auth.uid(),<br/>knowledge_sections: visible with their document,<br/>writes only to own private rows<br/>chat_history: owner only, no anon grant<br/>brain_settings: no policy, service_role only")]
            rpcFns["SECURITY INVOKER functions<br/>search_knowledge: anon, authenticated, service_role<br/>match_knowledge_sections, match_knowledge_hybrid:<br/>authenticated, service_role<br/>ingest_document_atomic: service_role only"]
        end
    end

    subgraph backendHost["Optional backend host, operator-controlled"]
        caller["HTTP client of /api/brain/*"]
        brain["backend/server.py<br/>default bind 127.0.0.1:9200<br/>not called by the browser bundle"]
    end

    subgraph thirdParty["Third-party services outside Starpi control"]
        gemini["Google Gemini<br/>gemini-2.5-flash:generateContent"]
        openrouter["OpenRouter<br/>/api/v1/chat/completions"]
        ownServer["Own Chat Completions server<br/>https anywhere, http only on<br/>localhost or 127.0.0.1"]
        hf["Hugging Face<br/>huggingface.co/mlc-ai weights"]
        ghLibs["raw.githubusercontent.com<br/>binary-mlc-llm-libs wasm"]
        backendApis["Backend upstreams<br/>LLM_BASE_URL, EMBEDDING_BASE_URL,<br/>GEMINI_API_KEYS, OPENROUTER_API_KEYS"]
    end

    host -->|"app shell and hashed assets<br/>with security headers"| sw
    sw -->|"navigations network-first,<br/>/assets/* and precache cache-first"| boot
    sw -->|"precache, put if cacheable()"| swCache
    boot -->|"register /sw.js, SKIP_WAITING"| sw
    boot -->|"settings, locale, chat fallback"| ls
    provJs -->|"readSecret"| ss
    sbClient -->|"persistSession, storageKey starpi-auth"| ls
    engineJs -->|"CreateWebWorkerMLCEngine,<br/>messages in, stream deltas out"| mlc
    engineJs -->|"hasModelInCache,<br/>deleteModelAllInfoInCache"| modelCache
    mlc -->|"read and write shards"| modelCache
    mlc -->|"GET weights if not cached,<br/>interactive loads only, after confirmDownload"| hf
    mlc -->|"GET model_lib wasm"| ghLibs
    wsJs -->|"postMessage ingest, search, head,<br/>context, text, remove,<br/>File structured-cloned"| ingest
    sbClient -->|"getSession, signInAnonymously"| auth
    sbClient -->|"apikey anon, Bearer session JWT:<br/>select, insert, delete, rpc search_knowledge"| rest
    rest -->|"SQL as anon or authenticated"| tables
    rest -->|"rpc"| rpcFns
    rpcFns -->|"run as the caller role"| tables
    provJs -->|"x-goog-api-key header,<br/>prompt with retrieved excerpts"| gemini
    provJs -->|"Bearer key, messages,<br/>failover over free models"| openrouter
    provJs -->|"messages, no key sent,<br/>GET /models probe"| ownServer
    caller -->|"Bearer BRAIN_API_TOKEN when set,<br/>else loopback Host only"| brain
    brain -->|"service_role key bypasses RLS:<br/>knowledge_documents, knowledge_sections,<br/>rpc match_knowledge_sections"| rest
    brain -->|"chat/completions, embeddings,<br/>generateContent"| backendApis

    classDef external stroke-dasharray: 5 5
    class gemini,openrouter,ownServer,hf,ghLibs,backendApis external
```

### Key flows

**One chat turn**, from the input to the persisted answer
([details](docs/ARCHITECTURE.md#3-answering-a-question)):

<!-- diagram: chat-request-lifecycle -->
```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Chat as chat.js submitChat
    participant Msg as messages.js
    participant Store as chat-store.js
    participant WS as rag/workspace.js worker
    participant SB as supabase.js
    participant Ret as retrieval.js
    participant Cit as rag/citations.js
    participant Eng as providers.js or WebGPU engine
    participant Syn as synthesizer.js

    User->>Chat: chatForm submit, Enter, quick-prompt or graph ask-entity
    opt busy is true
        Chat-->>User: setAssistantStatus status.busy, return
    end
    opt no text and no attachment
        Chat-->>User: return without a message
    end
    Note over Chat: trim to 8000 chars, clear input, removeAttachment.<br/>Captures sid, history, mode and localOnly = mode is client.<br/>A file without text asks chat.summarize_file
    Chat->>Msg: appendMessage user shownText
    Chat->>Store: void persistMessage user, localOnly or file attached
    Note over Chat,Store: a question about an attached file names the file,<br/>so it stays in localStorage like its answer
    Note over Chat: new AbortController, setBusy(true) shows Stop and status.generating
    Chat->>Msg: appendLoading()
    Chat->>WS: searchWorkspace(prompt, 6), any error gives no workspace hits
    opt attached docId not among the hits
        Chat->>WS: firstChunks(docId, 3) prepended
    end
    alt mode council or local
        Chat->>SB: searchKnowledge(prompt), rpc search_knowledge
        opt RPC error or zero rows
            Chat->>SB: recentKnowledge(30), on failure workspace hits only
            Chat->>Ret: rankHitsLocally(prompt, rows, 6)
        end
    else mode client
        Chat->>SB: recentKnowledge(30), question is not sent
        Chat->>Ret: rankHitsLocally(prompt, rows, 6), none if the fetch failed
    end
    Note over Chat: used is empty for a greeting without a file, else all hits
    Chat->>Ret: assignCitations(used, excerptChars 1600)
    Chat->>Cit: registerCitations gives scope id or null
    Chat->>Ret: distinctSources and buildContext(maxChars 9000)
    alt mode council
        Chat->>Eng: answerWithCloud, Gemini then OpenRouter
    else mode client
        Chat->>Eng: answerWithLocalModel, removes loading, streams its own bubble
    else mode local
        Chat->>Eng: answerWithOwnServer, callLocalServer(getLlmUrl())
    end
    Eng-->>Chat: Answer, empty text with note, or null
    opt answer is null or its text is empty
        Chat->>SB: knownTitles(), listDocuments unless cached under 60 s
        Chat->>Syn: synthesizeAnswer, extractive with citation labels
    end
    alt signal aborted and answer not rendered
        Note over Chat,Msg: throw AbortError, catch removes loading, isUserAbort so no notice
    else a call threw, e.g. a council or local error rethrown after abort
        Chat->>Msg: removeLoading, appendNotice chat.error_title unless isUserAbort
    else answer ready
        Chat->>Syn: describeTrace(prompt, method, used, engine label, note)
        opt sid is still currentSessionId()
            Chat->>Msg: removeLoading, appendMessage assistant unless already streamed
            Msg->>Cit: linkifyCitations and citationSources row
            Chat->>Chat: conversation.push user and assistant turns
        end
        Chat->>Store: void persistMessage assistant, localOnly or usesWorkspace
        alt localOnly or not canSyncChats()
            Store->>Store: appendLocal to localStorage
        else chat sync available
            Store->>SB: insertChatMessage into chat_history
            Note over Store,SB: on error console.warn and appendLocal,<br/>on success refreshSyncStatus
        end
    end
    Note over Chat: finally removeLoading, setBusy(false), activeAbort = null
```

**What leaves the device** in each mode:

<!-- diagram: modes-privacy-data-egress -->
```mermaid
flowchart TD
    Ask(["submitChat: question trimmed to 8000 chars<br/>mode = getMode(), stored in starpi_compute_mode"])
    UserTurn{"persist the user turn first:<br/>client mode or a file attached?"}
    RetMode{"retrieve(): mode is client?"}
    Ctx["assignCitations + buildContext<br/>workspace hits first, at most 6 hits, 9 with an attachment<br/>excerpt max 1600 chars, context max 9000 chars<br/>a greeting uses no excerpts"]
    Dispatch{"answer path by mode"}
    CKeys{"hasGeminiKey()?<br/>else hasOpenRouterKey()?"}
    Abort(["Stop pressed before a rendered answer:<br/>AbortError, answer not shown or persisted"])
    Persist{"answer localOnly?<br/>client mode, or any used excerpt<br/>came from the workspace"}
    Sync{"not localOnly: canSyncChats()?<br/>signed in and hardened schema"}

    subgraph dev["Stays in this browser"]
        WsSearch["retrieveWorkspace: BM25 in the ingest worker, every mode<br/>an unmatched attached file adds its first 3 chunks<br/>worker error: no workspace hits"]
        Keys[("provider keys<br/>readSecret: sessionStorage, then localStorage")]
        LGen["client: WebLLM worker on WebGPU<br/>budgeted excerpts + last 4 history messages<br/>+ question stay in the browser"]
        Synth["synthesizeAnswer: extractive quotes<br/>with citation labels, no model"]
        LS[("localStorage<br/>starpi_local_chats_v1")]
    end

    subgraph net["Sent over the network"]
        FTS["Supabase rpc search_knowledge<br/>question as query_text, first 1000 chars<br/>match_count 6"]
        Recent["Supabase recentKnowledge(30)<br/>30 newest documents, question not sent<br/>rankHitsLocally in the browser"]
        Gem["council: Gemini gemini-2.5-flash generateContent<br/>one user part: system + excerpts incl. workspace<br/>+ question, no chat history"]
        OR["council: OpenRouter chat/completions<br/>system + excerpts incl. workspace<br/>+ last 4 history messages + question"]
        Srv["local: own server getLlmUrl()/chat/completions<br/>system + excerpts incl. workspace<br/>+ last 4 history messages + question, no key"]
        HF["WebLLM model files: huggingface.co weights,<br/>raw.githubusercontent.com wasm<br/>only when not cached, after a confirm, no user text"]
        Titles["Supabase listDocuments, no question sent<br/>only titles used, cached 60 s"]
        CH[("Supabase chat_history insert")]
    end

    Ask --> UserTurn
    UserTurn -->|"yes"| LS
    UserTurn -->|"no"| Sync
    Ask --> WsSearch --> RetMode
    RetMode -->|"no, council or local"| FTS
    RetMode -->|"yes"| Recent
    FTS -->|"rows found"| Ctx
    FTS -.->|"zero rows or error"| Recent
    Recent -->|"ranked hits, none if it fails"| Ctx
    WsSearch -->|"workspace excerpts"| Ctx
    Ctx --> Dispatch
    Dispatch -->|"council"| CKeys
    Dispatch -->|"client"| LGen
    Dispatch -->|"local"| Srv
    CKeys -->|"Gemini key"| Gem
    CKeys -->|"only OpenRouter key"| OR
    CKeys -->|"no key"| Synth
    Gem -.->|"fails, OpenRouter key set"| OR
    Gem -.->|"fails, no OpenRouter key"| Synth
    OR -.->|"all attempts fail,<br/>or HTTP 401 or 403"| Synth
    HF -.->|"first load only"| LGen
    LGen -.->|"not loaded, declined,<br/>empty or throws"| Synth
    Srv -.->|"throws, not aborted"| Synth
    Keys -.->|"Gemini key only,<br/>x-goog-api-key header"| Gem
    Keys -.->|"OpenRouter key only,<br/>Authorization Bearer"| OR
    Synth -.->|"known titles"| Titles
    Dispatch -.->|"user abort"| Abort
    Gem --> Persist
    OR --> Persist
    LGen --> Persist
    Srv --> Persist
    Synth --> Persist
    Persist -->|"yes"| LS
    Persist -->|"no"| Sync
    Sync -->|"yes"| CH
    Sync -->|"no"| LS
    CH -.->|"insert fails"| LS
```

**From a retrieved chunk to a verified citation**
([details](docs/ARCHITECTURE.md#4-on-device-workspace-and-citations)):

<!-- diagram: citations-answer-to-drawer -->
```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Chat as chat.js submitChat
    participant Ret as retrieval.js
    participant Cit as rag/citations.js
    participant Gen as model or synthesizer.js
    participant Msg as messages.js
    participant WS as rag/workspace.js
    participant W as ingest.worker.js

    Note over Chat: used = the retrieved hits, or none for a greeting without an attached file
    Chat->>Ret: assignCitations(used, excerptChars 1600)
    Ret-->>Chat: citations with label, doc, chunk, source, heading, text, score, span
    Chat->>Cit: registerCitations(citations)
    Cit-->>Chat: scope id, or null when there are none
    Chat->>Ret: buildContext(citations, maxChars 9000)
    Ret-->>Chat: fenced EXCERPT blocks, each header carries its label
    alt a model answers (cloud, own server or on-device)
        Chat->>Gen: system prompt with the citation rules and the context
        Gen-->>Chat: answer text that cites labels
    else no model, a failed model or empty text
        Chat->>Gen: synthesizeAnswer with used hits and the citation list
        Gen-->>Chat: up to 4 quoted sentences, each followed by its excerpt label
    end
    Chat->>Msg: appendMessage(text, citations scope), only if the chat session is unchanged
    Note over Chat,Msg: a streamed on-device answer is finished by<br/>stream.finalize(text, citations scope) with the same steps
    Msg->>Cit: linkifyCitations(content rendered by renderMarkdown, scope), then citationSources(scope)
    Cit-->>Msg: open-citation buttons for registered labels only, Sources badge row
    User->>Cit: click open-citation, data-arg is scope and index
    alt scope evicted or index unknown
        Cit-->>User: nothing opens
    else citation found
        Cit-->>User: citationModal with doc, source, chunk, score, offsets, the excerpt in a mark
        alt source knowledge, span null
            Cit-->>User: note citation.note_knowledge, no worker request
        else source workspace, span set
            Cit-->>User: note citation.loading_context
            Cit->>WS: getChunkContext(span.docId, span.start, span.end)
            WS->>W: context, pad 400, a new worker is started if none runs
            alt the worker has a document with that docId
                W-->>WS: before, match, after, start, end, length
                WS-->>Cit: context
                Cit-->>User: before, match in a mark, after, ellipsis where cut, note citation.note_workspace
            else no such docId
                W-->>WS: ok false, code empty
                WS-->>Cit: reject WorkspaceError, also on a worker crash
                Cit-->>User: excerpt stays, note citation.note_missing
            end
        end
    end
    Note over WS,W: ids are ws-instanceId-n with a random instanceId<br/>per worker, so after Clear workspace or a crash<br/>an old span never matches a newer file
```

### Frontend modules (`src/js`)

| Module | Responsibility |
| --- | --- |
| `main.js` | Boot sequence, service worker registration and update prompt |
| `i18n/index.js`, `../locales/*.json` | Runtime translation (`t`, `setText`, `setLocale`), English default, German dictionary |
| `dom.js` | Single delegated dispatcher for `data-action` / `data-change` (no inline handlers) |
| `render.js` | `escapeHtml`, `escapeMarkdown`, `renderMarkdown` (marked + DOMPurify: no scripts, handlers, styles, images, `data-*` attributes or unsafe URLs) |
| `supabase.js` | Client, anonymous-session bootstrap, schema capability probe, typed queries with timeouts and error classification |
| `chat.js`, `chat-store.js`, `messages.js` | Chat flow, retrieval, persistence policy, message rendering with throttled streaming |
| `retrieval.js`, `synthesizer.js` | Keyword ranking, citation labels, context fencing against prompt injection, extractive answers |
| `prompts.js` | Language-specific system prompts (identity, grounding, citation rules) |
| `rag/ingest.worker.js`, `rag/parser.js`, `rag/chunker.js`, `rag/bm25.js` | On-device workspace: text extraction, sliding-window chunking, Okapi BM25 |
| `rag/workspace.js`, `rag/citations.js` | Worker RPC client; citation registry, safe citation buttons and the citation drawer |
| `bench/bench-ui.js`, `bench/diagnostics.js` | WebGPU adapter report and the inference benchmark |
| `providers.js` | Gemini (key in the `x-goog-api-key` header), OpenRouter, own Chat Completions server (URL validation) |
| `webgpu/models.js` | Pure model selection (shader-f16 detection, `q4f32_1` fallback, context budgeting) |
| `webgpu/engine.js`, `webgpu/worker.js` | Worker-based engine lifecycle: load sequencing, cancel, unload, device-loss handling, quota checks |
| `library.js`, `ingest.js`, `graph.js`, `settings.js`, `voice.js`, `ui.js` | Feature views |

### On-device models

Model ids are validated against the pinned WebLLM prebuilt catalog in the unit tests. On
adapters without the `shader-f16` feature the `q4f32_1` variant is selected automatically.

The engine's states, including cancelled and superseded loads and device loss:

<!-- diagram: webgpu-lifecycle-states -->
```mermaid
stateDiagram-v2
    [*] --> idle
    state "error (EngineError kept in state.error)" as error_state
    idle --> loading : loadModel, probe ok, chooseModel, teardown, seq still current
    error_state --> loading : loadModel retry, probe ok, teardown
    ready --> loading : loadModel for a different modelId (teardown first)
    ready --> ready : loadModel for the same modelId, engine reused, resolves true
    idle --> error_state : loadModel, probeWebGPU unsupported or no-adapter (never enters loading)
    error_state --> error_state : loadModel again, probe still fails
    loading --> idle : onlyIfCached and hasModelInCache false, seq current
    loading --> idle : confirmDownload declined, seq current
    loading --> idle : unloadModel cancels (loadSeq+1, abortPending cancelled, teardown)
    loading --> ready : CreateWebWorkerMLCEngine resolved and seq current
    loading --> error_state : run threw with seq current, teardown, classifyEngineError
    ready --> error_state : generate or runBenchmark failed with device-lost or out-of-memory (loadSeq+1, teardown)
    ready --> idle : unloadModel (unload button, changed model preference, deleteCachedModels)
    error_state --> idle : unloadModel
    note right of loading
        A run whose seq is no longer loadSeq resolves false without setState
        and terminates a worker it created.
        Concurrent loadModel calls share one loadPromise.
    end note
    note right of ready
        generate and runBenchmark throw not-loaded unless ready,
        and busy while the generating flag is set.
        Other generation errors are rethrown, status stays ready.
        chat.js, bench-ui.js and changeEngine check isReady first,
        so no caller runs loadModel from ready today.
    end note
    note left of error_state
        EngineErrors from the probe (unsupported, no-adapter),
        prepareStorage (quota) and the model lookup (unknown) pass through.
        Other failures are classified as quota, device-lost,
        out-of-memory, network, unsupported or unknown.
        cancelled never lands here.
    end note
```

| Preset | WebLLM model (f16 / f32 fallback) | Approx. download | VRAM (f16 / f32) | Context window |
| --- | --- | --- | --- | --- |
| `llama-1b` (mobile default) | `Llama-3.2-1B-Instruct-q4f16_1-MLC` / `…q4f32_1-MLC` | 0.7 GB | 879 MB / 1,129 MB | 2,048 |
| `qwen-1.5b` | `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` / `…q4f32_1-MLC` | 1.0 GB | 1,630 MB / 1,889 MB | 2,048 |
| `qwen-3b` (desktop default, ≥ 8 GB RAM) | `Qwen2.5-3B-Instruct-q4f16_1-MLC` / `…q4f32_1-MLC` | 1.9 GB | 2,505 MB / 2,894 MB | 4,096 |

Before downloading, the app checks `navigator.storage.estimate()`, asks for confirmation and
requests persistent storage. Weights are cached by WebLLM itself, not by the service worker.
**Settings → Advanced → Delete downloaded model data** removes them.

## Browser support

| Browser | WebGPU (local mode) | Notes |
| --- | --- | --- |
| Chrome / Edge 113+ (Windows, macOS, ChromeOS) | Yes | Linux support depends on GPU and driver; check `chrome://gpu`. |
| Chrome 121+ on Android 12+ | Yes | Compact 1B model with a 2,048-token context is selected by default. |
| Safari 26 (macOS, iOS, iPadOS) | Yes | iOS may evict cached model data under storage pressure. |
| Firefox 141+ | Windows only so far | Other platforms are rolling out. |
| Any browser without WebGPU | No | Cloud, own-server and extractive modes still work. |

Own-server mode from `https://www.starpi.app` to `http://localhost` triggers Chrome's Local
Network Access permission prompt (Chrome 142+), and Ollama must allow the origin
(`OLLAMA_ORIGINS`).

## Quickstart

Prerequisites: Node.js 20.19+ (22 LTS recommended), npm 10+. Python 3.11+ only for the backend.

```bash
git clone https://github.com/umutcantezgel-cpu/Starpi.git
cd Starpi
npm ci
npm run dev        # build in watch mode and serve dist/ on http://127.0.0.1:3000
```

The dev server applies the same response headers as production (`vercel.json`), including the
Content-Security-Policy.

| Command | Purpose |
| --- | --- |
| `npm run build` | Production build into `dist/` (Tailwind CSS, esbuild bundle, hashed assets, generated service worker) |
| `npm run preview` | Serve `dist/` with production headers |
| `npm run lint` / `npm run typecheck` | ESLint; TypeScript `checkJs` in strict mode for the core modules |
| `npm test` | Unit tests (`node --test`) |
| `npm run test:e2e` | Playwright tests against `dist/` with a mocked Supabase backend |
| `npm run verify` | Lint, typecheck, unit tests, build and output verification |

### Configuration

The Supabase URL and **anon** key are public by design and compiled into the bundle. Forks set
their own at build time:

```bash
STARPI_SUPABASE_URL=https://<project-ref>.supabase.co \
STARPI_SUPABASE_ANON_KEY=<anon key> \
npm run build
```

The build refuses any key whose JWT role is not `anon`, so a `service_role` key can never
reach the browser.

## Database setup (Supabase)

See [`backend/supabase/README.md`](backend/supabase/README.md) for details, verification
queries and rollback.

1. Enable **Anonymous sign-ins** (Authentication → Sign In / Providers). Consider CAPTCHA and
   rate limits for anonymous sign-ins.
2. New project: apply `backend/supabase/full_schema.sql`. Existing project: apply the files in
   `backend/supabase/migrations/` in file-name order (`20260923000000_harden_rls_anonymous_auth.sql`,
   then `20260924000000_lock_published_rows.sql`).
3. Verify with Supabase's security advisors.

Until the migration is applied, the app detects the old schema. It then keeps chats on the
device and notes, after saving, that new knowledge entries are visible to other visitors.

## Optional backend

`backend/` is a dependency-light Python service for server-side ingestion (Markdown
structuring, chunking, 1536-dimensional embeddings) and pgvector retrieval. It uses the
**service role** key and must never be exposed without authentication. It binds to
`127.0.0.1` by default and requires `BRAIN_API_TOKEN` on any other interface.

```bash
cd backend
python -m pip install -r requirements.txt
cp .env.example .env   # fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LLM and embedding endpoints
python server.py
```

Endpoints, configuration, request guards and pipelines are described in
[backend/README.md](backend/README.md).

## Security model

- **Data access:** the browser uses the public anon key and an anonymous Supabase session;
  RLS restricts chats to their owner and private knowledge rows to their creator. SECURITY
  DEFINER functions are not callable by browser roles.
- **Content rendering:** all Markdown from the database or models passes through DOMPurify
  with a restrictive profile. Values interpolated into HTML are escaped. The UI uses
  delegated event handlers, so the CSP needs no `unsafe-inline`.
- **Headers:** `script-src 'self' 'wasm-unsafe-eval'`, `style-src 'self'`,
  `img-src 'self' data: blob:` (blocks exfiltration via remote images),
  `frame-ancestors 'none'`, plus Permissions-Policy, COOP and HSTS. `connect-src` allows
  `https:` because the own-server endpoint is user-defined.
- **Untrusted files:** workspace files are parsed in a dedicated worker; pdf.js runs there without
  `eval`, font loading or network access, and extracted text is only ever set as `textContent`.
  Citation buttons are created with DOM APIs from registered excerpts, never from model output.
- **Credentials:** provider keys are kept for the browser tab only unless the user opts in
  to storing them on the device. They are never written back into form fields.
- **Supply chain:** exact dependency pins with a lockfile, `npm ci --ignore-scripts`, no CDN
  scripts at runtime, SHA-pinned GitHub Actions, gitleaks in CI.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Testing and CI

`.github/workflows/ci.yml` runs on every pull request:

| Job | Checks |
| --- | --- |
| `frontend` | ESLint, TypeScript, unit tests, production build, `verify-dist` (no inline scripts/handlers/styles, all assets present, no `eval`) |
| `e2e` | Playwright on desktop and mobile viewports under the production CSP: zero CSP violations, XSS payloads stay inert, graceful degradation, no chat writes without RLS |
| `backend` | ruff, byte-compilation, offline unit tests on Python 3.11 and 3.12 |
| `database` | Migration and RLS test suite on PostgreSQL 16 + pgvector (live, fresh and legacy schema shapes; idempotency; cross-user isolation) |
| `secrets` | gitleaks on the working tree and on the commits of the pull request |

## Roadmap

- **Benchmark history:** keep the Diagnostics results per model and device class (with peak GPU
  memory) and use them for the automatic model choice instead of static thresholds.
- **Quantization tiers:** measure the trade-offs between `q4f16_1`, `q4f32_1` and higher-precision
  variants per adapter, and add a tier for mid-range mobile GPUs.
- **Answer quality evaluation:** an English and German question-answering set over the knowledge base
  that compares local models, own-server models and cloud providers on answer faithfulness
  and citation accuracy.
- **Hybrid retrieval in the browser:** compute query embeddings on-device so local mode can use
  pgvector ranking without sending the question to the server.
- **Bundle size:** load the WebLLM runtime only inside the worker. Today the main thread also
  parses the shared chunk when local mode starts.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), the [walkthrough](docs/WALKTHROUGH.md) for a tour of the code
and the [Code of Conduct](CODE_OF_CONDUCT.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
