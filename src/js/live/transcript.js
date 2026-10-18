// @ts-check
// The transcript of a Live conversation: what the user said and what the assistant answered, turn
// by turn, each answer with its label. A free answer is "Free · not checked"; an answer of a source
// conversation is "Checked against your sources" with the number of sentences that were held back
// (not spoken). Text arrives in pieces and is appended to the open entry of its role: streamed
// deltas exactly as they come (they split inside words and numbers), transcription fragments of the
// Live service as words (a space between two fragments unless one already has it). Only the last
// LIMIT entries are kept; nothing is stored.
import { html, label, provenanceBadge } from '../ui/kit.js';

/** @typedef {'user' | 'assistant'} Speaker */
/** @typedef {'free' | 'checked'} EntryLabel */
/** @typedef {'raw' | 'words'} JoinMode  raw: the piece continues the text as it is; words: a fragment of its own */

/**
 * @typedef {object} TranscriptEntry
 * @property {number} id
 * @property {Speaker} role
 * @property {string} text
 * @property {EntryLabel | null} label   answers only
 * @property {number} withheld           sentences of a checked answer that were not spoken
 * @property {boolean} open              more text may still arrive
 */

/** Entries kept. */
export const TRANSCRIPT_LIMIT = 200;

/**
 * @param {{ limit?: number }} [options]
 */
export function createTranscript(options = {}) {
  const limit = options.limit ?? TRANSCRIPT_LIMIT;
  /** @type {TranscriptEntry[]} */
  let entries = [];
  let nextId = 1;
  /** @type {Set<(entries: readonly TranscriptEntry[]) => void>} */
  const listeners = new Set();
  const notify = () => {
    for (const fn of listeners) fn(entries);
  };

  /**
   * The open entry of a role, or a new one.
   * @param {Speaker} role
   * @param {EntryLabel | null} entryLabel
   */
  const openEntry = (role, entryLabel) => {
    const last = entries.at(-1);
    if (last && last.open && last.role === role) return last;
    for (const e of entries) if (e.open) e.open = false;
    const entry = { id: nextId++, role, text: '', label: role === 'assistant' ? entryLabel : null, withheld: 0, open: true };
    entries.push(entry);
    if (entries.length > limit) entries = entries.slice(-limit);
    return entry;
  };

  return {
    /**
     * Appends text to the open entry of a role (starting one when needed).
     * @param {Speaker} role
     * @param {string} text
     * @param {EntryLabel | null} [entryLabel]
     * @param {JoinMode} [join]
     */
    append(role, text, entryLabel = null, join = 'raw') {
      const piece = String(text ?? '');
      if (!piece) return null;
      const entry = openEntry(role, entryLabel);
      const spaced = join === 'words' && entry.text && !/\s$/.test(entry.text) && !/^[\s.,;:!?)]/.test(piece);
      entry.text = spaced ? `${entry.text} ${piece}` : entry.text + piece;
      notify();
      return entry;
    },
    /**
     * Opens an entry of a role (when none is open) without text yet.
     * @param {Speaker} role
     * @param {EntryLabel | null} [entryLabel]
     */
    ensure(role, entryLabel = null) {
      const entry = openEntry(role, entryLabel);
      notify();
      return entry;
    },
    /**
     * Closes the open entry of a role; an answer gets its count of held-back sentences.
     * @param {Speaker} role
     * @param {{ withheld?: number }} [meta]
     */
    close(role, meta = {}) {
      const entry = [...entries].reverse().find((e) => e.open && e.role === role);
      if (!entry) return;
      entry.open = false;
      entry.text = entry.text.trim();
      if (meta.withheld) entry.withheld = meta.withheld;
      notify();
    },
    entries: () => /** @type {readonly TranscriptEntry[]} */ (entries),
    clear() {
      entries = [];
      notify();
    },
    /** The last turns as chat history (closed entries with text). */
    history(max = 8) {
      return entries
        .filter((e) => !e.open && e.text)
        .slice(-max)
        .map((e) => ({ role: e.role, text: e.text }));
    },
    /** @param {(entries: readonly TranscriptEntry[]) => void} fn */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** @typedef {ReturnType<typeof createTranscript>} Transcript */

/**
 * The transcript as markup (newest last). Text is escaped; labels keep their i18n keys.
 * @param {readonly TranscriptEntry[]} entries
 */
export function renderTranscript(entries) {
  if (entries.length === 0) return label('live.transcript.empty', { tag: 'p', className: 'text-sm text-slate-500 text-center py-6' });
  return html`<ol class="space-y-3">${entries.map((e) =>
    e.role === 'user'
      ? html`<li class="flex justify-end" data-live-entry="user"><p class="max-w-[85%] rounded-2xl bg-slate-900 text-white px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words">${e.text}</p></li>`
      : html`<li class="flex flex-col items-start gap-1" data-live-entry="assistant" data-live-label="${e.label ?? 'free'}">
          ${e.text
            ? html`<p class="max-w-[85%] rounded-2xl bg-white border border-slate-200 px-3.5 py-2 text-sm leading-relaxed text-slate-800 whitespace-pre-wrap break-words">${e.text}</p>`
            : label(e.open ? 'live.transcript.thinking' : 'live.transcript.nothing', { tag: 'p', className: 'max-w-[85%] rounded-2xl bg-white border border-dashed border-slate-300 px-3.5 py-2 text-sm text-slate-500' })}
          <span class="flex flex-wrap items-center gap-1.5">${e.label === 'checked' ? provenanceBadge('checked') : provenanceBadge('unchecked', { label: 'live.label.free' })}${e.withheld ? provenanceBadge('withheld', { label: { key: 'live.label.withheld', params: { count: e.withheld } } }) : ''}</span>
        </li>`,
  )}</ol>`;
}
