// @ts-check
// Pure retrieval helpers: local keyword ranking (used in local mode so questions never leave the
// device, and as a fallback when the search RPC is unavailable) and context assembly for prompts.

/** @typedef {import('./supabase.js').KnowledgeHit} KnowledgeHit */

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
 * @property {string} text        the excerpt text exactly as given to the model
 * @property {number | null} score  BM25 score (workspace) or search rank (knowledge base)
 * @property {{ docId: string, start: number, end: number } | null} span  character offsets in the source file
 */

/** @param {string} name */
function labelName(name) {
  return name.replace(/[[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Document';
}

/**
 * @param {string} doc
 * @param {number} chunk 1-based
 */
export function citationLabel(doc, chunk) {
  return `[Doc: ${labelName(doc)}, Chunk: ${chunk}]`;
}

/** Matches citation labels in model output: [Doc: <name>, Chunk: <n>]. */
export const CITATION_PATTERN = /\[Doc:\s*([^\]\n]+?),\s*Chunk:\s*(\d{1,6})\s*\]/g;

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
    const text = h.content.length > limits.excerptChars ? `${h.content.slice(0, limits.excerptChars)}…` : h.content;
    out.push({
      label,
      doc,
      chunk,
      source: h.workspace ? 'workspace' : 'knowledge',
      heading: h.heading.replace(/^#+\s*/, ''),
      text,
      score: h.rank,
      span: h.workspace ? { docId: h.workspace.docId, start: h.workspace.start, end: h.workspace.end } : null,
    });
  }
  return out;
}

/**
 * Builds the retrieval context block. Excerpts are fenced and labelled as data so the model is
 * told not to follow instructions contained in documents (prompt-injection mitigation).
 * @param {Citation[]} citations
 * @param {{ maxChars: number }} limits
 */
export function buildContext(citations, limits) {
  let out = '';
  citations.forEach((c, i) => {
    if (out.length >= limits.maxChars) return;
    const heading = c.heading ? ` · ${c.heading}` : '';
    const block = `<<<EXCERPT ${i + 1} ${c.label}${heading}>>>\n${c.text}\n<<<END EXCERPT ${i + 1}>>>\n\n`;
    out += block.slice(0, Math.max(0, limits.maxChars - out.length));
  });
  return out.trim();
}
