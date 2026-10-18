// @ts-check
// The research pipeline of one job, from the question to the stored report:
//   1. plan      one call turns the question into up to four search queries (without a model that
//                can, the question itself is the only query);
//   2. sources   the sources part (sources-part.js): a tool loop over the person's documents, then
//                the sentence gate in sources mode;
//   3. web       when the job asked for it, the web part (web-part.js): one search round per query,
//                at most four rounds and twenty sources, judged as a whole in web mode;
//   4. report    the sections summary, details, sources and open questions as Markdown, stored as an
//                artifact (store `artifacts`);
//   5. check     the source check (core/grounding.js) over the kept sentences of the sources part,
//                whose result goes into the report and the answer receipt.
// A finished part is kept when a job runs again (retry), so only what is missing runs. Everything
// the pipeline needs from the app comes in a ResearchRuntime, so tests run it with fakes.
import { blocksFromMarkdown, groundAnswer } from '../core/grounding.js';
import { t } from '../i18n/index.js';
import { HINT_CHARS, MAX_PLAN_QUERIES, planPrompt, PLAN_SCHEMA, researchLocale, SECTION_IDS } from './prompts.js';
import { createSourceTools, gateSources, quoteExcerpts, runSignedLoop, runToolLoop, sectionsMarkdown } from './sources-part.js';
import { byokWebSearch, poolWebSearch, runWebPart } from './web-part.js';
import { webQuery } from './web-query.js';

/** @typedef {import('../ai/contract.js').ProviderId} ProviderId */
/** @typedef {import('../ai/contract.js').AiRequest} AiRequest */
/** @typedef {import('../ai/index.js').CompletionResult} CompletionResult */
/** @typedef {import('./prompts.js').ResearchLocale} ResearchLocale */
/** @typedef {import('./prompts.js').SectionId} SectionId */
/** @typedef {import('./sources-part.js').SourceBackends} SourceBackends */
/** @typedef {import('./sources-part.js').SourceExcerpt} SourceExcerpt */
/** @typedef {import('./sources-part.js').KeptSentence} KeptSentence */
/** @typedef {import('./sources-part.js').StepFn} StepFn */
/** @typedef {import('./web-part.js').WebPart} WebPart */
/** @typedef {import('../store/schema.js').ArtifactRecord} ArtifactRecord */
/** @typedef {import('../core/receipt.js').ReceiptDraft} ReceiptDraft */
/** @typedef {import('../core/receipt.js').ReceiptDocument} ReceiptDocument */

/** @typedef {{ provider: ProviderId, model: string }} ModelChoice */

/**
 * Who serves which step of a job: a model with tools for the sources part and a model with web
 * search for the web part, both with the person's own key, and whether the site's Gemini pool takes
 * research steps (GET /api/health `research`).
 * @typedef {{ sources: ModelChoice | null, web: ModelChoice | null, pool: boolean }} ResearchRoutes
 */

/**
 * @typedef {object} ResearchRuntime
 * @property {(req: AiRequest, options: { signal?: AbortSignal }) => { result: Promise<CompletionResult> }} complete
 * @property {StepFn} step                    POST /api/research/step
 * @property {SourceBackends} backends
 * @property {() => Promise<ResearchRoutes>} routes
 * @property {(artifact: ArtifactRecord & Record<string, unknown>) => Promise<void>} saveArtifact
 * @property {() => number} now
 */

/** @typedef {'plan' | 'sources' | 'web' | 'report' | 'check'} ResearchStep */
/** @typedef {{ step: ResearchStep, round: number, sources: number }} ResearchProgress */

/**
 * The sources part as a job stores it.
 * @typedef {object} SourcesPart
 * @property {'running' | 'done' | 'failed' | 'cancelled'} status
 * @property {'byok' | 'pool' | 'quote'} via   the person's key, the site's pool, or quoted without a model
 * @property {{ id: string, model: string } | null} provider
 * @property {number} rounds
 * @property {Record<SectionId, KeptSentence[]>} sections
 * @property {number} released
 * @property {number} withheld
 * @property {Partial<Record<string, number>>} reasons
 * @property {string[]} cited
 * @property {SourceExcerpt[]} excerpts
 * @property {string | null} fallback  the model failed and the excerpts were quoted instead (its error code)
 * @property {{ supported: number, weak: number, unsupported: number, unchecked: number } | null} check
 */

/**
 * What a job carries into the pipeline.
 * @typedef {object} JobInput
 * @property {string} id
 * @property {string} question
 * @property {number} createdAt
 * @property {string} [locale]
 * @property {{ focus?: string | null, conversationId?: string | null, nodeId?: string | null }} [scope]
 * @property {{ web?: boolean, stripPii?: boolean }} [options]
 * @property {{ queries: string[] } | null} [plan]
 * @property {{ sources?: SourcesPart | null, web?: WebPart | null }} [parts]
 */

/**
 * @typedef {object} ResearchOutcome
 * @property {{ queries: string[] }} plan
 * @property {{ id: string, model: string } | null} provider
 * @property {{ sources: SourcesPart, web: WebPart | null }} parts
 * @property {{ artifactId: string, markdown: string }} report
 */

/** @param {AbortSignal | undefined} signal */
function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

/** @param {unknown} err */
const isAbort = (err) => err instanceof DOMException && err.name === 'AbortError';

/**
 * An error as a short code for the record (the AI layer's codes, HTTP refusals, or 'error').
 * @param {unknown} err
 */
export function errorCode(err) {
  const code = /** @type {{ code?: unknown }} */ (err)?.code;
  return typeof code === 'string' && /^[a-z_]{2,40}$/.test(code) ? code : 'error';
}

/**
 * The plan: up to four distinct search queries. Without a model, or when its answer does not fit,
 * the question is the only query.
 * @param {{ question: string, locale: ResearchLocale, model: ModelChoice | null, complete: ResearchRuntime['complete'], signal?: AbortSignal }} o
 * @returns {Promise<string[]>}
 */
export async function makePlan(o) {
  const fallback = [o.question];
  if (!o.model) return fallback;
  try {
    const res = await o.complete(
      { provider: o.model.provider, model: o.model.model, system: planPrompt(o.locale), messages: [{ role: 'user', content: [{ type: 'text', text: o.question }] }], responseFormat: { type: 'json_schema', schema: { ...PLAN_SCHEMA } }, maxOutputTokens: 400, temperature: 0 },
      { signal: o.signal },
    ).result;
    throwIfAborted(o.signal);
    if (res.error) return fallback;
    const match = /\{[\s\S]*\}/.exec(res.text);
    const value = match ? JSON.parse(match[0]) : null;
    const queries = (Array.isArray(value?.queries) ? value.queries : [])
      .filter((/** @type {unknown} */ q) => typeof q === 'string')
      .map((/** @type {string} */ q) => q.replace(/\s+/g, ' ').trim().slice(0, HINT_CHARS).trim())
      .filter((/** @type {string} */ q, /** @type {number} */ i, /** @type {string[]} */ all) => q && all.findIndex((x) => x.toLowerCase() === q.toLowerCase()) === i)
      .slice(0, MAX_PLAN_QUERIES);
    return queries.length ? queries : fallback;
  } catch (err) {
    if (isAbort(err)) throw err;
    return fallback;
  }
}

/**
 * Runs the sources part: the tool loop with the person's key, else on the site's pool, else quoted
 * without a model; a failing model falls back to the quote. The text goes through the gate.
 * @param {{ job: JobInput, runtime: ResearchRuntime, routes: ResearchRoutes, locale: ResearchLocale, hints: string[], signal?: AbortSignal, onRound?: (round: number) => void }} o
 * @returns {Promise<SourcesPart>}
 */
export async function runSourcesPart(o) {
  const focus = o.job.scope?.focus ?? null;
  const tools = createSourceTools(o.runtime.backends, { focus });
  /** @type {SourcesPart['via']} */
  let via = o.routes.sources ? 'byok' : o.routes.pool ? 'pool' : 'quote';
  /** @type {{ id: string, model: string } | null} */
  let provider = null;
  let rounds = 0;
  let text = '';
  /** @type {string | null} */
  let fallback = null;
  try {
    if (via === 'byok' && o.routes.sources) {
      const r = await runToolLoop({ complete: o.runtime.complete, provider: o.routes.sources.provider, model: o.routes.sources.model, locale: o.locale, question: o.job.question, tools, hints: o.hints, focus, signal: o.signal, onRound: o.onRound });
      ({ text, rounds } = r);
      provider = { id: r.provider, model: r.model };
    } else if (via === 'pool') {
      const r = await runSignedLoop({ step: o.runtime.step, locale: o.locale, question: o.job.question, tools, hints: o.hints, focus, signal: o.signal, onRound: o.onRound });
      ({ text, rounds } = r);
      provider = { id: r.provider, model: r.model };
    }
  } catch (err) {
    if (isAbort(err) || o.signal?.aborted) throw err;
    fallback = errorCode(err);
    via = 'quote';
  }
  if (via === 'quote') text = await quoteExcerpts({ question: o.job.question, tools, locale: o.locale });
  throwIfAborted(o.signal);
  const gated = gateSources(text, tools.excerpts(), { question: o.job.question, locale: o.locale });
  return { status: 'done', via, provider: via === 'quote' ? null : provider, rounds, ...gated, excerpts: tools.excerpts(), fallback, check: null };
}

/**
 * The source check of the kept sentences (core/grounding.js), the grounding report a receipt carries.
 * @param {SourcesPart} part
 * @param {ResearchLocale} locale
 * @param {string} question
 */
export function sourceCheck(part, locale, question) {
  const markdown = sectionsMarkdown(part.sections, locale);
  const sources = part.excerpts.map((e) => ({ label: e.label, doc: e.doc, heading: e.heading, text: e.text.slice(0, e.deliveredChars), delivered: e.delivered }));
  const report = groundAnswer(blocksFromMarkdown(markdown, sources), sources, { given: [question] });
  return { markdown, report };
}

/**
 * The report of a job as Markdown, in the language of the job.
 * @param {{ question: string, createdAt: number, locale: ResearchLocale, sources: SourcesPart, web: WebPart | null }} r
 */
export function reportMarkdown(r) {
  const L = r.locale;
  const tr = (/** @type {string} */ key, /** @type {Record<string, string | number> | undefined} */ params = undefined) => t(key, params, L);
  const line = (/** @type {KeptSentence} */ s) => `${s.text}${s.cites.length ? ` ${s.cites.join(' ')}` : ''}`;
  const date = new Date(r.createdAt).toISOString().slice(0, 10);
  const by = r.sources.via === 'quote' ? tr('research.report.quoted') : tr('research.report.made_with', { model: r.sources.provider?.model ?? '' });
  /** @type {string[]} */
  const out = [`# ${tr('research.report.title')}`, '', `> ${r.question.replace(/\s+/g, ' ')}`, '', `${date} · ${by}`];
  const section = (/** @type {SectionId} */ id, /** @type {string} */ titleKey) => {
    const list = r.sources.sections[id] ?? [];
    if (!list.length) return;
    out.push('', `## ${tr(titleKey)}`, '');
    for (const s of list) out.push(s.kind === 'item' || id === 'details' ? `- ${line(s)}` : line(s));
  };
  section('summary', 'research.section.summary');
  section('details', 'research.section.details');
  if (!SECTION_IDS.some((id) => r.sources.sections[id]?.length)) out.push('', tr('research.report.no_document_answer'));
  if (r.web) {
    out.push('', `## ${tr('research.report.from_web')}`, '', tr('research.report.web_query', { query: r.web.query }));
    if (r.web.status === 'done' && r.web.text) out.push('', r.web.text.trim());
    else if (r.web.status === 'withheld') out.push('', tr('research.report.web_withheld', { reason: tr(`research.web_reason.${webReasonKey(r.web.reason)}`) }));
    else if (r.web.status === 'off') out.push('', tr('research.report.web_off'));
    else out.push('', tr('research.report.web_failed'));
  }
  out.push('', `## ${tr('research.section.sources')}`);
  const cited = r.sources.excerpts.filter((e) => r.sources.cited.includes(e.label));
  if (cited.length) {
    out.push('', `### ${tr('research.report.documents')}`, '');
    for (const e of cited) out.push(`- ${e.label}${e.heading ? ` ${e.heading}` : ''}`);
  }
  if (r.web?.sources.length) {
    out.push('', `### ${tr('research.report.web_sources')}`, '');
    for (const s of r.web.sources) out.push(`- ${s.title ? `${s.title.replace(/[[\]]/g, '')} ` : ''}<${s.uri}>`);
  }
  if (!cited.length && !r.web?.sources.length) out.push('', tr('research.report.no_sources'));
  section('open_questions', 'research.section.open_questions');
  out.push('', '---', '');
  const check = r.sources.check;
  if (check) out.push(tr('research.report.check', { supported: check.supported, weak: check.weak, unsupported: check.unsupported }));
  if (r.sources.withheld) out.push(tr('research.report.withheld', { n: r.sources.withheld }));
  out.push(tr('research.report.receipt_note'));
  return `${out.join('\n')}\n`;
}

/**
 * The i18n key part of a withheld or off reason (unknown codes read as "other").
 * @param {string | null} reason
 */
export function webReasonKey(reason) {
  return reason && ['empty', 'no_sources', 'web_ungrounded', 'unsupported_number', 'chars', 'link', 'joined', 'number_word', 'identifier', 'spoken_mismatch'].includes(reason) ? reason : 'other';
}

/**
 * The receipt draft of a job's sources part (core/receipt.js): its kept sentences as the answer,
 * the excerpts the model was given, the source check and the gate counts. Web sources are not part
 * of a receipt; the report lists them as not verified.
 * @param {{ question: string, createdAt: number, locale: ResearchLocale, sources: SourcesPart }} r
 * @param {{ version: string, documentInfo?: (docId: string) => ReceiptDocument | undefined }} o
 * @returns {ReceiptDraft}
 */
export function receiptDraft(r, o) {
  const { markdown, report } = sourceCheck(r.sources, r.locale, r.question);
  return {
    createdAt: new Date(r.createdAt).toISOString(),
    version: o.version,
    answer: { text: markdown, engine: r.sources.via === 'quote' ? 'synthesizer' : (r.sources.provider?.id ?? 'unknown'), locale: r.locale },
    question: r.question,
    grounding: report,
    gate: { mode: 'sources', released: r.sources.released, withheld: r.sources.withheld },
    citations: r.sources.excerpts.slice(0, 64).map((e) => {
      const document = e.span ? o.documentInfo?.(e.span.docId) : undefined;
      return {
        label: e.label,
        doc: e.doc,
        heading: e.heading,
        source: e.source,
        delivered: e.delivered,
        ...(e.delivered === 'partial' ? { deliveredChars: e.deliveredChars } : {}),
        text: e.text,
        truncated: e.truncated,
        documentId: e.source === 'knowledge' ? e.documentId : null,
        ...(document ? { document } : {}),
        ...(e.span ? { chunk: { index: e.span.chunkIndex, start: e.span.start, end: e.span.end } } : {}),
      };
    }),
  };
}

/**
 * Runs the pipeline of one job. Parts that are already done (a retry) are kept.
 * @param {JobInput} job
 * @param {ResearchRuntime} runtime
 * @param {{ signal?: AbortSignal, progress?: (p: ResearchProgress, parts?: { sources?: SourcesPart, web?: WebPart | null }) => void }} [options]
 * @returns {Promise<ResearchOutcome>}
 */
export async function runResearch(job, runtime, options = {}) {
  const { signal } = options;
  const progress = options.progress ?? (() => {});
  const locale = researchLocale(job.locale);
  const routes = await runtime.routes();
  throwIfAborted(signal);
  const query = webQuery(job.question, { stripPii: job.options?.stripPii === true });

  progress({ step: 'plan', round: 0, sources: 0 });
  const queries = job.plan?.queries?.length ? job.plan.queries : await makePlan({ question: query.text || job.question, locale, model: routes.sources, complete: runtime.complete, signal });

  /** @type {SourcesPart} */
  let sources;
  const kept = job.parts?.sources;
  if (kept && kept.status === 'done') sources = kept;
  else {
    progress({ step: 'sources', round: 0, sources: 0 });
    sources = await runSourcesPart({ job, runtime, routes, locale, hints: queries, signal, onRound: (round) => progress({ step: 'sources', round, sources: 0 }) });
    progress({ step: 'sources', round: sources.rounds, sources: sources.excerpts.length }, { sources });
  }

  /** @type {WebPart | null} */
  let web = null;
  if (job.options?.web) {
    const keptWeb = job.parts?.web;
    if (keptWeb && (keptWeb.status === 'done' || keptWeb.status === 'withheld')) web = keptWeb;
    else {
      const provider = routes.web ? { id: routes.web.provider, model: routes.web.model } : routes.pool ? { id: 'gemini', model: 'pool' } : null;
      const search = routes.web ? byokWebSearch({ complete: runtime.complete, provider: routes.web.provider, model: routes.web.model, locale }) : routes.pool ? poolWebSearch({ step: runtime.step, locale }) : null;
      const base = { query: query.text, removed: query.removed, text: null, grounding: null, suggestionsHtml: null, sources: [], rounds: 0, verdict: null, provider };
      if (!search || !query.text) web = { ...base, status: 'off', reason: query.text ? 'no_provider' : 'empty_query' };
      else {
        progress({ step: 'web', round: 0, sources: 0 }, { web: { ...base, status: 'running', reason: null } });
        try {
          web = await runWebPart({ search, query: query.text, removed: query.removed, queries: queries.filter((q) => q !== job.question), locale, provider, signal, onRound: (round, n) => progress({ step: 'web', round, sources: n }) });
        } catch (err) {
          if (isAbort(err) || signal?.aborted) throw err;
          web = { ...base, status: 'failed', reason: errorCode(err) };
        }
      }
      progress({ step: 'web', round: web.rounds, sources: web.sources.length }, { web });
    }
  }

  progress({ step: 'check', round: 0, sources: sources.excerpts.length });
  const { report } = sourceCheck(sources, locale, job.question);
  sources = { ...sources, check: { ...report.counts } };

  progress({ step: 'report', round: 0, sources: sources.excerpts.length });
  const markdown = reportMarkdown({ question: job.question, createdAt: job.createdAt, locale, sources, web });
  const artifactId = `research-${job.id}`;
  const at = runtime.now();
  await runtime.saveArtifact({
    id: artifactId,
    conversationId: job.scope?.conversationId ?? '',
    nodeId: job.scope?.nodeId ?? '',
    type: 'markdown',
    title: job.question.replace(/\s+/g, ' ').slice(0, 120),
    versions: [{ content: markdown, at }],
    researchId: job.id,
  });
  const provider = sources.provider ?? (web?.provider && web.status === 'done' ? web.provider : null);
  return { plan: { queries }, provider, parts: { sources, web }, report: { artifactId, markdown } };
}
