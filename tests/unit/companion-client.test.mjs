// The companion's HTTP client in the browser (src/js/companion/client.js): loopback origins only,
// the signed audit head in its three forms and its Ed25519 check over the canonical message, the
// two sign-ins (bearer token, CSRF value), requests that are never cached or redirected, stable
// error codes, server-sent events with the final audit event, and the probe.
import './setup.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { asHead, CompanionError, createCompanionClient, headMessage, keyIdMatches, loopbackOrigin, parseHeadHeader, verifyHead, importIdentityKey } from '../../src/js/companion/client.js';
import { fakeCompanion, makeIdentity } from './companion-fakes.mjs';

describe('loopback origins', () => {
  it('accepts the loopback hosts and gives the canonical origin', () => {
    assert.equal(loopbackOrigin('http://127.0.0.1:47821'), 'http://127.0.0.1:47821');
    assert.equal(loopbackOrigin(' http://localhost:47821/ '), 'http://localhost:47821');
    assert.equal(loopbackOrigin('http://[::1]:5000'), 'http://[::1]:5000');
  });

  it('refuses other hosts, paths, credentials and schemes', () => {
    for (const value of ['https://example.org', 'http://127.0.0.1:47821/v1', 'http://user:pw@127.0.0.1:1', 'ftp://127.0.0.1', 'http://127.0.0.1.example.org', 'http://192.168.1.4:47821', '', null, 42]) {
      assert.equal(loopbackOrigin(value), null, String(value));
    }
  });

  it('will not make a client for any other origin', () => {
    assert.throws(() => createCompanionClient({ origin: 'https://example.org' }), (err) => err instanceof CompanionError && err.code === 'origin_invalid');
  });
});

describe('audit heads', () => {
  const id = makeIdentity();

  it('reads the header form and the JSON form, and nothing else', () => {
    const head = id.head(7);
    assert.deepEqual(parseHeadHeader(`${head.seq}.${head.hash}.${head.sig}`), head);
    assert.deepEqual(asHead(head), head);
    assert.equal(parseHeadHeader('7.abc.def'), null);
    assert.equal(asHead({ seq: -1, hash: head.hash, sig: head.sig }), null);
    assert.equal(asHead({ seq: 1, hash: 'xyz', sig: head.sig }), null);
  });

  it('signs the canonical message with sorted keys and no white space', () => {
    assert.equal(headMessage({ keyId: 'k1', seq: 12, hash: 'ab' }), '{"hash":"ab","key":"k1","kind":"starpi.companion.audit-head","seq":12,"v":1}');
  });

  it('verifies a head of the identity and nothing changed', async () => {
    const key = await importIdentityKey(id.publicKey);
    const identity = { key, keyId: id.keyId };
    const head = id.head(9);
    assert.equal(await verifyHead(head, identity), true);
    assert.equal(await verifyHead({ ...head, seq: 10 }, identity), false);
    assert.equal(await verifyHead({ ...head, hash: id.head(9, { variant: 'x' }).hash }, identity), false);
    assert.equal(await verifyHead(id.head(9, { keyId: 'f'.repeat(64) }), identity), false);
    const other = makeIdentity();
    assert.equal(await verifyHead(other.head(9), identity), false);
  });

  it('checks that a public key has its key id', async () => {
    assert.equal(await keyIdMatches(id.publicKey, id.keyId), true);
    assert.equal(await keyIdMatches(id.publicKey, makeIdentity().keyId), false);
    assert.equal(await keyIdMatches('short', id.keyId), false);
  });
});

describe('requests', () => {
  it('sends the bearer token, no cookie, nothing cached, no redirect', async () => {
    const companion = fakeCompanion();
    companion.handlers.set('GET /v1/status', () => ({ body: { version: '2.1.0' } }));
    const client = createCompanionClient({ origin: companion.origin, auth: { kind: 'bearer', token: 'tok_abcdefghijklmnopqrstuvwxyz' }, fetch: companion.fetch });
    const body = await client.request('GET', '/v1/status');
    assert.equal(body.version, '2.1.0');
    const [req] = companion.calls('GET', '/v1/status');
    assert.equal(req.headers.authorization, 'Bearer tok_abcdefghijklmnopqrstuvwxyz');
    assert.equal(req.headers['x-companion-csrf'], undefined);
    assert.equal(req.init.credentials, 'omit');
    assert.equal(req.init.cache, 'no-store');
    assert.equal(req.init.redirect, 'error');
    assert.deepEqual(Object.keys(req.headers), ['authorization']);
  });

  it('sends the CSRF value of a cookie session', async () => {
    const companion = fakeCompanion();
    companion.handlers.set('POST /v1/memory/notes', (req) => ({ status: 201, body: { note: { id: 'note-1', text: req.body.text } } }));
    const client = createCompanionClient({ origin: companion.origin, auth: { kind: 'cookie', csrf: 'csrf_abcdefghijklmnopqrstuvwxyz' }, fetch: companion.fetch });
    const r = await client.request('POST', '/v1/memory/notes', { body: { text: 'Hello' } });
    assert.equal(r.note.text, 'Hello');
    const [req] = companion.calls('POST', '/v1/memory/notes');
    assert.equal(req.headers['x-companion-csrf'], 'csrf_abcdefghijklmnopqrstuvwxyz');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.headers.authorization, undefined);
  });

  it('reports the head of the header and of the body', async () => {
    const companion = fakeCompanion();
    /** @type {any[]} */
    const heads = [];
    const client = createCompanionClient({ origin: companion.origin, fetch: companion.fetch, onHead: (h) => heads.push(h) });
    await client.hello();
    assert.equal(heads.length, 2);
    assert.equal(heads[0].seq, 5);
    assert.deepEqual(heads[0], heads[1]);
  });

  it('turns failures into stable codes', async () => {
    const companion = fakeCompanion();
    companion.handlers.set('GET /v1/docs', () => ({ status: 503, body: { error: { code: 'breaker_engaged', message: 'busy' } } }));
    companion.handlers.set('GET /v1/plain', () => ({ body: 'oops', type: 'text/html' }));
    const client = createCompanionClient({ origin: companion.origin, fetch: companion.fetch });
    await assert.rejects(client.request('GET', '/v1/docs'), (err) => err instanceof CompanionError && err.code === 'breaker_engaged' && err.status === 503);
    await assert.rejects(client.request('GET', '/v1/plain'), (err) => err instanceof CompanionError && err.code === 'bad_response');
    await assert.rejects(client.request('POST', '/v1/session/pair', { body: { code: 'WRONG' } }), (err) => err instanceof CompanionError && err.code === 'pairing_failed');
    const offline = createCompanionClient({ origin: 'http://127.0.0.1:1', fetch: companion.fetch });
    await assert.rejects(offline.hello(), (err) => err instanceof CompanionError && err.code === 'unreachable');
    await assert.rejects(client.request('GET', '/elsewhere'), (err) => err instanceof CompanionError && err.code === 'bad_request');
  });

  it('knows the companion when it probes', async () => {
    const companion = fakeCompanion();
    const client = createCompanionClient({ origin: companion.origin, fetch: companion.fetch, auth: { kind: 'bearer', token: 'tok_abcdefghijklmnopqrstuvwxyz' } });
    assert.deepEqual(await client.hello(), { name: 'starpi-companion', version: '2.1.0', pairing: true });
    // The probe never carries the token.
    assert.equal(companion.calls('GET', '/v1/hello')[0].headers.authorization, undefined);
    companion.handlers.set('GET /v1/hello', () => ({ body: { name: 'something-else' } }));
    await assert.rejects(client.hello(), (err) => err instanceof CompanionError && err.code === 'not_a_companion');
  });

  it('reads a stream to its end, reports the audit event and stops on an error event', async () => {
    const companion = fakeCompanion();
    companion.handlers.set('POST /v1/chat', () => ({ events: [{ event: 'start', data: { conversation: 'chat-1', turn: 1 } }, { event: 'unit', data: { text: 'One.', cites: [], kind: 'sentence' } }] }));
    /** @type {any[]} */
    const heads = [];
    const client = createCompanionClient({ origin: companion.origin, fetch: companion.fetch, onHead: (h) => heads.push(h) });
    /** @type {string[]} */
    const events = [];
    await client.stream('POST', '/v1/chat', { body: { question: 'q' }, onEvent: (event) => events.push(event) });
    assert.deepEqual(events, ['start', 'unit', 'audit']);
    assert.equal(heads.length, 2);
    companion.handlers.set('POST /v1/chat', () => ({ events: [{ event: 'error', data: { code: 'module_stopped' } }] }));
    await assert.rejects(client.stream('POST', '/v1/chat', { body: { question: 'q' }, onEvent: () => {} }), (err) => err instanceof CompanionError && err.code === 'module_stopped');
  });
});
