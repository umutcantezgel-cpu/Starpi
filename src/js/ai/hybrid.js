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
//      b. Attached documents route to grounded. Questions that carry only images stay free (an
//         image is read by a model that sees, not searched). Without a file in the workspace or a
//         document in the knowledge base there is nothing a question's words could point at: it
//         stays free, whatever it names ("How do I search in my files?").
//      c. With sources: phrases that point at them ("according to my notes", "laut Quelle",
//         "selon mes notes", "según mis notas", "secondo i miei documenti", "notlarıma göre", a
//         file name of the workspace) route to grounded, and so does a question that names the
//         subject of a document in the knowledge base (two words of its title in a row: the library
//         is not probed, its titles are known).
//      d. Otherwise the workspace probe decides: a strong match (normalised score >= strong, query
//         term coverage >= 0.5, at least two matched terms) routes to grounded, a weaker match of at
//         least two terms (score >= weak) to mixed, anything else to free.
//      e. Without a model that could answer, the sources are quoted: grounded.
//      f. With the Web toggle on and a model without its own web search, a search API (when one
//         is set up and the question may leave this device) finds pages, they become the passages
//         of a context pack, and the answer is grounded on them. The search service of Settings ›
//         Tools (Brave, Tavily, SearXNG; ai/search.js) comes first, then a web search with the
//         user's own key at a provider that can search, then the site's search step.
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
 * Phrases that point at the user's own sources, matched as whole words in the lower-cased question.
 * Short and generic on purpose, and narrow: they name a source the answer must come from
 * ("according to my notes", "laut Quelle") or ask what one says ("was steht im Dokument"). A bare
 * place such as "in the file" or "im Dokument" is not on the list: it opens how-to questions about
 * software just as often ("How do I replace a string in the file with sed?") and refers to text
 * pasted into the question as well.
 */
export const REFERENCE_PHRASES = Object.freeze({
  en: Object.freeze([
    'according to the document',
    'according to the documents',
    'according to the file',
    'according to the files',
    'according to the source',
    'according to the sources',
    'according to my documents',
    'according to my files',
    'according to my notes',
    'according to my sources',
    'based on my documents',
    'based on my files',
    'based on my notes',
    'based on my sources',
    'based on the sources',
    'in my sources',
    'from my sources',
    'my uploaded documents',
    'my uploaded files',
    'what does the document say',
    'what do the documents say',
    'what does the file say',
    'what do my documents say',
    'what do my files say',
    'what do my notes say',
    'summarize my documents',
    'summarise my documents',
    'summarize my files',
    'summarise my files',
    'summarize my notes',
    'summarise my notes',
  ]),
  de: Object.freeze([
    'laut dokument',
    'laut dem dokument',
    'laut den dokumenten',
    'laut datei',
    'laut der datei',
    'laut quelle',
    'laut der quelle',
    'laut quellen',
    'laut den quellen',
    'laut meinen dokumenten',
    'laut meinen dateien',
    'laut meinen notizen',
    'laut meinen quellen',
    'laut meinen unterlagen',
    'laut den unterlagen',
    'gemäß dokument',
    'gemäß dem dokument',
    'gemäß quelle',
    'gemäß der quelle',
    'gemäß den unterlagen',
    'anhand meiner dokumente',
    'anhand meiner notizen',
    'anhand meiner quellen',
    'anhand meiner unterlagen',
    'anhand der unterlagen',
    'in meinen quellen',
    'aus meinen quellen',
    'in meinen unterlagen',
    'aus meinen unterlagen',
    'meine hochgeladenen dokumente',
    'meine hochgeladenen dateien',
    'was steht im dokument',
    'was steht in dem dokument',
    'was steht in den dokumenten',
    'was steht in der datei',
    'was steht in meinen dokumenten',
    'was steht in meinen dateien',
    'was steht in meinen notizen',
    'was sagt das dokument',
    'was sagen meine dokumente',
    'was sagen meine notizen',
    'fasse meine dokumente',
    'fasse meine dateien',
    'fasse meine notizen',
    'fasse meine unterlagen',
  ]),
  fr: Object.freeze([
    'selon le document',
    'selon les documents',
    'selon le fichier',
    'selon les fichiers',
    'selon la source',
    'selon les sources',
    'selon mes documents',
    'selon mes fichiers',
    'selon mes notes',
    'selon mes sources',
    'd après le document',
    'd après les documents',
    'd après les sources',
    'd après mes documents',
    'd après mes fichiers',
    'd après mes notes',
    'd après mes sources',
    'sur la base de mes documents',
    'sur la base de mes fichiers',
    'sur la base de mes notes',
    'sur la base des sources',
    'dans mes sources',
    'à partir de mes sources',
    'mes documents téléversés',
    'mes fichiers téléversés',
    'mes documents importés',
    'mes fichiers importés',
    'que dit le document',
    'que disent les documents',
    'que dit le fichier',
    'que disent mes documents',
    'que disent mes fichiers',
    'que disent mes notes',
    'résume mes documents',
    'résume mes fichiers',
    'résume mes notes',
    'résumez mes documents',
    'résumez mes fichiers',
    'résumez mes notes',
  ]),
  es: Object.freeze([
    'según el documento',
    'según los documentos',
    'según el archivo',
    'según los archivos',
    'según la fuente',
    'según las fuentes',
    'según mis documentos',
    'según mis archivos',
    'según mis notas',
    'según mis fuentes',
    'de acuerdo con el documento',
    'de acuerdo con mis documentos',
    'de acuerdo con mis notas',
    'basándote en mis documentos',
    'basándote en mis archivos',
    'basándote en mis notas',
    'basándote en mis fuentes',
    'basándote en las fuentes',
    'en mis fuentes',
    'de mis fuentes',
    'mis documentos subidos',
    'mis archivos subidos',
    'qué dice el documento',
    'qué dicen los documentos',
    'qué dice el archivo',
    'qué dicen mis documentos',
    'qué dicen mis archivos',
    'qué dicen mis notas',
    'resume mis documentos',
    'resume mis archivos',
    'resume mis notas',
    'resúmeme mis documentos',
    'resúmeme mis notas',
  ]),
  it: Object.freeze([
    'secondo il documento',
    'secondo i documenti',
    'secondo il file',
    'secondo la fonte',
    'secondo le fonti',
    'secondo i miei documenti',
    'secondo i miei file',
    'secondo le mie note',
    'secondo le mie fonti',
    'in base al documento',
    'in base ai miei documenti',
    'in base ai miei file',
    'in base alle mie note',
    'in base alle mie fonti',
    'in base alle fonti',
    'nelle mie fonti',
    'dalle mie fonti',
    'i miei documenti caricati',
    'i miei file caricati',
    'cosa dice il documento',
    'cosa dicono i documenti',
    'cosa dice il file',
    'cosa dicono i miei documenti',
    'cosa dicono i miei file',
    'cosa dicono le mie note',
    'riassumi i miei documenti',
    'riassumi i miei file',
    'riassumi le mie note',
  ]),
  tr: Object.freeze([
    'belgeye göre',
    'belgelere göre',
    'dosyaya göre',
    'dosyalara göre',
    'kaynağa göre',
    'kaynaklara göre',
    'belgelerime göre',
    'dosyalarıma göre',
    'notlarıma göre',
    'kaynaklarıma göre',
    'belgelerime dayanarak',
    'dosyalarıma dayanarak',
    'notlarıma dayanarak',
    'kaynaklarıma dayanarak',
    'kaynaklara dayanarak',
    'belgelerimden yola çıkarak',
    'notlarımdan yola çıkarak',
    'kaynaklarımda',
    'kaynaklarımdan',
    'yüklediğim belgeler',
    'yüklediğim dosyalar',
    'belgede ne yazıyor',
    'belgelerde ne yazıyor',
    'dosyada ne yazıyor',
    'belgelerimde ne yazıyor',
    'dosyalarımda ne yazıyor',
    'notlarımda ne yazıyor',
    'belge ne diyor',
    'belgelerim ne diyor',
    'notlarım ne diyor',
    'belgelerimi özetle',
    'dosyalarımı özetle',
    'notlarımı özetle',
  ]),
});

/**
 * Phrases that place a question in the user's own files ("in my notes"). They also open how-to
 * questions ("How do I search in my files?"), so they count only in a question that does not start
 * like one in the same language (HOW_TO).
 */
export const PLACE_PHRASES = Object.freeze({
  en: Object.freeze(['in my documents', 'in my files', 'in my notes', 'from my documents', 'from my files', 'from my notes', 'in the sources', 'from the sources']),
  de: Object.freeze(['in meinen dokumenten', 'in meinen dateien', 'in meinen notizen', 'aus meinen dokumenten', 'aus meinen dateien', 'aus meinen notizen', 'in den quellen', 'aus den quellen']),
  fr: Object.freeze(['dans mes documents', 'dans mes fichiers', 'dans mes notes', 'à partir de mes documents', 'à partir de mes fichiers', 'à partir de mes notes', 'dans les sources']),
  es: Object.freeze(['en mis documentos', 'en mis archivos', 'en mis notas', 'de mis documentos', 'de mis archivos', 'de mis notas', 'en las fuentes', 'de las fuentes']),
  it: Object.freeze(['nei miei documenti', 'nei miei file', 'nelle mie note', 'dai miei documenti', 'dai miei file', 'dalle mie note', 'nelle fonti', 'dalle fonti']),
  tr: Object.freeze(['belgelerimde', 'dosyalarımda', 'notlarımda', 'belgelerimden', 'dosyalarımdan', 'notlarımdan', 'kaynaklarda', 'kaynaklardan']),
});

/**
 * How-to openers per language, on the output of `words` ("how do i …", "wie speichere ich …",
 * "comment puis-je …", "comment installer …", "¿cómo puedo …?", "come cercare …", "… nasıl
 * yapabilirim?"). Most languages open one with their question word and a modal or an infinitive;
 * Turkish puts "nasıl" before a verb in the first person or the passive, anywhere. An opener counts
 * only against a place phrase of its own language (`isHowTo`): "comment" and "come" are English
 * words as well ("Comment on the risks in my notes", "Come prepare a summary from my notes").
 */
const HOW_TO = Object.freeze({
  en: /^ (?:how (?:do|can|could|should|would|to) |is there a way )/u,
  de: /^ (?:wie (?:\p{L}+ )?(?:ich|man) |gibt es eine möglichkeit )/u,
  fr: /^ (?:comment (?:je |j |on |puis je |peut on |pourrais je |faut il |est ce que |est ce qu |(?!(?:votre|notre|leur) )\p{L}+(?:er|ir|re) )|y a t il un moyen |existe t il un moyen )/u,
  es: /^ (?:c[oó]mo (?:puedo |se |hago |debo |podr[ií]a |\p{L}+(?:ar|er|ir) )|hay (?:alguna|una) (?:forma|manera) )/u,
  it: /^ (?:come (?:posso |si |faccio |devo |potrei |\p{L}+(?:are|ere|ire) )|c è un modo |esiste un modo )/u,
  tr: / (?:nas[ıi]l (?:\p{L}+ )?\p{L}+(?:abilirim|ebilirim|abiliriz|ebiliriz|[ıiuü]r[ıiuü]m|[ae]r[ıi]m|[ıiuü]l[ıiuü]r|[ıiuü]n[ıiuü]r)|bir yolu var m[ıi]) /u,
});

/** Languages whose how-to openers cancel each other's place phrases: English and German, tuned together. */
const HOW_TO_PEERS = Object.freeze({ en: ['en', 'de'], de: ['en', 'de'] });

/** Languages whose phrases also match a question written without accents ("segun mis notas", "belgelerime gore"). */
const ACCENT_FREE = new Set(['fr', 'es', 'it', 'tr']);

/** @param {string} text  lower-cased words between single spaces, with a space at both ends */
const words = (text) => ` ${text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/** @param {string} text  `words` with Turkish capitals ("İ" → "i", "I" → "ı") */
const turkishWords = (text) => words(text.normalize('NFKC').replace(/İ/g, 'i').replace(/I/g, 'ı'));

/** @param {string} text  without accents and with the dotless i read as "i", for ACCENT_FREE languages */
const unaccented = (text) => text.normalize('NFD').replace(/\p{M}+/gu, '').replace(/ı/g, 'i');

/**
 * Whether a question holds one of the phrases of a list, per language: English and German as
 * written, the others also without accents, Turkish lowercased with its own dotted and dotless i.
 * @param {string} question
 * @param {Readonly<Record<string, readonly string[]>>} lists
 */
function holdsPhrase(question, lists) {
  const q = words(question);
  const tq = turkishWords(question);
  const plain = unaccented(q);
  const tplain = unaccented(tq);
  for (const [lang, list] of Object.entries(lists)) {
    const text = lang === 'tr' ? tq : q;
    const loose = ACCENT_FREE.has(lang) ? (lang === 'tr' ? tplain : plain) : null;
    for (const phrase of list) {
      if (text.includes(` ${phrase} `)) return true;
      if (loose !== null && loose.includes(` ${unaccented(phrase)} `)) return true;
    }
  }
  return false;
}

/**
 * Whether a question opens like a how-to question in a language: English and German as written
 * (each also with the other's openers), the others also without accents and with either Turkish i.
 * @param {string} question
 * @param {string} lang  a key of PLACE_PHRASES
 */
function isHowTo(question, lang) {
  const q = words(question);
  const peers = /** @type {Record<string, string[]>} */ (HOW_TO_PEERS)[lang];
  if (peers) return peers.some((l) => /** @type {Record<string, RegExp>} */ (HOW_TO)[l].test(q));
  const pattern = /** @type {Record<string, RegExp | undefined>} */ (HOW_TO)[lang];
  return !!pattern && (pattern.test(q) || pattern.test(unaccented(turkishWords(question))));
}

/**
 * Whether a question points at the user's files: one of the reference phrases, a place phrase in a
 * question that is not a how-to question, or the name of a document it can see (the whole name, or
 * a name of several words without its extension; a name under four characters does not count, nor
 * does a single common word such as "notes").
 * @param {string} question
 * @param {readonly string[]} [names]  document names in the workspace and the knowledge base
 */
export function namesSources(question, names = []) {
  const q = words(question);
  if (holdsPhrase(question, REFERENCE_PHRASES)) return true;
  for (const [lang, list] of Object.entries(PLACE_PHRASES)) if (holdsPhrase(question, { [lang]: list }) && !isHowTo(question, lang)) return true;
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
 * @property {number} [documents]             files in the workspace plus documents in the knowledge base; with 0, no
 *   reference, title or probe rule applies (left out: unknown, the rules apply)
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
    // b. What the question carries.
    const kinds = (input.attachments ?? []).map((a) => a.kind);
    const documents = kinds.some((k) => k !== 'image');
    if (documents) {
      route = stricter(route, 'grounded');
      reasons.push('attachment');
    } else if (kinds.length) {
      reasons.push('images_only');
    } else if (input.documents === 0) {
      // Nothing to answer from: what the question names cannot be in a source.
      reasons.push('no_sources');
    } else if (namesSources(input.question, input.names)) {
      // c. What it names.
      route = stricter(route, 'grounded');
      reasons.push('reference');
    } else if (namesTitle(input.question, input.titles)) {
      route = stricter(route, 'grounded');
      reasons.push('title');
    } else if (input.workspaceProbe && input.question.trim()) {
      // d. The workspace probe.
      try {
        probe = await input.workspaceProbe(input.question);
      } catch (err) {
        console.warn('[starpi] the workspace probe failed', err);
      }
      const byProbe = probeRoute(probe, input.thresholds);
      route = stricter(route, byProbe);
      reasons.push(byProbe === 'grounded' ? 'probe_strong' : byProbe === 'mixed' ? 'probe_weak' : 'probe_none');
    }
    // e. Nothing could answer: the sources are quoted (not for images, which have no text yet).
    if (input.modelReady === false && !(kinds.length && !documents)) {
      route = stricter(route, 'grounded');
      reasons.push('no_model');
    }
    // f. The Web toggle with a model that cannot search: a search API, then a pack.
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
 * The pages of a search answer as passages for a context pack, in the shape of library hits marked
 * as web passages (`web.url`, no library document id, so citations and receipts never take them for
 * the knowledge base): each page with the parts of the answer that rest on it (only those; a page
 * without one gives no passage, as nothing says what it contains).
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
    out.push({ documentId: null, documentTitle: (source.title || host).slice(0, 120), heading: host, content, tags: ['web'], rank: null, web: { url: source.uri } });
  });
  return out;
}


/** Results the search service is asked for per question. */
const SEARCH_API_RESULTS = 6;

/**
 * A search service (ai/search.js: Brave, Tavily or a SearXNG instance) as a WebSearch: each result's
 * snippet is the part of the answer that rests on its page, so webHits makes one passage per page.
 * @param {(query: string, count: number, signal?: AbortSignal) => Promise<Array<{ title: string, url: string, snippet: string }>>} search
 * @returns {import('../research/web-part.js').WebSearch}
 */
export function searchServiceWebSearch(search) {
  return async (query, signal) => {
    const results = await search(query, SEARCH_API_RESULTS, signal);
    let text = '';
    /** @type {import('../research/web-part.js').WebAnswer['segments']} */
    const segments = [];
    /** @type {import('../research/web-part.js').WebAnswer['sources']} */
    const sources = [];
    for (const r of results) {
      const snippet = String(r.snippet ?? '').trim();
      if (!snippet || !/^https?:\/\//i.test(r.url)) continue;
      if (text) text += '\n\n';
      segments.push({ start: text.length, end: text.length + snippet.length, sources: [sources.length] });
      text += snippet;
      sources.push({ uri: r.url, title: r.title });
    }
    return { text, segments, sources, queries: [query], suggestionsHtml: null };
  };
}

/**
 * The search API of this browser for questions to models that cannot search themselves: the search
 * service set up under Settings › Tools (ai/search.js), else a web search with the person's own key
 * at a provider that can (research/runtime.js picks it), else the site's search step when it offers
 * one; null when none is set up. Loaded on first use.
 * @param {string} locale
 * @returns {Promise<import('../research/web-part.js').WebSearch | null>}
 */
export async function browserWebSearch(locale) {
  try {
    const [search, keys] = await Promise.all([import('./search.js'), import('./keys.js')]);
    const settings = search.readSearchSettings();
    if (settings.provider !== 'off' && search.searchReady(settings, keys.getKey)) {
      const provider = settings.provider;
      return searchServiceWebSearch((query, count, signal) =>
        search.webSearch(query, { provider, key: provider === 'searxng' ? undefined : keys.getKey(provider), baseUrl: settings.searxngUrl, count, signal, access: () => keys.getKey(keys.ACCESS_SLOT) }),
      );
    }
  } catch (err) {
    console.warn('[starpi] the search service could not be set up', err);
  }
  try {
    const [{ browserRuntime }, { byokWebSearch, poolWebSearch }, { researchLocale }] = await Promise.all([import('../research/runtime.js'), import('../research/web-part.js'), import('../research/prompts.js')]);
    const runtime = browserRuntime();
    const routes = await runtime.routes();
    const lang = researchLocale(locale);
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
