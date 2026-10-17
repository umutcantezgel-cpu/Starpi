// @ts-check
// Pure retrieval helpers: local keyword ranking (used in local mode so questions never leave the
// device, and as a fallback when the search RPC is unavailable), the choice between hybrid and
// keyword search of the workspace, and context assembly for prompts.

import { citationLabel, fenceSafe, labelName } from './core/labels.js';
import { safeSlice } from './core/sentences.js';

export { CITATION_PATTERN, citationLabel } from './core/labels.js';

/** @typedef {import('./supabase.js').KnowledgeHit} KnowledgeHit */
/** @typedef {import('./rag/workspace.js').WorkspaceHit} WorkspaceHit */

/** How long a search waits for the question's vector before it ranks by keywords alone. */
export const QUERY_EMBED_TIMEOUT_MS = 2_000;

/**
 * The value of a promise, or null when it rejects or takes longer than `ms`.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T | null>}
 */
export function withinTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Workspace search as the chat runs it: hybrid when the workspace holds vectors and the question's
 * vector arrives within the timeout, keyword search (BM25) otherwise. The question is embedded on
 * this device; a slow or missing model never holds an answer back by more than the timeout.
 * @template H
 * @param {string} query
 * @param {number} topK
 * @param {{ hasVectors: () => boolean, embed: ((text: string) => Promise<Float32Array | null>) | null, search: (query: string, topK: number, vector: Float32Array | null) => Promise<H[]>, timeoutMs?: number }} deps
 * @returns {Promise<H[]>}
 */
export async function searchWithQueryVector(query, topK, deps) {
  const vector = deps.embed && deps.hasVectors() ? await withinTimeout(deps.embed(query), deps.timeoutMs ?? QUERY_EMBED_TIMEOUT_MS) : null;
  return deps.search(query, topK, vector instanceof Float32Array && vector.length > 0 ? vector : null);
}

/**
 * Runs of two or more angle brackets in excerpt text, the shape of the markers around an excerpt.
 * Each bracket becomes its single-guillemet look-alike, so the text keeps its length and line
 * breaks but can neither close its excerpt early nor forge another one.
 * @param {string} text
 */
export function defuseFences(text) {
  return text.replace(/<{2,}|>{2,}/g, (run) => (run[0] === '<' ? '\u2039' : '\u203a').repeat(run.length));
}

/**
 * A workspace search hit in the shape of a knowledge-base hit, so both flow through one pipeline.
 * @param {WorkspaceHit} h
 * @returns {KnowledgeHit}
 */
export function workspaceHit(h) {
  return {
    documentId: h.docId,
    documentTitle: h.docName,
    heading: '',
    content: h.text,
    tags: [],
    // The BM25 score where there is one (a hybrid hit found by meaning alone has none).
    rank: h.keywordScore !== undefined ? h.keywordScore : h.score,
    workspace: { docId: h.docId, chunkIndex: h.chunkIndex, start: h.start, end: h.end },
  };
}

const STOPWORDS = new Set([
  'der', 'die', 'das', 'und', 'oder', 'aber', 'ein', 'eine', 'einen', 'einem', 'einer', 'ist', 'sind', 'war', 'wer',
  'wie', 'was', 'wann', 'wo', 'warum', 'welche', 'welcher', 'welches', 'mit', 'von', 'für', 'auf', 'aus', 'bei', 'zu',
  'im', 'in', 'am', 'an', 'den', 'dem', 'des', 'es', 'ich', 'du', 'sie', 'wir', 'ihr', 'mir', 'mich', 'uns', 'nicht',
  'the', 'and', 'for', 'what', 'who', 'how', 'with', 'about', 'bitte', 'mal', 'gibt', 'hat', 'haben', 'kann', 'können',
]);

/**
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  return (text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (w) => w.length > 2 && !STOPWORDS.has(w),
  );
}

/**
 * Scores hits by query-term overlap (title matches weigh more) and returns the best ones.
 * Hits without any overlap are dropped.
 * @param {string} query
 * @param {KnowledgeHit[]} hits
 * @param {number} limit
 * @returns {KnowledgeHit[]}
 */
export function rankHitsLocally(query, hits, limit) {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  return hits
    .map((hit) => {
      const title = hit.documentTitle.toLowerCase();
      const body = `${hit.heading} ${hit.content}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (title.includes(term)) score += 2;
        if (body.includes(term)) score += 1;
      }
      return { hit, score: score / (terms.length * 3) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({ ...x.hit, rank: Math.round(x.score * 1000) / 1000 }));
}

/**
 * Distinct documents referenced by hits, in order of first appearance.
 * @param {KnowledgeHit[]} hits
 * @returns {Array<{ title: string, rank: number | null }>}
 */
export function distinctSources(hits) {
  /** @type {Map<string, { title: string, rank: number | null }>} */
  const seen = new Map();
  for (const h of hits) {
    const key = h.documentId ?? h.documentTitle;
    if (!seen.has(key)) seen.set(key, { title: h.documentTitle, rank: h.rank });
  }
  return [...seen.values()];
}

/**
 * @typedef {object} Citation
 * @property {string} label       exact label shown to the model and the user, e.g. "[Doc: a.pdf, Chunk: 2]"
 * @property {string} doc         document or file name
 * @property {number} chunk       1-based chunk number within the document
 * @property {'workspace' | 'knowledge'} source  on-device workspace or Supabase knowledge base
 * @property {string} heading
 * @property {string} text        the excerpt text as given to the model (cut to the excerpt limit)
 * @property {boolean} truncated  whether `text` was cut, i.e. ends before the retrieved passage does
 * @property {number | null} score  BM25 score (workspace) or search rank (knowledge base)
 * @property {string | null} documentId  knowledge-base document id, or the workspace document id
 * @property {{ docId: string, chunkIndex: number, start: number, end: number } | null} span  workspace chunk and its character offsets in the extracted text
 */

/**
 * Assigns a stable citation to every hit. Workspace chunks keep their real chunk number; knowledge
 * base sections are numbered per document in order of appearance.
 * @param {KnowledgeHit[]} hits
 * @param {{ excerptChars: number }} limits
 * @returns {Citation[]}
 */
export function assignCitations(hits, limits) {
  /** @type {Map<string, number>} */
  const perDoc = new Map();
  /** @type {Set<string>} */
  const used = new Set();
  /** @type {Citation[]} */
  const out = [];
  for (const h of hits) {
    const doc = labelName(h.documentTitle);
    let chunk;
    if (h.workspace) {
      chunk = h.workspace.chunkIndex + 1;
    } else {
      chunk = (perDoc.get(doc) ?? 0) + 1;
      perDoc.set(doc, chunk);
    }
    let label = citationLabel(doc, chunk);
    // Same file name from two sources: keep labels unique so every citation resolves to one excerpt.
    while (used.has(label)) {
      chunk += 1000;
      label = citationLabel(doc, chunk);
    }
    used.add(label);
    const truncated = h.content.length > limits.excerptChars;
    out.push({
      label,
      doc,
      chunk,
      source: h.workspace ? 'workspace' : 'knowledge',
      heading: h.heading.replace(/^#+\s*/, ''),
      text: truncated ? `${safeSlice(h.content, limits.excerptChars)}…` : h.content,
      truncated,
      score: h.rank,
      documentId: h.documentId ?? null,
      span: h.workspace ? { docId: h.workspace.docId, chunkIndex: h.workspace.chunkIndex, start: h.workspace.start, end: h.workspace.end } : null,
    });
  }
  return out;
}

/**
 * Builds the retrieval context block. Excerpts are fenced and labelled as data so the model is
 * told not to follow instructions contained in documents (prompt-injection mitigation). When the
 * budget runs out, the text of an excerpt is cut, never its fences.
 * @param {Citation[]} citations
 * @param {{ maxChars: number }} limits
 */
export function buildContext(citations, limits) {
  /** @type {string[]} */
  const blocks = [];
  let used = 0;
  citations.forEach((c, i) => {
    // Heading and text come from the document: they must not end the marker early or forge another one.
    const heading = c.heading ? ` · ${fenceSafe(c.heading)}` : '';
    const body = defuseFences(c.text);
    const open = `<<<EXCERPT ${i + 1} ${c.label}${heading}>>>\n`;
    const close = `\n<<<END EXCERPT ${i + 1}>>>`;
    const separator = blocks.length ? 2 : 0;
    const room = limits.maxChars - used - separator - open.length - close.length;
    if (room < Math.min(MIN_EXCERPT_CHARS, body.length)) return;
    const text = body.length <= room ? body : `${safeSlice(body, room - 1).trimEnd()}…`;
    blocks.push(`${open}${text}${close}`);
    used += separator + open.length + text.length + close.length;
  });
  return blocks.join('\n\n');
}

/** An excerpt cut shorter than this is left out rather than sent as a fragment. */
const MIN_EXCERPT_CHARS = 120;

/**
 * Combines workspace and knowledge-base hits so neither source crowds out the other: each gets at
 * least half of the free slots when it has that many hits. `pinned` leading workspace hits (the
 * attached file) are always kept.
 * @template T
 * @param {T[]} workspace  ranked workspace hits
 * @param {T[]} knowledge  ranked knowledge-base hits
 * @param {number} limit
 * @param {number} [pinned]
 * @returns {T[]}
 */
export function mergeHits(workspace, knowledge, limit, pinned = 0) {
  const kept = workspace.slice(0, Math.min(pinned, limit));
  const rest = workspace.slice(kept.length);
  const room = limit - kept.length;
  const fromKnowledge = Math.min(knowledge.length, Math.max(room - rest.length, Math.ceil(room / 2)));
  const fromWorkspace = Math.min(rest.length, room - fromKnowledge);
  return [...kept, ...rest.slice(0, fromWorkspace), ...knowledge.slice(0, fromKnowledge)];
}
