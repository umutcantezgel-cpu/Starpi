// End-to-end smoke of the encrypted chat sync against a mocked Supabase project: Settings › Chat
// sync turns sync on with a passphrase and sends only ciphertext; a second browser reaches the same
// account with an email code and restores the conversation with the passphrase; turning off with
// deletion removes the key first and then the rows.
import { expect, mockSupabase, storedChatText, test } from './fixtures.mjs';

const PASSPHRASE = 'a passphrase for the smoke test';
const QUESTION = 'Wann ist der Launch von Projekt Beta?';
const EMAIL = 'reader@example.org';
const CODE = '135790';

/** A Supabase account store shared by the browser contexts of one test. */
function project() {
  /** @type {Map<string, { id: string, email: string | null, pending: string | null }>} */
  const users = new Map();
  /** @type {Map<string, string>} */
  const tokens = new Map();
  /** @type {Array<Record<string, any>>} */
  let rows = [];
  /** @type {Array<Record<string, any>>} */
  let keys = [];
  /** @type {Array<{ method: string, path: string, query: string, body: string }>} */
  const calls = [];
  let seq = 0;

  /** @param {{ id: string, email: string | null }} user */
  const userJson = (user) => ({ id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email ?? '', is_anonymous: !user.email, app_metadata: {}, user_metadata: {}, created_at: '2026-10-18T00:00:00Z' });
  /** @param {{ id: string, email: string | null }} user */
  function session(user) {
    seq += 1;
    const token = `token-${seq}-${user.id}`;
    tokens.set(token, user.id);
    const now = Math.floor(Date.now() / 1000);
    return { access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: `refresh-${seq}`, user: userJson(user) };
  }

  /**
   * Routes the auth and chat sync requests of a page; everything else goes to mockSupabase.
   * @param {import('@playwright/test').Page} page
   */
  async function attach(page) {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.route(/^https:\/\/[a-z0-9]+\.supabase\.co\/(auth\/v1\/(signup|user|otp|verify|logout)|rest\/v1\/chat_sync)/, async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fallback();
      const url = new URL(req.url());
      const body = req.postData() ?? '';
      calls.push({ method: req.method(), path: url.pathname, query: url.search, body });
      const data = body ? JSON.parse(body) : null;
      const uid = tokens.get((req.headers().authorization ?? '').replace(/^Bearer /, '')) ?? null;
      const json = (/** @type {number} */ status, /** @type {unknown} */ out) =>
        route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: out === undefined ? '' : JSON.stringify(out) });
      const p = url.pathname;
      if (p === '/auth/v1/signup') {
        const user = { id: crypto.randomUUID(), email: null, pending: null };
        users.set(user.id, user);
        return json(200, session(user));
      }
      if (p === '/auth/v1/user' && req.method() === 'PUT') {
        const user = uid ? users.get(uid) : undefined;
        if (!user) return json(401, { code: 401, error_code: 'no_authorization', msg: 'No session' });
        user.pending = data.email;
        return json(200, userJson(user));
      }
      if (p === '/auth/v1/otp') return [...users.values()].some((u) => u.email === data.email) ? json(200, {}) : json(422, { code: 422, error_code: 'otp_disabled', msg: 'Signups not allowed for otp' });
      if (p === '/auth/v1/verify') {
        const user = [...users.values()].find((u) => (data.type === 'email_change' ? u.pending === data.email : u.email === data.email));
        if (!user || data.token !== CODE) return json(403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
        if (data.type === 'email_change') {
          user.email = user.pending;
          user.pending = null;
        }
        return json(200, session(user));
      }
      if (p === '/auth/v1/logout') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      if (!uid) return json(401, { code: '42501', message: 'permission denied' });
      const eq = (/** @type {string} */ col) => url.searchParams.get(col)?.replace(/^eq\./, '');
      const own = (/** @type {Record<string, any>} */ r) => r.user_id === uid;
      const select = (url.searchParams.get('select') ?? '').split(',').filter(Boolean);
      const pick = (/** @type {Record<string, any>} */ r) => (select.length ? Object.fromEntries(select.map((c) => [c, r[c]])) : r);
      if (p === '/rest/v1/chat_sync_keys') {
        if (req.method() === 'GET') return json(200, keys.filter(own).map(pick));
        if (req.method() === 'POST') {
          if (keys.some(own)) return json(409, { code: '23505', message: 'duplicate key' });
          keys.push({ ...data, user_id: uid });
          return json(201, undefined);
        }
        if (req.method() === 'DELETE') {
          keys = keys.filter((k) => !own(k));
          return json(204, undefined);
        }
      }
      if (p === '/rest/v1/chat_sync') {
        if (req.method() === 'GET') {
          const ids = url.searchParams.get('conv_id');
          const wanted = ids?.startsWith('in.(') ? new Set(ids.slice(4, -1).split(',').map((v) => v.replace(/^"|"$/g, ''))) : null;
          return json(200, rows.filter((r) => own(r) && (!wanted || wanted.has(r.conv_id))).map(pick));
        }
        if (req.method() === 'POST') {
          if (rows.some((r) => own(r) && r.conv_id === data.conv_id)) return json(409, { code: '23505', message: 'duplicate key' });
          rows.push({ ...data, user_id: uid });
          return json(201, undefined);
        }
        if (req.method() === 'PATCH') {
          const hit = rows.filter((r) => own(r) && r.conv_id === eq('conv_id') && String(r.rev) === eq('rev'));
          for (const r of hit) Object.assign(r, data);
          return json(200, hit.map(pick));
        }
        if (req.method() === 'DELETE') {
          rows = rows.filter((r) => !own(r));
          return json(204, undefined);
        }
      }
      return route.fallback();
    });
  }

  return {
    attach,
    calls,
    get rows() {
      return rows;
    },
    get keys() {
      return keys;
    },
  };
}

/** @param {import('@playwright/test').Page} page */
async function openSettings(page) {
  await page.click('#nav-settings');
  await expect(page.locator('#tab-settings')).toBeVisible();
  const card = page.locator('#syncSettings [data-sv-root]');
  await expect(card).toBeVisible();
  return card;
}

test.describe('encrypted chat sync', () => {
  test('turns on with a passphrase, sends only ciphertext and restores in a second browser', async ({ page, browser, diagnostics }) => {
    test.skip((page.viewportSize()?.width ?? 1280) < 768, 'desktop layout');
    const supabase = project();
    await supabase.attach(page);
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto('/');
    await page.fill('#chatInput', QUESTION);
    await page.press('#chatInput', 'Enter');
    await expect(page.locator('#chatMessages > div').last()).toContainText('3. März geplant');

    const card = await openSettings(page);
    await expect(card.locator('[data-sync-state]')).toHaveAttribute('data-sync-state', 'off');
    await expect(page.locator('#chatSyncStatusText')).toContainText('This device only');
    await card.locator('#svPass').fill(PASSPHRASE);
    await card.locator('#svPass2').fill(PASSPHRASE);
    await card.locator('[data-action="sync-enable"]').click();
    await expect(card.locator('[data-sv="result"]')).toContainText('Sync is on', { timeout: 20_000 });
    await expect(card.locator('[data-sync-state]')).toHaveAttribute('data-sync-state', 'on');
    await expect(card.locator('[data-sv="count"]')).toContainText('1 conversations synced');
    await expect(page.locator('#chatSyncStatusText')).toContainText('End-to-end encrypted');
    expect(supabase.rows).toHaveLength(1);
    expect(Object.keys(supabase.rows[0]).sort()).toEqual(['ciphertext', 'conv_id', 'iv', 'rev', 'user_id']);
    expect(supabase.rows[0].conv_id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(supabase.keys[0].iterations).toBe(600000);

    // Add an email address to this browser's account.
    await card.locator('[data-sv="account"] summary').click();
    await card.locator('#svEmail').fill(EMAIL);
    await card.locator('[data-action="sync-email-link"]').click();
    await expect(card.locator('[data-sv="result"]')).toContainText(`sent a code to ${EMAIL}`);
    await card.locator('#svCode').fill(CODE);
    await card.locator('[data-action="sync-email-verify"]').click();
    await expect(card.locator('[data-sv="who"]')).toContainText(`Signed in as ${EMAIL}`);

    // A second browser signs in with the address and unlocks with the passphrase.
    const other = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    const page2 = await other.newPage();
    await supabase.attach(page2);
    await page2.goto('/');
    const card2 = await openSettings(page2);
    await card2.locator('[data-sv="account"] summary').click();
    await card2.locator('#svEmail').fill(EMAIL);
    await card2.locator('[data-action="sync-email-signin"]').click();
    await card2.locator('#svCode').fill(CODE);
    await card2.locator('[data-action="sync-email-verify"]').click();
    await expect(card2.locator('[data-sv="result"]')).toContainText('Enter your passphrase');
    await expect(card2.locator('[data-sv-form]')).toHaveAttribute('data-sv-form', 'join');
    await card2.locator('#svPass').fill(PASSPHRASE);
    await card2.locator('[data-action="sync-enable"]').click();
    await expect(card2.locator('[data-sv="result"]')).toContainText('Unlocked', { timeout: 20_000 });
    await expect.poll(() => storedChatText(page2)).toContain(QUESTION);
    await other.close();

    // Nothing readable went to the server, and never to the plaintext table.
    for (const call of supabase.calls) {
      expect(`${call.path}${call.query} ${call.body}`).not.toContain('Projekt Beta');
      expect(call.body).not.toContain(PASSPHRASE);
      expect(call.body).not.toContain('starpi_');
      expect(call.path).not.toContain('chat_history');
    }

    // Turn off and delete: the key goes first, then the rows.
    await card.locator('[data-action="sync-off-delete"]').click();
    await expect(card.locator('[data-sv="result"]')).toContainText('synced copy was deleted');
    const deletes = supabase.calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
    expect(deletes).toEqual(['/rest/v1/chat_sync_keys', '/rest/v1/chat_sync']);
    expect(supabase.rows).toHaveLength(0);
    await expect(page.locator('#chatSyncStatusText')).toContainText('This device only');
    expect(diagnostics).toEqual([]);
  });
});
