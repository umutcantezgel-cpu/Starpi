// @ts-check
// Origin: generic infrastructure first written for a related project of the same author (MIT); re-expressed for Starpi.
//
// The web part of a research job: what a web search finds. Each round is one call with web search
// on (Gemini's google_search by default; Anthropic, OpenAI, xAI and OpenRouter search the same way
// through the AI layer, or the site's Gemini pool over POST /api/research/step). Every answer is
// brought into one shape, WebAnswer { text, segments, sources, queries, suggestionsHtml }, the
// rounds are joined, and the joined text is judged as a whole by the sentence gate in web mode:
// every number must lie inside a segment that rests on an http(s) source. One unit that fails
// withholds the whole part. A withheld part keeps only the list of sources it consulted and the
// class of the reason, never a piece of its text and never its search suggestions.
import { checkText } from '../core/gate.js';
import { MAX_PLAN_QUERIES, webPrompt } from './prompts.js';

/** @typedef {import('../ai/index.js').CompletionResult} CompletionResult */
/** @typedef {import('../ai/contract.js').AiRequest} AiRequest */
/** @typedef {import('../ai/contract.js').ProviderId} ProviderId */
/** @typedef {import('./prompts.js').ResearchLocale} ResearchLocale */
/** @typedef {import('./web-query.js').PiiKind} PiiKind */

/**
 * A web answer in one shape, whichever provider searched.
 * @typedef {object} WebAnswer
 * @property {string} text
 * @property {Array<{ start: number, end: number, sources: number[] }>} segments  UTF-16 offsets into `text`
 * @property {Array<{ uri: string, title: string }>} sources  http(s) only
 * @property {string[]} queries
 * @property {string | null} suggestionsHtml  the search suggestions Google asks apps to show
 */

/**
 * @typedef {'empty' | 'no_sources' | import('../core/gate.js').WithheldReason} WebWithheldReason
 * @typedef {{ verdict: 'released' | 'withheld', reason: WebWithheldReason | null, released: number, withheld: number }} WebVerdict
 */

/**
 * The web part as a job stores it.
 * @typedef {object} WebPart
 * @property {'running' | 'done' | 'withheld' | 'failed' | 'off' | 'cancelled'} status
 * @property {'released' | 'withheld' | null} verdict
 * @property {string} query      the exact text that went (goes) to the search
 * @property {PiiKind[]} removed what the optional stripping took out of the question
 * @property {string | null} text  released only
 * @property {{ segments: WebAnswer['segments'], queries: string[] } | null} grounding  released only
 * @property {string[] | null} suggestionsHtml  released only: the search suggestions of each round
 * @property {WebAnswer['sources']} sources  what the search consulted (also when withheld)
 * @property {number} rounds
 * @property {string | null} reason  withheld: the class of the gate's reason; failed: the error code; off: why
 * @property {{ id: string, model: string } | null} provider
 */

/** Sources a web part keeps at most. */
export const MAX_WEB_SOURCES = 20;
/** Search rounds a web part runs at most. */
export const MAX_WEB_ROUNDS = MAX_PLAN_QUERIES;

const HTTP = /^https?:\/\//i;

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A completed call of the AI layer as a WebAnswer: its citations give the sources and the grounded
 * segments, and the grounding block a Gemini answer carries gives the queries and suggestions.
 * @param {Pick<CompletionResult, 'text' | 'citations' | 'opaque'>} result
 * @returns {WebAnswer}
 */
export function webAnswerFromResult(result) {
  const text = typeof result.text === 'string' ? result.text : '';
  /** @type {WebAnswer['sources']} */
  const sources = [];
  /** @type {Map<string, number>} */
  const index = new Map();
  /** @type {Map<string, { start: number, end: number, sources: number[] }>} */
  const segments = new Map();
  for (const c of result.citations ?? []) {
    if (!c || typeof c.url !== 'string' || !HTTP.test(c.url)) continue;
    let i = index.get(c.url);
    if (i === undefined) {
      i = sources.length;
      index.set(c.url, i);
      sources.push({ uri: c.url, title: typeof c.title === 'string' ? c.title.slice(0, 300) : '' });
    }
    if (Number.isInteger(c.start) && Number.isInteger(c.end) && /** @type {number} */ (c.end) > /** @type {number} */ (c.start) && /** @type {number} */ (c.end) <= text.length) {
      const key = `${c.start}:${c.end}`;
      const seg = segments.get(key) ?? { start: /** @type {number} */ (c.start), end: /** @type {number} */ (c.end), sources: [] };
      if (!seg.sources.includes(i)) seg.sources.push(i);
      segments.set(key, seg);
    }
  }
  let queries = /** @type {string[]} */ ([]);
  /** @type {string | null} */
  let suggestionsHtml = null;
  for (const part of result.opaque ?? []) {
    const block = isObject(part) && isObject(part.block) ? part.block : null;
    if (!block || block.kind !== 'gemini-grounding') continue;
    if (Array.isArray(block.queries)) queries = block.queries.filter((/** @type {unknown} */ q) => typeof q === 'string').slice(0, 10);
    if (typeof block.searchEntryPoint === 'string' && block.searchEntryPoint.trim()) suggestionsHtml = block.searchEntryPoint;
  }
  return { text, segments: [...segments.values()].sort((a, b) => a.start - b.start), sources, queries, suggestionsHtml };
}

/**
 * A WebAnswer from a step of the site's pool (api/research/step.js), checked field by field.
 * @param {{ text?: unknown, grounding?: unknown }} step
 * @returns {WebAnswer}
 */
export function webAnswerFromStep(step) {
  const text = typeof step.text === 'string' ? step.text : '';
  const g = isObject(step.grounding) ? step.grounding : {};
  const sources = (Array.isArray(g.sources) ? g.sources : []).filter((s) => isObject(s) && typeof s.uri === 'string' && HTTP.test(s.uri)).map((s) => ({ uri: s.uri, title: typeof s.title === 'string' ? s.title.slice(0, 300) : '' }));
  const segments = (Array.isArray(g.segments) ? g.segments : [])
    .filter((s) => isObject(s) && Number.isInteger(s.start) && Number.isInteger(s.end) && s.end > s.start && s.end <= text.length && Array.isArray(s.sources))
    .map((s) => ({ start: s.start, end: s.end, sources: s.sources.filter((/** @type {unknown} */ i) => Number.isInteger(i) && /** @type {number} */ (i) >= 0 && /** @type {number} */ (i) < sources.length) }));
  const queries = (Array.isArray(g.queries) ? g.queries : []).filter((q) => typeof q === 'string').slice(0, 10);
  return { text, segments, sources, queries, suggestionsHtml: typeof g.suggestionsHtml === 'string' && g.suggestionsHtml.trim() ? g.suggestionsHtml : null };
}

/**
 * The answers of several rounds as one: texts joined by a blank line, segment offsets moved along,
 * sources merged by address (at most `maxSources`; a segment loses the sources beyond the cap, and
 * a segment with none left grounds nothing).
 * @param {readonly WebAnswer[]} answers
 * @param {number} [maxSources]
 * @returns {WebAnswer & { suggestions: string[] }}
 */
export function mergeWebAnswers(answers, maxSources = MAX_WEB_SOURCES) {
  let text = '';
  /** @type {WebAnswer['sources']} */
  const sources = [];
  /** @type {Map<string, number>} */
  const index = new Map();
  /** @type {WebAnswer['segments']} */
  const segments = [];
  /** @type {string[]} */
  const queries = [];
  /** @type {string[]} */
  const suggestions = [];
  for (const a of answers) {
    if (!a.text.trim()) continue;
    const offset = text ? text.length + 2 : 0;
    text = text ? `${text}\n\n${a.text}` : a.text;
    const map = a.sources.map((s) => {
      const known = index.get(s.uri);
      if (known !== undefined) return known;
      if (sources.length >= maxSources) return -1;
      index.set(s.uri, sources.length);
      sources.push(s);
      return sources.length - 1;
    });
    for (const seg of a.segments) {
      const refs = [...new Set(seg.sources.map((i) => map[i] ?? -1).filter((i) => i >= 0))];
      if (refs.length) segments.push({ start: seg.start + offset, end: seg.end + offset, sources: refs });
    }
    for (const q of a.queries) if (!queries.includes(q)) queries.push(q);
    if (a.suggestionsHtml) suggestions.push(a.suggestionsHtml);
  }
  return { text, segments, sources, queries, suggestionsHtml: suggestions[0] ?? null, suggestions };
}

/**
 * Judges a web answer as a whole: released only when it has text, at least one http(s) source, and
 * every unit passes the gate in web mode.
 * @param {WebAnswer} answer
 * @param {{ locale?: ResearchLocale, question?: string }} [options]
 * @returns {WebVerdict}
 */
export function judgeWeb(answer, options = {}) {
  if (!answer.text.trim()) return { verdict: 'withheld', reason: 'empty', released: 0, withheld: 0 };
  if (!answer.sources.some((s) => HTTP.test(s.uri))) return { verdict: 'withheld', reason: 'no_sources', released: 0, withheld: 0 };
  const result = checkText(answer.text, {
    mode: 'web',
    locale: options.locale ?? null,
    question: options.question,
    grounding: { segments: answer.segments, sources: answer.sources.map((s) => ({ uri: s.uri, title: s.title })) },
  });
  if (result.counts.withheld > 0) return { verdict: 'withheld', reason: result.withheld[0]?.reason ?? 'web_ungrounded', released: result.counts.released, withheld: result.counts.withheld };
  return { verdict: 'released', reason: null, released: result.counts.released, withheld: 0 };
}

/**
 * @typedef {(query: string, signal?: AbortSignal) => Promise<WebAnswer>} WebSearch
 */

/**
 * A web search with the person's own key, through the AI layer.
 * @param {{ complete: (req: AiRequest, options: { signal?: AbortSignal }) => { result: Promise<CompletionResult> }, provider: ProviderId, model: string, locale: ResearchLocale }} o
 * @returns {WebSearch}
 */
export function byokWebSearch(o) {
  return async (query, signal) => {
    const res = await o
      .complete(
        { provider: o.provider, model: o.model, system: webPrompt(o.locale), messages: [{ role: 'user', content: [{ type: 'text', text: query }] }], search: { enabled: true, maxUses: 3 }, maxOutputTokens: 1600, temperature: 0.2 },
        { signal },
      )
      .result;
    if (res.error) throw res.error;
    return webAnswerFromResult(res);
  };
}

/**
 * A web search on the site's Gemini pool.
 * @param {{ step: import('./sources-part.js').StepFn, locale: ResearchLocale }} o
 * @returns {WebSearch}
 */
export function poolWebSearch(o) {
  return async (query, signal) => {
    const res = await o.step({ part: 'web', question: query, locale: o.locale }, signal);
    if (res.status !== 'final') throw new Error('research: the web step asked for tools');
    return webAnswerFromStep(res);
  };
}

/**
 * Runs the web part: one round per query (the question as typed first, then the plan's queries),
 * at most MAX_WEB_ROUNDS rounds, no new round once MAX_WEB_SOURCES sources are in, then judges the
 * joined answer as a whole.
 * @param {{ search: WebSearch, query: string, removed?: PiiKind[], queries?: readonly string[], locale: ResearchLocale, provider: { id: string, model: string } | null, signal?: AbortSignal, onRound?: (round: number, sources: number) => void }} o
 * @returns {Promise<WebPart>}
 */
export async function runWebPart(o) {
  const rounds = [o.query, ...(o.queries ?? []).filter((q) => q && q.trim().toLowerCase() !== o.query.trim().toLowerCase())].slice(0, MAX_WEB_ROUNDS);
  /** @type {WebAnswer[]} */
  const answers = [];
  let seen = 0;
  for (const [i, q] of rounds.entries()) {
    if (o.signal?.aborted) throw o.signal.reason instanceof Error ? o.signal.reason : new DOMException('Aborted', 'AbortError');
    if (seen >= MAX_WEB_SOURCES) break;
    answers.push(await o.search(q, o.signal));
    seen = mergeWebAnswers(answers).sources.length;
    o.onRound?.(i + 1, seen);
  }
  const merged = mergeWebAnswers(answers);
  const verdict = judgeWeb(merged, { locale: o.locale, question: o.query });
  const base = { query: o.query, removed: o.removed ?? [], sources: merged.sources, rounds: answers.length, provider: o.provider };
  if (verdict.verdict === 'released') {
    return { ...base, status: 'done', verdict: 'released', text: merged.text, grounding: { segments: merged.segments, queries: merged.queries }, suggestionsHtml: merged.suggestions, reason: null };
  }
  return { ...base, status: 'withheld', verdict: 'withheld', text: null, grounding: null, suggestionsHtml: null, reason: verdict.reason };
}

/**
 * Checks a stored web part again before it is shown: released text is judged once more against
 * its stored grounding; when it no longer passes, it is shown as withheld.
 * @param {WebPart} part
 * @param {{ locale?: ResearchLocale }} [options]
 * @returns {WebPart}
 */
export function recheckWeb(part, options = {}) {
  if (part.status !== 'done' || typeof part.text !== 'string' || !part.grounding) return part;
  const verdict = judgeWeb({ text: part.text, segments: part.grounding.segments ?? [], sources: part.sources ?? [], queries: [], suggestionsHtml: null }, { locale: options.locale, question: part.query });
  if (verdict.verdict === 'released') return part;
  return { ...part, status: 'withheld', verdict: 'withheld', text: null, grounding: null, suggestionsHtml: null, reason: verdict.reason };
}
