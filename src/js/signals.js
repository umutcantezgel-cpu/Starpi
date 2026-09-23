// @ts-check

/**
 * Returns a signal that aborts after `ms` or when `signal` aborts, whichever happens first.
 * Falls back gracefully on browsers without AbortSignal.any (Chrome < 116, Safari < 17.4).
 * @param {AbortSignal | null | undefined} signal
 * @param {number} ms
 * @returns {AbortSignal}
 */
export function withTimeoutSignal(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  const controller = new AbortController();
  const abort = (/** @type {AbortSignal} */ source) => controller.abort(source.reason);
  if (signal.aborted) abort(signal);
  signal.addEventListener('abort', () => abort(signal), { once: true });
  timeout.addEventListener('abort', () => abort(timeout), { once: true });
  return controller.signal;
}

/**
 * True when an error was caused by an abort initiated by the user (not by a timeout).
 * @param {unknown} err
 */
export function isUserAbort(err) {
  return err instanceof DOMException && err.name === 'AbortError';
}
