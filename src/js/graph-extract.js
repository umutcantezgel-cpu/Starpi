// @ts-check
// Knowledge graph from the files in the workspace. The purpose extract_graph (ai/purposes.js) reads
// the documents' chunks in batches and names entities and the relations between them, each relation
// citing the chunk it comes from. Nothing a model says enters the graph unchecked: a relation stays
// only when the chunk it cites names both of its ends (every word of the subject and of the object
// matches the chunk the way the source check matches words, core/facts.js tokenMatches), and an
// entity only when a chunk of its batch names it. What fails is dropped and counted.
//
// Without a model (none set up, offline, or on-device mode without a loaded model) the graph links
// names written with capitals that appear in the same sentence ("appears with"), checked the same
// way. Either way every relation keeps the chunk it came from.
//
// Results are kept per document (settings store of the app database, key `graph.auto:<docId>`)
// with the document's text hash, so a changed or removed file takes its part with it. When the user
// keeps files in memory only, so are the results. loadMergedGraph() puts them next to the entities
// added by hand in the shared knowledge base, each marked auto or manual.
import { contentTokens, fold, guessLanguage, indexSource, tokenMatches } from './core/facts.js';
import { fromPacks } from './core/lang/index.js';
import { sentenceSpans } from './core/sentences.js';
import { CHUNKER, chunkText } from './rag/chunker.js';
import { range } from './store/idb.js';

/** @typedef {import('./store/idb.js').StoreDb} StoreDb */
/** @typedef {import('./rag/workspace.js').WorkspaceDocument} WorkspaceDocument */
/** @typedef {import('./core/facts.js').SourceIndex} SourceIndex */

/**
 * The chunk a relation comes from: a workspace document id and the chunk's index in it.
 * @typedef {{ doc: string, chunk: number }} Cite
 */
/** @typedef {{ doc: string, docName: string, chunk: number, text: string }} GraphChunk */
/** @typedef {'model' | 'cooccurrence'} TripleKind */
/**
 * A checked relation. A co-occurrence has no predicate of its own ('').
 * @typedef {{ subject: string, predicate: string, object: string, cite: Cite, quote?: string, kind: TripleKind }} Triple
 */
/** @typedef {{ name: string, type: string }} GraphEntity */
/** @typedef {{ relations: number, entities: number }} DropCount */
/** @typedef {'model' | 'cooccurrence' | 'mixed'} GraphMode */
/**
 * What was found in one document.
 * @typedef {object} DocGraph
 * @property {1} v
 * @property {string} docId
 * @property {string} docName
 * @property {string} textSha256  the document text it was read from
 * @property {GraphMode} mode     model: every chunk read by a model; cooccurrence: none; mixed: some
 * @property {number} at
 * @property {GraphEntity[]} entities
 * @property {Triple[]} triples
 * @property {DropCount} dropped  unsupported relations and entities left out
 */
/**
 * Asks a model about one batch of passages: the purpose's validated answer, or null when no model
 * answered (the router fell through to its template).
 * @typedef {(input: { passages: Array<{ doc: string, chunk: number, text: string }> }, signal?: AbortSignal) => Promise<{ value: unknown, model?: string | null } | null>} RunBatch
 */
/** @typedef {{ text: string, index: SourceIndex }} Passage */

/** Identifies these extraction rules in stored results. */
export const GRAPH_EXTRACT = Object.freeze({ id: 'starpi-graph', version: 1 });
/** The purpose that reads a batch. */
export const GRAPH_PURPOSE = 'extract_graph';
/** Key prefix of the stored results in the settings store. */
export const RECORD_PREFIX = 'graph.auto:';
/** Chunks and characters of one model call. */
export const BATCH_CHUNKS = 8;
export const BATCH_CHARS = 6_000;
/** Model calls one run starts at most; the documents left wait for the next run. */
export const MAX_RUN_BATCHES = 60;
/** Unanswered batches in a row after which the run stops asking a model. */
const MAX_MISSES = 2;
/** Names and links the co-occurrence fallback keeps per document (the most frequent ones). */
export const MAX_PHRASES_PER_DOC = 40;
export const MAX_COOCCURRENCES_PER_DOC = 60;
/** What one document keeps at most. */
const MAX_DOC_ENTITIES = 200;
const MAX_DOC_TRIPLES = 400;
/** Entities found in files the graph shows at most (the best connected ones). */
export const MAX_VIEW_AUTO_ENTITIES = 80;
/** Chunks a relation shown in the graph lists at most. */
const MAX_CITES = 5;

/**
 * The key two spellings of one name share: folded (case, umlauts, typography), words only.
 * @param {string} name
 */
export function nameKey(name) {
  return fold(String(name ?? ''))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** @param {Cite} cite */
const citeKey = (cite) => `${cite.doc}#${cite.chunk}`;

/**
 * A chunk prepared for checks.
 * @param {string} text
 * @returns {Passage}
 */
export function passageOf(text) {
  return { text, index: indexSource(text) };
}

/**
 * Whether a passage names a thing: every content word of the name matches a word of the passage
 * (inflection tolerated as in the source check), and every word with a digit appears as it is.
 * A name without content words ("2026", a function word) must appear as a whole.
 * @param {string} name
 * @param {Passage} passage
 */
export function namedIn(name, passage) {
  const words = nameKey(name).split(' ').filter(Boolean);
  if (words.length === 0) return false;
  const numbered = words.filter((w) => /\p{N}/u.test(w));
  if (!numbered.every((w) => passage.index.words.includes(` ${w} `))) return false;
  const tokens = contentTokens(name);
  if (tokens.length) return tokens.every((t) => tokenMatches(t, passage.index));
  return numbered.length > 0 || passage.index.words.includes(` ${words.join(' ')} `);
}

/**
 * Checks one relation against the passage it cites.
 * @param {Triple} triple
 * @param {Map<string, Passage>} passages  by `doc#chunk`
 * @returns {'cite' | 'same' | 'subject' | 'object' | null}  why it is not supported, or null
 */
export function checkTriple(triple, passages) {
  const passage = passages.get(citeKey(triple.cite));
  if (!passage) return 'cite';
  if (nameKey(triple.subject) === nameKey(triple.object)) return 'same';
  if (!namedIn(triple.subject, passage)) return 'subject';
  if (!namedIn(triple.object, passage)) return 'object';
  return null;
}

/**
 * Whether `quote` appears in `source`, ignoring case and white space.
 * @param {string} quote
 * @param {string} source
 */
function quotedIn(quote, source) {
  const squash = (/** @type {string} */ s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const q = squash(quote);
  return q.length > 0 && squash(source).includes(q);
}

// ---------------------------------------------------------------------------------------------
// Batches and the model's answer
// ---------------------------------------------------------------------------------------------

/**
 * One model call: its chunks, the short document labels the model cites ("d1", "d2", …) and the
 * prepared passages.
 * @typedef {object} Batch
 * @property {GraphChunk[]} chunks
 * @property {Map<string, string>} docOf    label → document id
 * @property {Map<string, string>} labelOf  document id → label
 * @property {Map<string, Passage>} passages  by `docId#chunk`, prepared when the batch is checked
 */

/**
 * Splits chunks, in order, into batches of at most `maxChunks` chunks and about `maxChars`
 * characters (a single longer chunk is a batch of its own).
 * @param {readonly GraphChunk[]} chunks
 * @param {{ maxChunks?: number, maxChars?: number }} [options]
 * @returns {Batch[]}
 */
export function makeBatches(chunks, options = {}) {
  const maxChunks = Math.max(1, options.maxChunks ?? BATCH_CHUNKS);
  const maxChars = Math.max(1, options.maxChars ?? BATCH_CHARS);
  /** @type {GraphChunk[][]} */
  const groups = [];
  let current = /** @type {GraphChunk[]} */ ([]);
  let chars = 0;
  for (const chunk of chunks) {
    if (current.length && (current.length >= maxChunks || chars + chunk.text.length > maxChars)) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    current.push(chunk);
    chars += chunk.text.length;
  }
  if (current.length) groups.push(current);
  return groups.map((group) => {
    /** @type {Map<string, string>} */
    const labelOf = new Map();
    for (const c of group) if (!labelOf.has(c.doc)) labelOf.set(c.doc, `d${labelOf.size + 1}`);
    /** @type {Map<string, Passage> | null} */
    let passages = null;
    return {
      chunks: group,
      labelOf,
      docOf: new Map([...labelOf].map(([doc, label]) => [label, doc])),
      get passages() {
        passages ??= new Map(group.map((c) => [citeKey(c), passageOf(c.text)]));
        return passages;
      },
    };
  });
}

/**
 * The purpose input of a batch.
 * @param {Batch} batch
 */
export function batchInput(batch) {
  return { passages: batch.chunks.map((c) => ({ doc: /** @type {string} */ (batch.labelOf.get(c.doc)), chunk: c.chunk, text: c.text })) };
}

/**
 * What a batch adds to each of its documents.
 * @typedef {{ entities: Map<string, GraphEntity>, triples: Triple[], dropped: DropCount }} DocPart
 */

/** @returns {DocPart} */
const emptyPart = () => ({ entities: new Map(), triples: [], dropped: { relations: 0, entities: 0 } });

/**
 * @param {Map<string, GraphEntity>} entities
 * @param {string} name
 * @param {string} type
 */
function addEntity(entities, name, type) {
  const key = nameKey(name);
  if (!key) return;
  const known = entities.get(key);
  if (!known) entities.set(key, { name: name.trim(), type });
  else if (known.type === 'other' && type !== 'other') known.type = type;
}

/**
 * Checks a model's answer for a batch. A relation stays when the passage it cites names both of its
 * ends; an entity when a passage of the batch names it (it belongs to every document that does).
 * Everything else is dropped and counted: against the cited document, or the batch's first
 * document when the cite names none of the batch.
 * @param {unknown} answer  the validated value of extract_graph for batchInput(batch)
 * @param {Batch} batch
 * @returns {{ parts: Map<string, DocPart>, dropped: DropCount, reasons: Record<string, number> }}
 */
export function verifyAnswer(answer, batch) {
  const a = /** @type {{ entities?: unknown, relations?: unknown }} */ (answer && typeof answer === 'object' ? answer : {});
  const entities = /** @type {Array<{ name?: unknown, type?: unknown }>} */ (Array.isArray(a.entities) ? a.entities : []);
  const relations = /** @type {Array<{ from?: unknown, to?: unknown, label?: unknown, quote?: unknown, cite?: { doc?: unknown, chunk?: unknown } }>} */ (Array.isArray(a.relations) ? a.relations : []);
  /** @type {Map<string, DocPart>} */
  const parts = new Map();
  const part = (/** @type {string} */ doc) => {
    let p = parts.get(doc);
    if (!p) parts.set(doc, (p = emptyPart()));
    return p;
  };
  const first = batch.chunks[0]?.doc ?? '';
  /** @type {Record<string, number>} */
  const reasons = {};
  const dropped = { relations: 0, entities: 0 };
  /** @type {Map<string, string>} */
  const types = new Map();
  for (const e of entities) if (typeof e.name === 'string' && typeof e.type === 'string' && !types.has(nameKey(e.name))) types.set(nameKey(e.name), e.type);
  const typeOf = (/** @type {string} */ name) => types.get(nameKey(name)) ?? 'other';

  for (const r of relations) {
    if (typeof r.from !== 'string' || typeof r.to !== 'string' || typeof r.label !== 'string') continue;
    const doc = typeof r.cite?.doc === 'string' ? batch.docOf.get(r.cite.doc.trim()) : undefined;
    const chunk = Number.isInteger(r.cite?.chunk) ? /** @type {number} */ (r.cite?.chunk) : -1;
    /** @type {Triple} */
    const triple = { subject: r.from.trim(), predicate: r.label.trim(), object: r.to.trim(), cite: { doc: doc ?? '', chunk }, kind: 'model' };
    const reason = doc === undefined ? 'cite' : checkTriple(triple, batch.passages);
    if (reason) {
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      dropped.relations += 1;
      part(doc ?? first).dropped.relations += 1;
      continue;
    }
    const target = part(/** @type {string} */ (doc));
    const passage = /** @type {Passage} */ (batch.passages.get(citeKey(triple.cite)));
    if (typeof r.quote === 'string' && quotedIn(r.quote, passage.text)) triple.quote = r.quote.trim().slice(0, 400);
    target.triples.push(triple);
    addEntity(target.entities, triple.subject, typeOf(triple.subject));
    addEntity(target.entities, triple.object, typeOf(triple.object));
  }

  for (const e of entities) {
    if (typeof e.name !== 'string' || typeof e.type !== 'string' || !nameKey(e.name)) continue;
    const docs = new Set(batch.chunks.filter((c) => namedIn(/** @type {string} */ (e.name), /** @type {Passage} */ (batch.passages.get(citeKey(c))))).map((c) => c.doc));
    if (docs.size === 0) {
      reasons.entity = (reasons.entity ?? 0) + 1;
      dropped.entities += 1;
      part(first).dropped.entities += 1;
      continue;
    }
    for (const doc of docs) addEntity(part(doc).entities, e.name, e.type);
  }
  return { parts, dropped, reasons };
}

// ---------------------------------------------------------------------------------------------
// Without a model: names that appear together
// ---------------------------------------------------------------------------------------------

/** Function words, month and weekday names of every language pack: never a name on their own. */
const commonWords = fromPacks((packs) => new Set(packs.flatMap((p) => [...p.stopwords, ...Object.keys(p.months), ...Object.keys(p.weekdays)].map((w) => fold(w)))));
/** Lowercase words that may join two capitalised words of one English name ("Bank of England"). */
const PARTICLES_EN = new Set(['of', 'de', 'da', 'di', 'du', 'del', 'della', 'van', 'von', 'la', 'le']);
/**
 * German capitalises every noun, so a single capitalised word after one of these is a noun, not a
 * name ("das Projekt"); names rarely take them.
 */
const DETERMINERS_DE = new Set(
  'der die das den dem des ein eine einen einem einer eines kein keine keinen keinem keiner keines dieser diese dieses diesem diesen jeder jede jedes jedem jeden mein meine meinem meinen meiner sein seine seinem seinen seiner ihr ihre ihrem ihren ihrer unser unsere unserem unseren unserer zum zur im am vom beim'.split(' '),
);
const WORD = /[\p{L}\p{N}][\p{L}\p{M}\p{N}'’]*(?:-[\p{L}\p{M}\p{N}]+)*/gu;
/** Longer runs of capitalised words are headings or titles, not names. */
const MAX_PHRASE_WORDS = 5;

/** @param {string} word */
const capitalised = (word) => /^\p{Lu}/u.test(word) || /^\p{Ll}+\p{Lu}/u.test(word);

/**
 * One occurrence of a capitalised name in a sentence.
 * @typedef {{ key: string, surface: string, initial: boolean, single: boolean, afterDeterminer: boolean }} PhraseHit
 */

/**
 * The runs of capitalised words in a sentence ("Mara Jensen", "Bank of England", "Windows 11"),
 * without leading or trailing function words; a run of only function words, months or weekdays is
 * none.
 * @param {string} sentence
 * @param {{ particles?: ReadonlySet<string> }} [options]
 * @returns {PhraseHit[]}
 */
export function capitalisedPhrases(sentence, options = {}) {
  const particles = options.particles ?? PARTICLES_EN;
  const common = commonWords();
  const words = [...sentence.matchAll(WORD)].map((m) => ({ text: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  /** @type {PhraseHit[]} */
  const out = [];
  let i = 0;
  while (i < words.length) {
    if (!capitalised(words[i].text)) {
      i += 1;
      continue;
    }
    // Extend the run over capitalised words, numbers after them, and particles between two
    // capitalised words; punctuation or a line break ends it.
    let j = i;
    while (j + 1 < words.length) {
      const next = words[j + 1];
      if (!/^[ \t]+$/.test(sentence.slice(words[j].end, next.start))) break;
      if (capitalised(next.text) || /^\p{N}/u.test(next.text)) j += 1;
      else if (particles.has(next.text) && j + 2 < words.length && capitalised(words[j + 2].text) && /^[ \t]+$/.test(sentence.slice(next.end, words[j + 2].start))) j += 2;
      else break;
    }
    let s = i;
    let e = j;
    while (s <= e && common.has(fold(words[s].text))) s += 1;
    while (e >= s && (common.has(fold(words[e].text)) || particles.has(words[e].text))) e -= 1;
    const run = words.slice(s, e + 1);
    const named = run.filter((w) => !/^\p{N}/u.test(w.text) && !common.has(fold(w.text)));
    if (named.length && run.length <= MAX_PHRASE_WORDS && !/^\p{N}/u.test(run[0].text)) {
      const surface = sentence.slice(run[0].start, run[run.length - 1].end);
      const before = s > 0 ? fold(words[s - 1].text) : '';
      out.push({ key: nameKey(surface), surface, initial: s === 0, single: run.length === 1, afterDeterminer: DETERMINERS_DE.has(before) });
    }
    i = j + 1;
  }
  return out;
}

/**
 * The co-occurrence graph of one document: capitalised names (the most frequent ones) linked when
 * they appear in the same sentence. A single word at the start of a sentence counts only where the
 * document also writes it capitalised inside a sentence; in German text, where every noun is
 * capitalised, a single word the document puts after an article anywhere counts not at all. Every
 * link cites the first chunk it was seen in and is checked like a model's relation.
 * @param {readonly GraphChunk[]} chunks  one document's chunks
 * @returns {DocPart}
 */
export function cooccurrenceGraph(chunks) {
  const result = emptyPart();
  if (!chunks.length) return result;
  const german = guessLanguage(chunks.slice(0, 4).map((c) => c.text).join('\n')) === 'de';
  const particles = german ? new Set() : PARTICLES_EN;
  /** @type {Array<{ chunk: GraphChunk, hits: PhraseHit[] }>} */
  const sentences = [];
  /** Names the document writes capitalised inside a sentence. */
  const inside = new Set();
  /** German: single words the document puts after an article somewhere (nouns). */
  const articled = new Set();
  for (const chunk of chunks) {
    for (const span of sentenceSpans(chunk.text)) {
      const hits = capitalisedPhrases(chunk.text.slice(span.start, span.end), { particles });
      for (const h of hits) {
        if (!h.initial) inside.add(h.key);
        if (german && h.single && h.afterDeterminer) articled.add(h.key);
      }
      sentences.push({ chunk, hits });
    }
  }
  const counts = /** @type {Map<string, { surface: string, sentences: number, order: number }>} */ (new Map());
  const kept = sentences.map(({ chunk, hits }) => {
    const keys = new Set();
    for (const h of hits) {
      if (h.single && h.initial && !inside.has(h.key)) continue;
      if (h.single && articled.has(h.key)) continue;
      if (keys.has(h.key)) continue;
      keys.add(h.key);
      const c = counts.get(h.key);
      if (c) c.sentences += 1;
      else counts.set(h.key, { surface: h.surface, sentences: 1, order: counts.size });
    }
    return { chunk, keys: [...keys] };
  });
  const top = new Set(
    [...counts]
      .sort((a, b) => b[1].sentences - a[1].sentences || a[1].order - b[1].order)
      .slice(0, MAX_PHRASES_PER_DOC)
      .map(([key]) => key),
  );
  /** @type {Map<string, { a: string, b: string, count: number, order: number, cite: Cite }>} */
  const pairs = new Map();
  for (const { chunk, keys } of kept) {
    const present = keys.filter((k) => top.has(k)).slice(0, 8);
    for (let x = 0; x < present.length; x += 1) {
      for (let y = x + 1; y < present.length; y += 1) {
        const [a, b] = [present[x], present[y]].sort();
        const id = `${a}|${b}`;
        const known = pairs.get(id);
        if (known) known.count += 1;
        else pairs.set(id, { a, b, count: 1, order: pairs.size, cite: { doc: chunk.doc, chunk: chunk.chunk } });
      }
    }
  }
  const passages = new Map(chunks.map((c) => [citeKey(c), passageOf(c.text)]));
  const surface = (/** @type {string} */ key) => /** @type {{ surface: string }} */ (counts.get(key)).surface;
  for (const p of [...pairs.values()].sort((x, y) => y.count - x.count || x.order - y.order).slice(0, MAX_COOCCURRENCES_PER_DOC)) {
    /** @type {Triple} */
    const triple = { subject: surface(p.a), predicate: '', object: surface(p.b), cite: p.cite, kind: 'cooccurrence' };
    if (checkTriple(triple, passages)) {
      result.dropped.relations += 1;
      continue;
    }
    result.triples.push(triple);
    addEntity(result.entities, triple.subject, 'other');
    addEntity(result.entities, triple.object, 'other');
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// A run over documents
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} ExtractReport
 * @property {DocGraph[]} graphs       one per document finished in this run
 * @property {number} pending          documents that needed reading
 * @property {number} deferred         documents left for the next run (the run's call limit)
 * @property {boolean} cancelled
 * @property {number} batches          model calls made
 * @property {number} answered         batches a model answered
 * @property {DropCount} dropped       left out in this run
 * @property {Record<string, number>} reasons  why model relations were left out (cite, same, subject, object, entity)
 * @property {boolean} modelUsed       a model answered at least one batch
 */

/**
 * Reads documents into per-document graphs. With `run`, chunks go to the model in batches; a
 * document every chunk of which a model read is 'model'. Without a model, or once it stops
 * answering, the remaining documents get the co-occurrence graph ('mixed' where a model had read
 * some of their chunks). Cancelling keeps the documents already finished.
 * @param {ReadonlyArray<{ docId: string, name: string, textSha256: string, chunks: readonly GraphChunk[] }>} docs
 * @param {{ run?: RunBatch | null, signal?: AbortSignal, onProgress?: (p: { done: number, total: number }) => void, maxBatches?: number, now?: () => number, batch?: { maxChunks?: number, maxChars?: number } }} [options]
 * @returns {Promise<ExtractReport>}
 */
export async function extractDocs(docs, options = {}) {
  const now = options.now ?? Date.now;
  const total = docs.reduce((n, d) => n + d.chunks.length, 0);
  let done = 0;
  const progress = () => options.onProgress?.({ done, total });
  /** @type {ExtractReport} */
  const report = { graphs: [], pending: docs.length, deferred: 0, cancelled: false, batches: 0, answered: 0, dropped: { relations: 0, entities: 0 }, reasons: {}, modelUsed: false };
  /** @type {Map<string, DocPart>} */
  const modelParts = new Map();
  /** @type {Map<string, number>} chunks of each document a model read */
  const read = new Map();
  let modelAvailable = Boolean(options.run);
  /** Documents with chunks in batches the call limit left unread. */
  const cutOff = new Set();
  progress();

  if (options.run) {
    const batches = makeBatches(
      docs.flatMap((d) => d.chunks),
      options.batch,
    );
    const limit = Math.max(1, options.maxBatches ?? MAX_RUN_BATCHES);
    let misses = 0;
    for (let i = 0; i < batches.length; i += 1) {
      if (options.signal?.aborted) {
        report.cancelled = true;
        break;
      }
      if (report.batches >= limit) {
        for (const b of batches.slice(i)) for (const c of b.chunks) cutOff.add(c.doc);
        break;
      }
      const batch = batches[i];
      report.batches += 1;
      /** @type {{ value: unknown } | null} */
      let answer = null;
      try {
        answer = await options.run(batchInput(batch), options.signal);
      } catch (err) {
        if (options.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
          report.cancelled = true;
          break;
        }
        console.warn('[starpi] graph extraction: a batch failed', err);
      }
      if (!answer) {
        misses += 1;
        if (misses >= MAX_MISSES) {
          modelAvailable = false;
          break;
        }
        continue;
      }
      misses = 0;
      report.answered += 1;
      report.modelUsed = true;
      const checked = verifyAnswer(answer.value, batch);
      report.dropped.relations += checked.dropped.relations;
      report.dropped.entities += checked.dropped.entities;
      for (const [k, n] of Object.entries(checked.reasons)) report.reasons[k] = (report.reasons[k] ?? 0) + n;
      for (const [doc, p] of checked.parts) mergePart(modelParts, doc, p);
      for (const c of batch.chunks) read.set(c.doc, (read.get(c.doc) ?? 0) + 1);
      done += batch.chunks.length;
      progress();
    }
  }

  // A document is finished when a model read all of it, or when no model will: then the
  // co-occurrence graph covers it. Documents the call limit cut off wait for the next run.
  for (const doc of docs) {
    if (options.signal?.aborted) report.cancelled = true;
    const byModel = read.get(doc.docId) ?? 0;
    const complete = options.run ? byModel >= doc.chunks.length : doc.chunks.length === 0;
    if (!complete && report.cancelled) continue;
    if (!complete && modelAvailable && cutOff.has(doc.docId)) {
      report.deferred += 1;
      continue;
    }
    const part = modelParts.get(doc.docId) ?? emptyPart();
    /** @type {GraphMode} */
    let mode = options.run ? 'model' : 'cooccurrence';
    if (!complete) {
      const fallback = cooccurrenceGraph(doc.chunks);
      mergeInto(part, fallback);
      report.dropped.relations += fallback.dropped.relations;
      mode = byModel > 0 ? 'mixed' : 'cooccurrence';
      done += doc.chunks.length - byModel;
      progress();
    }
    report.graphs.push(toDocGraph(doc, part, mode, now()));
  }
  return report;
}

/**
 * @param {Map<string, DocPart>} parts
 * @param {string} doc
 * @param {DocPart} add
 */
function mergePart(parts, doc, add) {
  const p = parts.get(doc);
  if (p) mergeInto(p, add);
  else parts.set(doc, add);
}

/**
 * @param {DocPart} target
 * @param {DocPart} add
 */
function mergeInto(target, add) {
  for (const e of add.entities.values()) addEntity(target.entities, e.name, e.type);
  target.triples.push(...add.triples);
  target.dropped.relations += add.dropped.relations;
  target.dropped.entities += add.dropped.entities;
}

/**
 * @param {{ docId: string, name: string, textSha256: string }} doc
 * @param {DocPart} part
 * @param {GraphMode} mode
 * @param {number} at
 * @returns {DocGraph}
 */
function toDocGraph(doc, part, mode, at) {
  /** @type {Map<string, Triple>} */
  const triples = new Map();
  for (const t of part.triples) {
    const id = t.kind === 'cooccurrence' ? `~|${[nameKey(t.subject), nameKey(t.object)].sort().join('|')}` : `${nameKey(t.subject)}|${nameKey(t.predicate)}|${nameKey(t.object)}`;
    if (!triples.has(id)) triples.set(id, t);
  }
  return {
    v: 1,
    docId: doc.docId,
    docName: doc.name,
    textSha256: doc.textSha256,
    mode,
    at,
    entities: [...part.entities.values()].slice(0, MAX_DOC_ENTITIES),
    triples: [...triples.values()].slice(0, MAX_DOC_TRIPLES),
    dropped: { ...part.dropped },
  };
}

// ---------------------------------------------------------------------------------------------
// Workspace documents and their chunks
// ---------------------------------------------------------------------------------------------

/**
 * A document's chunks: the ones the workspace keeps in the app database, or, for a document kept in
 * memory only, the same chunks again from its text (the chunker is deterministic and the document
 * records its settings). [] when neither works.
 * @param {WorkspaceDocument} doc
 * @param {{ openDb?: (() => Promise<StoreDb>) | null, text?: ((docId: string) => Promise<{ text: string }>) | null }} sources
 * @returns {Promise<GraphChunk[]>}
 */
export async function readDocChunks(doc, sources) {
  if (doc.stored !== false && sources.openDb) {
    try {
      const db = await sources.openDb();
      if (db.persistent) {
        const rows = /** @type {import('./store/schema.js').ChunkRecord[]} */ (await db.getAllFromIndex('chunks', 'docId', doc.docId));
        if (rows.length > 0 && rows.length === doc.chunks) return rows.sort((a, b) => a.idx - b.idx).map((r) => ({ doc: doc.docId, docName: doc.name, chunk: r.idx, text: r.text }));
      }
    } catch (err) {
      console.warn('[starpi] graph extraction: stored chunks could not be read', err);
    }
  }
  if (!sources.text || doc.chunker?.id !== CHUNKER.id || doc.chunker.version !== CHUNKER.version) return [];
  const { text } = await sources.text(doc.docId);
  return chunkText(text, { chunkSize: doc.chunker.size, chunkOverlap: doc.chunker.overlap }).map((c) => ({ doc: doc.docId, docName: doc.name, chunk: c.index, text: c.text }));
}

/**
 * Whether a document needs reading in a run: no result for its current text yet, or a result that
 * was not (or not wholly) a model's while this run has one.
 * @param {WorkspaceDocument} doc
 * @param {DocGraph | undefined} stored
 * @param {boolean} withModel
 */
export function needsReading(doc, stored, withModel) {
  if (!stored || stored.textSha256 !== doc.textSha256) return true;
  return withModel && stored.mode !== 'model';
}

// ---------------------------------------------------------------------------------------------
// Keeping results
// ---------------------------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {value is DocGraph}
 */
function isDocGraph(value) {
  const v = /** @type {Partial<DocGraph>} */ (value);
  return Boolean(v) && v.v === 1 && typeof v.docId === 'string' && typeof v.textSha256 === 'string' && Array.isArray(v.entities) && Array.isArray(v.triples);
}

/**
 * @typedef {object} GraphStore
 * @property {() => Promise<DocGraph[]>} load
 * @property {(graphs: readonly DocGraph[], options: { persist: boolean }) => Promise<void>} save
 *   persist false: in memory only (the user keeps files in memory only), and any stored copy goes
 * @property {(docIds: readonly string[]) => Promise<void>} remove
 * @property {() => Promise<void>} clear
 */

/**
 * The per-document results: in the app database's settings store, or in memory.
 * @param {{ openDb?: (() => Promise<StoreDb>) | null, now?: () => number }} [options]  openDb null: memory only
 * @returns {GraphStore}
 */
export function createGraphStore(options = {}) {
  const now = options.now ?? Date.now;
  /** @type {Map<string, DocGraph>} */
  const memory = new Map();
  const db = async () => {
    if (!options.openDb) return null;
    try {
      const d = await options.openDb();
      return d.persistent ? d : null;
    } catch {
      return null;
    }
  };
  /** @param {readonly string[]} docIds */
  const unstore = async (docIds) => {
    const d = await db();
    if (!d || !docIds.length) return;
    await d.transaction('settings', 'readwrite', async (tx) => {
      await Promise.all(docIds.map((id) => tx.delete('settings', RECORD_PREFIX + id)));
    });
  };
  return {
    async load() {
      const d = await db();
      const stored = d ? /** @type {Array<{ value: unknown }>} */ (await d.getAll('settings', range.startsWith(RECORD_PREFIX)).catch(() => [])) : [];
      /** @type {Map<string, DocGraph>} */
      const out = new Map();
      for (const r of stored) if (isDocGraph(r.value)) out.set(r.value.docId, r.value);
      for (const [id, g] of memory) out.set(id, g);
      return [...out.values()];
    },
    async save(graphs, { persist }) {
      if (!graphs.length) return;
      const d = persist ? await db() : null;
      if (d) {
        for (const g of graphs) memory.delete(g.docId);
        await d.putMany(
          'settings',
          graphs.map((g) => ({ key: RECORD_PREFIX + g.docId, value: g, updatedAt: now() })),
        );
        return;
      }
      for (const g of graphs) memory.set(g.docId, g);
      await unstore(graphs.map((g) => g.docId)).catch(() => {});
    },
    async remove(docIds) {
      for (const id of docIds) memory.delete(id);
      await unstore(docIds);
    },
    async clear() {
      const ids = (await this.load()).map((g) => g.docId);
      memory.clear();
      await unstore(ids);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The graph shown: found in files, next to entities added by hand
// ---------------------------------------------------------------------------------------------

/** @typedef {{ id: string, name: string, entity_type: string, description: string | null }} ManualEntity */
/** @typedef {{ source_entity_id: string, target_entity_id: string, relation_type: string }} ManualRelation */
/**
 * An entity of the graph view. origin: manual (the shared knowledge base), auto (found in files) or
 * both (added by hand and also found in files).
 * @typedef {ManualEntity & { origin: 'manual' | 'auto' | 'both', docs: string[] }} ViewEntity
 */
/**
 * A relation of the graph view. An auto relation lists the chunks it was found in.
 * @typedef {ManualRelation & { origin: 'manual' | 'auto', kind?: TripleKind, cites?: Array<Cite & { docName: string }>, quote?: string }} ViewRelation
 */
/**
 * @typedef {object} AutoSummary
 * @property {number} docs        documents with a result
 * @property {number} entities    entities found (before the view's limit)
 * @property {number} relations
 * @property {number} hidden      entities found that the view leaves out (its limit)
 * @property {DropCount} dropped
 * @property {Record<GraphMode, number>} modes  documents per mode
 * @property {Record<string, string>} docNames  document id → name
 */

/**
 * The results of the documents that are still in the workspace with the same text.
 * @param {readonly DocGraph[]} graphs
 * @param {ReadonlyArray<{ docId: string, textSha256: string }>} docs
 * @returns {{ live: DocGraph[], stale: string[] }}
 */
export function liveGraphs(graphs, docs) {
  const current = new Map(docs.map((d) => [d.docId, d.textSha256]));
  /** @type {DocGraph[]} */
  const live = [];
  /** @type {string[]} */
  const stale = [];
  for (const g of graphs) {
    if (current.get(g.docId) === g.textSha256) live.push(g);
    else stale.push(g.docId);
  }
  return { live, stale };
}

/**
 * Puts the entities found in files next to the ones added by hand. An entity found in files with
 * the name of one added by hand is that entity (origin both); the others get ids of their own
 * ("auto:<name>"). A relation found in files that one added by hand already states is left out, and
 * so is a co-occurrence between two entities another relation already links. The view keeps the
 * best connected entities found in files (MAX_VIEW_AUTO_ENTITIES).
 * @param {{ entities: readonly ManualEntity[], relations: readonly ManualRelation[] }} manual
 * @param {readonly DocGraph[]} graphs
 * @param {{ maxAuto?: number }} [options]
 * @returns {{ entities: ViewEntity[], relations: ViewRelation[], summary: AutoSummary }}
 */
export function mergeGraphs(manual, graphs, options = {}) {
  const maxAuto = options.maxAuto ?? MAX_VIEW_AUTO_ENTITIES;
  /** @type {ViewEntity[]} */
  const entities = manual.entities.map((e) => ({ ...e, origin: 'manual', docs: [] }));
  /** @type {Map<string, ViewEntity>} */
  const byKey = new Map();
  for (const e of entities) if (!byKey.has(nameKey(e.name))) byKey.set(nameKey(e.name), e);
  /** @type {ViewRelation[]} */
  const relations = manual.relations.map((r) => ({ ...r, origin: 'manual' }));

  // Everything found in files, merged across documents.
  /** @type {Map<string, { name: string, type: string, docs: Set<string> }>} */
  const found = new Map();
  /** @type {Map<string, { a: string, b: string, predicate: string, kind: TripleKind, cites: Array<Cite & { docName: string }>, quote?: string }>} */
  const links = new Map();
  /** @type {AutoSummary} */
  const summary = { docs: graphs.length, entities: 0, relations: 0, hidden: 0, dropped: { relations: 0, entities: 0 }, modes: { model: 0, cooccurrence: 0, mixed: 0 }, docNames: {} };
  const note = (/** @type {string} */ name, /** @type {string} */ type, /** @type {string} */ doc) => {
    const key = nameKey(name);
    if (!key) return;
    const f = found.get(key);
    if (!f) found.set(key, { name, type, docs: new Set([doc]) });
    else {
      f.docs.add(doc);
      if (f.type === 'other' && type !== 'other') f.type = type;
    }
  };
  for (const g of graphs) {
    summary.docNames[g.docId] = g.docName;
    summary.modes[g.mode] = (summary.modes[g.mode] ?? 0) + 1;
    summary.dropped.relations += g.dropped?.relations ?? 0;
    summary.dropped.entities += g.dropped?.entities ?? 0;
    for (const e of g.entities) note(e.name, e.type, g.docId);
    for (const t of g.triples) {
      const [a, b] = [nameKey(t.subject), nameKey(t.object)];
      if (!a || !b || a === b) continue;
      note(t.subject, 'other', g.docId);
      note(t.object, 'other', g.docId);
      const ends = t.kind === 'cooccurrence' ? [a, b].sort() : [a, b];
      const id = t.kind === 'cooccurrence' ? `~|${ends.join('|')}` : `${a}|${nameKey(t.predicate)}|${b}`;
      const cite = { ...t.cite, docName: g.docName };
      const link = links.get(id);
      if (!link) links.set(id, { a: ends[0], b: ends[1], predicate: t.predicate, kind: t.kind, cites: [cite], ...(t.quote ? { quote: t.quote } : {}) });
      else if (link.cites.length < MAX_CITES && !link.cites.some((c) => c.doc === cite.doc && c.chunk === cite.chunk)) link.cites.push(cite);
    }
  }
  summary.entities = found.size;
  summary.relations = links.size;

  // The best connected entities found in files; those added by hand are always there.
  /** @type {Map<string, number>} */
  const degree = new Map();
  for (const l of links.values()) for (const k of [l.a, l.b]) degree.set(k, (degree.get(k) ?? 0) + (l.kind === 'model' ? 2 : 1));
  const autoKeys = [...found.keys()].filter((k) => !byKey.has(k));
  const shownAuto = new Set(
    autoKeys
      .map((k, order) => ({ k, order }))
      .sort((x, y) => (degree.get(y.k) ?? 0) - (degree.get(x.k) ?? 0) || x.order - y.order)
      .slice(0, Math.max(0, maxAuto))
      .map((x) => x.k),
  );
  for (const [key, f] of found) {
    const known = byKey.get(key);
    if (known) {
      if (known.origin === 'manual') known.origin = 'both';
      known.docs = [...new Set([...known.docs, ...f.docs])];
      continue;
    }
    if (!shownAuto.has(key)) continue;
    /** @type {ViewEntity} */
    const entity = { id: `auto:${key}`, name: f.name, entity_type: f.type, description: null, origin: 'auto', docs: [...f.docs] };
    entities.push(entity);
    byKey.set(key, entity);
  }
  summary.hidden = autoKeys.length - shownAuto.size;

  const stated = new Set(relations.map((r) => `${r.source_entity_id}|${nameKey(r.relation_type)}|${r.target_entity_id}`));
  const linked = new Set(relations.flatMap((r) => [`${r.source_entity_id}|${r.target_entity_id}`, `${r.target_entity_id}|${r.source_entity_id}`]));
  const ordered = [...links.values()].sort((x, y) => Number(x.kind === 'cooccurrence') - Number(y.kind === 'cooccurrence'));
  for (const l of ordered) {
    const source = byKey.get(l.a);
    const target = byKey.get(l.b);
    if (!source || !target || source === target) continue;
    const pair = `${source.id}|${target.id}`;
    if (l.kind === 'cooccurrence' ? linked.has(pair) : stated.has(`${source.id}|${nameKey(l.predicate)}|${target.id}`)) continue;
    relations.push({ source_entity_id: source.id, target_entity_id: target.id, relation_type: l.predicate, origin: 'auto', kind: l.kind, cites: l.cites, ...(l.quote ? { quote: l.quote } : {}) });
    linked.add(pair);
    linked.add(`${target.id}|${source.id}`);
  }
  return { entities, relations, summary };
}

/**
 * @typedef {object} MergedGraph
 * @property {ViewEntity[]} entities
 * @property {ViewRelation[]} relations
 * @property {AutoSummary} summary
 * @property {import('./supabase.js').DataError | null} manualError  why the shared knowledge base gave nothing, or null
 */

/**
 * Loads the graph view's data: the entities and relations added by hand (the shared knowledge
 * base) and the results found in the workspace documents, merged. Results of documents that are
 * gone or changed are removed from the store when `docs` is known.
 * @param {object} deps
 * @param {() => Promise<{ ok: boolean, data?: ManualEntity[] | null, error?: any }>} deps.listEntities
 * @param {() => Promise<{ ok: boolean, data?: ManualRelation[] | null, error?: any }>} deps.listRelations
 * @param {GraphStore} deps.store
 * @param {ReadonlyArray<{ docId: string, textSha256: string }> | null} deps.docs  the workspace documents; null while unknown (nothing is removed)
 * @returns {Promise<MergedGraph>}
 */
export async function loadMergedGraph(deps) {
  const [entRes, relRes, graphs] = await Promise.all([deps.listEntities(), deps.listRelations(), deps.store.load().catch(() => /** @type {DocGraph[]} */ ([]))]);
  let live = graphs;
  if (deps.docs) {
    const split = liveGraphs(graphs, deps.docs);
    live = split.live;
    if (split.stale.length) await deps.store.remove(split.stale).catch(() => {});
  }
  const manual = entRes.ok ? { entities: entRes.data ?? [], relations: relRes.ok ? (relRes.data ?? []) : [] } : { entities: [], relations: [] };
  return { ...mergeGraphs(manual, live), manualError: entRes.ok ? null : (entRes.error ?? null) };
}

/**
 * The model runner of the app: the purpose through the router, without its answer cache (the
 * results are kept here). On this device only when `deviceOnly`. Null when no model can run it.
 * The AI layer loads on first use.
 * @param {{ deviceOnly?: boolean }} [options]
 * @returns {Promise<{ run: RunBatch, leavesDevice: boolean } | null>}
 */
export async function appModelRunner(options = {}) {
  const [{ planChain, routerDeps, runPurpose }, { getPurpose }] = await Promise.all([import('./ai/router.js'), import('./ai/purposes.js')]);
  const def = getPurpose(GRAPH_PURPOSE);
  /** @type {import('./ai/router.js').RunOptions} */
  const opts = options.deviceOnly ? { providers: [] } : {};
  const steps = def ? planChain(def, opts, routerDeps()) : [];
  if (!steps.length) return null;
  return {
    leavesDevice: steps.some((s) => s.tier !== 'device'),
    run: async (input, signal) => {
      const res = await runPurpose(GRAPH_PURPOSE, input, { ...opts, signal, cache: 'off' });
      return res.ok && res.value ? { value: res.value, model: res.model } : null;
    },
  };
}
