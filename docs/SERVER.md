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
| `GET /api/health` | Which features the site offers, as booleans only. |
| `POST /api/voice/speak`, `POST /api/voice/transcribe` | **Speech** with the site's keys: read-aloud (Gemini voices, ElevenLabs premade voices) and dictation (Gemini). |
| `GET /api/voice/voices` | What the site offers for speech, as booleans and the fixed voice lists. |
| `POST /api/voice/live-token` | A single-use ephemeral token for one Gemini Live conversation, from the site's key or the user's key. |

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

## Speech routes

The speech routes run the same front checks as the relay (origin, a per-IP limit of their own,
the access code; `GET /api/voice/voices` skips the origin check like any same-origin `GET`). They
use the site's Gemini keys (`GEMINI_API_KEYS`, while the Gemini pool is enabled) and its
ElevenLabs keys (`ELEVENLABS_API_KEYS`), with the same rotation, failover and parking as a pool.
Neither text nor audio is stored or logged.

- `speak` takes `{ text, source, voice, locale }` (one piece of at most 600 characters; the app
  sends only sentences its sentence check released) and answers a WAV file. Only the prebuilt
  Gemini voices and ElevenLabs premade voices on the app's list can be named.
- `transcribe` takes `{ audio, locale, glossary? }`: a base64 WAV of at most 60 seconds and the
  user's own list of names and terms. It answers `{ text }`.
- `live-token` takes `{ voice, locale, camera? }` and asks Gemini for a token that opens one
  session within a minute and carries the whole session setup (model, voice, instruction), so the
  browser cannot change it. With the header `x-goog-api-key` the user's own key mints the token
  for this one call and the site's budgets do not apply. A key in the query string is refused.

Besides the per-IP limits, the site's keys have daily ceilings per function instance: characters
spoken, seconds transcribed and Live sessions started.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `STARPI_ALLOWED_ORIGINS` | empty | Further origins, comma separated, whose pages may call the functions. `NVIDIA_ALLOWED_ORIGINS` and `RELAY_ALLOWED_ORIGINS` are older names for the same list. |
| `STARPI_RELAY_RPM_PER_IP` | `30` | Relay requests per client IP and minute. |
| `STARPI_POOL_PROVIDERS` | all four | The pools the site offers, comma separated: `nvidia,groq,gemini,openrouter`. A pool also needs keys. |
| `NVIDIA_API_KEYS`, `GROQ_API_KEYS`, `GEMINI_API_KEYS`, `OPENROUTER_API_KEYS` | empty | The keys of each pool, comma separated. Entries of another shape are ignored and only counted in the log. |
| `STARPI_POOL_RPM_PER_IP` | `20` | Pool requests per client IP and minute, over all pools. `NVIDIA_RATE_LIMIT_PER_MINUTE` is the older name. |
| `STARPI_POOL_DAILY_PER_IP` | `200` | Pool requests per client IP and UTC day that reach a provider; `0` turns the budget off. |
| `ELEVENLABS_API_KEYS` | empty | The site's ElevenLabs keys for read-aloud, comma separated. |
| `STARPI_VOICE_POOL` | on | `off` keeps the site's keys out of the speech routes (users can still bring their own). |
| `STARPI_VOICE_RPM_PER_IP` | `20` | Speech requests per client IP and minute. |
| `STARPI_VOICE_DAILY_PER_IP` | `150` | Speech requests per client IP and UTC day that use the site's keys; `0` turns it off. |
| `STARPI_VOICE_DAILY_TTS_CHARS`, `STARPI_VOICE_DAILY_STT_SECONDS`, `STARPI_VOICE_DAILY_LIVE` | `300000`, `7200`, `200` | Daily ceilings of the site's keys: characters spoken, seconds transcribed, Live sessions. |
| `STARPI_GEMINI_TTS_MODEL`, `STARPI_GEMINI_STT_MODEL`, `STARPI_GEMINI_LIVE_MODEL`, `STARPI_ELEVENLABS_MODEL` | built in | The speech models the routes use. |
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
themselves (an `available(env)` export), so they turn true only once a route serves requests; the
voice flags are true when the site's own keys can speak, transcribe or start Live conversations.

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
