// The cloud base model in the running app, against the local provider fakes: with a MiniMax key of
// the tab, Auto answers the free chat with MiniMax M3.1 Flash ahead of another provider's key, the
// privacy notice names MiniMax, the thinking the model always does stays in the answer's details
// and never in its text, and thinking off asks for the low effort (never for none). Settings tests
// the key with one small chat request, as MiniMax offers no model list, and the own-server section
// says what a self-hosted MiniMax M3 build needs.
import { expect, mockSupabase, test } from './fixtures.mjs';

const FAKES = Number(process.env.STARPI_FAKES_PORT || 4610);
/** The OpenAI-compatible fake as MiniMax (it always streams reasoning_content). */
const MINIMAX_FAKE = `http://127.0.0.1:${FAKES + 1}/flavor/minimax`;
const ANTHROPIC_FAKE = `http://127.0.0.1:${FAKES + 2}`;
/** Built at run time, so no key-shaped literal is committed. */
const KEY = `mm-e2e-${'k'.repeat(32)}`;
const ANSWER = 'This is a simulated answer from the local test provider.';
const THINKING = 'I recall the key facts first';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-expose-headers': 'request-id, x-request-id' };

/**
 * Sends a provider's calls to a fake and records the request bodies.
 * @param {import('@playwright/test').Page} page
 * @param {string} host
 * @param {string} target
 */
async function routeProvider(page, host, target) {
  /** @type {any[]} */
  const bodies = [];
  await page.route(`https://${host}/**`, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url());
    if (req.method() === 'POST') bodies.push(JSON.parse(req.postData() ?? '{}'));
    const res = await route.fetch({ url: `${target}${url.pathname}${url.search}` });
    return route.fulfill({ response: res, headers: { ...res.headers(), ...CORS } });
  });
  return bodies;
}

/** @param {import('@playwright/test').Page} page */
const answers = (page) => page.locator('#chatMessages .message-row[data-role="assistant"]');

/**
 * Starts the page with a MiniMax key (and an Anthropic key) for this tab, Auto and the free chat.
 * @param {import('@playwright/test').Page} page
 */
async function seed(page) {
  await page.addInitScript(
    ([key]) => {
      if (sessionStorage.getItem('e2e_seeded')) return;
      sessionStorage.setItem('e2e_seeded', '1');
      sessionStorage.setItem('starpi_key_minimax', key);
      sessionStorage.setItem('starpi_key_anthropic', 'sk-ant-e2e0123456789abcdefghijklmnop');
      localStorage.setItem('starpi_chat_mode', 'free');
      localStorage.setItem('starpi_assistant_v1', 'auto');
    },
    [KEY],
  );
}

test.describe('the cloud base model', () => {
  test('answers Auto with MiniMax M3.1 Flash first, its thinking apart from the answer', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const minimax = await routeProvider(page, 'api.minimax.io', MINIMAX_FAKE);
    const anthropic = await routeProvider(page, 'api.anthropic.com', ANTHROPIC_FAKE);
    await seed(page);
    await page.goto('/');
    await expect(page.locator('#privacyNotice')).toContainText('MiniMax');

    await page.fill('#chatInput', 'Hello there, how are you today?');
    await page.press('#chatInput', 'Enter');
    await expect(page.locator('#stopBtn')).toBeHidden();
    const answer = answers(page).last();
    await expect(answer).toHaveAttribute('data-node-id', /.+/);
    await expect(answer.locator('.engine-badge-label')).toHaveText('MiniMax · MiniMax M3.1 Flash');
    await expect(answer.locator('.message-content')).toContainText(ANSWER);
    await expect(answer.locator('.message-content')).not.toContainText(THINKING);
    await expect(answer.locator('[data-answer-label="free"]')).toContainText('Free chat · not checked');
    await answer.locator('[data-action="toggle-thought"]').click();
    await expect(answer.locator('.thought-body')).toContainText(THINKING);

    // The chat call (not the title, a purpose of its own): the base model, thinking off as low.
    const chat = minimax.filter((b) => !JSON.stringify(b.messages ?? []).includes('starpi-purpose'));
    expect(chat.length).toBeGreaterThan(0);
    expect(chat[0].model).toBe('MiniMax-M3.1-Flash');
    expect(chat[0].reasoning_effort).toBe('low');
    expect(JSON.stringify(minimax)).not.toMatch(/"none"|disabled/);
    expect(anthropic.filter((b) => Array.isArray(b.messages))).toEqual([]);
  });

  test('tests the key without a model list and describes self-hosted MiniMax M3', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const minimax = await routeProvider(page, 'api.minimax.io', MINIMAX_FAKE);
    await routeProvider(page, 'api.anthropic.com', ANTHROPIC_FAKE);
    await seed(page);
    await page.goto('/');
    const mobile = (page.viewportSize()?.width ?? 1280) < 768;
    await page.click(mobile ? '#mobile-nav-settings' : '#nav-settings');
    await expect(page.locator('#providerSettings')).toContainText('Model providers and keys');
    await expect(page.locator('[data-pv-status="minimax"]')).toContainText('Key for this tab');
    await page.click('details[data-provider="minimax"] > summary');
    await page.click('[data-action="providers-test-key"][data-arg="minimax"]');
    await expect(page.locator('#providerSettings')).toContainText('The key works (direct from the browser).');
    const test = minimax.at(-1);
    expect(test.model).toBe('MiniMax-M3.1-Flash');
    expect(test.reasoning_effort).toBe('low');
    expect(test.max_tokens).toBeLessThanOrEqual(16);
    await expect(page.locator('#pvLocalLarge')).toContainText('about 160 GB of memory');
  });
});
