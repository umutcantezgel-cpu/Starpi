// @ts-check
// Origin: generic infrastructure first written for a related project of the same author (MIT); re-expressed for Starpi.
//
// The sources part of a research job: what the person's own documents say. A model searches them
// with three read-only tools (prompts.js) and answers with a citation label on every statement:
//   - with the person's own key, the AI layer's tool calls run here in a loop (runToolLoop), on any
//     provider whose model takes tools;
//   - on the site's Gemini pool, the loop runs over POST /api/research/step (runSignedLoop): the
//     browser runs the tools and sends every signed model turn back unchanged with the results;
//   - without any model, the best matching sentences of the excerpts are quoted (quoteExcerpts).
// Whatever wrote the text, it then goes through the sentence gate in sources mode (gateSources):
// a sentence is kept only when every number in it appears with the same value in an excerpt it
// cites; the others are counted, never shown. The kept sentences carry their labels as
// [Doc: name, Chunk: n], and a stored part can be checked again (recheckSources) before it is shown.
//
// The tools see the documents through SourceBackends (workspace and library search, the document
// names), so this module has no DOM and runs in tests with fakes.
import { checkText } from '../core/gate.js';
import { citationLabel, labelName } from '../core/labels.js';
import { safeSlice, splitSentences } from '../core/sentences.js';
import { defuseFences, tokenize } from '../retrieval.js';
import { MAX_CALLS_PER_ROUND, MAX_SEARCH_RESULTS, MAX_TOOL_ROUNDS, sectionOfHeading, SECTION_HEADINGS, SECTION_IDS, SOURCE_TOOL_SPECS, sourcesPrompt } from './prompts.js';

/** @typedef {import('../ai/contract.js').Message} Message */
/** @typedef {import('../ai/contract.js').Part} Part */
/** @typedef {import('../ai/contract.js').AiRequest} AiRequest */
/** @typedef {import('../ai/index.js').CompletionResult} CompletionResult */
/** @typedef {import('../supabase.js').KnowledgeHit} KnowledgeHit */
/** @typedef {import('./prompts.js').ResearchLocale} ResearchLocale */
/** @typedef {import('./prompts.js').SectionId} SectionId */
/** @typedef {import('../core/gate.js').WithheldReason} WithheldReason */

/**
 * An excerpt handed to the model, as the report, the gate and the receipt keep it.
 * @typedef {object} SourceExcerpt
 * @property {string} label       "[Doc: name, Chunk: n]"
 * @property {string} doc         document name as used in the label
 * @property {string} heading
 * @property {'workspace' | 'knowledge'} source
 * @property {string} text        the excerpt (up to FULL_CHARS)
 * @property {boolean} truncated  the passage went on beyond `text`
 * @property {'partial' | 'full'} delivered  the model saw a preview, or the whole excerpt (read_excerpt)
 * @property {number} deliveredChars  how many leading characters of `text` the model saw
 * @property {string | null} documentId  library document id, or the workspace document id
 * @property {{ docId: string, chunkIndex: number, start: number, end: number } | null} span
 */

/**
 * Where the tools read from. `search` returns workspace and library hits together (a workspace hit
 * carries `workspace`); `documents` names what can be searched.
 * @typedef {object} SourceBackends
 * @property {(query: string, k: number) => Promise<KnowledgeHit[]>} search
 * @property {() => Promise<string[]>} documents
 */

/**
 * @typedef {object} ToolSession
 * @property {readonly import('../ai/contract.js').ToolSpec[]} specs
 * @property {(name: string, args: unknown) => Promise<{ content: string, isError: boolean }>} call
 * @property {() => SourceExcerpt[]} excerpts  every excerpt handed to the model, in order of first appearance
 * @property {() => number} calls
 */

/** @typedef {{ text: string, cites: string[], kind: 'sentence' | 'item' | 'row' | 'code' }} KeptSentence */

/**
 * The checked sources part.
 * @typedef {object} GatedSources
 * @property {Record<SectionId, KeptSentence[]>} sections
 * @property {number} released
 * @property {number} withheld
 * @property {Partial<Record<WithheldReason, number>>} reasons
 * @property {string[]} cited  labels the kept sentences cite, in order of first citation
 */

/** Characters of an excerpt search_sources shows; read_excerpt shows up to FULL_CHARS. */
export const PREVIEW_CHARS = 700;
export const FULL_CHARS = 4000;
/** Excerpts one job keeps at most (the receipt takes 64 citations). */
export const MAX_EXCERPTS = 40;
/** Document names list_documents returns at most. */
const MAX_DOCUMENT_NAMES = 100;

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {});

/**
 * The tools of the sources part over a set of backends. Labels stay stable for the whole job: a
 * workspace chunk keeps its own number, a library section is numbered per document in the order it
 * first appears. read_excerpt only opens an excerpt a search returned.
 * @param {SourceBackends} backends
 * @param {{ focus?: string | null }} [options]  focus: hits of this document come first
 * @returns {ToolSession}
 */
export function createSourceTools(backends, options = {}) {
  /** @type {Map<string, SourceExcerpt>} by label */
  const byLabel = new Map();
  /** @type {Map<string, string>} hit identity → label */
  const byHit = new Map();
  /** @type {Map<string, number>} library sections numbered per document */
  const perDoc = new Map();
  let count = 0;
  const focus = options.focus ? labelName(options.focus).toLowerCase() : null;

  /**
   * @param {KnowledgeHit} hit
   * @returns {SourceExcerpt | null}
   */
  function remember(hit) {
    const doc = labelName(hit.documentTitle || '');
    const identity = hit.workspace ? `w:${hit.workspace.docId}:${hit.workspace.chunkIndex}` : `k:${hit.documentId ?? doc}:${hit.heading}:${hit.content.slice(0, 200)}`;
    const known = byHit.get(identity);
    if (known) return byLabel.get(known) ?? null;
    if (byLabel.size >= MAX_EXCERPTS) return null;
    let chunk;
    if (hit.workspace) chunk = hit.workspace.chunkIndex + 1;
    else {
      chunk = (perDoc.get(doc) ?? 0) + 1;
      perDoc.set(doc, chunk);
    }
    let label = citationLabel(doc, chunk);
    // The same name from the workspace and the library: keep labels unique.
    while (byLabel.has(label)) {
      chunk += 1000;
      label = citationLabel(doc, chunk);
    }
    const truncated = hit.content.length > FULL_CHARS;
    const text = truncated ? safeSlice(hit.content, FULL_CHARS) : hit.content;
    /** @type {SourceExcerpt} */
    const excerpt = {
      label,
      doc,
      heading: hit.heading.replace(/^#+\s*/, ''),
      source: hit.workspace ? 'workspace' : 'knowledge',
      text,
      truncated,
      delivered: text.length <= PREVIEW_CHARS ? 'full' : 'partial',
      deliveredChars: Math.min(text.length, PREVIEW_CHARS),
      documentId: hit.workspace ? hit.workspace.docId : (hit.documentId ?? null),
      span: hit.workspace ? { docId: hit.workspace.docId, chunkIndex: hit.workspace.chunkIndex, start: hit.workspace.start, end: hit.workspace.end } : null,
    };
    byLabel.set(label, excerpt);
    byHit.set(identity, label);
    return excerpt;
  }

  /** @param {SourceExcerpt} e @param {boolean} whole */
  const shown = (e, whole) => {
    const text = whole ? e.text : e.text.slice(0, e.deliveredChars);
    return { label: e.label, document: e.doc, ...(e.heading ? { heading: e.heading } : {}), text: defuseFences(text), complete: whole ? !e.truncated : e.delivered === 'full' && !e.truncated };
  };

  /** @param {unknown} value */
  const json = (value) => JSON.stringify(value);
  const error = (/** @type {string} */ message) => ({ content: json({ error: message }), isError: true });

  return {
    specs: SOURCE_TOOL_SPECS,
    calls: () => count,
    excerpts: () => [...byLabel.values()],
    async call(name, args) {
      count += 1;
      const a = record(args);
      switch (name) {
        case 'search_sources': {
          const query = typeof a.query === 'string' ? a.query.trim().slice(0, 300) : '';
          if (!query) return error('query is required');
          const k = Number.isInteger(a.k) ? Math.min(MAX_SEARCH_RESULTS, Math.max(1, /** @type {number} */ (a.k))) : 5;
          let hits = await backends.search(query, k);
          if (focus) hits = [...hits.filter((h) => labelName(h.documentTitle).toLowerCase() === focus), ...hits.filter((h) => labelName(h.documentTitle).toLowerCase() !== focus)];
          const excerpts = hits
            .slice(0, k)
            .map(remember)
            .filter((e) => e !== null);
          return { content: json(excerpts.length ? { excerpts: excerpts.map((e) => shown(e, false)) } : { excerpts: [], note: 'Nothing matched. Try other words.' }), isError: false };
        }
        case 'read_excerpt': {
          const label = typeof a.label === 'string' ? a.label.replace(/\s+/g, ' ').trim() : '';
          const excerpt = byLabel.get(label) ?? [...byLabel.values()].find((e) => e.label.toLowerCase() === label.toLowerCase());
          if (!excerpt) return error('unknown label: use a label that search_sources returned');
          excerpt.delivered = 'full';
          excerpt.deliveredChars = excerpt.text.length;
          return { content: json(shown(excerpt, true)), isError: false };
        }
        case 'list_documents': {
          const names = [...new Set((await backends.documents()).map((n) => labelName(n)))].slice(0, MAX_DOCUMENT_NAMES);
          return { content: json({ documents: names }), isError: false };
        }
        default:
          return error(`unknown tool ${String(name).slice(0, 40)}: only search_sources, read_excerpt and list_documents exist`);
      }
    },
  };
}

/**
 * @typedef {object} LoopResult
 * @property {string} text
 * @property {number} rounds   tool rounds the model made
 * @property {string} provider
 * @property {string} model    the model that served
 */

/**
 * @typedef {object} ToolLoopOptions
 * @property {(req: AiRequest, options: { signal?: AbortSignal }) => { result: Promise<CompletionResult> }} complete
 * @property {import('../ai/contract.js').ProviderId} provider
 * @property {string} model
 * @property {ResearchLocale} locale
 * @property {string} question
 * @property {ToolSession} tools
 * @property {readonly string[]} [hints]
 * @property {string | null} [focus]
 * @property {AbortSignal} [signal]
 * @property {(round: number) => void} [onRound]
 * @property {number} [maxRounds]
 */

/** @param {AbortSignal | undefined} signal */
function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

/**
 * The tool loop with the person's own key, through the AI layer: calls run here until the model
 * answers; after `maxRounds` rounds the call offers no more tools (toolChoice 'none').
 * @param {ToolLoopOptions} o
 * @returns {Promise<LoopResult>}
 */
export async function runToolLoop(o) {
  const maxRounds = o.maxRounds ?? MAX_TOOL_ROUNDS;
  /** @type {Message[]} */
  const messages = [{ role: 'user', content: [{ type: 'text', text: o.question }] }];
  const system = sourcesPrompt(o.locale, { rounds: maxRounds, hints: o.hints, focus: o.focus });
  for (let round = 1; ; round += 1) {
    throwIfAborted(o.signal);
    const last = round > maxRounds;
    const res = await o.complete({ provider: o.provider, model: o.model, system, messages, tools: [...o.tools.specs], toolChoice: last ? 'none' : 'auto', maxOutputTokens: 2400, temperature: 0.2 }, { signal: o.signal }).result;
    throwIfAborted(o.signal);
    if (res.error) throw res.error;
    const calls = res.toolCalls.slice(0, MAX_CALLS_PER_ROUND);
    if (calls.length > 0 && !last) {
      /** @type {Part[]} */
      const assistant = [];
      if (res.text) assistant.push({ type: 'text', text: res.text });
      for (const c of calls) assistant.push({ type: 'tool_call', id: c.id, name: c.name, args: c.args ?? {} });
      assistant.push(...res.opaque);
      messages.push({ role: 'assistant', content: assistant });
      /** @type {Part[]} */
      const results = [];
      for (const c of calls) {
        const r = c.args === null ? { content: JSON.stringify({ error: 'the arguments were not valid JSON' }), isError: true } : await o.tools.call(c.name, c.args);
        results.push({ type: 'tool_result', id: c.id, content: r.content, ...(r.isError ? { isError: true } : {}) });
      }
      messages.push({ role: 'tool', content: results });
      o.onRound?.(round);
      continue;
    }
    if (!res.text.trim()) throw new Error('research: the model gave no answer');
    return { text: res.text, rounds: round - 1, provider: res.provider, model: res.model };
  }
}

/**
 * @typedef {object} StepCall
 * @property {string} name
 * @property {string} [id]
 * @property {Record<string, unknown>} args
 */

/**
 * A step of the signed loop, as POST /api/research/step answers it.
 * @typedef {{ status: 'tool_calls', round: number, model: string, calls: StepCall[], turn: unknown, sig: string }
 *   | { status: 'final', round: number, model: string, text: string, grounding?: unknown }} StepAnswer
 */

/**
 * @typedef {(body: Record<string, unknown>, signal?: AbortSignal) => Promise<StepAnswer>} StepFn
 */

/**
 * The tool loop on the site's Gemini pool: every signed model turn goes back unchanged with the
 * results of its calls. A call of a tool this side does not run is answered as an error, whatever
 * the server sent.
 * @param {{ step: StepFn, locale: ResearchLocale, question: string, tools: ToolSession, hints?: readonly string[], focus?: string | null, signal?: AbortSignal, onRound?: (round: number) => void }} o
 * @returns {Promise<LoopResult>}
 */
export async function runSignedLoop(o) {
  /** @type {unknown[]} */
  const history = [];
  for (;;) {
    throwIfAborted(o.signal);
    const res = await o.step({ part: 'sources', question: o.question, locale: o.locale, history, hints: [...(o.hints ?? [])].slice(0, 4), focus: o.focus ?? null }, o.signal);
    throwIfAborted(o.signal);
    if (res.status === 'final') {
      if (typeof res.text !== 'string' || !res.text.trim()) throw new Error('research: the model gave no answer');
      return { text: res.text, rounds: res.round - 1, provider: 'gemini', model: res.model };
    }
    if (!Array.isArray(res.calls) || res.calls.length === 0 || history.length >= 2 * MAX_TOOL_ROUNDS) throw new Error('research: unexpected step');
    /** @type {Array<{ name: string, id?: string, content: string }>} */
    const results = [];
    for (const c of res.calls) {
      const r = await o.tools.call(c.name, c.args);
      results.push({ name: c.name, ...(c.id ? { id: c.id } : {}), content: r.content });
    }
    history.push({ turn: res.turn, sig: res.sig }, { results });
    o.onRound?.(res.round);
  }
}

/**
 * The answer without a model: the sentences of the excerpts that share the most words with the
 * question, quoted as written, each with its label. Searches with the question first.
 * @param {{ question: string, tools: ToolSession, locale: ResearchLocale, limit?: number }} o
 * @returns {Promise<string>} Markdown with the summary and details headings, or '' when nothing matched
 */
export async function quoteExcerpts(o) {
  await o.tools.call('search_sources', { query: o.question, k: 6 });
  const terms = new Set(tokenize(o.question));
  /** @type {Array<{ sentence: string, label: string, score: number }>} */
  const found = [];
  for (const e of o.tools.excerpts()) {
    const text = e.text.slice(0, e.deliveredChars).replace(/[#>*_`|]/g, ' ');
    const sentences = splitSentences(text).filter((s) => s.length > 15 && s.length < 400 && s.split(/\s+/).length >= 4);
    // A cut preview ends inside its last sentence: that one is not quoted.
    const usable = e.delivered === 'partial' || e.truncated ? sentences.slice(0, -1) : sentences;
    for (const sentence of usable) {
      const words = new Set(tokenize(sentence));
      let score = 0;
      for (const t of terms) if (words.has(t)) score += 1;
      if (score > 0 && !found.some((f) => f.sentence === sentence)) found.push({ sentence: sentence.replace(/\s+/g, ' ').trim(), label: e.label, score });
    }
  }
  found.sort((a, b) => b.score - a.score);
  const top = found.slice(0, o.limit ?? 5);
  if (!top.length) return '';
  const h = SECTION_HEADINGS[o.locale];
  const [first, ...rest] = top;
  const lines = [`## ${h.summary}`, `${first.sentence} ${first.label}`];
  if (rest.length) lines.push('', `## ${h.details}`, ...rest.map((f) => `- ${f.sentence} ${f.label}`));
  return lines.join('\n');
}

/**
 * The excerpts as the sentence gate reads them: what the model saw of each.
 * @param {readonly SourceExcerpt[]} excerpts
 */
export function gateSourceList(excerpts) {
  return excerpts.map((e, index) => ({ index, label: e.label, kind: /** @type {const} */ ('doc'), text: e.text.slice(0, e.deliveredChars) }));
}

/**
 * The text of the sources part through the sentence gate in sources mode, split into the sections
 * its headings name (text before any heading is the summary; an unknown heading starts details).
 * @param {string} text
 * @param {readonly SourceExcerpt[]} excerpts
 * @param {{ question?: string, locale?: ResearchLocale }} [options]
 * @returns {GatedSources}
 */
export function gateSources(text, excerpts, options = {}) {
  const result = checkText(text, { mode: 'sources', sources: gateSourceList(excerpts), question: options.question, locale: options.locale ?? null });
  /** @type {Record<SectionId, KeptSentence[]>} */
  const sections = { summary: [], details: [], open_questions: [] };
  /** @type {SectionId} */
  let current = 'summary';
  /** @type {string[]} */
  const cited = [];
  let released = 0;
  for (const unit of result.released) {
    if (unit.kind === 'heading') {
      current = sectionOfHeading(unit.text) ?? 'details';
      continue;
    }
    const cites = [...new Set(unit.cites.map((i) => excerpts[i]?.label).filter((l) => typeof l === 'string'))];
    for (const c of cites) if (!cited.includes(c)) cited.push(c);
    sections[current].push({ text: unit.text, cites, kind: unit.kind });
    released += 1;
  }
  return { sections, released, withheld: result.counts.withheld, reasons: { ...result.counts.reasons }, cited };
}

/**
 * Markdown of kept sentences (with their labels), as the gate and the source check read it again.
 * @param {Record<SectionId, KeptSentence[]>} sections
 * @param {ResearchLocale} locale
 */
export function sectionsMarkdown(sections, locale) {
  const h = SECTION_HEADINGS[locale];
  /** @type {string[]} */
  const out = [];
  for (const id of SECTION_IDS) {
    const list = sections[id] ?? [];
    if (!list.length) continue;
    if (out.length) out.push('');
    out.push(`## ${h[id]}`);
    for (const s of list) {
      const line = `${s.text}${s.cites.length ? ` ${s.cites.join(' ')}` : ''}`;
      out.push(s.kind === 'item' ? `- ${line}` : line);
    }
  }
  return out.join('\n');
}

/**
 * Checks a stored sources part again before it is shown: its sentences go through the gate once
 * more against its stored excerpts, so a record changed in storage cannot show a sentence the gate
 * would not release. Returns the sections as released now.
 * @param {{ sections?: Record<SectionId, KeptSentence[]>, excerpts?: SourceExcerpt[] }} part
 * @param {{ question?: string, locale?: ResearchLocale }} [options]
 * @returns {GatedSources}
 */
export function recheckSources(part, options = {}) {
  const excerpts = Array.isArray(part.excerpts) ? part.excerpts.filter((e) => e && typeof e.label === 'string' && typeof e.text === 'string') : [];
  const sections = part.sections ?? { summary: [], details: [], open_questions: [] };
  const clean = /** @type {Record<SectionId, KeptSentence[]>} */ (
    Object.fromEntries(
      SECTION_IDS.map((id) => [
        id,
        (Array.isArray(sections[id]) ? sections[id] : [])
          .filter((s) => s && typeof s.text === 'string')
          .map((s) => ({ text: s.text, cites: Array.isArray(s.cites) ? s.cites.filter((c) => typeof c === 'string') : [], kind: s.kind === 'item' || s.kind === 'row' || s.kind === 'code' ? s.kind : 'sentence' })),
      ]),
    )
  );
  const locale = options.locale ?? 'en';
  return gateSources(sectionsMarkdown(clean, locale), excerpts, { question: options.question, locale });
}
