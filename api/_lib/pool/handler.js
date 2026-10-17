// @ts-check
// The site's key pools: POST /api/pool?provider=<id>&path=<upstream path> streams one answer from a
// provider with a key the site holds, so the browser needs none. POST /api/chat/nvidia is the same
// handler with the provider and the path fixed, for clients of earlier versions. The guards run in
// this order:
//
//   1. same-origin check (STARPI_ALLOWED_ORIGINS and its aliases)
//   2. per-IP limit (STARPI_POOL_RPM_PER_IP, default 20 a minute; NVIDIA_RATE_LIMIT_PER_MINUTE is
//      the older name)
//   3. access code, when the site sets STARPI_ACCESS_CODE
//   4. a pool the site enables (STARPI_POOL_PROVIDERS) and a path of its dialect
//   5. keys configured (<P>_API_KEYS), else 503
//   6. body (JSON object, capped) and validation (api/_lib/pool/request.js)
//   7. per-IP daily budget (STARPI_POOL_DAILY_PER_IP, default 200), counted for requests that reach
//      a provider
//
// Then the key router fails over until the first byte and relayStream streams the rest. Like the
// per-minute limit, the daily budget lives in one function instance: a best-effort brake.
//
// GET /api/models/pool and GET /api/health read their pool facts from here as well; they report
// whether a pool has keys, never how many.
import { readAccessCode } from '../access.js';
import { positiveInt, readEnv } from '../env.js';
import { clientIp, createRateLimiter, json, readJsonBody, refuse } from '../guards.js';
import { relayStream } from '../nvidia-stream.js';
import { allowedOrigins, createDailyLimiter, guardRequest } from '../origins.js';
import { scrubSecrets } from '../relay/scrub.js';
import { resolveRoot } from '../relay/upstreams.js';
import { enabledPoolIds, findPoolSpec, parsePoolKeys, POOL_IDS, publicPoolModels } from './allowlist.js';
import { bearerAuth, createKeyRouter } from './key-router.js';
import { poolRoute, validatePoolRequest } from './request.js';

/**
 * @typedef {import('./allowlist.js').PoolSpec} PoolSpec
 * @typedef {import('./key-router.js').KeyRouter} KeyRouter
 * @typedef {import('../origins.js').Limiter} Limiter
 * @typedef {object} Pool
 * @property {PoolSpec} spec with `root` set to the API root in use (fixed, or a loopback fake)
 * @property {KeyRouter | null} router null while the pool has no valid key
 * @property {boolean} simulated the API root is a loopback fake
 * @typedef {object} PoolDeps
 * @property {Readonly<Record<string, Pool>>} pools the pools the site enables
 * @property {Limiter} limiter per-IP requests a minute
 * @property {Limiter} daily per-IP requests a day
 * @property {readonly string[]} extraOrigins
 * @property {string} accessCode '' when the site has none
 * @property {() => number} now
 * @typedef {object} PoolTarget
 * @property {string} provider
 * @property {string} path the upstream path the browser names
 * @property {string} [notConfigured] error code without keys (default pool_not_configured)
 * @property {number} [maxBodyBytes] a smaller body cap than the pool's
 * @property {boolean} [textOnly] refuse images even for vision models
 */

/** vercel.json `functions["api/pool.js"].maxDuration` in milliseconds (a unit test keeps them equal). */
export const POOL_FUNCTION_MAX_MS = 300_000;
// The stream ends this long before the platform stops the function, so the error event arrives.
const SHUTDOWN_MARGIN_MS = 3000;
const RATE_WINDOW_MS = 60_000;

export const POOL_DEFAULTS = Object.freeze({
  /** Requests per client IP and minute, over all pools (STARPI_POOL_RPM_PER_IP). */
  rateLimitPerMinute: 20,
  /** Requests per client IP and UTC day that reach a provider (STARPI_POOL_DAILY_PER_IP). */
  dailyPerIp: 200,
});

const SSE_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  'X-Content-Type-Options': 'nosniff',
  'X-Accel-Buffering': 'no',
});

/** The variables pool dependencies are built from. */
function poolVariables() {
  return [
    'STARPI_POOL_PROVIDERS',
    'STARPI_POOL_RPM_PER_IP',
    'NVIDIA_RATE_LIMIT_PER_MINUTE',
    'STARPI_POOL_DAILY_PER_IP',
    'STARPI_ALLOWED_ORIGINS',
    'NVIDIA_ALLOWED_ORIGINS',
    'RELAY_ALLOWED_ORIGINS',
    'STARPI_ACCESS_CODE',
    ...POOL_IDS.flatMap((id) => [/** @type {PoolSpec} */ (findPoolSpec(id)).keysVariable, `STARPI_${id.toUpperCase()}_BASE_URL`]),
  ];
}

/**
 * The enabled pools from the environment, each with its router (or none without keys).
 * @param {Record<string, string | undefined>} env
 * @param {{ fetch: typeof fetch, now: () => number, warn?: (line: string) => void }} io
 * @returns {Record<string, Pool>}
 */
export function buildPools(env, { fetch: send, now, warn = (line) => console.warn(scrubSecrets(line)) }) {
  /** @type {Record<string, Pool>} */
  const pools = {};
  for (const id of enabledPoolIds(env.STARPI_POOL_PROVIDERS)) {
    const base = /** @type {PoolSpec} */ (findPoolSpec(id));
    const { root, simulated } = resolveRoot(id, base.root, env);
    const spec = { ...base, root };
    const { keys, invalid } = parsePoolKeys(spec, env[spec.keysVariable]);
    if (invalid > 0) warn(`pool ${id}: ignored ${invalid} malformed entries in ${spec.keysVariable}`);
    const authHeader = spec.auth === 'bearer' ? bearerAuth : (/** @type {string} */ key) => /** @type {[string, string]} */ ([spec.auth, key]);
    const router = keys.length > 0
      ? createKeyRouter({ keys, fetch: send, now, upstreamUrl: `${root}/v1/chat/completions`, authHeader, label: id, keyRpm: spec.keyRpm, timing: spec.timing, log: (line) => console.warn(scrubSecrets(line)) })
      : null;
    pools[id] = { spec, router, simulated };
  }
  return pools;
}

/** @type {{ signature: string, deps: PoolDeps } | null} */
let cached = null;

/**
 * Dependencies from the environment. They are rebuilt only when a relevant variable changes, so key
 * cooldowns, token buckets and rate windows carry over between requests on a warm instance.
 * @returns {PoolDeps}
 */
export function poolRuntimeDeps() {
  const env = readEnv();
  const signature = poolVariables().map((name) => env[name] ?? '').join('\n');
  if (cached?.signature !== signature) {
    const now = () => Date.now();
    const perMinute = positiveInt(env.STARPI_POOL_RPM_PER_IP, positiveInt(env.NVIDIA_RATE_LIMIT_PER_MINUTE, POOL_DEFAULTS.rateLimitPerMinute));
    // "0" switches the daily budget off; anything else that is no positive integer keeps the default.
    const daily = (env.STARPI_POOL_DAILY_PER_IP ?? '').trim() === '0' ? 0 : positiveInt(env.STARPI_POOL_DAILY_PER_IP, POOL_DEFAULTS.dailyPerIp);
    cached = {
      signature,
      deps: {
        pools: buildPools(env, { fetch: (input, init) => fetch(input, init), now }),
        limiter: createRateLimiter({ limit: perMinute, windowMs: RATE_WINDOW_MS, now }),
        daily: createDailyLimiter({ limit: daily, now }),
        extraOrigins: allowedOrigins(env),
        accessCode: readAccessCode(env),
        now,
      },
    };
  }
  return cached.deps;
}

/**
 * Provider and upstream path of a pool URL (`?provider=<id>&path=<upstream path>`).
 * @param {string} url
 * @returns {PoolTarget}
 */
export function poolTarget(url) {
  const params = URL.parse(url)?.searchParams;
  return { provider: params?.get('provider') ?? '', path: params?.get('path') ?? '' };
}

/**
 * POST /api/pool (and POST /api/chat/nvidia, with the target fixed).
 * @param {Request} request
 * @param {PoolDeps} deps
 * @param {PoolTarget} [fixed] provider and path when the route names them; the URL otherwise
 * @returns {Promise<Response>}
 */
export async function handlePool(request, deps, fixed) {
  const { now } = deps;
  const startedAt = now();
  const front = await guardRequest(request, deps);
  if (front) return refuse(front);

  const target = fixed ?? poolTarget(request.url);
  const notConfigured = target.notConfigured ?? 'pool_not_configured';
  const pool = Object.hasOwn(deps.pools, target.provider) ? deps.pools[target.provider] : null;
  if (!pool) return refuse(fixed ? { status: 503, error: notConfigured } : { status: 404, error: 'unknown_pool' });
  const route = poolRoute(pool.spec, target.path);
  if (!route.ok) return refuse(route);
  if (!pool.router) return refuse({ status: 503, error: notConfigured });

  const read = await readJsonBody(request, Math.min(pool.spec.limits.maxBodyBytes, target.maxBodyBytes ?? Number.POSITIVE_INFINITY));
  if (!read.ok) return refuse(read);
  const spec = target.textOnly ? { ...pool.spec, models: pool.spec.models.map((m) => ({ ...m, vision: false })) } : pool.spec;
  const valid = validatePoolRequest(spec, route, read.data);
  if (!valid.ok) return refuse(valid);
  const daily = deps.daily.hit(clientIp(request));
  if (!daily.ok) return refuse({ status: 429, error: 'daily_limit_reached', retryAfterS: daily.retryAfterS });

  const { timing } = pool.spec;
  const opened = await pool.router.open(valid.body, { signal: request.signal, deadline: startedAt + timing.failoverBudgetMs, url: valid.url });
  if (!opened.ok) return refuse(opened);
  const stream = relayStream({
    first: opened.first,
    reader: opened.reader,
    abort: opened.abort,
    now,
    idleMs: timing.idleTimeoutMs,
    hardDeadline: startedAt + Math.min(timing.streamMaxMs, POOL_FUNCTION_MAX_MS - SHUTDOWN_MARGIN_MS),
    maxBytes: timing.maxStreamBytes,
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

/**
 * Per pool: whether it serves requests (enabled and keyed) and whether it points at a local fake.
 * Every known pool appears, so the shape does not depend on the configuration.
 * @param {Readonly<Record<string, Pool>>} pools
 */
export function poolStatus(pools) {
  /** @type {Record<string, { configured: boolean, simulated: boolean }>} */
  const status = {};
  for (const id of POOL_IDS) {
    const pool = Object.hasOwn(pools, id) ? pools[id] : null;
    status[id] = { configured: Boolean(pool?.router), simulated: Boolean(pool?.simulated) };
  }
  return status;
}

/**
 * GET /api/models/pool: per pool whether it serves requests and the models it allows (never keys
 * or a key count).
 * @param {PoolDeps} deps
 */
export function handlePoolModels({ pools }) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [id, { configured }] of Object.entries(poolStatus(pools))) {
    const spec = /** @type {PoolSpec} */ (findPoolSpec(id));
    out[id] = {
      configured,
      dialect: spec.dialect,
      defaultModel: spec.defaultModel,
      limits: { maxMessages: spec.limits.maxMessages, maxMessageChars: spec.limits.maxMessageChars, maxTotalChars: spec.limits.maxTotalChars, maxOutputTokens: spec.limits.maxOutputTokens, maxImages: spec.limits.maxImages },
      models: publicPoolModels(spec),
    };
  }
  return json(200, { version: 1, pools: out });
}
