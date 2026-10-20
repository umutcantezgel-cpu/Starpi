#!/usr/bin/env node
// Fake OpenAI-compatible provider on 127.0.0.1 for unit, adapter and e2e tests. It serves
// Chat Completions (streamed and whole), the Responses API (streamed and whole), GET /models,
// image generation, speech and transcription stubs. FAKE_FLAVOR (or --flavor, or a path prefix
// /flavor/<name>/...) switches the model list and the quirks of one compatible provider:
//
//   openai      no reasoning text in Chat Completions (only a token count); system_fingerprint
//   xai         reasoning in delta.reasoning_content
//   groq        reasoning in delta.reasoning; usage in x_groq on the last chunk
//   mistral     reasoning as content chunks of type "thinking"; tool calls arrive whole; model_length
//   deepseek    reasoning_content; ": keep-alive" comments before the first chunk
//   openrouter  reasoning plus reasoning_details; ": OPENROUTER PROCESSING" comments; web plugin annotations
//   nvidia      reasoning_content; the model list of Starpi's NVIDIA catalog
//   minimax     always thinks: reasoning_content on every answer; reasoning_effort none, an effort
//               it does not know, or a thinking switch set to disabled answer 400
//   ollama      no key needed; reasoning as <think> tags in the content; /api/tags and /api/show
//
// Scenarios (see shared.mjs for how to pick one): text (default), reasoning, tool, search,
// refusal, length, image, stream-error. A request whose last message is a tool result is answered
// with text, so tool loops end. Faults: see shared.mjs.
//
// Usage: node scripts/fakes/openai.mjs [--port 4611] [--flavor groq] [--marker starpi-purpose] [--fixtures dir]
// API root for clients: http://127.0.0.1:<port> (paths /v1/..., also /openai/v1/... and /api/v1/...);
// a flavor other than the default: http://127.0.0.1:<port>/flavor/<name>.
import { NVIDIA_MODELS } from '../../src/js/models/nvidia-catalog.js';
import {
  chunkText,
  createAnswerBook,
  createFakeServer,
  isMain,
  mp3Silence,
  pcmSilence,
  REASONING_TEXT,
  refusalText,
  runStandalone,
  SEARCH_SOURCES,
  searchSentences,
  TINY_PNG_BASE64,
  wavSilence,
} from './shared.mjs';

export const DEFAULT_PORT = 4611;

/**
 * @typedef {'reasoning_content' | 'reasoning' | 'thinking_chunks' | 'think_tags' | 'count_only'} ReasoningShape
 * @typedef {{ models: string[], reasoning: ReasoningShape, keyOptional?: boolean, comment?: string, wholeToolCalls?: boolean, lengthReason?: string, usageField?: 'x_groq', alwaysUsage?: boolean, alwaysThinks?: boolean }} Flavor
 */

/** @type {Readonly<Record<string, Flavor>>} */
export const FLAVORS = Object.freeze({
  openai: { models: ['fake-gpt-small', 'fake-gpt-large', 'fake-gpt-reasoner', 'fake-image-1', 'fake-tts-1', 'fake-transcribe-1'], reasoning: 'count_only' },
  xai: { models: ['fake-grok-fast', 'fake-grok-reasoner'], reasoning: 'reasoning_content', alwaysUsage: true },
  groq: { models: ['fake-groq-small', 'fake-groq-reasoner'], reasoning: 'reasoning', usageField: 'x_groq' },
  mistral: { models: ['fake-mistral-small', 'fake-mistral-reasoner'], reasoning: 'thinking_chunks', wholeToolCalls: true, lengthReason: 'model_length', alwaysUsage: true },
  deepseek: { models: ['fake-deepseek-chat', 'fake-deepseek-reasoner'], reasoning: 'reasoning_content', comment: ': keep-alive', alwaysUsage: true },
  openrouter: { models: ['fake/router-small', 'fake/router-reasoner:free'], reasoning: 'reasoning', comment: ': OPENROUTER PROCESSING', alwaysUsage: true },
  nvidia: { models: NVIDIA_MODELS.map((m) => m.id), reasoning: 'reasoning_content', alwaysUsage: true },
  minimax: { models: ['MiniMax-M3.1-Flash', 'MiniMax-M3'], reasoning: 'reasoning_content', alwaysUsage: true, alwaysThinks: true },
  ollama: { models: ['fake-local:8b', 'fake-local-reasoner:4b'], reasoning: 'think_tags', keyOptional: true, wholeToolCalls: true },
});

/** The effort levels of a flavor that always thinks; anything else is refused. */
const THINKING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Whether a request asks a model that always thinks not to think (or for an effort it does not know).
 * @param {any} body
 */
function refusesThinking(body) {
  const effort = body?.reasoning_effort;
  const thinking = body?.thinking;
  if (effort !== undefined && !THINKING_EFFORTS.includes(effort)) return true;
  return thinking === 'disabled' || thinking === false || (thinking && typeof thinking === 'object' && thinking.type === 'disabled');
}

/** @param {unknown} content */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p && typeof p === 'object' ? (typeof p.text === 'string' ? p.text : '') : typeof p === 'string' ? p : ''))
    .join('');
}

/**
 * What a Chat Completions or Responses request asks for, in one shape.
 * @param {any} body
 * @param {'chat' | 'responses'} api
 */
function readRequest(body, api) {
  const b = body && typeof body === 'object' ? body : {};
  /** @type {any[]} */
  const items = api === 'chat' ? (Array.isArray(b.messages) ? b.messages : []) : Array.isArray(b.input) ? b.input : typeof b.input === 'string' ? [{ role: 'user', content: b.input }] : [];
  const system = [api === 'responses' && typeof b.instructions === 'string' ? b.instructions : '', ...items.filter((m) => m?.role === 'system' || m?.role === 'developer').map((m) => textOf(m.content))].join('\n');
  const users = items.filter((m) => m?.role === 'user');
  const user = users.length ? textOf(users[users.length - 1].content) : '';
  const last = items[items.length - 1];
  const afterTool = api === 'chat' ? last?.role === 'tool' : last?.type === 'function_call_output';
  /** @type {any[]} */
  const tools = Array.isArray(b.tools) ? b.tools : [];
  const functions = tools
    .map((t) => (api === 'chat' ? (t?.type === 'function' ? t.function : null) : t?.type === 'function' ? t : null))
    .filter((f) => f && typeof f.name === 'string');
  const searchTool = tools.some((t) => typeof t?.type === 'string' && t.type.startsWith('web_search'));
  const plugins = Array.isArray(b.plugins) ? b.plugins : [];
  const search = searchTool || plugins.some((p) => p?.id === 'web') || (typeof b.model === 'string' && b.model.endsWith(':online')) || Boolean(b.web_search_options);
  const format = api === 'chat' ? b.response_format : b.text?.format;
  const schema = format?.type === 'json_schema' ? (api === 'chat' ? format.json_schema?.schema : format.schema) ?? {} : format?.type === 'json_object' ? { type: 'object' } : null;
  const effort = api === 'chat' ? (b.reasoning_effort ?? b.reasoning?.effort) : b.reasoning?.effort;
  const reasoning = (typeof effort === 'string' && effort !== 'none') || b.reasoning?.enabled === true || b.think === true;
  return {
    model: typeof b.model === 'string' && b.model ? b.model : 'fake-model',
    stream: b.stream === true,
    includeUsage: b.stream_options?.include_usage === true,
    system,
    user,
    afterTool,
    functions,
    search,
    schema,
    reasoning,
    summary: api === 'responses' && typeof b.reasoning?.summary === 'string',
    encrypted: api === 'responses' && Array.isArray(b.include) && b.include.includes('reasoning.encrypted_content'),
  };
}

/** @param {string} text */
const tokens = (text) => Math.max(1, Math.ceil(text.length / 4));

/**
 * @param {string | null} scenario
 * @param {ReturnType<typeof readRequest>} r
 */
function decide(scenario, r) {
  let s = scenario ?? (r.search ? 'search' : 'text');
  if (s === 'tool' && (r.afterTool || r.functions.length === 0)) s = 'text';
  if (r.afterTool && s !== 'stream-error') s = 'text';
  return { scenario: s, reasoning: s === 'reasoning' || r.reasoning };
}

/**
 * The answer text of a text-like scenario.
 * @param {string} scenario
 * @param {ReturnType<typeof readRequest>} r
 * @param {ReturnType<typeof createAnswerBook>} book
 */
function answerText(scenario, r, book) {
  if (scenario === 'refusal') return refusalText(r.user);
  if (scenario === 'search') return searchSentences(r.user).map((s) => s.text).join('');
  const { text } = book.answer({ system: r.system, user: r.user, schema: r.schema });
  return scenario === 'length' ? text.slice(0, Math.max(1, Math.floor(text.length / 2))) : text;
}

/** @param {string} user */
function citations(user) {
  let at = 0;
  return searchSentences(user).map((s) => {
    const start = at;
    at += s.text.length;
    const src = SEARCH_SOURCES[s.source];
    return { url: src.url, title: src.title, start: start + (s.text.startsWith(' ') ? 1 : 0), end: at };
  });
}

/**
 * @param {ReturnType<typeof readRequest>} r
 */
function toolArgs(r) {
  return JSON.stringify({ query: r.user.replace(/\[\[[^\]]*\]\]/g, '').trim().slice(0, 60) || 'example' });
}

/**
 * Creates the fake (not yet listening).
 * @param {{ flavor?: string, marker?: string, fixtures?: any, fixturesDir?: string, gapMs?: number, latencyMs?: number, cors?: boolean, log?: (line: string) => void }} [options]
 */
export function createOpenAiFake(options = {}) {
  const defaultFlavor = options.flavor ?? 'openai';
  if (!Object.hasOwn(FLAVORS, defaultFlavor)) throw new Error(`unknown flavor ${defaultFlavor}`);
  const book = createAnswerBook(options);
  let counter = 0;

  /** @param {string} path */
  const route = (path) => {
    const m = /^\/flavor\/([a-z]+)(\/.*)?$/.exec(path);
    const flavorName = m && Object.hasOwn(FLAVORS, m[1]) ? m[1] : defaultFlavor;
    const rest = m ? (m[2] ?? '/') : path;
    const api = /^(?:\/v1|\/openai\/v1|\/api\/v1)?(\/(?:models|chat\/completions|responses|images\/generations|audio\/speech|audio\/transcriptions))$/.exec(rest)?.[1] ?? rest;
    return { flavorName, flavor: FLAVORS[flavorName], api };
  };

  const fake = createFakeServer(
    {
      name: 'openai',
      texts: ({ json }) => {
        const msgs = Array.isArray(json?.messages) ? json.messages : Array.isArray(json?.input) ? json.input : typeof json?.input === 'string' ? [{ role: 'user', content: json.input }] : [];
        const users = msgs.filter((/** @type {any} */ m) => m?.role === 'user');
        return users.length ? [textOf(users[users.length - 1].content)] : [];
      },
      auth: ({ req, url, path }) => {
        if (['key', 'api_key'].some((k) => url.searchParams.has(k))) return 'in_query';
        const { flavor } = route(path);
        const header = req.headers.authorization;
        if (flavor.keyOptional) return 'ok';
        return typeof header === 'string' && /^Bearer \S+$/.test(header) ? 'ok' : 'missing';
      },
      errorBody: (status, kind) => ({
        error: {
          message: `Simulated ${kind} error.`,
          type: status === 429 ? 'rate_limit_exceeded' : status === 401 ? 'invalid_request_error' : status >= 500 ? 'server_error' : 'invalid_request_error',
          code: status === 429 ? 'rate_limit_exceeded' : status === 401 ? 'invalid_api_key' : status === 404 ? 'model_not_found' : kind === 'key_in_query' ? 'key_in_query' : null,
          param: null,
        },
      }),
      async handle(ctx) {
        const { flavorName, flavor, api } = route(ctx.path);
        const method = ctx.req.method;
        if (method === 'GET' && api === '/models') {
          return ctx.send(200, { object: 'list', data: flavor.models.map((id) => ({ id, object: 'model', created: 1767225600, owned_by: flavorName === 'nvidia' ? id.split('/')[0] : `fake-${flavorName}` })) });
        }
        if (flavorName === 'ollama' && method === 'GET' && api === '/api/tags') {
          return ctx.send(200, { models: flavor.models.map((name) => ({ name, model: name, size: 4_000_000_000, details: { family: 'fake', parameter_size: name.split(':')[1] ?? '' } })) });
        }
        if (flavorName === 'ollama' && method === 'POST' && api === '/api/show') {
          return ctx.send(200, { parameters: 'num_ctx 8192', model_info: { 'general.architecture': 'fake', 'fake.context_length': 32768 }, capabilities: ['completion', 'tools'] });
        }
        if (method !== 'POST') return false;
        counter += 1;
        if (api === '/chat/completions') return chat(ctx, flavorName, flavor, counter);
        if (api === '/responses') return responses(ctx, counter);
        if (api === '/images/generations') return ctx.send(200, { created: 1767225600, data: [{ b64_json: TINY_PNG_BASE64, revised_prompt: 'A simple test image.' }] });
        if (api === '/audio/speech') return speech(ctx);
        if (api === '/audio/transcriptions') return transcription(ctx);
        return false;
      },
    },
    options,
  );

  /**
   * @param {import('./shared.mjs').FakeContext} ctx
   * @param {string} flavorName
   * @param {Flavor} flavor
   * @param {number} n
   */
  async function chat(ctx, flavorName, flavor, n) {
    if (!ctx.json || !Array.isArray(ctx.json.messages) || ctx.json.messages.length === 0) return ctx.fail(400, 'bad_request');
    if (flavor.alwaysThinks && refusesThinking(ctx.json)) return ctx.fail(400, 'bad_request');
    const r = readRequest(ctx.json, 'chat');
    const decided = decide(ctx.control.scenario, r);
    const scenario = decided.scenario;
    const reasoning = decided.reasoning || flavor.alwaysThinks === true;
    const id = `chatcmpl-${n}fake`;
    const created = 1767225600 + n;
    const text = scenario === 'tool' ? '' : answerText(scenario, r, book);
    const fn = r.functions[0];
    const callId = flavorName === 'mistral' ? `fk${String(n).padStart(7, '0')}` : `call_${n}fake`;
    const finish = scenario === 'tool' ? 'tool_calls' : scenario === 'length' ? (flavor.lengthReason ?? 'length') : scenario === 'refusal' ? 'content_filter' : 'stop';
    const reasoningTokens = reasoning ? tokens(REASONING_TEXT) : 0;
    const usage = { prompt_tokens: tokens(r.system + r.user), completion_tokens: tokens(text) + reasoningTokens, total_tokens: tokens(r.system + r.user) + tokens(text) + reasoningTokens, completion_tokens_details: { reasoning_tokens: reasoningTokens } };
    const annotations = scenario === 'search' && (flavorName === 'openrouter' || flavorName === 'openai')
      ? citations(r.user).map((c) => ({ type: 'url_citation', url_citation: { url: c.url, title: c.title, start_index: c.start, end_index: c.end } }))
      : null;

    if (!r.stream) {
      /** @type {Record<string, unknown>} */
      const message = { role: 'assistant', content: scenario === 'tool' ? null : flavor.reasoning === 'think_tags' && reasoning ? `<think>${REASONING_TEXT}</think>\n\n${text}` : text, refusal: null };
      if (reasoning && flavor.reasoning === 'reasoning_content') message.reasoning_content = REASONING_TEXT;
      if (reasoning && flavor.reasoning === 'reasoning') message.reasoning = REASONING_TEXT;
      if (reasoning && flavor.reasoning === 'thinking_chunks') message.content = [{ type: 'thinking', thinking: [{ type: 'text', text: REASONING_TEXT }] }, { type: 'text', text }];
      if (scenario === 'tool' && fn) message.tool_calls = [{ id: callId, type: 'function', function: { name: fn.name, arguments: toolArgs(r) } }];
      if (annotations) message.annotations = annotations;
      return ctx.send(200, { id, object: 'chat.completion', created, model: r.model, choices: [{ index: 0, message, finish_reason: finish, logprobs: null }], usage });
    }

    const base = { id, object: 'chat.completion.chunk', created, model: r.model, ...(flavorName === 'openai' ? { system_fingerprint: 'fp_fake' } : {}) };
    /** @param {Record<string, unknown>} delta @param {string | null} [finishReason] @param {Record<string, unknown>} [extra] */
    const chunk = (delta, finishReason = null, extra = {}) => ({ data: { ...base, choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }], ...extra } });
    /** @type {import('./shared.mjs').SseItem[]} */
    const items = [];
    if (flavor.comment) items.push({ raw: `${flavor.comment}\n\n` }, { raw: `${flavor.comment}\n\n` });
    items.push(chunk({ role: 'assistant', content: '' }));
    if (reasoning) {
      const pieces = chunkText(REASONING_TEXT);
      if (flavor.reasoning === 'reasoning_content') for (const p of pieces) items.push(chunk({ reasoning_content: p }));
      if (flavor.reasoning === 'reasoning') {
        for (const p of pieces) items.push(chunk(flavorName === 'openrouter' ? { reasoning: p, reasoning_details: [{ type: 'reasoning.text', text: p, format: 'unknown', index: 0 }] } : { reasoning: p }));
      }
      if (flavor.reasoning === 'thinking_chunks') for (const p of pieces) items.push(chunk({ content: [{ type: 'thinking', thinking: [{ type: 'text', text: p }] }] }));
      if (flavor.reasoning === 'think_tags') {
        items.push(chunk({ content: '<think>' }));
        for (const p of pieces) items.push(chunk({ content: p }));
        items.push(chunk({ content: '</think>\n\n' }));
      }
    }
    if (scenario === 'stream-error') {
      items.push(chunk({ content: text.slice(0, 20) }));
      items.push({ data: { error: { message: 'Simulated error in the middle of the stream.', type: 'server_error', code: 'overloaded' } } });
      return ctx.sse(items);
    }
    if (scenario === 'tool' && fn) {
      const args = toolArgs(r);
      if (flavor.wholeToolCalls) items.push(chunk({ tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: fn.name, arguments: args } }] }));
      else {
        items.push(chunk({ tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: fn.name, arguments: '' } }] }));
        for (let i = 0; i < args.length; i += 7) items.push(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 7) } }] }));
      }
    } else {
      for (const p of chunkText(text)) items.push(chunk({ content: p }));
      if (annotations) items.push(chunk({ annotations }));
    }
    const wantUsage = r.includeUsage || flavor.alwaysUsage;
    if (flavor.usageField === 'x_groq') items.push(chunk({}, finish, { x_groq: { id: `req_${n}fake`, usage } }));
    else if (wantUsage && flavorName !== 'openai') items.push(chunk({}, finish, { usage }));
    else items.push(chunk({}, finish));
    if (r.includeUsage && flavorName === 'openai') items.push({ data: { ...base, choices: [], usage } });
    items.push({ raw: 'data: [DONE]\n\n' });
    return ctx.sse(items, { 'x-request-id': `req_${n}fake` });
  }

  /**
   * @param {import('./shared.mjs').FakeContext} ctx
   * @param {number} n
   */
  async function responses(ctx, n) {
    if (!ctx.json || (ctx.json.input === undefined && ctx.json.instructions === undefined)) return ctx.fail(400, 'bad_request');
    const r = readRequest(ctx.json, 'responses');
    const { scenario, reasoning } = decide(ctx.control.scenario, r);
    const respId = `resp_${n}fake`;
    const text = scenario === 'tool' ? '' : answerText(scenario, r, book);
    const fn = r.functions[0];
    const usage = { input_tokens: tokens(r.system + r.user), input_tokens_details: { cached_tokens: 0 }, output_tokens: tokens(text) + (reasoning ? tokens(REASONING_TEXT) : 0), output_tokens_details: { reasoning_tokens: reasoning ? tokens(REASONING_TEXT) : 0 }, total_tokens: 0 };
    usage.total_tokens = usage.input_tokens + usage.output_tokens;
    /** @type {Record<string, unknown>} */
    const head = { id: respId, object: 'response', created_at: 1767225600 + n, model: r.model, store: ctx.json.store !== false };
    /** @type {any[]} */
    const output = [];
    /** @type {Array<{ event: string, data: Record<string, unknown> }>} */
    const events = [];
    let seq = 0;
    /** @param {string} type @param {Record<string, unknown>} [data] */
    const emit = (type, data = {}) => events.push({ event: type, data: { type, sequence_number: seq++, ...data } });

    emit('response.created', { response: { ...head, status: 'in_progress', output: [] } });
    emit('response.in_progress', { response: { ...head, status: 'in_progress', output: [] } });
    if (reasoning) {
      const index = output.length;
      const item = { id: `rs_${n}fake`, type: 'reasoning', summary: /** @type {any[]} */ ([]) };
      emit('response.output_item.added', { output_index: index, item: { ...item } });
      if (r.summary) {
        emit('response.reasoning_summary_part.added', { item_id: item.id, output_index: index, summary_index: 0, part: { type: 'summary_text', text: '' } });
        for (const p of chunkText(REASONING_TEXT)) emit('response.reasoning_summary_text.delta', { item_id: item.id, output_index: index, summary_index: 0, delta: p });
        emit('response.reasoning_summary_text.done', { item_id: item.id, output_index: index, summary_index: 0, text: REASONING_TEXT });
        emit('response.reasoning_summary_part.done', { item_id: item.id, output_index: index, summary_index: 0, part: { type: 'summary_text', text: REASONING_TEXT } });
        item.summary = [{ type: 'summary_text', text: REASONING_TEXT }];
      }
      const done = r.encrypted ? { ...item, encrypted_content: Buffer.from(`fake-reasoning-${n}`).toString('base64') } : item;
      emit('response.output_item.done', { output_index: index, item: done });
      output.push(done);
    }
    if (scenario === 'search') {
      const index = output.length;
      const item = { id: `ws_${n}fake`, type: 'web_search_call', status: 'in_progress' };
      emit('response.output_item.added', { output_index: index, item });
      emit('response.web_search_call.in_progress', { output_index: index, item_id: item.id });
      emit('response.web_search_call.searching', { output_index: index, item_id: item.id });
      emit('response.web_search_call.completed', { output_index: index, item_id: item.id });
      const done = { ...item, status: 'completed', action: { type: 'search', query: r.user.slice(0, 60) } };
      emit('response.output_item.done', { output_index: index, item: done });
      output.push(done);
    }
    if (scenario === 'tool' && fn) {
      const index = output.length;
      const args = toolArgs(r);
      const item = { id: `fc_${n}fake`, type: 'function_call', status: 'in_progress', call_id: `call_${n}fake`, name: fn.name, arguments: '' };
      emit('response.output_item.added', { output_index: index, item });
      for (let i = 0; i < args.length; i += 7) emit('response.function_call_arguments.delta', { item_id: item.id, output_index: index, delta: args.slice(i, i + 7) });
      emit('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: args });
      const done = { ...item, status: 'completed', arguments: args };
      emit('response.output_item.done', { output_index: index, item: done });
      output.push(done);
    } else if (scenario !== 'stream-error') {
      const index = output.length;
      const refusal = scenario === 'refusal';
      const item = { id: `msg_${n}fake`, type: 'message', status: 'in_progress', role: 'assistant', content: /** @type {any[]} */ ([]) };
      emit('response.output_item.added', { output_index: index, item });
      const emptyPart = refusal ? { type: 'refusal', refusal: '' } : { type: 'output_text', text: '', annotations: [] };
      emit('response.content_part.added', { item_id: item.id, output_index: index, content_index: 0, part: emptyPart });
      for (const p of chunkText(text)) emit(refusal ? 'response.refusal.delta' : 'response.output_text.delta', { item_id: item.id, output_index: index, content_index: 0, delta: p });
      const annotations = scenario === 'search' ? citations(r.user).map((c) => ({ type: 'url_citation', url: c.url, title: c.title, start_index: c.start, end_index: c.end })) : [];
      annotations.forEach((annotation, i) => emit('response.output_text.annotation.added', { item_id: item.id, output_index: index, content_index: 0, annotation_index: i, annotation }));
      const part = refusal ? { type: 'refusal', refusal: text } : { type: 'output_text', text, annotations };
      emit(refusal ? 'response.refusal.done' : 'response.output_text.done', { item_id: item.id, output_index: index, content_index: 0, ...(refusal ? { refusal: text } : { text }) });
      emit('response.content_part.done', { item_id: item.id, output_index: index, content_index: 0, part });
      const done = { ...item, status: scenario === 'length' ? 'incomplete' : 'completed', content: [part] };
      emit('response.output_item.done', { output_index: index, item: done });
      output.push(done);
    }
    /** @type {Record<string, unknown>} */
    let final;
    if (scenario === 'stream-error') {
      final = { ...head, status: 'failed', error: { code: 'server_error', message: 'Simulated failure.' }, output, usage: null };
      emit('response.failed', { response: final });
    } else if (scenario === 'length') {
      final = { ...head, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output, usage };
      emit('response.incomplete', { response: final });
    } else {
      final = { ...head, status: 'completed', output, usage, output_text: text };
      emit('response.completed', { response: final });
    }
    if (!r.stream) return ctx.send(200, final, { 'x-request-id': `req_${n}fake` });
    return ctx.sse(events, { 'x-request-id': `req_${n}fake` });
  }

  /** @param {import('./shared.mjs').FakeContext} ctx */
  function speech(ctx) {
    const input = typeof ctx.json?.input === 'string' ? ctx.json.input : '';
    if (!input.trim()) return ctx.fail(400, 'bad_request');
    const ms = Math.min(10_000, 200 + input.length * 40);
    const format = ctx.json.response_format ?? 'mp3';
    if (format === 'wav') return ctx.sendBytes(200, wavSilence(ms, 24_000), 'audio/wav');
    if (format === 'pcm') return ctx.sendBytes(200, pcmSilence(ms, 24_000), 'audio/pcm');
    return ctx.sendBytes(200, mp3Silence(ms), 'audio/mpeg');
  }

  /** @param {import('./shared.mjs').FakeContext} ctx */
  function transcription(ctx) {
    if (!/^multipart\/form-data/i.test(ctx.req.headers['content-type'] ?? '') || ctx.raw.length === 0) return ctx.fail(400, 'bad_request');
    const form = ctx.raw.toString('latin1');
    const field = (/** @type {string} */ name) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(form)?.[1] ?? '';
    const text = field('language') === 'de' ? 'Dies ist ein simuliertes Transkript.' : 'This is a simulated transcript.';
    if (field('response_format') === 'text') return ctx.sendBytes(200, Buffer.from(text), 'text/plain; charset=utf-8');
    return ctx.send(200, { text, usage: { type: 'duration', seconds: 2 } });
  }

  return fake;
}

if (isMain(import.meta.url)) {
  await runStandalone('openai', ({ args, ...common }) => createOpenAiFake({ ...common, flavor: args.flavor ?? process.env.FAKE_FLAVOR, log: (l) => console.log(l) }), { envPort: 'FAKE_OPENAI_PORT', defaultPort: DEFAULT_PORT });
}
