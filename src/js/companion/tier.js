// @ts-check
// The companion as a tier of the app's answers and as a source of the chat's grounded questions.
//
// Tier `companion`: a question goes to the companion (POST /v1/chat, streamed; POST /v1/ask for one
// JSON answer), which answers from its own documents, notes and feed readings (mode `sources`) or
// from general knowledge (mode `free`) with the models it is configured for, routed by data class
// on that machine. Every answer has already passed the companion's sentence gate, so the browser
// passes it through unchanged: released units are shown as they arrive, withdrawn ones go away on
// `reset`, and nothing is checked, rewritten or cached here. Answers are not kept in the browser at
// all: the conversation lives sealed in the companion, and the Companion tab reads it from there.
// A template answer carries a notice code (no model, secret content, a resting model, ...), which
// the app translates (companion.notice.<code>).
//
// Source "Companion documents and notes": a grounded question in the chat also searches the
// companion (POST /v1/retrieval/search), and its passages join the excerpts of the question like
// library passages; the browser's own source check then judges the answer. Which passages may come:
//   - a question that stays on this device (the device model only): passages up to the class
//     `sensitive`. The companion runs on this machine, so asking it keeps the question here, and
//     the passages reach no model but the one in this browser. This is a deliberate choice: the
//     companion is part of "this device" for the question's storage rule.
//   - any other question may reach a model in the cloud: passages up to the ceiling the user chose
//     (`personal` by default, matching the companion's own default for cloud models; `public` when
//     the companion is set to keep personal content local). `secret` passages never leave it.
// The class of every passage is checked again here, whatever the companion answered. The search
// waits at most SOURCE_TIMEOUT_MS, so a slow companion never holds an answer back.
import { t } from '../i18n/index.js';
import { readLocalJson, writeLocalJson } from '../storage.js';
import { CompanionError } from './client.js';

/** @typedef {import('./pair.js').Pairing} Pairing */
/** @typedef {import('../supabase.js').KnowledgeHit} KnowledgeHit */
/** @typedef {'public' | 'personal' | 'sensitive' | 'secret'} DataClass */

/** The tier id of the companion among the app's answer routes. */
export const COMPANION_TIER = 'companion';
/** The id of the retrieval source. */
export const COMPANION_SOURCE = 'companion';
/** Data classes, weakest first (the companion's order). */
export const DATA_CLASSES = Object.freeze(/** @type {const} */ (['public', 'personal', 'sensitive', 'secret']));
/** Notice codes of the companion's router, each with its text under companion.notice.<code>. */
export const NOTICE_CODES = Object.freeze(['no_model', 'class_secret', 'no_brain_for_class', 'brain_unavailable', 'brain_failed_midway', 'refusal', 'breaker']);
/** Passages one grounded question takes from the companion at most. */
export const SOURCE_PASSAGES = 4;
export const SOURCE_TIMEOUT_MS = 4_000;
export const MAX_QUESTION_CHARS = 8_000;
const SETTINGS_KEY = 'starpi_companion_source';

/**
 * @typedef {object} SourceSettings
 * @property {boolean} enabled               grounded questions search the companion
 * @property {'public' | 'personal'} cloudCeiling  the most protected class a question that may reach the cloud takes
 */

/** @type {SourceSettings} */
const DEFAULT_SETTINGS = Object.freeze({ enabled: true, cloudCeiling: 'personal' });

/** @param {unknown} c @returns {number} */
export const classRank = (c) => DATA_CLASSES.indexOf(/** @type {DataClass} */ (c));

/** @returns {SourceSettings} */
export function sourceSettings() {
  const stored = readLocalJson(SETTINGS_KEY, /** @type {Partial<SourceSettings> | null} */ (null));
  return {
    enabled: typeof stored?.enabled === 'boolean' ? stored.enabled : DEFAULT_SETTINGS.enabled,
    cloudCeiling: stored?.cloudCeiling === 'public' ? 'public' : 'personal',
  };
}

/** @param {Partial<SourceSettings>} patch */
export function setSourceSettings(patch) {
  const next = { ...sourceSettings(), ...patch };
  writeLocalJson(SETTINGS_KEY, next);
  return next;
}

/**
 * The most protected class a question may take from the companion.
 * @param {{ deviceOnly: boolean }} ctx
 * @param {SourceSettings} settings
 * @returns {DataClass}
 */
export function ceilingFor(ctx, settings) {
  return ctx.deviceOnly ? 'sensitive' : settings.cloudCeiling;
}

/**
 * Companion passages in the shape of library hits. A passage above the ceiling is dropped, whatever
 * the companion sent.
 * @param {unknown} passages
 * @param {DataClass} ceiling
 * @returns {KnowledgeHit[]}
 */
export function passagesToHits(passages, ceiling) {
  if (!Array.isArray(passages)) return [];
  /** @type {KnowledgeHit[]} */
  const hits = [];
  for (const p of passages) {
    if (!p || typeof p !== 'object' || typeof p.text !== 'string' || !p.text.trim() || typeof p.id !== 'string') continue;
    const rank = classRank(p.dataClass);
    if (rank < 0 || rank > classRank(ceiling)) continue;
    const note = p.collection === 'notes';
    hits.push({
      documentId: `companion:${p.id}`.slice(0, 100),
      documentTitle: typeof p.title === 'string' && p.title.trim() ? p.title.trim().slice(0, 200) : t(note ? 'companion.source.untitled_note' : 'companion.source.untitled_document'),
      heading: t(note ? 'companion.source.note' : 'companion.source.document'),
      content: p.text,
      tags: ['companion', note ? 'note' : 'document', p.dataClass],
      rank: typeof p.keywordScore === 'number' ? p.keywordScore : typeof p.score === 'number' ? p.score : null,
    });
  }
  return hits;
}

/**
 * The retrieval source for the chat's grounded questions.
 * @param {() => Promise<Pairing>} pairingOf
 * @param {{ settings?: () => SourceSettings, timeoutMs?: number }} [opts]
 */
export function companionSource(pairingOf, opts = {}) {
  const settingsOf = opts.settings ?? sourceSettings;
  return {
    id: COMPANION_SOURCE,
    /**
     * @param {string} query
     * @param {{ deviceOnly: boolean }} ctx
     * @returns {Promise<{ hits: KnowledgeHit[], label: string }>}
     */
    async search(query, ctx) {
      const settings = settingsOf();
      if (!settings.enabled) return { hits: [], label: '' };
      const pairing = await pairingOf();
      await pairing.restore();
      if (pairing.state().phase !== 'paired') return { hits: [], label: '' };
      const ceiling = ceilingFor(ctx, settings);
      const signal = AbortSignal.timeout(opts.timeoutMs ?? SOURCE_TIMEOUT_MS);
      try {
        const answer = await pairing.call('POST', '/v1/retrieval/search', { body: { query: query.slice(0, 2000), k: SOURCE_PASSAGES, maxClass: ceiling, collections: ['notes', 'documents'] }, signal });
        const hits = passagesToHits(answer?.passages, ceiling);
        return { hits, label: hits.length ? t('companion.retrieval.method', { n: hits.length }) : '' };
      } catch (err) {
        if (!(err instanceof CompanionError)) console.warn('[starpi] the companion search failed', err);
        return { hits: [], label: t('companion.retrieval.unavailable') };
      }
    },
  };
}

/**
 * The text of a notice code (null when the answer came from a model).
 * @param {unknown} code
 */
export function noticeKey(code) {
  return typeof code === 'string' && NOTICE_CODES.includes(code) ? `companion.notice.${code}` : code ? 'companion.notice.other' : null;
}

/**
 * @typedef {object} CompanionAnswer
 * @property {string} id
 * @property {string} text                                 the released text, as the gate released it
 * @property {Array<{ text: string, cites: string[], kind: string }>} units
 * @property {Array<{ reason: string, kind: string }>} withheld
 * @property {Array<{ label: string, kind: string, title: string, dataClass: string }>} sources
 * @property {'sources' | 'free'} mode
 * @property {DataClass} dataClass
 * @property {string | null} model
 * @property {string} locality                             'local', 'cloud' or 'none'
 * @property {'model' | 'template'} source
 * @property {string | null} notice
 * @property {{ released: number, withheld: number }} counts
 */

/**
 * @typedef {object} AskInput
 * @property {string} question
 * @property {'sources' | 'free'} [mode]
 * @property {DataClass} [dataClass]
 * @property {string | null} [conversation]
 * @property {boolean} [tools]
 * @property {AbortSignal} [signal]
 */

/** @param {AskInput} input */
function questionBody(input) {
  const question = String(input.question ?? '').trim();
  if (!question) throw new CompanionError('question_empty');
  if (question.length > MAX_QUESTION_CHARS) throw new CompanionError('question_too_long');
  return {
    question,
    mode: input.mode === 'free' ? 'free' : 'sources',
    ...(input.dataClass && classRank(input.dataClass) >= 0 ? { dataClass: input.dataClass } : {}),
    ...(input.conversation ? { conversation: input.conversation } : {}),
    ...(input.tools ? { tools: true } : {}),
  };
}

/**
 * One question, one JSON answer (POST /v1/ask), passed through as the companion released it.
 * @param {Pairing} pairing
 * @param {AskInput} input
 * @returns {Promise<CompanionAnswer>}
 */
export async function askCompanion(pairing, input) {
  const body = questionBody(input);
  delete (/** @type {any} */ (body).conversation);
  delete (/** @type {any} */ (body).tools);
  const answer = await pairing.call('POST', '/v1/ask', { body, signal: input.signal, timeoutMs: 180_000 });
  if (!answer?.answer || typeof answer.answer.text !== 'string') throw new CompanionError('bad_response');
  return answer.answer;
}

/**
 * @typedef {object} StreamHandlers
 * @property {(e: { conversation: string, turn: number }) => void} [onStart]
 * @property {(e: { mode: string, dataClass: string, sources: unknown[], tools: string[] }) => void} [onSources]
 * @property {(unit: { text: string, cites: string[], kind: string }) => void} [onUnit]
 * @property {(e: { withdrawn: number }) => void} [onReset]
 * @property {(e: { tool: string, state: string, code?: string | null }) => void} [onTool]
 * @property {(e: { id: string, server: string, tool: string, expires: string, reason: string }) => void} [onApproval]
 */

/**
 * A question in a companion conversation (POST /v1/chat): units arrive as the gate releases them.
 * Resolves with the finished answer and the conversation it belongs to.
 * @param {Pairing} pairing
 * @param {AskInput} input
 * @param {StreamHandlers} [handlers]
 * @returns {Promise<{ conversation: string, turn: number, answer: CompanionAnswer }>}
 */
export async function streamCompanion(pairing, input, handlers = {}) {
  /** @type {{ conversation: string, turn: number, answer: CompanionAnswer } | null} */
  let done = null;
  await pairing.stream('POST', '/v1/chat', {
    body: questionBody(input),
    signal: input.signal,
    onEvent(event, data) {
      if (!data || typeof data !== 'object') return;
      if (event === 'start') handlers.onStart?.(data);
      else if (event === 'sources') handlers.onSources?.(data);
      else if (event === 'unit' && typeof data.text === 'string') handlers.onUnit?.({ text: data.text, cites: Array.isArray(data.cites) ? data.cites : [], kind: String(data.kind ?? 'sentence') });
      else if (event === 'reset') handlers.onReset?.(data);
      else if (event === 'tool') handlers.onTool?.(data);
      else if (event === 'approval') handlers.onApproval?.(data);
      else if (event === 'done' && data.answer && typeof data.answer.text === 'string') done = { conversation: String(data.conversation), turn: Number(data.turn) || 0, answer: data.answer };
    },
  });
  if (!done) throw new CompanionError(input.signal?.aborted ? 'aborted' : 'stream_failed');
  return done;
}

/**
 * Decides a tool call that waits in a companion conversation.
 * @param {Pairing} pairing
 * @param {string} id
 * @param {'approve' | 'deny'} decision
 */
export function decideApproval(pairing, id, decision) {
  return pairing.call('POST', `/v1/connectors/approvals/${encodeURIComponent(id)}`, { body: { decision } });
}
