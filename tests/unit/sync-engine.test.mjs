// The chat sync engine (sync/sync.js, sync/payload.js) between browsers of one account, against an
// in-memory server with the semantics of the chat_sync tables:
// - turning sync on in one browser and restoring in a second one with the passphrase;
// - a wrong passphrase, an account switch, sync turned off (and set up again) in another browser;
// - conflict resolution: concurrent messages merge, conversation fields go to the later writer, a
//   stale browser adopts the newer revision, deletions travel, lose against new messages and win
//   over changed fields (in both orders), metadata attached differently on both sides settles;
// - local-only turns (also questions answered on the device, and titles made from them), keys and
//   signing keys never leave the browser; nothing but ciphertext, opaque ids and revision numbers
//   reaches the server;
// - failures: offline, rows that do not open, conversations above the size limit, a turn-off whose
//   row deletion failed after the key was deleted.
import './setup.mjs';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nodeText } from '../../src/js/chat/tree.js';
import { createSyncKey, openRecord, rowIdFor, sealRecord } from '../../src/js/sync/crypto.js';
import { createBrowser, createFakeServer, text } from './sync-fakes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PASSPHRASE = 'tide tables and moon phases';
const USER = '11111111-1111-4111-8111-111111111111';

/**
 * Adds a question and its answer at the end of a conversation's active thread.
 * @param {ReturnType<typeof createBrowser>} b
 * @param {string} convId
 * @param {string} question
 * @param {string} answer
 * @param {{ localOnly?: boolean, mode?: 'free' | 'grounded' }} [opts]
 */
async function turn(b, convId, question, answer, opts = {}) {
  const localOnly = opts.localOnly === true;
  await b.store.appendToActive(convId, { role: 'user', parts: text(question), localOnly }, { create: { mode: opts.mode ?? 'free' } });
  return b.store.appendToActive(convId, { role: 'assistant', parts: text(answer), localOnly, model: 'model-a', provider: 'openai' });
}

/**
 * The texts of a conversation's messages, sorted.
 * @param {ReturnType<typeof createBrowser>} b
 * @param {string} convId
 */
async function texts(b, convId) {
  return (await b.store.getNodes(convId)).map((n) => nodeText(n)).sort();
}

/**
 * Every record on the server for one account, decrypted with a browser's keys.
 * @param {ReturnType<typeof createFakeServer>} server
 * @param {ReturnType<typeof createBrowser>} b
 */
async function decryptedRows(server, b) {
  const st = await b.sync.status();
  assert.equal(st.phase, 'on');
  const { settingsStateStore } = await import('../../src/js/sync/sync.js');
  const state = await settingsStateStore(b.open).load();
  assert.ok(state);
  const keys = { keyId: state.keyId, enc: state.enc, ids: state.ids };
  const out = [];
  for (const [rowId, row] of server.account(USER).rows) out.push(await openRecord(keys, { rowId, ...row }));
  return out;
}

describe('turning sync on and restoring in a second browser', () => {
  it('encrypts the conversations, and the passphrase restores them in another browser', async () => {
    const server = createFakeServer();
    const a = createBrowser(server, { userId: USER });
    await turn(a, 'starpi_trip', 'Plan a weekend in the mountains', 'Start with a short hike on Saturday.');
    await a.store.updateConversation('starpi_trip', { title: 'Mountain weekend', pinned: true });
    await turn(a, 'starpi_bread', 'How long does dough rise?', 'About two hours at room temperature.');

    const on = await a.sync.enable(PASSPHRASE);
    assert.equal(on.ok, true);
    assert.equal(on.ok && on.joined, false);
    assert.deepEqual(on.ok && on.report, { applied: 0, written: 2, skipped: 0 });
    assert.equal(a.sync.status().phase, 'on');
    assert.equal(a.sync.status().conversations, 2);
    const account = server.account(USER);
    assert.ok(account.envelope);
    assert.equal(account.rows.size, 2);
    for (const [rowId, row] of account.rows) {
      assert.match(rowId, /^[A-Za-z0-9_-]{32}$/);
      assert.equal(row.rev, 1);
    }

    // The second browser signs in to the same account and knows only the passphrase.
    const b = createBrowser(server, { userId: USER });
    const joined = await b.sync.enable(PASSPHRASE);
    assert.equal(joined.ok && joined.joined, true);
    assert.deepEqual(joined.ok && joined.report, { applied: 2, written: 0, skipped: 0 });
    const restored = await b.store.loadThread('starpi_trip');
    assert.ok(restored);
    assert.equal(restored.conversation.title, 'Mountain weekend');
    assert.equal(restored.conversation.pinned, 1);
    assert.equal(restored.conversation.mode, 'free');
    assert.deepEqual(
      restored.path.map((n) => [n.role, nodeText(n), n.model]),
      [
        ['user', 'Plan a weekend in the mountains', null],
        ['assistant', 'Start with a short hike on Saturday.', 'model-a'],
      ],
    );
    assert.deepEqual(await texts(b, 'starpi_bread'), ['About two hours at room temperature.', 'How long does dough rise?']);

    // Restored copies equal the originals: neither browser writes anything back.
    assert.deepEqual(await b.sync.syncNow(), { applied: 0, written: 0, skipped: 0 });
    assert.deepEqual(await a.sync.syncNow(), { applied: 0, written: 0, skipped: 0 });
  });

  it('refuses a wrong passphrase and stays off', async () => {
    const server = createFakeServer();
    const a = createBrowser(server, { userId: USER });
    await turn(a, 'starpi_x', 'Question', 'Answer');
    assert.equal((await a.sync.enable(PASSPHRASE)).ok, true);
    const b = createBrowser(server, { userId: USER });
    assert.deepEqual(await b.sync.enable('tide tables and moon phase'), { ok: false, reason: 'wrong_passphrase' });
    assert.deepEqual(await b.sync.enable('short'), { ok: false, reason: 'too_short' });
    assert.equal(b.sync.status().phase, 'off');
    assert.equal(await b.store.getConversation('starpi_x'), undefined);
    assert.equal(await b.sync.syncNow(), null);
  });

  it('follows local changes by itself once started', async () => {
    const server = createFakeServer();
    const a = createBrowser(server, { userId: USER });
    assert.equal((await a.sync.enable(PASSPHRASE)).ok, true);
    await a.sync.start();
    await turn(a, 'starpi_live', 'Is this synced?', 'Yes, a moment later.');
    for (let i = 0; i < 200 && server.account(USER).rows.size === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(server.account(USER).rows.size, 1);
    a.sync.stop();
  });
});

describe('conflict resolution', () => {
  /** Two browsers of one account with one synced conversation. */
  async function pair() {
    const server = createFakeServer();
    const a = createBrowser(server, { userId: USER });
    await turn(a, 'starpi_c', 'First question', 'First answer');
    assert.equal((await a.sync.enable(PASSPHRASE)).ok, true);
    const b = createBrowser(server, { userId: USER });
    assert.equal((await b.sync.enable(PASSPHRASE)).ok, true);
    const row = () => [...server.account(USER).rows.values()][0];
    return { server, a, b, row };
  }

  it('merges messages written in both browsers and gives conversation fields to the later writer', async () => {
    const { a, b, row } = await pair();
    await turn(a, 'starpi_c', 'Question from A', 'Answer for A');
    await a.store.updateConversation('starpi_c', { title: 'Title from A' });
    await turn(b, 'starpi_c', 'Question from B', 'Answer for B');
    await b.store.updateConversation('starpi_c', { title: 'Title from B' });

    assert.deepEqual(await a.sync.syncNow(), { applied: 0, written: 1, skipped: 0 });
    assert.equal(row().rev, 2);
    // B's write builds on revision 1: it merges revision 2 and writes the result as revision 3.
    const report = await b.sync.syncNow();
    assert.deepEqual(report, { applied: 1, written: 1, skipped: 0 });
    assert.equal(row().rev, 3);
    assert.deepEqual(await a.sync.syncNow(), { applied: 1, written: 0, skipped: 0 });

    const all = ['Answer for A', 'Answer for B', 'First answer', 'First question', 'Question from A', 'Question from B'];
    assert.deepEqual(await texts(a, 'starpi_c'), all);
    assert.deepEqual(await texts(b, 'starpi_c'), all);
    const [ta, tb] = [await a.store.loadThread('starpi_c'), await b.store.loadThread('starpi_c')];
    assert.equal(ta?.conversation.title, 'Title from B');
    assert.equal(tb?.conversation.title, 'Title from B');
    // Both browsers show B's branch (the later writer's active leaf); A's turn is the sibling.
    assert.deepEqual(ta?.path.map((n) => nodeText(n)), ['First question', 'First answer', 'Question from B', 'Answer for B']);
    assert.deepEqual(tb?.path.map((n) => nodeText(n)), ta?.path.map((n) => nodeText(n)));
  });

  it('keeps a field changed here and takes the others from the newer revision', async () => {
    const { a, b } = await pair();
    await a.store.updateConversation('starpi_c', { pinned: true });
    await a.sync.syncNow();
    await b.store.updateConversation('starpi_c', { title: 'Renamed in B' });
    await b.sync.syncNow();
    await a.sync.syncNow();
    for (const x of [a, b]) {
      const c = await x.store.getConversation('starpi_c');
      assert.deepEqual([c?.title, c?.pinned], ['Renamed in B', 1]);
    }
  });

  it('a browser without changes adopts the newer revision', async () => {
    const { a, b, row } = await pair();
    await a.store.updateConversation('starpi_c', { archived: true, title: 'Done' });
    await a.sync.syncNow();
    assert.deepEqual(await b.sync.syncNow(), { applied: 1, written: 0, skipped: 0 });
    const c = await b.store.getConversation('starpi_c');
    assert.deepEqual([c?.title, c?.archived], ['Done', 1]);
    assert.equal(row().rev, 2);
  });

  it('copies that differ only in their creation time settle without writing each other back', async () => {
    const server = createFakeServer();
    const a = createBrowser(server, { userId: USER });
    const b = createBrowser(server, { userId: USER });
    await a.store.createConversation({ id: 'starpi_same', createdAt: 1_000, mode: 'free' });
    await b.store.createConversation({ id: 'starpi_same', createdAt: 9_000, mode: 'free' });
    await turn(a, 'starpi_same', 'From A', 'A');
    await turn(b, 'starpi_same', 'From B', 'B');
    await a.sync.enable(PASSPHRASE);
    await b.sync.enable(PASSPHRASE);
    await a.sync.syncNow();
    assert.deepEqual(await b.sync.syncNow(), { applied: 0, written: 0, skipped: 0 });
    assert.deepEqual(await a.sync.syncNow(), { applied: 0, written: 0, skipped: 0 });
    assert.deepEqual(await texts(a, 'starpi_same'), await texts(b, 'starpi_same'));
  });

  it('a deletion travels to the other browser', async () => {
    const { a, b, server } = await pair();
    assert.equal(await (await a.store).deleteConversation('starpi_c'), true);
    assert.deepEqual(await a.sync.syncNow(), { applied: 0, written: 1, skipped: 0 });
    const records = await decryptedRows(server, a);
    assert.deepEqual(
      records.map((r) => /** @type {any} */ (r).kind),
      ['deleted'],
    );
    assert.deepEqual(await b.sync.syncNow(), { applied: 1, written: 0, skipped: 0 });
    assert.equal(await b.store.getConversation('starpi_c'), undefined);
    assert.equal(b.sync.status().conversations, 0);
    assert.deepEqual(await b.sync.syncNow(), { applied: 0, written: 0, skipped: 0 });
  });

  it('new messages win over a deletion made elsewhere', async () => {
    const { a, b, row } = await pair();
    await a.store.deleteConversation('starpi_c');
    await a.sync.syncNow();
    await turn(b, 'starpi_c', 'Still needed', 'Kept');
    assert.deepEqual(await b.sync.syncNow(), { applied: 0, written: 1, skipped: 0 });
    assert.equal(row().rev, 3);
    assert.deepEqual(await a.sync.syncNow(), { applied: 1, written: 0, skipped: 0 });
    assert.deepEqual(await texts(a, 'starpi_c'), ['First answer', 'First question', 'Kept', 'Still needed']);
  });

  it('a deletion loses against messages another browser synced first, and the delete says so', async () => {
    const { a, b } = await pair();
    await turn(b, 'starpi_c', 'Added in B', 'While A deleted');
    await b.sync.syncNow();
    await a.store.deleteConversation('starpi_c');
    // What the chat view's delete waits for: false, as the chat is back.
    assert.equal(await a.sync.flushDeleted(['starpi_c']), false);
    assert.deepEqual(await texts(a, 'starpi_c'), ['Added in B', 'First answer', 'First question', 'While A deleted']);
    assert.deepEqual(await a.sync.syncNow(), { applied: 0, written: 0, skipped: 0 });
  });

  it('a deletion made here wins over fields another browser changed first (branch, pin, title, model, mode)', async () => {
    const { server, a, b, row } = await pair();
    const nodes = await b.store.getNodes('starpi_c');
    const answer = /** @type {import('../../src/js/store/schema.js').NodeRecord} */ (nodes.find((n) => n.role === 'assistant'));
    // A second answer in A first, so B has a branch to switch back to.
    await a.store.addSibling(answer.id, { role: 'assistant', parts: text('Second answer'), model: 'model-b', provider: 'openai' });
    await a.sync.syncNow();
    await b.sync.syncNow();
    await b.store.setActiveLeaf('starpi_c', answer.id);
    await b.store.updateConversation('starpi_c', { pinned: true, title: 'Renamed in B', model: 'model-z', mode: 'grounded' });
    assert.equal((await b.sync.syncNow())?.written, 1);
    const before = row().rev;

    await a.store.deleteConversation('starpi_c');
    assert.equal(await a.sync.flushDeleted(['starpi_c']), true, 'the delete is complete');
    assert.equal(await a.store.getConversation('starpi_c'), undefined);
    assert.equal(row().rev, before + 1);
    assert.deepEqual(
      (await decryptedRows(server, a)).map((r) => /** @type {any} */ (r).kind),
      ['deleted'],
    );
    assert.deepEqual(await b.sync.syncNow(), { applied: 1, written: 0, skipped: 0 });
    assert.equal(await b.store.getConversation('starpi_c'), undefined);
    for (const x of [a, b]) assert.deepEqual(await x.sync.syncNow({ full: true }), { applied: 0, written: 0, skipped: 0 });
  });

  it('a deletion made elsewhere wins over fields changed here before it arrived', async () => {
    const { server, a, b } = await pair();
    await a.store.deleteConversation('starpi_c');
    await a.sync.syncNow();
    await b.store.updateConversation('starpi_c', { pinned: true, title: 'Pinned in B' });
    assert.deepEqual(await b.sync.syncNow(), { applied: 1, written: 0, skipped: 0 });
    assert.equal(await b.store.getConversation('starpi_c'), undefined);
    assert.deepEqual(
      (await decryptedRows(server, b)).map((r) => /** @type {any} */ (r).kind),
      ['deleted'],
    );
    assert.deepEqual(await a.sync.syncNow(), { applied: 0, written: 0, skipped: 0 });
  });

  it('metadata both browsers attached with different values settles on one value', async () => {
    const { a, b } = await pair();
    const answer = /** @type {import('../../src/js/store/schema.js').NodeRecord} */ ((await a.store.getNodes('starpi_c')).find((n) => n.role === 'assistant'));
    await a.store.annotateNode(answer.id, { label: 'from-a', meta: { checkedBy: 'a', shared: 1 } });
    await b.store.annotateNode(answer.id, { label: 'from-b', meta: { checkedBy: 'b', other: true } });
    await a.sync.syncNow();
    await b.sync.syncNow();
    await a.sync.syncNow();
    for (let round = 0; round < 2; round += 1) {
      for (const x of [a, b]) assert.deepEqual(await x.sync.syncNow({ full: true }), { applied: 0, written: 0, skipped: 0 });
    }
    const [na, nb] = [await a.store.getNodes('starpi_c'), await b.store.getNodes('starpi_c')].map((all) => all.find((n) => n.id === answer.id));
    assert.equal(na?.label, 'from-a');
    assert.equal(nb?.label, 'from-a');
    assert.deepEqual(na?.meta, { checkedBy: 'a', shared: 1, other: true });
    assert.deepEqual(nb?.meta, na?.meta);
  });
});

describe('what never leaves the browser', () => {
  it('local-only turns stay on the device, also in titles; a conversation of only local-only turns is not synced', async () => {
    const server = createFakeServer();
    const a = createBrowser(server, { userId: USER });
    await turn(a, 'starpi_mixed', 'Summarise my private notes', 'Your notes say: dentist on Monday.', { localOnly: true, mode: 'grounded' });
    await turn(a, 'starpi_mixed', 'What is a good stretch for the back?', 'Try a cat-cow stretch.');
    await turn(a, 'starpi_device', 'Read my diary file', 'The diary mentions a trip.', { localOnly: true });
    assert.equal((await a.store.getConversation('starpi_mixed'))?.title, 'Summarise my private notes');

    assert.equal((await a.sync.enable(PASSPHRASE)).ok, true);
    const records = /** @type {any[]} */ (await decryptedRows(server, a));
    assert.equal(records.length, 1, 'the conversation of only local-only turns has no row');
    const [mixed] = records;
    assert.equal(mixed.id, 'starpi_mixed');
    assert.equal(mixed.conversation.title, 'What is a good stretch for the back?');
    assert.deepEqual(
      mixed.nodes.map((/** @type {any} */ n) => [n.role, n.parts[0].text, n.parentId === null]).sort(),
      [
        ['assistant', 'Try a cat-cow stretch.', false],
        ['user', 'What is a good stretch for the back?', true],
      ],
    );
    const json = JSON.stringify(records);
    for (const secret of ['private notes', 'dentist', 'diary']) assert.equal(json.includes(secret), false, secret);

    // The other browser gets the synced turns; the first one keeps everything and writes nothing more.
    const b = createBrowser(server, { userId: USER });
    assert.equal((await b.sync.enable(PASSPHRASE)).ok, true);
    assert.deepEqual(await texts(b, 'starpi_mixed'), ['Try a cat-cow stretch.', 'What is a good stretch for the back?']);
    assert.equal(await b.store.getConversation('starpi_device'), undefined);
    assert.equal((await a.store.getNodes('starpi_mixed')).length, 4);
    assert.deepEqual(await a.sync.syncNow(), { applied: 0, written: 0, skipped: 0 });

    // A reply in the other browser comes back without disturbing the local-only turns.
    await turn(b, 'starpi_mixed', 'And for the neck?', 'Slow neck rolls.');
    await b.sync.syncNow();
    await a.sync.syncNow();
    const thread = await a.store.loadThread('starpi_mixed');
    assert.equal(thread?.nodes.length, 6);
    assert.equal(thread?.nodes.filter((n) => n.localOnly).length, 2);
    assert.equal(thread?.conversation.title, 'Summarise my private notes', 'the local title stays on this device');
  });

  it('a question answered on this device stays here, also while any answer is still to come', async () => {
    const server = createFakeServer();
    const a = createBrowser(server, { userId: USER });
    await turn(a, 'starpi_q', 'Cloud question', 'Cloud answer');
    // Asked for any model, answered by the one on this device: the answer is local-only, the
    // question is not marked, and stays here all the same.
    await a.store.appendToActive('starpi_q', { role: 'user', parts: text('Is this mole worrying?'), localOnly: false });
    const device = await a.store.appendToActive('starpi_q', { role: 'assistant', parts: text('Device answer'), localOnly: true });
    // A question still waiting for its answer is not synced yet.
    await a.store.appendToActive('starpi_w', { role: 'user', parts: text('Waiting for an answer') }, { create: { mode: 'free' } });
    assert.equal((await a.sync.enable(PASSPHRASE)).ok, true);
    let records = /** @type {any[]} */ (await decryptedRows(server, a));
    assert.deepEqual(records.map((r) => r.id), ['starpi_q']);
    assert.deepEqual(records[0].nodes.map((/** @type {any} */ n) => n.parts[0].text).sort(), ['Cloud answer', 'Cloud question']);
    assert.equal(JSON.stringify(records).includes('mole'), false);
    // The active leaf (the device answer) moves up to the last synced message.
    assert.equal(nodeText(/** @type {any} */ (records[0].nodes.find((/** @type {any} */ n) => n.id === records[0].conversation.activeLeafId))), 'Cloud answer');

    // Once the waiting question gets an answer from the cloud, both sync.
    await a.store.appendToActive('starpi_w', { role: 'assistant', parts: text('Here it is'), provider: 'openai' });
    // The device-answered question asked again of a cloud model (regenerate): now it syncs.
    await a.store.addSibling(device.id, { role: 'assistant', parts: text('Cloud second opinion'), provider: 'openai' });
    await a.sync.syncNow();
    records = /** @type {any[]} */ (await decryptedRows(server, a));
    const byId = new Map(records.map((r) => [r.id, r.nodes.map((/** @type {any} */ n) => n.parts[0].text).sort()]));
    assert.deepEqual(byId.get('starpi_w'), ['Here it is', 'Waiting for an answer']);
    assert.deepEqual(byId.get('starpi_q'), ['Cloud answer', 'Cloud question', 'Cloud second opinion', 'Is this mole worrying?']);
    assert.equal(JSON.stringify(records).includes('Device answer'), false);
    assert.deepEqual(await a.sync.syncNow({ full: true }), { applied: 0, written: 0, skipped: 0 });
  });

  it('a title a model wrote from a device-only exchange stays here; renames from elsewhere still arrive', async () => {
    const server = createFakeServer();
    const a = createBrowser(server, { userId: USER });
    await turn(a, 'starpi_t', 'My lab results show XYZ, what now?', 'Device answer', { localOnly: true });
    // The model on this device names the conversation after its first answer.
    await a.store.updateConversation('starpi_t', { title: 'Lab result XYZ follow-up' });
    await turn(a, 'starpi_t', 'General question', 'General answer');
    assert.equal((await a.sync.enable(PASSPHRASE)).ok, true);
    let [record] = /** @type {any[]} */ (await decryptedRows(server, a));
    assert.equal(record.conversation.title, 'General question');
    assert.equal(JSON.stringify(record).includes('XYZ'), false);

    // A rename in another browser arrives here and is not written back.
    const b = createBrowser(server, { userId: USER });
    assert.equal((await b.sync.enable(PASSPHRASE)).ok, true);
    assert.equal((await b.store.getConversation('starpi_t'))?.title, 'General question');
    await b.store.updateConversation('starpi_t', { title: 'Renamed in B' });
    await b.sync.syncNow();
    assert.deepEqual(await a.sync.syncNow(), { applied: 1, written: 0, skipped: 0 });
    assert.equal((await a.store.getConversation('starpi_t'))?.title, 'Renamed in B');
    assert.deepEqual(await a.sync.syncNow({ full: true }), { applied: 0, written: 0, skipped: 0 });

    // A first exchange that synced keeps the title a model wrote for it.
    await turn(a, 'starpi_cloud', 'Cloud first', 'Cloud reply');
    await a.store.updateConversation('starpi_cloud', { title: 'Named by the provider' });
    await a.sync.syncNow();
    record = (/** @type {any[]} */ (await decryptedRows(server, a))).find((r) => r.id === 'starpi_cloud');
    assert.equal(record.conversation.title, 'Named by the provider');
  });

  it('sends only ciphertext, opaque row ids and revisions; provider keys and signing keys are never read or sent', async () => {
    const server = createFakeServer();
    const a = createBrowser(server, { userId: USER });
    const db = await a.open();
    await db.put('keyvault', { id: 'vault', v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000 }, salt: new Uint8Array(16), iv: new Uint8Array(12), ct: new TextEncoder().encode('provider-key-sk-live-123'), updatedAt: 1 });
    await db.put('signingKeys', { id: 'signing-key-1', alg: 'ES256', publicJwk: { kty: 'EC', d: 'private-scalar-xyz', x: 'pub' }, createdAt: 1, retiredAt: null });
    await turn(a, 'starpi_secret', 'My bank PIN hint is the cat name', 'Noted.');
    assert.equal((await a.sync.enable(PASSPHRASE)).ok, true);

    const sent = JSON.stringify(server.sent);
    for (const plain of ['bank PIN', 'cat name', 'Noted', 'starpi_secret', PASSPHRASE, 'provider-key', 'private-scalar', 'signing-key-1']) {
      assert.equal(sent.includes(plain), false, `${plain} was sent`);
    }
    const writes = server.sent.filter((s) => s.call === 'writeRow');
    assert.equal(writes.length, 1);
    const [row, baseRev] = /** @type {[Record<string, unknown>, number]} */ (writes[0].args);
    assert.deepEqual(Object.keys(row).sort(), ['ciphertext', 'iv', 'rev', 'rowId']);
    assert.equal(baseRev, 0);
    const records = JSON.stringify(await decryptedRows(server, a));
    for (const plain of ['provider-key', 'private-scalar', 'signing-key-1']) assert.equal(records.includes(plain), false);

    // The sync modules never touch the key stores or the plaintext chat table.
    const dir = path.join(ROOT, 'src/js/sync');
    for (const file of readdirSync(dir)) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      assert.equal(/keyvault|signingKeys|chat_history|ai\/keys\.js|trust\/signing\.js/.test(source), false, file);
    }
  });
});

describe('sync turned off, set up again, other accounts', () => {
  it('turning off with deletion empties the server; the other browser keeps its chats until it is set up again', async () => {
    const server = createFakeServer();
    const a = createBrowser(server, { userId: USER });
    await turn(a, 'starpi_one', 'One', 'Uno');
    assert.equal((await a.sync.enable(PASSPHRASE)).ok, true);
    const b = createBrowser(server, { userId: USER });
    assert.equal((await b.sync.enable(PASSPHRASE)).ok, true);
    await turn(b, 'starpi_two', 'Two', 'Dos');

    assert.equal(await a.sync.disable({ deleteRemote: true }), true);
    assert.equal(a.sync.status().phase, 'off');
    assert.equal(server.account(USER).envelope, null);
    assert.equal(server.account(USER).rows.size, 0);
    assert.ok(await a.store.getConversation('starpi_one'), 'turning off keeps the chats here');

    assert.equal(await b.sync.syncNow(), null);
    assert.equal(b.sync.status().phase, 'remote_off');
    assert.equal(server.account(USER).rows.size, 0, 'nothing is written back');
    assert.ok(await b.store.getConversation('starpi_one'));

    // Set up again in A with a new passphrase: B needs that one.
    assert.equal((await a.sync.enable('a brand new passphrase')).ok, true);
    await b.sync.syncNow();
    assert.equal(b.sync.status().phase, 'rekeyed');
    assert.deepEqual(await b.sync.enable(PASSPHRASE), { ok: false, reason: 'wrong_passphrase' });
    const again = await b.sync.enable('a brand new passphrase');
    assert.equal(again.ok && again.joined, true);
    await a.sync.syncNow();
    assert.deepEqual(await texts(a, 'starpi_two'), ['Dos', 'Two']);
    assert.equal(server.account(USER).rows.size, 2);
  });

  it('turning off in one browser only keeps the server copy', async () => {
    const server = createFakeServer();
    const a = createBrowser(server, { userId: USER });
    await turn(a, 'starpi_one', 'One', 'Uno');
    await a.sync.enable(PASSPHRASE);
    assert.equal(await a.sync.disable({ deleteRemote: false }), true);
    assert.equal(server.account(USER).rows.size, 1);
    assert.ok(server.account(USER).envelope);
    await turn(a, 'starpi_after', 'Not synced', 'Off');
    assert.equal(await a.sync.syncNow(), null);
    assert.equal(server.account(USER).rows.size, 1);
  });

  it('stops when the browser is signed in to another account', async () => {
    const server = createFakeServer();
    const user = { userId: USER };
    const a = createBrowser(server, user);
    await turn(a, 'starpi_one', 'One', 'Uno');
    await a.sync.enable(PASSPHRASE);
    user.userId = '22222222-2222-4222-8222-222222222222';
    await turn(a, 'starpi_two', 'Two', 'Dos');
    assert.equal(await a.sync.syncNow(), null);
    assert.equal(a.sync.status().phase, 'other_account');
    assert.equal(server.account(user.userId).rows.size, 0);
  });
});

describe('failures', () => {
  it('offline: reports the error, keeps the changes and writes them once back online', async () => {
    const server = createFakeServer();
    const a = createBrowser(server, { userId: USER });
    await a.sync.enable(PASSPHRASE);
    server.offline = true;
    await turn(a, 'starpi_later', 'Written offline', 'Synced later');
    assert.equal(await a.sync.syncNow(), null);
    assert.equal(a.sync.status().error, 'network');
    assert.equal(a.sync.status().phase, 'on');
    server.offline = false;
    assert.deepEqual(await a.sync.syncNow(), { applied: 0, written: 1, skipped: 0 });
    assert.equal(a.sync.status().error, null);
  });

  it('a turn-off whose row deletion failed after the key was deleted is retried by later syncs', async () => {
    const server = createFakeServer();
    const a = createBrowser(server, { userId: USER });
    await turn(a, 'starpi_p', 'Question', 'Answer');
    assert.equal((await a.sync.enable(PASSPHRASE)).ok, true);
    server.failRowsDelete = true;
    assert.equal(await a.sync.disable({ deleteRemote: true }), false);
    assert.equal(server.account(USER).envelope, null, 'the key is gone');
    assert.equal(server.account(USER).rows.size, 1, 'the rows are still there');
    assert.deepEqual([a.sync.status().phase, a.sync.status().purging, a.sync.status().error], ['on', true, 'network']);
    // Not "turned off in another browser": the next sync retries the deletion, never writes rows.
    await turn(a, 'starpi_p2', 'Later question', 'Later answer');
    assert.equal(await a.sync.syncNow(), null);
    assert.deepEqual([a.sync.status().phase, a.sync.status().purging], ['on', true]);
    assert.equal(server.account(USER).rows.size, 1);
    // A reload remembers it.
    const { createChatSync, settingsStateStore } = await import('../../src/js/sync/sync.js');
    const reloaded = createChatSync({ remote: server.remoteFor(() => a.user), store: async () => a.store, state: settingsStateStore(a.open) });
    await reloaded.ready();
    assert.deepEqual([reloaded.status().phase, reloaded.status().purging], ['on', true]);

    server.failRowsDelete = false;
    assert.deepEqual(await reloaded.syncNow(), { applied: 0, written: 0, skipped: 0 });
    assert.equal(server.account(USER).rows.size, 0);
    assert.deepEqual([reloaded.status().phase, reloaded.status().purging], ['off', false]);
    assert.equal(await settingsStateStore(a.open).load(), null);
    assert.equal(await a.store.getConversation('starpi_p') !== undefined, true, 'the conversations stay in this browser');
  });

  it('skips rows that do not open and conversations above the size limit', async () => {
    const server = createFakeServer();
    const a = createBrowser(server, { userId: USER });
    await turn(a, 'starpi_ok', 'Small', 'Fine');
    await turn(a, 'starpi_huge', 'Paste', 'x'.repeat(2_100_000));
    const on = await a.sync.enable(PASSPHRASE);
    assert.deepEqual(on.ok && on.report, { applied: 0, written: 1, skipped: 1 });
    assert.equal(a.sync.status().skipped, 1);

    // A row sealed with another key (for example left from an older setup).
    const stranger = await createSyncKey('some other passphrase');
    const rowId = await rowIdFor(stranger.keys, 'starpi_foreign');
    const sealed = await sealRecord(stranger.keys, { rowId, rev: 1 }, { v: 1, kind: 'deleted', id: 'starpi_foreign', deletedAt: 1 });
    server.account(USER).rows.set(rowId, { rev: 1, ...sealed });
    const b = createBrowser(server, { userId: USER });
    const joined = await b.sync.enable(PASSPHRASE);
    assert.deepEqual(joined.ok && joined.report, { applied: 1, written: 0, skipped: 1 });
    assert.equal(b.sync.status().skipped, 1);
    assert.deepEqual(await b.sync.syncNow(), { applied: 0, written: 0, skipped: 0 }, 'an unreadable row is not fetched again');
  });

  it('is unavailable where the browser cannot keep the key', async () => {
    const server = createFakeServer();
    const { createChatSync } = await import('../../src/js/sync/sync.js');
    const sync = createChatSync({
      remote: server.remoteFor(() => ({ userId: USER })),
      store: async () => {
        throw new Error('not used');
      },
      state: { load: async () => null, save: async () => {}, clear: async () => {}, persistent: async () => false },
    });
    await sync.ready();
    assert.equal(sync.status().phase, 'unavailable');
    assert.deepEqual(await sync.enable(PASSPHRASE), { ok: false, reason: 'unavailable' });
  });
});
