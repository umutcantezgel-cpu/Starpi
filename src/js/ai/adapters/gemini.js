// @ts-check
// Adapter for the Gemini API (v1beta), streamed with `:streamGenerateContent?alt=sse`. The key
// travels in the x-goog-api-key header, never in the URL.
//
// Thinking: `thinkingConfig` with `thinkingLevel` (models the catalog marks `reasoning: 'effort'`)
// or `thinkingBudget` (`'budget'`), and `includeThoughts` so thought summaries arrive as parts
// marked `thought: true`. Thought signatures (on function calls and on the first answer part) are
// the model's state: the answer's parts are kept as one opaque block and sent back unchanged in
// later turns, which function calling requires.
//
// Search: the google_search tool; the grounding metadata becomes citation events (its segment
// offsets count UTF-8 bytes and are converted to UTF-16 offsets into the answer), and the search
// suggestions Google asks apps to show are kept in a second opaque block for the view.
import { messageText, withoutForeignOpaque } from '../contract.js';
import { AiError } from '../errors.js';
import { fromGemini } from '../stop-reason.js';
import { capsFor, parseModelList } from '../catalog/models.js';
import { base64Text, isRecord, streamError, toolNameFor, usageEvent, utf16Offset } from './common.js';

/** @typedef {import('../contract.js').AiRequest} AiRequest */
/** @typedef {import('../contract.js').AiEvent} AiEvent */
/** @typedef {import('../contract.js').Caps} Caps */
/** @typedef {import('../contract.js').Message} Message */
/** @typedef {import('../stream.js').WireAdapter} WireAdapter */

/** The `kind` of the opaque block that holds a whole answer's parts. */
export const OPAQUE_PARTS = 'gemini-parts';
/** The `kind` of the opaque block with the search suggestions and queries of a grounded answer. */
export const OPAQUE_GROUNDING = 'gemini-grounding';
/** Thinking budgets per effort for models that take a budget; -1 lets the model decide. */
const BUDGETS = Object.freeze({ low: 1024, medium: 8192, high: 24_576, max: 32_768 });
/** Model ids the request path accepts (the relay allows the same set). */
const MODEL_ID = /^[a-z0-9.-]{1,100}$/;

/**
 * The generation config's thinking part.
 * @param {AiRequest} req
 * @param {Caps} caps
 * @returns {Record<string, unknown> | null}
 */
function thinkingConfig(req, caps) {
  if (caps.reasoning !== 'effort' && caps.reasoning !== 'budget') return null;
  const mode = req.thinking?.mode ?? 'auto';
  const effort = req.thinking?.effort;
  const show = mode !== 'off' && (req.thinking?.show ?? true);
  /** @type {Record<string, unknown>} */
  const config = { includeThoughts: show };
  if (caps.reasoning === 'effort') {
    if (mode === 'off' || effort === 'low' || effort === 'medium') config.thinkingLevel = 'low';
    else if (mode === 'on' || effort) config.thinkingLevel = 'high';
  } else if (mode === 'off') {
    // Models that cannot stop thinking refuse 0; the smallest budget is the closest to "off".
    config.thinkingBudget = /pro/.test(req.model) ? 128 : 0;
  } else if (effort) config.thinkingBudget = BUDGETS[effort];
  else if (mode === 'on') config.thinkingBudget = -1;
  return config;
}

/**
 * Parts of a user message.
 * @param {Message} m
 */
function userParts(m) {
  /** @type {any[]} */
  const parts = [];
  for (const p of m.content) {
    if (p.type === 'text') {
      if (p.text) parts.push({ text: p.text });
    } else if (p.type === 'image') parts.push({ inlineData: { mimeType: p.mime, data: p.data } });
    else if (p.type === 'file') {
      if (p.mime === 'application/pdf') parts.push({ inlineData: { mimeType: p.mime, data: p.data } });
      else parts.push({ text: `${p.name}\n\n${base64Text(p.data)}` });
    }
  }
  return parts;
}

/**
 * Parts of an assistant (model) message: the stored parts of the answer when there are some, else
 * parts rebuilt from text and function calls.
 * @param {Message} m
 */
function modelParts(m) {
  for (const p of m.content) {
    if (p.type === 'opaque' && isRecord(p.block) && p.block.kind === OPAQUE_PARTS && Array.isArray(p.block.parts)) return p.block.parts;
  }
  /** @type {any[]} */
  const parts = [];
  const text = messageText(m);
  if (text) parts.push({ text });
  for (const p of m.content) if (p.type === 'tool_call') parts.push({ functionCall: { name: p.name, args: p.args } });
  return parts;
}

/**
 * The system instruction and contents of a request. System messages inside the conversation join
 * the system instruction (Gemini has no other place for them); tool results become a user turn of
 * functionResponse parts, named after the call they answer.
 * @param {AiRequest} req
 */
export function geminiContents(req) {
  const messages = withoutForeignOpaque(req.messages, 'gemini');
  /** @type {string[]} */
  const system = req.system ? [req.system] : [];
  /** @type {Array<{ role: 'user' | 'model', parts: any[] }>} */
  const contents = [];
  for (const m of messages) {
    if (m.role === 'system') {
      const text = messageText(m);
      if (text) system.push(text);
    } else if (m.role === 'user') {
      const parts = userParts(m);
      if (parts.length) contents.push({ role: 'user', parts });
    } else if (m.role === 'assistant') {
      const parts = modelParts(m);
      if (parts.length) contents.push({ role: 'model', parts });
    } else {
      const parts = m.content.flatMap((p) => {
        if (p.type !== 'tool_result') return [];
        const name = toolNameFor(messages, p.id) ?? 'tool';
        const response = p.isError ? { error: p.content } : { result: p.content };
        return [{ functionResponse: { name, response, ...(p.id.startsWith('gemini-call-') ? {} : { id: p.id }) } }];
      });
      if (!parts.length) continue;
      const last = contents[contents.length - 1];
      if (last?.role === 'user' && last.parts.every((/** @type {any} */ x) => x.functionResponse)) last.parts.push(...parts);
      else contents.push({ role: 'user', parts });
    }
  }
  return { system: system.join('\n\n'), contents };
}

/**
 * The request body of a call.
 * @param {AiRequest} req
 * @param {Caps} [caps]
 */
export function buildGeminiBody(req, caps = capsFor('gemini', req.model)) {
  const { system, contents } = geminiContents(req);
  /** @type {Record<string, any>} */
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  /** @type {Record<string, any>} */
  const generation = {};
  if (req.maxOutputTokens) generation.maxOutputTokens = Math.min(req.maxOutputTokens, caps.maxOutput);
  if (req.temperature !== undefined) generation.temperature = req.temperature;
  const thinking = thinkingConfig(req, caps);
  if (thinking) generation.thinkingConfig = thinking;
  if (req.responseFormat) {
    generation.responseMimeType = 'application/json';
    generation.responseJsonSchema = req.responseFormat.schema;
  }
  if (caps.imageOut) generation.responseModalities = ['TEXT', 'IMAGE'];
  if (Object.keys(generation).length) body.generationConfig = generation;
  /** @type {any[]} */
  const tools = [];
  if (req.tools?.length) tools.push({ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.schema })) });
  if (req.search?.enabled) tools.push({ google_search: {} });
  if (tools.length) body.tools = tools;
  if (req.tools?.length && req.toolChoice) body.toolConfig = { functionCallingConfig: { mode: req.toolChoice === 'none' ? 'NONE' : 'AUTO' } };
  return body;
}

/**
 * @typedef {object} GeminiState
 * @property {string} model
 * @property {boolean} started
 * @property {boolean} ended
 * @property {any[]} parts          the answer's parts as they will be replayed
 * @property {boolean} signed       a part carried a thought signature
 * @property {string} answer        the answer text so far (for grounding offsets)
 * @property {string | null} finishReason
 * @property {unknown} blockReason
 * @property {number} calls
 * @property {AiEvent | null} usage
 * @property {Record<string, any> | null} grounding
 */

/**
 * @param {GeminiState} state
 * @returns {AiEvent[]}
 */
function begin(state) {
  if (state.started) return [];
  state.started = true;
  return [{ type: 'start', provider: 'gemini', model: state.model }];
}

/**
 * Adds a part to the stored answer. Plain text parts without a signature join the text part before
 * them when that one has none either; a part with a signature always stands alone.
 * @param {GeminiState} state
 * @param {Record<string, any>} part
 */
function keepPart(state, part) {
  const prev = state.parts[state.parts.length - 1];
  const plain = (/** @type {any} */ p) => typeof p.text === 'string' && !p.thought && !p.thoughtSignature && Object.keys(p).length === 1;
  if (prev && plain(prev) && plain(part)) prev.text += part.text;
  else state.parts.push({ ...part });
}

/**
 * Citation events of grounding metadata.
 * @param {Record<string, any>} grounding
 * @param {string} answer
 * @returns {AiEvent[]}
 */
export function groundingCitations(grounding, answer) {
  const chunks = Array.isArray(grounding.groundingChunks) ? grounding.groundingChunks : [];
  const supports = Array.isArray(grounding.groundingSupports) ? grounding.groundingSupports : [];
  /** @type {AiEvent[]} */
  const out = [];
  const web = (/** @type {number} */ i) => {
    const w = isRecord(chunks[i]) && isRecord(chunks[i].web) ? chunks[i].web : null;
    return w && typeof w.uri === 'string' && /^https?:\/\//i.test(w.uri) ? { url: w.uri, title: typeof w.title === 'string' ? w.title : '' } : null;
  };
  const used = new Set();
  for (const s of supports) {
    if (!isRecord(s) || !Array.isArray(s.groundingChunkIndices)) continue;
    const seg = isRecord(s.segment) ? s.segment : {};
    const startByte = Number.isInteger(seg.startIndex) ? seg.startIndex : 0;
    const endByte = Number.isInteger(seg.endIndex) ? seg.endIndex : null;
    const start = utf16Offset(answer, startByte);
    const end = endByte === null ? undefined : utf16Offset(answer, endByte);
    for (const i of s.groundingChunkIndices) {
      const source = Number.isInteger(i) ? web(i) : null;
      if (!source) continue;
      used.add(i);
      out.push({ type: 'citation', ...source, ...(typeof seg.text === 'string' ? { citedText: seg.text } : {}), ...(end !== undefined && start <= end ? { start, end } : {}) });
    }
  }
  // Sources the answer does not point at still count as consulted.
  chunks.forEach((_, i) => {
    const source = used.has(i) ? null : web(i);
    if (source) out.push({ type: 'citation', ...source });
  });
  return out;
}

/**
 * @param {GeminiState} state
 * @returns {AiEvent[]}
 */
function closing(state) {
  if (state.ended) return [];
  state.ended = true;
  /** @type {AiEvent[]} */
  const out = begin(state);
  if (state.grounding) {
    out.push(...groundingCitations(state.grounding, state.answer));
    const entry = isRecord(state.grounding.searchEntryPoint) ? state.grounding.searchEntryPoint.renderedContent : undefined;
    const queries = Array.isArray(state.grounding.webSearchQueries) ? state.grounding.webSearchQueries.filter((q) => typeof q === 'string') : [];
    if (typeof entry === 'string' || queries.length) out.push({ type: 'opaque', block: { kind: OPAQUE_GROUNDING, ...(typeof entry === 'string' ? { searchEntryPoint: entry } : {}), queries } });
  }
  if (state.signed && state.parts.length) out.push({ type: 'opaque', block: { kind: OPAQUE_PARTS, parts: state.parts } });
  if (state.usage) out.push(state.usage);
  out.push({ type: 'end', stopReason: fromGemini(state.finishReason, { hasToolCalls: state.calls > 0, blockReason: state.blockReason }) });
  return out;
}

/**
 * One response chunk (parsed JSON) as AiEvents.
 * @param {any} chunk
 * @param {GeminiState} state
 * @returns {AiEvent[]}
 */
export function parseGeminiChunk(chunk, state) {
  if (!isRecord(chunk) || state.ended) return [];
  if (isRecord(chunk.error)) {
    state.ended = true;
    const error = streamError('gemini', chunk.error.status);
    return [...begin(state), { type: 'end', stopReason: 'error', error }];
  }
  if (typeof chunk.modelVersion === 'string' && chunk.modelVersion && !state.started) state.model = chunk.modelVersion;
  /** @type {AiEvent[]} */
  const out = begin(state);
  const u = isRecord(chunk.usageMetadata) ? chunk.usageMetadata : null;
  if (u) state.usage = usageEvent({ input: u.promptTokenCount, output: u.candidatesTokenCount, reasoning: u.thoughtsTokenCount, cacheRead: u.cachedContentTokenCount });
  if (isRecord(chunk.promptFeedback) && chunk.promptFeedback.blockReason) state.blockReason = chunk.promptFeedback.blockReason;
  const candidate = Array.isArray(chunk.candidates) && isRecord(chunk.candidates[0]) ? chunk.candidates[0] : null;
  if (!candidate) return out;
  const parts = isRecord(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.thoughtSignature) state.signed = true;
    if (part.thought === true) {
      if (typeof part.text === 'string' && part.text) out.push({ type: 'reasoning', delta: part.text });
      // A thought part that carries a signature goes back as it came; plain summaries need not.
      if (part.thoughtSignature) keepPart(state, part);
      continue;
    }
    if (typeof part.text === 'string') {
      if (part.text) {
        state.answer += part.text;
        out.push({ type: 'text', delta: part.text });
      }
      keepPart(state, part);
    } else if (isRecord(part.functionCall) && typeof part.functionCall.name === 'string') {
      state.calls += 1;
      const call = part.functionCall;
      const id = typeof call.id === 'string' && call.id ? call.id : `gemini-call-${state.calls}`;
      out.push({ type: 'tool_call', id, name: call.name, args: isRecord(call.args) ? call.args : {}, final: true });
      keepPart(state, part);
    } else if (isRecord(part.inlineData)) {
      const { mimeType, data } = part.inlineData;
      if (typeof mimeType === 'string' && /^image\//i.test(mimeType) && typeof data === 'string' && data) out.push({ type: 'image', mime: mimeType, data });
    } else keepPart(state, part);
  }
  if (isRecord(candidate.groundingMetadata)) state.grounding = candidate.groundingMetadata;
  if (typeof candidate.finishReason === 'string') state.finishReason = candidate.finishReason;
  return out;
}

/**
 * The Gemini adapter.
 * @returns {WireAdapter & { createState(req: AiRequest): GeminiState }}
 */
export function createGeminiAdapter() {
  return {
    kind: 'wire',
    id: 'gemini',
    dialect: 'gemini',
    capabilities: (modelId, catalog) => capsFor('gemini', modelId, catalog),
    listModels: { path: '/v1beta/models?pageSize=1000', parse: (json) => parseModelList('gemini', json).map(({ id, label, contextTokens, maxOutput }) => ({ id, label, contextTokens, maxOutput })) },
    authHeader: (key) => ['x-goog-api-key', key],
    buildRequest(req) {
      if (!MODEL_ID.test(req.model)) throw new AiError('bad_request', { provider: 'gemini' });
      return { path: `/v1beta/models/${req.model}:streamGenerateContent?alt=sse`, method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: buildGeminiBody(req) };
    },
    createState(req) {
      return { model: req.model, started: false, ended: false, parts: [], signed: false, answer: '', finishReason: null, blockReason: undefined, calls: 0, usage: null, grounding: null };
    },
    parseEvent(sse, state) {
      let chunk;
      try {
        chunk = JSON.parse(sse.data);
      } catch (err) {
        throw new AiError('bad_response', { provider: 'gemini', cause: err });
      }
      return parseGeminiChunk(chunk, state);
    },
    finish(state) {
      // The stream has no end marker: it ends after the chunk with the finish reason (or a prompt
      // block reason). Closing without either is a cut stream.
      return state.finishReason !== null || state.blockReason ? closing(state) : [];
    },
    parseResponse(json, state) {
      const chunks = Array.isArray(json) ? json : [json];
      const out = chunks.flatMap((c) => parseGeminiChunk(c, state));
      return [...out, ...closing(state)];
    },
  };
}

export const geminiAdapter = createGeminiAdapter();
