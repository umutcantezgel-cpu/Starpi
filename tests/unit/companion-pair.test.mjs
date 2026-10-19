// Pairing with the companion (src/js/companion/pair.js): the code, the sealed secret, the voice
// link, a restore without any request, unpairing, a session the companion no longer knows, and the
// audit check: the first head is stored, an older current head is a rollback (an older head that
// only arrives late is not), another hash at a known number or a chain that lost the stored record
// is a fork, a wrong signature is invalid, and the user can accept the companion's current state.
import './setup.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CompanionError } from '../../src/js/companion/client.js';
import { compareHeads, createPairing, LINK_MARKER, normalizeCode, openSecret, sealSecret } from '../../src/js/companion/pair.js';
import { fakeCompanion, memoryLinkStore, memoryMarker, settle } from './companion-fakes.mjs';

const TOKEN = 'tok_0123456789abcdefghijklmnopqrstuvwxyzABCDE';

/** A pairing against a fake companion with stores in memory. */
function setup(companion = fakeCompanion()) {
  const store = memoryLinkStore();
  const marker = memoryMarker();
  /** @type {any[]} */
  const voice = [];
  const make = () => createPairing({ store, marker, fetch: companion.fetch, voiceLink: (l) => voice.push(l) });
  return { companion, store, marker, voice, make, pairing: make() };
}

describe('pairing', () => {
  it('pairs with the code, keeps the token sealed and tells the voice input', async () => {
    const { companion, store, marker, voice, pairing } = setup();
    const state = await pairing.pair({ code: 'abcd-efgh', origin: companion.origin });
    assert.equal(state.phase, 'paired');
    assert.equal(state.mode, 'bearer');
    assert.equal(state.role, 'owner');
    assert.equal(companion.calls('POST', '/v1/session/pair')[0].body.code, 'ABCDEFGH');
    const { link } = store.peek();
    assert.ok(!JSON.stringify(link).includes(TOKEN), 'the stored link holds the token only sealed');
    assert.equal(await openSecret(await store.sealKey(), link.secret, link), TOKEN);
    assert.equal(marker.get(), true);
    assert.deepEqual(voice.at(-1), { origin: companion.origin, token: TOKEN });
    // Later calls carry the token.
    companion.handlers.set('GET /v1/status', () => ({ body: { version: '2.1.0' } }));
    await pairing.call('GET', '/v1/status');
    assert.equal(companion.calls('GET', '/v1/status')[0].headers.authorization, `Bearer ${TOKEN}`);
  });

  it('refuses a malformed code without asking, and a key that does not match its id', async () => {
    const { companion, pairing } = setup();
    await assert.rejects(pairing.pair({ code: 'ABC', origin: companion.origin }), (err) => err instanceof CompanionError && err.code === 'code_format');
    assert.equal(companion.requests.length, 0);
    await assert.rejects(pairing.pair({ code: 'ABCDEFGH', origin: 'https://example.org' }), (err) => err instanceof CompanionError && err.code === 'origin_invalid');
    companion.handlers.set('POST /v1/session/pair', () => ({ body: { mode: 'bearer', session: 's', role: 'owner', expiresAt: '2099-01-01T00:00:00Z', publicKey: companion.identity.publicKey, keyId: 'f'.repeat(64), token: TOKEN } }));
    await assert.rejects(pairing.pair({ code: 'ABCDEFGH', origin: companion.origin }), (err) => err instanceof CompanionError && err.code === 'identity_invalid');
    assert.equal(pairing.state().phase, 'unpaired');
  });

  it('passes the companion’s refusal on as its code', async () => {
    const { companion, pairing } = setup();
    await assert.rejects(pairing.pair({ code: 'ZZZZZZZZ', origin: companion.origin }), (err) => err instanceof CompanionError && err.code === 'pairing_failed');
  });

  it('restores a stored link without a request, and reads nothing when no link was stored', async () => {
    const first = setup();
    await first.pairing.pair({ code: 'ABCDEFGH', origin: first.companion.origin });
    const before = first.companion.requests.length;
    const again = first.make();
    const state = await again.restore();
    assert.equal(state.phase, 'paired');
    assert.equal(first.companion.requests.length, before);
    assert.deepEqual(first.voice.at(-1), { origin: first.companion.origin, token: TOKEN });

    const fresh = setup();
    await fresh.pairing.restore();
    assert.equal(fresh.store.calls.load, 0);
    assert.equal(fresh.pairing.state().phase, 'unpaired');
  });

  it('uses the CSRF value in Mode A and gives the voice input a cookie link with it', async () => {
    const companion = fakeCompanion();
    companion.handlers.set('POST /v1/session/pair', () => ({ body: { mode: 'cookie', session: 'sess-a', role: 'member', expiresAt: '2099-01-01T00:00:00Z', publicKey: companion.identity.publicKey, keyId: companion.identity.keyId, csrf: 'csrf_0123456789abcdefghijklmnop' } }));
    companion.handlers.set('GET /v1/docs', () => ({ body: { documents: [] } }));
    const { voice, pairing } = setup(companion);
    await pairing.pair({ code: 'ABCDEFGH', origin: companion.origin });
    assert.equal(pairing.state().mode, 'cookie');
    assert.deepEqual(voice.at(-1), { origin: companion.origin, csrf: 'csrf_0123456789abcdefghijklmnop' });
    await pairing.call('GET', '/v1/docs');
    const [req] = companion.calls('GET', '/v1/docs');
    assert.equal(req.headers['x-companion-csrf'], 'csrf_0123456789abcdefghijklmnop');
    assert.equal(req.headers.authorization, undefined);
  });

  it('unpairs: ends the session there, forgets the link here, keeps the audit head', async () => {
    const { companion, store, marker, voice, pairing } = setup();
    await pairing.pair({ code: 'ABCDEFGH', origin: companion.origin });
    await settle();
    await pairing.unpair();
    assert.equal(companion.calls('POST', '/v1/session/logout').length, 1);
    assert.equal(store.peek().link, null);
    assert.equal(store.peek().heads.size, 1);
    assert.equal(marker.get(), false);
    assert.equal(voice.at(-1), null);
    assert.equal(pairing.state().phase, 'unpaired');
  });

  it('notices a session the companion no longer knows', async () => {
    const { companion, store, voice, pairing } = setup();
    await pairing.pair({ code: 'ABCDEFGH', origin: companion.origin });
    companion.handlers.set('GET /v1/status', () => ({ status: 401, body: { error: { code: 'unauthenticated', message: 'pair' } } }));
    await assert.rejects(pairing.call('GET', '/v1/status'), (err) => err instanceof CompanionError && err.code === 'unauthenticated');
    assert.equal(pairing.state().phase, 'unpaired');
    assert.equal(pairing.state().lost, true);
    assert.equal(store.peek().link, null);
    assert.equal(voice.at(-1), null);
  });

  it('seals a secret for its link only', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const link = { origin: 'http://127.0.0.1:47821', session: 's1', mode: 'bearer' };
    const sealed = await sealSecret(key, 'secret-value', link);
    assert.equal(await openSecret(key, sealed, link), 'secret-value');
    assert.equal(await openSecret(key, sealed, { ...link, session: 's2' }), null);
    assert.equal(await openSecret(key, { iv: 'bad', data: sealed.data }, link), null);
  });

  it('keeps its stored-link flag under the name the feature module and the pickers read', async () => {
    const feature = await import('../../src/js/features/companion.js');
    assert.equal(feature.LINK_MARKER, LINK_MARKER);
    const providers = await import('../../src/js/providers.js');
    assert.equal(providers.COMPANION_LINK_MARKER, LINK_MARKER);
  });

  it('normalizes what the user typed', () => {
    assert.equal(normalizeCode(' abcd-efgh '), 'ABCDEFGH');
    assert.equal(normalizeCode(null), '');
  });
});

describe('audit check', () => {
  /** Pairs and lets the first head be stored. */
  async function paired() {
    const ctx = setup();
    await ctx.pairing.pair({ code: 'ABCDEFGH', origin: ctx.companion.origin });
    await settle();
    return ctx;
  }

  it('stores the first verified head', async () => {
    const { store, pairing, companion } = await paired();
    assert.equal(pairing.state().audit.state, 'ok');
    assert.equal(store.peek().heads.get(companion.identity.keyId).seq, 5);
  });

  it('moves on with a newer head whose chain still holds the stored one', async () => {
    const { store, pairing, companion } = await paired();
    companion.setSeq(9);
    await pairing.checkAudit();
    assert.equal(pairing.state().audit.state, 'ok');
    assert.equal(store.peek().heads.get(companion.identity.keyId).seq, 9);
    assert.equal(companion.calls('GET', '/v1/audit/head').some((r) => r.query.get('seq') === '5'), true);
  });

  it('calls a lower head a rollback', async () => {
    const { pairing, companion } = await paired();
    companion.setSeq(3);
    const audit = await pairing.checkAudit();
    assert.equal(audit.state, 'rollback');
    assert.equal(audit.stored?.seq, 5);
    assert.equal(audit.reported?.seq, 3);
  });

  it('calls another hash at a known number a fork', async () => {
    const { pairing, companion } = await paired();
    companion.forceHead(companion.identity.head(5, { variant: 'other' }));
    assert.equal((await pairing.checkAudit()).state, 'fork');
  });

  it('calls a newer chain without the stored record a fork', async () => {
    const { pairing, companion } = await paired();
    companion.setSeq(12);
    companion.handlers.set('GET /v1/audit/head', (req) => ({ body: { head: req.query.get('seq') === null ? companion.identity.head(12) : companion.identity.head(Number(req.query.get('seq')), { variant: 'rewritten' }) } }));
    assert.equal((await pairing.checkAudit()).state, 'fork');
  });

  it('calls a head signed by another key invalid', async () => {
    const { pairing, companion } = await paired();
    const stranger = fakeCompanion();
    companion.forceHead(stranger.identity.head(6));
    assert.equal((await pairing.checkAudit()).state, 'invalid');
  });

  it('accepts the companion’s current head on request', async () => {
    const { store, pairing, companion } = await paired();
    companion.setSeq(2);
    assert.equal((await pairing.checkAudit()).state, 'rollback');
    assert.equal(await pairing.acceptCurrent(), true);
    assert.equal(pairing.state().audit.state, 'ok');
    assert.equal(store.peek().heads.get(companion.identity.keyId).seq, 2);
  });

  /**
   * Lets an answer arrive late: its body carries an older head than the companion's current one.
   * @param {ReturnType<typeof fakeCompanion>} companion
   * @param {{ seq: number, hash: string, sig: string }} head
   */
  function lateAnswer(companion, head) {
    companion.handlers.set('GET /v1/notes', () => ({ noHead: true, body: { notes: [], auditHead: head } }));
  }

  it('takes an older head that arrives late for no rollback when the chain holds it', async () => {
    const { store, pairing, companion } = await paired();
    companion.setSeq(7);
    await pairing.checkAudit();
    assert.equal(store.peek().heads.get(companion.identity.keyId).seq, 7);
    lateAnswer(companion, companion.identity.head(6));
    await pairing.call('GET', '/v1/notes');
    await settle();
    assert.equal(pairing.state().audit.state, 'ok', 'no false rollback banner');
    assert.equal(store.peek().heads.get(companion.identity.keyId).seq, 7, 'the highest head stays');
    const asked = companion.calls('GET', '/v1/audit/head').slice(-2).map((r) => r.query.get('seq'));
    assert.deepEqual(asked, [null, '6'], 'the current head first, then the record of the late one');
  });

  it('moves on to the current head when an old answer arrives after newer records', async () => {
    const { store, pairing, companion } = await paired();
    companion.setSeq(9);
    lateAnswer(companion, companion.identity.head(4));
    await pairing.call('GET', '/v1/notes');
    await settle();
    assert.equal(pairing.state().audit.state, 'ok');
    assert.equal(store.peek().heads.get(companion.identity.keyId).seq, 9);
    assert.equal(companion.calls('GET', '/v1/audit/head').some((r) => r.query.get('seq') === '5'), true, 'the stored record is still checked');
  });

  it('still calls a late head of another history a fork', async () => {
    const { pairing, companion } = await paired();
    lateAnswer(companion, companion.identity.head(4, { variant: 'other' }));
    await pairing.call('GET', '/v1/notes');
    await settle();
    assert.equal(pairing.state().audit.state, 'fork');
  });

  it('still calls it a rollback when the current head is lower too', async () => {
    const { pairing, companion } = await paired();
    companion.setSeq(3);
    lateAnswer(companion, companion.identity.head(3));
    await pairing.call('GET', '/v1/notes');
    await settle();
    const audit = pairing.state().audit;
    assert.equal(audit.state, 'rollback');
    assert.equal(audit.reported?.seq, 3);
    assert.equal(await pairing.acceptCurrent(), true);
    assert.equal(pairing.state().audit.state, 'ok');
  });

  it('compares heads by number and hash', () => {
    const h = { seq: 4, hash: 'a'.repeat(64), sig: '' };
    assert.equal(compareHeads(h, null), 'first');
    assert.equal(compareHeads(h, { keyId: 'k', seq: 4, hash: 'a'.repeat(64), sig: '', at: '' }), 'same');
    assert.equal(compareHeads(h, { keyId: 'k', seq: 4, hash: 'b'.repeat(64), sig: '', at: '' }), 'fork');
    assert.equal(compareHeads(h, { keyId: 'k', seq: 5, hash: 'a'.repeat(64), sig: '', at: '' }), 'rollback');
    assert.equal(compareHeads(h, { keyId: 'k', seq: 3, hash: 'a'.repeat(64), sig: '', at: '' }), 'newer');
  });
});
