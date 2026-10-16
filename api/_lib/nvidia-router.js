// @ts-check
// Key pool of the NVIDIA proxy: the generic pool router (api/_lib/pool/key-router.js) with the NVIDIA
// endpoint, Bearer auth and "nvidia" in its log lines. Round robin, failover until the first byte and
// parking (429 for its Retry-After, 401/403 for half an hour, timeouts and 408/5xx briefly) live there.
import { NVIDIA_PROXY, NVIDIA_UPSTREAM_URL } from '../../src/js/models/nvidia-catalog.js';
import { bearerAuth, createKeyRouter as createPoolKeyRouter } from './pool/key-router.js';

export { parseRetryAfter, RETRY_AFTER_MAX_S } from './pool/key-router.js';

/**
 * @typedef {import('./pool/key-router.js').KeyRouter} KeyRouter
 * @typedef {import('./pool/key-router.js').OpenOk} OpenOk
 * @typedef {import('./pool/key-router.js').OpenFail} OpenFail
 * @typedef {import('./pool/key-router.js').OpenOptions} OpenOptions
 * @typedef {import('../../src/js/models/nvidia-catalog.js').NvidiaProxyTiming} NvidiaProxyTiming
 */

/**
 * @param {{ keys: readonly string[], fetch: typeof fetch, now?: () => number, log?: (line: string) => void,
 *   url?: string, timing?: NvidiaProxyTiming }} options
 * @returns {KeyRouter}
 */
export function createKeyRouter({ keys, fetch, now, log, url = NVIDIA_UPSTREAM_URL, timing = NVIDIA_PROXY }) {
  return createPoolKeyRouter({ keys, fetch, now, log, timing, upstreamUrl: url, authHeader: bearerAuth, label: 'nvidia' });
}
