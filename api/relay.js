// @ts-check
// /api/relay/:provider/:path* (Vercel Function): the stateless relay that forwards a request with
// the user's own key to an allowlisted provider path. vercel.json rewrites the route to this file;
// the function sees the original URL and reads the provider and the path from it.
// Until it is built, every method answers 501 with the JSON body { "error": "not_implemented" }.
import { json } from './_lib/guards.js';

const notImplemented = () => json(501, { error: 'not_implemented' });

export {
  notImplemented as DELETE,
  notImplemented as GET,
  notImplemented as HEAD,
  notImplemented as OPTIONS,
  notImplemented as PATCH,
  notImplemented as POST,
  notImplemented as PUT,
};
