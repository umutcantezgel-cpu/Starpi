// @ts-check
// Adapter for OpenAI's Responses API. Requests are stateless (`store: false`): nothing is kept on
// the provider's side, so each call sends the whole conversation, and reasoning models return their
// reasoning as encrypted items (`include: ['reasoning.encrypted_content']`) that are kept as opaque
// state and sent back unchanged in later turns.
//
// Mapping: reasoning summary deltas become reasoning events, output text deltas text events,
// url_citation annotations of the built-in web search citations, function calls tool calls (with
// argument pieces), refusals text with a `refusal` stop. Images go as input_image, PDFs as
// input_file, both as data URLs.
import { messageText, withoutForeignOpaque } from '../contract.js';
import { AiError } from '../errors.js';
import { fromOpenAiResponses } from '../stop-reason.js';
import { capsFor, parseModelList } from '../catalog/models.js';
import { createToolCalls, dataUrl, fileAsText, isRecord, streamError, usageEvent } from './common.js';

/** @typedef {import('../contract.js').AiRequest} AiRequest */
/** @typedef {import('../contract.js').AiEvent} AiEvent */
/** @typedef {import('../contract.js').Caps} Caps */
/** @typedef {import('../contract.js').Part} Part */
/** @typedef {import('../stream.js').WireAdapter} WireAdapter */

export const RESPONSES_PATH = '/v1/responses';

/**
 * Input content of a user message.
 * @param {Part[]} parts
 */
function userContent(parts) {
  /** @type {any[]} */
  const items = [];
  for (const p of parts) {
    if (p.type === 'text') {
      if (p.text) items.push({ type: 'input_text', text: p.text });
    } else if (p.type === 'image') items.push({ type: 'input_image', image_url: dataUrl(p.mime, p.data) });
    else if (p.type === 'file') {
      if (p.mime === 'application/pdf') items.push({ type: 'input_file', filename: p.name, file_data: dataUrl(p.mime, p.data) });
      else items.push({ type: 'input_text', text: fileAsText(p.name, p.data) });
    }
  }
  return items;
}

/**
 * The conversation as Responses input items. Stored reasoning items lead their assistant turn,
 * then its text, then its function calls, which is the order the API produced them in.
 * @param {AiRequest} req
 */
export function responsesInput(req) {
  /** @type {any[]} */
  const items = [];
  for (const m of withoutForeignOpaque(req.messages, 'openai')) {
    if (m.role === 'system') {
      const text = messageText(m);
      if (text) items.push({ role: 'developer', content: [{ type: 'input_text', text }] });
    } else if (m.role === 'user') {
      const content = userContent(m.content);
      if (content.length) items.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      for (const p of m.content) if (p.type === 'opaque' && isRecord(p.block) && p.block.type === 'reasoning') items.push(p.block);
      const text = messageText(m);
      if (text) items.push({ role: 'assistant', content: text });
      for (const p of m.content) if (p.type === 'tool_call') items.push({ type: 'function_call', call_id: p.id, name: p.name, arguments: JSON.stringify(p.args) });
    } else {
      for (const p of m.content) if (p.type === 'tool_result') items.push({ type: 'function_call_output', call_id: p.id, output: p.content });
    }
  }
  return items;
}

/**
 * The request body of a call.
 * @param {AiRequest} req
 * @param {Caps} [caps]
 */
export function buildResponsesBody(req, caps = capsFor('openai', req.model)) {
  /** @type {Record<string, any>} */
  const body = { model: req.model, input: responsesInput(req), stream: true, store: false };
  if (req.system) body.instructions = req.system;
  if (req.maxOutputTokens) body.max_output_tokens = Math.min(req.maxOutputTokens, caps.maxOutput);
  const reasons = caps.reasoning !== 'none';
  if (reasons) {
    body.include = ['reasoning.encrypted_content'];
    const mode = req.thinking?.mode ?? 'auto';
    const effort = mode === 'off' ? 'minimal' : req.thinking?.effort === 'max' ? 'high' : (req.thinking?.effort ?? (mode === 'on' ? 'high' : undefined));
    /** @type {Record<string, unknown>} */
    const reasoning = {};
    if (effort) reasoning.effort = effort;
    if (mode !== 'off' && req.thinking?.show !== false) reasoning.summary = 'auto';
    if (Object.keys(reasoning).length) body.reasoning = reasoning;
  } else if (req.temperature !== undefined) body.temperature = req.temperature;
  /** @type {any[]} */
  const tools = (req.tools ?? []).map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.schema, strict: false }));
  if (req.search?.enabled) tools.push({ type: 'web_search', ...(req.search.allowDomains?.length ? { filters: { allowed_domains: req.search.allowDomains } } : {}) });
  if (tools.length) body.tools = tools;
  if (req.toolChoice && req.tools?.length) body.tool_choice = req.toolChoice;
  if (req.responseFormat) body.text = { format: { type: 'json_schema', name: 'response', schema: req.responseFormat.schema, strict: false } };
  return body;
}

/**
 * @typedef {object} ResponsesState
 * @property {string} model
 * @property {boolean} started
 * @property {boolean} ended
 * @property {ReturnType<typeof createToolCalls>} tools
 * @property {Map<string, string | number>} callKeys       item id -> tool call key
 * @property {Map<string, number>} partStart               `<output>:<content>` -> offset of that text part in the answer
 * @property {number} answerLength
 * @property {boolean} refused
 * @property {Set<string>} summaries                       `<item>:<summary index>` seen, for separators
 * @property {Set<string>} cited
 */

/**
 * @param {ResponsesState} state
 * @returns {AiEvent[]}
 */
function begin(state) {
  if (state.started) return [];
  state.started = true;
  return [{ type: 'start', provider: 'openai', model: state.model }];
}

/**
 * @param {unknown} response
 * @param {ResponsesState} state
 * @returns {AiEvent[]}
 */
function finalEvents(response, state) {
  if (state.ended) return [];
  state.ended = true;
  const r = isRecord(response) ? response : {};
  /** @type {AiEvent[]} */
  const out = [...begin(state), ...state.tools.finish()];
  const u = isRecord(r.usage) ? r.usage : null;
  const usage = u ? usageEvent({ input: u.input_tokens, output: u.output_tokens, reasoning: u.output_tokens_details?.reasoning_tokens, cacheRead: u.input_tokens_details?.cached_tokens }) : null;
  if (usage) out.push(usage);
  if (r.status === 'failed') {
    const err = isRecord(r.error) ? r.error : {};
    out.push({ type: 'end', stopReason: 'error', error: streamError('openai', err.code) });
    return out;
  }
  const incomplete = isRecord(r.incomplete_details) ? r.incomplete_details.reason : undefined;
  out.push({ type: 'end', stopReason: fromOpenAiResponses(r.status ?? 'completed', incomplete, { hasToolCalls: state.tools.size > 0, refused: state.refused }) });
  return out;
}

/**
 * Citation events of one annotation (offsets made absolute in the answer).
 * @param {unknown} annotation
 * @param {number} base
 * @param {ResponsesState} state
 * @returns {AiEvent[]}
 */
function citation(annotation, base, state) {
  if (!isRecord(annotation) || annotation.type !== 'url_citation' || typeof annotation.url !== 'string' || !/^https?:\/\//i.test(annotation.url)) return [];
  const start = Number.isInteger(annotation.start_index) ? base + annotation.start_index : undefined;
  const end = Number.isInteger(annotation.end_index) ? base + annotation.end_index : undefined;
  const key = `${annotation.url}|${start}|${end}`;
  if (state.cited.has(key)) return [];
  state.cited.add(key);
  const offsets = start !== undefined && end !== undefined && start >= 0 && start <= end ? { start, end } : {};
  return [{ type: 'citation', url: annotation.url, title: typeof annotation.title === 'string' ? annotation.title : '', ...offsets }];
}

/**
 * One streamed Responses event (parsed JSON) as AiEvents.
 * @param {any} data
 * @param {ResponsesState} state
 * @returns {AiEvent[]}
 */
export function parseResponsesEvent(data, state) {
  if (!isRecord(data) || state.ended) return [];
  const type = typeof data.type === 'string' ? data.type : '';
  if (type === 'response.created' || type === 'response.in_progress') {
    if (isRecord(data.response) && typeof data.response.model === 'string' && data.response.model && !state.started) state.model = data.response.model;
    return begin(state);
  }
  /** @type {AiEvent[]} */
  const out = begin(state);
  const partKey = `${data.output_index}:${data.content_index}`;
  switch (type) {
    case 'response.content_part.added':
      state.partStart.set(partKey, state.answerLength);
      break;
    case 'response.output_text.delta':
    case 'response.refusal.delta':
      if (typeof data.delta === 'string' && data.delta) {
        if (!state.partStart.has(partKey)) state.partStart.set(partKey, state.answerLength);
        if (type === 'response.refusal.delta') state.refused = true;
        state.answerLength += data.delta.length;
        out.push({ type: 'text', delta: data.delta });
      }
      break;
    case 'response.output_text.annotation.added':
      out.push(...citation(data.annotation, state.partStart.get(partKey) ?? 0, state));
      break;
    case 'response.reasoning_summary_text.delta':
      if (typeof data.delta === 'string' && data.delta) {
        const key = `${data.item_id}:${data.summary_index}`;
        if (!state.summaries.has(key)) {
          if (state.summaries.size) out.push({ type: 'reasoning', delta: '\n\n' });
          state.summaries.add(key);
        }
        out.push({ type: 'reasoning', delta: data.delta });
      }
      break;
    case 'response.output_item.added': {
      const item = isRecord(data.item) ? data.item : {};
      if (item.type === 'function_call') {
        const key = String(item.call_id ?? item.id ?? data.output_index);
        state.callKeys.set(String(item.id ?? key), key);
        out.push(...state.tools.add(key, { id: item.call_id, name: item.name, argsDelta: item.arguments }, () => key));
      }
      break;
    }
    case 'response.function_call_arguments.delta': {
      const key = state.callKeys.get(String(data.item_id));
      if (key !== undefined) out.push(...state.tools.add(key, { argsDelta: data.delta }, () => String(key)));
      break;
    }
    case 'response.output_item.done': {
      const item = isRecord(data.item) ? data.item : {};
      // Encrypted reasoning is the state a stateless conversation hands back next turn.
      if (item.type === 'reasoning' && typeof item.encrypted_content === 'string') out.push({ type: 'opaque', block: item });
      break;
    }
    case 'response.completed':
    case 'response.incomplete':
    case 'response.failed':
      out.push(...finalEvents(data.response, state));
      break;
    case 'error': {
      state.ended = true;
      const error = streamError('openai', data.code ?? data.error?.code ?? data.error?.type);
      out.push({ type: 'end', stopReason: 'error', error });
      break;
    }
    default:
      break;
  }
  return out;
}

/**
 * The events of a whole (non-streamed) response object.
 * @param {Record<string, any>} response
 * @param {ResponsesState} state
 * @returns {AiEvent[]}
 */
function wholeResponse(response, state) {
  if (typeof response.model === 'string' && response.model) state.model = response.model;
  /** @type {AiEvent[]} */
  const out = begin(state);
  const output = Array.isArray(response.output) ? response.output : [];
  for (const [index, item] of output.entries()) {
    if (!isRecord(item)) continue;
    if (item.type === 'reasoning') {
      for (const s of Array.isArray(item.summary) ? item.summary : []) if (isRecord(s) && typeof s.text === 'string' && s.text) out.push({ type: 'reasoning', delta: s.text });
      if (typeof item.encrypted_content === 'string') out.push({ type: 'opaque', block: item });
    } else if (item.type === 'message') {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (!isRecord(part)) continue;
        const text = part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : null;
        if (typeof text !== 'string' || !text) continue;
        if (part.type === 'refusal') state.refused = true;
        const base = state.answerLength;
        state.answerLength += text.length;
        out.push({ type: 'text', delta: text });
        for (const a of Array.isArray(part.annotations) ? part.annotations : []) out.push(...citation(a, base, state));
      }
    } else if (item.type === 'function_call') {
      const key = String(item.call_id ?? item.id ?? index);
      out.push(...state.tools.add(key, { id: item.call_id, name: item.name, argsDelta: item.arguments }, () => key));
    }
  }
  return [...out, ...finalEvents(response, state)];
}

/**
 * The Responses adapter.
 * @returns {WireAdapter & { createState(req: AiRequest): ResponsesState }}
 */
export function createOpenAiResponsesAdapter() {
  return {
    kind: 'wire',
    id: 'openai',
    dialect: 'openai-responses',
    capabilities: (modelId, catalog) => capsFor('openai', modelId, catalog),
    listModels: { path: '/v1/models', parse: (json) => parseModelList('openai', json).map(({ id }) => ({ id })) },
    authHeader: (key) => ['authorization', `Bearer ${key}`],
    buildRequest(req) {
      return { path: RESPONSES_PATH, method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: buildResponsesBody(req) };
    },
    createState(req) {
      return { model: req.model, started: false, ended: false, tools: createToolCalls(), callKeys: new Map(), partStart: new Map(), answerLength: 0, refused: false, summaries: new Set(), cited: new Set() };
    },
    parseEvent(sse, state) {
      let data;
      try {
        data = JSON.parse(sse.data);
      } catch (err) {
        throw new AiError('bad_response', { provider: 'openai', cause: err });
      }
      return parseResponsesEvent(data, state);
    },
    parseResponse(json, state) {
      if (!isRecord(json)) throw new AiError('bad_response', { provider: 'openai' });
      return wholeResponse(json, state);
    },
  };
}

export const openaiResponsesAdapter = createOpenAiResponsesAdapter();
