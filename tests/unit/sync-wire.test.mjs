// The chat sync over the wire: the real data layer (supabase.js with the Supabase client) against a
// fake Supabase project (auth and PostgREST with owner-only rows), with every request recorded.
// - Only ciphertext leaves the browser: no request carries a message, a title, a conversation id or
//   the passphrase, chat_sync rows and the key envelope have exactly their four and six columns in
//   the formats the database checks, and the plaintext chat_history table is never touched.
// - A second browser reaches the same account with an email code and restores the conversations
//   with the passphrase.
// - Writes name the revision they build on (PATCH … rev=eq.n); a stale write merges and retries.
// - Turning off with deletion removes the key first, then the rows.
import './setup.mjs';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { createChatStore } from '../../src/js/chat/store.js';
import { nodeText } from '../../src/js/chat/tree.js';
import { openAppDb } from '../../src/js/store/schema.js';
import { createChatSync, settingsStateStore } from '../../src/js/sync/sync.js';

const PASSPHRASE = 'lighthouse keeper at dawn';
const EMAIL = 'reader@example.org';
const CODE = '246810';
const SECRETS = ['Which herbs grow in shade?', 'Mint and parsley grow well in shade.', 'Shade garden', 'starpi_garden', PASSPHRASE];

/** @typedef {{ method: string, path: string, query: string, headers: Record<string, string>, body: string }} Recorded */

/** A Supabase project in memory: anonymous and email accounts, chat_sync and chat_sync_keys. */
function fakeProject() {
  /** @type {Recorded[]} */
  const requests = [];
  /** @type {Map<string, { id: string, email: string | null, pendingEmail: string | null }>} */
  const users = new Map();
  /** @type {Map<string, string>} token → user id */
  const tokens = new Map();
  /** @type {Array<{ user_id: string, conv_id: string, rev: number, iv: string, ciphertext: string }>} */
  let rows = [];
  /** @type {Array<Record<string, unknown> & { user_id: string }>} */
  let keys = [];
  let seq = 0;

  const b64url = (/** @type {object} */ v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  /** @param {{ id: string, email: string | null }} user */
  function session(user) {
    seq += 1;
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: user.id, role: 'authenticated', exp, n: seq, is_anonymous: !user.email })}.c2ln`;
    tokens.set(token, user.id);
    return {
      access_token: token,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: exp,
      refresh_token: `refresh-${seq}`,
      user: userJson(user),
    };
  }
  /** @param {{ id: string, email: string | null, pendingEmail?: string | null }} user */
  const userJson = (user) => ({ id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email ?? '', new_email: user.pendingEmail ?? undefined, is_anonymous: !user.email, app_metadata: {}, user_metadata: {}, created_at: '2026-10-18T00:00:00Z' });

  /**
   * @param {number} status
   * @param {unknown} [body]
   */
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  /**
   * PostgREST filters of a query string: eq. and in.() on the given columns.
   * @param {URLSearchParams} q
   * @returns {(row: Record<string, unknown>) => boolean}
   */
  function filterOf(q) {
    /** @type {Array<(row: Record<string, unknown>) => boolean>} */
    const tests = [];
    for (const [key, value] of q) {
      if (['select', 'order', 'offset', 'limit', 'columns'].includes(key)) continue;
      if (value.startsWith('eq.')) tests.push((r) => String(r[key]) === value.slice(3));
      else if (value.startsWith('in.(')) {
        const set = new Set(value.slice(4, -1).split(',').map((v) => v.replace(/^"|"$/g, '')));
        tests.push((r) => set.has(String(r[key])));
      } else throw new Error(`unsupported filter ${key}=${value}`);
    }
    return (row) => tests.every((t) => t(row));
  }
  /**
   * @param {Record<string, unknown>} row
   * @param {string | null} select
   */
  const pick = (row, select) => (select ? Object.fromEntries(select.split(',').map((c) => [c.trim(), row[c.trim()]])) : row);

  /**
   * @param {string} uid
   * @param {string} table
   * @param {string} method
   * @param {URLSearchParams} q
   * @param {any} body
   * @param {string} prefer
   */
  function rest(uid, table, method, q, body, prefer) {
    const own = (/** @type {{ user_id: string }} */ r) => r.user_id === uid;
    const where = filterOf(q);
    const select = q.get('select');
    if (table === 'chat_sync_keys') {
      if (method === 'GET') return json(200, keys.filter((k) => own(k) && where(k)).map((k) => pick(k, select)));
      if (method === 'POST') {
        if (keys.some(own)) return json(409, { code: '23505', message: 'duplicate key value violates unique constraint "chat_sync_keys_pkey"' });
        keys.push({ ...body, user_id: uid });
        return json(201);
      }
      if (method === 'DELETE') {
        keys = keys.filter((k) => !(own(k) && where(k)));
        return json(204);
      }
    }
    if (table === 'chat_sync') {
      if (method === 'GET') {
        let out = rows.filter((r) => own(r) && where(r)).sort((a, b) => (a.conv_id < b.conv_id ? -1 : 1));
        const offset = Number(q.get('offset') ?? 0);
        const limit = Number(q.get('limit') ?? 1000);
        out = out.slice(offset, offset + limit);
        return json(200, out.map((r) => pick(r, select)));
      }
      if (method === 'POST') {
        if (rows.some((r) => own(r) && r.conv_id === body.conv_id)) return json(409, { code: '23505', message: 'duplicate key value violates unique constraint "chat_sync_pkey"' });
        rows.push({ ...body, user_id: uid });
        return json(201);
      }
      if (method === 'PATCH') {
        const hit = rows.filter((r) => own(r) && where(r));
        for (const r of hit) {
          if (body.rev <= r.rev) return json(400, { code: '40001', message: 'chat_sync revision is not newer' });
          Object.assign(r, body);
        }
        return prefer.includes('return=representation') ? json(200, hit.map((r) => pick(r, select))) : json(204);
      }
      if (method === 'DELETE') {
        rows = rows.filter((r) => !(own(r) && where(r)));
        return json(204);
      }
    }
    return json(404, { code: 'PGRST205', message: `no table ${table}` });
  }

  /** @type {typeof fetch} */
  async function fetchImpl(input, init = {}) {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const body = init.body !== undefined && init.body !== null ? String(init.body) : request.body ? await request.text() : '';
    const headers = Object.fromEntries(new Headers(init.headers ?? request.headers));
    const method = (init.method ?? request.method).toUpperCase();
    requests.push({ method, path: url.pathname, query: url.search, headers, body });
    const data = body ? JSON.parse(body) : null;
    const bearer = headers.authorization?.replace(/^Bearer /, '') ?? '';
    const uid = tokens.get(bearer) ?? null;
    const p = url.pathname;

    if (p === '/auth/v1/settings') return json(200, { external: { anonymous_users: true, email: true } });
    if (p === '/auth/v1/signup' && method === 'POST') {
      const user = { id: crypto.randomUUID(), email: null, pendingEmail: null };
      users.set(user.id, user);
      return json(200, session(user));
    }
    if (p === '/auth/v1/user' && method === 'PUT') {
      const user = uid ? users.get(uid) : null;
      if (!user) return json(401, { code: 401, error_code: 'no_authorization', msg: 'No session' });
      if ([...users.values()].some((u) => u.email === data.email)) return json(422, { code: 422, error_code: 'email_exists', msg: 'Email address already registered' });
      user.pendingEmail = data.email;
      return json(200, userJson(user));
    }
    if (p === '/auth/v1/otp' && method === 'POST') {
      if (![...users.values()].some((u) => u.email === data.email)) return json(422, { code: 422, error_code: 'otp_disabled', msg: 'Signups not allowed for otp' });
      return json(200, {});
    }
    if (p === '/auth/v1/verify' && method === 'POST') {
      if (data.token !== CODE) return json(403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
      if (data.type === 'email_change') {
        const user = [...users.values()].find((u) => u.pendingEmail === data.email);
        if (!user) return json(403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
        user.email = user.pendingEmail;
        user.pendingEmail = null;
        return json(200, session(user));
      }
      const user = [...users.values()].find((u) => u.email === data.email);
      return user ? json(200, session(user)) : json(403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
    }
    if (p === '/auth/v1/logout') return new Response(null, { status: 204 });
    if (p === '/rest/v1/knowledge_documents') return json(200, []);
    if (p.startsWith('/rest/v1/')) {
      if (!uid) return json(401, { code: '42501', message: 'permission denied' });
      const response = rest(uid, p.slice('/rest/v1/'.length), method, url.searchParams, data, headers.prefer ?? '');
      // Lets a test act right after a revision list was answered (another browser writing meanwhile).
      const hook = project.afterList;
      if (hook && method === 'GET' && p === '/rest/v1/chat_sync' && url.searchParams.get('select') === 'conv_id,rev') {
        project.afterList = null;
        await hook();
      }
      return response;
    }
    return json(404, { message: `unknown route ${method} ${p}` });
  }

  const project = {
    /** @type {(() => Promise<void>) | null} */
    afterList: null,
    requests,
    fetch: fetchImpl,
    get rows() {
      return rows;
    },
    get keys() {
      return keys;
    },
  };
  return project;
}

let seq = 0;

/**
 * A browser: its own instance of the data layer (own Supabase client and session), database,
 * conversation store and sync engine.
 */
async function browser() {
  seq += 1;
  const data = /** @type {typeof import('../../src/js/supabase.js')} */ (await import(`../../src/js/supabase.js?browser=${seq}`));
  const factory = new IDBFactory();
  /** @type {Promise<import('../../src/js/store/idb.js').StoreDb> | null} */
  let db = null;
  const open = () => (db ??= openAppDb({ name: `sync-wire-${seq}`, factory }));
  const store = createChatStore({ open });
  const sync = createChatSync({
    remote: {
      account: data.syncAccount,
      getKeyEnvelope: data.getSyncKeyEnvelope,
      putKeyEnvelope: data.putSyncKeyEnvelope,
      listRevisions: data.listSyncRevisions,
      fetchRows: data.fetchSyncRows,
      writeRow: data.writeSyncRow,
      deleteAll: data.deleteSyncData,
    },
    store: async () => store,
    state: settingsStateStore(open),
  });
  const connection = await data.connect();
  assert.equal(connection.status, 'ready');
  assert.equal(connection.signedIn, true);
  return { data, store, sync };
}

describe('chat sync over the wire', () => {
  const project = fakeProject();
  const realFetch = globalThis.fetch;
  before(() => {
    globalThis.fetch = project.fetch;
  });
  after(() => {
    globalThis.fetch = realFetch;
  });

  /** @type {Awaited<ReturnType<typeof browser>>} */
  let a;
  /** @type {Awaited<ReturnType<typeof browser>>} */
  let b;

  it('sends only ciphertext when sync is turned on', async () => {
    a = await browser();
    await a.store.appendToActive('starpi_garden', { role: 'user', parts: [{ type: 'text', text: SECRETS[0] }] }, { create: { mode: 'free' } });
    await a.store.appendToActive('starpi_garden', { role: 'assistant', parts: [{ type: 'text', text: SECRETS[1] }] });
    await a.store.updateConversation('starpi_garden', { title: SECRETS[2] });
    const on = await a.sync.enable(PASSPHRASE);
    assert.equal(on.ok && on.report?.written, 1);

    assert.equal(project.keys.length, 1);
    assert.deepEqual(Object.keys(project.keys[0]).sort(), ['iterations', 'iv', 'kdf', 'key_id', 'salt', 'user_id', 'wrapped_key']);
    assert.equal(project.keys[0].iterations, 600000);
    assert.equal(project.rows.length, 1);
    const writes = project.requests.filter((r) => r.path === '/rest/v1/chat_sync' && (r.method === 'POST' || r.method === 'PATCH'));
    assert.equal(writes.length, 1);
    const body = JSON.parse(writes[0].body);
    assert.deepEqual(Object.keys(body).sort(), ['ciphertext', 'conv_id', 'iv', 'rev']);
    assert.match(body.conv_id, /^[A-Za-z0-9_-]{32}$/);
    assert.match(body.iv, /^[A-Za-z0-9+/]{16}$/);
    assert.match(body.ciphertext, /^[A-Za-z0-9+/]+={0,2}$/);
    assert.equal(body.rev, 1);
  });

  it('restores in a second browser signed in to the same account with an email code', async () => {
    // The first browser adds an address to its anonymous account (same user id, same rows).
    const before = await a.data.syncAccount();
    assert.equal(before.ok && before.data.anonymous, true);
    assert.deepEqual(await a.data.sendEmailCode(EMAIL, 'link'), { ok: true, data: null });
    const wrong = await a.data.verifyEmailCode(EMAIL, '000000', 'link');
    assert.equal(wrong.ok ? null : wrong.error.kind, 'invalid_code');
    const linked = await a.data.verifyEmailCode(EMAIL, CODE, 'link');
    assert.ok(linked.ok);
    assert.equal(linked.data.userId, before.ok && before.data.userId);
    assert.equal(linked.data.email, EMAIL);
    assert.equal(linked.data.anonymous, false);

    b = await browser();
    const unknown = await b.data.sendEmailCode('nobody@example.org', 'sign_in');
    assert.equal(unknown.ok ? null : unknown.error.kind, 'no_account');
    const invalid = await b.data.sendEmailCode('not an address', 'sign_in');
    assert.equal(invalid.ok ? null : invalid.error.kind, 'invalid_email');
    assert.deepEqual(await b.data.sendEmailCode(EMAIL, 'sign_in'), { ok: true, data: null });
    const signedIn = await b.data.verifyEmailCode(EMAIL, CODE, 'sign_in');
    assert.equal(signedIn.ok && signedIn.data.userId, linked.data.userId);

    const joined = await b.sync.enable(PASSPHRASE);
    assert.equal(joined.ok && joined.joined, true);
    const thread = await b.store.loadThread('starpi_garden');
    assert.equal(thread?.conversation.title, SECRETS[2]);
    assert.deepEqual(thread?.path.map((n) => nodeText(n)), [SECRETS[0], SECRETS[1]]);
  });

  it('writes against the revision it builds on, and merges a stale write', async () => {
    await b.store.appendToActive('starpi_garden', { role: 'user', parts: [{ type: 'text', text: 'And in full sun?' }] });
    await b.store.appendToActive('starpi_garden', { role: 'assistant', parts: [{ type: 'text', text: 'Lavender and thyme.' }] });
    await a.store.appendToActive('starpi_garden', { role: 'user', parts: [{ type: 'text', text: 'What about basil?' }] });
    await a.store.appendToActive('starpi_garden', { role: 'assistant', parts: [{ type: 'text', text: 'Basil wants sun.' }] });
    // B writes right after A has read the revisions, so A's write builds on a stale revision.
    project.afterList = async () => {
      assert.equal((await b.sync.syncNow())?.written, 1);
    };
    const report = await a.sync.syncNow();
    assert.deepEqual(report, { applied: 1, written: 1, skipped: 0 });
    const patches = project.requests.filter((r) => r.path === '/rest/v1/chat_sync' && r.method === 'PATCH').map((r) => r.query);
    assert.equal(patches.length, 3, 'B writes rev 2; A tries rev 2 on rev 1, merges, writes rev 3 on rev 2');
    assert.match(patches[0], /rev=eq\.1/);
    assert.match(patches[1], /rev=eq\.1/);
    assert.match(patches[2], /rev=eq\.2/);
    assert.equal(project.rows[0].rev, 3);
    await b.sync.syncNow();
    const texts = async (/** @type {typeof a} */ x) => (await x.store.getNodes('starpi_garden')).map((n) => nodeText(n)).sort();
    assert.deepEqual(await texts(a), await texts(b));
    assert.equal((await texts(a)).length, 6);
  });

  it('never sends a message, title, conversation id or the passphrase, and never touches chat_history', () => {
    for (const r of project.requests) {
      const all = `${r.method} ${r.path}${decodeURIComponent(r.query)} ${JSON.stringify(r.headers)} ${r.body}`;
      for (const secret of SECRETS) assert.equal(all.includes(secret), false, `${secret} in ${r.method} ${r.path}`);
      for (const later of ['And in full sun?', 'Lavender and thyme.', 'What about basil?', 'Basil wants sun.']) assert.equal(all.includes(later), false);
      assert.equal(r.path.includes('chat_history'), false);
    }
    const tables = new Set(project.requests.filter((r) => r.path.startsWith('/rest/v1/')).map((r) => r.path));
    assert.deepEqual([...tables].sort(), ['/rest/v1/chat_sync', '/rest/v1/chat_sync_keys', '/rest/v1/knowledge_documents']);
  });

  it('turning off with deletion removes the key first, then the rows; the other browser stops', async () => {
    const mark = project.requests.length;
    assert.equal(await a.sync.disable({ deleteRemote: true }), true);
    const deletes = project.requests.slice(mark).filter((r) => r.method === 'DELETE').map((r) => r.path);
    assert.deepEqual(deletes, ['/rest/v1/chat_sync_keys', '/rest/v1/chat_sync']);
    assert.equal(project.keys.length, 0);
    assert.equal(project.rows.length, 0);
    assert.equal(await b.sync.syncNow(), null);
    assert.equal(b.sync.status().phase, 'remote_off');
    assert.ok(await b.store.getConversation('starpi_garden'));
  });

  it('signing out starts a new anonymous account', async () => {
    const before = await b.data.syncAccount();
    assert.deepEqual(await b.data.signOutAccount(), { ok: true, data: null });
    const after = await b.data.syncAccount();
    assert.equal(after.ok && after.data.anonymous, true);
    assert.notEqual(after.ok && after.data.userId, before.ok && before.data.userId);
  });
});
