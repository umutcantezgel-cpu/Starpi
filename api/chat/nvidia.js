// @ts-check
// POST /api/chat/nvidia (Vercel Function): streams an NVIDIA NIM chat completion through the server's
// key pool. Every other method gets 405.
import { methodNotAllowed } from '../_lib/guards.js';
import { handleChat, runtimeDeps } from '../_lib/handlers.js';

/** @param {Request} request */
export function POST(request) {
  return handleChat(request, runtimeDeps());
}

function notAllowed() {
  return methodNotAllowed('POST');
}

export { notAllowed as DELETE, notAllowed as GET, notAllowed as OPTIONS, notAllowed as PATCH, notAllowed as PUT };
