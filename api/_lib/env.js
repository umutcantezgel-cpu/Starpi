// @ts-check
// Environment of the NVIDIA proxy (Vercel Functions, `npm run preview`, `npm run nvidia:ping`). The
// process environment is read only here, through globalThis, so the other modules use Web globals only.

/** An NVIDIA API key: `nvapi-` and 64 characters of the base64url alphabet. */
export const KEY_PATTERN = /^nvapi-[A-Za-z0-9_-]{64}$/;

/** @returns {Record<string, string | undefined>} */
export function readEnv() {
  const proc = /** @type {{ process?: { env?: Record<string, string | undefined> } }} */ (/** @type {unknown} */ (globalThis)).process;
  return proc?.env ?? {};
}

/**
 * Keys from NVIDIA_API_KEYS: split on commas and whitespace, deduplicated. Entries that do not match
 * KEY_PATTERN (cut off, wrong prefix, pasted with Markdown escapes such as `\_`) are dropped and only
 * counted, so a caller can report the number without ever printing a key.
 * @param {string | undefined} raw
 * @returns {{ keys: string[], invalid: number }}
 */
export function parseKeys(raw) {
  const entries = [...new Set((raw ?? '').split(/[\s,]+/).filter(Boolean))];
  const keys = entries.filter((entry) => KEY_PATTERN.test(entry));
  return { keys, invalid: entries.length - keys.length };
}

/**
 * Extra browser origins allowed to call the proxy (NVIDIA_ALLOWED_ORIGINS, comma separated), as
 * serialized origins. Entries that are not http(s) URLs are dropped.
 * @param {string | undefined} raw
 * @returns {string[]}
 */
export function parseOrigins(raw) {
  /** @type {string[]} */
  const origins = [];
  for (const entry of (raw ?? '').split(',')) {
    const url = URL.parse(entry.trim());
    if (url && (url.protocol === 'https:' || url.protocol === 'http:') && !origins.includes(url.origin)) origins.push(url.origin);
  }
  return origins;
}

/**
 * @param {string | undefined} raw
 * @param {number} fallback used when `raw` is not a positive decimal integer
 */
export function positiveInt(raw, fallback) {
  const value = /^\d+$/.test((raw ?? '').trim()) ? Number(raw) : 0;
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
