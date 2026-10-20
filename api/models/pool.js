// @ts-check
// GET /api/models/pool (Vercel Function): per pool whether the site serves it and the models it
// allows, never keys or a key count. Every other method gets 405.
import { methodNotAllowed } from '../_lib/guards.js';
import { handlePoolModels, poolRuntimeDeps } from '../_lib/pool/handler.js';

export function GET() {
  return handlePoolModels(poolRuntimeDeps());
}

function notAllowed() {
  return methodNotAllowed('GET');
}

export { notAllowed as DELETE, notAllowed as HEAD, notAllowed as OPTIONS, notAllowed as PATCH, notAllowed as POST, notAllowed as PUT };
