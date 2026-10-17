// @ts-check
// POST /api/pool?provider=<id>&path=<upstream path> (Vercel Function): streams an answer through
// the site's provider key pools (api/_lib/pool/handler.js); the browser sends no key. Every other
// method gets 405.
import { methodNotAllowed } from './_lib/guards.js';
import { handlePool, poolRuntimeDeps } from './_lib/pool/handler.js';

/** @param {Request} request */
export function POST(request) {
  return handlePool(request, poolRuntimeDeps());
}

function notAllowed() {
  return methodNotAllowed('POST');
}

export { notAllowed as DELETE, notAllowed as GET, notAllowed as HEAD, notAllowed as OPTIONS, notAllowed as PATCH, notAllowed as PUT };
