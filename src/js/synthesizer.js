// @ts-check
// Extractive answers built only from retrieved knowledge-base text. Used when no language model is
// configured or reachable. It never invents facts: every statement is a quoted sentence or title.
import { escapeMarkdown } from './render.js';
import { tokenize } from './retrieval.js';

/** @typedef {import('./supabase.js').KnowledgeHit} KnowledgeHit */

const GREETING = /^(hey|hallo|hi|moin|servus|guten (tag|morgen|abend)|was geht|wer bist du|hallo starpi)\b/;
const DOC_LIST_REQUEST = /dokument|archiv|hinterlegt|liste|dateien|gespeichert/;

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

const ABBREVIATIONS = new Set(['z', 'b', 'bzw', 'ca', 'nr', 'dr', 'st', 'usw', 'vgl', 'inkl', 'ggf', 'evtl', 'etc', 'u', 'a', 'd', 'h', 'mio', 'mrd', 'tsd']);

/**
 * Splits German text into sentences without breaking ordinals ("3. März"), decimals or abbreviations ("z. B.").
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
 * @param {string} query
 * @param {KnowledgeHit[]} hits
 * @param {number} limit
 */
export function extractSentences(query, hits, limit) {
  const terms = new Set(tokenize(query));
  /** @type {Array<{ sentence: string, title: string, score: number }>} */
  const found = [];
  for (const h of hits) {
    const sentences = splitSentences(h.content.replace(/[#>*_`]/g, ' ')).filter((s) => s.length > 15 && s.length < 400);
    for (const sentence of sentences) {
      const words = new Set(tokenize(sentence));
      let score = 0;
      for (const t of terms) if (words.has(t)) score += 1;
      if (score > 0 && !found.some((f) => f.sentence === sentence)) found.push({ sentence, title: h.documentTitle, score });
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
    : '* Noch keine Dokumente hinterlegt.';
  const footer = input.modelAvailable
    ? ''
    : '\n\n_Diese Antwort stammt direkt aus der Wissensdatenbank, ohne KI Modell. Für ausformulierte Antworten hinterlegen Sie in den Einstellungen einen eigenen Schlüssel oder nutzen den lokalen Modus._';

  if (isGreeting(query)) {
    return `Hallo! 👋 Ich bin **Starpi**, Ihr Assistent für die Unternehmenswissensdatenbank.\n\n📚 **Aktuell verfügbare Dokumente:**\n${titleList}\n\nFragen Sie mich nach Inhalten dieser Dokumente oder speisen Sie über **„Wissen einspeisen“** neue Notizen ein.${footer}`;
  }

  if (DOC_LIST_REQUEST.test(query.toLowerCase())) {
    return `### 📚 Verfügbare Dokumente (${allTitles.length})\n\n${titleList}${footer}`;
  }

  const facts = extractSentences(query, input.hits, 4);
  if (facts.length > 0) {
    const lines = facts.map((f) => `* **${escapeMarkdown(f.title)}:** ${escapeMarkdown(f.sentence)}`).join('\n');
    return `### 🔍 Passende Stellen aus der Wissensdatenbank\n\n${lines}${footer}`;
  }

  return `### ℹ️ Keine passenden Stellen gefunden\n\nZu **„${escapeMarkdown(query.slice(0, 200))}“** enthält die Wissensdatenbank keine passenden Textstellen.\n\n**Verfügbare Dokumente:**\n${titleList}${footer}`;
}

/**
 * A factual trace of how the answer was produced (shown in the collapsible details panel).
 * @param {{ query: string, method: string, hits: KnowledgeHit[], engineLabel: string, durationMs: number | null, note?: string }} input
 */
export function describeTrace(input) {
  const docTitles = titles(input.hits);
  const docs = docTitles.length ? docTitles.slice(0, 5).map((t) => `„${escapeMarkdown(t)}“`).join(', ') : 'keine';
  const duration = input.durationMs !== null ? `${(input.durationMs / 1000).toFixed(1)} s` : '–';
  return [
    '### 1. Wissensdatenbank durchsucht',
    `• **Anfrage:** ${escapeMarkdown(input.query.slice(0, 120))}`,
    `• **Methode:** ${input.method}`,
    `• **Treffer:** ${input.hits.length} Abschnitte aus ${docTitles.length} Dokumenten (${docs})`,
    '',
    '### 2. Antwort erzeugt',
    `• **Quelle der Antwort:** ${input.engineLabel}`,
    `• **Dauer:** ${duration}`,
    input.note ? `• **Hinweis:** ${input.note}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
