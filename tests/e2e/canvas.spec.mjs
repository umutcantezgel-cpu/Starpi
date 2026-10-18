// The canvas, compare and the council in the browser under the production headers, against the
// local provider fakes and mocked providers: a code block of an answer opens in the canvas, a later
// revision of it becomes version 2, an AI edit of a selection version 3 (as a new chat turn), older
// versions show again, the preview runs in the render frame and the document is there after a
// reload; one question to two models of the own server side by side, "Continue with this" as the
// newest branch; the council in the conversation with three providers and a labelled answer; all
// without a page error and with the panels passing axe.
import AxeBuilder from '@axe-core/playwright';
import { expect, mockSupabase, test } from './fixtures.mjs';

const FAKES = Number(process.env.STARPI_FAKES_PORT || 4610);
/** The OpenAI-compatible fake as an Ollama server (no key, reasoning in <think> tags). */
const SERVER = `http://127.0.0.1:${FAKES + 1}/flavor/ollama/v1`;
const ANTHROPIC_FAKE = `http://127.0.0.1:${FAKES + 2}`;

const PAGE_V1 = ['<!doctype html>', '<h1 id="t">Welcome to the page</h1>', '<p>Body text.</p>', '<script>document.getElementById("t").textContent = "Ran";</script>'].join('\n');
const PAGE_V2 = PAGE_V1.replace('<p>Body text.</p>', '<p>Body text, now blue.</p>');
/** @param {string} page */
const reply = (page) => `Here is the page:\n\n\`\`\`html title="Landing page"\n${page}\n\`\`\``;

/**
 * Answers OpenRouter chat requests (with a key for this tab) by the question: `answer(lastUserText)`.
 * The app's own tasks (titles, a council's judge) are refused, so the replies stay predictable.
 * @param {import('@playwright/test').Page} page
 * @param {(question: string) => string} answer
 */
async function mockOpenRouter(page, answer) {
  // Init scripts run in every frame; the sandboxed ones have no storage.
  await page.addInitScript(() => {
    if (self.origin !== 'null') sessionStorage.setItem('starpi_openrouter_key', 'test-key');
  });
  /** @type {any[]} */
  const bodies = [];
  await page.route('https://openrouter.ai/**', async (route) => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = JSON.parse(route.request().postData() ?? '{}');
    if (JSON.stringify(body.messages ?? []).includes('starpi-purpose')) return route.fulfill({ status: 400, contentType: 'application/json', headers, body: '{"error":{"message":"no"}}' });
    bodies.push(body);
    const last = [...(body.messages ?? [])].reverse().find((/** @type {any} */ m) => m.role === 'user');
    const text = typeof last?.content === 'string' ? last.content : (last?.content ?? []).map((/** @type {any} */ p) => p.text ?? '').join('');
    return route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify({ choices: [{ message: { content: answer(text) }, finish_reason: 'stop' }] }) });
  });
  return bodies;
}

/**
 * Sends Anthropic calls of the page to the Anthropic fake.
 * @param {import('@playwright/test').Page} page
 */
async function routeAnthropic(page) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-expose-headers': 'request-id' };
  await page.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = new URL(req.url());
    const res = await route.fetch({ url: `${ANTHROPIC_FAKE}${url.pathname}${url.search}` });
    return route.fulfill({ response: res, headers: { ...res.headers(), ...cors } });
  });
}

/** @param {import('@playwright/test').Page} page */
const answers = (page) => page.locator('#chatMessages .message-row[data-role="assistant"]');

/** @param {import('@playwright/test').Page} page @param {string} text */
async function ask(page, text) {
  await page.fill('#chatInput', text);
  await page.press('#chatInput', 'Enter');
}

/**
 * Waits until the newest answer is stored and finished.
 * @param {import('@playwright/test').Page} page
 */
async function settled(page) {
  await expect(page.locator('#stopBtn')).toBeHidden();
  await expect(answers(page).last()).toHaveAttribute('data-node-id', /.+/);
  await expect(answers(page).last().locator('[data-action="msg-copy"]')).toBeVisible();
}

/**
 * Removes the diagnostics a test provoked on purpose and returns them.
 * @param {string[]} diagnostics
 * @param {RegExp[]} expected
 */
function takeExpected(diagnostics, expected) {
  const taken = diagnostics.filter((d) => expected.some((re) => re.test(d)));
  diagnostics.splice(0, diagnostics.length, ...diagnostics.filter((d) => !taken.includes(d)));
  return taken;
}

// Playwright's own init script for serviceWorkers: 'block' reads navigator.serviceWorker in every
// frame, which a sandboxed frame refuses; that error is the harness's, not the app's.
test.afterEach(({ diagnostics }) => {
  takeExpected(diagnostics, [/^pageerror: Failed to read the 'serviceWorker' property from 'Navigator': .*sandboxed/]);
});

test.describe('canvas', () => {
  test('opens a block, keeps model revisions and an AI edit as versions, previews and survives a reload', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const bodies = await mockOpenRouter(page, (q) => (/in the canvas: say hello/.test(q) ? 'Sure:\n\n```html\nHello there\n```' : /blue/.test(q) ? reply(PAGE_V2) : reply(PAGE_V1)));
    await page.goto('/');
    await page.click('[data-action="set-chat-mode"][data-arg="free"]');
    await ask(page, 'Build a landing page');
    await settled(page);
    const first = answers(page).last();
    await first.locator('[data-action="canvas-code"]').click();
    const aside = page.locator('#chat-aside');
    await expect(aside).toBeVisible();
    await expect(page.locator('#chat-aside-tab-canvas')).toHaveAttribute('aria-selected', 'true');
    const canvas = page.locator('#chat-aside-canvas');
    await expect(canvas.locator('[data-canvas-title]')).toHaveText('Landing page');
    const editor = canvas.locator('[data-canvas-editor]');
    await expect(editor).toHaveValue(PAGE_V1);
    await expect(canvas.locator('[data-canvas-versions] option')).toHaveCount(1);

    // A later answer revises the page: it becomes version 2 of the same document.
    await ask(page, 'Make the body blue');
    await settled(page);
    await answers(page).last().locator('[data-action="canvas-code"]').click();
    await expect(canvas.locator('[data-canvas-versions] option')).toHaveCount(2);
    await expect(editor).toHaveValue(PAGE_V2);
    await expect(canvas.locator('[data-canvas-status]')).toContainText('Added as version 2 of "Landing page"');

    // Edit with AI: the selection and the instruction become a new turn; the answer replaces the selection.
    const turns = await answers(page).count();
    await editor.evaluate((el) => {
      const area = /** @type {HTMLTextAreaElement} */ (el);
      const start = area.value.indexOf('Welcome to the page');
      area.focus();
      area.setSelectionRange(start, start + 'Welcome to the page'.length);
      area.dispatchEvent(new Event('select', { bubbles: true }));
    });
    await expect(canvas.locator('[data-canvas-selection]')).toContainText('19 selected characters');
    await canvas.locator('[data-canvas-instruction]').fill('say hello');
    await canvas.locator('[data-canvas-ai-run]').click();
    await expect(canvas.locator('[data-canvas-versions] option')).toHaveCount(3);
    await expect(editor).toHaveValue(PAGE_V2.replace('Welcome to the page', 'Hello there'));
    await expect(canvas.locator('[data-canvas-versions] option').nth(2)).toContainText('AI edit');
    await expect(answers(page)).toHaveCount(turns + 1);
    const editTurn = bodies.at(-1);
    expect(JSON.stringify(editTurn.messages.at(-1))).toContain('<<<PASSAGE>>>Welcome to the page<<<END PASSAGE>>>');

    // Older versions show again; the preview runs in the render frame, scripts only on request.
    await canvas.locator('[data-canvas-versions]').selectOption('0');
    await expect(editor).toHaveValue(PAGE_V1);
    await canvas.locator('[data-action="canvas-preview"]').click();
    await expect.poll(() => page.frames().some((f) => f.url().endsWith('/render-frame'))).toBe(true);
    const frame = /** @type {import('@playwright/test').Frame} */ (page.frames().find((f) => f.url().endsWith('/render-frame')));
    await expect(frame.locator('#t')).toHaveText('Welcome to the page');
    await canvas.locator('[data-action="canvas-run-preview"]').click();
    await expect(frame.locator('#t')).toHaveText('Ran');
    await canvas.locator('[data-action="canvas-mode"][data-arg="read"]').click();
    await expect(canvas.locator('[data-canvas-read] code.hljs')).toBeVisible();

    const results = await new AxeBuilder({ page }).include('#chat-aside').exclude('iframe').analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);

    // The document and its versions are kept on this device.
    await page.reload();
    await page.click('[data-action="toggle-chat-aside"]');
    await page.click('#chat-aside-tab-canvas');
    await expect(page.locator('#chat-aside-canvas [data-canvas-title]')).toHaveText('Landing page');
    await expect(page.locator('#chat-aside-canvas [data-canvas-versions] option')).toHaveCount(3);
  });
});

test.describe('compare and council', () => {
  test('compares two models of the own server side by side and continues with one', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.addInitScript((url) => {
      if (sessionStorage.getItem('e2e_seeded')) return;
      sessionStorage.setItem('e2e_seeded', '1');
      localStorage.setItem('starpi_llm_url', url);
      localStorage.setItem('starpi_assistant_v1', 'local:*');
      localStorage.setItem('starpi_chat_mode', 'free');
    }, SERVER);
    await page.goto('/');
    await ask(page, 'Name a colour');
    await settled(page);
    await answers(page).last().locator('[data-action="msg-extra"][data-extra="compare"]').click();
    await expect(page.locator('#chat-aside-tab-compare')).toHaveAttribute('aria-selected', 'true');
    const panel = page.locator('#chat-aside-compare');
    await expect(panel.locator('[data-compare-question]')).toHaveValue('Name a colour');
    await expect(panel.locator('[data-compare-model]')).toHaveCount(2);
    await panel.locator('[data-compare-run]').click();
    const columns = panel.locator('[data-column]');
    await expect(columns).toHaveCount(2);
    await expect(columns.nth(0)).toHaveAttribute('data-status', 'done');
    await expect(columns.nth(1)).toHaveAttribute('data-status', 'done');
    for (const i of [0, 1]) {
      await expect(columns.nth(i).locator('[data-column-body]')).toContainText('simulated answer from the local test provider');
      await expect(columns.nth(i).locator('.free-note')).toBeVisible();
      await expect(columns.nth(i).locator('[data-column-stats]')).toContainText('No cost: your own server');
    }
    await expect(columns.nth(1).locator('[data-column-model]')).toContainText('fake-local-reasoner:4b');
    const results = await new AxeBuilder({ page }).include('#chat-aside').analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);

    await columns.nth(1).locator('[data-action="compare-continue"]').click();
    await expect(columns.nth(1)).toContainText('In the chat as the newest branch');
    const newest = answers(page).last();
    await expect(newest.locator('.engine-badge-label')).toHaveText('Your server · fake-local-reasoner:4b');
    await expect(newest.locator('.branch-pos')).toHaveText('2/2');
    await expect(newest.locator('[data-compared]')).toContainText('Chosen in a comparison of 2 models');
  });

  test('asks the council with three providers and keeps its labelled answer', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await routeAnthropic(page);
    await mockOpenRouter(page, () => 'Blue is calm.');
    await page.addInitScript((url) => {
      if (self.origin === 'null' || sessionStorage.getItem('e2e_seeded')) return;
      sessionStorage.setItem('e2e_seeded', '1');
      sessionStorage.setItem('starpi_key_anthropic', 'sk-ant-e2e0123456789abcdefghijklmnop');
      localStorage.setItem('starpi_llm_url', url);
      localStorage.setItem('starpi_assistant_v1', 'local:*');
      localStorage.setItem('starpi_chat_mode', 'free');
    }, SERVER);
    await page.goto('/');
    await ask(page, 'Which colour is calm?');
    await settled(page);
    await answers(page).last().locator('[data-action="msg-extra"][data-extra="council"]').click();
    await expect(page.locator('#chatMessages .council-row')).toBeVisible();
    await expect(page.locator('#chatMessages .council-row [data-member]')).toHaveCount(3);
    // The result is stored as the newest branch with how the council decided.
    const newest = answers(page).last();
    await expect(newest.locator('[data-council-label]')).toContainText('Council · ');
    await expect(page.locator('#chatMessages .council-row')).toHaveCount(0);
    await expect(newest.locator('.branch-pos')).toHaveText('2/2');
    await newest.locator('[data-council-label] > details > summary').click();
    await expect(newest.locator('[data-council-details] [data-member]')).toHaveCount(3);
    const providers = await newest.locator('[data-council-details] [data-member] p.break-all .font-semibold').allTextContents();
    expect(new Set(providers.map((p) => p.trim())).size).toBe(3);
    const results = await new AxeBuilder({ page }).include('#chatMessages').analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});
