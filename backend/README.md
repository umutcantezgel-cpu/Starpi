# Starpi backend (optional)

A dependency-light Python service for server-side ingestion and retrieval. It structures raw text
into Markdown sections, stores them with 1536-dimensional embeddings in Supabase and answers
questions over pgvector search. The browser app does not call it: the PWA reads Supabase directly
with the anon key and row level security.

The backend writes with the Supabase **service role key**, which bypasses RLS. Run it only on a
machine you control, keep it on `127.0.0.1` or behind a TLS reverse proxy with `BRAIN_API_TOKEN`
set, and never ship the service role key or the API token to a browser. The full set of backend
diagrams is in the [architecture atlas](../docs/ARCHITECTURE.md#10-optional-backend).

## Run locally

```bash
cd backend
python -m pip install -r requirements.txt
cp .env.example .env        # fill in the values you need, see below
python server.py            # 127.0.0.1:9200; override with: python server.py 9300 --host 127.0.0.1 --log-level DEBUG
```

Without `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` the service runs on an in-memory store,
which is enough for development and for the tests.

## Configuration

Values come from the process environment, then from `backend/.env` (or `.env` in the repository
root); the environment always wins, and within the file the last assignment of a key wins.
[`.env.example`](.env.example) documents every variable.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | empty | Supabase project; both are required, and if either is empty documents are kept in memory only |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | `http://127.0.0.1:8000/v1`, `EMPTY`, `Qwen/Qwen2.5-7B-Instruct` | Chat Completions-compatible endpoint for structuring and answers |
| `GEMINI_API_KEYS`, `OPENROUTER_API_KEYS` | empty | Optional key pools, comma separated, tried before `LLM_BASE_URL` for answers |
| `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL` | `http://127.0.0.1:8000/v1`, `EMPTY`, see `.env.example` | `/v1/embeddings` endpoint returning 1536 dimensions; set the model your endpoint serves. Without the endpoint, sections are stored without embeddings |
| `BRAIN_SERVER_HOST`, `BRAIN_SERVER_PORT` | `127.0.0.1`, `9200` | Bind address; any non-loopback address requires `BRAIN_API_TOKEN` |
| `BRAIN_API_TOKEN` | empty | Bearer token for `/api/brain/*` (`openssl rand -hex 32`) |
| `BRAIN_ALLOWED_ORIGINS` | local dev servers and `starpi.app` | CORS allow-list, comma separated |
| `BRAIN_MAX_BODY_BYTES` | `1048576` | Largest accepted request body |
| `BRAIN_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING` or `ERROR` |

## Endpoints

| Method and path | Token | Body | Response |
| --- | --- | --- | --- |
| `GET /api/health` | never | none | `{"status": "healthy", "supabase_live": bool}`; `supabase_live` only means URL and key are set |
| `GET /api/brain/documents` | when set | none | `{"documents": [...], "count": n}` |
| `POST /api/brain/ingest` | when set | `{"text": str, "source_name"?: str, "source_type"?: str}` (200000 / 256 / 64 characters) | document id, title, summary, tags, Markdown, section and embedding counts, storage |
| `POST /api/brain/query` | when set | `{"query": str}` (4000 characters) | `answer`, `sources`, `provider` (`gemini_pool`, `openrouter_pool` or `local_llm`); when no model answers, still 200 with `provider` `none`, `error` `llm_unavailable` and the retrieved context as `answer` |

Rejected requests get a 4xx or 5xx status and a JSON object with an `error` code. Every response,
including errors, carries the security headers.

## Request handling

Every request passes the same guards in a fixed order before a handler runs:

<!-- diagram: backend-request-routing -->
```mermaid
flowchart TD
    Req(["HTTP request on a BrainAPIHandler thread<br/>socket timeout 30 s"]) --> HasDo{"do_GET, do_POST or do_OPTIONS<br/>exists for the method?"}
    HasDo -->|"no, e.g. HEAD, PUT, DELETE,<br/>or a malformed request line or headers"| StdErr["stdlib calls the send_error override<br/>before any guard runs: drains body,<br/>JSON error from the status phrase<br/>e.g. 501 not_implemented, connection closed"]
    HasDo -->|"yes, _dispatch then _route"| Proxy{"_check_proxy_headers<br/>no BRAIN_API_TOKEN and any of Forwarded,<br/>X-Forwarded-For, X-Forwarded-Host,<br/>X-Forwarded-Proto, X-Real-IP?"}
    Proxy -->|"yes"| E401P["401 api_token_required_behind_proxy<br/>with WWW-Authenticate Bearer"]
    Proxy -->|"no"| Orig{"Origin header present and not in allowed_origins?<br/>BRAIN_ALLOWED_ORIGINS, default http://localhost:3000,<br/>http://127.0.0.1:3000, https://www.starpi.app, https://starpi.app<br/>an empty Origin is not allowed"}
    Orig -->|"yes"| E403O["403 origin_not_allowed"]
    Orig -->|"no"| HostC{"_check_host<br/>no token, Host header present and<br/>not localhost or a loopback IP?"}
    HostC -->|"yes"| E403H["403 host_not_allowed"]
    HostC -->|"no"| Path{"path without query or fragment<br/>is a key of ROUTES?"}
    Path -->|"no"| E404["404 not_found"]
    Path -->|"yes"| IsOpt{"method is OPTIONS?"}
    IsOpt -->|"yes"| PreO{"_handle_preflight<br/>allowed Origin header?"}
    PreO -->|"no Origin header"| P204A["204 with Allow"]
    PreO -->|"yes"| P204B["204 with Access-Control-Allow-Methods,<br/>Access-Control-Allow-Headers Authorization, Content-Type,<br/>Access-Control-Max-Age 600"]
    IsOpt -->|"no"| MethOk{"method listed for this path?"}
    MethOk -->|"no"| E405["405 method_not_allowed<br/>with Allow header"]
    MethOk -->|"yes"| Prot{"path starts with /api/brain/<br/>and BRAIN_API_TOKEN is set?"}
    Prot -->|"no, e.g. /api/health"| Handler
    Prot -->|"yes"| Bearer{"_check_auth<br/>scheme Bearer, case-insensitive, and<br/>hmac.compare_digest matches the token?"}
    Bearer -->|"no"| E401["401 unauthorized<br/>with WWW-Authenticate Bearer"]
    Bearer -->|"yes"| Handler["handler method from ROUTES<br/>_handle_health, _handle_documents,<br/>_handle_ingest, _handle_query"]
    Handler -->|"returns"| OK["200 JSON body"]
    Handler -->|"raises ApiError<br/>in body or field checks"| AE
    E401P --> AE
    E403O --> AE
    E403H --> AE
    E404 --> AE
    E405 --> AE
    E401 --> AE
    AE["_dispatch catches ApiError<br/>_discard_unread_body drains the body only if it is unread<br/>and Content-Length is 1 to 65536 bytes, 1 s timeout<br/>larger bodies are not drained"] --> Send
    Handler -->|"BrokenPipeError or ConnectionResetError"| Disc["log client disconnected<br/>close connection, no response"]
    Handler -->|"any other exception"| Started{"logger.exception with traceback,<br/>connection marked to close<br/>response already started?"}
    Started -->|"no"| E500["500 internal_error"]
    Started -->|"yes"| Closed["nothing more is sent"]
    E500 --> Send
    OK --> Send
    P204A --> Send
    P204B --> Send
    StdErr --> Send
    Send["_send adds headers to every response<br/>Content-Type application/json when there is a body<br/>Content-Length except on 204<br/>X-Content-Type-Options nosniff, Cache-Control no-store<br/>Referrer-Policy no-referrer<br/>Content-Security-Policy default-src 'none' and frame-ancestors 'none'<br/>Vary Origin, Access-Control-Allow-Origin for an allowed Origin"]
```

JSON bodies are bounded and validated before any work starts:

<!-- diagram: backend-request-body -->
```mermaid
flowchart TD
    H{"handler for the matched route"}
    H -->|"GET /api/health"| Health["_handle_health<br/>status healthy, supabase_live = bool(db.is_live)<br/>is_live only means SUPABASE_URL and<br/>SUPABASE_SERVICE_ROLE_KEY are set, no connectivity check"]
    H -->|"GET /api/brain/documents"| Docs{"_handle_documents: db.list_documents<br/>is_live and GET /rest/v1/knowledge_documents<br/>order created_at.desc, limit 200<br/>returns a JSON list?"}
    Docs -->|"yes"| R200
    Docs -->|"not live, httpx.HTTPError,<br/>ValueError or non-list body"| DocsMem["warning if live, newest 200 documents<br/>of the in-memory store, storage memory"]
    DocsMem --> R200
    H -->|"POST /api/brain/ingest<br/>or /api/brain/query"| TE{"_read_json_object<br/>Transfer-Encoding header present?"}
    TE -->|"yes"| E411["411 length_required"]
    TE -->|"no"| CL{"Content-Length header present?"}
    CL -->|"no"| E411
    CL -->|"yes"| CLv{"exactly one Content-Length<br/>made of ASCII digits only?"}
    CLv -->|"no"| E400L["400 invalid_content_length"]
    CLv -->|"yes"| Max{"length above max_body_bytes?<br/>BRAIN_MAX_BODY_BYTES, default 1048576<br/>more than 18 digits counts as 10^18"}
    Max -->|"yes"| E413["413 payload_too_large<br/>with max_bytes"]
    Max -->|"no"| CT{"Content-Type media type<br/>is application/json?"}
    CT -->|"no"| E415["415 unsupported_media_type"]
    CT -->|"yes"| Read["rfile.read(length)"]
    Read -->|"TimeoutError, body stalled past 30 s"| E408["408 request_timeout<br/>Connection close"]
    Read -->|"bytes received"| Short{"fewer bytes than Content-Length?"}
    Short -->|"yes"| E400B["400 incomplete_body"]
    Short -->|"no"| Json{"UTF-8 decode and json.loads succeed?"}
    Json -->|"no"| E400J["400 invalid_json"]
    Json -->|"yes"| Obj{"top level is a JSON object?"}
    Obj -->|"no"| E400O["400 json_body_must_be_object"]
    Obj -->|"yes"| Fields{"_string_field checks<br/>ingest: text required, max 200000 chars,<br/>source_name max 256, source_type max 64<br/>query: query required, max 4000 chars"}
    Fields -->|"not a string, too long,<br/>or required and missing or blank"| E400F["400 invalid_field<br/>with field and detail"]
    Fields -->|"ingest"| Ing["ingest_raw_information<br/>source_name default Web-Upload<br/>source_type default text"]
    Fields -->|"query"| Qry["query_brain(user_query)"]
    Health --> R200["_send 200 JSON"]
    Ing --> R200
    Qry --> R200
    Ing -->|"exception type not caught<br/>by the pipeline fallbacks"| E500["500 internal_error<br/>from _dispatch"]
    Qry -->|"exception type not caught<br/>by the fallbacks"| E500
    Docs -->|"other exception type"| E500
    E411 --> AE
    E400L --> AE
    E413 --> AE
    E415 --> AE
    E408 --> AE
    E400B --> AE
    E400J --> AE
    E400O --> AE
    E400F --> AE
    AE["raised as ApiError<br/>_dispatch drains any unread body<br/>and sends the JSON error"]
```

Start-up refuses unsafe configurations:

<!-- diagram: backend-request-startup -->
```mermaid
flowchart TD
    Start(["python server.py [port] [--host HOST] [--log-level LEVEL]"]) --> Env["import core.config<br/>loads backend/.env, else the repo-root .env<br/>parse_env_line: a quoted value ends at its matching quote,<br/>an unquoted value drops a whitespace # comment<br/>last assignment of a key in the file wins<br/>variables already in the environment win"]
    Env --> Cfg["config = BrainConfig()<br/>BRAIN_SERVER_HOST default 127.0.0.1<br/>BRAIN_SERVER_PORT default 9200"]
    Cfg --> Int{"BRAIN_SERVER_PORT or BRAIN_MAX_BODY_BYTES<br/>set but not an integer?"}
    Int -->|"yes"| IntW["warning, default value used"]
    Int -->|"no"| LL
    IntW --> LL{"_env_log_level<br/>BRAIN_LOG_LEVEL value?"}
    LL -->|"empty"| LInfo["log_level INFO"]
    LL -->|"not DEBUG, INFO,<br/>WARNING or ERROR"| LWarn["warning without the raw value<br/>log_level INFO"]
    LL -->|"valid, case-insensitive"| LSet["log_level = that level"]
    LInfo --> Db
    LWarn --> Db
    LSet --> Db
    Db["server.py imports core.supabase_client<br/>db = SupabaseBrainClient()<br/>is_live = SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY<br/>both set, no network call"] --> Args
    Args{"main(): argparse<br/>--log-level upper-cased, one of LOG_LEVELS,<br/>default config.log_level<br/>port, if given, an integer?"}
    Args -->|"no"| ArgErr["argparse error, exit status 2"]
    Args -->|"yes"| Basic["logging.basicConfig(level)"]
    Basic --> Host["run_server<br/>host = --host or BRAIN_SERVER_HOST<br/>port = argument or BRAIN_SERVER_PORT"]
    Host --> Loop{"host is not localhost or a loopback IP<br/>and BRAIN_API_TOKEN is empty?"}
    Loop -->|"yes"| Refuse["log error, raise SystemExit(2)"]
    Loop -->|"no"| TokLen{"token set but shorter<br/>than 32 characters?"}
    TokLen -->|"yes"| TokW["warning"]
    TokLen -->|"no"| Bind
    TokW --> Bind["create_server: BrainHTTPServer (ThreadingHTTPServer)<br/>daemon_threads False, request threads not daemonic<br/>AF_INET6 when the host contains a colon<br/>server_bind skips the reverse DNS lookup"]
    Bind -->|"OSError, e.g. address in use"| BindErr["not caught: traceback, exit status 1"]
    Bind --> Sig{"running in the main thread?"}
    Sig -->|"yes"| SigT["install SIGTERM handler: logs Received SIGTERM,<br/>httpd.shutdown in a daemon thread"]
    Sig -->|"no"| Listen
    SigT --> Listen["log Brain API listening<br/>with supabase_live and token_auth"]
    Listen --> Live{"db.is_live?"}
    Live -->|"no"| MemW["warning: Supabase is not configured,<br/>documents are kept in memory only"]
    Live -->|"yes"| Serve
    MemW --> Serve["serve_forever"]
    Serve -->|"SIGTERM shutdown or KeyboardInterrupt"| Close["finally: server_close<br/>joins the non-daemon request threads,<br/>so requests in flight finish first"]
```

## Pipelines

Ingestion structures the text, chunks it and embeds each section:

<!-- diagram: backend-pipelines-ingest -->
```mermaid
sequenceDiagram
    autonumber
    participant Srv as server.py _handle_ingest
    participant Pipe as ingestion_pipeline
    participant Str as structurer
    participant LLM as Chat Completions endpoint
    participant Chk as chunker
    participant Emb as embeddings
    participant EAPI as Embeddings endpoint
    participant DB as supabase_client db

    Srv->>Pipe: ingest_raw_information(raw_text, source_name, source_type)
    Pipe->>Str: structure_raw_content(raw_text, source_name)
    alt raw_text blank
        Str-->>Pipe: fixed Leeres Dokument structure, tag empty
    else text present
        Str->>LLM: POST LLM_BASE_URL/chat/completions, LLM_MODEL, temperature 0.2, max_tokens 3000
        Note over Str,LLM: timeout 120 s, connect 3 s, Bearer only when LLM_API_KEY is set and not EMPTY
        alt HTTP error, unexpected reply shape or no JSON object
            Str-->>Pipe: fallback_structure, title source_name or first line, tags auto-ingest and raw
        else JSON object parsed (code fences tolerated)
            Str-->>Pipe: title (else source_name or Unbenanntes Dokument), summary, tags (max 20), markdown (raw_text if missing)
        end
    end
    Pipe->>Chk: chunk_markdown(markdown, max_chunk_chars 1500)
    Chk-->>Pipe: sections split at heading lines (levels 1 to 4) and when a section grows past 1500 chars
    Note over Chk: heading Allgemein before the first heading, token_count is the word count
    loop each section
        Pipe->>Emb: get_embedding_with_source(title - heading and section text)
        Emb->>EAPI: POST EMBEDDING_BASE_URL/embeddings, EMBEDDING_MODEL, timeout 20 s, connect 2 s
        alt HTTP error, bad reply shape, not 1536 values, non-numeric, NaN or Infinity
            Emb->>Emb: hash_embedding, L2-normalised word-hash vector
            Emb-->>Pipe: hash vector, is_real False
            Note over Pipe: embedding None, fallback_embedding holds the hash vector
        else 1536 finite floats
            Emb-->>Pipe: vector, is_real True
            Note over Pipe: embedding holds the vector, embedded_count plus 1
        end
    end
    opt fewer embedded sections than sections
        Pipe->>Pipe: warning with the count of sections vector search will miss
    end
    Pipe->>DB: save_document(title, summary, tags, source_type, source_name, raw_text, sections)
    DB-->>Pipe: record with id and storage supabase or memory
    Pipe-->>Srv: document_id, title, summary, tags, markdown, counts, storage, status success
```

On Supabase, a document whose sections cannot be inserted is deleted again (best effort: a failed
rollback is only logged and the row stays). A failed remote save falls back to the in-memory store:

<!-- diagram: backend-pipelines-storage -->
```mermaid
sequenceDiagram
    autonumber
    participant Pipe as ingestion_pipeline
    participant DB as SupabaseBrainClient db
    participant REST as Supabase PostgREST
    participant Mem as in-memory store

    Pipe->>DB: save_document(title, summary, tags, source_type, source_name, raw_content, sections)
    DB->>DB: document_fields clips title 500, summary 5000, source_type 64, source_name 500
    DB->>DB: clip_tags keeps at most 50 tags of at most 100 chars, new uuid4 id, total_sections
    Note over DB: raw_content is not clipped, server.py caps text at 200000 chars
    alt db.is_live, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set
        DB->>DB: section_payload clips heading 1000 and markdown_content 210000
        Note over DB: embedding sent only if it is 1536 finite numbers, else NULL. fallback_embedding is never sent
        DB->>REST: POST /rest/v1/knowledge_documents, Prefer return=representation
        REST-->>DB: created row with id
        opt at least one section
            DB->>REST: POST /rest/v1/knowledge_sections with document_id, Prefer return=minimal
            opt any exception in the section insert
                DB->>REST: DELETE /rest/v1/knowledge_documents?id=eq.doc_id (rollback)
                Note over DB,REST: a failed rollback is only logged and the row stays, the original exception is re-raised
            end
        end
        alt remote save succeeded
            DB-->>Pipe: created row, storage supabase
        else httpx.HTTPError, ValueError, KeyError, IndexError or TypeError
            DB->>Mem: _save_local, warning logged
            DB-->>Pipe: record, storage memory
        end
    else offline mode
        DB->>Mem: _save_local, vector is the embedding or the hash fallback
        DB-->>Pipe: record, storage memory
    end
    Note over Pipe,REST: any other exception type propagates to server.py, which answers 500 internal_error
```

Queries embed the question, search pgvector and ask the answer providers in order:

<!-- diagram: backend-pipelines-query -->
```mermaid
sequenceDiagram
    autonumber
    participant Srv as server.py _handle_query
    participant Rag as rag.query_brain
    participant Emb as embeddings
    participant EAPI as Embeddings endpoint
    participant DB as supabase_client db
    participant REST as Supabase PostgREST
    participant Gem as Gemini API
    participant ORt as OpenRouter
    participant LLM as Chat Completions endpoint

    Srv->>Rag: query_brain(user_query)
    opt user_query blank
        Rag-->>Srv: early return, answer asks for a question, sources empty
    end
    Rag->>Emb: get_embedding_with_source(user_query)
    Emb->>EAPI: POST EMBEDDING_BASE_URL/embeddings
    Emb-->>Rag: vector and is_real, hash vector when the endpoint fails
    alt db.is_live and only a hash vector
        Rag->>Rag: warning, answer without retrieved sections
    else real vector, or offline mode
        Rag->>DB: search_similar_sections(vector, threshold 0.15, limit 5)
        alt db.is_live
            DB->>REST: POST /rest/v1/rpc/match_knowledge_sections
            Note over DB,REST: query_embedding, match_threshold, match_count
            alt RPC ok and body is a list
                REST-->>DB: matching rows
            else HTTP error, invalid JSON or non-list body
                DB->>DB: rank_local_sections over in-memory sections
            end
        else offline mode
            DB->>DB: rank_local_sections, cosine above threshold, top 5
        end
        DB-->>Rag: matching sections
    end
    Rag->>Rag: _format_context into RAG_SYSTEM_PROMPT
    opt GEMINI_API_KEYS set
        loop each key from a round-robin start until one returns text
            Rag->>Gem: POST gemini-2.5-flash generateContent, x-goog-api-key header, 25 s
        end
    end
    alt Gemini returned text
        Rag-->>Srv: answer, sources, provider gemini_pool
    else no Gemini answer
        opt OPENROUTER_API_KEYS set
            loop each key from a round-robin start, then each of 4 models
                Rag->>ORt: POST chat/completions, temperature 0.5, max_tokens 1024, 25 s
            end
        end
        alt OpenRouter returned content
            Rag-->>Srv: answer, sources, provider openrouter_pool
        else no OpenRouter answer
            Rag->>LLM: POST LLM_BASE_URL/chat/completions, temperature 0.3, max_tokens 2048, 60 s
            alt local answer not empty
                Rag-->>Srv: answer, sources, provider local_llm
            else HTTP error or empty answer
                Rag-->>Srv: hint plus context_text as answer, provider none, error llm_unavailable
            end
        end
    end
```

## Command line

<!-- diagram: backend-pipelines-cli -->
```mermaid
flowchart TD
    Cli(["python -m core.cli_supabase COMMAND<br/>run from backend/, SupabaseService"]) --> Parse{"subcommand?"}
    Parse -->|"missing or unknown"| ArgErr["argparse error, exit status 2"]
    Parse -->|"health"| HConf{"SUPABASE_URL and<br/>SUPABASE_SERVICE_ROLE_KEY set?"}
    HConf -->|"no"| HOff["status offline_mode, connected false"]
    HConf -->|"yes"| HGet{"GET /rest/v1/brain_settings<br/>select key, limit 1<br/>timeout 10 s, connect 5 s"}
    HGet -->|"httpx.HTTPError"| HUnr["status unreachable, connected false"]
    HGet -->|"HTTP 200 or 206"| HOk["status connected, connected true"]
    HGet -->|"any other status"| HErr["status error with status_code<br/>and the first 500 chars of the body"]
    HOk --> HExit0["print JSON, exit 0"]
    HOff --> HExit1["print JSON, exit 1"]
    HUnr --> HExit1
    HErr --> HExit1
    Parse -->|"list"| LReq{"configured, and GET /rest/v1/knowledge_documents<br/>newest first, no limit, timeout 15 s<br/>returns a JSON list?"}
    LReq -->|"yes"| LPrint["print Total documents and one line<br/>per document, exit 0"]
    LReq -->|"not configured, httpx.HTTPError,<br/>ValueError or non-list body"| LMem["warning if configured, in-memory list<br/>empty in a fresh CLI process"]
    LMem --> LPrint
    Parse -->|"test-query"| QText["query = the words joined, default Projekt Alpha<br/>get_embedding_with_source"]
    QText --> QReal{"configured and only a hash vector,<br/>embedding endpoint unavailable?"}
    QReal -->|"yes"| QE2["remote vector search skipped<br/>message on stderr, exit 1"]
    QReal -->|"no"| QM{"match_sections threshold 0.1, limit 3<br/>configured, and RPC match_knowledge_sections<br/>returns a JSON list? timeout 20 s"}
    QM -->|"yes"| QPrint["print matches: document title,<br/>heading and similarity, exit 0"]
    QM -->|"not configured, httpx.HTTPError,<br/>ValueError or non-list body"| QMem["rank_local_sections over the<br/>in-memory sections"]
    QMem --> QPrint
    Smoke(["python backend/scripts/brain_smoke.py<br/>--query Q repeatable, --skip-ingest, --verbose"]) --> SLive["print Supabase live = db.is_live"]
    SLive --> SIng{"--skip-ingest?"}
    SIng -->|"no"| SIngest["ingest_raw_information with a sample meeting note<br/>Meeting_Alpha_28Aug.txt, meeting_notes<br/>writes a real document when Supabase is configured"]
    SIng -->|"yes"| SQ
    SIngest --> SQ["query_brain for each --query<br/>or the 2 default questions<br/>print provider, answer and sources, exit 0"]
```

## Tests

```bash
python -m pip install -r requirements-dev.txt
ruff check . && ruff format --check .
python -m unittest discover -s . -p 'test_*.py'
```

The unit tests run offline: calls to external services are mocked or replaced with fakes, and the
server tests send real HTTP requests to a server started on `127.0.0.1` with an ephemeral port. `scripts/brain_smoke.py` is a manual end-to-end
check against live endpoints. The database policies are tested separately with
`supabase/tests/run_rls_tests.sh` (see [supabase/README.md](supabase/README.md)).

## Deployment

[aws/cloud_architecture.md](aws/cloud_architecture.md) describes the EC2 deployment with
`remote_sync.sh` and `aws/deploy_ec2.sh`, the reverse proxy and operations.
