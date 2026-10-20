import assert from 'node:assert/strict';
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { auditHeadMessage } from '../src/audit/chain.js';
import { publicKeyFromRaw, verifySignature } from '../src/audit/identity.js';
import { call, pairOver, startTest, tempDir } from './helpers.mjs';

const APP = 'https://www.starpi.app';

test('hello, host and origin checks, private-network preflight', async (t) => {
  const { dir, cleanup } = tempDir();
  const { companion, base } = await startTest(dir);
  t.after(async () => {
    await companion.stop();
    cleanup();
  });
  const hello = await call(`${base}/v1/hello`);
  assert.equal(hello.status, 200);
  const body = hello.json();
  assert.deepEqual({ name: body.name, pairing: body.pairing }, { name: 'starpi-companion', pairing: true });
  assert.equal((await call(`${base}/v1/hello`, { host: `rebound.example:${companion.port}` })).status, 421);
  const evil = await call(`${base}/v1/hello`, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
  const fromApp = await call(`${base}/v1/hello`, { origin: APP });
  assert.equal(fromApp.headers['access-control-allow-origin'], APP);
  const preflight = await call(`${base}/v1/session/pair`, { method: 'OPTIONS', origin: APP, headers: { 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-private-network'], 'true');
  assert.equal((await call(`${base}/v1/nothing`)).status, 404);
  assert.equal((await call(`${base}/v1/hello`, { method: 'DELETE' })).status, 405);
});

test('Mode A: same-origin pairing gives an HttpOnly cookie and a CSRF value', async (t) => {
  const { dir, cleanup } = tempDir();
  const { companion, base } = await startTest(dir);
  t.after(async () => {
    await companion.stop();
    cleanup();
  });
  const { res, body } = await pairOver(companion, { origin: base });
  assert.equal(res.status, 200);
  assert.equal(body.mode, 'cookie');
  assert.equal(body.token, undefined);
  const setCookie = String(res.headers['set-cookie']);
  assert.match(setCookie, /HttpOnly; SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  assert.equal((await call(`${base}/v1/status`, { headers: { cookie } })).status, 401, 'no CSRF value');
  const ok = await call(`${base}/v1/status`, { headers: { cookie, 'x-companion-csrf': body.csrf } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json().profile, 'minimal');
  assert.equal((await call(`${base}/v1/status`, { origin: APP, headers: { cookie, 'x-companion-csrf': body.csrf } })).status, 401, 'never from a cross origin');
});

test('Mode B: an allowed origin gets a bearer token; roles gate the owner routes', async (t) => {
  const { dir, cleanup } = tempDir();
  const { companion, base } = await startTest(dir);
  t.after(async () => {
    await companion.stop();
    cleanup();
  });
  const owner = await pairOver(companion, { origin: APP, role: 'owner' });
  assert.equal(owner.body.mode, 'bearer');
  assert.equal(owner.body.keyId, companion.installation.identity.keyId);
  const member = await pairOver(companion, { origin: APP, role: 'member' });
  const as = (/** @type {string} */ token) => ({ origin: APP, headers: { authorization: `Bearer ${token}` } });
  assert.equal((await call(`${base}/v1/secrets`, as(member.body.token))).status, 403);
  assert.equal((await call(`${base}/v1/status`, as(member.body.token))).status, 200);
  const put = await call(`${base}/v1/secrets/openai`, { ...as(owner.body.token), method: 'PUT', body: { value: 'sk-test-123' } });
  assert.equal(put.status, 200);
  const list = (await call(`${base}/v1/secrets`, as(owner.body.token))).json();
  assert.deepEqual(list.secrets.map((/** @type {any} */ s) => s.name), ['openai']);
  assert.equal(JSON.stringify(list).includes('sk-test-123'), false);
  assert.equal((await call(`${base}/v1/status`, { origin: 'https://evil.example', headers: { authorization: `Bearer ${owner.body.token}` } })).status, 403);
  const sessions = (await call(`${base}/v1/sessions`, as(owner.body.token))).json().sessions;
  assert.equal(sessions.length, 2);
  assert.equal((await call(`${base}/v1/sessions/${member.body.session}`, { ...as(owner.body.token), method: 'DELETE' })).status, 200);
  assert.equal((await call(`${base}/v1/status`, as(member.body.token))).status, 401);
  assert.equal((await call(`${base}/v1/session/pair`, { method: 'POST', origin: 'https://evil.example', body: { code: 'AAAAAAAA' } })).status, 403);
});

test('every answer carries a signed audit head that verifies and grows with the chain', async (t) => {
  const { dir, cleanup } = tempDir();
  const { companion, base } = await startTest(dir);
  t.after(async () => {
    await companion.stop();
    cleanup();
  });
  const { body } = await pairOver(companion, { origin: APP });
  const headers = { authorization: `Bearer ${body.token}` };
  const r1 = await call(`${base}/v1/audit/head`, { origin: APP, headers });
  const head = r1.json().head;
  const key = publicKeyFromRaw(body.publicKey);
  assert.equal(verifySignature(key, auditHeadMessage({ keyId: body.keyId, seq: head.seq, hash: head.hash }), head.sig), true);
  assert.equal(r1.headers['x-companion-audit-head'], `${head.seq}.${head.hash}.${head.sig}`);
  assert.equal(r1.headers['access-control-expose-headers'], 'X-Companion-Audit-Head');
  await call(`${base}/v1/secrets/k1`, { method: 'PUT', origin: APP, headers, body: { value: 'v' } });
  const later = (await call(`${base}/v1/status`, { origin: APP, headers })).json().auditHead;
  assert.ok(later.seq > head.seq);
  const past = (await call(`${base}/v1/audit/head?seq=${head.seq}`, { origin: APP, headers })).json().head;
  assert.deepEqual({ seq: past.seq, hash: past.hash }, { seq: head.seq, hash: head.hash }, 'the browser can check its stored head is an ancestor');
  const report = (await call(`${base}/v1/audit/verify`, { origin: APP, headers })).json().report;
  assert.equal(report.ok, true);
});

test('owner routes: erase a namespace (confirmed), reset the breaker with a reason', async (t) => {
  const { dir, cleanup } = tempDir();
  const { companion, base } = await startTest(dir);
  t.after(async () => {
    await companion.stop();
    cleanup();
  });
  companion.installation.vault.namespace('notes').put('n', 'v');
  const { body } = await pairOver(companion, { origin: APP });
  const opts = { origin: APP, headers: { authorization: `Bearer ${body.token}` } };
  assert.equal((await call(`${base}/v1/vault/erase`, { ...opts, method: 'POST', body: { namespace: 'notes' } })).status, 400);
  const erased = await call(`${base}/v1/vault/erase`, { ...opts, method: 'POST', body: { namespace: 'notes', confirm: 'notes' } });
  assert.equal(erased.json().items, 1);
  assert.equal(companion.installation.keyring.has('notes'), false);
  assert.equal((await call(`${base}/v1/breaker/reset`, { ...opts, method: 'POST', body: { reason: '' } })).status, 400);
  assert.equal((await call(`${base}/v1/breaker/reset`, { ...opts, method: 'POST', body: { reason: 'checked the logs' } })).json().level, 'steady');
  const kinds = companion.installation.store.db.prepare('SELECT kind FROM audit_log ORDER BY seq').all().map((/** @type {any} */ r) => r.kind);
  assert.ok(kinds.includes('vault.erased'));
  assert.ok(kinds.includes('session.paired'));
  const bad = await call(`${base}/v1/secrets/x`, { ...opts, method: 'PUT', headers: { ...opts.headers, 'content-type': 'text/plain' } });
  assert.ok([400, 415].includes(bad.status));
});

test('Mode A static app: headers from headers.json, index for navigations, no escapes', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = join(dir, 'app');
  mkdirSync(join(app, 'assets'), { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(join(app, 'assets', 'a.js'), 'export {};');
  writeFileSync(join(app, '.hidden'), 'no');
  writeFileSync(join(dir, 'outside.txt'), 'secret');
  symlinkSync(join(dir, 'outside.txt'), join(app, 'link.txt'));
  linkSync(join(dir, 'outside.txt'), join(app, 'hard.txt'));
  writeFileSync(join(app, 'headers.json'), JSON.stringify({ profile: 'companion', digest: 'x', rules: [{ source: '/(.*)', headers: [{ key: 'Content-Security-Policy', value: "default-src 'self'" }] }, { source: '/assets/(.*)', headers: [{ key: 'Cache-Control', value: 'immutable' }] }] }));
  const { companion, base } = await startTest(dir, { appDir: app });
  t.after(async () => {
    await companion.stop();
    cleanup();
  });
  const index = await call(`${base}/`);
  assert.equal(index.status, 200);
  assert.equal(index.headers['content-security-policy'], "default-src 'self'");
  assert.equal((await call(`${base}/assets/a.js`)).headers['cache-control'], 'immutable');
  assert.equal((await call(`${base}/settings/companion`, { headers: { accept: 'text/html' } })).text, '<!doctype html><title>app</title>');
  assert.equal((await call(`${base}/`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 200, 'a link from another site opens the app');
  assert.equal((await call(`${base}/assets/a.js`, { origin: 'https://evil.example' })).status, 403);
  for (const path of ['/.hidden', '/link.txt', '/hard.txt', '/headers.json', '/%2e%2e/outside.txt', '/assets%2fa.js']) assert.equal((await call(`${base}${path}`)).status, 404, path);
  const redirect = await call(`${base}/`, { host: `localhost:${companion.port}` });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, `http://127.0.0.1:${companion.port}/`);
});
