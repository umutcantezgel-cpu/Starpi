// Search over the conversation list: BM25 over titles and first questions, title matches first,
// prefix matches for the word being typed, both languages' stop words ignored, and an index that
// follows the store (new, renamed, deleted and cleared conversations) without a rebuild.
import './setup.mjs';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { ConversationSearch, openConversationSearch } from '../../src/js/chat/search.js';
import { createChatStore } from '../../src/js/chat/store.js';
import { openAppDb } from '../../src/js/store/schema.js';

let seq = 0;

describe('ConversationSearch', () => {
  const index = new ConversationSearch();
  index.set('tides', 'Tides and the moon', 'How do tides work?');
  index.set('bread', 'Sourdough starter', 'My bread does not rise. What is wrong with the moon-shaped loaf?');
  index.set('trip', 'Reise nach Lissabon', 'Welche Viertel sollte ich in Lissabon besuchen?');

  it('ranks a title match above a match in the first question', () => {
    assert.deepEqual(index.search('moon').map((h) => h.id), ['tides', 'bread']);
    assert.deepEqual(index.search('bread').map((h) => h.id), ['bread']);
  });

  it('matches the word being typed as a prefix, and only that word', () => {
    assert.deepEqual(index.search('tid').map((h) => h.id), ['tides']);
    assert.deepEqual(index.search('sourd').map((h) => h.id), ['bread']);
    assert.deepEqual(index.search('tid ').map((h) => h.id), [], 'a finished word must match whole');
    assert.deepEqual(index.search('Lissab').map((h) => h.id), ['trip']);
  });

  it('ignores stop words of both languages and empty queries', () => {
    assert.deepEqual(index.search('the and'), []);
    assert.deepEqual(index.search('sollte ich'), []);
    assert.deepEqual(index.search('   '), []);
    assert.deepEqual(index.search('x'), []);
  });

  it('replaces and removes entries', () => {
    const s = new ConversationSearch();
    s.set('a', 'Garden plans', 'Which tomatoes grow well?');
    s.set('a', 'Balcony plans', 'Which tomatoes grow well?');
    assert.equal(s.size, 1);
    assert.deepEqual(s.search('garden'), []);
    assert.deepEqual(s.search('balcony').map((h) => h.id), ['a']);
    assert.equal(s.firstTurn('a'), 'Which tomatoes grow well?');
    s.remove('a');
    s.remove('a');
    assert.equal(s.size, 0);
    assert.deepEqual(s.search('tomatoes'), []);
  });
});

describe('openConversationSearch', () => {
  it('builds from the store and follows its changes', async () => {
    const name = `chat-search-test-${(seq += 1)}`;
    /** @type {Promise<import('../../src/js/store/idb.js').StoreDb> | null} */
    let db = null;
    const store = createChatStore({ open: () => (db ??= openAppDb({ name, factory: new IDBFactory() })) });
    const old = await store.createConversation({ title: 'Volcano facts' });
    await store.appendNode(old.id, { parentId: null, role: 'user', parts: [{ type: 'text', text: 'Why do volcanoes erupt?' }] });

    const search = await openConversationSearch(store);
    assert.deepEqual(search.search('erupt').map((h) => h.id), [old.id]);

    // A new conversation is found by its first question once it has one.
    const fresh = await store.appendToActive('starpi_fresh-chat', { role: 'user', parts: [{ type: 'text', text: 'Recipe for lentil soup' }] }, { create: {} });
    await search.ready();
    assert.deepEqual(search.search('lentil').map((h) => h.id), [fresh.conversationId]);

    await store.updateConversation(old.id, { title: 'Geology notes' });
    await search.ready();
    assert.deepEqual(search.search('geology').map((h) => h.id), [old.id]);
    assert.deepEqual(search.search('volcano '), [], 'the old title is gone (the question says "volcanoes")');
    assert.deepEqual(search.search('volcano').map((h) => h.id), [old.id], 'a prefix of a word in the question');

    await store.deleteConversation(old.id);
    await search.ready();
    assert.deepEqual(search.search('geology'), []);

    await store.clearConversations();
    await search.ready();
    assert.equal(search.index.size, 0);
    search.close();
  });
});
