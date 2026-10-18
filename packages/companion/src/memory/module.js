// @ts-check
// Module `memory`: notes the user keeps on purpose, sealed in the vault namespace `notes`, found
// again by the search index (passages of the collection `notes`) and ordered by rank.js.
//   GET    /v1/memory/notes          member  the notes, best ranked first (summaries, no text)
//   POST   /v1/memory/notes          member  { text, title?, tags?, dataClass?, pinned? } adds one
//   GET    /v1/memory/notes/:id      member  one note with its text
//   PUT    /v1/memory/notes/:id      member  changes members of a note
//   DELETE /v1/memory/notes/:id      member  deletes it (the vault records the deletion)
//   POST   /v1/memory/recall         member  { query, k?, maxClass? } the notes that answer a question
// Configuration (`modules.memory`): { "halfLifeDays": 30, "maxNotes": 10000 }.
// The audit chain records that a note was added, changed or deleted (its id, never its text). The
// module mirrors the vault: before every use it compares the stored ids and times with what it
// indexed, so a crypto-erase, a restore or an import is followed without a restart.
import { text } from '../contracts/check.js';
import { classRank } from '../contracts/data-classes.js';
import { fail } from '../lib/errors.js';
import { isoAt } from '../lib/clock.js';
import { actorOf, bodyOf, checkBody, dataClassRule, idPattern, intIn, moduleConfig, newId, notFound } from '../setup/kit.js';
import { changeNote, makeNote, noteProblems, noteRecalled, noteSummary, readNote } from './notes.js';
import { DEFAULT_HALF_LIFE_DAYS, rankNotes } from './rank.js';

export const MEMORY_MODULE = 'memory';
export const NOTES_NAMESPACE = 'notes';
const NOTE_ID = idPattern('note');

/**
 * What other modules may use: recall and read, never write.
 * @typedef {object} MemoryService
 * @property {(query: string, options?: { k?: number, maxClass?: import('../contracts/data-classes.js').DataClass, record?: boolean, signal?: AbortSignal }) => Promise<Array<{ id: string, title: string, dataClass: import('../contracts/data-classes.js').DataClass, score: number, chunk: number, text: string }>>} recall
 * @property {(id: string) => import('./notes.js').Note | null} get
 * @property {() => ReturnType<typeof noteSummary>[]} list
 */

/**
 * @param {{ hub: import('../setup/hub.js').Hub }} deps
 * @returns {import('../contracts/module.js').CompanionModule}
 */
export function createMemoryModule({ hub }) {
  /** @type {any} */
  let ctx = null;
  /** @type {any} */
  let ns = null;
  let settings = { halfLifeDays: DEFAULT_HALF_LIFE_DAYS, maxNotes: 10_000 };
  /** id -> { updated (vault time), note } */
  const mirror = new Map();
  /** @type {(() => void) | null} */
  let withdraw = null;

  const index = () => hub.get('retrieval');
  const now = () => ctx.clock.now();

  /** @param {import('./notes.js').Note} note */
  function indexNote(note) {
    index()?.put({ id: note.id, collection: 'notes', title: note.title, dataClass: note.dataClass, text: note.title && !note.text.startsWith(note.title) ? `${note.title}\n${note.text}` : note.text });
  }

  /** Follows the vault: loads new or changed notes, forgets removed ones. */
  function sync() {
    if (!ns) throw fail('module_stopped', 'the memory is not running', { status: 503 });
    const stored = new Map(ns.list().map((/** @type {{ id: string, updated: string }} */ item) => [item.id, item.updated]));
    for (const id of [...mirror.keys()]) {
      if (stored.has(id)) continue;
      mirror.delete(id);
      index()?.remove(id);
    }
    for (const [id, updated] of stored) {
      if (!NOTE_ID.test(id) || mirror.get(id)?.updated === updated) continue;
      try {
        const note = readNote(ns.getJson(id));
        mirror.set(id, { updated, note });
        indexNote(note);
      } catch (err) {
        ctx.log('warn', 'note_skipped', { id, code: /** @type {any} */ (err)?.code ?? 'unreadable' });
        mirror.set(id, { updated, note: null });
      }
    }
    // An index that started after this module (or was restarted) gets the notes again.
    const idx = index();
    if (idx) for (const { note } of mirror.values()) if (note && !idx.has(note.id)) indexNote(note);
  }

  /** @param {import('./notes.js').Note} note */
  function save(note) {
    const { updated } = ns.putJson(note.id, note);
    mirror.set(note.id, { updated, note });
  }

  /** @param {string} id */
  function noteOf(id) {
    if (!NOTE_ID.test(id)) throw notFound('note_unknown', 'note');
    sync();
    const note = mirror.get(id)?.note;
    if (!note) throw notFound('note_unknown', 'note');
    return note;
  }

  const notes = () => [...mirror.values()].map((m) => m.note).filter((n) => n !== null);

  /**
   * The notes that answer a question.
   * @param {string} query
   * @param {{ k?: number, maxClass?: import('../contracts/data-classes.js').DataClass, record?: boolean, signal?: AbortSignal }} [options]
   */
  async function recall(query, { k = 5, maxClass = 'sensitive', record = true, signal } = {}) {
    sync();
    const idx = index();
    /** @type {Map<string, { score: number, chunk: number, text: string }>} */
    const matches = new Map();
    if (idx) {
      const { passages } = await idx.search(query, { k: Math.max(20, k * 4), collections: ['notes'], maxClass, signal });
      for (const p of passages) if (!matches.has(p.id)) matches.set(p.id, { score: p.score, chunk: p.chunk, text: p.text });
    } else {
      // Without the index: the share of the question's words a note contains.
      const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
      for (const note of notes()) {
        if (classRank(note.dataClass) > classRank(maxClass)) continue;
        const hay = `${note.title}\n${note.text}`.toLowerCase();
        const hits = words.filter((w) => hay.includes(w)).length;
        if (hits > 0) matches.set(note.id, { score: hits / words.length, chunk: 0, text: note.text });
      }
    }
    const ranked = rankNotes(notes(), { now: now(), halfLifeDays: settings.halfLifeDays, matches }).slice(0, k);
    if (!record) return ranked;
    const at = isoAt(now());
    return ranked.map((r) => {
      const note = noteRecalled(r.note, at);
      save(note);
      return { ...r, note };
    });
  }

  /** @type {MemoryService} */
  const service = {
    async recall(query, options) {
      const ranked = await recall(query, options);
      return ranked.map((r) => ({ id: r.note.id, title: r.note.title, dataClass: r.note.dataClass, score: r.score, chunk: r.passage?.chunk ?? 0, text: r.passage?.text ?? r.note.text }));
    },
    get(id) {
      if (!NOTE_ID.test(id)) return null;
      sync();
      return mirror.get(id)?.note ?? null;
    },
    list() {
      sync();
      return rankNotes(notes(), { now: now(), halfLifeDays: settings.halfLifeDays }).map((r) => noteSummary(r.note));
    },
  };

  /** @param {Record<string, unknown>} body @param {boolean} partial */
  const checkNote = (body, partial) => {
    const problems = noteProblems(body, { partial });
    if (problems.length > 0) throw fail('note_invalid', problems.join('; '), { status: 400, details: { problems } });
  };

  return {
    id: MEMORY_MODULE,
    version: '1.0.0',
    title: 'Notes',
    namespaces: [NOTES_NAMESPACE],
    routes: [
      {
        method: 'GET',
        path: '/notes',
        access: 'member',
        handler: () => {
          sync();
          const ranked = rankNotes(notes(), { now: now(), halfLifeDays: settings.halfLifeDays });
          return { body: { notes: ranked.map((r) => ({ ...noteSummary(r.note), score: r.score })) } };
        },
      },
      {
        method: 'POST',
        path: '/notes',
        access: 'member',
        maxBody: 64 * 1024,
        handler(req) {
          const body = bodyOf(req);
          checkNote(body, false);
          sync();
          if (mirror.size >= settings.maxNotes) throw fail('notes_full', `the memory holds at most ${settings.maxNotes} notes`, { status: 409 });
          const note = makeNote(newId('note'), body, isoAt(now()));
          save(note);
          indexNote(note);
          ctx.audit.append({ kind: 'memory.note_added', subject: note.id, actor: actorOf(req), details: { dataClass: note.dataClass } });
          return { status: 201, body: { note } };
        },
      },
      {
        method: 'GET',
        path: '/notes/:id',
        access: 'member',
        handler: (req) => ({ body: { note: noteOf(req.params.id) } }),
      },
      {
        method: 'PUT',
        path: '/notes/:id',
        access: 'member',
        maxBody: 64 * 1024,
        handler(req) {
          const body = bodyOf(req);
          checkNote(body, true);
          const before = noteOf(req.params.id);
          const note = changeNote(before, body, isoAt(now()));
          save(note);
          indexNote(note);
          ctx.audit.append({ kind: 'memory.note_changed', subject: note.id, actor: actorOf(req), details: { dataClass: note.dataClass, textChanged: note.text !== before.text } });
          return { body: { note } };
        },
      },
      {
        method: 'DELETE',
        path: '/notes/:id',
        access: 'member',
        handler(req) {
          const note = noteOf(req.params.id);
          ns.delete(note.id);
          mirror.delete(note.id);
          index()?.remove(note.id);
          ctx.audit.append({ kind: 'memory.note_deleted', subject: note.id, actor: actorOf(req) });
          return { body: { deleted: true, id: note.id } };
        },
      },
      {
        method: 'POST',
        path: '/recall',
        access: 'member',
        maxBody: 8 * 1024,
        async handler(req) {
          const body = bodyOf(req);
          checkBody(body, { query: text(2000), k: intIn(1, 50), maxClass: dataClassRule }, ['query']);
          const ranked = await recall(/** @type {string} */ (body.query), { k: /** @type {number | undefined} */ (body.k) ?? 5, maxClass: /** @type {any} */ (body.maxClass) ?? 'secret', signal: req.signal });
          return { body: { notes: ranked.map((r) => ({ ...noteSummary(r.note), score: r.score, signals: r.signals, passage: r.passage })) } };
        },
      },
    ],
    start(context) {
      ctx = context;
      settings = moduleConfig(MEMORY_MODULE, ctx.config, { halfLifeDays: intIn(1, 3650), maxNotes: intIn(1, 1_000_000) }, settings);
      ns = ctx.vault.namespace(NOTES_NAMESPACE);
      sync();
      withdraw = hub.provide('memory', service);
    },
    stop() {
      withdraw?.();
      withdraw = null;
      ns = null;
      mirror.clear();
    },
  };
}
