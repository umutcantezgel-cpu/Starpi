// @ts-check
// Extractive answers built only from retrieved text. Used when no model is available (or it fails):
// it quotes matching sentences verbatim and cites each with the label of the excerpt it came from,
// so every statement can be checked in the citation drawer. It never generates new content.
import { sentenceSpans, splitSentences } from './core/sentences.js';
import { formatNumber, t } from './i18n/index.js';
import { escapeMarkdown } from './render.js';
import { tokenize } from './retrieval.js';

export { splitSentences } from './core/sentences.js';

/** @typedef {import('./supabase.js').KnowledgeHit} KnowledgeHit */
/** @typedef {import('./retrieval.js').Citation} Citation */

const GREETING =
  /^(hey|hallo|hi|hello|moin|servus|grüß gott|guten (tag|morgen|abend)|good (morning|afternoon|evening)|was geht|wer bist du|who are you|what can you do|hallo starpi|hi starpi)\b/i;
/** Only a question that asks for the list itself ("Which documents are available?"), not one about their content. */
const DOC_LIST_REQUEST =
  /^\s*(?:which|what|welche|list|liste|zeige?(?:\s+mir)?|show(?:\s+me)?)\s+(?:all\s+|alle\s+|the\s+|die\s+)?(?:documents?|dokumente?n?|files|dateien)(?:\s+(?:are|is|do|you|have|there|exist|available|stored|indexed|sind|gibt|es|hast|du|haben|sie|existieren|verfügbar|vorhanden|gespeichert|hinterlegt|indexiert|da|in|the|der|dem|im|knowledge|base|wissensdatenbank|workspace|arbeitsbereich))*\s*[?.!]?\s*$/i;

/** Words that can follow a greeting without making it a question ("Hello there", "Hi team"). */
const GREETING_FILLER = new Set([
  'there', 'everyone', 'everybody', 'all', 'team', 'folks', 'friend', 'friends', 'again', 'starpi', 'you', 'are', 'doing',
  'today', 'zusammen', 'leute', 'allerseits', 'alle', 'geht', 'gehts', 'dir', 'euch', 'ihnen', 'nochmal', 'heute',
  'can', 'kannst', 'bist',
]);

/**
 * True when the message is only a greeting or a question about the assistant. "Hi, what is the
 * budget?" is a question: the rest after the greeting has words to search for.
 * @param {string} text
 */
export function isGreeting(text) {
  const lower = text.toLowerCase().trim();
  const m = GREETING.exec(lower);
  if (!m) return false;
  const rest = lower.slice(m[0].length);
  if (/^[\s,.!?;:-]*(?:and\s+|und\s+)?(?:who are you|what can you do|wer bist du|was kannst du)\b[\s?.!]*$/.test(rest)) return true;
  return tokenize(rest).every((w) => GREETING_FILLER.has(w));
}

/**
 * @param {KnowledgeHit[]} hits
 * @returns {string[]}
 */
function titles(hits) {
  return [...new Set(hits.map((h) => h.documentTitle).filter(Boolean))];
}

/**
 * Sentences of a hit worth quoting: complete statements, not headings, table headers or the
 * fragment a chunk starts with when it begins inside the overlap with its predecessor.
 * @param {KnowledgeHit} h
 */
function quotableSentences(h) {
  let sentences = splitSentences(h.content.replace(/[#>*_`]/g, ' '));
  if (h.workspace && h.workspace.start > 0 && /^\p{Ll}/u.test(sentences[0] ?? '')) sentences = sentences.slice(1);
  return sentences.filter((s) => s.length > 15 && s.length < 400 && s.split(/\s+/).length >= 5);
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
    for (const sentence of quotableSentences(h)) {
      const words = new Set(tokenize(sentence));
      let score = 0;
      for (const term of terms) if (words.has(term)) score += 1;
      if (score > 0 && !found.some((f) => f.sentence.includes(sentence) || sentence.includes(f.sentence))) found.push({ sentence, title: h.documentTitle, score, hit });
    }
  });
  return found.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * @param {Citation[]} citations
 * @param {Array<{ sentence: string, title: string, hit: number }>} facts
 */
function factLines(citations, facts) {
  return facts
    .map((f) => {
      const label = citations[f.hit]?.label;
      return `* **${escapeMarkdown(f.title)}:** ${escapeMarkdown(f.sentence)}${label ? ` ${escapeMarkdown(label)}` : ''}`;
    })
    .join('\n');
}

/**
 * @param {{ query: string, hits: KnowledgeHit[], citations: Citation[], knownTitles: string[], modelAvailable: boolean, kbUnavailable?: boolean, focusName?: string | null }} input
 *   `kbUnavailable`: the knowledge base could not be searched (offline), so "no match" is unknown;
 *   `focusName`: a file attached to this question.
 * @returns {string} Markdown
 */
export function synthesizeAnswer(input) {
  const query = input.query.trim();
  const all = [...new Set([...titles(input.hits), ...input.knownTitles])];
  const shown = all.slice(0, 8);
  const more = all.length > shown.length ? `\n* ${t('synth.more_documents', { n: formatNumber(all.length - shown.length) })}` : '';
  const empty = input.kbUnavailable ? 'synth.kb_unavailable_short' : 'synth.no_documents';
  const titleList = shown.length ? `${shown.map((title) => `* ${escapeMarkdown(title)}`).join('\n')}${more}` : `* ${t(empty)}`;
  const footer = input.modelAvailable ? '' : `\n\n_${t('synth.footer_no_model')}_`;

  if (isGreeting(query)) {
    return `${t('synth.greeting')}\n\n**${t('synth.available_documents')}**\n${titleList}${footer}`;
  }

  if (DOC_LIST_REQUEST.test(query)) {
    if (input.kbUnavailable && !all.length) return `### ${t('synth.kb_unavailable_heading')}\n\n${t('synth.kb_unavailable_body')}${footer}`;
    return `### ${t('synth.documents_heading', { count: formatNumber(all.length) })}\n\n${titleList}${footer}`;
  }

  // Quote only what the citation drawer shows: the excerpt as given, without a sentence the excerpt
  // limit cut in half.
  const quotable = input.hits.map((h, i) => {
    const c = input.citations[i];
    if (!c) return h;
    if (!c.truncated) return { ...h, content: c.text };
    const text = c.text.replace(/…$/, '');
    const spans = sentenceSpans(text);
    return { ...h, content: spans.length > 1 ? text.slice(0, spans[spans.length - 2].end) : '' };
  });
  const facts = extractSentences(query, quotable, 4);
  if (facts.length > 0) return `### ${t('synth.facts_heading')}\n\n${factLines(input.citations, facts)}${footer}`;

  // No sentence shares a word with the question (e.g. "Summarize the attached file"): quote the
  // opening statements of the best passages instead of claiming that nothing was found.
  const order = quotable.map((h, hit) => ({ h, hit })).sort((a, b) => Number(b.h.documentTitle === input.focusName) - Number(a.h.documentTitle === input.focusName));
  /** @type {Array<{ sentence: string, title: string, hit: number }>} */
  const opening = [];
  for (const { h, hit } of order) {
    for (const sentence of quotableSentences(h).slice(0, 2)) {
      if (opening.length < 4 && !opening.some((o) => o.sentence === sentence)) opening.push({ sentence, title: h.documentTitle, hit });
    }
  }
  if (opening.length > 0) {
    const heading = input.focusName ? t('synth.file_heading', { name: escapeMarkdown(input.focusName) }) : t('synth.closest_heading');
    const note = input.focusName ? '' : `\n\n${t('synth.closest_note')}`;
    return `### ${heading}${note}\n\n${factLines(input.citations, opening)}${footer}`;
  }

  if (input.kbUnavailable) return `### ${t('synth.kb_unavailable_heading')}\n\n${t('synth.kb_unavailable_body')}${footer}`;
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
