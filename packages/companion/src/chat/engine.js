// @ts-check
// The answer engine behind /v1/ask and /v1/chat. One turn:
//  1. sources (source mode): passages of documents, notes and feed readings (sources.js); the data
//     class of the turn becomes the strictest of the request, the conversation and every source;
//  2. tools (chat only, when asked for): the approved connector tools the class allows; their
//     result class raises the turn's class before the first model call, so every round of the turn
//     goes to the same kind of model;
//  3. the model through the kernel's router, streamed into the sentence gate of @starpi/core in
//     the turn's mode (`sources` or `free`): only released units reach the caller, as they are
//     released; a withdrawn stream (`reset`) withdraws what was shown;
//  4. a tool call (a reply starting with CALL) is never shown: the tool runs (with an approval
//     when its policy or an earlier result asks for one), its result becomes a source [Tn] and the
//     model is asked again, at most MAX_TOOL_CALLS times;
//  5. a record in the audit chain: mode, class, model, counts and the hash of the released text,
//     never the text itself.
// A template answer of the router (no model, secret content, a resting model, a refusal) passes the
// gate as well, so every answer has the same shape.
import { createHash, randomUUID } from 'node:crypto';
import { createSentenceGate } from '@starpi/core';
import { strictest } from '../contracts/data-classes.js';
import { codeOf } from '../lib/errors.js';
import { clip } from '../setup/kit.js';
import { CALL_PREFIX, parseToolCall, systemMessage, toolResultBlock } from './rules.js';
import { gatherSources } from './sources.js';

export const MAX_TOOL_CALLS = 4;
export const TOOL_RESULT_CHARS = 8000;
export const MODES = Object.freeze(['sources', 'free']);

/**
 * @typedef {object} AnswerRequest
 * @property {string} question
 * @property {'sources' | 'free'} mode
 * @property {import('../contracts/data-classes.js').DataClass} dataClass
 * @property {Array<{ question: string, answer: string }>} [history]
 * @property {readonly string[] | null} [documents]
 * @property {boolean} [notes]
 * @property {boolean} [feeds]
 * @property {boolean} [tools]
 * @property {number} [maxTokens]
 * @property {string} [subject]   what the audit record names (a conversation id); a new id when left out
 */

/**
 * @typedef {object} AnswerUnit
 * @property {string} text
 * @property {string[]} cites     labels of the sources the unit cites
 * @property {string} kind
 */

/**
 * @typedef {object} Answer
 * @property {string} id
 * @property {string} text
 * @property {AnswerUnit[]} units
 * @property {Array<{ reason: string, kind: string }>} withheld
 * @property {Array<{ label: string, kind: string, title: string, dataClass: string, ref: unknown, excerpt: string }>} citations
 * @property {Array<{ label: string, kind: string, title: string, dataClass: string, ref: unknown }>} sources
 * @property {Array<{ tool: string, outcome: string }>} tools
 * @property {'sources' | 'free'} mode
 * @property {import('../contracts/data-classes.js').DataClass} dataClass
 * @property {string} brain
 * @property {string | null} model
 * @property {string} locality
 * @property {'model' | 'template'} source
 * @property {string | null} notice
 * @property {{ released: number, withheld: number, reasons: Record<string, number> }} counts
 */

/**
 * The released units joined as they stood in the streamed text: a blank line stays a paragraph
 * break, a line break a line break, anything else one space.
 * @param {string} raw
 * @param {Array<{ text: string, start: number, end: number }>} units
 */
export function joinUnits(raw, units) {
  let out = '';
  let previous = -1;
  for (const u of units) {
    if (out) {
      const between = raw.slice(previous, u.start);
      out += /\n\s*\n/.test(between) ? '\n\n' : between.includes('\n') ? '\n' : ' ';
    }
    out += u.text;
    previous = u.end;
  }
  return out;
}

/**
 * @param {object} deps
 * @param {import('../setup/hub.js').Hub} deps.hub
 * @param {import('../brain/router.js').BrainRouter} deps.router
 * @param {{ append(entry: { kind: string, subject?: string, actor?: string, details?: Record<string, unknown> }): unknown }} deps.audit
 * @param {string} deps.auditKind          e.g. 'chat.answered'
 * @param {import('../lib/clock.js').Clock} deps.clock
 * @param {string} deps.timeZone
 * @param {import('../lib/log.js').Logger} [deps.log]
 */
export function createAnswerEngine({ hub, router, audit, auditKind, clock, timeZone, log = () => {} }) {
  /** @param {number} ms */
  const localTime = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'full', timeStyle: 'short' }).format(new Date(ms));

  /**
   * Answers one turn.
   * @param {AnswerRequest} req
   * @param {{ signal?: AbortSignal, emit?: (event: string, data: unknown) => void, actor?: string }} [options]
   * @returns {Promise<Answer>}
   */
  async function answer(req, { signal = new AbortController().signal, emit = () => {}, actor = 'companion' } = {}) {
    const id = randomUUID();
    const { question, mode } = req;
    let dataClass = req.dataClass;
    const sources = mode === 'sources' && dataClass !== 'secret'
      ? await gatherSources(hub, question, { maxClass: 'sensitive', documents: req.documents ?? null, notes: req.notes !== false, feeds: req.feeds !== false, signal, log })
      : [];
    for (const s of sources) dataClass = strictest(dataClass, s.dataClass);
    const toolService = req.tools && dataClass !== 'secret' ? hub.get('tools') : null;
    const offered = toolService ? toolService.offer(dataClass) : [];
    for (const t of offered) dataClass = strictest(dataClass, t.resultClass);
    emit('sources', { mode, dataClass, sources: sources.map(publicSource), tools: offered.map((t) => t.name) });

    /** @type {import('./sources.js').AnswerSource[]} */
    const toolSources = [];
    /** @type {Array<{ tool: string, outcome: string }>} */
    const toolLog = [];
    /** @type {import('../brain/contract.js').BrainMessage[]} */
    const messages = [{ role: 'system', content: systemMessage({ mode, sources, tools: offered, now: localTime(clock.now()), timeZone }) }];
    for (const turn of req.history ?? []) messages.push({ role: 'user', content: turn.question }, { role: 'assistant', content: turn.answer });
    messages.push({ role: 'user', content: question });

    /** @type {ReturnType<typeof createSentenceGate> | null} */
    let gate = null;
    /** @type {import('./sources.js').AnswerSource[]} */
    let gateSources = [];
    let raw = '';
    /** @type {Array<AnswerUnit & { start: number, end: number }>} */
    let units = [];

    const openGate = () => {
      gateSources = [...sources, ...toolSources];
      raw = '';
      units = [];
      gate = createSentenceGate({ mode, question, sources: gateSources.map((s) => ({ label: s.label, kind: s.kind, text: s.text })) });
      return gate;
    };
    /** @param {Array<{ text: string, cites: number[], kind: string, start: number, end: number }>} released */
    const take = (released) => {
      for (const u of released) {
        const unit = { text: u.text, cites: u.cites.map((i) => gateSources[i]?.label ?? '').filter(Boolean), kind: u.kind, start: u.start, end: u.end };
        units.push(unit);
        emit('unit', { text: unit.text, cites: unit.cites, kind: unit.kind });
      }
    };
    /** @param {string} delta */
    const feed = (delta) => {
      const g = gate ?? openGate();
      raw += delta;
      take(g.push(delta));
    };
    const withdraw = () => {
      if (!gate) return;
      gate.abort();
      gate = null;
      if (units.length > 0) emit('reset', { withdrawn: units.length });
      units = [];
      raw = '';
    };

    let calls = 0;
    /** @type {import('../brain/router.js').BrainResult} */
    let result;
    for (;;) {
      const mayCall = offered.length > 0 && calls < MAX_TOOL_CALLS;
      /** @type {'answer' | 'call' | null} */
      let decided = mayCall ? null : 'answer';
      let head = '';
      let reply = '';
      result = await router.complete(
        { messages, dataClass, maxTokens: req.maxTokens, purpose: auditKind },
        {
          signal,
          onEvent(event) {
            if (event.type === 'reset') {
              withdraw();
              decided = mayCall ? null : 'answer';
              head = '';
              reply = '';
              return;
            }
            if (event.type !== 'text') return;
            reply += event.text;
            if (decided === 'answer') return feed(event.text);
            if (decided === 'call') return;
            head += event.text;
            const start = head.trimStart();
            if (start.length > CALL_PREFIX.length || start.includes('\n')) {
              decided = start.startsWith(`${CALL_PREFIX} `) || start.startsWith(`${CALL_PREFIX}{`) ? 'call' : 'answer';
              if (decided === 'answer') feed(head);
            }
          },
        },
      );
      if (result.source === 'template') {
        // The template never streamed; whatever did is withdrawn and the template is shown instead.
        withdraw();
        openGate();
        feed(result.text);
        break;
      }
      if (decided === null) {
        decided = parseToolCall(head) ? 'call' : 'answer';
        if (decided === 'answer') feed(head);
      }
      if (decided !== 'call') break;

      calls += 1;
      const call = parseToolCall(reply);
      const label = `[T${toolSources.length + 1}]`;
      /** @type {{ text?: string, error?: string }} */
      let outcome;
      const name = call && 'tool' in call ? call.tool : 'unknown';
      if (!call || 'invalid' in call) outcome = { error: 'the call could not be read' };
      else if (!toolService || !offered.some((t) => t.name === call.tool)) outcome = { error: 'no such tool is offered' };
      else {
        emit('tool', { tool: call.tool, state: 'calling' });
        try {
          // After a first result the context holds outside data: every later call needs a person's approval.
          const r = await toolService.call(call.tool, call.arguments, { signal, tainted: calls > 1, onApproval: (approval) => emit('approval', approval) });
          outcome = r.isError ? { error: clip(r.text, 300) || 'the tool reported an error' } : { text: clip(r.text, TOOL_RESULT_CHARS) };
        } catch (err) {
          if (signal.aborted) throw err;
          outcome = { error: codeOf(err) };
        }
        emit('tool', { tool: call.tool, state: outcome.error ? 'failed' : 'done', code: outcome.error ? (/^[a-z_]+$/.test(outcome.error) ? outcome.error : 'tool_error') : null });
      }
      toolLog.push({ tool: name, outcome: outcome.error ? (/^[a-z_]+$/.test(outcome.error) ? outcome.error : 'tool_error') : 'done' });
      if (outcome.text !== undefined) toolSources.push({ label, kind: 'tool', title: name, text: outcome.text, dataClass, ref: { type: 'tool', tool: name } });
      messages.push({ role: 'assistant', content: reply.trim() });
      messages.push({ role: 'user', content: `${toolResultBlock({ label, tool: name, text: outcome.text ?? '', error: outcome.error ?? null })}${calls >= MAX_TOOL_CALLS ? '\n\nNo more tool calls are possible in this turn; answer now.' : ''}` });
    }

    const end = /** @type {ReturnType<typeof createSentenceGate>} */ (gate ?? openGate()).end();
    take(end.released);
    const text = joinUnits(raw, units);
    const allSources = [...sources, ...toolSources];
    const cited = new Set(units.flatMap((u) => u.cites));
    /** @type {Answer} */
    const out = {
      id,
      text,
      units: units.map((u) => ({ text: u.text, cites: u.cites, kind: u.kind })),
      withheld: end.withheld.map((w) => ({ reason: w.reason, kind: w.kind })),
      citations: allSources.filter((s) => cited.has(s.label)).map((s) => ({ ...publicSource(s), excerpt: s.text })),
      sources: allSources.map(publicSource),
      tools: toolLog,
      mode,
      dataClass,
      brain: result.brain,
      model: result.model,
      locality: result.locality,
      source: result.source,
      notice: result.notice,
      counts: { released: end.counts.released, withheld: end.counts.withheld, reasons: /** @type {Record<string, number>} */ (end.counts.reasons) },
    };
    audit.append({
      kind: auditKind,
      subject: req.subject ?? id,
      actor,
      details: {
        answer: id,
        mode,
        dataClass,
        brain: out.brain,
        locality: out.locality,
        source: out.source,
        notice: out.notice,
        released: out.counts.released,
        withheld: out.counts.withheld,
        sources: allSources.length,
        tools: toolLog.length,
        sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      },
    });
    return out;
  }

  return { answer };
}

/** @param {import('./sources.js').AnswerSource} s */
function publicSource(s) {
  return { label: s.label, kind: s.kind, title: s.title, dataClass: s.dataClass, ref: s.ref };
}

/** @typedef {ReturnType<typeof createAnswerEngine>} AnswerEngine */
