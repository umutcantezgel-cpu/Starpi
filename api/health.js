// @ts-check
// GET /api/health (Vercel Function): which server features this site offers, as booleans only:
// `{ version, pools, simulated, voice: { tts, stt, live }, research, access }`. `pools` names every
// pool and whether it has keys, `simulated` every provider whose API root points at a local fake
// (STARPI_<PROVIDER>_BASE_URL), `access` whether the site wants an access code. No key, key count
// or address ever appears. Every other method gets 405.
import packageJson from '../package.json' with { type: 'json' };
import { readAccessCode } from './_lib/access.js';
import { readEnv } from './_lib/env.js';
import { json, methodNotAllowed } from './_lib/guards.js';
import { poolRuntimeDeps, poolStatus } from './_lib/pool/handler.js';
import { findUpstream, RELAY_PROVIDERS, resolveRoot } from './_lib/relay/upstreams.js';
import * as research from './research/step.js';
import * as liveToken from './voice/live-token.js';
import * as speak from './voice/speak.js';
import * as transcribe from './voice/transcribe.js';

/**
 * @typedef {Record<string, string | undefined>} Env
 * @typedef {{ available?: (env: Env) => boolean }} FeatureRoute
 * @typedef {{ tts: FeatureRoute, stt: FeatureRoute, live: FeatureRoute, research: FeatureRoute }} FeatureRoutes
 */

/** The routes whose `available(env)` export decides a health flag. */
const FEATURES = /** @type {FeatureRoutes} */ ({ tts: speak, stt: transcribe, live: liveToken, research });

/**
 * @param {FeatureRoute} route
 * @param {Env} env
 */
const offered = (route, env) => (typeof route.available === 'function' ? route.available(env) === true : false);

/**
 * The health report.
 * @param {Env} env
 * @param {ReturnType<typeof poolStatus>} pools
 * @param {FeatureRoutes} [features]
 */
export function healthReport(env, pools, features = FEATURES) {
  /** @type {Record<string, boolean>} */
  const simulated = {};
  for (const id of RELAY_PROVIDERS) simulated[id] = resolveRoot(id, /** @type {{ root: string }} */ (findUpstream(id)).root, env).simulated;
  return {
    version: String(packageJson.version),
    pools: Object.fromEntries(Object.entries(pools).map(([id, status]) => [id, status.configured])),
    simulated,
    voice: { tts: offered(features.tts, env), stt: offered(features.stt, env), live: offered(features.live, env) },
    research: offered(features.research, env),
    access: readAccessCode(env) !== '',
  };
}

export function GET() {
  return json(200, healthReport(readEnv(), poolStatus(poolRuntimeDeps().pools)));
}

function notAllowed() {
  return methodNotAllowed('GET');
}

export { notAllowed as DELETE, notAllowed as HEAD, notAllowed as OPTIONS, notAllowed as PATCH, notAllowed as POST, notAllowed as PUT };
