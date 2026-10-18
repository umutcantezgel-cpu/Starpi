// @ts-check
// The tool loop. An answer that stopped for tool calls goes on here: each call is looked up, its
// arguments are checked against the tool's schema, the approval gate decides (approval.js), the tool
// runs with a time limit, and its output goes back to the model quoted as untrusted data. Then the
// model is asked again with the tools still offered. After MAX_TOOL_ROUNDS rounds of tool calls the
// model is asked once more with toolChoice 'none' and must answer with what it has.
//
// The answer the user sees joins the text of every round. Pages a web tool returned become the
// answer's citations, images a tool made become its images. The provider state kept for replay is
// the last round's only: earlier rounds hold tool calls whose results are not stored with the answer.
import { complete as completeCall } from '../index.js';
import { quoteToolResult, validateArgs } from './registry.js';

/** @typedef {import('../contract.js').AiRequest} AiRequest */
/** @typedef {import('../contract.js').Message} Message */
/** @typedef {import('../contract.js').Part} Part */
/** @typedef {import('../index.js').CompletionResult} CompletionResult */
/** @typedef {import('../index.js').ToolCallResult} ToolCallResult */
/** @typedef {import('../stream.js').Adapter} Adapter */
/** @typedef {import('./registry.js').ToolRegistry} ToolRegistry */
/** @typedef {import('./registry.js').SideEffect} SideEffect */
/** @typedef {import('./registry.js').ToolOutput} ToolOutput */
/** @typedef {import('./approval.js').ApprovalGate} ApprovalGate */
/** @typedef {import('./approval.js').ApprovalRequest} ApprovalRequest */
/** @typedef {import('./approval.js').ApprovalAnswer} ApprovalAnswer */

/** Rounds of tool calls per answer; the next call must answer without tools. */
export const MAX_TOOL_ROUNDS = 8;
/** Calls run per round; further calls of the same round get an error result. */
export const MAX_CALLS_PER_ROUND = 8;
/** How long one tool may take. */
export const TOOL_TIMEOUT_MS = 30_000;
/** Server-side pauses (Anthropic pause_turn) continued per answer. */
const MAX_PAUSES = 2;
/** Citations an answer keeps from web tools. */
const MAX_TOOL_CITATIONS = 8;

/**
 * @typedef {'done' | 'failed' | 'denied' | 'forbidden' | 'invalid' | 'unknown' | 'skipped'} CallStatus
 */

/**
 * @typedef {object} ToolCallRecord
 * @property {string} id
 * @property {string} name
 * @property {Record<string, unknown> | null} args
 * @property {CallStatus} status
 * @property {SideEffect | null} effect
 * @property {number} round
 */

/**
 * What the loop reports while it runs (the chat shows it in the answer).
 * @typedef {object} LoopObserver
 * @property {(text: string) => void} [onText]   the answer's text so far (all rounds)
 * @property {(call: ToolCallResult, title: string) => void} [onToolStart]
 * @property {(call: ToolCallResult, title: string, status: CallStatus) => void} [onToolEnd]
 * @property {(rounds: number) => void} [onLimit]
 */

/**
 * @typedef {object} LoopOptions
 * @property {AiRequest} request              the first round's request (offering the tools)
 * @property {CompletionResult} [first]        the first round's result, when the caller ran it already
 * @property {ToolRegistry} registry
 * @property {ApprovalGate} gate
 * @property {AbortSignal} signal
 * @property {(req: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalAnswer>} [ask]
 * @property {LoopObserver} [observer]
 * @property {typeof completeCall} [complete]
 * @property {(req: AiRequest) => Adapter | undefined} [adapterFor]
 * @property {string} [locale]
 * @property {number} [maxRounds]
 * @property {number} [toolTimeoutMs]
 */

/**
 * @typedef {object} LoopResult
 * @property {CompletionResult} result   the answer over all rounds
 * @property {number} rounds             rounds of tool calls that ran
 * @property {ToolCallRecord[]} calls
 * @property {boolean} limited           the round limit ended the tool calls
 * @property {Message[]} messages        the conversation of the last call
 */

/**
 * Runs `promise` with a time limit; the tool's own signal aborts at the limit too.
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} run
 * @param {AbortSignal} outer
 * @param {number} ms
 * @returns {Promise<T>}
 */
async function withTimeout(run, outer, ms) {
  const controller = new AbortController();
  const abort = () => controller.abort(outer.reason);
  outer.addEventListener('abort', abort, { once: true });
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new DOMException('The tool took too long', 'TimeoutError'));
          reject(new DOMException('The tool took too long', 'TimeoutError'));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    outer.removeEventListener('abort', abort);
  }
}

/**
 * An error result for the model (quoted like any tool output).
 * @param {string} name
 * @param {string} error
 * @param {Record<string, unknown>} [extra]
 */
function errorResult(name, error, extra = {}) {
  return quoteToolResult(name, JSON.stringify({ error, ...extra }));
}

/**
 * The assistant turn of a round, as the next call replays it: its text, its tool calls and its
 * provider state.
 * @param {CompletionResult} res
 * @param {ToolCallResult[]} calls
 * @returns {Message}
 */
function assistantTurn(res, calls) {
  /** @type {Part[]} */
  const content = [];
  if (res.text) content.push({ type: 'text', text: res.text });
  for (const c of calls) content.push({ type: 'tool_call', id: c.id, name: c.name, args: c.args ?? {} });
  content.push(...res.opaque);
  if (!content.length) content.push({ type: 'text', text: '' });
  return { role: 'assistant', content };
}

/**
 * Runs the tool loop (see the file comment).
 * @param {LoopOptions} o
 * @returns {Promise<LoopResult>}
 */
export async function runToolLoop(o) {
  const complete = o.complete ?? completeCall;
  const maxRounds = o.maxRounds ?? MAX_TOOL_ROUNDS;
  const timeoutMs = o.toolTimeoutMs ?? TOOL_TIMEOUT_MS;
  const observer = o.observer ?? {};
  const locale = o.locale ?? 'en';
  /** @type {Message[]} */
  let messages = [...o.request.messages];
  /** @type {string[]} */
  const texts = [];
  /** @type {string[]} */
  const reasonings = [];
  /** @type {CompletionResult['citations']} */
  const citations = [];
  /** @type {CompletionResult['images']} */
  const images = [];
  /** @type {Array<{ url: string, title: string, snippet?: string }>} */
  const sources = [];
  /** @type {ToolCallRecord[]} */
  const records = [];
  /** @type {CompletionResult['usage']} */
  let usage = null;
  let rounds = 0;
  let pauses = 0;
  let limited = false;

  const shown = () => texts.filter(Boolean).join('\n\n');
  /** @param {CompletionResult} res */
  const take = (res) => {
    const shift = shown().length + (shown() && res.text ? 2 : 0);
    if (res.text) texts.push(res.text);
    if (res.reasoning) reasonings.push(res.reasoning);
    for (const c of res.citations) citations.push({ ...c, ...(c.start !== undefined ? { start: c.start + shift } : {}), ...(c.end !== undefined ? { end: c.end + shift } : {}) });
    images.push(...res.images);
    if (res.usage) {
      const u = usage ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0 };
      usage = { input: u.input + res.usage.input, output: u.output + res.usage.output, reasoning: u.reasoning + res.usage.reasoning, cacheRead: u.cacheRead + res.usage.cacheRead };
      if (u.costUsd !== undefined || res.usage.costUsd !== undefined) usage.costUsd = (u.costUsd ?? 0) + (res.usage.costUsd ?? 0);
    }
  };
  /**
   * One model call; its text streams to the observer after the text of the earlier rounds.
   * @param {AiRequest} req
   * @returns {Promise<CompletionResult>}
   */
  const ask = async (req) => {
    const before = shown();
    const call = complete(req, { signal: o.signal, adapter: o.adapterFor?.(req) });
    let text = '';
    for await (const ev of call.events) {
      if (ev.type !== 'text') continue;
      text += ev.delta;
      observer.onText?.(before && text ? `${before}\n\n${text}` : before || text);
    }
    return call.result;
  };

  /**
   * Runs one call of the model: lookup, arguments, approval, the tool, its quoted output.
   * @param {ToolCallResult} c
   * @param {number} round
   * @returns {Promise<Part>}
   */
  const runCall = async (c, round) => {
    const def = o.registry.get(c.name);
    /** @param {CallStatus} status @param {string} content @param {boolean} isError */
    const done = (status, content, isError) => {
      records.push({ id: c.id, name: c.name, args: c.args, status, effect: def?.effect ?? null, round });
      return /** @type {Part} */ ({ type: 'tool_result', id: c.id, content, ...(isError ? { isError: true } : {}) });
    };
    if (!def) return done('unknown', errorResult(c.name, 'there is no tool of this name'), true);
    if (c.args === null) return done('invalid', errorResult(c.name, 'the arguments were not valid JSON'), true);
    const problems = validateArgs(def.schema, c.args);
    if (problems.length) return done('invalid', errorResult(c.name, 'the arguments do not fit the tool', { problems: problems.slice(0, 8) }), true);
    const title = def.server?.tool ?? def.name;
    const decision = await o.gate.decide(def, c.args, o.signal, { ask: o.ask });
    if (!decision.ok) {
      const status = decision.reason === 'forbidden' ? 'forbidden' : 'denied';
      observer.onToolEnd?.(c, title, status);
      return done(status, errorResult(c.name, status === 'forbidden' ? 'this tool may not be used' : 'the user did not allow this call; do not try it again'), true);
    }
    observer.onToolStart?.(c, title);
    /** @type {ToolOutput} */
    let out;
    try {
      const args = /** @type {Record<string, unknown>} */ (c.args);
      out = await withTimeout((signal) => def.run(args, { signal, locale }), o.signal, timeoutMs);
    } catch (err) {
      const name = err && typeof err === 'object' ? /** @type {{ name?: unknown }} */ (err).name : '';
      out = { content: JSON.stringify({ error: name === 'TimeoutError' ? 'the tool took too long' : 'the tool failed' }), isError: true };
    }
    if (out.sources) for (const s of out.sources) if (!sources.some((x) => x.url === s.url)) sources.push(s);
    if (out.images) images.push(...out.images);
    const status = out.isError ? 'failed' : 'done';
    observer.onToolEnd?.(c, title, status);
    return done(status, quoteToolResult(def.name, out.content), Boolean(out.isError));
  };

  let req = o.request;
  let res = o.first ?? (await ask(req));
  for (;;) {
    take(res);
    if (res.error || o.signal.aborted) break;
    if (res.stopReason === 'pause' && pauses < MAX_PAUSES) {
      // The server paused a long turn: send it back with what it wrote, and it goes on.
      pauses += 1;
      messages = [...messages, assistantTurn(res, [])];
      req = { ...req, messages };
      res = await ask(req);
      continue;
    }
    const calls = res.toolCalls.filter((c) => c.id && c.name);
    if (res.stopReason !== 'tool_call' || !calls.length) break;
    if (rounds >= maxRounds) {
      limited = true;
      break;
    }
    rounds += 1;
    messages = [...messages, assistantTurn(res, calls)];
    /** @type {Part[]} */
    const results = [];
    for (const [i, c] of calls.entries()) {
      if (o.signal.aborted) break;
      if (i >= MAX_CALLS_PER_ROUND) {
        records.push({ id: c.id, name: c.name, args: c.args, status: 'skipped', effect: null, round: rounds });
        results.push({ type: 'tool_result', id: c.id, content: errorResult(c.name, 'too many calls in one round'), isError: true });
        continue;
      }
      results.push(await runCall(c, rounds));
    }
    if (o.signal.aborted) break;
    messages = [...messages, { role: 'tool', content: results }];
    const last = rounds >= maxRounds;
    if (last) {
      limited = true;
      observer.onLimit?.(rounds);
    }
    req = { ...o.request, messages, toolChoice: last ? 'none' : (o.request.toolChoice ?? 'auto') };
    res = await ask(req);
  }

  // Pages of web tools: those the answer names first, then the others.
  const text = shown();
  const named = sources.filter((s) => text.includes(s.url) || text.includes(hostOf(s.url)));
  const ordered = [...named, ...sources.filter((s) => !named.includes(s))];
  for (const s of ordered.slice(0, MAX_TOOL_CITATIONS)) {
    if (citations.some((c) => c.url === s.url)) continue;
    citations.push({ url: s.url, title: s.title, ...(s.snippet ? { citedText: s.snippet } : {}) });
  }
  /** @type {CompletionResult} */
  const result = {
    ...res,
    text,
    reasoning: reasonings.join('\n\n'),
    toolCalls: records.map((r) => ({ id: r.id, name: r.name, args: r.args, argsText: r.args ? JSON.stringify(r.args) : '' })),
    citations,
    images,
    usage,
  };
  return { result, rounds, calls: records, limited, messages };
}

/**
 * The host name of an address ('' when it is none).
 * @param {string} url
 */
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '\u0000';
  }
}
