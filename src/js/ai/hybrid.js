// @ts-check
// Auto routing between the free chat and answers from the user's sources. Deterministic and
// without an extra model call: the route of a question follows from what it carries and from a
// keyword probe of the on-device workspace (rag/workspace.js workspaceProbe, BM25 only, a few
// milliseconds).
//
//   1. An explicit mode wins: Free stays free, Grounded stays grounded.
//   2. Auto:
//      a. hooks.classify(question) runs first (empty here; an embedding app plugs in its own
//         classifier). It can only make a route stricter, never looser: its answer is combined with
//         the rules below and the stricter route wins.
//      b. Attached documents, and phrases that point at the user's files ("in the document",
//         "laut Quelle", a file name of the workspace), route to grounded, and so does a question
//         that names the subject of a document in the knowledge base (two words of its title in a
//         row: the library is not probed, its titles are known). Questions that carry only images
//         stay free (an image is read by a model that sees, not searched).
//      c. Otherwise the workspace probe decides: a strong match (normalised score >= strong, query
//         term coverage >= 0.5, at least two matched terms) routes to grounded, a weaker match of at
//         least two terms (score >= weak) to mixed, anything else to free.
//      d. Without a model that could answer, the sources are quoted: grounded.
//      e. With the Web toggle on and a model without its own web search, a search API (when one
//         is set up and the question may leave this device) finds pages, they become the passages
//         of a context pack, and the answer is grounded on them.
//
// The thresholds are tuned on tests/fixtures/routing (neutral workspace and questions); the unit
// test fails when a change of the probe or of a threshold moves a case to a looser route.
import { tokenize } from '../rag/bm25.js';

/** @typedef {import('../rag/hybrid.js').WorkspaceProbe} WorkspaceProbe */
/** @typedef {'free' | 'mixed' | 'grounded'} Route */
/** @typedef {'workspace' | 'supabase' | 'web' | 'engine'} RetrievalSource */

/**
 * How strict a route is: a route may only be replaced by one at least as strict. A classifier of an
 * embedding app may name routes of its own; they count as stricter than grounded.
 */
export const ROUTE_RANK = Object.freeze({ free: 0, mixed: 1, grounded: 2 });

/**
 * Probe thresholds (tests/fixtures/routing). `strong` and `weak` compare with the normalised BM25
 * score of the best chunk (rag/hybrid.js probeIndex), `coverage` with the share of the question's
 * terms in that chunk; a match needs `minTerms` matched terms (or every term of a shorter question).
 */
export const PROBE_THRESHOLDS = Object.freeze({ strong: 0.45, weak: 0.3, coverage: 0.5, minTerms: 2 });

/** Passages a route retrieves at most. */
export const ROUTE_TOP_K = Object.freeze({ grounded: 6, mixed: 3 });

/**
 * Phrases that point at the user's own files, matched as whole words in the lower-cased question.
 * Short and generic on purpose: they must not catch everyday questions.
 */
export const REFERENCE_PHRASES = Object.freeze({
  en: Object.freeze([
    'in the document',
    'in the documents',
    'in the file',
    'in the files',
    'in the attachment',
    'in the attached',
    'in the pdf',
    'in my documents',
    'in my files',
    'in my notes',
    'in my sources',
    'from my documents',
    'from my files',
    'from my notes',
    'from the document',
    'from the sources',
    'according to the document',
    'according to the file',
    'according to the source',
    'according to the sources',
    'according to my notes',
    'my documents',
    'my sources',
    'the uploaded',
    'this document',
    'these documents',
    'cite the source',
  ]),
  de: Object.freeze([
    'im dokument',
    'in dem dokument',
    'in den dokumenten',
    'in der datei',
    'in den dateien',
    'im anhang',
    'im pdf',
    'in meinen dokumenten',
    'in meinen dateien',
    'in meinen notizen',
    'in meinen unterlagen',
    'in meinen quellen',
    'aus meinen dokumenten',
    'aus meinen dateien',
    'aus meinen unterlagen',
    'aus dem dokument',
    'aus den quellen',
    'laut dokument',
    'laut datei',
    'laut quelle',
    'laut quellen',
    'laut den unterlagen',
    'laut meinen notizen',
    'gemäß dokument',
    'gemäß quelle',
    'meine dokumente',
    'meine quellen',
    'dieses dokument',
    'diese dokumente',
    'hochgeladene',
  ]),
});

/** @param {string} text  lower-cased words between single spaces, with a space at both ends */
const words = (text) => ` ${text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/**
 * Whether a question points at the user's files: one of the reference phrases, or the name of a
 * document it can see (the whole name, or a name of several words without its extension; a name
 * under four characters does not count, nor does a single common word such as "notes").
 * @param {string} question
 * @param {readonly string[]} [names]  document names in the workspace and the knowledge base
 */
export function namesSources(question, names = []) {
  const q = words(question);
  for (const list of Object.values(REFERENCE_PHRASES)) for (const phrase of list) if (q.includes(` ${phrase} `)) return true;
  for (const name of names) {
    const raw = String(name);
    const full = words(raw).trim();
    const stem = words(raw.replace(/\.[a-z0-9]{1,5}$/i, '')).trim();
    if (full.length >= 4 && full !== stem && q.includes(` ${full} `)) return true;
    if (stem.length >= 4 && stem.includes(' ') && q.includes(` ${stem} `)) return true;
  }
  return false;
}

/**
 * Whether a question names the subject of a titled document: two content words of a title in a
 * row ("Project Beta" for "Project Beta kickoff"), compared without stop words and case.
 * @param {string} question
 * @param {readonly string[]} [titles]
 */
export function namesTitle(question, titles = []) {
  const q = tokenize(question);
  const pairs = new Set(q.slice(1).map((w, i) => `${q[i]} ${w}`));
  if (!pairs.size) return false;
  for (const title of titles) {
    const words = tokenize(String(title).replace(/\.[a-z0-9]{1,5}$/i, '')).filter((w) => w.length >= 3);
    for (let i = 1; i < words.length; i += 1) if (pairs.has(`${words[i - 1]} ${words[i]}`)) return true;
  }
  return false;
}

/**
 * The route a workspace probe gives: grounded on a strong match, mixed on a weaker one, else free.
 * @param {WorkspaceProbe | null | undefined} probe
 * @param {typeof PROBE_THRESHOLDS} [thresholds]
 * @returns {Route}
 */
export function probeRoute(probe, thresholds = PROBE_THRESHOLDS) {
  if (!probe || !probe.terms || !probe.matched?.length) return 'free';
  const enough = probe.matched.length >= Math.min(thresholds.minTerms, probe.terms);
  if (!enough) return 'free';
  if (probe.score >= thresholds.strong && probe.coverage >= thresholds.coverage) return 'grounded';
  return probe.score >= thresholds.weak ? 'mixed' : 'free';
}

/**
 * The stricter of two routes (unknown names of a classifier count as the strictest).
 * @param {string} a
 * @param {string} b
 */
export function stricter(a, b) {
  const rank = (/** @type {string} */ r) => (Object.hasOwn(ROUTE_RANK, r) ? ROUTE_RANK[/** @type {Route} */ (r)] : 3);
  return rank(b) > rank(a) ? b : a;
}

/**
 * What the decision needs to know.
 * @typedef {object} RouteInput
 * @property {string} question
 * @property {'auto' | 'free' | 'grounded'} mode   the mode control's setting
 * @property {{ mode?: 'auto' | 'free' | 'grounded' } | null} [project]  a project that fixes the mode counts as an explicit mode
 * @property {readonly { kind: string, name?: string }[]} [attachments]
 * @property {((question: string) => Promise<WorkspaceProbe> | WorkspaceProbe) | null} [workspaceProbe]
 * @property {{ classify?: ((question: string) => Promise<{ route: string, reasons?: string[] } | null> | { route: string, reasons?: string[] } | null) | null }} [hooks]
 * @property {readonly string[]} [names]      document names the question may refer to
 * @property {readonly string[]} [titles]     titles of the knowledge base's documents (their subject counts as a reference)
 * @property {boolean} [modelReady]           a model can answer (default true)
 * @property {boolean} [deviceOnly]           the question stays on this device (no web search, no question to the library)
 * @property {{ on: boolean, native: boolean, searchApi: boolean }} [web]  the Web toggle, the model's own search, a search API
 * @property {typeof PROBE_THRESHOLDS} [thresholds]
 */

/**
 * @typedef {object} RouteDecision
 * @property {Route | string} route   a classifier may name a route of its own
 * @property {string[]} reasons       why, in the order the rules applied
 * @property {{ topK: number, sources: RetrievalSource[] }} retrieval
 * @property {WorkspaceProbe | null} probe
 */

/**
 * The route of a question.
 * @param {RouteInput} input
 * @returns {Promise<RouteDecision>}
 */
export async function decideRoute(input) {
  /** @type {string[]} */
  const reasons = [];
  /** @type {WorkspaceProbe | null} */
  let probe = null;
  const explicit = input.project?.mode && input.project.mode !== 'auto' ? input.project.mode : input.mode !== 'auto' ? input.mode : null;
  /** @type {string} */
  let route;
  if (explicit) {
    route = explicit;
    reasons.push(input.project?.mode && input.project.mode !== 'auto' ? 'project' : 'explicit_mode');
  } else {
    route = 'free';
    // a. The classifier of an embedding app, first; it can only tighten what the rules decide.
    let classified = null;
    try {
      classified = (await input.hooks?.classify?.(input.question)) ?? null;
    } catch (err) {
      console.warn('[starpi] the route classifier failed; the rules decide', err);
    }
    if (classified && typeof classified.route === 'string') {
      route = classified.route;
      reasons.push('classifier', ...(classified.reasons ?? []).map(String).slice(0, 4));
    }
    // b. What the question carries and what it names.
    const kinds = (input.attachments ?? []).map((a) => a.kind);
    const documents = kinds.some((k) => k !== 'image');
    if (documents) {
      route = stricter(route, 'grounded');
      reasons.push('attachment');
    } else if (kinds.length) {
      reasons.push('images_only');
    } else if (namesSources(input.question, input.names)) {
      route = stricter(route, 'grounded');
      reasons.push('reference');
    } else if (namesTitle(input.question, input.titles)) {
      route = stricter(route, 'grounded');
      reasons.push('title');
    } else if (input.workspaceProbe && input.question.trim()) {
      // c. The workspace probe.
      try {
        probe = await input.workspaceProbe(input.question);
      } catch (err) {
        console.warn('[starpi] the workspace probe failed', err);
      }
      const byProbe = probeRoute(probe, input.thresholds);
      route = stricter(route, byProbe);
      reasons.push(byProbe === 'grounded' ? 'probe_strong' : byProbe === 'mixed' ? 'probe_weak' : 'probe_none');
    }
    // d. Nothing could answer: the sources are quoted (not for images, which have no text yet).
    if (input.modelReady === false && !(kinds.length && !documents)) {
      route = stricter(route, 'grounded');
      reasons.push('no_model');
    }
    // e. The Web toggle with a model that cannot search: a search API, then a pack.
    if (input.web?.on && !input.web.native) {
      if (input.deviceOnly) reasons.push('web_device_only');
      else if (input.web.searchApi) {
        route = stricter(route, 'grounded');
        reasons.push('web_search_api');
      } else reasons.push('web_unavailable');
    }
  }
  /** @type {RetrievalSource[]} */
  const sources = route === 'free' ? [] : ['workspace', 'supabase'];
  if (!explicit && reasons.includes('web_search_api')) sources.push('web');
  return { route, reasons, retrieval: { topK: route === 'mixed' ? ROUTE_TOP_K.mixed : ROUTE_TOP_K.grounded, sources }, probe };
}

// ---------------------------------------------------------------------------------------------
// Web passages from a search API
// ---------------------------------------------------------------------------------------------

/** @typedef {import('../research/web-part.js').WebAnswer} WebAnswer */
/** @typedef {import('../supabase.js').KnowledgeHit} KnowledgeHit */

/** Web pages a context pack takes at most. */
export const MAX_WEB_PASSAGES = 6;
/** Characters of one web passage at most. */
const WEB_PASSAGE_CHARS = 1600;

/**
 * The pages of a search answer as passages for a context pack, in the shape of library hits: each
 * page with the parts of the answer that rest on it (only those; a page without one gives no
 * passage, as nothing says what it contains).
 * @param {WebAnswer} answer
 * @param {number} [max]
 * @returns {KnowledgeHit[]}
 */
export function webHits(answer, max = MAX_WEB_PASSAGES) {
  /** @type {Map<number, string[]>} */
  const parts = new Map();
  for (const seg of answer.segments ?? []) {
    const text = answer.text.slice(seg.start, seg.end).trim();
    if (!text) continue;
    for (const i of seg.sources) {
      const list = parts.get(i) ?? [];
      if (!list.includes(text)) list.push(text);
      parts.set(i, list);
    }
  }
  /** @type {KnowledgeHit[]} */
  const out = [];
  answer.sources.forEach((source, i) => {
    const list = parts.get(i);
    if (!list?.length || out.length >= max || !/^https?:\/\//i.test(source.uri)) return;
    let host = source.uri;
    try {
      host = new URL(source.uri).host;
    } catch {
      // keep the address as it is
    }
    const content = list.join(' ').slice(0, WEB_PASSAGE_CHARS);
    out.push({ documentId: source.uri, documentTitle: (source.title || host).slice(0, 120), heading: host, content, tags: ['web'], rank: null });
  });
  return out;
}


/**
 * The search API of this browser for questions to models that cannot search themselves: a web
 * search with the person's own key at a provider that can (research/runtime.js picks it), else the
 * site's search step when it offers one; null when neither is set up. Loaded on first use.
 * @param {string} locale
 * @returns {Promise<import('../research/web-part.js').WebSearch | null>}
 */
export async function browserWebSearch(locale) {
  try {
    const [{ browserRuntime }, { byokWebSearch, poolWebSearch }] = await Promise.all([import('../research/runtime.js'), import('../research/web-part.js')]);
    const runtime = browserRuntime();
    const routes = await runtime.routes();
    const lang = String(locale).slice(0, 2) === 'de' ? 'de' : 'en';
    if (routes.web) return byokWebSearch({ complete: runtime.complete, provider: routes.web.provider, model: routes.web.model, locale: lang });
    if (routes.pool) return poolWebSearch({ step: runtime.step, locale: lang });
  } catch (err) {
    console.warn('[starpi] no web search could be set up', err);
  }
  return null;
}

/**
 * Web passages for a question: one search through `search`, its pages as library-shaped hits. Never
 * throws (an empty list when the search fails or nothing is set up).
 * @param {string} question
 * @param {{ search: import('../research/web-part.js').WebSearch | null, signal?: AbortSignal }} o
 * @returns {Promise<KnowledgeHit[]>}
 */
export async function searchWebHits(question, o) {
  if (!o.search || !question.trim()) return [];
  try {
    return webHits(await o.search(question, o.signal));
  } catch (err) {
    if (!o.signal?.aborted) console.warn('[starpi] the web search failed', err);
    return [];
  }
}
