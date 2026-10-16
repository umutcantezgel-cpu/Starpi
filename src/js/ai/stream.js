// @ts-check
// The generic stream driver. It runs one model call through an adapter and a transport and yields
// normalized AiEvents: exactly one `start` first and one `end` last, also when the call fails
// (end.error is then an AiError and end.stopReason says how it ended).
//
// Two adapter kinds share the output:
// - 'wire' adapters are pure halves: buildRequest(req) builds the HTTP request, the transport sends
//   it, the body is read as server-sent events and parseEvent(sse, state) turns each event into
//   AiEvents. The adapter emits `end` at the provider's terminal event; a body that closes before
//   it counts as a cut stream.
// - 'sdk' adapters run a vendor SDK themselves: stream(req, { fetch, baseURL, signal }) yields
//   AiEvents, with the transport's fetch and base URL injected so keys and routing stay here.
//
// The call stops on the caller's signal (`cancelled`), on req.timeoutMs (`timeout`) and when the
// provider sends nothing for idleTimeoutMs (`timeout`), counted from the request until the answer
// starts and between two pieces of it. Leaving the loop early aborts the request.
import { isProviderId, validateRequest } from './contract.js';
import { AiError, fromHttp, MAX_ERROR_SNIPPET_CHARS, toAiError } from './errors.js';
import { readSse, readText, SseIdleError } from './sse.js';
import { stopReasonForError } from './stop-reason.js';

/** @typedef {import('./contract.js').AiRequest} AiRequest */
/** @typedef {import('./contract.js').AiEvent} AiEvent */
/** @typedef {import('./contract.js').StartEvent} StartEvent */
/** @typedef {import('./contract.js').EndEvent} EndEvent */
/** @typedef {import('./contract.js').Caps} Caps */
/** @typedef {import('./contract.js').ProviderId} ProviderId */
/** @typedef {import('./errors.js').AiErrorCode} AiErrorCode */
/** @typedef {import('./sse.js').SseEvent} SseEvent */
/** @typedef {import('./transport.js').Transport} Transport */
/** @typedef {import('./transport.js').BuiltRequest} BuiltRequest */
/** @typedef {import('./transport.js').FetchLike} FetchLike */

/** @typedef {{ id: string, label?: string, contextTokens?: number, maxOutput?: number }} ModelInfo */

/**
 * @typedef {object} AdapterBase
 * @property {ProviderId} id
 * @property {string} dialect                                   e.g. 'openai-chat', 'anthropic', 'gemini'
 * @property {(modelId: string, catalog?: unknown) => Caps} [capabilities]
 * @property {{ path: string, parse(json: unknown): ModelInfo[] }} [listModels]
 * @property {(key: string) => [string, string]} [authHeader]   the provider's auth header for a key
 */

/**
 * @typedef {AdapterBase & {
 *   kind: 'wire',
 *   buildRequest(req: AiRequest): BuiltRequest,
 *   parseEvent(sse: SseEvent, state: any): AiEvent[],
 *   parseResponse?(json: unknown, state: any): AiEvent[],
 *   finish?(state: any): AiEvent[],
 *   createState?(req: AiRequest): any,
 * }} WireAdapter
 * `createState` gives each call its own parser state; `finish` runs when the body has closed (and
 * may emit the end a provider signals only by closing); `parseResponse` reads a JSON answer from
 * servers that ignore the stream flag.
 */

/** @typedef {{ fetch: FetchLike | undefined, baseURL: string | undefined, signal: AbortSignal }} SdkContext */

/**
 * @typedef {AdapterBase & { kind: 'sdk', stream(req: AiRequest, context: SdkContext): AsyncIterable<AiEvent> }} SdkAdapter
 */

/** @typedef {WireAdapter | SdkAdapter} Adapter */

/**
 * @typedef {object} StreamOptions
 * @property {AbortSignal} [signal]        the caller's Stop
 * @property {number} [idleTimeoutMs]      longest silence before the answer starts and between two pieces of it (0: none)
 * @property {boolean} [validate]          check the request against the contract first (default true)
 */

/** Silence after which a call counts as stalled; the site relay uses the same idle limit. */
export const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
/** Largest JSON answer read from servers that answer a streamed request in one piece. */
export const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;

const IDLE = Symbol('idle');

/**
 * @param {Adapter} adapter
 * @param {AiRequest} req
 * @param {Transport | null | undefined} transport  may be null for SDK adapters that run in the browser
 * @param {StreamOptions} [options]
 * @returns {AsyncGenerator<AiEvent, void, undefined>}
 */
export async function* stream(adapter, req, transport, options = {}) {
  const { signal, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, validate = true } = options;
  /** @type {ProviderId} */
  const provider = isProviderId(req?.provider) ? req.provider : isProviderId(adapter?.id) ? adapter.id : 'local';
  const model = typeof req?.model === 'string' && req.model ? req.model : 'unknown';
  const controller = new AbortController();
  /** @type {AiErrorCode | null} */
  let cause = null;
  /** @param {AiErrorCode} code */
  const halt = (code) => {
    if (cause) return;
    cause = code;
    controller.abort(new AiError(code, { provider }));
  };
  const onAbort = () => halt('aborted');
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const deadline = typeof req?.timeoutMs === 'number' && req.timeoutMs > 0 ? setTimeout(() => halt('timeout'), req.timeoutMs) : null;
  const meta = { requestId: /** @type {string | null} */ (null), responded: false };

  /** @type {StartEvent | null} */
  let start = null;
  /** @type {EndEvent | null} */
  let end = null;
  /** @returns {StartEvent} */
  const fallbackStart = () => ({ type: 'start', provider, model, requestId: meta.requestId });

  try {
    if (cause) throw new AiError(cause, { provider });
    if (validate && validateRequest(req).length) throw new AiError('bad_request', { provider });
    const context = { signal: controller.signal, idleMs: Math.max(0, idleTimeoutMs), meta, halt, provider };
    const source = adapter?.kind === 'wire' ? wireEvents(adapter, req, transport, context) : adapter?.kind === 'sdk' ? sdkEvents(adapter, req, transport, context) : null;
    if (!source) throw new AiError('bad_request', { provider });
    for await (const ev of source) {
      if (!ev || typeof ev !== 'object') continue;
      if (ev.type === 'start') {
        if (!start) {
          start = { type: 'start', provider: isProviderId(ev.provider) ? ev.provider : provider, model: ev.model || model, requestId: ev.requestId ?? meta.requestId };
          yield start;
        }
        continue;
      }
      if (!start) {
        start = fallbackStart();
        yield start;
      }
      if (ev.type === 'end') {
        end = normalizeEnd(ev, provider);
        break;
      }
      yield ev;
    }
    if (!end) end = errorEnd(new AiError(cause ?? 'stream_cut', { provider }));
  } catch (err) {
    end = errorEnd(cause ? new AiError(cause, { provider, cause: err }) : classify(err, meta.responded, provider));
  } finally {
    if (deadline) clearTimeout(deadline);
    signal?.removeEventListener('abort', onAbort);
    // The caller left early, or the call failed: release the connection.
    if (!end || end.error) controller.abort();
  }
  if (!start) yield fallbackStart();
  yield end;
}

/**
 * @param {AiError} error
 * @returns {EndEvent}
 */
function errorEnd(error) {
  return { type: 'end', stopReason: stopReasonForError(error.code), error };
}

/**
 * An adapter's end, with an AiError attached when it reports an error without one.
 * @param {EndEvent} ev
 * @param {ProviderId} provider
 * @returns {EndEvent}
 */
function normalizeEnd(ev, provider) {
  if (ev.error !== undefined && !(ev.error instanceof AiError)) return errorEnd(new AiError('bad_response', { provider }));
  if (ev.stopReason === 'error' && !ev.error) return { type: 'end', stopReason: 'error', error: new AiError('bad_response', { provider }) };
  return ev.error ? { type: 'end', stopReason: ev.stopReason, error: ev.error } : { type: 'end', stopReason: ev.stopReason };
}

/**
 * @param {unknown} err
 * @param {boolean} responded
 * @param {ProviderId} provider
 */
function classify(err, responded, provider) {
  if (err instanceof SseIdleError) return new AiError('timeout', { provider, cause: err });
  if (err instanceof RangeError) return new AiError('bad_response', { provider, cause: err });
  return toAiError(err, { provider, responded, beforeResponse: 'network' });
}

/**
 * @typedef {object} RunContext
 * @property {AbortSignal} signal
 * @property {number} idleMs
 * @property {{ requestId: string | null, responded: boolean }} meta
 * @property {(code: AiErrorCode) => void} halt
 * @property {ProviderId} provider
 */

/**
 * Runs an adapter hook; a throw becomes `bad_response` (an answer the adapter could not read).
 * @param {() => AiEvent[] | undefined | null} fn
 * @param {ProviderId} provider
 * @returns {AiEvent[]}
 */
function parsed(fn, provider) {
  try {
    const out = fn();
    return Array.isArray(out) ? out : [];
  } catch (err) {
    throw err instanceof AiError ? err : new AiError('bad_response', { provider, cause: err });
  }
}

/**
 * @param {WireAdapter} adapter
 * @param {AiRequest} req
 * @param {Transport | null | undefined} transport
 * @param {RunContext} context
 * @returns {AsyncGenerator<AiEvent, void, undefined>}
 */
async function* wireEvents(adapter, req, transport, context) {
  const { provider, idleMs, meta } = context;
  if (typeof transport !== 'function') throw new AiError('bad_request', { provider });
  /** @type {BuiltRequest} */
  let built;
  try {
    built = adapter.buildRequest(req);
  } catch (err) {
    throw err instanceof AiError ? err : new AiError('bad_request', { provider, cause: err });
  }
  const pending = Promise.resolve(transport(adapter, built, { signal: context.signal }));
  const response = idleMs > 0 ? await within(pending, idleMs) : await pending;
  if (response === IDLE) {
    // The aborted fetch rejects later; that rejection is expected and dropped.
    pending.catch(() => {});
    context.halt('timeout');
    throw new AiError('timeout', { provider });
  }
  meta.responded = true;
  meta.requestId = response.headers.get('request-id') ?? response.headers.get('x-request-id') ?? null;
  if (!response.ok) {
    /** @type {string} */
    let snippet = '';
    try {
      snippet = await readText(response.body, { maxBytes: MAX_ERROR_SNIPPET_CHARS, idleMs, truncate: true });
    } catch {
      // the body only refines the classification
    }
    throw fromHttp(response.status, response.headers, snippet, { provider });
  }
  const type = (response.headers.get('content-type') ?? '').toLowerCase();
  const state = adapter.createState ? adapter.createState(req) : {};
  if (type.startsWith('text/event-stream')) {
    for await (const sse of readSse(response.body, { idleMs })) yield* parsed(() => adapter.parseEvent(sse, state), provider);
    const finish = adapter.finish;
    if (finish) yield* parsed(() => finish.call(adapter, state), provider);
    return;
  }
  const parseResponse = adapter.parseResponse;
  if (parseResponse && /[/+]json\b/.test(type)) {
    const text = await readText(response.body, { maxBytes: MAX_JSON_RESPONSE_BYTES, idleMs });
    /** @type {unknown} */
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new AiError('bad_response', { provider, cause: err });
    }
    yield* parsed(() => parseResponse.call(adapter, json, state), provider);
    // A whole answer is complete by definition; this end only applies when the adapter gave none.
    yield { type: 'end', stopReason: 'end_turn' };
    return;
  }
  await response.body?.cancel().catch(() => {});
  throw new AiError('bad_response', { provider, status: response.status });
}

/**
 * The value of a promise, or IDLE when it takes longer than `ms`.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T | typeof IDLE>}
 */
function within(promise, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {Promise<typeof IDLE>} */
  const idle = new Promise((resolve) => {
    timer = setTimeout(() => resolve(IDLE), ms);
  });
  return Promise.race([promise, idle]).finally(() => clearTimeout(timer));
}

/**
 * @param {SdkAdapter} adapter
 * @param {AiRequest} req
 * @param {Transport | null | undefined} transport
 * @param {RunContext} context
 * @returns {AsyncGenerator<AiEvent, void, undefined>}
 */
async function* sdkEvents(adapter, req, transport, context) {
  const { idleMs, meta, provider } = context;
  const iterable = adapter.stream(req, { fetch: transport?.fetch, baseURL: transport?.baseURL, signal: context.signal });
  const it = iterable[Symbol.asyncIterator]();
  let done = false;
  try {
    for (;;) {
      const result = idleMs > 0 ? await within(it.next(), idleMs) : await it.next();
      if (result === IDLE) {
        context.halt('timeout');
        throw new AiError('timeout', { provider });
      }
      if (result.done) {
        done = true;
        return;
      }
      meta.responded = true;
      yield result.value;
    }
  } finally {
    // Not awaited: a pending next() of a stalled SDK settles only once the abort reaches it.
    if (!done) it.return?.()?.catch(() => {});
  }
}
