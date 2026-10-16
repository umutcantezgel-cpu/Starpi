// @ts-check
// The AI layer's front door. stream() (stream.js) is the primitive; complete() runs it and offers
// both views of one call: `events`, the normalized event stream for views that render as tokens
// arrive, and `result`, a promise of the assembled answer. Adapters register by provider id; the
// transport comes from the caller or from a resolver the key and transport settings install.
import { isProviderId, validateEvent } from './contract.js';
import { AiError } from './errors.js';
import { stream } from './stream.js';

export * from './contract.js';
export * from './errors.js';
export {
  ANTHROPIC_STOP_REASONS,
  fromAnthropic,
  fromGemini,
  fromLocal,
  fromOpenAiChat,
  fromOpenAiResponses,
  GEMINI_BLOCK_REASONS,
  GEMINI_FINISH_REASONS,
  LOCAL_STOP_REASONS,
  mapStopReason,
  OPENAI_CHAT_FINISH_REASONS,
  OPENAI_RESPONSES_INCOMPLETE_REASONS,
  OPENAI_RESPONSES_STATUS,
  STOP_NOTE_KEYS,
  stopReasonForError,
} from './stop-reason.js';
export { createSseParser, formatSse, readSse, MAX_SSE_BUFFER_CHARS } from './sse.js';
export { DEFAULT_IDLE_TIMEOUT_MS, stream } from './stream.js';
export { directTransport, nativeAuthHeader, poolTransport, relayTransport } from './transport.js';

/** @typedef {import('./contract.js').AiRequest} AiRequest */
/** @typedef {import('./contract.js').AiEvent} AiEvent */
/** @typedef {import('./contract.js').CitationEvent} CitationEvent */
/** @typedef {import('./contract.js').OpaquePart} OpaquePart */
/** @typedef {import('./contract.js').ProviderId} ProviderId */
/** @typedef {import('./contract.js').StopReason} StopReason */
/** @typedef {import('./stream.js').Adapter} Adapter */
/** @typedef {import('./transport.js').Transport} Transport */

/**
 * @typedef {(provider: ProviderId, adapter: Adapter) => Transport | null | undefined | Promise<Transport | null | undefined>} TransportResolver
 */

/**
 * @typedef {object} CompleteOptions
 * @property {AbortSignal} [signal]
 * @property {Transport | null} [transport]   overrides the resolver
 * @property {Adapter} [adapter]              overrides the registry
 * @property {number} [idleTimeoutMs]
 */

/**
 * @typedef {object} ToolCallResult
 * @property {string} id
 * @property {string} name
 * @property {Record<string, unknown> | null} args  null when the argument JSON could not be read
 * @property {string} argsText                      the argument JSON as it arrived
 */

/**
 * @typedef {object} CompletionUsage
 * @property {number} input
 * @property {number} output
 * @property {number} reasoning
 * @property {number} cacheRead
 * @property {number} [costUsd]
 */

/**
 * The assembled answer of one call. `error` is set when the call failed; text that arrived before
 * the failure is kept.
 * @typedef {object} CompletionResult
 * @property {string} text
 * @property {string} reasoning
 * @property {number} reasoningTokens
 * @property {ToolCallResult[]} toolCalls
 * @property {Array<Omit<CitationEvent, 'type'>>} citations
 * @property {Array<{ mime: string, data: string }>} images
 * @property {OpaquePart[]} opaque      provider state to store with the answer and replay unchanged
 * @property {StopReason} stopReason
 * @property {ProviderId} provider      the provider that served
 * @property {string} model             the model that served
 * @property {string | null} requestId
 * @property {CompletionUsage | null} usage
 * @property {AiError | null} error
 */

/** @type {Map<string, Adapter>} */
const adapters = new Map();
/** @type {TransportResolver | null} */
let transportResolver = null;

/**
 * @param {unknown} adapter
 * @returns {adapter is Adapter}
 */
function isAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') return false;
  const a = /** @type {Record<string, unknown>} */ (adapter);
  if (a.kind === 'wire') return typeof a.buildRequest === 'function' && typeof a.parseEvent === 'function';
  if (a.kind === 'sdk') return typeof a.stream === 'function';
  return false;
}

/**
 * Registers the adapter of a provider; a later registration replaces it.
 * @param {ProviderId} id
 * @param {Adapter} adapter
 * @returns {() => void} removes this registration again
 */
export function registerAdapter(id, adapter) {
  if (!isProviderId(id)) throw new TypeError(`Unknown provider id: ${String(id).slice(0, 40)}`);
  if (!isAdapter(adapter)) throw new TypeError('An adapter needs kind "wire" with buildRequest and parseEvent, or kind "sdk" with stream');
  adapters.set(id, adapter);
  return () => {
    if (adapters.get(id) === adapter) adapters.delete(id);
  };
}

/**
 * @param {string} id
 * @returns {Adapter | null}
 */
export function getAdapter(id) {
  return adapters.get(id) ?? null;
}

/** Provider ids with a registered adapter. */
export function listAdapters() {
  return [...adapters.keys()];
}

/**
 * Installs the function that picks a transport for a provider (keys, relay or pool); null removes it.
 * @param {TransportResolver | null} resolver
 */
export function setTransportResolver(resolver) {
  transportResolver = resolver;
}

/**
 * Folds events into a CompletionResult. Exposed so views that consume `events` themselves can
 * build the same result.
 * @param {{ provider?: ProviderId, model?: string }} [requested]
 */
export function createResultBuilder(requested = {}) {
  let text = '';
  let reasoning = '';
  let reasoningTokens = 0;
  /** @type {Map<string, { id: string, name: string, argsText: string, args: Record<string, unknown> | null | undefined }>} */
  const calls = new Map();
  /** @type {CompletionResult['citations']} */
  const citations = [];
  /** @type {CompletionResult['images']} */
  const images = [];
  /** @type {unknown[]} */
  const opaqueBlocks = [];
  /** @type {StopReason} */
  let stopReason = 'error';
  /** @type {ProviderId} */
  let provider = requested.provider ?? 'local';
  let model = requested.model ?? 'unknown';
  /** @type {string | null} */
  let requestId = null;
  /** @type {CompletionUsage | null} */
  let usage = null;
  /** @type {AiError | null} */
  let error = null;

  return {
    /** @param {AiEvent} ev */
    add(ev) {
      switch (ev.type) {
        case 'start':
          provider = ev.provider;
          model = ev.model;
          requestId = ev.requestId ?? null;
          break;
        case 'text':
          text += ev.delta;
          break;
        case 'reasoning':
          if (typeof ev.delta === 'string') reasoning += ev.delta;
          else if (typeof ev.tokens === 'number') reasoningTokens = Math.max(reasoningTokens, ev.tokens);
          break;
        case 'tool_call': {
          const call = calls.get(ev.id) ?? { id: ev.id, name: ev.name, argsText: '', args: undefined };
          calls.set(ev.id, call);
          if (ev.name) call.name = ev.name;
          if (typeof ev.argsDelta === 'string') call.argsText += ev.argsDelta;
          if (ev.args) {
            call.args = ev.args;
            if (!call.argsText) call.argsText = JSON.stringify(ev.args);
          }
          break;
        }
        case 'citation': {
          /** @type {CompletionResult['citations'][number]} */
          const citation = { url: ev.url, title: ev.title };
          if (ev.citedText !== undefined) citation.citedText = ev.citedText;
          if (ev.start !== undefined) citation.start = ev.start;
          if (ev.end !== undefined) citation.end = ev.end;
          citations.push(citation);
          break;
        }
        case 'image':
          images.push({ mime: ev.mime, data: ev.data });
          break;
        case 'opaque':
          opaqueBlocks.push(ev.block);
          break;
        case 'usage': {
          const next = usage ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0 };
          for (const key of /** @type {const} */ (['input', 'output', 'reasoning', 'cacheRead'])) {
            const value = ev[key];
            if (typeof value === 'number') next[key] = value;
          }
          if (typeof ev.costUsd === 'number') next.costUsd = ev.costUsd;
          usage = next;
          if (typeof ev.reasoning === 'number') reasoningTokens = Math.max(reasoningTokens, ev.reasoning);
          break;
        }
        case 'end':
          stopReason = ev.stopReason;
          error = ev.error ?? null;
          break;
      }
    },
    /** @returns {CompletionResult} */
    result() {
      return {
        text,
        reasoning,
        reasoningTokens,
        toolCalls: [...calls.values()].map((c) => ({ id: c.id, name: c.name, args: c.args === undefined ? parseArgs(c.argsText) : c.args, argsText: c.argsText })),
        citations: [...citations],
        images: [...images],
        opaque: opaqueBlocks.map((block) => ({ type: 'opaque', provider, model, block })),
        stopReason,
        provider,
        model,
        requestId,
        usage: usage ? { ...usage } : null,
        error,
      };
    },
  };
}

/**
 * @param {string} text
 * @returns {Record<string, unknown> | null}
 */
function parseArgs(text) {
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Consumes an event stream and returns the assembled result.
 * @param {AsyncIterable<AiEvent>} events
 * @param {{ provider?: ProviderId, model?: string }} [requested]
 * @returns {Promise<CompletionResult>}
 */
export async function collect(events, requested) {
  const builder = createResultBuilder(requested);
  for await (const ev of events) builder.add(ev);
  return builder.result();
}

/**
 * A single-consumer buffer between the running call and whoever reads `events`.
 * @param {() => void} onCancel
 */
function createChannel(onCancel) {
  /** @type {AiEvent[]} */
  const buffer = [];
  /** @type {((r: IteratorResult<AiEvent, undefined>) => void) | null} */
  let waiting = null;
  let closed = false;
  let taken = false;
  return {
    /** @param {AiEvent} ev */
    push(ev) {
      if (closed) return;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: ev, done: false });
      } else buffer.push(ev);
    },
    close() {
      closed = true;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: undefined, done: true });
      }
    },
    /** @type {AsyncIterable<AiEvent>} */
    iterable: {
      [Symbol.asyncIterator]() {
        if (taken) throw new TypeError('The events of a call can be read once');
        taken = true;
        return {
          next() {
            const ev = buffer.shift();
            if (ev) return Promise.resolve({ value: ev, done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => {
              waiting = resolve;
            });
          },
          return() {
            buffer.length = 0;
            if (!closed) onCancel();
            closed = true;
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    },
  };
}

/**
 * Runs one call. `events` yields every normalized event once (buffered, so reading late loses
 * nothing); leaving that loop early stops the call, as `abort()` does. `result` resolves when the
 * call ends and never rejects: a failure is in `result.error`.
 * @param {AiRequest} req
 * @param {CompleteOptions} [options]
 * @returns {{ events: AsyncIterable<AiEvent>, result: Promise<CompletionResult>, abort: () => void }}
 */
export function complete(req, options = {}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  const channel = createChannel(() => controller.abort());
  const requested = { provider: req?.provider, model: req?.model };

  const result = (async () => {
    const builder = createResultBuilder(requested);
    try {
      const adapter = options.adapter ?? getAdapter(req?.provider);
      const transport = adapter && options.transport !== undefined ? options.transport : adapter && transportResolver ? await transportResolver(req.provider, adapter) : null;
      const events = adapter ? stream(adapter, req, transport, { signal: controller.signal, idleTimeoutMs: options.idleTimeoutMs }) : failedEvents(req);
      for await (const ev of events) {
        builder.add(ev);
        channel.push(ev);
      }
    } catch (err) {
      // Only a resolver can throw here; the call itself always ends with an end event.
      const error = err instanceof AiError ? err : new AiError('bad_request', { provider: isProviderId(req?.provider) ? req.provider : null, cause: err });
      for await (const ev of failedEvents(req, error)) {
        builder.add(ev);
        channel.push(ev);
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      channel.close();
    }
    return builder.result();
  })();

  return { events: channel.iterable, result, abort: () => controller.abort() };
}

/**
 * The events of a call that cannot start (no adapter for the provider, or no transport).
 * @param {AiRequest} req
 * @param {AiError} [error]
 * @returns {AsyncGenerator<AiEvent, void, undefined>}
 */
async function* failedEvents(req, error) {
  const provider = isProviderId(req?.provider) ? req.provider : 'local';
  yield { type: 'start', provider, model: typeof req?.model === 'string' && req.model ? req.model : 'unknown', requestId: null };
  yield { type: 'end', stopReason: 'error', error: error ?? new AiError('bad_request', { provider }) };
}

/**
 * Checks an event sequence against the contract: every event valid, one start first, one end last.
 * For adapter tests.
 * @param {AiEvent[]} events
 * @returns {string[]} problems; empty when the sequence is valid
 */
export function validateEventSequence(events) {
  /** @type {string[]} */
  const problems = [];
  events.forEach((ev, i) => problems.push(...validateEvent(ev).map((p) => `#${i} ${p}`)));
  if (events[0]?.type !== 'start') problems.push('the first event must be start');
  if (events.at(-1)?.type !== 'end') problems.push('the last event must be end');
  if (events.filter((e) => e.type === 'start').length !== 1) problems.push('exactly one start expected');
  if (events.filter((e) => e.type === 'end').length !== 1) problems.push('exactly one end expected');
  return problems;
}
