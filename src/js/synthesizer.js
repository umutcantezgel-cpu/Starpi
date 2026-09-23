// @ts-check
// Extractive answers built from retrieved knowledge-base text and BM25 chunks.
// Appends verifiable citations [Doc: filename, Chunk: X] for inspection.
import { t } from './i18n/index.js';
import { escapeMarkdown } from './render.js';
import { tokenize } from './retrieval.js';

/** @typedef {import('./supabase.js').KnowledgeHit} KnowledgeHit */

const GREETING = /^(hey|hallo|hi|moin|servus|guten (tag|morgen|abend)|was geht|wer bist du|hallo starpi|hello|good (morning|afternoon|evening))\b/i;
const DOC_LIST_REQUEST = /dokument|archiv|hinterlegt|liste|dateien|gespeichert|document|archive|list|files|records/i;

/** @param {string} text */
export function isGreeting(text) {
  return GREETING.test(text.toLowerCase().trim());
}

/**
 * @param {KnowledgeHit[]} hits
 * @returns {string[]}
 */
function titles(hits) {
  return [...new Set(hits.map((h) => h.documentTitle).filter(Boolean))];
}

const ABBREVIATIONS = new Set(['z', 'b', 'bzw', 'ca', 'nr', 'dr', 'st', 'usw', 'vgl', 'inkl', 'ggf', 'evtl', 'etc', 'u', 'a', 'd', 'h', 'mio', 'mrd', 'tsd', 'inc', 'corp', 'ltd', 'vs', 'e', 'g', 'i']);

/**
 * Splits text into sentences without breaking ordinals, decimals or abbreviations.
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  /** @type {string[]} */
  const out = [];
  for (const line of text.split(/\n+/)) {
    let start = 0;
    const re = /[.!?]+(?=\s+\S)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const before = line.slice(start, m.index);
      const lastToken = (before.match(/(\S+)$/)?.[1] ?? '').toLowerCase();
      if (m[0] === '.' && (/^\d+$/.test(lastToken) || ABBREVIATIONS.has(lastToken))) continue;
      out.push(line.slice(start, m.index + m[0].length));
      start = m.index + m[0].length;
    }
    out.push(line.slice(start));
  }
  return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/**
 * Extracts relevant sentences matching query terms.
 * @param {string} query
 * @param {KnowledgeHit[]} hits
 * @param {number} limit
 */
export function extractSentences(query, hits, limit) {
  const terms = new Set(tokenize(query));
  /** @type {Array<{ sentence: string, title: string, score: number, chunkIndex: number }>} */
  const found = [];
  for (let hitIdx = 0; hitIdx < hits.length; hitIdx++) {
    const h = hits[hitIdx];
    const sentences = splitSentences(h.content.replace(/[#>*_`]/g, ' ')).filter((s) => s.length > 15 && s.length < 400);
    for (const sentence of sentences) {
      const words = new Set(tokenize(sentence));
      let score = 0;
      for (const t of terms) if (words.has(t)) score += 1;
      if (score > 0 && !found.some((f) => f.sentence === sentence)) {
        found.push({
          sentence,
          title: h.documentTitle,
          score,
          chunkIndex: hitIdx,
        });
      }
    }
  }
  return found.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * @param {{ query: string, hits: KnowledgeHit[], knownTitles: string[], modelAvailable: boolean }} input
 * @returns {string} Markdown
 */
export function synthesizeAnswer(input) {
  const query = input.query.trim();
  const allTitles = [...new Set([...titles(input.hits), ...input.knownTitles])].slice(0, 8);
  const titleList = allTitles.length
    ? allTitles.map((t) => `* ${escapeMarkdown(t)}`).join('\n')
    : `* ${t('library.empty')}`;
  const footer = input.modelAvailable
    ? ''
    : `\n\n_${t('chat.fallback_note')}_`;

  if (isGreeting(query)) {
    return `${t('chat.welcome_title')}\n\n**${t('chat.source_docs')}:**\n${titleList}\n\n${t('chat.welcome_desc')}${footer}`;
  }

  if (DOC_LIST_REQUEST.test(query.toLowerCase())) {
    return `### ${t('chat.available_docs')} (${allTitles.length})\n\n${titleList}${footer}`;
  }

  const facts = extractSentences(query, input.hits, 4);
  if (facts.length > 0) {
    const lines = facts
      .map((f) => `* **${escapeMarkdown(f.title)}:** ${escapeMarkdown(f.sentence)} [Doc: ${escapeMarkdown(f.title)}, Chunk: ${f.chunkIndex}]`)
      .join('\n');
    return `### ${t('chat.source_docs')}\n\n${lines}${footer}`;
  }

  return `### ${t('chat.no_hits_title')}\n\n${t('chat.no_hits_desc')}\n\n**${t('chat.available_docs')}:**\n${titleList}${footer}`;
}

/**
 * A factual trace of how the answer was produced.
 * @param {{ query: string, method: string, hits: KnowledgeHit[], engineLabel: string, durationMs: number | null, note?: string }} input
 */
export function describeTrace(input) {
  const docTitles = titles(input.hits);
  const docs = docTitles.length ? docTitles.slice(0, 5).map((t) => `„${escapeMarkdown(t)}“`).join(', ') : '–';
  const duration = input.durationMs !== null ? `${(input.durationMs / 1000).toFixed(1)} s` : '–';
  return [
    `### 1. Retrieval Pass`,
    `• **Query:** ${escapeMarkdown(input.query.slice(0, 120))}`,
    `• **Method:** ${input.method}`,
    `• **Matches:** ${input.hits.length} segments from ${docTitles.length} documents (${docs})`,
    '',
    `### 2. Answer Generation`,
    `• **Engine:** ${input.engineLabel}`,
    `• **Duration:** ${duration}`,
    input.note ? `• **Note:** ${input.note}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
