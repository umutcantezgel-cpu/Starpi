// @ts-check
// GET /api/models/nvidia, shared by the Vercel Function (api/models/nvidia.js) and
// `node scripts/serve.mjs --functions`. POST /api/chat/nvidia is served by the pool handler
// (api/chat/nvidia.js). Dependencies are passed in, so tests need neither network nor environment;
// runtimeDeps() builds them from the environment.
import { publicCatalog } from '../../src/js/models/nvidia-catalog.js';
import { parseKeys, readEnv } from './env.js';
import { json } from './guards.js';
import { createKeyRouter } from './nvidia-router.js';

/**
 * @typedef {object} Deps
 * @property {import('./nvidia-router.js').KeyRouter | null} router null when NVIDIA_API_KEYS holds no valid key
 */

/** @type {{ signature: string, deps: Deps } | null} */
let cached = null;

/**
 * Dependencies from the environment, rebuilt only when NVIDIA_API_KEYS changes.
 * @returns {Deps}
 */
export function runtimeDeps() {
  const env = readEnv();
  const signature = env.NVIDIA_API_KEYS ?? '';
  if (cached?.signature !== signature) {
    const { keys, invalid } = parseKeys(env.NVIDIA_API_KEYS);
    if (invalid > 0) console.warn(`nvidia: ignored ${invalid} malformed entries in NVIDIA_API_KEYS`);
    cached = { signature, deps: { router: keys.length > 0 ? createKeyRouter({ keys, fetch, now: () => Date.now() }) : null } };
  }
  return cached.deps;
}

/**
 * GET /api/models/nvidia: the public allowlist and whether the server has keys (never keys or a count).
 * @param {Deps} deps
 */
export function handleModels({ router }) {
  return json(200, publicCatalog(router !== null));
}
