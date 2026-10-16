#!/usr/bin/env node
// Fake of the Messages API on 127.0.0.1: POST /v1/messages (streamed and whole),
// POST /v1/messages/count_tokens and GET /v1/models. It answers browser calls only when they carry
// the direct-browser-access header, as the real API does, and rejects request shapes current models
// reject (a forced tool_choice, disabled thinking or a thinking budget on the 5.5 models), so an
// adapter that sends them fails in tests too.
//
// Scenarios (see shared.mjs): text (default), reasoning (a thinking block; its text is empty unless
// thinking.display is "summarized", always with a signature), redacted (a redacted_thinking block),
// tool (tool_use with input_json_delta), search (server_tool_use, web_search_tool_result and text
// with citations; chosen automatically when the request offers a web search tool), search-error
// (the result block carries an error object), pause (stops with pause_turn after the search call;
// sending the turn back continues it), refusal, length, stream-error (an error event mid-stream).
// A request with `thinking` gets a thinking block in every scenario. Faults: see shared.mjs.
//
// Usage: node scripts/fakes/anthropic.mjs [--port 4612] [--marker starpi-purpose] [--fixtures dir]
// API root for clients: http://127.0.0.1:<port> (paths /v1/...)
import { createHash } from 'node:crypto';
import { chunkText, createAnswerBook, createFakeServer, isMain, REASONING_TEXT, refusalText, runStandalone, SEARCH_SOURCES, searchSentences } from './shared.mjs';

export const DEFAULT_PORT = 4612;
export const BROWSER_HEADER = 'anthropic-dangerous-direct-browser-access';

/** Models the fake lists, with the fields the live list carries. */
export const FAKE_MODELS = Object.freeze([
  { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 1_000_000, max_tokens: 128_000 },
  { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', max_input_tokens: 1_000_000, max_tokens: 128_000 },
  { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', max_input_tokens: 1_000_000, max_tokens: 128_000 },
]);

/** Models that reject forced tool use and disabled thinking. */
const STRICT_MODELS = /^claude-(?:opus|sonnet)-5-5/;

const ERROR_TYPES = /** @type {Record<number, string>} */ ({
  400: 'invalid_request_error',
  401: 'authentication_error',
  402: 'billing_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  500: 'api_error',
  503: 'overloaded_error',
  529: 'overloaded_error',
});

/** @param {number} status @param {string} [message] */
const errorBody = (status, message = 'Simulated error.') => ({ type: 'error', error: { type: ERROR_TYPES[status] ?? 'api_error', message }, request_id: 'req_fake' });

/** @param {unknown} content */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
}

/**
 * The opaque signature of a thinking block, derived from its text and model.
 * @param {string} text
 * @param {string} model
 */
export function signatureOf(text, model) {
  return `fake-sig-${createHash('sha256').update(`${model}\n${text}`).digest('base64url').slice(0, 32)}`;
}

/** @param {string} text */
const tokens = (text) => Math.max(1, Math.ceil(text.length / 4));

/**
 * The 400 a real model gives for this request shape, or null.
 * @param {any} body
 */
function rejectShape(body) {
  if (typeof body.model !== 'string' || !body.model) return 'model: field required';
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) return 'max_tokens: field required';
  if (!Array.isArray(body.messages) || body.messages.length === 0) return 'messages: at least one message is required';
  if (body.messages[0]?.role !== 'user') return 'messages: first message must use the "user" role';
  if (STRICT_MODELS.test(body.model)) {
    const choice = body.tool_choice?.type;
    if (choice === 'any' || choice === 'tool') return 'tool_choice: type "tool" and "any" are not supported for this model.';
    if (body.thinking?.type === 'disabled' && /opus/.test(body.model)) return 'thinking: type "disabled" is not supported for this model.';
    if (body.thinking?.type === 'enabled' || body.thinking?.budget_tokens !== undefined) return 'thinking.budget_tokens: not supported for this model; use adaptive thinking.';
  }
  return null;
}

/**
 * Creates the fake (not yet listening).
 * @param {{ marker?: string, fixtures?: any, fixturesDir?: string, gapMs?: number, latencyMs?: number, cors?: boolean, log?: (line: string) => void }} [options]
 */
export function createAnthropicFake(options = {}) {
  const book = createAnswerBook(options);
  let counter = 0;

  return createFakeServer(
    {
      name: 'anthropic',
      texts: ({ json }) => {
        const users = Array.isArray(json?.messages) ? json.messages.filter((/** @type {any} */ m) => m?.role === 'user') : [];
        return users.length ? [textOf(users[users.length - 1].content)] : [];
      },
      auth: ({ req, url }) => {
        if (url.searchParams.has('key') || url.searchParams.has('api_key')) return 'in_query';
        const key = req.headers['x-api-key'];
        const bearer = req.headers.authorization;
        return (typeof key === 'string' && key.length > 0) || (typeof bearer === 'string' && /^Bearer \S+$/.test(bearer)) ? 'ok' : 'missing';
      },
      // Browsers get CORS headers only for requests that opt into direct access.
      cors: (req) => {
        const requested = String(req.headers['access-control-request-headers'] ?? '').toLowerCase();
        return req.headers[BROWSER_HEADER] === 'true' || requested.split(',').map((h) => h.trim()).includes(BROWSER_HEADER);
      },
      errorBody: (status) => errorBody(status),
      async handle(ctx) {
        const method = ctx.req.method;
        if (method === 'GET' && ctx.path === '/v1/models') {
          const data = FAKE_MODELS.map((m) => ({ type: 'model', ...m, created_at: '2026-01-01T00:00:00Z', capabilities: { image_input: { supported: true }, thinking: { supported: true, types: { adaptive: { supported: true } } } } }));
          return ctx.send(200, { data, has_more: false, first_id: data[0].id, last_id: data[data.length - 1].id });
        }
        const one = /^\/v1\/models\/([a-z0-9.-]+)$/.exec(ctx.path);
        if (method === 'GET' && one) {
          const model = FAKE_MODELS.find((m) => m.id === one[1]);
          return model ? ctx.send(200, { type: 'model', ...model, created_at: '2026-01-01T00:00:00Z' }) : ctx.fail(404, 'not_found');
        }
        if (method !== 'POST') return false;
        if (typeof ctx.req.headers['anthropic-version'] !== 'string') return ctx.send(400, errorBody(400, 'anthropic-version: header is required'));
        if (!ctx.json || typeof ctx.json !== 'object') return ctx.send(400, errorBody(400, 'There was an issue with the request body.'));
        if (ctx.path === '/v1/messages/count_tokens') {
          const all = (ctx.json.messages ?? []).map((/** @type {any} */ m) => textOf(m?.content)).join('\n');
          return ctx.send(200, { input_tokens: tokens(`${textOf(ctx.json.system)}${all}`) });
        }
        if (ctx.path !== '/v1/messages') return false;
        const problem = rejectShape(ctx.json);
        if (problem) return ctx.send(400, errorBody(400, problem));
        counter += 1;
        return messages(ctx, counter);
      },
    },
    options,
  );

  /**
   * @param {import('./shared.mjs').FakeContext} ctx
   * @param {number} n
   */
  function messages(ctx, n) {
    const body = ctx.json;
    const model = body.model;
    const msgs = /** @type {any[]} */ (body.messages);
    const users = msgs.filter((m) => m?.role === 'user');
    const user = users.length ? textOf(users[users.length - 1].content) : '';
    const system = textOf(body.system);
    const last = msgs[msgs.length - 1];
    const afterTool = last?.role === 'user' && Array.isArray(last.content) && last.content.some((/** @type {any} */ b) => b?.type === 'tool_result');
    const lastBlocks = last?.role === 'assistant' && Array.isArray(last.content) ? last.content : [];
    const resumesPause = lastBlocks.length > 0 && lastBlocks[lastBlocks.length - 1]?.type === 'server_tool_use';
    /** @type {any[]} */
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const searchTool = tools.find((t) => typeof t?.type === 'string' && t.type.startsWith('web_search'));
    const clientTool = tools.find((t) => t && typeof t.name === 'string' && (t.type === undefined || t.type === 'custom'));

    let scenario = ctx.control.scenario ?? (searchTool ? 'search' : 'text');
    if (resumesPause) scenario = 'resume';
    else if (afterTool || (scenario === 'tool' && !clientTool)) scenario = 'text';
    const thinking = scenario === 'reasoning' || (body.thinking && body.thinking.type !== 'disabled' && body.thinking.type !== 'between_tools');
    const summarized = body.thinking?.display === 'summarized';

    /** @type {any[]} */
    const content = [];
    if (thinking) content.push({ type: 'thinking', thinking: summarized ? REASONING_TEXT : '', signature: signatureOf(REASONING_TEXT, model) });
    if (scenario === 'redacted') content.push({ type: 'redacted_thinking', data: Buffer.from(`fake-redacted-${n}`).toString('base64') });
    let stopReason = 'end_turn';
    let searches = 0;
    const query = user.replace(/\[\[[^\]]*\]\]/g, '').trim().slice(0, 60) || 'example';
    const searchCall = { type: 'server_tool_use', id: `srvtoolu_${n}fake`, name: 'web_search', input: { query } };
    const searchResult = (/** @type {string} */ id) => ({
      type: 'web_search_tool_result',
      tool_use_id: id,
      content: scenario === 'search-error'
        ? { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' }
        : SEARCH_SOURCES.map((s, i) => ({ type: 'web_search_result', url: s.url, title: s.title, encrypted_content: Buffer.from(`fake-page-${i}`).toString('base64'), page_age: 'January 1, 2026' })),
    });
    const citedText = () =>
      searchSentences(user).map((s, i) => ({
        type: 'text',
        text: s.text,
        citations: [{ type: 'web_search_result_location', url: SEARCH_SOURCES[s.source].url, title: SEARCH_SOURCES[s.source].title, cited_text: SEARCH_SOURCES[s.source].snippet, encrypted_index: Buffer.from(`fake-index-${i}`).toString('base64') }],
      }));

    switch (scenario) {
      case 'tool': {
        const input = { query };
        content.push({ type: 'text', text: 'Let me look that up.' });
        content.push({ type: 'tool_use', id: `toolu_${n}fake`, name: clientTool.name, input });
        stopReason = 'tool_use';
        break;
      }
      case 'search':
      case 'search-error':
        searches = 1;
        content.push(searchCall, searchResult(searchCall.id));
        if (scenario === 'search') content.push(...citedText());
        else content.push({ type: 'text', text: 'The search could not run, so this answer uses no sources.' });
        break;
      case 'pause':
        searches = 1;
        content.push(searchCall);
        stopReason = 'pause_turn';
        break;
      case 'resume':
        searches = 1;
        content.push(searchResult(String(lastBlocks[lastBlocks.length - 1]?.id ?? searchCall.id)), ...citedText());
        break;
      case 'refusal':
        content.push({ type: 'text', text: refusalText(user) });
        stopReason = 'refusal';
        break;
      default: {
        const { text } = book.answer({ system, user, schema: body.output_config?.format?.schema ?? null });
        content.push({ type: 'text', text: scenario === 'length' ? text.slice(0, Math.max(1, Math.floor(text.length / 2))) : text });
        if (scenario === 'length') stopReason = 'max_tokens';
      }
    }

    const outputText = content.map((b) => (b.type === 'text' ? b.text : b.type === 'thinking' ? REASONING_TEXT : '')).join('');
    const usage = {
      input_tokens: tokens(system + user),
      output_tokens: tokens(outputText),
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...(searches ? { server_tool_use: { web_search_requests: searches } } : {}),
    };
    const stopDetails = stopReason === 'refusal' ? { type: 'refusal', category: null, explanation: 'Simulated refusal.' } : null;
    const message = { id: `msg_${n}fake`, type: 'message', role: 'assistant', model, content, stop_reason: stopReason, stop_sequence: null, stop_details: stopDetails, usage };
    const headers = { 'request-id': `req_${n}fake` };
    if (body.stream !== true) return ctx.send(200, message, headers);
    return ctx.sse(streamOf(message, scenario === 'stream-error'), headers);
  }
}

/**
 * The event stream of a whole message: message_start, each block as start, deltas and stop,
 * message_delta with the stop reason and usage, message_stop.
 * @param {any} message
 * @param {boolean} failMidway  replace the end with an error event
 * @returns {import('./shared.mjs').SseItem[]}
 */
export function streamOf(message, failMidway = false) {
  /** @param {string} event @param {Record<string, unknown>} data */
  const ev = (event, data) => ({ event, data: { type: event, ...data } });
  const items = [
    ev('message_start', { message: { ...message, content: [], stop_reason: null, stop_sequence: null, stop_details: null, usage: { ...message.usage, output_tokens: 1 } } }),
    ev('ping', {}),
  ];
  message.content.forEach((/** @type {any} */ block, /** @type {number} */ index) => {
    switch (block.type) {
      case 'thinking':
        items.push(ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } }));
        for (const piece of block.thinking ? chunkText(block.thinking) : []) items.push(ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: piece } }));
        items.push(ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: block.signature } }));
        break;
      case 'text':
        items.push(ev('content_block_start', { index, content_block: { type: 'text', text: '', ...(block.citations ? { citations: [] } : {}) } }));
        for (const citation of block.citations ?? []) items.push(ev('content_block_delta', { index, delta: { type: 'citations_delta', citation } }));
        for (const piece of chunkText(block.text)) items.push(ev('content_block_delta', { index, delta: { type: 'text_delta', text: piece } }));
        break;
      case 'tool_use':
      case 'server_tool_use': {
        items.push(ev('content_block_start', { index, content_block: { ...block, input: {} } }));
        const json = JSON.stringify(block.input);
        for (let i = 0; i < json.length; i += 6) items.push(ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 6) } }));
        break;
      }
      default:
        // redacted_thinking and web_search_tool_result arrive whole in their start event.
        items.push(ev('content_block_start', { index, content_block: block }));
    }
    items.push(ev('content_block_stop', { index }));
  });
  if (failMidway) {
    items.splice(Math.max(3, items.length - 2));
    items.push(ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }));
    return items;
  }
  items.push(ev('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null, stop_details: message.stop_details }, usage: { output_tokens: message.usage.output_tokens, ...(message.usage.server_tool_use ? { server_tool_use: message.usage.server_tool_use } : {}) } }));
  items.push(ev('message_stop', {}));
  return items;
}

if (isMain(import.meta.url)) {
  await runStandalone('anthropic', (common) => createAnthropicFake({ ...common, log: (l) => console.log(l) }), { envPort: 'FAKE_ANTHROPIC_PORT', defaultPort: DEFAULT_PORT });
}
