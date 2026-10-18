# Server functions: relay, pools, health and access code

Starpi's Vercel Functions under `api/` are small and stateless. They never store a request, an
answer or a key, and they never write a header or a body to a log. This page is for anyone who
deploys their own copy of Starpi.

| Route | What it does |
| --- | --- |
| `GET`/`POST /api/relay/<provider>/<path>` | The **BYOK relay**: forwards one request with the user's own key to an allowlisted path of a known provider, for providers whose API does not accept calls from a browser. |
| `POST /api/pool?provider=<id>&path=<path>` | The **site pools**: streams an answer with a key the site holds, so visitors need no key of their own. |
| `POST /api/chat/nvidia` | The NVIDIA pool under its earlier address, with its earlier rules (text only, 256 KiB body). |
| `GET /api/models/pool` | Per pool: whether it is configured and the models it allows. |
| `POST /api/research/step` | One step of a **research job** on the Gemini pool: a tool round over the visitor's own documents, or a web search. |
| `GET /api/health` | Which features the site offers, as booleans only. |

All of them run with Node.js on Vercel, or locally with `npm run preview`
(`node scripts/serve.mjs --functions`), which applies the same route table and rewrites.

## The relay

The relay answers only for a fixed list of providers, each with a fixed API root
(`api/_lib/relay/upstreams.js`): `anthropic`, `openai`, `gemini`, `xai`, `groq`, `mistral`,
`deepseek`, `openrouter`, `nvidia`, `elevenlabs` (speech and voices), `brave` and `tavily`
(search). The host never comes from the browser, so local servers and custom URLs cannot be
reached through it; the browser talks to those directly.

Every request runs these checks in this order:

1. **Origin.** `Sec-Fetch-Site`, when sent, must be `same-origin`, and `Origin` must match the
   host, unless the origin is listed in `STARPI_ALLOWED_ORIGINS` (403).
2. **Rate limit** per client IP (`STARPI_RELAY_RPM_PER_IP`, 429 with `Retry-After`).
3. **Access code**, when `STARPI_ACCESS_CODE` is set (401).
4. **Allowlist.** A known provider (404 `unknown_provider`), an allowed method and path (404
   `path_not_allowed`, 405), a query without credentials (400 `key_in_query`).
5. **Key.** Exactly one auth header, in the provider's own style (`Authorization: Bearer`,
   `x-api-key`, `x-goog-api-key`, `xi-api-key` or `x-subscription-token`); a missing key is 401
   `key_required`, any other credential header 400.
6. **Body.** At most 4 MB; a JSON object, or multipart form data for transcription.
7. **Headers.** Only `content-type`, `accept`, `anthropic-version`, known `anthropic-beta` values
   and OpenRouter's attribution headers are forwarded. Cookies and client addresses never are.

The upstream request does not follow redirects. Event streams are relayed as they arrive (90 s
without data or 16 MB end the stream with an error event, and it ends 3 s before the function's
time limit); JSON and audio pass through with the same limits. When the provider answers with an
error, the relay reads at most 2 KB of it and returns only `{ "error": "<identifier>",
"upstreamStatus": <status> }`, where the identifier is the provider's own error code if it is a
short snake_case word.

## Site pools

A pool spends the site's keys, so it accepts much less than the relay: chat text, images for
models marked as vision models, no tools, a clamped output length and a model from the pool's
allowlist (`api/_lib/pool/allowlist.js`). The pools are `nvidia`, `groq` and `openrouter`
(OpenAI-compatible chat completions) and `gemini` (`streamGenerateContent`).

Each request starts at the next key of the pool and moves on to the following keys until a
stream starts. A key answered with 429 waits for its `Retry-After`, a key rejected with 401 or 403
waits 30 minutes, and a key that failed or timed out waits briefly. Each key also has a request
budget per minute, so the pool spreads the load before a provider starts refusing.

## Research steps

A research job asks a model to search the visitor's documents with three read-only tools
(`search_sources`, `read_excerpt`, `list_documents`) and, if the visitor wants, the web. With the
visitor's own key the browser does all of it directly. Without one, it uses the site's Gemini pool
through `POST /api/research/step`, one step per request:

- **Sources part.** The server sends the question and the tool results so far to Gemini. When the
  model asks for tools, the server returns its turn with an HMAC-SHA256 signature; the browser runs
  the tools on its own documents and sends the turn back unchanged with the results. A turn whose
  signature does not match (a changed turn, question, round or model, or a key change of the site)
  is refused with 400 `history_not_signed` before anything reaches Google. The signing key is
  derived with HKDF from the pool's first Gemini key and never leaves the function. After five tool
  rounds the model may only answer.
- **Web part.** A single step with Google Search; the answer comes back exactly as grounded, with
  its segments, sources, queries and search suggestions.

The guards are those of the pools: origin, a per-IP limit, the access code, the Gemini pool's keys
(503 `research_not_configured` without them), then the shape of the request and the signatures,
and a per-IP daily budget counted only for steps that reach Google. The function stores nothing
between steps.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `STARPI_ALLOWED_ORIGINS` | empty | Further origins, comma separated, whose pages may call the functions. `NVIDIA_ALLOWED_ORIGINS` and `RELAY_ALLOWED_ORIGINS` are older names for the same list. |
| `STARPI_RELAY_RPM_PER_IP` | `30` | Relay requests per client IP and minute. |
| `STARPI_POOL_PROVIDERS` | all four | The pools the site offers, comma separated: `nvidia,groq,gemini,openrouter`. A pool also needs keys. |
| `NVIDIA_API_KEYS`, `GROQ_API_KEYS`, `GEMINI_API_KEYS`, `OPENROUTER_API_KEYS` | empty | The keys of each pool, comma separated. Entries of another shape are ignored and only counted in the log. |
| `STARPI_POOL_RPM_PER_IP` | `20` | Pool requests per client IP and minute, over all pools. `NVIDIA_RATE_LIMIT_PER_MINUTE` is the older name. |
| `STARPI_POOL_DAILY_PER_IP` | `200` | Pool requests per client IP and UTC day that reach a provider; `0` turns the budget off. |
| `STARPI_RESEARCH_MODEL` | `gemini-2.5-flash` | The model of research steps; only a model of the Gemini pool's allowlist is taken. Research steps need `GEMINI_API_KEYS` and `gemini` among the pools. |
| `STARPI_RESEARCH_RPM_PER_IP` | `60` | Research steps per client IP and minute. A job takes up to ten (six for the documents, four web searches) and three run at once; the browser waits out a 429 of this limit. |
| `STARPI_RESEARCH_DAILY_PER_IP` | `300` | Research steps per client IP and UTC day that reach Google; `0` turns the budget off. |
| `STARPI_ACCESS_CODE` | empty | When set, the relay, the pools, the voice routes and research steps require the header `x-starpi-access` with this code. |
| `STARPI_<PROVIDER>_BASE_URL` | empty | For tests: points a provider at a local fake (`localhost`, `127.0.0.1` or `[::1]` only). `GET /api/health` then reports it as simulated. |

On Vercel, store keys and the access code as **Sensitive** variables and redeploy after a change.

The rate limits and the daily budget are counted in each function instance. They brake abuse,
but they are not a global quota: a busy deployment runs several instances, and a client that
reaches several of them gets through more often. Use the provider's own spending limits for a
hard ceiling.

## Access code

An access code is useful for a private deployment, or to keep a pool for a group of people. Choose
a long random value (16 characters or more). It is compared in constant time, never logged and
never echoed; `GET /api/health` only reports `"access": true`. The access check runs after the
rate limit, so the code cannot be guessed faster than the limit allows. The code protects the
functions only, not the static site.

## Health

`GET /api/health` answers, for example:

```json
{
  "version": "3.0.0",
  "pools": { "nvidia": true, "groq": false, "gemini": true, "openrouter": false },
  "simulated": { "anthropic": false, "openai": false, "gemini": false },
  "voice": { "tts": false, "stt": false, "live": false },
  "research": false,
  "access": false
}
```

`simulated` lists every relay provider. The voice and research flags come from the routes
themselves (an `available(env)` export), so they turn true only once a route serves requests:
`research` is true when the Gemini pool has keys.

## Checking a provider by hand

```bash
GROQ_API_KEYS=… npm run providers:ping -- --provider groq
ANTHROPIC_API_KEY=… npm run providers:ping -- --provider anthropic
npm run providers:ping -- --provider gemini --model gemini-2.5-flash
```

The script lists the provider's models (or voices, or one search result), checks whether the API
allows calls from a browser, and for a pool sends one small streamed request per allowlisted
model. It prints statuses, timings and model ids only, and says `skipped` (exit code 0) when no
key is set. It uses real quota. `npm run nvidia:ping` keeps its own NVIDIA report.
