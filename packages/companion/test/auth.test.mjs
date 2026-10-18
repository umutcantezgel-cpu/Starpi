import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { openStore } from '../src/store/sqlite.js';
import { createSessions, CODE_ALPHABET, MAX_FAILURES, normalizeCode } from '../src/auth/sessions.js';
import { createOriginPolicy, normalizeOrigin } from '../src/auth/origins.js';
import { manualClock } from '../src/lib/clock.js';
import { tempDir } from './helpers.mjs';

/** @param {string} dir */
function setup(dir) {
  const clock = manualClock(Date.UTC(2026, 6, 1));
  const store = openStore({ path: join(dir, 'c.db') });
  return { clock, store, sessions: createSessions({ store, clock }) };
}

test('a code pairs once; only hashes are stored', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const { store, sessions } = setup(dir);
  const { code } = sessions.issueCode({ role: 'member', label: 'phone' });
  assert.match(code, new RegExp(`^[${CODE_ALPHABET}]{8}$`));
  const paired = sessions.pair({ code: `${code.slice(0, 4)}-${code.slice(4).toLowerCase()}`, kind: 'bearer', origin: 'https://www.starpi.app' });
  assert.equal(paired.role, 'member');
  assert.equal(paired.csrf, null);
  assert.throws(() => sessions.pair({ code, kind: 'bearer', origin: 'https://www.starpi.app' }), (err) => /** @type {any} */ (err).code === 'pairing_failed');
  const dump = JSON.stringify(store.db.prepare('SELECT * FROM auth_sessions').all()) + JSON.stringify(store.db.prepare('SELECT * FROM auth_codes').all());
  assert.equal(dump.includes(paired.token), false);
  assert.equal(dump.includes(code), false);
});

test('codes expire, and five wrong codes void every open code', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const { clock, sessions } = setup(dir);
  const old = sessions.issueCode().code;
  clock.advance(11 * 60_000);
  assert.throws(() => sessions.pair({ code: old, kind: 'cookie', origin: null }), /wrong or expired/);
  const good = sessions.issueCode().code;
  for (let i = 0; i < MAX_FAILURES - 1; i += 1) assert.throws(() => sessions.pair({ code: 'AAAAAAAA', kind: 'cookie', origin: null }));
  assert.throws(() => sessions.pair({ code: 'AAAAAAAA', kind: 'cookie', origin: null }));
  assert.throws(() => sessions.pair({ code: good, kind: 'cookie', origin: null }), /wrong or expired/, 'the good code was voided');
});

test('cookie sessions need the CSRF value and the same origin; bearer tokens stay bound to their origin', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const { sessions } = setup(dir);
  const cookie = sessions.pair({ code: sessions.issueCode({ role: 'owner' }).code, kind: 'cookie', origin: null });
  assert.equal(sessions.authenticate({ cookie: cookie.token, csrf: cookie.csrf, origin: null, sameOrigin: true })?.role, 'owner');
  assert.equal(sessions.authenticate({ cookie: cookie.token, csrf: null, origin: null, sameOrigin: true }), null);
  assert.equal(sessions.authenticate({ cookie: cookie.token, csrf: 'x'.repeat(43), origin: null, sameOrigin: true }), null);
  assert.equal(sessions.authenticate({ cookie: cookie.token, csrf: cookie.csrf, origin: 'https://www.starpi.app', sameOrigin: false }), null);
  const bearer = sessions.pair({ code: sessions.issueCode().code, kind: 'bearer', origin: 'https://www.starpi.app' });
  assert.ok(sessions.authenticate({ bearer: bearer.token, origin: 'https://www.starpi.app', sameOrigin: false }));
  assert.ok(sessions.authenticate({ bearer: bearer.token, origin: null, sameOrigin: true }), 'a local script without Origin');
  assert.equal(sessions.authenticate({ bearer: bearer.token, origin: 'https://other.example', sameOrigin: false }), null);
  assert.equal(sessions.authenticate({ bearer: cookie.token, origin: null, sameOrigin: true }), null, 'a cookie value is no bearer token');
  assert.equal(sessions.revoke({ id: bearer.session }), 1);
  assert.equal(sessions.authenticate({ bearer: bearer.token, origin: null, sameOrigin: true }), null);
  assert.equal(sessions.list().length, 1);
  assert.equal(sessions.revoke({ all: true }), 1);
  assert.equal(sessions.list().length, 0);
});

test('origins: https, http only on loopback, the companion itself is no cross origin', () => {
  assert.equal(normalizeOrigin('https://WWW.Starpi.app'), 'https://www.starpi.app');
  assert.equal(normalizeOrigin('http://example.com'), null);
  assert.equal(normalizeOrigin('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeOrigin('https://x.example/path'), null);
  assert.equal(normalizeOrigin('null'), null);
  const policy = createOriginPolicy({ allowed: ['https://www.starpi.app', 'https://self.example'], port: 47821 });
  assert.equal(policy.isSelf('http://127.0.0.1:47821'), true);
  assert.equal(policy.isAllowed('https://self.example'), true);
  assert.equal(policy.isAllowed('https://evil.example'), false);
  assert.deepEqual(policy.corsHeaders('https://evil.example'), {});
  assert.equal(policy.corsHeaders('https://www.starpi.app', { preflight: true, privateNetwork: true })['Access-Control-Allow-Private-Network'], 'true');
  assert.throws(() => createOriginPolicy({ allowed: ['http://example.com'], port: 1 }));
  assert.equal(normalizeCode(' ab-cd efgh '), 'ABCDEFGH');
});
