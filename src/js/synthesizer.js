// @ts-check
// Extractive answers built only from retrieved text. Used when no model is available (or it fails):
// it quotes matching sentences verbatim and cites each with the label of the excerpt it came from,
// so every statement can be checked in the citation drawer. It never generates new content.
import { formatNumber, t } from './i18n/index.js';
import { escapeMarkdown } from './render.js';
import { tokenize } from './retrieval.js';

/** @typedef {import('./supabase.js').KnowledgeHit} KnowledgeHit */
/** @typedef {import('./retrieval.js').Citation} Citation */

const GREETING =
  /^(hey|hallo|hi|hello|moin|servus|grüß gott|guten (tag|morgen|abend)|good (morning|afternoon|evening)|was geht|wer bist du|who are you|what can you do|hallo starpi|hi starpi)\b/i;
const DOC_LIST_REQUEST =
  /\b(welche|which|what|list|liste|zeige?|show)\b.*\b(dokumente?n?|documents?|dateien|files|archiv|archive|records|einträge|indexed|indexiert|hinterlegt|gespeichert|stored)\b/i;

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
 * Sentences from the hits that share terms with the query, best first. `hit` is the index into
 * `hits`, so the caller can cite the excerpt the sentence came from.
 * @param {string} query
 * @param {KnowledgeHit[]} hits
 * @param {number} limit
 */
export function extractSentences(query, hits, limit) {
  const terms = new Set(tokenize(query));
  /** @type {Array<{ sentence: string, title: string, score: number, hit: number }>} */
  const found = [];
  hits.forEach((h, hit) => {
    const sentences = splitSentences(h.content.replace(/[#>*_`]/g, ' ')).filter((s) => s.length > 15 && s.length < 400);
    for (const sentence of sentences) {
      const words = new Set(tokenize(sentence));
      let score = 0;
      for (const term of terms) if (words.has(term)) score += 1;
      if (score > 0 && !found.some((f) => f.sentence === sentence)) found.push({ sentence, title: h.documentTitle, score, hit });
    }
  });
  return found.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * @param {{ query: string, hits: KnowledgeHit[], citations: Citation[], knownTitles: string[], modelAvailable: boolean }} input
 * @returns {string} Markdown
 */
export function synthesizeAnswer(input) {
  const query = input.query.trim();
  const allTitles = [...new Set([...titles(input.hits), ...input.knownTitles])].slice(0, 8);
  const titleList = allTitles.length ? allTitles.map((title) => `* ${escapeMarkdown(title)}`).join('\n') : `* ${t('synth.no_documents')}`;
  const footer = input.modelAvailable ? '' : `\n\n_${t('synth.footer_no_model')}_`;

  if (isGreeting(query)) {
    return `${t('synth.greeting')}\n\n**${t('synth.available_documents')}**\n${titleList}${footer}`;
  }

  if (DOC_LIST_REQUEST.test(query)) {
    return `### ${t('synth.documents_heading', { count: formatNumber(allTitles.length) })}\n\n${titleList}${footer}`;
  }

  const facts = extractSentences(query, input.hits, 4);
  if (facts.length > 0) {
    const lines = facts
      .map((f) => {
        const label = input.citations[f.hit]?.label;
        return `* **${escapeMarkdown(f.title)}:** ${escapeMarkdown(f.sentence)}${label ? ` ${escapeMarkdown(label)}` : ''}`;
      })
      .join('\n');
    return `### ${t('synth.facts_heading')}\n\n${lines}${footer}`;
  }

  return `### ${t('synth.no_hits_heading')}\n\n${t('synth.no_hits_body')}\n\n**${t('synth.available_documents')}**\n${titleList}${footer}`;
}

/**
 * A factual trace of how the answer was produced (stored with the message, so it is written in the
 * language active at that time).
 * @param {{ query: string, method: string, hits: KnowledgeHit[], engineLabel: string, durationMs: number | null, note?: string }} input
 */
export function describeTrace(input) {
  const docTitles = titles(input.hits);
  const docs = docTitles.length ? docTitles.slice(0, 5).map((title) => `"${escapeMarkdown(title)}"`).join(', ') : '–';
  const duration = input.durationMs !== null ? `${formatNumber(input.durationMs / 1000, { maximumFractionDigits: 1 })} s` : '–';
  return [
    `### ${t('trace.retrieval_heading')}`,
    `* **${t('trace.query')}:** ${escapeMarkdown(input.query.slice(0, 120))}`,
    `* **${t('trace.method')}:** ${escapeMarkdown(input.method)}`,
    `* **${t('trace.matches')}:** ${t('trace.matches_value', { hits: input.hits.length, docs: docTitles.length, titles: docs })}`,
    '',
    `### ${t('trace.answer_heading')}`,
    `* **${t('trace.engine')}:** ${escapeMarkdown(input.engineLabel)}`,
    `* **${t('trace.duration')}:** ${duration}`,
    input.note ? `* **${t('trace.note')}:** ${escapeMarkdown(input.note)}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
