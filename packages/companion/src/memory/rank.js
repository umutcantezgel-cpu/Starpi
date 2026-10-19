// @ts-check
// How the memory orders notes. Four signals, each between 0 and 1:
//   match      how well the note answers the question: its best passage's score over the best
//              score of all candidates (only when there is a question);
//   use        how often it was recalled, flattening out: 1 - e^(-recalls / 5);
//   spread     on how many different days it was recalled, up to a week: days / 7;
//   freshness  how recently it was written, changed or recalled, halving every `halfLifeDays`
//              (30 by default); a pinned note never fades.
// With a question:  0.60 match + 0.20 freshness + 0.15 use + 0.05 spread.
// Without one (the list): 0.45 freshness + 0.30 use + 0.10 spread + 0.15 for a pinned note.
// Equal scores: more recalls first, then the id. Notes fade in the ranking only; nothing is
// deleted on its own.

export const DAY_MS = 86_400_000;
export const DEFAULT_HALF_LIFE_DAYS = 30;

/** @param {number} x */
const unit = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/**
 * @param {import('./notes.js').Note} note
 * @param {number} now
 * @param {number} halfLifeDays
 */
export function freshness(note, now, halfLifeDays = DEFAULT_HALF_LIFE_DAYS) {
  if (note.pinned) return 1;
  const touched = Math.max(Date.parse(note.updated), note.recalls.last ? Date.parse(note.recalls.last) : 0);
  const days = Math.max(0, (now - touched) / DAY_MS);
  return unit(0.5 ** (days / halfLifeDays));
}

/** @param {import('./notes.js').Note} note */
export const use = (note) => unit(1 - Math.exp(-note.recalls.count / 5));

/** @param {import('./notes.js').Note} note */
export const spread = (note) => unit(note.recalls.days.length / 7);

/**
 * @typedef {object} RankedNote
 * @property {import('./notes.js').Note} note
 * @property {number} score
 * @property {{ match: number | null, use: number, spread: number, freshness: number }} signals
 * @property {{ chunk: number, text: string } | null} passage   the best passage, with a question
 */

/**
 * Orders notes.
 * @param {import('./notes.js').Note[]} notes
 * @param {{ now: number, halfLifeDays?: number, matches?: Map<string, { score: number, chunk: number, text: string }> }} options
 *   matches: the best passage per note id for a question; notes without one are left out
 * @returns {RankedNote[]}
 */
export function rankNotes(notes, { now, halfLifeDays = DEFAULT_HALF_LIFE_DAYS, matches }) {
  const best = matches ? Math.max(0, ...[...matches.values()].map((m) => m.score)) : 0;
  /** @type {RankedNote[]} */
  const ranked = [];
  for (const note of notes) {
    const m = matches?.get(note.id);
    if (matches && !m) continue;
    const signals = { match: m ? unit(best > 0 ? m.score / best : 0) : null, use: use(note), spread: spread(note), freshness: freshness(note, now, halfLifeDays) };
    const score =
      signals.match !== null
        ? 0.6 * signals.match + 0.2 * signals.freshness + 0.15 * signals.use + 0.05 * signals.spread
        : 0.45 * signals.freshness + 0.3 * signals.use + 0.1 * signals.spread + (note.pinned ? 0.15 : 0);
    ranked.push({ note, score: Math.round(score * 1e6) / 1e6, signals, passage: m ? { chunk: m.chunk, text: m.text } : null });
  }
  ranked.sort((a, b) => b.score - a.score || b.note.recalls.count - a.note.recalls.count || (a.note.id < b.note.id ? -1 : a.note.id > b.note.id ? 1 : 0));
  return ranked;
}
