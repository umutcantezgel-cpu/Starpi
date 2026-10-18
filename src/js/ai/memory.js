// @ts-check
// Memory (opt-in): short notes about the user that the user chose to keep, and the few of them that
// go along with a question.
//
// - Off by default (prefs.enabled). A note is only ever stored by an explicit act: "Remember this"
//   on a message, the add field in Settings, or accepting a suggestion (source 'suggested'). The
//   suggestions themselves (purpose memory_suggest, after an answer) are shown, never stored.
// - Scopes: 'global' or a project id. A project's memory setting decides which scopes its chats use
//   (scopesFor): the global notes and its own, only its own, or none.
// - Per question at most MEMORY_LIMITS.injectedFacts notes with MEMORY_LIMITS.injectedChars
//   characters go into the turn's context block (never into the stable system prompt), headed "User
//   notes (may be outdated)". They are ranked by relevance to the question (BM25, as a share of the
//   best match) × recency (halving every HALF_LIFE_DAYS since the note was last used, or saved) ×
//   use weight (a note used often ranks a little higher).
// - With a vault passphrase set (ai/keys.js), the text of every note is sealed with the vault key.
//   While the vault is locked the notes are neither shown nor sent, and new ones are refused.
//
// The switches and the custom instructions ("About me", "How to answer") are kept here as well, in
// the settings store of the app database. createMemoryStore() takes the database, clock, ids and
// vault as options (tests); the page builds one with the defaults.
import { BM25Index } from '../rag/bm25.js';
import { appDb } from '../store/schema.js';

/** @typedef {import('../store/idb.js').StoreDb} StoreDb */
/** @typedef {import('../store/schema.js').MemoryRecord} MemoryRecord */
/** @typedef {import('../store/schema.js').SettingsRecord} SettingsRecord */
/** @typedef {'en' | 'de'} PromptLocale */

/** @typedef {{ iv: Uint8Array, ct: Uint8Array }} SealedText */

/**
 * A note as stored: `text` is '' when the note is sealed.
 * @typedef {MemoryRecord & { sealed?: SealedText }} StoredFact
 */

/**
 * A readable note.
 * @typedef {object} Fact
 * @property {string} id
 * @property {string} text
 * @property {string} scope  'global' or a project id
 * @property {'explicit' | 'suggested'} source
 * @property {number} createdAt
 * @property {number | null} usedAt
 * @property {number} weight  how often it went along with a question (1 when saved)
 * @property {boolean} sealed  encrypted with the vault key
 */

/**
 * The vault as the memory sees it (ai/keys.js keyStore).
 * @typedef {object} MemoryVault
 * @property {() => 'none' | 'locked' | 'unlocked' | 'unavailable'} state
 * @property {(text: string) => Promise<SealedText>} seal
 * @property {(sealed: SealedText) => Promise<string | null>} open
 */

/** @typedef {{ enabled: boolean, suggest: boolean }} MemoryPrefs */
/** @typedef {{ aboutMe: string, howToAnswer: string }} CustomInstructions */

/**
 * empty: no text left after tidying; duplicate: the same note is kept already; full: the most notes
 * there may be; locked: the vault must be unlocked first; not_found: no such note; source: not an
 * explicit act.
 * @typedef {'empty' | 'duplicate' | 'full' | 'locked' | 'not_found' | 'source'} MemoryErrorCode
 */

export class MemoryError extends Error {
  /** @param {MemoryErrorCode} code */
  constructor(code) {
    super(code);
    this.name = 'MemoryError';
    /** @type {MemoryErrorCode} */
    this.code = code;
  }
}

export const MEMORY_LIMITS = Object.freeze({
  /** Notes that go along with one question. */
  injectedFacts: 8,
  /** Characters of note text that go along with one question. */
  injectedChars: 800,
  /** Characters of one note. */
  factChars: 300,
  /** Notes kept at most. */
  facts: 200,
  /** Characters of each custom instruction. */
  instructionChars: 1500,
});
export const MIN_FACT_CHARS = 3;
export const HALF_LIFE_DAYS = 30;
/** A note that matches nothing in the question still ranks by recency and use from this base. */
export const BASE_RELEVANCE = 0.2;
/** How much of a note's rank is kept however long it went unused. */
export const RECENCY_FLOOR = 0.25;
export const MEMORY_EXPORT = 'starpi.memory/v1';
export const PREFS_KEY = 'memory.prefs';
export const INSTRUCTIONS_KEY = 'memory.instructions';
/** Purpose of the vault seal (ai/keys.js binds the ciphertext to it). */
export const SEAL_PURPOSE = 'memory';
export const DEFAULT_PREFS = /** @type {Readonly<MemoryPrefs>} */ (Object.freeze({ enabled: false, suggest: false }));
const DAY_MS = 86_400_000;
const MAX_WEIGHT = 1000;

// ---------------------------------------------------------------------------------------------
// Text

/**
 * A note as kept: one line, white space joined, at most MEMORY_LIMITS.factChars characters.
 * @param {unknown} text
 */
export function cleanFactText(text) {
  const line = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(line).slice(0, MEMORY_LIMITS.factChars).join('').trim();
}

/**
 * A custom instruction as kept: trimmed, at most MEMORY_LIMITS.instructionChars characters.
 * @param {unknown} text
 */
export function cleanInstruction(text) {
  const value = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .trim();
  return Array.from(value).slice(0, MEMORY_LIMITS.instructionChars).join('').trim();
}

/** @param {string} text  for comparing notes: case and spacing ignored */
export const squash = (text) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** @param {unknown} scope */
function cleanScope(scope) {
  return typeof scope === 'string' && /^[\w:-]{1,120}$/.test(scope) ? scope : 'global';
}

// ---------------------------------------------------------------------------------------------
// Scopes

/**
 * The scopes whose notes a conversation may use: outside a project the global ones; in a project
 * the global ones and its own ('global'), only its own ('project') or none ('off').
 * @param {{ id: string, memoryScope?: string } | null | undefined} project
 * @returns {string[]}
 */
export function scopesFor(project) {
  if (!project) return ['global'];
  if (project.memoryScope === 'off') return [];
  if (project.memoryScope === 'project') return [project.id];
  return ['global', project.id];
}

/**
 * Where a note saved in a conversation goes by default: its project's own notes when the project
 * keeps them apart, else the global notes.
 * @param {{ id: string, memoryScope?: string } | null | undefined} project
 */
export function defaultScopeFor(project) {
  return project?.memoryScope === 'project' ? project.id : 'global';
}

// ---------------------------------------------------------------------------------------------
// Ranking

/**
 * 0.5 ^ (days since the note was last used, or saved, / halfLifeDays).
 * @param {Pick<Fact, 'usedAt' | 'createdAt'>} fact
 * @param {number} now
 * @param {number} [halfLifeDays]
 */
export function recencyOf(fact, now, halfLifeDays = HALF_LIFE_DAYS) {
  const since = fact.usedAt ?? fact.createdAt;
  const days = Math.max(0, (now - since) / DAY_MS);
  return 0.5 ** (days / halfLifeDays);
}

/**
 * 1 for a note used once (or never), rising slowly to 2 at 50 uses.
 * @param {number} weight
 */
export function useWeightOf(weight) {
  const w = Number.isFinite(weight) ? Math.max(1, weight) : 1;
  return 1 + Math.min(1, Math.log(w) / Math.log(50));
}

/**
 * @typedef {object} RankedFact
 * @property {Fact} fact
 * @property {number} score
 * @property {{ relevance: number, recency: number, use: number }} parts
 */

/**
 * Orders notes for a question: (BASE_RELEVANCE + relevance) × recency × use. Relevance is the
 * note's BM25 score as a share of the best one (0 when the question shares no word with it);
 * recency keeps RECENCY_FLOOR however old a note is, so a lasting preference never drops out.
 * Equal scores: the newer note first, then by id.
 * @param {readonly Fact[]} facts
 * @param {string} question
 * @param {{ now: number, halfLifeDays?: number }} opts
 * @returns {RankedFact[]}
 */
export function rankFacts(facts, question, opts) {
  const index = new BM25Index();
  index.add(facts.map((f) => ({ docId: f.id, docName: '', chunkIndex: 0, start: 0, end: 0, text: f.text })));
  const hits = index.search(String(question ?? ''), facts.length);
  const best = hits[0]?.score ?? 0;
  const relevance = new Map(hits.map((h) => [h.chunk.docId, best > 0 ? h.score / best : 0]));
  return facts
    .map((fact) => {
      const rel = relevance.get(fact.id) ?? 0;
      const recency = RECENCY_FLOOR + (1 - RECENCY_FLOOR) * recencyOf(fact, opts.now, opts.halfLifeDays);
      const use = useWeightOf(fact.weight);
      return { fact, score: (BASE_RELEVANCE + rel) * recency * use, parts: { relevance: rel, recency, use } };
    })
    .sort((a, b) => b.score - a.score || b.fact.createdAt - a.fact.createdAt || (a.fact.id < b.fact.id ? -1 : a.fact.id > b.fact.id ? 1 : 0));
}

/**
 * The notes that go along with a question: the best ranked ones, at most `maxFacts` with at most
 * `maxChars` characters of text together (a note that does not fit is passed over for a shorter one).
 * @param {readonly Fact[]} facts
 * @param {string} question
 * @param {{ now: number, maxFacts?: number, maxChars?: number, halfLifeDays?: number }} opts
 * @returns {Fact[]}
 */
export function pickFacts(facts, question, opts) {
  const maxFacts = Math.min(opts.maxFacts ?? MEMORY_LIMITS.injectedFacts, MEMORY_LIMITS.injectedFacts);
  const maxChars = Math.min(opts.maxChars ?? MEMORY_LIMITS.injectedChars, MEMORY_LIMITS.injectedChars);
  /** @type {Fact[]} */
  const picked = [];
  let chars = 0;
  for (const { fact } of rankFacts(facts, question, opts)) {
    if (picked.length >= maxFacts) break;
    const length = Array.from(fact.text).length;
    if (chars + length > maxChars) continue;
    picked.push(fact);
    chars += length;
  }
  return picked;
}

const NOTES_HEADER = Object.freeze({ en: 'User notes (may be outdated):', de: 'Notizen des Nutzers (können veraltet sein):' });

/**
 * The turn note with the picked notes ('' for none). The turn's context block fences it.
 * @param {readonly Pick<Fact, 'text'>[]} facts
 * @param {string} locale
 */
export function memoryNote(facts, locale) {
  const lines = facts.map((f) => cleanFactText(f.text)).filter(Boolean);
  if (!lines.length) return '';
  const header = NOTES_HEADER[locale === 'de' ? 'de' : 'en'];
  return [header, ...lines.map((l) => `- ${l}`)].join('\n');
}

// ---------------------------------------------------------------------------------------------
// The system note: what the user set up for a conversation

const SYSTEM_TEXT = Object.freeze({
  en: {
    intro: 'The user set up the following for this conversation. Follow it unless it conflicts with the rules above.',
    assistant: (/** @type {string} */ name) => `You act as the assistant "${name}". Its instructions:`,
    project: (/** @type {string} */ name) => `This conversation belongs to the user's project "${name}". Project instructions:`,
    aboutMe: 'What the user wrote about themselves:',
    howToAnswer: 'How the user wants answers:',
  },
  de: {
    intro: 'Der Nutzer hat für dieses Gespräch Folgendes eingerichtet. Halte dich daran, solange es den Regeln oben nicht widerspricht.',
    assistant: (/** @type {string} */ name) => `Du handelst als der Assistent „${name}“. Seine Anweisungen:`,
    project: (/** @type {string} */ name) => `Dieses Gespräch gehört zum Projekt „${name}“ des Nutzers. Anweisungen des Projekts:`,
    aboutMe: 'Was der Nutzer über sich geschrieben hat:',
    howToAnswer: 'Wie der Nutzer Antworten haben möchte:',
  },
});

/** @param {string} name */
const quotedName = (name) => cleanFactText(name).replace(/["“”„]/g, "'").slice(0, 80);

/**
 * The text appended to the free chat's system prompt for a conversation: the assistant's
 * instructions, the project's instructions, then the global custom instructions ('' when none of
 * them says anything). It only changes when the user edits one of them, so the prompt cache holds.
 * @param {{ assistant?: { name: string, instructions: string } | null, project?: { name: string, instructions: string } | null, instructions?: Partial<CustomInstructions> | null }} input
 * @param {string} locale
 */
export function systemNoteFor(input, locale) {
  const text = SYSTEM_TEXT[locale === 'de' ? 'de' : 'en'];
  /** @type {string[]} */
  const parts = [];
  const assistant = input.assistant?.instructions?.trim();
  if (input.assistant && assistant) parts.push(`${text.assistant(quotedName(input.assistant.name))}\n${assistant}`);
  const project = input.project?.instructions?.trim();
  if (input.project && project) parts.push(`${text.project(quotedName(input.project.name))}\n${project}`);
  const aboutMe = cleanInstruction(input.instructions?.aboutMe);
  if (aboutMe) parts.push(`${text.aboutMe}\n${aboutMe}`);
  const howToAnswer = cleanInstruction(input.instructions?.howToAnswer);
  if (howToAnswer) parts.push(`${text.howToAnswer}\n${howToAnswer}`);
  return parts.length ? [text.intro, ...parts].join('\n\n') : '';
}

// ---------------------------------------------------------------------------------------------
// Suggestions

/**
 * @typedef {object} SuggestOptions
 * @property {(purpose: string, input: unknown, opts: Record<string, unknown>) => Promise<{ ok: boolean, tier?: string, value?: unknown }>} run  router.js runPurpose
 * @property {readonly string[]} providers  who may see the turn (the provider that answered; none: only the model on this device)
 * @property {PromptLocale} [locale]
 * @property {AbortSignal} [signal]
 */

/**
 * Notes a model suggests after a turn, without the ones already kept. Nothing is stored here: the
 * caller shows them and stores only what the user accepts.
 * @param {{ question: string, answer: string, existing: readonly string[] }} input
 * @param {SuggestOptions} opts
 * @returns {Promise<Array<{ text: string, kind: string }>>}
 */
export async function suggestFacts(input, opts) {
  const question = String(input.question ?? '').trim();
  const answer = String(input.answer ?? '').trim();
  if (!question || !answer) return [];
  const existing = input.existing.slice(0, 200);
  const res = await opts.run(
    'memory_suggest',
    { messages: [{ role: 'user', text: question.slice(0, 1500) }, { role: 'assistant', text: answer.slice(0, 1500) }], existing },
    { cache: 'off', providers: [...opts.providers], maxCalls: 2, ...(opts.locale ? { locale: opts.locale } : {}), ...(opts.signal ? { signal: opts.signal } : {}) },
  );
  if (!res.ok || res.tier === 'template' || !res.value || typeof res.value !== 'object') return [];
  const kept = new Set(existing.map(squash));
  /** @type {Array<{ text: string, kind: string }>} */
  const out = [];
  for (const m of /** @type {{ memories?: unknown }} */ (res.value).memories instanceof Array ? /** @type {any[]} */ (/** @type {any} */ (res.value).memories) : []) {
    const text = cleanFactText(m?.text);
    const key = squash(text);
    if (Array.from(text).length < MIN_FACT_CHARS || kept.has(key)) continue;
    kept.add(key);
    out.push({ text, kind: typeof m?.kind === 'string' ? m.kind : 'fact' });
    if (out.length >= 3) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Store

/**
 * @param {unknown} value
 * @returns {value is StoredFact}
 */
function isStoredFact(value) {
  if (!value || typeof value !== 'object') return false;
  const r = /** @type {Record<string, any>} */ (value);
  return typeof r.id === 'string' && typeof r.text === 'string' && typeof r.scope === 'string' && Number.isFinite(r.createdAt);
}

/**
 * @param {StoredFact} record
 * @param {string} text
 * @returns {Fact}
 */
function toFact(record, text) {
  return {
    id: record.id,
    text,
    scope: record.scope,
    source: record.source === 'suggested' ? 'suggested' : 'explicit',
    createdAt: record.createdAt,
    usedAt: Number.isFinite(record.usedAt) ? Number(record.usedAt) : null,
    weight: Number.isFinite(record.weight) ? Number(record.weight) : 1,
    sealed: Boolean(record.sealed),
  };
}

/**
 * @typedef {object} MemoryStoreOptions
 * @property {() => Promise<StoreDb>} [open]  the database (default: the app database)
 * @property {() => number} [now]
 * @property {() => string} [uuid]
 * @property {MemoryVault | null} [vault]  null: notes are never sealed
 * @property {string | null} [channel]  BroadcastChannel name for changes between tabs (none by default)
 */

/**
 * Builds a memory store.
 * @param {MemoryStoreOptions} [options]
 */
export function createMemoryStore(options = {}) {
  const open = options.open ?? appDb;
  const now = options.now ?? Date.now;
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const vault = options.vault ?? null;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** Texts of sealed notes read while the vault was open: forgetting the vault keeps them readable. */
  /** @type {Map<string, string>} */
  const opened = new Map();
  /** @type {BroadcastChannel | null} */
  let channel = null;
  if (options.channel && typeof BroadcastChannel === 'function') {
    try {
      channel = new BroadcastChannel(options.channel);
      channel.onmessage = () => deliver();
    } catch {
      channel = null;
    }
  }

  let tail = Promise.resolve();
  /**
   * Runs store calls one after the other.
   * @template T
   * @param {(db: StoreDb) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function serial(fn) {
    const run = tail.then(() => open()).then(fn);
    tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  function deliver() {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch (err) {
        console.error('[starpi] a memory listener failed', err);
      }
    }
  }

  function emit() {
    deliver();
    try {
      channel?.postMessage('change');
    } catch {
      // The other tabs only miss this change.
    }
  }

  const vaultState = () => vault?.state() ?? 'none';

  /**
   * The text of a note; null when it is sealed and the vault cannot open it now.
   * @param {StoredFact} record
   */
  async function readText(record) {
    if (!record.sealed) return record.text;
    const text = vault ? await vault.open(record.sealed) : null;
    if (text !== null) opened.set(record.id, text);
    return text;
  }

  /**
   * A note's text as it is written: sealed while a passphrase is set.
   * @param {string} text
   * @returns {Promise<{ text: string, sealed?: SealedText }>}
   */
  async function writable(text) {
    const state = vaultState();
    if (state === 'locked') throw new MemoryError('locked');
    if (state === 'unlocked' && vault) return { text: '', sealed: await vault.seal(text) };
    return { text };
  }

  /** @param {StoreDb} db @returns {Promise<StoredFact[]>} */
  const all = async (db) => (await db.getAll('memory')).filter(isStoredFact);

  /**
   * @param {StoreDb} db
   * @param {string} id
   * @returns {Promise<StoredFact>}
   */
  async function mustGet(db, id) {
    const record = await db.get('memory', id);
    if (!isStoredFact(record)) throw new MemoryError('not_found');
    return record;
  }

  /**
   * @param {StoreDb} db
   * @param {string} key
   * @returns {Promise<unknown>}
   */
  const readSetting = async (db, key) => /** @type {SettingsRecord | undefined} */ (await db.get('settings', key))?.value;

  const store = {
    /**
     * Every readable note, newest first, and how many sealed notes the vault cannot open now.
     * @returns {Promise<{ facts: Fact[], locked: number }>}
     */
    list() {
      return serial(async (db) => {
        /** @type {Fact[]} */
        const facts = [];
        let locked = 0;
        for (const record of await all(db)) {
          const text = await readText(record);
          if (text === null) locked += 1;
          else facts.push(toFact(record, text));
        }
        facts.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1));
        return { facts, locked };
      });
    },

    /**
     * Keeps a note. Only an explicit act stores one: 'explicit' (Remember this, the add field) or
     * 'suggested' (the user accepted a suggestion).
     * @param {{ text: string, scope?: string, source: 'explicit' | 'suggested' }} input
     * @returns {Promise<Fact>}
     */
    add(input) {
      const text = cleanFactText(input?.text);
      if (input?.source !== 'explicit' && input?.source !== 'suggested') return Promise.reject(new MemoryError('source'));
      if (Array.from(text).length < MIN_FACT_CHARS) return Promise.reject(new MemoryError('empty'));
      const scope = cleanScope(input.scope);
      return serial(async (db) => {
        const records = await all(db);
        if (records.length >= MEMORY_LIMITS.facts) throw new MemoryError('full');
        const key = squash(text);
        for (const record of records) {
          if (record.scope !== scope) continue;
          const known = await readText(record);
          if (known !== null && squash(known) === key) throw new MemoryError('duplicate');
        }
        /** @type {StoredFact} */
        const record = { id: uuid(), ...(await writable(text)), scope, source: input.source, createdAt: now(), usedAt: null, weight: 1 };
        await db.add('memory', record);
        if (record.sealed) opened.set(record.id, text);
        emit();
        return toFact(record, text);
      });
    },

    /**
     * Changes a note's text or scope.
     * @param {string} id
     * @param {{ text?: string, scope?: string }} patch
     * @returns {Promise<Fact>}
     */
    update(id, patch) {
      return serial(async (db) => {
        const record = { ...(await mustGet(db, id)) };
        let text = await readText(record);
        if (patch.text !== undefined) {
          const next = cleanFactText(patch.text);
          if (Array.from(next).length < MIN_FACT_CHARS) throw new MemoryError('empty');
          const body = await writable(next);
          record.text = body.text;
          if (body.sealed) record.sealed = body.sealed;
          else delete record.sealed;
          text = next;
          if (record.sealed) opened.set(id, next);
          else opened.delete(id);
        }
        if (text === null) throw new MemoryError('locked');
        if (patch.scope !== undefined) record.scope = cleanScope(patch.scope);
        await db.put('memory', record);
        emit();
        return toFact(record, text);
      });
    },

    /**
     * @param {string} id
     * @returns {Promise<void>}
     */
    remove(id) {
      return serial(async (db) => {
        await db.delete('memory', id);
        opened.delete(id);
        emit();
      });
    },

    /**
     * Deletes the notes of one scope (a deleted project's).
     * @param {string} scope
     * @returns {Promise<number>} how many were deleted
     */
    removeScope(scope) {
      return serial(async (db) => {
        const ids = await db.getAllKeysFromIndex('memory', 'scope', scope);
        await db.transaction('memory', 'readwrite', async (tx) => {
          await Promise.all(ids.map((k) => tx.delete('memory', k)));
        });
        for (const k of ids) opened.delete(String(k));
        if (ids.length) emit();
        return ids.length;
      });
    },

    /**
     * Deletes every note.
     * @returns {Promise<void>}
     */
    clear() {
      return serial(async (db) => {
        await db.clear('memory');
        opened.clear();
        emit();
      });
    },

    /**
     * Deletes the sealed notes the vault cannot open now (sealed under a passphrase that is gone).
     * @returns {Promise<number>}
     */
    removeUnreadable() {
      return serial(async (db) => {
        let n = 0;
        for (const record of await all(db)) {
          if ((await readText(record)) !== null) continue;
          await db.delete('memory', record.id);
          n += 1;
        }
        if (n) emit();
        return n;
      });
    },

    /**
     * Notes that just went along with a question: their recency starts again and their weight grows.
     * @param {readonly string[]} ids
     * @returns {Promise<void>}
     */
    markUsed(ids) {
      if (!ids.length) return Promise.resolve();
      return serial(async (db) => {
        const at = now();
        await db.transaction('memory', 'readwrite', async (tx) => {
          for (const id of ids) {
            const record = await tx.get('memory', id);
            if (!isStoredFact(record)) continue;
            await tx.put('memory', { ...record, usedAt: at, weight: Math.min(MAX_WEIGHT, (Number(record.weight) || 1) + 1) });
          }
        });
      });
    },

    /**
     * Brings the stored form in line with the vault: an unlocked vault seals every plain note; once
     * the vault is gone, the sealed notes read while it was open are kept as plain text again (the
     * others stay unreadable until removeUnreadable).
     * @returns {Promise<number>} notes rewritten
     */
    reconcile() {
      return serial(async (db) => {
        const state = vaultState();
        let n = 0;
        for (const record of await all(db)) {
          if (state === 'unlocked' && !record.sealed) {
            if (!vault) continue;
            const sealed = await vault.seal(record.text);
            await db.put('memory', { ...record, text: '', sealed });
            opened.set(record.id, record.text);
            n += 1;
          } else if ((state === 'none' || state === 'unavailable') && record.sealed && opened.has(record.id)) {
            /** @type {StoredFact} */
            const plain = { ...record, text: /** @type {string} */ (opened.get(record.id)) };
            delete plain.sealed;
            await db.put('memory', plain);
            opened.delete(record.id);
            n += 1;
          }
        }
        if (n) emit();
        return n;
      });
    },

    /**
     * The readable notes as a `starpi.memory/v1` document.
     * @param {{ exportedAt: string, version: string, projectName?: (id: string) => string | null }} meta
     */
    async exportDoc(meta) {
      const { facts, locked } = await store.list();
      return {
        schema: MEMORY_EXPORT,
        generator: { name: 'starpi', version: meta.version },
        exportedAt: meta.exportedAt,
        facts: facts.map((f) => ({
          text: f.text,
          scope: f.scope === 'global' ? 'global' : 'project',
          ...(f.scope !== 'global' ? { project: meta.projectName?.(f.scope) ?? null } : {}),
          source: f.source,
          createdAt: new Date(f.createdAt).toISOString(),
          usedAt: f.usedAt ? new Date(f.usedAt).toISOString() : null,
        })),
        ...(locked ? { omitted: locked } : {}),
      };
    },

    /** @returns {Promise<MemoryPrefs>} */
    prefs() {
      return serial(async (db) => {
        const value = /** @type {Partial<MemoryPrefs> | undefined} */ (await readSetting(db, PREFS_KEY));
        return { enabled: value?.enabled === true, suggest: value?.suggest === true };
      });
    },

    /**
     * @param {Partial<MemoryPrefs>} patch
     * @returns {Promise<MemoryPrefs>}
     */
    setPrefs(patch) {
      return serial(async (db) => {
        const value = /** @type {Partial<MemoryPrefs> | undefined} */ (await readSetting(db, PREFS_KEY));
        const next = { enabled: (patch.enabled ?? value?.enabled) === true, suggest: (patch.suggest ?? value?.suggest) === true };
        await db.put('settings', /** @type {SettingsRecord} */ ({ key: PREFS_KEY, value: next, updatedAt: now() }));
        emit();
        return next;
      });
    },

    /** @returns {Promise<CustomInstructions>} */
    instructions() {
      return serial(async (db) => {
        const value = /** @type {Partial<CustomInstructions> | undefined} */ (await readSetting(db, INSTRUCTIONS_KEY));
        return { aboutMe: cleanInstruction(value?.aboutMe), howToAnswer: cleanInstruction(value?.howToAnswer) };
      });
    },

    /**
     * @param {Partial<CustomInstructions>} input
     * @returns {Promise<CustomInstructions>}
     */
    setInstructions(input) {
      return serial(async (db) => {
        const value = /** @type {Partial<CustomInstructions> | undefined} */ (await readSetting(db, INSTRUCTIONS_KEY));
        const next = { aboutMe: cleanInstruction(input.aboutMe ?? value?.aboutMe), howToAnswer: cleanInstruction(input.howToAnswer ?? value?.howToAnswer) };
        await db.put('settings', /** @type {SettingsRecord} */ ({ key: INSTRUCTIONS_KEY, value: next, updatedAt: now() }));
        emit();
        return next;
      });
    },

    /**
     * Listens to changes of notes, switches and instructions, here and in other tabs.
     * @param {() => void} listener
     * @returns {() => void}
     */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Stops the change channel between tabs. */
    close() {
      channel?.close();
      channel = null;
    },
  };
  return store;
}

/** @typedef {ReturnType<typeof createMemoryStore>} MemoryStore */
