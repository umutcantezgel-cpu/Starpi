// Settings → Model providers and keys in the running app: plaintext keys a 2.x browser remembered move
// into the tab, a vault passphrase keeps keys encrypted in IndexedDB (WebCrypto in a real browser),
// a reload finds the vault locked and the passphrase opens it again.
import { expect, mockSupabase, test } from './fixtures.mjs';

const GEMINI = 'AIzaSyA-e2e-legacy-key-0123456789abcdefgh';
const GROQ = 'gsk_e2evaultkey0123456789abcdefghij';
const PASSPHRASE = 'correct horse battery staple';

/** @param {import('@playwright/test').Page} page */
async function openSettings(page) {
  const mobile = (page.viewportSize()?.width ?? 1280) < 768;
  await page.click(mobile ? '#mobile-nav-settings' : '#nav-settings');
  await expect(page.locator('#providerSettings')).toContainText('Model providers and keys');
}

/** @param {import('@playwright/test').Page} page @param {string} id */
const status = (page, id) => page.locator(`[data-pv-status="${id}"]`);

test.describe('providers and keys', () => {
  test('moves remembered keys out of plaintext and keeps vault keys across a reload', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.addInitScript(
      ([key]) => {
        // Once per tab: the 2.x state with "remember keys" ticked.
        if (sessionStorage.getItem('e2e_seeded')) return;
        sessionStorage.setItem('e2e_seeded', '1');
        localStorage.setItem('starpi_gemini_key', key);
        localStorage.setItem('starpi_remember_keys', '1');
      },
      [GEMINI],
    );
    await page.goto('/');
    await openSettings(page);

    await expect(page.locator('#providerSettings')).toContainText('were moved');
    await expect(status(page, 'gemini')).toContainText('Key for this tab (••••efgh)');
    expect(await page.evaluate(() => [localStorage.getItem('starpi_gemini_key'), localStorage.getItem('starpi_remember_keys'), sessionStorage.getItem('starpi_gemini_key')])).toEqual([null, null, GEMINI]);

    // A passphrase creates the vault; the tab's keys move into it.
    await page.fill('#pvPassphrase', PASSPHRASE);
    await page.click('[data-action="providers-unlock"]');
    await expect(page.locator('[data-vault-state]')).toHaveAttribute('data-vault-state', 'unlocked');
    await expect(page.locator('#providerSettings')).not.toContainText('were moved');
    await expect(status(page, 'gemini')).toContainText('Key in the vault');

    await page.click('details[data-provider="groq"] > summary');
    await page.fill('#pvKey-groq', GROQ);
    await page.check('#pvRemember-groq');
    await page.click('[data-action="providers-save-key"][data-arg="groq"]');
    await expect(status(page, 'groq')).toContainText('Key in the vault (••••ghij)');

    // Only ciphertext reaches IndexedDB, and nothing is left in plaintext storage.
    const stored = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open('starpi');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const get = open.result.transaction('keyvault').objectStore('keyvault').get('vault');
            get.onsuccess = () => {
              const r = get.result;
              resolve({ v: r.v, iterations: r.kdf.iterations, salt: r.salt.length, iv: r.iv.length, text: new TextDecoder().decode(r.ct), session: JSON.stringify(sessionStorage), local: JSON.stringify(localStorage) });
              open.result.close();
            };
          };
        }),
    );
    const record = /** @type {{ v: number, iterations: number, salt: number, iv: number, text: string, session: string, local: string }} */ (stored);
    expect([record.v, record.iterations, record.salt, record.iv]).toEqual([1, 600000, 16, 12]);
    for (const text of [record.text, record.session, record.local]) {
      expect(text).not.toContain(GROQ);
      expect(text).not.toContain(GEMINI);
    }

    // A reload finds the vault locked; the passphrase opens it.
    await page.reload();
    await openSettings(page);
    await expect(page.locator('[data-vault-state]')).toHaveAttribute('data-vault-state', 'locked');
    await expect(status(page, 'groq').locator('[data-key]')).toHaveAttribute('data-key', 'none');
    await page.fill('#pvPassphrase', 'wrong passphrase');
    await page.click('[data-action="providers-unlock"]');
    await expect(page.locator('[data-pv="vault-result"]')).toContainText('does not open the vault');
    await page.fill('#pvPassphrase', PASSPHRASE);
    await page.click('[data-action="providers-unlock"]');
    await expect(status(page, 'groq')).toContainText('Key in the vault (••••ghij)');
    await expect(status(page, 'gemini')).toContainText('Key in the vault (••••efgh)');

    await page.click('[data-action="providers-lock"]');
    await expect(page.locator('[data-vault-state]')).toHaveAttribute('data-vault-state', 'locked');
    expect(diagnostics).toEqual([]);
  });
});
