// @ts-check
// /api/models/pool (Vercel Function): the models the site's provider pools offer.
// Until it is built, every method answers 501 with the JSON body { "error": "not_implemented" }.
import { json } from '../_lib/guards.js';

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
