// @ts-check
// Conversations of the chat, sealed in the vault namespace `chats`: one record per conversation
// (title, times, data class, number of turns) and one item per turn (the question and the answer
// exactly as it was released, with its citations). A conversation's data class only ever rises: a
// turn that drew on sensitive content makes the whole history sensitive, so a later question never
// carries that history to a model the class does not allow.
import { isRecord } from '../contracts/check.js';
import { strictest } from '../contracts/data-classes.js';
import { isoAt } from '../lib/clock.js';
import { fail } from '../lib/errors.js';
import { clip, idPattern, newId } from '../setup/kit.js';

export const CHATS_NAMESPACE = 'chats';
export const MAX_TURNS = 10_000;
const CONVERSATION_ID = idPattern('conv');

/**
 * @typedef {object} Conversation
 * @property {string} id
 * @property {string} title
 * @property {string} created
 * @property {string} updated
 * @property {import('../contracts/data-classes.js').DataClass} dataClass
 * @property {number} turns
 */

/**
 * @typedef {object} Turn
 * @property {number} n
 * @property {string} question
 * @property {import('./engine.js').Answer} answer
 * @property {string} at
 */

/** @param {string} id @param {number} n */
const turnId = (id, n) => `${id}.t${String(n).padStart(6, '0')}`;

/**
 * @param {{ namespace: any, clock: import('../lib/clock.js').Clock }} deps
 */
export function createChatStore({ namespace, clock }) {
  /** @param {string} id @returns {Conversation | null} */
  function get(id) {
    if (!CONVERSATION_ID.test(id)) return null;
    const value = namespace.getJson(id);
    return isRecord(value) && value.id === id ? /** @type {Conversation} */ (/** @type {unknown} */ (value)) : null;
  }

  return {
    isId: (/** @type {string} */ id) => CONVERSATION_ID.test(id),
    get,
    /** Conversations, the most recently used first. */
    list() {
      /** @type {Conversation[]} */
      const out = [];
      for (const { id } of namespace.list()) {
        const c = CONVERSATION_ID.test(id) ? get(id) : null;
        if (c) out.push(c);
      }
      return out.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.id < b.id ? -1 : 1));
    },
    /**
     * A new conversation titled after its first question.
     * @param {string} question
     * @param {import('../contracts/data-classes.js').DataClass} dataClass
     * @returns {Conversation}
     */
    create(question, dataClass) {
      const at = isoAt(clock.now());
      const c = { id: newId('conv'), title: clip(question.trim().replace(/\s+/g, ' '), 80), created: at, updated: at, dataClass, turns: 0 };
      namespace.putJson(c.id, c);
      return c;
    },
    /**
     * The last turns of a conversation, oldest first.
     * @param {Conversation} c
     * @param {number} [limit]
     * @returns {Turn[]}
     */
    turns(c, limit = MAX_TURNS) {
      /** @type {Turn[]} */
      const out = [];
      for (let n = Math.max(1, c.turns - limit + 1); n <= c.turns; n += 1) {
        const value = namespace.getJson(turnId(c.id, n));
        if (isRecord(value)) out.push(/** @type {Turn} */ (/** @type {unknown} */ (value)));
      }
      return out;
    },
    /**
     * Stores a turn and raises the conversation's class to the turn's.
     * @param {Conversation} c
     * @param {string} question
     * @param {import('./engine.js').Answer} answer
     */
    addTurn(c, question, answer) {
      if (c.turns >= MAX_TURNS) throw fail('conversation_full', `a conversation holds at most ${MAX_TURNS} turns`, { status: 409 });
      const at = isoAt(clock.now());
      const n = c.turns + 1;
      namespace.putJson(turnId(c.id, n), { n, question, answer, at });
      const next = { ...c, turns: n, updated: at, dataClass: strictest(c.dataClass, answer.dataClass) };
      namespace.putJson(c.id, next);
      return next;
    },
    /**
     * Renames a conversation.
     * @param {Conversation} c
     * @param {string} title
     */
    rename(c, title) {
      const next = { ...c, title: clip(title.trim().replace(/\s+/g, ' '), 80) };
      namespace.putJson(c.id, next);
      return next;
    },
    /**
     * Deletes a conversation with every turn.
     * @param {Conversation} c
     */
    remove(c) {
      for (const { id } of namespace.list()) if (id.startsWith(`${c.id}.t`)) namespace.delete(id);
      namespace.delete(c.id);
    },
  };
}

/** @typedef {ReturnType<typeof createChatStore>} ChatStore */
