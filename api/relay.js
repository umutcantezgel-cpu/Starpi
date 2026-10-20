// @ts-check
// GET or POST /api/relay/:provider/:path* (Vercel Function): the stateless relay that forwards one
// request with the user's own key to an allowlisted provider path (api/_lib/relay/handler.js).
// vercel.json rewrites the route to this file; the function sees the original URL and reads the
// provider and the path from it. Every other method gets 405.
import { methodNotAllowed } from './_lib/guards.js';
import { relayRuntimeDeps, serveRelay } from './_lib/relay/handler.js';

/** @param {Request} request */
function relay(request) {
  return serveRelay(request, relayRuntimeDeps());
}

function notAllowed() {
  return methodNotAllowed('GET, POST');
}

export { notAllowed as DELETE, relay as GET, notAllowed as HEAD, notAllowed as OPTIONS, notAllowed as PATCH, relay as POST, notAllowed as PUT };
