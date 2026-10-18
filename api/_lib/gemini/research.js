// @ts-check
// Origin: generic infrastructure first written for a related project of the same author (MIT); re-expressed for Starpi.
//
// One step of a research job on the site's Gemini pool (POST /api/research/step). The server keeps
// no state between steps: the browser carries the conversation and sends it back each time. Two
// parts:
//   - sources: a tool loop over the read-only tools of research/prompts.js. The browser runs the
//     tools on its own documents; the server only talks to Gemini. Every model turn that asks for
//     tools goes to the browser with an HMAC signature, and comes back with the tool results in the
//     next step; a turn whose signature does not verify is refused, so a browser can neither forge a
//     model turn (and with it what the model "said") nor move a turn to another question, round or
//     model. The signing key is derived with HKDF from the first Gemini key and never leaves this
//     module. At most MAX_TOOL_ROUNDS rounds: in the step after the last one the model may only
//     answer (functionCallingConfig NONE).
//   - web: a single step with Google Search; the answer comes back with its grounding (segments in
//     UTF-16 offsets of the text, sources, queries, search suggestions), the text exactly as Google
//     grounded it.
// A browser that holds its own key talks to the provider directly and needs none of this.
//
// WebCrypto only (HKDF, HMAC), so it runs on any runtime with Web globals.
import { MAX_CALLS_PER_ROUND, MAX_TOOL_ROUNDS, QUESTION_CHARS, isSourceTool, sourcesPrompt, toolDeclarations, webPrompt } from '../../../src/js/research/prompts.js';
import { isPoolModel } from '../../../src/js/ai/catalog/pools.js';
import { scrubSecrets } from '../relay/scrub.js';

/**
 * @typedef {'sources' | 'web'} StepPart
 * @typedef {{ role: 'model', parts: Array<Record<string, unknown>> }} ModelTurn
 * @typedef {{ turn: ModelTurn, sig: string }} SignedTurn
 * @typedef {{ name: string, id?: string, content: string }} ToolResult
 * @typedef {{ results: ToolResult[] }} ResultsItem
 * @typedef {object} StepRequest
 * @property {StepPart} part
 * @property {string} question
 * @property {'en' | 'de'} locale
 * @property {Array<SignedTurn | ResultsItem>} history  alternating: a signed model turn, then the results of its calls
 * @property {readonly string[]} hints  search queries of the plan (sources part)
 * @property {string | null} focus      a document the question is about (sources part)
 * @typedef {{ name: string, id?: string, args: Record<string, unknown> }} StepCall
 * @typedef {object} WebGrounding
 * @property {Array<{ start: number, end: number, sources: number[] }>} segments
 * @property {Array<{ uri: string, title: string }>} sources
 * @property {string[]} queries
 * @property {string | null} suggestionsHtml
 * @typedef {{ status: 'tool_calls', round: number, model: string, calls: StepCall[], turn: ModelTurn, sig: string }
 *   | { status: 'final', round: number, model: string, text: string, grounding: WebGrounding | null }} StepResponse
 * @typedef {object} TurnSigner
 * @property {(turn: { part: StepPart, round: number, question: string, model: string, turn: unknown }) => Promise<string>} sign
 * @property {(turn: { part: StepPart, round: number, question: string, model: string, turn: unknown }, sig: string) => Promise<boolean>} verify
 */

/** Size limits of a step. */
export const STEP_LIMITS = Object.freeze({
  /** Request body. */
  bodyBytes: 600_000,
  /** One tool result as the browser sends it. */
  resultChars: 24_000,
  /** One model turn (JSON). */
  turnBytes: 200_000,
  /** The answer text. */
  textChars: 16_000,
  hints: 4,
  hintChars: 200,
  focusChars: 300,
});

/** The pool model a step uses unless STARPI_RESEARCH_MODEL names another model of the Gemini pool. */
export const RESEARCH_MODEL = 'gemini-2.5-flash';
/** Deadline of one generateContent call. */
export const STEP_TIMEOUT_MS = 25_000;
/** A signature: HMAC-SHA256 in base64url without padding. */
const SIG = /^[A-Za-z0-9_-]{43}$/;
const CALL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const encoder = new TextEncoder();

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} value */
const jsonBytes = (value) => encoder.encode(JSON.stringify(value) ?? '').byteLength;

/**
 * JSON with the keys of every object sorted, so a turn verifies however the browser orders them.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = /** @type {Record<string, unknown>} */ (value);
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

/** @param {ArrayBuffer} buffer */
function base64url(buffer) {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {string} text */
function fromBase64url(text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** @param {string} text */
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * What a signature covers: the part, the round, the question (as its hash), the model that wrote the
 * turn and the turn itself. The canonical JSON never holds a line break, so no field can run into
 * the next one.
 * @param {{ part: StepPart, round: number, question: string, model: string, turn: unknown }} t
 */
async function signedText(t) {
  return `starpi-research-turn/v1\n${t.part}\n${t.round}\n${await sha256Hex(t.question)}\n${t.model}\n${canonicalJson(t.turn)}`;
}

/**
 * The signer of model turns: an HMAC-SHA256 key derived with HKDF-SHA256 from a secret (the first
 * Gemini key). The key is not extractable and never leaves this object.
 * @param {string} secret
 * @returns {TurnSigner}
 */
export function createTurnSigner(secret) {
  if (typeof secret !== 'string' || !secret) throw new TypeError('createTurnSigner: a secret is needed');
  /** @type {Promise<CryptoKey>} */
  const key = crypto.subtle
    .importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey'])
    .then((base) =>
      crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('starpi/research-step'), info: encoder.encode('model-turn-signature/v1') },
        base,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['sign', 'verify'],
      ),
    );
  return {
    async sign(t) {
      return base64url(await crypto.subtle.sign('HMAC', await key, encoder.encode(await signedText(t))));
    },
    async verify(t, sig) {
      if (typeof sig !== 'string' || !SIG.test(sig)) return false;
      // crypto.subtle.verify compares in constant time.
      return crypto.subtle.verify('HMAC', await key, fromBase64url(sig), encoder.encode(await signedText(t)));
    },
  };
}

/** @type {Map<string, TurnSigner>} */
const signers = new Map();

/**
 * The signer for a secret, made once per warm instance.
 * @param {string} secret
 */
export function signerFor(secret) {
  let signer = signers.get(secret);
  if (!signer) {
    if (signers.size > 8) signers.clear();
    signer = createTurnSigner(secret);
    signers.set(secret, signer);
  }
  return signer;
}

/**
 * The function calls of a model turn, in order.
 * @param {unknown} turn
 * @returns {Array<{ name: string, id?: string, args: unknown }>}
 */
export function callsOf(turn) {
  const parts = isObject(turn) && Array.isArray(turn.parts) ? turn.parts : [];
  return parts
    .filter((p) => isObject(p) && isObject(p.functionCall))
    .map((p) => {
      const c = /** @type {Record<string, any>} */ (p.functionCall);
      return { name: typeof c.name === 'string' ? c.name : '', ...(typeof c.id === 'string' ? { id: c.id } : {}), args: c.args };
    });
}

/**
 * @param {unknown} item
 * @returns {string | null}
 */
function checkTurnItem(item) {
  if (!isObject(item) || Object.keys(item).length !== 2 || !isObject(item.turn) || typeof item.sig !== 'string' || !SIG.test(item.sig)) return 'expected { turn, sig }';
  const turn = item.turn;
  if (turn.role !== 'model' || !Array.isArray(turn.parts) || turn.parts.length === 0 || !turn.parts.every(isObject)) return 'model turn malformed';
  if (jsonBytes(turn) > STEP_LIMITS.turnBytes) return 'model turn too large';
  const calls = callsOf(turn);
  if (calls.length === 0 || calls.length > MAX_CALLS_PER_ROUND) return 'model turn without valid calls';
  if (calls.some((c) => !isSourceTool(c.name))) return 'model turn calls an unknown tool';
  return null;
}

/**
 * @param {unknown} item
 * @param {Array<{ name: string, id?: string }>} calls  the calls of the turn before it
 * @returns {string | null}
 */
function checkResultsItem(item, calls) {
  if (!isObject(item) || Object.keys(item).length !== 1 || !Array.isArray(item.results)) return 'expected { results }';
  const results = item.results;
  if (results.length !== calls.length) return 'one result per call of the model turn';
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    if (!isObject(r) || Object.keys(r).some((k) => k !== 'name' && k !== 'id' && k !== 'content')) return 'result malformed';
    if (r.name !== calls[i].name) return 'results must follow the calls in order';
    if (r.id !== undefined && (typeof r.id !== 'string' || !CALL_ID.test(r.id) || r.id !== calls[i].id)) return 'result id does not match its call';
    if (typeof r.content !== 'string' || r.content.length > STEP_LIMITS.resultChars) return `result content must be text of at most ${STEP_LIMITS.resultChars} characters`;
  }
  return null;
}

/**
 * The shape check of a step (signatures are checked by verifyHistory). A problem, or the request.
 * @param {unknown} body
 * @returns {{ ok: true, request: StepRequest } | { ok: false, problem: string }}
 */
export function checkStepRequest(body) {
  const fail = (/** @type {string} */ problem) => /** @type {const} */ ({ ok: false, problem });
  if (!isObject(body)) return fail('body must be an object');
  const extra = Object.keys(body).find((k) => !['part', 'question', 'locale', 'history', 'hints', 'focus'].includes(k));
  if (extra !== undefined) return fail(`unknown field ${extra.slice(0, 40)}`);
  if (body.part !== 'sources' && body.part !== 'web') return fail('part must be "sources" or "web"');
  if (typeof body.question !== 'string' || !body.question.trim() || body.question.length > QUESTION_CHARS) return fail(`question must have 1 to ${QUESTION_CHARS} characters`);
  if (body.locale !== 'en' && body.locale !== 'de') return fail('locale must be "en" or "de"');
  const history = body.history ?? [];
  if (!Array.isArray(history)) return fail('history must be a list');
  if (body.part === 'web' && history.length > 0) return fail('the web part is a single step');
  if (history.length % 2 !== 0) return fail('history must end with the results of its last model turn');
  if (history.length > 2 * MAX_TOOL_ROUNDS) return fail(`at most ${MAX_TOOL_ROUNDS} tool rounds`);
  for (let i = 0; i < history.length; i += 2) {
    const turnProblem = checkTurnItem(history[i]);
    if (turnProblem) return fail(`history[${i}]: ${turnProblem}`);
    const resultsProblem = checkResultsItem(history[i + 1], callsOf(history[i].turn));
    if (resultsProblem) return fail(`history[${i + 1}]: ${resultsProblem}`);
  }
  const hints = body.hints ?? [];
  if (!Array.isArray(hints) || hints.length > STEP_LIMITS.hints || !hints.every((h) => typeof h === 'string' && h.length <= STEP_LIMITS.hintChars)) return fail('hints must be a short list of short texts');
  if (body.focus !== undefined && body.focus !== null && (typeof body.focus !== 'string' || body.focus.length > STEP_LIMITS.focusChars)) return fail('focus must be a short text');
  return {
    ok: true,
    request: {
      part: body.part,
      question: body.question,
      locale: body.locale,
      history: /** @type {StepRequest['history']} */ (history),
      hints,
      focus: typeof body.focus === 'string' && body.focus ? body.focus : null,
    },
  };
}

/**
 * Index of the first model turn whose signature does not verify for this model, or -1.
 * @param {TurnSigner} signer
 * @param {StepRequest} req
 * @param {string} model
 */
export async function firstUnsigned(signer, req, model) {
  for (let i = 0; i < req.history.length; i += 2) {
    const item = /** @type {SignedTurn} */ (req.history[i]);
    const ok = await signer.verify({ part: req.part, round: i / 2 + 1, question: req.question, model, turn: item.turn }, item.sig);
    if (!ok) return i;
  }
  return -1;
}

/**
 * The generateContent body of a step.
 * @param {StepRequest} req  checked and verified
 */
export function stepBody(req) {
  /** @type {Array<Record<string, unknown>>} */
  const contents = [{ role: 'user', parts: [{ text: req.question }] }];
  for (const item of req.history) {
    if ('turn' in item) contents.push(item.turn);
    else contents.push({ role: 'user', parts: item.results.map((r) => ({ functionResponse: { name: r.name, ...(r.id ? { id: r.id } : {}), response: { result: r.content } } })) });
  }
  if (req.part === 'web') return { systemInstruction: { parts: [{ text: webPrompt(req.locale) }] }, contents, tools: [{ google_search: {} }] };
  const rounds = req.history.length / 2;
  return {
    systemInstruction: { parts: [{ text: sourcesPrompt(req.locale, { hints: req.hints, focus: req.focus }) }] },
    contents,
    tools: [{ functionDeclarations: toolDeclarations() }],
    // After the last round the model may only answer.
    toolConfig: { functionCallingConfig: { mode: rounds >= MAX_TOOL_ROUNDS ? 'NONE' : 'AUTO' } },
  };
}

/**
 * The UTF-16 offset of a UTF-8 byte offset into a text (Google counts segment offsets in bytes).
 * @param {string} text
 * @param {number} byteOffset
 */
function utf16At(text, byteOffset) {
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const code = text.codePointAt(i) ?? 0;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > byteOffset) return i;
    bytes += size;
    i += code >= 0x10000 ? 2 : 1;
  }
  return text.length;
}

/**
 * The grounding of a web answer from Gemini's groundingMetadata: http(s) sources, the grounded
 * segments as UTF-16 offsets into `text`, the queries and the search suggestions markup.
 * @param {string} text
 * @param {unknown} metadata
 * @returns {WebGrounding}
 */
export function webGrounding(text, metadata) {
  const m = isObject(metadata) ? metadata : {};
  const chunks = Array.isArray(m.groundingChunks) ? m.groundingChunks : [];
  /** @type {WebGrounding['sources']} */
  const sources = [];
  /** @type {Map<number, number>} chunk index → source index */
  const index = new Map();
  chunks.forEach((c, i) => {
    const web = isObject(c) && isObject(c.web) ? c.web : null;
    if (!web || typeof web.uri !== 'string' || !/^https?:\/\//i.test(web.uri)) return;
    index.set(i, sources.length);
    sources.push({ uri: web.uri, title: typeof web.title === 'string' ? web.title.slice(0, 300) : '' });
  });
  /** @type {WebGrounding['segments']} */
  const segments = [];
  for (const s of Array.isArray(m.groundingSupports) ? m.groundingSupports : []) {
    if (!isObject(s) || !isObject(s.segment) || !Array.isArray(s.groundingChunkIndices)) continue;
    const startByte = Number.isInteger(s.segment.startIndex) ? s.segment.startIndex : 0;
    if (!Number.isInteger(s.segment.endIndex)) continue;
    const start = utf16At(text, startByte);
    const end = utf16At(text, s.segment.endIndex);
    const refs = s.groundingChunkIndices.flatMap((/** @type {unknown} */ i) => (typeof i === 'number' && index.has(i) ? [/** @type {number} */ (index.get(i))] : []));
    if (end > start && refs.length) segments.push({ start, end, sources: refs });
  }
  const queries = (Array.isArray(m.webSearchQueries) ? m.webSearchQueries : []).filter((q) => typeof q === 'string').slice(0, 10);
  const entry = isObject(m.searchEntryPoint) ? m.searchEntryPoint.renderedContent : null;
  return { segments, sources, queries, suggestionsHtml: typeof entry === 'string' && entry.trim() ? entry : null };
}

/** An upstream failure that the route turns into a refusal. */
export class StepError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} [detail]  for the log (scrubbed there)
   */
  constructor(status, code, detail = '') {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * @typedef {object} StepDeps
 * @property {readonly string[]} keys     the pool's Gemini keys; the first one derives the signing key
 * @property {string} root                API root (fixed, or a loopback fake)
 * @property {string} model
 * @property {typeof fetch} fetch
 * @property {() => number} [now]
 * @property {number} [timeoutMs]
 * @property {(line: string) => void} [log]
 */

let rotation = 0;

/**
 * One generateContent call; the keys are tried in turn (starting with the next one each call) while
 * Google answers 429 or 5xx.
 * @param {StepDeps} deps
 * @param {Record<string, unknown>} body
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<Record<string, any>>}
 */
async function generate(deps, body, signal) {
  const keys = deps.keys;
  const start = rotation++ % keys.length;
  /** @type {StepError | null} */
  let last = null;
  for (let n = 0; n < keys.length; n += 1) {
    const key = keys[(start + n) % keys.length];
    const timeout = AbortSignal.timeout(deps.timeoutMs ?? STEP_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    /** @type {Response} */
    let res;
    try {
      res = await deps.fetch(`${deps.root}/v1beta/models/${deps.model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      if (signal?.aborted) throw new StepError(499, 'aborted');
      throw new StepError(timeout.aborted ? 504 : 502, timeout.aborted ? 'upstream_timeout' : 'upstream_unreachable', String(err));
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch (err) {
        throw new StepError(502, 'bad_response', String(err));
      }
    }
    void res.body?.cancel().catch(() => {});
    last = new StepError(res.status === 429 ? 429 : 502, res.status === 429 ? 'upstream_busy' : 'upstream_error', `status ${res.status}`);
    if (res.status !== 429 && res.status < 500) break;
  }
  throw last ?? new StepError(502, 'upstream_error');
}

/**
 * Runs one step: verifies the history, calls Gemini, and returns signed tool calls or the answer.
 * @param {StepDeps} deps
 * @param {StepRequest} req  checked by checkStepRequest
 * @param {AbortSignal} [signal]
 * @param {() => number | null} [spend]  takes one step from a budget once the history verified; a number
 *   (seconds until the budget refills) refuses the step with daily_limit_reached
 * @returns {Promise<StepResponse>}
 */
export async function runStep(deps, req, signal, spend) {
  if (!deps.keys.length) throw new StepError(503, 'research_not_configured');
  const signer = signerFor(deps.keys[0]);
  const unsigned = await firstUnsigned(signer, req, deps.model);
  if (unsigned !== -1) throw new StepError(400, 'history_not_signed', `history[${unsigned}]`);
  const retryAfterS = spend?.() ?? null;
  if (retryAfterS !== null) throw new StepError(429, 'daily_limit_reached', String(retryAfterS));
  const round = req.history.length / 2 + 1;
  const json = await generate(deps, stepBody(req), signal);
  const candidate = Array.isArray(json.candidates) && isObject(json.candidates[0]) ? json.candidates[0] : null;
  const parts = candidate && isObject(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts.filter(isObject) : [];
  const calls = callsOf({ parts });
  if (calls.length > 0) {
    if (req.part === 'web' || round > MAX_TOOL_ROUNDS) throw new StepError(502, 'bad_response', 'a function call where only an answer is allowed');
    if (calls.length > MAX_CALLS_PER_ROUND || calls.some((c) => !isSourceTool(c.name))) throw new StepError(502, 'bad_response', 'too many calls or an unknown tool');
    /** @type {ModelTurn} */
    const turn = { role: 'model', parts };
    if (jsonBytes(turn) > STEP_LIMITS.turnBytes) throw new StepError(502, 'bad_response', 'model turn too large');
    // The key travels only in a request header, so no turn can hold it; should one ever turn up,
    // the turn is refused instead of leaving the server.
    const serialized = JSON.stringify(turn);
    if (deps.keys.some((k) => serialized.includes(k))) throw new StepError(502, 'bad_response', 'model turn holds a configured key');
    const sig = await signer.sign({ part: req.part, round, question: req.question, model: deps.model, turn });
    return {
      status: 'tool_calls',
      round,
      model: deps.model,
      calls: calls.map((c) => ({ name: c.name, ...(c.id !== undefined ? { id: c.id } : {}), args: isObject(c.args) ? c.args : {} })),
      turn,
      sig,
    };
  }
  const text = parts
    .filter((p) => typeof p.text === 'string' && p.thought !== true)
    .map((p) => p.text)
    .join('');
  if (!text.trim() || text.length > STEP_LIMITS.textChars) throw new StepError(502, 'bad_response', text.trim() ? 'answer too long' : `answer without text (${String(candidate?.finishReason ?? 'none')})`);
  // The web answer stays exactly as grounded: the segment offsets point into this very text.
  return { status: 'final', round, model: deps.model, text, grounding: req.part === 'web' ? webGrounding(text, candidate?.groundingMetadata) : null };
}

/**
 * The model a site runs research steps with: STARPI_RESEARCH_MODEL when it names a model of the
 * Gemini pool, else RESEARCH_MODEL.
 * @param {Record<string, string | undefined>} env
 */
export function researchModel(env) {
  const named = (env.STARPI_RESEARCH_MODEL ?? '').trim();
  return named && isPoolModel('gemini', named) ? named : RESEARCH_MODEL;
}

/**
 * A log line without anything key-shaped.
 * @param {string} line
 */
export const scrubLine = (line) => scrubSecrets(line);
