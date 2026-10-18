// The chat view's persistence layer with the encrypted sync bound (chat-store.js bindChatSync):
// deleting a chat or the whole history asks the sync to write the deletion at once and reports a
// failure of that as a partial delete; without a bound sync nothing changes; the plaintext table of
// 2.x is never written.
import './setup.mjs';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

// The sync line lives in Settings; there is no page here.
Object.defineProperty(globalThis, 'document', { value: { getElementById: () => null }, configurable: true, writable: true });
after(() => delete (/** @type {any} */ (globalThis)).document);

/** @type {typeof import('../../src/js/chat-store.js')} */
const facade = await import('../../src/js/chat-store.js');
after(async () => (await facade.chatData()).close());

const row = (/** @type {'user' | 'assistant'} */ role, /** @type {string} */ content) => ({ role, content, sources: [], metadata: { chat_mode: 'free' } });

describe('chat-store.js with the encrypted sync', () => {
  it('flushes the sync after deleting a chat and the whole history', async () => {
    let flushes = 0;
    let flushResult = true;
    facade.bindChatSync({ statusLine: () => ({ key: 'sync.line.on', params: { n: '1' } }), flush: async () => ((flushes += 1), flushResult) });
    const sid = facade.currentSessionId();
    await facade.persistMessage(sid, row('user', 'Hello'), { localOnly: false });
    await facade.persistMessage(sid, row('assistant', 'Hi'), { localOnly: false });
    assert.equal((await facade.loadSessionThread(sid))?.nodes.length, 2);

    assert.equal(await facade.deleteSession(sid), true);
    assert.equal(flushes, 1);
    assert.equal(await facade.loadSessionThread(sid), null);

    const next = facade.currentSessionId();
    await facade.persistMessage(next, row('user', 'Again'), { localOnly: false });
    flushResult = false;
    assert.equal(await facade.deleteChatHistory(), false, 'a deletion the sync could not write yet is a partial delete');
    assert.equal(flushes, 2);

    facade.bindChatSync(null);
    await facade.persistMessage(facade.currentSessionId(), row('user', 'No sync'), { localOnly: false });
    assert.equal(await facade.deleteChatHistory(), true);
    assert.equal(flushes, 2);
    assert.equal(facade.CHAT_SYNC_ENABLED, false);
  });
});
