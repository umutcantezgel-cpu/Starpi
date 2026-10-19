// @ts-check
// Adapter for the paired companion (Starpi Core, packages/companion): provider `companion`. It is an
// SDK-kind adapter without a transport: the call goes to the companion's POST /v1/chat with the
// stored pairing (companion/pair.js, tier.js streamCompanion), so the sign-in, the audit head check
// and the no-store rule of the companion client apply as for every other companion request.
//
// The companion answers in a conversation it keeps itself and passes every answer through its own
// sentence gate before anything leaves it. This adapter therefore sends only the question (the last
// user message; the system prompt of the app is not the companion's) and the companion's
// conversation id, which it finds in the provider state of the companion's earlier answers in the
// history. It passes the released answer through unchanged:
//   - each released unit becomes a text delta, so the answer shows as it is released;
//   - a withdrawal (`reset`) cannot be undone in an event stream: `onText` hears the visible text
//     after every unit and every withdrawal, so a view can show exactly what is released now;
//   - the finished answer comes as one opaque block of kind `companion-turn`: the released text as
//     the gate released it, its mode, source (model or template), notice code, withheld count,
//     locality, served model and data class, and the conversation and turn. The chat stores that
//     text and that label; nothing here checks, rewrites or caches it.
// Nothing is loaded before a call: the pairing and the tier load with the first question.
import { capsFor, COMPANION_MODEL } from '../catalog/models.js';
import { AiError } from '../errors.js';
import { fileAsText } from './common.js';

/** @typedef {import('../contract.js').AiRequest} AiRequest */
/** @typedef {import('../contract.js').AiEvent} AiEvent */
/** @typedef {import('../stream.js').SdkAdapter} SdkAdapter */
/** @typedef {import('../errors.js').AiErrorCode} AiErrorCode */
/** @typedef {import('../../companion/pair.js').Pairing} Pairing */
/** @typedef {import('../../companion/tier.js').CompanionAnswer} CompanionAnswer */

export { COMPANION_MODEL };
/** The kind of the opaque block a companion answer carries. */
export const COMPANION_BLOCK = 'companion-turn';
/** The longest question the companion takes (tier.js MAX_QUESTION_CHARS). */
export const COMPANION_QUESTION_CHARS = 8_000;
/** Longest silence of this adapter's events while the companion works (its stream pings on its own). */
export const HEARTBEAT_MS = 20_000;

const CONVERSATION = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The finished answer as the chat stores it.
 * @typedef {object} CompanionTurn
 * @property {typeof COMPANION_BLOCK} kind
 * @property {string} conversation
 * @property {number} turn
 * @property {string} text                 the released text, as the gate released it
 * @property {'sources' | 'free'} mode
 * @property {'model' | 'template'} source
 * @property {string | null} notice        the notice code of a template answer
 * @property {number} withheld             units the gate withheld
 * @property {string} locality             'local', 'cloud' or 'none'
 * @property {string | null} model         the companion's model that answered
 * @property {string} dataClass
 */

/**
 * @typedef {object} CompanionAdapterOptions
 * @property {'sources' | 'free'} [mode]          how the companion answers (default free)
 * @property {'sensitive'} [dataClass]            sensitive: no cloud model of the companion may see the question
 * @property {(text: string) => void} [onText]    the visible answer after every released unit and every withdrawal
 * @property {() => Promise<Pairing>} [pairing]   the page's pairing (default: companion/pair.js companionPairing)
 * @property {typeof import('../../companion/tier.js').streamCompanion} [streamCompanion]
 * @property {number} [heartbeatMs]
 */

/** Companion error codes and the AI layer's codes for them. */
const ERROR_CODES = /** @type {Readonly<Record<string, AiErrorCode>>} */ ({
  unreachable: 'network',
  timeout: 'timeout',
  aborted: 'aborted',
  not_paired: 'auth',
  unauthenticated: 'auth',
  forbidden: 'auth',
  origin_not_allowed: 'auth',
  conversation_busy: 'rate_limited',
  breaker_engaged: 'rate_limited',
  question_too_long: 'context_length',
  question_empty: 'bad_request',
  body_invalid: 'bad_request',
  not_found: 'not_found',
  conversation_unknown: 'not_found',
  stream_failed: 'stream_cut',
  bad_response: 'bad_response',
});

/**
 * An AiError for whatever a companion call threw; the companion's own code stays as providerCode.
 * @param {unknown} err
 * @returns {AiError}
 */
export function companionAiError(err) {
  if (err instanceof AiError) return err;
  const code = err && typeof err === 'object' && typeof (/** @type {any} */ (err).code) === 'string' ? /** @type {string} */ (/** @type {any} */ (err).code) : '';
  return new AiError(ERROR_CODES[code] ?? 'server', { provider: 'companion', providerCode: code || null, cause: err });
}

/**
 * The question of a request: the text of the last user message, with text files written out (the
 * companion reads text only; images and PDFs stay here).
 * @param {AiRequest} req
 */
export function questionOf(req) {
  const last = [...req.messages].reverse().find((m) => m.role === 'user');
  if (!last) return '';
  return last.content
    .map((p) => (p.type === 'text' ? p.text : p.type === 'file' && p.mime !== 'application/pdf' ? fileAsText(p.name, p.data) : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

/**
 * The companion turn an opaque block holds, or null.
 * @param {unknown} block
 * @returns {CompanionTurn | null}
 */
export function companionTurnOf(block) {
  if (!block || typeof block !== 'object') return null;
  const b = /** @type {Record<string, unknown>} */ (block);
  if (b.kind !== COMPANION_BLOCK || typeof b.text !== 'string' || typeof b.conversation !== 'string' || !CONVERSATION.test(b.conversation)) return null;
  return /** @type {CompanionTurn} */ (b);
}

/**
 * The companion conversation a request continues: the one of the latest companion answer in its
 * history; null for a first question.
 * @param {AiRequest} req
 * @returns {string | null}
 */
export function conversationOf(req) {
  for (let i = req.messages.length - 1; i >= 0; i -= 1) {
    const m = req.messages[i];
    if (m.role !== 'assistant') continue;
    for (const part of m.content) {
      if (part.type !== 'opaque' || part.provider !== 'companion') continue;
      const turn = companionTurnOf(part.block);
      if (turn) return turn.conversation;
    }
  }
  return null;
}

/**
 * The visible text of released units: sentences joined by a space, list items and table rows by a
 * line break, anything else by a blank line. Only for the live view: the finished answer brings
 * the companion's own text.
 * @param {Array<{ text: string, kind: string }>} units
 */
export function liveText(units) {
  let out = '';
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    if (i > 0) {
      const prev = units[i - 1].kind;
      out += prev === 'sentence' && unit.kind === 'sentence' ? ' ' : prev === unit.kind && (unit.kind === 'item' || unit.kind === 'row') ? '\n' : '\n\n';
    }
    out += unit.text;
  }
  return out;
}

/**
 * @param {CompanionAnswer} answer
 * @param {{ conversation: string, turn: number }} where
 * @param {'sources' | 'free'} mode
 * @returns {CompanionTurn}
 */
function turnRecord(answer, where, mode) {
  return {
    kind: COMPANION_BLOCK,
    conversation: String(where.conversation).slice(0, 64),
    turn: Number.isSafeInteger(where.turn) ? where.turn : 0,
    text: answer.text,
    mode: answer.mode === 'sources' || answer.mode === 'free' ? answer.mode : mode,
    source: answer.source === 'template' ? 'template' : 'model',
    notice: typeof answer.notice === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(answer.notice) ? answer.notice : null,
    withheld: Array.isArray(answer.withheld) ? answer.withheld.length : 0,
    locality: typeof answer.locality === 'string' && /^[a-z]{1,16}$/.test(answer.locality) ? answer.locality : 'none',
    model: typeof answer.model === 'string' && answer.model ? answer.model.slice(0, 120) : null,
    dataClass: typeof answer.dataClass === 'string' && /^[a-z]{1,16}$/.test(answer.dataClass) ? answer.dataClass : 'personal',
  };
}

/**
 * @param {CompanionAdapterOptions} [options]
 * @returns {SdkAdapter}
 */
export function createCompanionAdapter(options = {}) {
  const mode = options.mode === 'sources' ? 'sources' : 'free';
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const loadPairing = options.pairing ?? (async () => (await import('../../companion/pair.js')).companionPairing());
  return {
    kind: 'sdk',
    id: 'companion',
    dialect: 'companion',
    capabilities: (modelId, catalog) => capsFor('companion', modelId, catalog),
    async *stream(req, context) {
      const question = questionOf(req);
      if (!question) throw new AiError('bad_request', { provider: 'companion' });
      if (question.length > COMPANION_QUESTION_CHARS) throw new AiError('context_length', { provider: 'companion' });
      let pairing;
      try {
        pairing = await loadPairing();
        await pairing.restore();
      } catch (err) {
        throw companionAiError(err);
      }
      if (pairing.state().phase !== 'paired') throw new AiError('auth', { provider: 'companion', providerCode: 'not_paired' });
      const stream = options.streamCompanion ?? (await import('../../companion/tier.js')).streamCompanion;

      /** @type {Array<{ kind: 'text', text: string } | { kind: 'done', turn: CompanionTurn } | { kind: 'failed', error: unknown }>} */
      const queue = [];
      /** @type {(() => void) | null} */
      let wake = null;
      const push = (/** @type {typeof queue[number]} */ item) => {
        queue.push(item);
        const fn = wake;
        wake = null;
        fn?.();
      };
      /** @type {Array<{ text: string, kind: string }>} */
      const units = [];
      /** The text handed out as deltas; after a withdrawal the deltas stop (the opaque block has the answer). */
      let emitted = '';
      let withdrawn = false;
      const show = () => {
        const text = liveText(units);
        try {
          options.onText?.(text);
        } catch {
          // a view's failure must not end the answer
        }
        if (!withdrawn && text.startsWith(emitted) && text.length > emitted.length) {
          push({ kind: 'text', text: text.slice(emitted.length) });
          emitted = text;
        }
      };
      const conversation = conversationOf(req);
      stream(
        pairing,
        { question, mode, ...(options.dataClass ? { dataClass: options.dataClass } : {}), conversation, signal: context.signal },
        {
          onUnit(unit) {
            units.push(unit);
            show();
          },
          onReset(e) {
            const n = Number(e?.withdrawn);
            units.splice(Math.max(0, units.length - (Number.isFinite(n) && n > 0 ? n : units.length)));
            withdrawn = true;
            show();
          },
        },
      ).then(
        (done) => push({ kind: 'done', turn: turnRecord(done.answer, done, mode) }),
        (err) => push({ kind: 'failed', error: err }),
      );

      yield { type: 'start', provider: 'companion', model: req.model || COMPANION_MODEL };
      for (;;) {
        if (!queue.length) {
          /** @type {ReturnType<typeof setTimeout> | undefined} */
          let timer;
          const beat = await new Promise((resolve) => {
            wake = () => resolve(false);
            timer = setTimeout(() => resolve(true), heartbeatMs);
          });
          clearTimeout(timer);
          wake = null;
          // The companion is still working (its stream is kept alive by its pings): say so, so the
          // call's idle limit does not end a long answer.
          if (beat && !queue.length) {
            yield { type: 'reasoning', tokens: 0 };
            continue;
          }
        }
        const item = /** @type {typeof queue[number]} */ (queue.shift());
        if (item.kind === 'text') {
          yield { type: 'text', delta: item.text };
          continue;
        }
        if (item.kind === 'failed') throw companionAiError(item.error);
        const turn = item.turn;
        // Normally the deltas already spell the answer; the rest comes now when they do not end it.
        if (!withdrawn && turn.text.startsWith(emitted) && turn.text.length > emitted.length) yield { type: 'text', delta: turn.text.slice(emitted.length) };
        yield { type: 'opaque', block: turn };
        yield { type: 'end', stopReason: 'end_turn' };
        return;
      }
    },
  };
}
