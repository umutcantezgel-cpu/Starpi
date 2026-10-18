// @ts-check
// POST /api/research/step (Vercel Function): one step of a research job on the site's Gemini pool
// (api/_lib/gemini/research.js). The guards run in this order:
//
//   1. same-origin check (STARPI_ALLOWED_ORIGINS and its aliases)
//   2. per-IP limit (STARPI_RESEARCH_RPM_PER_IP, default 60 steps a minute)
//   3. access code, when the site sets STARPI_ACCESS_CODE
//   4. Gemini keys of the pool (GEMINI_API_KEYS, with gemini among STARPI_POOL_PROVIDERS), else 503
//   5. body (JSON object, capped) and its shape
//   6. the signatures of the model turns in the history
//   7. per-IP daily budget (STARPI_RESEARCH_DAILY_PER_IP, default 300 steps), counted for steps that
//      reach Google
//
// GET /api/health reports `research: true` when step 4 would pass. Every other method gets 405.
import { readAccessCode } from '../_lib/access.js';
import { positiveInt, readEnv } from '../_lib/env.js';
import { checkStepRequest, researchModel, runStep, scrubLine, StepError, STEP_LIMITS } from '../_lib/gemini/research.js';
import { clientIp, createRateLimiter, json, methodNotAllowed, readJsonBody, refuse } from '../_lib/guards.js';
import { allowedOrigins, createDailyLimiter, guardRequest } from '../_lib/origins.js';
import { enabledPoolIds, findPoolSpec, parsePoolKeys } from '../_lib/pool/allowlist.js';
import { resolveRoot } from '../_lib/relay/upstreams.js';

/**
 * @typedef {import('../_lib/origins.js').Limiter} Limiter
 * @typedef {object} ResearchDeps
 * @property {readonly string[]} keys
 * @property {string} root
 * @property {string} model
 * @property {Limiter} limiter
 * @property {Limiter} daily
 * @property {readonly string[]} extraOrigins
 * @property {string} accessCode
 * @property {typeof fetch} fetch
 * @property {() => number} now
 * @property {number} [timeoutMs]
 * @property {(line: string) => void} [log]
 */

export const RESEARCH_DEFAULTS = Object.freeze({
  /**
   * Steps per client IP and minute (STARPI_RESEARCH_RPM_PER_IP). A job takes up to ten (six for the
   * documents: five tool rounds and the answer; four web searches), and three jobs run at once.
   */
  rateLimitPerMinute: 60,
  /** Steps per client IP and UTC day that reach Google (STARPI_RESEARCH_DAILY_PER_IP). */
  dailyPerIp: 300,
});

const GEMINI = /** @type {import('../_lib/pool/allowlist.js').PoolSpec} */ (findPoolSpec('gemini'));

/**
 * The pool's Gemini keys, or none when the site does not offer the Gemini pool.
 * @param {Record<string, string | undefined>} env
 */
function researchKeys(env) {
  if (!enabledPoolIds(env.STARPI_POOL_PROVIDERS).includes('gemini')) return [];
  return parsePoolKeys(GEMINI, env[GEMINI.keysVariable]).keys;
}

/**
 * Whether this route serves requests; GET /api/health reports it as `research`.
 * @param {Record<string, string | undefined>} env
 */
export const available = (env) => researchKeys(env).length > 0;

const VARIABLES = Object.freeze([
  'STARPI_POOL_PROVIDERS',
  GEMINI.keysVariable,
  'STARPI_GEMINI_BASE_URL',
  'STARPI_RESEARCH_MODEL',
  'STARPI_RESEARCH_RPM_PER_IP',
  'STARPI_RESEARCH_DAILY_PER_IP',
  'STARPI_ALLOWED_ORIGINS',
  'NVIDIA_ALLOWED_ORIGINS',
  'RELAY_ALLOWED_ORIGINS',
  'STARPI_ACCESS_CODE',
]);

/** @type {{ signature: string, deps: ResearchDeps } | null} */
let cached = null;

/**
 * Dependencies from the environment, rebuilt only when a relevant variable changes, so rate windows
 * carry over between requests on a warm instance.
 * @returns {ResearchDeps}
 */
export function researchRuntimeDeps() {
  const env = readEnv();
  const signature = VARIABLES.map((name) => env[name] ?? '').join('\n');
  if (cached?.signature !== signature) {
    const now = () => Date.now();
    const daily = (env.STARPI_RESEARCH_DAILY_PER_IP ?? '').trim() === '0' ? 0 : positiveInt(env.STARPI_RESEARCH_DAILY_PER_IP, RESEARCH_DEFAULTS.dailyPerIp);
    cached = {
      signature,
      deps: {
        keys: researchKeys(env),
        root: resolveRoot('gemini', GEMINI.root, env).root,
        model: researchModel(env),
        limiter: createRateLimiter({ limit: positiveInt(env.STARPI_RESEARCH_RPM_PER_IP, RESEARCH_DEFAULTS.rateLimitPerMinute), windowMs: 60_000, now }),
        daily: createDailyLimiter({ limit: daily, now }),
        extraOrigins: allowedOrigins(env),
        accessCode: readAccessCode(env),
        fetch: (input, init) => fetch(input, init),
        now,
      },
    };
  }
  return cached.deps;
}

/**
 * POST /api/research/step.
 * @param {Request} request
 * @param {ResearchDeps} deps
 * @returns {Promise<Response>}
 */
export async function handleResearchStep(request, deps) {
  const front = await guardRequest(request, deps);
  if (front) return refuse(front);
  if (!deps.keys.length) return refuse({ status: 503, error: 'research_not_configured' });
  const read = await readJsonBody(request, STEP_LIMITS.bodyBytes);
  if (!read.ok) return refuse(read);
  const checked = checkStepRequest(read.data);
  if (!checked.ok) return json(400, { error: 'invalid_request', detail: checked.problem.slice(0, 200) });
  const log = deps.log ?? ((/** @type {string} */ line) => console.warn(scrubLine(line)));
  try {
    // The daily budget counts only steps that reach Google: a forged history is refused first.
    const result = await runStep({ ...deps, timeoutMs: deps.timeoutMs, log }, checked.request, request.signal, () => {
      const daily = deps.daily.hit(clientIp(request));
      return daily.ok ? null : daily.retryAfterS;
    });
    return json(200, result);
  } catch (err) {
    if (err instanceof StepError) {
      if (err.code === 'daily_limit_reached') return refuse({ status: 429, error: err.code, retryAfterS: Number(err.detail) || 3600 });
      if (err.status >= 500 || err.status === 429) log(`research step: ${err.code} ${err.detail}`);
      return refuse({ status: err.status, error: err.code });
    }
    log(`research step: ${String(err)}`);
    return refuse({ status: 500, error: 'internal_error' });
  }
}

/** @param {Request} request */
export function POST(request) {
  return handleResearchStep(request, researchRuntimeDeps());
}

function notAllowed() {
  return methodNotAllowed('POST');
}

export { notAllowed as DELETE, notAllowed as GET, notAllowed as HEAD, notAllowed as OPTIONS, notAllowed as PATCH, notAllowed as PUT };
