// @ts-check
// GET /api/models/nvidia (Vercel Function): the NVIDIA model allowlist and whether the server has keys.
// Every other method gets 405.
import { methodNotAllowed } from '../_lib/guards.js';
import { handleModels, runtimeDeps } from '../_lib/handlers.js';

export function GET() {
  return handleModels(runtimeDeps());
}

function notAllowed() {
  return methodNotAllowed('GET');
}

export { notAllowed as DELETE, notAllowed as OPTIONS, notAllowed as PATCH, notAllowed as POST, notAllowed as PUT };
