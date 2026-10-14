// @ts-check
// The two NVIDIA routes, shared by the Vercel Functions (api/chat/nvidia.js, api/models/nvidia.js) and
// `node scripts/serve.mjs --functions`. Dependencies are passed in, so tests need neither network nor
// environment; runtimeDeps() builds them from the environment.
import { NVIDIA_LIMITS, NVIDIA_PROXY, publicCatalog } from '../../src/js/models/nvidia-catalog.js';
import { parseKeys, parseOrigins, positiveInt, readEnv } from './env.js';
import { checkSameOrigin, clientIp, createRateLimiter, json, readJsonBody, refuse } from './guards.js';
import { validateChatRequest } from './nvidia-request.js';
import { createKeyRouter } from './nvidia-router.js';
import { relayStream } from './nvidia-stream.js';

/**
 * @typedef {object} Deps
 * @property {import('./nvidia-router.js').KeyRouter | null} router null when NVIDIA_API_KEYS holds no valid key
 * @property {ReturnType<typeof createRateLimiter>} limiter
 * @property {readonly string[]} extraOrigins
 * @property {() => number} now
 */

/** vercel.json `functions["api/chat/nvidia.js"].maxDuration` in milliseconds (a unit test keeps them equal). */
export const FUNCTION_MAX_MS = 300_000;
// The relay ends the stream this long before the platform stops the function, so the error event arrives.
const SHUTDOWN_MARGIN_MS = 3000;
const RATE_WINDOW_MS = 60_000;

const SSE_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  'X-Content-Type-Options': 'nosniff',
  'X-Accel-Buffering': 'no',
});

/** @type {{ signature: string, deps: Deps } | null} */
let cached = null;

/**
 * Dependencies from the environment. They are rebuilt only when a relevant variable changes, so key
 * cooldowns and rate-limit windows carry over between requests on a warm instance.
 * @returns {Deps}
 */
export function runtimeDeps() {
  const env = readEnv();
  const signature = [env.NVIDIA_API_KEYS, env.NVIDIA_RATE_LIMIT_PER_MINUTE, env.NVIDIA_ALLOWED_ORIGINS].join('\n');
  if (cached?.signature !== signature) {
    const { keys, invalid } = parseKeys(env.NVIDIA_API_KEYS);
    if (invalid > 0) console.warn(`nvidia: ignored ${invalid} malformed entries in NVIDIA_API_KEYS`);
    const now = () => Date.now();
    cached = {
      signature,
      deps: {
        router: keys.length > 0 ? createKeyRouter({ keys, fetch, now }) : null,
        limiter: createRateLimiter({ limit: positiveInt(env.NVIDIA_RATE_LIMIT_PER_MINUTE, NVIDIA_PROXY.rateLimitPerMinute), windowMs: RATE_WINDOW_MS, now }),
        extraOrigins: parseOrigins(env.NVIDIA_ALLOWED_ORIGINS),
        now,
      },
    };
  }
  return cached.deps;
}

/**
 * POST /api/chat/nvidia. The guards run in this order (the Python route uses the same): origin, rate
 * limit, keys configured, body, validation. Then the key router fails over until the first byte, and
 * the relay streams the rest.
 * @param {Request} request
 * @param {Deps} deps
 * @returns {Promise<Response>}
 */
export async function handleChat(request, { router, limiter, extraOrigins, now }) {
  const startedAt = now();
  const refusal = checkSameOrigin(request, extraOrigins);
  if (refusal) return refuse(refusal);
  const rate = limiter.hit(clientIp(request));
  if (!rate.ok) return refuse({ status: 429, error: 'rate_limited', retryAfterS: rate.retryAfterS });
  if (!router) return refuse({ status: 503, error: 'nvidia_not_configured' });

  const read = await readJsonBody(request, NVIDIA_LIMITS.maxBodyBytes);
  if (!read.ok) return refuse(read);
  const valid = validateChatRequest(read.data);
  if (!valid.ok) return refuse(valid);

  const opened = await router.open(valid.body, { signal: request.signal, deadline: startedAt + NVIDIA_PROXY.failoverBudgetMs });
  if (!opened.ok) return refuse(opened);
  const stream = relayStream({
    first: opened.first,
    reader: opened.reader,
    abort: opened.abort,
    now,
    idleMs: NVIDIA_PROXY.idleTimeoutMs,
    hardDeadline: startedAt + Math.min(NVIDIA_PROXY.streamMaxMs, FUNCTION_MAX_MS - SHUTDOWN_MARGIN_MS),
    maxBytes: NVIDIA_PROXY.maxStreamBytes,
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

/**
 * GET /api/models/nvidia: the public allowlist and whether the server has keys (never keys or a count).
 * @param {Deps} deps
 */
export function handleModels({ router }) {
  return json(200, publicCatalog(router !== null));
}
