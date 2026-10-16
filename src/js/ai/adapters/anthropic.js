// @ts-check
// Adapter for Anthropic's Messages API. Two kinds share one pure core:
// - `anthropicAdapter` (kind 'sdk') runs the official @anthropic-ai/sdk, loaded lazily as its own
//   chunk. The transport's fetch and base URL are injected, so the SDK's requests go direct, through
//   the relay or through any server transport, and the transport sets the key: the SDK only ever
//   holds a placeholder. `dangerouslyAllowBrowser` makes the SDK send the direct-browser-access
//   header the API wants from web pages.
// - `anthropicWireAdapter` (kind 'wire') sends the same body with the stream driver's own fetch,
//   for hosts that do not ship the SDK.
//
// Request rules for the current models:
// - thinking "off" is `output_config.effort: 'low'` (thinking cannot be switched off on all of
//   them, and a disabled or budgeted thinking config is refused); "on" is adaptive thinking with a
//   summarized display, so the reasoning can be shown; the effort comes from the toggle
// - no forced tool choice (refused); only 'auto' (the default) and 'none'
// - top-level automatic prompt caching (`cache_control`), so a stable prefix is read from cache
// - optional server-side fallbacks (`fallbacks: "default"` plus its beta header) only for the Opus
//   and Sonnet 5.5 models and only when the caller asks for them; the served model is reported
// - web search as the server tool, its citations as citation events
//
// History is replayed append-only: the whole content of every answer (thinking blocks with their
// signatures, server tool blocks, text with citations, tool calls) is kept as one opaque block and
// sent back unchanged, because an edited earlier turn invalidates the thinking of later ones. The
// client never trims an Anthropic conversation; server-side compaction is the opt-in alternative.
import { messageText, withoutForeignOpaque } from '../contract.js';
import { AiError } from '../errors.js';
import { fromAnthropic } from '../stop-reason.js';
import { capsFor } from '../catalog/models.js';
import { argsObject, base64Text, isRecord, streamError, usageEvent } from './common.js';

/** @typedef {import('../contract.js').AiRequest} AiRequest */
/** @typedef {import('../contract.js').AiEvent} AiEvent */
/** @typedef {import('../contract.js').Message} Message */
/** @typedef {import('../contract.js').Part} Part */
/** @typedef {import('../contract.js').Caps} Caps */
/** @typedef {import('../sse.js').SseEvent} SseEvent */
/** @typedef {import('../stream.js').SdkAdapter} SdkAdapter */
/** @typedef {import('../stream.js').WireAdapter} WireAdapter */
/** @typedef {import('../stream.js').SdkContext} SdkContext */
/** @typedef {import('../transport.js').BuiltRequest} BuiltRequest */

export const ANTHROPIC_VERSION = '2023-06-01';
/** Beta header of `fallbacks: "default"`. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Beta header of server-side compaction. */
export const COMPACTION_BETA = 'compact-2026-01-12';
export const WEB_SEARCH_TOOL = 'web_search_20260209';
export const WEB_SEARCH_TOOL_BASIC = 'web_search_20250305';
/** The `kind` of the opaque block that holds a whole answer's content. */
export const OPAQUE_CONTENT = 'anthropic-content';
/** Output budget when the request names none; capped by the model's limit. */
export const DEFAULT_MAX_TOKENS = 64_000;
/** Thinking budgets of older models that take one, per effort. */
const THINKING_BUDGETS = Object.freeze({ low: 2048, medium: 8192, high: 16_384, max: 32_768 });
/** Stands in for the key inside the SDK; every transport replaces the auth header. */
const PLACEHOLDER_KEY = 'transport-sets-the-key';
/** Longest a single SDK call may run; the stream driver's own deadline is usually shorter. */
const SDK_TIMEOUT_MS = 60 * 60_000;

/**
 * @typedef {object} AnthropicOptions
 * @property {boolean} [serverFallbacks]  send `fallbacks: "default"` to the Opus and Sonnet 5.5 models (default off)
 * @property {boolean} [compaction]       ask for server-side compaction near the context limit (default off)
 * @property {boolean} [promptCache]      top-level automatic prompt caching (default on)
 * @property {() => Promise<any>} [loadSdk] loads the SDK module (tests inject one)
 */

/**
 * @typedef {object} ModelTraits
 * @property {boolean} adaptive      adaptive thinking (a budget is refused)
 * @property {boolean} effort        output_config.effort is accepted
 * @property {boolean} maxEffort     the 'max' effort level exists
 * @property {boolean} sampling      temperature is accepted
 * @property {boolean} fallbacks     server-side `fallbacks: "default"` may be sent
 * @property {boolean} midSystem     system messages inside the conversation are accepted
 * @property {string} webSearchTool
 */

/**
 * What a model id accepts, from its family and version. Unknown ids get the rules of the current
 * models, which are the strictest.
 * @param {string} model
 * @returns {ModelTraits}
 */
export function anthropicModelTraits(model) {
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d)(?!\d))?/.exec(String(model));
  const family = m?.[1] ?? 'opus';
  const version = m ? Number(m[2]) + Number(m[3] ?? 0) / 10 : 9;
  const top = family === 'fable' || family === 'mythos';
  const adaptive = top || (family === 'haiku' ? version >= 5 : version >= 4.6);
  const midSystem = top || (family === 'opus' && version >= 4.8) || (family === 'sonnet' && version >= 5.5) || (family === 'haiku' && version >= 5.5);
  return {
    adaptive,
    effort: adaptive || (family === 'opus' && version >= 4.5),
    maxEffort: adaptive,
    sampling: !top && version <= 4.6,
    fallbacks: (family === 'opus' || family === 'sonnet') && version === 5.5,
    midSystem,
    webSearchTool: (family === 'opus' || family === 'sonnet' || top) && version >= 4.6 ? WEB_SEARCH_TOOL : WEB_SEARCH_TOOL_BASIC,
  };
}

/**
 * The thinking and effort fields of a request.
 * @param {AiRequest} req
 * @param {ModelTraits} traits
 * @param {number} maxTokens
 * @returns {{ thinking?: Record<string, unknown>, effort?: string }}
 */
function thinkingFields(req, traits, maxTokens) {
  const mode = req.thinking?.mode ?? 'auto';
  const requested = req.thinking?.effort;
  if (traits.adaptive) {
    if (mode === 'off') return { effort: 'low' };
    const show = req.thinking?.show ?? true;
    const effort = requested ?? (mode === 'on' ? 'high' : undefined);
    return { thinking: show ? { type: 'adaptive', display: 'summarized' } : { type: 'adaptive' }, effort };
  }
  /** @type {{ thinking?: Record<string, unknown>, effort?: string }} */
  const out = {};
  if (traits.effort && requested) out.effort = requested === 'max' ? 'high' : requested;
  if (mode === 'on' && maxTokens > 2048) {
    const budget = Math.min(THINKING_BUDGETS[requested ?? 'medium'], maxTokens - 1024);
    out.thinking = { type: 'enabled', budget_tokens: Math.max(1024, budget) };
  }
  return out;
}

/**
 * Content blocks of a user message: documents and images first, then the text, which is where the
 * API reads them best.
 * @param {Part[]} parts
 * @param {boolean} citations  documents carry citations (not allowed together with a JSON format)
 */
function userBlocks(parts, citations) {
  const media = [];
  const texts = [];
  for (const p of parts) {
    if (p.type === 'text') {
      if (p.text) texts.push({ type: 'text', text: p.text });
    } else if (p.type === 'image') {
      media.push({ type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } });
    } else if (p.type === 'file') {
      const source = p.mime === 'application/pdf' ? { type: 'base64', media_type: 'application/pdf', data: p.data } : { type: 'text', media_type: 'text/plain', data: base64Text(p.data) };
      media.push({ type: 'document', source, title: p.name, ...(citations ? { citations: { enabled: true } } : {}) });
    }
  }
  return [...media, ...texts];
}

/**
 * The content of an assistant message: the stored content of the answer when there is one,
 * otherwise blocks rebuilt from its parts.
 * @param {Part[]} parts
 * @returns {unknown[]}
 */
function assistantBlocks(parts) {
  for (const p of parts) {
    if (p.type === 'opaque' && isRecord(p.block) && p.block.kind === OPAQUE_CONTENT && Array.isArray(p.block.content)) return p.block.content;
  }
  const blocks = [];
  for (const p of parts) {
    // A single stored block (thinking with its signature) leads the rebuilt content.
    if (p.type === 'opaque' && isRecord(p.block) && typeof p.block.type === 'string') blocks.push(p.block);
  }
  for (const p of parts) {
    if (p.type === 'text' && p.text) blocks.push({ type: 'text', text: p.text });
    else if (p.type === 'tool_call') blocks.push({ type: 'tool_use', id: p.id, name: p.name, input: p.args });
  }
  return blocks;
}

/**
 * The system prompt and messages in Messages API form. Leading system messages, and later ones the
 * model cannot take in place, join the top-level system prompt; tool results become a user turn.
 * @param {AiRequest} req
 * @param {ModelTraits} traits
 * @param {boolean} citations
 */
export function anthropicMessages(req, traits, citations) {
  /** @type {string[]} */
  const system = req.system ? [req.system] : [];
  /** @type {Array<{ role: string, content: any }>} */
  const out = [];
  for (const m of withoutForeignOpaque(req.messages, 'anthropic')) {
    if (m.role === 'system') {
      const text = messageText(m);
      if (text) out.push({ role: 'system', content: text });
    } else if (m.role === 'user') {
      const content = userBlocks(m.content, citations);
      if (content.length) out.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      const content = assistantBlocks(m.content);
      if (content.length) out.push({ role: 'assistant', content });
    } else {
      const results = m.content.flatMap((p) => (p.type === 'tool_result' ? [{ type: 'tool_result', tool_use_id: p.id, content: p.content, ...(p.isError ? { is_error: true } : {}) }] : []));
      if (!results.length) continue;
      const last = out[out.length - 1];
      // Parallel results belong in one user turn.
      if (last?.role === 'user' && last.content.every((/** @type {any} */ b) => b.type === 'tool_result')) last.content.push(...results);
      else out.push({ role: 'user', content: results });
    }
  }
  // A system message inside the conversation must follow a user turn and come last or before an
  // assistant turn; anything else (and every one on models without them) joins the system prompt.
  const messages = out.filter((msg, i) => {
    if (msg.role !== 'system') return true;
    const ok = traits.midSystem && out[i - 1]?.role === 'user' && (i === out.length - 1 || out[i + 1].role === 'assistant');
    if (!ok) system.push(msg.content);
    return ok;
  });
  return { system: system.join('\n\n'), messages };
}

/**
 * The request body (the SDK and the wire form send the same one) and the beta headers it needs.
 * @param {AiRequest} req
 * @param {AnthropicOptions} [options]
 * @param {Caps} [caps]
 * @returns {{ body: Record<string, any>, betas: string[] }}
 */
export function buildAnthropicBody(req, options = {}, caps = capsFor('anthropic', req.model)) {
  const traits = anthropicModelTraits(req.model);
  const maxTokens = Math.max(1, Math.min(req.maxOutputTokens ?? DEFAULT_MAX_TOKENS, caps.maxOutput));
  const citations = !req.responseFormat;
  const { system, messages } = anthropicMessages(req, traits, citations);
  /** @type {Record<string, any>} */
  const body = { model: req.model, max_tokens: maxTokens };
  if (system) body.system = system;
  body.messages = messages;

  const tools = (req.tools ?? []).map((t) => ({ name: t.name, description: t.description, input_schema: t.schema, eager_input_streaming: true }));
  if (req.search?.enabled) {
    const s = req.search;
    tools.push(
      /** @type {any} */ ({
        type: traits.webSearchTool,
        name: 'web_search',
        ...(s.maxUses ? { max_uses: s.maxUses } : {}),
        ...(s.allowDomains?.length ? { allowed_domains: s.allowDomains } : {}),
        ...(s.blockDomains?.length ? { blocked_domains: s.blockDomains } : {}),
      }),
    );
  }
  if (tools.length) body.tools = tools;
  if (req.toolChoice === 'none' && tools.length) body.tool_choice = { type: 'none' };

  const { thinking, effort } = thinkingFields(req, traits, maxTokens);
  if (thinking) body.thinking = thinking;
  /** @type {Record<string, unknown>} */
  const outputConfig = {};
  if (effort && traits.effort) outputConfig.effort = effort === 'max' && !traits.maxEffort ? 'high' : effort;
  if (req.responseFormat) outputConfig.format = { type: 'json_schema', schema: req.responseFormat.schema };
  if (Object.keys(outputConfig).length) body.output_config = outputConfig;
  if (req.temperature !== undefined && traits.sampling && !thinking) body.temperature = req.temperature;

  /** @type {string[]} */
  const betas = [];
  if (options.promptCache !== false) body.cache_control = { type: 'ephemeral' };
  if (options.serverFallbacks && traits.fallbacks) {
    body.fallbacks = 'default';
    betas.push(FALLBACK_BETA);
  }
  if (options.compaction) {
    body.context_management = { edits: [{ type: 'compact_20260112' }] };
    betas.push(COMPACTION_BETA);
  }
  body.stream = true;
  return { body, betas };
}

/**
 * @typedef {object} BlockState
 * @property {Record<string, any>} block   the block as it will be replayed
 * @property {string} json                  streamed input JSON (tool and server tool blocks)
 * @property {number} textStart             offset of a text block in the answer
 * @property {any[]} citations              web citations waiting for the end of their text block
 */

/**
 * @typedef {object} AnthropicState
 * @property {string} model
 * @property {string | null} requestId
 * @property {Array<Record<string, any>>} blocks
 * @property {Map<number, BlockState>} open
 * @property {number} answerLength
 * @property {string | null} stopReason
 * @property {{ input: number, cacheRead: number, cacheWrite: number, output: number }} usage
 * @property {boolean} started
 * @property {boolean} ended
 */

/**
 * @param {AiRequest} req
 * @returns {AnthropicState}
 */
export function createAnthropicState(req) {
  return {
    model: req.model,
    requestId: null,
    blocks: [],
    open: new Map(),
    answerLength: 0,
    stopReason: null,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    started: false,
    ended: false,
  };
}

/**
 * @param {AnthropicState} state
 * @param {any} usage
 */
function readUsage(state, usage) {
  if (!isRecord(usage)) return;
  const n = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
  state.usage.input = n(usage.input_tokens) ?? state.usage.input;
  state.usage.cacheRead = n(usage.cache_read_input_tokens) ?? state.usage.cacheRead;
  state.usage.cacheWrite = n(usage.cache_creation_input_tokens) ?? state.usage.cacheWrite;
  state.usage.output = n(usage.output_tokens) ?? state.usage.output;
}

/**
 * The content to send back after a turn. When the answer switched to a fallback model midway, the
 * model-internal blocks of the declined part (thinking, tool calls, unanswered server tool calls,
 * unknown block types) are left out, as the API asks; text and everything after the switch stay.
 * @param {Array<Record<string, any>>} blocks
 */
export function replayContent(blocks) {
  const boundary = blocks.map((b) => b.type).lastIndexOf('fallback');
  if (boundary === -1) return blocks;
  const answered = new Set(blocks.filter((b) => typeof b.tool_use_id === 'string').map((b) => b.tool_use_id));
  const kept = new Set(['text', 'fallback', 'web_search_tool_result', 'web_fetch_tool_result']);
  return blocks.filter((b, i) => i >= boundary || kept.has(b.type) || (b.type === 'server_tool_use' && answered.has(b.id)));
}

/**
 * Events at the end of a message: the stored content, usage and the end.
 * @param {AnthropicState} state
 * @returns {AiEvent[]}
 */
function finishMessage(state) {
  if (state.ended) return [];
  state.ended = true;
  /** @type {AiEvent[]} */
  const out = [];
  const blocks = state.blocks.filter(Boolean);
  if (blocks.length) out.push({ type: 'opaque', block: { kind: OPAQUE_CONTENT, model: state.model, content: replayContent(blocks) } });
  const u = state.usage;
  const usage = usageEvent({ input: u.input + u.cacheRead + u.cacheWrite, output: u.output, cacheRead: u.cacheRead });
  if (usage) out.push(usage);
  out.push({ type: 'end', stopReason: fromAnthropic(state.stopReason) });
  return out;
}

/**
 * One streamed Messages API event (the parsed JSON of its data) as AiEvents. Pure apart from the
 * state it is given.
 * @param {any} data
 * @param {AnthropicState} state
 * @returns {AiEvent[]}
 */
export function parseAnthropicEvent(data, state) {
  if (!isRecord(data) || state.ended) return [];
  /** @type {AiEvent[]} */
  const out = [];
  switch (data.type) {
    case 'message_start': {
      const message = isRecord(data.message) ? data.message : {};
      if (typeof message.model === 'string' && message.model) state.model = message.model;
      readUsage(state, message.usage);
      if (!state.started) {
        state.started = true;
        out.push({ type: 'start', provider: 'anthropic', model: state.model, requestId: state.requestId ?? undefined });
      }
      break;
    }
    case 'content_block_start': {
      const index = Number(data.index);
      /** @type {Record<string, any>} */
      const block = isRecord(data.content_block) ? { ...data.content_block } : { type: 'unknown' };
      state.blocks[index] = block;
      const entry = { block, json: '', textStart: state.answerLength, citations: /** @type {any[]} */ ([]) };
      state.open.set(index, entry);
      if (block.type === 'text') {
        if (Array.isArray(block.citations)) block.citations = [...block.citations];
        if (typeof block.text === 'string' && block.text) {
          out.push({ type: 'text', delta: block.text });
          state.answerLength += block.text.length;
        }
      } else if (block.type === 'tool_use') {
        out.push({ type: 'tool_call', id: String(block.id), name: String(block.name), final: false });
      } else if (block.type === 'fallback' && isRecord(block.to) && typeof block.to.model === 'string') {
        // The answer continues on another model from here on.
        state.model = block.to.model;
      }
      break;
    }
    case 'content_block_delta': {
      const entry = state.open.get(Number(data.index));
      const delta = isRecord(data.delta) ? data.delta : {};
      if (!entry) break;
      const { block } = entry;
      switch (delta.type) {
        case 'text_delta':
          if (typeof delta.text === 'string' && delta.text) {
            block.text = (block.text ?? '') + delta.text;
            state.answerLength += delta.text.length;
            out.push({ type: 'text', delta: delta.text });
          }
          break;
        case 'thinking_delta':
          if (typeof delta.thinking === 'string' && delta.thinking) {
            block.thinking = (block.thinking ?? '') + delta.thinking;
            out.push({ type: 'reasoning', delta: delta.thinking });
          }
          break;
        case 'signature_delta':
          if (typeof delta.signature === 'string') block.signature = (block.signature ?? '') + delta.signature;
          break;
        case 'input_json_delta':
          if (typeof delta.partial_json === 'string' && delta.partial_json) {
            entry.json += delta.partial_json;
            if (block.type === 'tool_use') out.push({ type: 'tool_call', id: String(block.id), name: String(block.name), argsDelta: delta.partial_json, final: false });
          }
          break;
        case 'citations_delta':
          if (isRecord(delta.citation)) {
            block.citations = [...(Array.isArray(block.citations) ? block.citations : []), delta.citation];
            if (delta.citation.type === 'web_search_result_location') entry.citations.push(delta.citation);
          }
          break;
        default:
          break;
      }
      break;
    }
    case 'content_block_stop': {
      const index = Number(data.index);
      const entry = state.open.get(index);
      if (!entry) break;
      state.open.delete(index);
      const { block } = entry;
      if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        const input = entry.json ? argsObject(entry.json) : isRecord(block.input) ? block.input : {};
        block.input = input ?? {};
        if (block.type === 'tool_use') {
          out.push(input ? { type: 'tool_call', id: String(block.id), name: String(block.name), args: input, final: true } : { type: 'tool_call', id: String(block.id), name: String(block.name), final: true });
        }
      } else if (block.type === 'text') {
        // A web citation backs the whole text block it arrived with.
        for (const c of entry.citations) {
          if (typeof c.url !== 'string' || !/^https?:\/\//i.test(c.url)) continue;
          out.push({ type: 'citation', url: c.url, title: typeof c.title === 'string' ? c.title : '', ...(typeof c.cited_text === 'string' ? { citedText: c.cited_text } : {}), start: entry.textStart, end: state.answerLength });
        }
      }
      break;
    }
    case 'message_delta': {
      const delta = isRecord(data.delta) ? data.delta : {};
      if (typeof delta.stop_reason === 'string') state.stopReason = delta.stop_reason;
      readUsage(state, data.usage);
      break;
    }
    case 'message_stop':
      out.push(...finishMessage(state));
      break;
    case 'error': {
      state.ended = true;
      const err = isRecord(data.error) ? data.error : {};
      const error = streamError('anthropic', err.type);
      out.push({ type: 'end', stopReason: error.code === 'refusal' ? 'refusal' : 'error', error });
      break;
    }
    default:
      break;
  }
  return out;
}

/**
 * Headers of the wire form (the SDK sets the same ones itself).
 * @param {string[]} betas
 * @returns {Record<string, string>}
 */
function wireHeaders(betas) {
  return {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
    ...(betas.length ? { 'anthropic-beta': betas.join(',') } : {}),
  };
}

/**
 * @param {unknown} json
 * @returns {import('../stream.js').ModelInfo[]}
 */
function parseModels(json) {
  const data = isRecord(json) && Array.isArray(json.data) ? json.data : [];
  return data
    .filter((m) => isRecord(m) && typeof m.id === 'string')
    .map((m) => ({
      id: m.id,
      ...(typeof m.display_name === 'string' ? { label: m.display_name } : {}),
      ...(Number.isInteger(m.max_input_tokens) ? { contextTokens: m.max_input_tokens } : {}),
      ...(Number.isInteger(m.max_tokens) ? { maxOutput: m.max_tokens } : {}),
    }));
}

/** @param {string} key @returns {[string, string]} */
const authHeader = (key) => ['x-api-key', key];

/**
 * The SDK adapter. `options.serverFallbacks` is the caller's decision: the site's own BYOK chat
 * turns it on, hosts with a no-silent-switch rule leave it off.
 * @param {AnthropicOptions} [options]
 * @returns {SdkAdapter & { buildRequest(req: AiRequest): BuiltRequest, createState(req: AiRequest): AnthropicState, parseEvent(sse: SseEvent, state: AnthropicState): AiEvent[] }}
 */
export function createAnthropicAdapter(options = {}) {
  const wire = createAnthropicWireAdapter(options);
  const load = options.loadSdk ?? (() => import('@anthropic-ai/sdk'));
  return {
    kind: 'sdk',
    id: 'anthropic',
    dialect: 'anthropic',
    capabilities: (modelId, catalog) => capsFor('anthropic', modelId, catalog),
    listModels: wire.listModels,
    authHeader,
    buildRequest: wire.buildRequest,
    createState: wire.createState,
    parseEvent: wire.parseEvent,
    async *stream(req, context) {
      if (typeof context.fetch !== 'function' || !context.baseURL) throw new AiError('bad_request', { provider: 'anthropic' });
      const mod = await load();
      const Anthropic = mod.default ?? mod.Anthropic;
      const client = new Anthropic({
        apiKey: PLACEHOLDER_KEY,
        authToken: null,
        baseURL: context.baseURL,
        fetch: context.fetch,
        maxRetries: 0,
        timeout: SDK_TIMEOUT_MS,
        dangerouslyAllowBrowser: true,
        logLevel: 'off',
      });
      const { body, betas } = buildAnthropicBody(req, options);
      const headers = betas.length ? { 'anthropic-beta': betas.join(',') } : {};
      const state = createAnthropicState(req);
      const { data: events, request_id: requestId } = await client.messages.create(body, { signal: context.signal, headers }).withResponse();
      state.requestId = typeof requestId === 'string' ? requestId : null;
      try {
        for await (const event of events) {
          const out = parseAnthropicEvent(event, state);
          yield* out;
          if (state.ended) return;
        }
      } catch (err) {
        // An error event inside the stream: the SDK throws it without an HTTP status.
        const e = /** @type {{ status?: unknown, error?: unknown }} */ (err);
        if (context.signal.aborted || e?.status !== undefined || !isRecord(e?.error) || e.error.type !== 'error') throw err;
        yield* parseAnthropicEvent(e.error, state);
      }
    },
  };
}

/**
 * The wire adapter: same body, sent by the stream driver through any transport.
 * @param {AnthropicOptions} [options]
 * @returns {WireAdapter & { createState(req: AiRequest): AnthropicState }}
 */
export function createAnthropicWireAdapter(options = {}) {
  return {
    kind: 'wire',
    id: 'anthropic',
    dialect: 'anthropic',
    capabilities: (modelId, catalog) => capsFor('anthropic', modelId, catalog),
    listModels: { path: '/v1/models?limit=100', parse: parseModels },
    authHeader,
    buildRequest(req) {
      const { body, betas } = buildAnthropicBody(req, options);
      return { path: '/v1/messages', method: 'POST', headers: wireHeaders(betas), body };
    },
    createState: createAnthropicState,
    parseEvent(sse, state) {
      if (sse.event === 'ping') return [];
      let data;
      try {
        data = JSON.parse(sse.data);
      } catch (err) {
        throw new AiError('bad_response', { provider: 'anthropic', cause: err });
      }
      return parseAnthropicEvent(data, state);
    },
  };
}

/** The adapter with the defaults: no server-side fallbacks, prompt caching on. */
export const anthropicAdapter = createAnthropicAdapter();
/** The wire form with the defaults. */
export const anthropicWireAdapter = createAnthropicWireAdapter();
