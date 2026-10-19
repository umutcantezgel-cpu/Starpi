// The app with the local companion (packages/companion), started for this file on its own loopback
// port with throwaway folders: Mode A (the companion serves a build of the profile `companion` and
// pairs it with a cookie and a CSRF value), Mode B (the app on its own origin probes the companion
// only when asked, pairs with a token kept sealed in IndexedDB, and unpairs), the companion's
// documents, notes and agenda in the Companion tab, the red audit rollback banner when the
// highest head this browser stored is newer than the one the companion reports (and none when an
// honest answer only arrives with an older head), and the companion as a model of the chat: offered
// by the picker once paired, its answer shown with its own label and kept out of the router's cache.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, mockSupabase, storedChatNodes, test } from './fixtures.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APP_PORT = Number(process.env.STARPI_E2E_PORT || 4173);
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
// Its own port, next to the app's, so several checkouts can run the suite side by side.
const COMPANION_PORT = Number(process.env.STARPI_COMPANION_E2E_PORT || APP_PORT + 317);
const COMPANION = `http://127.0.0.1:${COMPANION_PORT}`;
const CLI = path.join(ROOT, 'packages/companion/bin/starpi-companion.mjs');

test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => isMobile, 'pairing and the Companion tab are checked on desktop');

/** @type {string} */
let dir = '';
/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
let output = '';

const companionEnv = () => ({
  ...process.env,
  STARPI_COMPANION_CONFIG: path.join(dir, 'config', 'config.json'),
  STARPI_COMPANION_DATA_DIR: path.join(dir, 'data'),
  STARPI_COMPANION_ANCHOR_DIR: path.join(dir, 'anchors'),
});

/** A fresh one-time pairing code from the companion's command line. */
function pairingCode() {
  return JSON.parse(execFileSync(process.execPath, [CLI, 'pair', '--json'], { env: companionEnv(), encoding: 'utf8' })).code;
}

test.beforeAll(async () => {
  // Building the companion's app takes a while.
  test.setTimeout(300_000);
  dir = mkdtempSync(path.join(tmpdir(), 'starpi-companion-e2e-'));
  for (const sub of ['config', 'data', 'anchors']) mkdirSync(path.join(dir, sub));
  // The companion imports the built @starpi/core.
  try {
    createRequire(path.join(ROOT, 'packages/companion/package.json')).resolve('@starpi/core');
  } catch {
    execFileSync(process.execPath, ['scripts/build-core.mjs', '--no-types'], { cwd: ROOT, stdio: 'pipe' });
  }
  // The app build the companion serves (Mode A), in a folder of its own.
  const appDir = path.join(dir, 'app');
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: ROOT, env: { ...process.env, STARPI_HEADER_PROFILE: 'companion', STARPI_DIST_DIR: appDir }, stdio: 'pipe' });
  writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify({ port: COMPANION_PORT, allowedOrigins: [APP_ORIGIN] }));
  child = spawn(process.execPath, [CLI, 'start', '--app-dir', appDir], { cwd: ROOT, env: companionEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (b) => (output += b));
  child.stderr?.on('data', (b) => (output += b));
  const deadline = Date.now() + 30_000;
  for (;;) {
    const ok = await fetch(`${COMPANION}/v1/hello`).then((r) => r.ok, () => false);
    if (ok) break;
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`the companion did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 200));
  }
});

test.afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 5000))]);
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/**
 * Page errors, CSP violations and console errors, except the expected ones: missing /api routes
 * (4xx). A companion build reaches for nothing its CSP refuses (it never loads the library).
 * @param {import('@playwright/test').Page} page
 * @param {{ ignore?: RegExp }} [opts]
 */
async function watchProblems(page, opts = {}) {
  /** @type {string[]} */
  const problems = [];
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP_VIOLATION ${e.violatedDirective} ${e.blockedURI}`));
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/^Failed to load resource: the server responded with a status of 4\d\d/.test(text)) return;
    if (opts.ignore?.test(text)) return;
    problems.push(`console.error: ${text}`);
  });
  return problems;
}

/**
 * No serious or critical axe violation in the Companion tab.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function axe(page, name) {
  const results = await new AxeBuilder({ page }).include('#tab-companion').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${name}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

/**
 * The link stored in IndexedDB (database starpi-companion).
 * @param {import('@playwright/test').Page} page
 */
function storedLink(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('starpi-companion');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const get = db.transaction('link').objectStore('link').get('current');
          get.onsuccess = () => {
            db.close();
            resolve(get.result ?? null);
          };
        };
      }),
  );
}

/**
 * Pairs the app on its own origin (Mode B) through Settings → Companion.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ token: string }>}
 */
async function pairHosted(page) {
  await page.click('#nav-settings');
  await page.click('[data-companion-connect] summary');
  await page.fill('#companionSettingsOrigin', COMPANION);
  await page.locator('#companionSettingsOrigin').dispatchEvent('change');
  await expect(page.locator('[data-companion-probe]')).toContainText('answers at');
  await page.fill('#companionSettingsCode', pairingCode());
  const answer = page.waitForResponse((r) => r.url() === `${COMPANION}/v1/session/pair`);
  await page.click('#companionSettings [data-action="companion-pair"]');
  const body = await (await answer).json();
  await expect(page.locator('#companionSettings [data-action="companion-unpair"]')).toBeVisible();
  return { token: body.token };
}

test('Mode A: the companion serves its build, pairs it with a cookie, and shows documents, notes and agenda', async ({ page, context }) => {
  const problems = await watchProblems(page);
  page.on('dialog', (d) => d.accept());
  const response = await page.goto(`${COMPANION}/`);
  expect(response?.headers()['content-security-policy']).toContain("connect-src 'self' data:");
  expect(response?.headers()['cross-origin-embedder-policy']).toBe('require-corp');
  // The companion's own build always offers the Companion tab; it asks for the code there.
  await expect(page.locator('#nav-companion')).toBeVisible();
  await page.click('#nav-companion');
  await page.fill('#companionTabCode', pairingCode());
  await page.click('#tab-companion [data-action="companion-pair"]');
  await expect(page.locator('#tab-companion')).toContainText('Paired · served by the companion');
  await expect(page.locator('#tab-companion')).toContainText('Audit ok');
  await expect(page.locator('[data-cv="page"]')).toContainText(/\d+\.\d+\.\d+/);

  const cookie = (await context.cookies(COMPANION)).find((c) => c.name === `starpi_companion_${COMPANION_PORT}`);
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');
  const link = /** @type {any} */ (await storedLink(page));
  expect(link.mode).toBe('cookie');
  expect(Object.keys(link).sort()).toEqual(['expiresAt', 'id', 'keyId', 'mode', 'origin', 'pairedAt', 'publicKey', 'role', 'secret', 'session']);
  expect(Object.keys(link.secret).sort()).toEqual(['data', 'iv']);

  await page.click('[data-action="companion-page"][data-arg="documents"]');
  await page.setInputFiles('[data-change="companion-doc-upload"]', { name: 'room-guide.txt', mimeType: 'text/plain', buffer: Buffer.from('The meeting room holds twelve people. The projector was replaced in March.') });
  await expect(page.locator('[data-companion-list="documents"]')).toContainText('room-guide.txt');

  await page.click('[data-action="companion-page"][data-arg="notes"]');
  await page.fill('#companionNoteTitle', 'Parking');
  await page.fill('#companionNoteText', 'Visitors park on level two.');
  await page.click('[data-action="companion-note-add"]');
  await expect(page.locator('[data-companion-list="notes"]')).toContainText('Parking');
  await page.click('[data-action="companion-note-open"]');
  await expect(page.locator('[data-note-text]')).toHaveText('Visitors park on level two.');

  await page.click('[data-action="companion-page"][data-arg="agenda"]');
  await page.fill('#companionAgendaTitle', 'Water the plants');
  await page.selectOption('#companionAgendaRule', 'weekly');
  await page.check('[data-companion-weekday="1"]');
  await page.check('[data-companion-weekday="4"]');
  await page.click('[data-action="companion-agenda-add"]');
  await expect(page.locator('[data-companion-list="agenda"]')).toContainText('Water the plants');
  await expect(page.locator('[data-companion-list="agenda"]')).toContainText('Mon, Thu at 09:00');
  expect(problems).toEqual([]);
});

test('Mode B: the app probes only when asked, pairs with a sealed token, reads the companion and unpairs', async ({ page }) => {
  await mockSupabase(page, { hardened: true, anonymousAuth: true });
  // The default address has no companion here: the first probe is refused by the network.
  const problems = await watchProblems(page, { ignore: /ERR_CONNECTION_REFUSED/ });
  page.on('dialog', (d) => d.accept());
  /** @type {string[]} */
  const asked = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.hostname === '127.0.0.1' && (url.port === '47821' || url.port === String(COMPANION_PORT))) asked.push(req.url());
  });
  await page.goto('/');
  await expect(page.locator('#nav-companion')).toBeHidden();
  await page.click('#nav-settings');
  await expect(page.locator('#companionSettings')).toContainText('Not paired');
  // Opening Settings asks nothing; opening "Connect the companion" does.
  expect(asked).toEqual([]);
  const { token } = await pairHosted(page);
  expect(asked.some((u) => u.endsWith('/v1/hello'))).toBe(true);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

  // The token is kept sealed: not in the stored link, not in web storage.
  const link = /** @type {any} */ (await storedLink(page));
  expect(link.mode).toBe('bearer');
  expect(JSON.stringify(link)).not.toContain(token);
  expect(await page.evaluate((tk) => JSON.stringify({ ...localStorage }).includes(tk) || JSON.stringify({ ...sessionStorage }).includes(tk), token)).toBe(false);

  await expect(page.locator('#nav-companion')).toBeVisible();
  await page.click('#nav-companion');
  await expect(page.locator('#tab-companion')).toContainText('Audit ok');
  await page.click('[data-action="companion-page"][data-arg="documents"]');
  await expect(page.locator('[data-companion-list="documents"]')).toContainText('room-guide.txt');
  await page.click('[data-action="companion-page"][data-arg="notes"]');
  await expect(page.locator('[data-companion-list="notes"]')).toContainText('Parking');
  await page.click('[data-action="companion-page"][data-arg="agenda"]');
  await expect(page.locator('[data-companion-list="agenda"]')).toContainText('Water the plants');
  await axe(page, 'agenda');

  // A reload keeps the pairing without asking the companion until the tab opens.
  asked.length = 0;
  await page.reload();
  await expect(page.locator('#nav-companion')).toBeVisible();
  expect(asked).toEqual([]);

  // Unpairing ends the session on the companion and forgets the link here.
  await page.click('#nav-settings');
  await page.click('#companionSettings [data-action="companion-unpair"]');
  await expect(page.locator('#companionSettings')).toContainText('Not paired');
  await expect(page.locator('#nav-companion')).toBeHidden();
  expect(await storedLink(page)).toBeNull();
  const after = await fetch(`${COMPANION}/v1/session`, { headers: { authorization: `Bearer ${token}` } });
  expect(after.status).toBe(401);
  expect(problems).toEqual([]);
});

test('shows the red audit rollback banner when this browser saw a newer head than the companion reports', async ({ page }) => {
  await mockSupabase(page, { hardened: true, anonymousAuth: true });
  const problems = await watchProblems(page, { ignore: /ERR_CONNECTION_REFUSED/ });
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await pairHosted(page);
  await page.click('#nav-companion');
  await expect(page.locator('#tab-companion')).toContainText('Audit ok');
  await expect(page.locator('[data-companion-banner]')).toHaveCount(0);

  // As if the companion's data had been put back to an older copy: this browser remembers a head
  // 100 records further on.
  const reported = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('starpi-companion');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('heads', 'readwrite');
          const store = tx.objectStore('heads');
          const all = store.getAll();
          all.onsuccess = () => {
            const head = all.result[0];
            store.put({ ...head, seq: head.seq + 100 });
            tx.oncomplete = () => {
              db.close();
              resolve(head.seq);
            };
          };
        };
      }),
  );
  await page.reload();
  await page.click('#nav-companion');
  const banner = page.locator('#tab-companion [data-companion-banner="rollback"]');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Audit rollback');
  await expect(banner).toContainText(`already saw record ${Number(reported) + 100}`);
  await expect(page.locator('#tab-companion')).toContainText('Audit rollback');
  await axe(page, 'rollback banner');
  // The Settings card carries it too, and checking again does not make it go away.
  await page.click('#nav-settings');
  await expect(page.locator('#companionSettings [data-companion-banner="rollback"]')).toBeVisible();
  await page.click('#companionSettings [data-action="companion-audit-check"]');
  await expect(page.locator('#companionSettings [data-companion-banner="rollback"]')).toBeVisible();
  // Accepting the companion's state on purpose (after a restore the user made) clears it.
  await page.click('#companionSettings [data-action="companion-audit-accept"]');
  await expect(page.locator('[data-companion-banner]')).toHaveCount(0);
  await page.click('#nav-companion');
  await expect(page.locator('#tab-companion')).toContainText('Audit ok');
  expect(problems).toEqual([]);
});

test('an honest answer that arrives with an older audit head raises no rollback banner', async ({ page }) => {
  await mockSupabase(page, { hardened: true, anonymousAuth: true });
  const problems = await watchProblems(page, { ignore: /ERR_CONNECTION_REFUSED/ });
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  const { token } = await pairHosted(page);
  await page.click('#nav-companion');
  await expect(page.locator('#tab-companion')).toContainText('Audit ok');

  // An older head of the companion's own chain, as an answer to a request sent before the newest
  // ones would carry it when it arrives last.
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const current = (await (await fetch(`${COMPANION}/v1/audit/head`, auth)).json()).head;
  expect(current.seq).toBeGreaterThan(1);
  const stale = (await (await fetch(`${COMPANION}/v1/audit/head?seq=${current.seq - 1}`, auth)).json()).head;
  await page.route(
    `${COMPANION}/v1/docs`,
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, headers: { ...response.headers(), 'x-companion-audit-head': `${stale.seq}.${stale.hash}.${stale.sig}` }, body: JSON.stringify({ ...body, auditHead: stale }) });
    },
    { times: 1 },
  );
  const lookedUp = page.waitForRequest((r) => r.url() === `${COMPANION}/v1/audit/head?seq=${stale.seq}`);
  await page.click('[data-action="companion-page"][data-arg="documents"]');
  // Before deciding, the browser asked the companion whether the older head is its own record.
  await lookedUp;
  await expect(page.locator('#tab-companion')).toContainText('Audit ok');
  await expect(page.locator('[data-companion-banner]')).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('the companion answers in the chat once paired: its own label, stored here, never in the router cache', async ({ page }) => {
  await mockSupabase(page, { hardened: true, anonymousAuth: true });
  const problems = await watchProblems(page, { ignore: /ERR_CONNECTION_REFUSED/ });
  page.on('dialog', (d) => d.accept());
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e_seeded')) return;
    sessionStorage.setItem('e2e_seeded', '1');
    localStorage.setItem('starpi_chat_mode', 'free');
  });
  await page.goto('/');
  // Before pairing the picker offers no companion, and no database was opened for it.
  await expect(page.locator('#engineSelector[data-ready="true"]')).toHaveCount(1);
  await expect(page.locator('#engineSelector option[value="companion:starpi-core"]')).toHaveCount(0);
  expect(await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))).not.toContain('starpi-companion');

  await pairHosted(page);
  await expect(page.locator('#engineSelector option[value="companion:starpi-core"]')).toHaveText('Starpi Core (local companion)');
  await page.click('#nav-chat');
  await page.selectOption('#engineSelector', 'companion:starpi-core');
  await expect(page.locator('#privacyNotice')).toContainText('Starpi Core on this computer');
  const asked = page.waitForRequest((r) => r.url() === `${COMPANION}/v1/chat` && r.method() === 'POST');
  await page.fill('#chatInput', 'Where is the spare key?');
  await page.press('#chatInput', 'Enter');
  expect(JSON.parse((await asked).postData() ?? '{}')).toEqual({ question: 'Where is the spare key?', mode: 'free' });

  // The companion has no model here, so its template answers: shown as released, with its label.
  const answer = page.locator('#chatMessages .message-row[data-role="assistant"]').last();
  await expect(answer.locator('.answer-label[data-answer-label="companion_template"]')).toContainText('Template answer, no model wrote it');
  await expect(answer.locator('[data-companion-notice="no_model"]')).toContainText('No language model is configured in the companion');
  await expect(answer.locator('.message-content')).toContainText('No language model is configured');
  await expect(answer.locator('.engine-badge-label')).toHaveText('Local companion · Starpi Core');
  await expect(page.locator('#stopBtn')).toBeHidden();

  // Kept in the conversation on this device like every answer, and nowhere in the router's cache.
  const nodes = /** @type {any[]} */ (await storedChatNodes(page));
  const stored = nodes.find((n) => n.role === 'assistant');
  expect(stored?.provider).toBe('companion');
  expect(stored?.localOnly).toBe(true);
  expect(stored?.meta?.answer_label).toBe('companion_template');
  const cache = await page.evaluate(() => localStorage.getItem('starpi_ai_cache_v1') ?? '[]');
  expect(cache).not.toContain('companion');
  expect(cache).not.toContain('No language model is configured');
  await page.reload();
  await expect(page.locator('#chatMessages .answer-label[data-answer-label="companion_template"]')).toHaveCount(1);
  expect(problems).toEqual([]);
});
