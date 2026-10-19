// The inbox: numbers only ever rise, so an app that catches up with ?after= after a gap never
// misses a notification, also when the newest one was removed or pruned in between.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDir } from './helpers.mjs';
import { client, startModules } from './module-helpers.mjs';
import { manualClock } from '../src/lib/clock.js';
import { createInbox } from '../src/notify/inbox.js';

/** A namespace of the vault's shape that keeps its items in memory. */
function memoryNamespace() {
  /** @type {Map<string, string>} */
  const items = new Map();
  return {
    list: () => [...items.keys()].sort().map((id) => ({ id })),
    /** @param {string} id */
    getJson: (id) => (items.has(id) ? JSON.parse(/** @type {string} */ (items.get(id))) : null),
    /** @param {string} id @param {unknown} value */
    putJson: (id, value) => void items.set(id, JSON.stringify(value)),
    /** @param {string} id */
    delete: (id) => items.delete(id),
  };
}

test('inbox numbers are never reused: not after removing the newest, not after pruning', () => {
  const clock = manualClock(Date.UTC(2026, 9, 18, 8, 0));
  const inbox = createInbox({ namespace: memoryNamespace(), clock, keepDays: 30 });
  assert.deepEqual(['reminder', 'reminder', 'doc_ready'].map((kind) => inbox.post({ kind }).seq), [1, 2, 3]);
  // An app has seen everything up to 3; then the newest one is removed.
  assert.equal(inbox.remove('n-000000000003'), true);
  assert.equal(inbox.list().latest, 3, 'latest is the highest number handed out, not the newest kept');
  const next = inbox.post({ kind: 'reminder', title: 'Water the herbs' });
  assert.equal(next.seq, 4);
  assert.deepEqual(inbox.list({ after: 3 }).notifications.map((n) => n.title), ['Water the herbs'], 'the app catching up sees it');

  // Everything ages out; the numbers go on.
  clock.advance(31 * 86_400_000);
  assert.equal(inbox.prune(), 3);
  assert.deepEqual(inbox.list(), { notifications: [], latest: 4, unread: 0 });
  assert.equal(inbox.post({ kind: 'reminder' }).seq, 5);
});

test('/v1/notify: removing the newest notification neither resets an app nor hides the next one', async (t) => {
  const { dir, cleanup } = tempDir();
  const { companion, hub } = await startModules(dir, { only: ['notify'] });
  t.after(async () => {
    await companion.stop();
    cleanup();
  });
  const c = await client(companion, { role: 'member' });
  const inbox = /** @type {import('../src/notify/inbox.js').Inbox} */ (hub.get('notify'));
  inbox.post({ kind: 'reminder', title: 'First' });
  const second = inbox.post({ kind: 'reminder', title: 'Second' });
  assert.equal((await c.get('/v1/notify?after=0')).json().latest, 2);
  assert.equal((await c.del(`/v1/notify/${second.id}`)).status, 200);
  const caughtUp = (await c.get('/v1/notify?after=2')).json();
  assert.equal(caughtUp.reset, false, 'the app is not sent back to the start');
  assert.equal(caughtUp.latest, 2);
  assert.deepEqual(caughtUp.notifications, []);
  inbox.post({ kind: 'reminder', title: 'Third' });
  const later = (await c.get('/v1/notify?after=2')).json();
  assert.deepEqual(later.notifications.map((/** @type {any} */ n) => [n.seq, n.title]), [[3, 'Third']]);
  assert.equal((await c.get('/v1/notify?after=9')).json().reset, true, 'a number beyond every one handed out still starts over');
});
