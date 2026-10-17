// @ts-check
// Request guards of the NVIDIA routes: JSON error responses, the same-origin check, the JSON body
// reader with a byte cap and the per-IP rate limiter. Web-standard Request and Response only.

/**
 * A request the proxy refuses before any upstream call: becomes the flat JSON body `{ error, field? }`.
 * @typedef {{ status: number, error: string, field?: string, retryAfterS?: number }} Refusal
 */

const JSON_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

/**
 * @param {number} status
 * @param {unknown} payload
 * @param {Record<string, string>} [headers]
 */
export function json(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { ...JSON_HEADERS, ...headers } });
}

/** @param {Refusal} refusal */
export function refuse({ status, error, field, retryAfterS }) {
  return json(status, field ? { error, field } : { error }, retryAfterS ? { 'Retry-After': String(retryAfterS) } : {});
}

/** @param {string} allow the methods the route serves */
export function methodNotAllowed(allow) {
  return json(405, { error: 'method_not_allowed' }, { Allow: allow });
}

/**
 * Only pages of this site (and the origins in NVIDIA_ALLOWED_ORIGINS) may call the proxy. Browsers
 * always send Origin on POST and Sec-Fetch-Site on every request; scripts outside a browser can forge
 * both, which the rate limit and the model allowlist have to absorb.
 * @param {Request} request
 * @param {readonly string[]} extraOrigins serialized origins
 * @returns {Refusal | null}
 */
export function checkSameOrigin(request, extraOrigins) {
  const origin = request.headers.get('origin');
  const parsed = origin ? URL.parse(origin) : null;
  if (parsed && extraOrigins.includes(parsed.origin)) return null;
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return { status: 403, error: 'cross_site_request' };
  if (!origin) return { status: 403, error: 'origin_required' };
  // The Host header, not request.url: the platform may rebuild the URL with another scheme or host.
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? new URL(request.url).host;
  const sameHost = parsed !== null && (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.host === host.toLowerCase();
  return sameHost ? null : { status: 403, error: 'origin_not_allowed' };
}

/**
 * The client address the platform reports (x-real-ip on Vercel, set from the socket by serve.mjs).
 * @param {Request} request
 */
export function clientIp(request) {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return request.headers.get('x-real-ip')?.trim() || forwarded || 'unknown';
}

/**
 * Reads a JSON object body of at most `maxBytes` bytes, checking in this order:
 * a declared size above the cap (413) before the media type (415), then the streamed size (413),
 * UTF-8 and JSON (400 invalid_json) and the top-level type (400 json_body_must_be_object).
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<{ ok: true, data: Record<string, unknown> } | ({ ok: false } & Refusal)>}
 */
export async function readJsonBody(request, maxBytes) {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > maxBytes) return { ok: false, status: 413, error: 'payload_too_large' };
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json') return { ok: false, status: 415, error: 'unsupported_media_type' };

  const bytes = await readCapped(request.body, maxBytes);
  if (!bytes) return { ok: false, status: 413, error: 'payload_too_large' };
  let data;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, status: 400, error: 'json_body_must_be_object' };
  return { ok: true, data };
}

/**
 * @param {ReadableStream<Uint8Array> | null} body
 * @param {number} maxBytes
 * @returns {Promise<Uint8Array | null>} the bytes, or null once they exceed `maxBytes` (reading stops)
 */
async function readCapped(body, maxBytes) {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Fixed-window request counter per client IP. It lives in one function instance, so it is a best-effort
 * brake, not a global quota. At `maxEntries` addresses it forgets expired windows first, then the oldest.
 * @param {{ limit: number, windowMs: number, now: () => number, maxEntries?: number }} options
 */
export function createRateLimiter({ limit, windowMs, now, maxEntries = 5000 }) {
  /** @type {Map<string, { start: number, count: number }>} */
  const windows = new Map();

  /** @param {number} at */
  function prune(at) {
    for (const [ip, entry] of windows) if (at - entry.start >= windowMs) windows.delete(ip);
    for (const ip of windows.keys()) {
      if (windows.size < maxEntries) break;
      windows.delete(ip);
    }
  }

  return {
    /**
     * Counts one request.
     * @param {string} ip
     * @returns {{ ok: boolean, retryAfterS: number }}
     */
    hit(ip) {
      const at = now();
      let entry = windows.get(ip);
      if (!entry || at - entry.start >= windowMs) {
        // Re-inserting keeps the map in window-start order, so pruning drops the oldest windows.
        windows.delete(ip);
        if (windows.size >= maxEntries) prune(at);
        entry = { start: at, count: 0 };
        windows.set(ip, entry);
      }
      entry.count++;
      return { ok: entry.count <= limit, retryAfterS: Math.max(1, Math.ceil((entry.start + windowMs - at) / 1000)) };
    },
  };
}
