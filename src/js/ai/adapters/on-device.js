// @ts-check
// The shared part of the in-browser adapters (webllm.js, wasm.js). Both engines run whole chats
// locally and stream plain text, so the adapter is an SDK-kind adapter without a transport: it
// turns the conversation into text-only chat messages, streams the engine's deltas as AiEvents
// (reasoning written as <think> tags becomes reasoning events) and stops the engine on Stop.
//
// Two engine shapes are accepted:
// - a chat engine with `chat.completions.create({ stream: true })` and `interruptGenerate()`, as
//   WebLLM's engine and the processor runtime's WasmEngineClient offer them;
// - the engine controller of webgpu/engine.js (`generate()` with cumulative text, `interrupt()`),
//   which runs whichever runtime the user loaded. This is the default, loaded lazily.
import { messageText } from '../contract.js';
import { AiError } from '../errors.js';
import { capsFor } from '../catalog/models.js';
import { createThinkSplitter, fileAsText, usageEvent } from './common.js';

/** @typedef {import('../contract.js').AiRequest} AiRequest */
/** @typedef {import('../contract.js').AiEvent} AiEvent */
/** @typedef {import('../contract.js').ProviderId} ProviderId */
/** @typedef {import('../errors.js').AiErrorCode} AiErrorCode */
/** @typedef {import('../stream.js').SdkAdapter} SdkAdapter */
/** @typedef {import('../../webgpu/engine.js').LocalEngine} LocalEngine */
/** @typedef {{ role: 'system' | 'user' | 'assistant', content: string }} LocalMessage */

/**
 * The part of webgpu/engine.js the adapters use.
 * @typedef {object} EngineController
 * @property {(req: { messages: any[], maxTokens: number, temperature: number, onDelta: (text: string) => void }) => Promise<string>} generate
 * @property {() => void} interrupt
 * @property {() => { status: string, model: { ref?: string, runtime?: string } | null }} getEngineState
 */

/**
 * @typedef {object} OnDeviceOptions
 * @property {LocalEngine | (() => LocalEngine | null | Promise<LocalEngine | null>)} [engine]  a chat engine (or a getter)
 * @property {() => Promise<EngineController>} [loadController]  the engine controller (default: webgpu/engine.js)
 * @property {number} [temperature]  when the request names none (default 0.7)
 */

/** Engine error kinds (webgpu/engine.js) mapped onto AI error codes. */
const ENGINE_ERRORS = /** @type {Readonly<Record<string, AiErrorCode>>} */ ({
  'not-loaded': 'not_found',
  unsupported: 'not_found',
  'no-adapter': 'not_found',
  busy: 'rate_limited',
  cancelled: 'aborted',
  network: 'network',
  'code-download': 'network',
  quota: 'quota',
  'device-lost': 'server',
  'out-of-memory': 'server',
});

/**
 * @param {unknown} err
 * @param {ProviderId} provider
 */
function engineError(err, provider) {
  if (err instanceof AiError) return err;
  const kind = err && typeof err === 'object' ? /** @type {{ kind?: unknown }} */ (err).kind : undefined;
  const code = typeof kind === 'string' && Object.hasOwn(ENGINE_ERRORS, kind) ? ENGINE_ERRORS[kind] : 'server';
  return new AiError(code, { provider, providerCode: typeof kind === 'string' ? kind.replace(/-/g, '_') : null, cause: err });
}

/**
 * The conversation as text-only chat messages: images are left out, text files inlined, tool turns
 * dropped (local engines run without tools), system text first.
 * @param {AiRequest} req
 * @returns {LocalMessage[]}
 */
export function localMessages(req) {
  /** @type {LocalMessage[]} */
  const out = [];
  const system = [req.system ?? '', ...req.messages.filter((m) => m.role === 'system').map(messageText)].filter(Boolean).join('\n\n');
  if (system) out.push({ role: 'system', content: system });
  for (const m of req.messages) {
    if (m.role === 'user') {
      const text = m.content
        .map((p) => (p.type === 'text' ? p.text : p.type === 'file' && p.mime !== 'application/pdf' ? fileAsText(p.name, p.data) : ''))
        .filter(Boolean)
        .join('\n\n');
      if (text) out.push({ role: 'user', content: text });
    } else if (m.role === 'assistant') {
      const text = messageText(m);
      if (text) out.push({ role: 'assistant', content: text });
    }
  }
  return out;
}

/**
 * A queue between a callback-driven producer and an async generator.
 * @returns {{ push(text: string): void, close(error?: unknown): void, next(): Promise<{ text?: string, done: boolean, error?: unknown }> }}
 */
function textQueue() {
  /** @type {string[]} */
  const items = [];
  let done = false;
  /** @type {unknown} */
  let failure;
  /** @type {(() => void) | null} */
  let wake = null;
  return {
    push(text) {
      items.push(text);
      wake?.();
    },
    close(error) {
      done = true;
      failure = error;
      wake?.();
    },
    async next() {
      while (!items.length && !done) {
        await new Promise((resolve) => {
          wake = () => resolve(undefined);
        });
        wake = null;
      }
      if (items.length) return { text: items.shift(), done: false };
      return { done: true, error: failure };
    },
  };
}

/**
 * @param {ProviderId} provider
 * @param {'webllm' | 'wasm'} dialect
 * @param {OnDeviceOptions} options
 * @returns {SdkAdapter}
 */
export function createOnDeviceAdapter(provider, dialect, options = {}) {
  const loadController = options.loadController ?? (async () => /** @type {EngineController} */ (/** @type {unknown} */ (await import('../../webgpu/engine.js'))));
  return {
    kind: 'sdk',
    id: provider,
    dialect,
    capabilities: (modelId, catalog) => capsFor(provider, modelId, catalog),
    async *stream(req, context) {
      const caps = capsFor(provider, req.model);
      const maxTokens = Math.max(1, Math.min(req.maxOutputTokens ?? caps.maxOutput, caps.maxOutput));
      const temperature = req.temperature ?? options.temperature ?? 0.7;
      const messages = localMessages(req);
      const queue = textQueue();
      /** @type {{ input?: number, output?: number }} */
      const usage = {};
      /** @type {() => void} */
      let stop = () => {};

      const engine = typeof options.engine === 'function' ? await options.engine() : options.engine;
      if (engine) {
        stop = () => engine.interruptGenerate();
        (async () => {
          const chunks = await engine.chat.completions.create({ messages, max_tokens: maxTokens, temperature, stream: true, stream_options: { include_usage: true } });
          for await (const chunk of chunks) {
            const text = chunk.choices[0]?.delta?.content;
            if (text) queue.push(text);
            if (chunk.usage) {
              usage.input = chunk.usage.prompt_tokens;
              usage.output = chunk.usage.completion_tokens;
            }
            if (context.signal.aborted) break;
          }
        })().then(
          () => queue.close(),
          (err) => queue.close(err),
        );
      } else {
        const controller = await loadController();
        const state = controller.getEngineState();
        const loaded = state.model?.ref;
        if (state.status !== 'ready' || (req.model !== 'auto' && loaded && loaded !== req.model)) throw new AiError('not_found', { provider, providerCode: 'not_loaded' });
        stop = () => controller.interrupt();
        let seen = 0;
        controller
          .generate({
            messages,
            maxTokens,
            temperature,
            onDelta: (text) => {
              // The controller reports the answer so far; the events carry what is new.
              if (text.length > seen) queue.push(text.slice(seen));
              seen = text.length;
            },
          })
          .then(
            () => queue.close(),
            (err) => queue.close(err),
          );
      }

      const onAbort = () => stop();
      context.signal.addEventListener('abort', onAbort, { once: true });
      const think = createThinkSplitter();
      let finished = false;
      try {
        yield { type: 'start', provider, model: req.model };
        for (;;) {
          const item = await queue.next();
          if (item.done) {
            finished = true;
            if (context.signal.aborted) throw new AiError('aborted', { provider });
            if (item.error !== undefined) throw engineError(item.error, provider);
            break;
          }
          for (const piece of think.push(item.text ?? '')) yield { type: piece.type, delta: piece.delta };
        }
        for (const piece of think.flush()) yield { type: piece.type, delta: piece.delta };
        const ev = usageEvent(usage);
        if (ev) yield ev;
        yield { type: 'end', stopReason: 'end_turn' };
      } finally {
        context.signal.removeEventListener('abort', onAbort);
        // Leaving before the engine is done (an idle limit, the caller's loop) stops it as well.
        if (!finished && !context.signal.aborted) stop();
      }
    },
  };
}
