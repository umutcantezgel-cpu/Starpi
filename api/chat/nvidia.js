// @ts-check
// POST /api/chat/nvidia (Vercel Function): the NVIDIA pool under its earlier address. It runs the
// pool handler with the provider and the path fixed and with the earlier request rules (text only,
// a body of at most NVIDIA_LIMITS.maxBodyBytes), so clients of earlier versions keep working;
// without NVIDIA keys it answers 503 nvidia_not_configured, as before. Every other method gets 405.
import { NVIDIA_LIMITS } from '../../src/js/models/nvidia-catalog.js';
import { methodNotAllowed } from '../_lib/guards.js';
import { handlePool, poolRuntimeDeps } from '../_lib/pool/handler.js';

/** @type {Readonly<import('../_lib/pool/handler.js').PoolTarget>} The pool target of this route. */
export const NVIDIA_ALIAS = Object.freeze({ provider: 'nvidia', path: '/v1/chat/completions', notConfigured: 'nvidia_not_configured', maxBodyBytes: NVIDIA_LIMITS.maxBodyBytes, textOnly: true });

/** @param {Request} request */
export function POST(request) {
  return handlePool(request, poolRuntimeDeps(), NVIDIA_ALIAS);
}

function notAllowed() {
  return methodNotAllowed('POST');
}

export { notAllowed as DELETE, notAllowed as GET, notAllowed as OPTIONS, notAllowed as PATCH, notAllowed as PUT };
