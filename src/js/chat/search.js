// @ts-check
// Search over the conversation list: an in-memory BM25 index (rag/bm25.js) over each conversation's
// title and first question. It is built from the store when the search is first used and follows
// the store's change events from then on, so it never holds more than titles and first questions,
// and nothing of it is written anywhere. The word being typed also matches as a prefix ("tid" finds
// "tides").
import { BM25Index, tokenize } from '../rag/bm25.js';

/** @typedef {import('./store.js').ChatStore} ChatStore */
/** @typedef {{ id: string, score: number }} ConversationHit */

/** At most this many indexed words stand in for the word being typed. */
const MAX_PREFIX_TERMS = 24;

export class ConversationSearch {
  constructor() {
    this.index = new BM25Index();
    /** @type {Map<string, { title: string, firstTurn: string }>} */
    this.docs = new Map();
  }

  get size() {
    return this.docs.size;
  }

  /**
   * Adds or replaces a conversation. The title counts twice, so a title match ranks first.
   * @param {string} id
   * @param {string} title
   * @param {string} firstTurn
   */
  set(id, title, firstTurn) {
    const known = this.docs.get(id);
    if (known && known.title === title && known.firstTurn === firstTurn) return;
    if (known) this.index.remove(id);
    this.docs.set(id, { title, firstTurn });
    this.index.add([{ docId: id, docName: title, chunkIndex: 0, start: 0, end: 0, text: `${title}\n${title}\n${firstTurn}` }]);
  }

  /** @param {string} id */
  remove(id) {
    if (!this.docs.delete(id)) return;
    this.index.remove(id);
  }

  clear() {
    this.docs.clear();
    this.index.clear();
  }

  /**
   * @param {string} id
   * @returns {string} the indexed first question ('' when unknown)
   */
  firstTurn(id) {
    return this.docs.get(id)?.firstTurn ?? '';
  }

  /**
   * Conversations matching the query, best first.
   * @param {string} query
   * @param {number} [limit]
   * @returns {ConversationHit[]}
   */
  search(query, limit = 50) {
    const terms = tokenize(query);
    // Unless the query ends with a space, its last word may still be typed.
    const lastWord = /\s$/.test(query) ? '' : (query.trim().split(/\s+/).at(-1) ?? '');
    const typing = tokenize(lastWord).at(-1);
    /** @type {string[]} */
    const expansions = [];
    if (typing) {
      for (const term of this.index.df.keys()) {
        if (term !== typing && term.startsWith(typing)) expansions.push(term);
        if (expansions.length >= MAX_PREFIX_TERMS) break;
      }
    }
    if (terms.length === 0 && expansions.length === 0) return [];
    return this.index.search([...terms, ...expansions].join(' '), limit).map((hit) => ({ id: hit.chunk.docId, score: hit.score }));
  }
}

/**
 * A search over the store's conversations that keeps itself up to date.
 * @param {Pick<ChatStore, 'listConversations' | 'firstUserTurns' | 'firstUserTurn' | 'getConversation' | 'onChange'>} store
 * @returns {Promise<{ search: (query: string, limit?: number) => ConversationHit[], index: ConversationSearch, ready: () => Promise<void>, close: () => void }>}
 */
export async function openConversationSearch(store) {
  const index = new ConversationSearch();
  let generation = 0;
  /** @type {Promise<void>} */
  let pending = Promise.resolve();
  /** @param {() => Promise<void>} job */
  const track = (job) => {
    const run = job().catch((err) => console.warn('[starpi] the chat search could not be updated', err));
    pending = pending.then(() => run);
    return run;
  };

  const rebuild = () =>
    track(async () => {
      const gen = ++generation;
      const [conversations, turns] = await Promise.all([store.listConversations({ includeArchived: true }), store.firstUserTurns()]);
      if (gen !== generation) return;
      index.clear();
      for (const c of conversations) index.set(c.id, c.title, turns.get(c.id) ?? '');
    });

  /** @param {string} id */
  const refresh = (id) =>
    track(async () => {
      const conversation = await store.getConversation(id);
      if (!conversation) {
        index.remove(id);
        return;
      }
      const firstTurn = index.firstTurn(id) || (await store.firstUserTurn(id));
      index.set(id, conversation.title, firstTurn);
    });

  const off = store.onChange((change) => {
    if (change.kind === 'all') void rebuild();
    else if (change.kind === 'conversation' && change.op === 'delete') index.remove(change.id);
    else if (change.kind === 'conversation') void refresh(change.id);
  });
  await rebuild();
  return {
    search: (query, limit) => index.search(query, limit),
    index,
    ready: () => pending,
    close: off,
  };
}
