// The 3.0 chat thread against the local provider fakes (scripts/fakes): streaming from the user's
// own server (the first text within 1.5 s), Stop, a new chat started while an answer streams (the
// answer stays in its own chat), Continue after the length limit, regenerating
// with another model, editing a question into a new branch, copying, the chat title, the thread
// after a reload, images scaled down before they go to a model that sees, reading answers aloud
// (while streaming and with the speaker button), "Research this" on an answer, Auto answering free
// without files and grounded with one (the source check, a receipt, the file kept when the question
// is edited), all without a page error and with the thread passing axe.
import AxeBuilder from '@axe-core/playwright';
import { expect, mockSupabase, storedChatNodes, test } from './fixtures.mjs';

const FAKES = Number(process.env.STARPI_FAKES_PORT || 4610);
/** The OpenAI-compatible fake as an Ollama server (no key, reasoning in <think> tags). */
const SERVER = `http://127.0.0.1:${FAKES + 1}/flavor/ollama/v1`;
const ANTHROPIC_FAKE = `http://127.0.0.1:${FAKES + 2}`;
const ANSWER = 'This is a simulated answer from the local test provider.';

/**
 * Starts the page with the user's own server set up and picked, in the given chat mode.
 * @param {import('@playwright/test').Page} page
 * @param {{ mode?: 'free' | 'grounded' | 'auto', assistant?: string }} [opts]
 */
async function useServer(page, opts = {}) {
  await page.addInitScript(
    ([url, mode, assistant]) => {
      if (sessionStorage.getItem('e2e_seeded')) return;
      sessionStorage.setItem('e2e_seeded', '1');
      localStorage.setItem('starpi_llm_url', url);
      localStorage.setItem('starpi_assistant_v1', assistant);
      localStorage.setItem('starpi_chat_mode', mode);
    },
    [SERVER, opts.mode ?? 'free', opts.assistant ?? 'local:*'],
  );
}

/** @param {import('@playwright/test').Page} page @param {string} text */
async function ask(page, text) {
  await page.fill('#chatInput', text);
  await page.press('#chatInput', 'Enter');
}

/**
 * Asks a question and measures, in the page, the milliseconds from Enter to the first text of the
 * answer on screen.
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 */
async function askTimed(page, text) {
  await page.fill('#chatInput', text);
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__firstText = null;
    const box = /** @type {HTMLElement} */ (document.getElementById('chatMessages'));
    const seen = new Set(box.querySelectorAll('.message-row[data-role="assistant"]'));
    document.getElementById('chatInput')?.addEventListener('keydown', () => (w.__asked = performance.now()), { once: true, capture: true });
    const observer = new MutationObserver(() => {
      const fresh = [...box.querySelectorAll('.message-row[data-role="assistant"]')].find((el) => !seen.has(el));
      if (fresh && fresh.querySelector('.message-content')?.textContent?.trim()) {
        w.__firstText = performance.now() - w.__asked;
        observer.disconnect();
      }
    });
    observer.observe(box, { childList: true, subtree: true, characterData: true });
  });
  await page.press('#chatInput', 'Enter');
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__firstText)).not.toBeNull();
  return /** @type {number} */ (await page.evaluate(() => /** @type {any} */ (window).__firstText));
}

/** @param {import('@playwright/test').Page} page */
const answers = (page) => page.locator('#chatMessages .message-row[data-role="assistant"]');
/** @param {import('@playwright/test').Page} page */
const questions = (page) => page.locator('#chatMessages .message-row[data-role="user"]');

/**
 * Waits until the newest answer is stored and finished (its bar is there and Stop is gone).
 * @param {import('@playwright/test').Page} page
 */
async function settled(page) {
  await expect(page.locator('#stopBtn')).toBeHidden();
  await expect(answers(page).last()).toHaveAttribute('data-node-id', /.+/);
  await expect(answers(page).last().locator('[data-action="msg-copy"]')).toBeVisible();
}

/**
 * The width and height of a JPEG (its first SOF marker).
 * @param {Buffer} buf
 */
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

/**
 * Sends Anthropic calls of the page to the Anthropic fake and records the request bodies.
 * @param {import('@playwright/test').Page} page
 */
async function routeAnthropic(page) {
  /** @type {any[]} */
  const bodies = [];
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-expose-headers': 'request-id' };
  await page.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = new URL(req.url());
    if (req.method() === 'POST') bodies.push(JSON.parse(req.postData() ?? '{}'));
    const res = await route.fetch({ url: `${ANTHROPIC_FAKE}${url.pathname}${url.search}` });
    return route.fulfill({ response: res, headers: { ...res.headers(), ...cors } });
  });
  return bodies;
}

test.describe('chat thread', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('streams a free answer from the own server, copies it, names the chat and keeps the thread after a reload', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await useServer(page);
    await page.goto('/');
    // The first text of the answer is on screen within 1.5 s of Enter (the fake answers at once).
    const latency = await askTimed(page, 'Hello there, how are you today?');
    expect(latency).toBeLessThanOrEqual(1500);
    const answer = answers(page).last();
    await expect(answer.locator('.message-content')).toContainText(ANSWER);
    await settled(page);
    await expect(answer.locator('.engine-badge-label')).toHaveText('Your server · fake-local:8b');
    await expect(answer.locator('[data-answer-label="free"]')).toContainText('Free chat · not checked');
    await expect(answer.locator('.grounding-bar')).toHaveCount(0);
    await expect(answer.locator('.message-meta')).toContainText(/in · \d+ out/);

    // Copy and Copy as Markdown copy the answer's text and its source.
    await answer.locator('[data-action="msg-copy-md"]').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(ANSWER);

    // The title comes from the title purpose, not from the first words of the question.
    const row = page.locator('#chat-sidebar [data-conv-id]').first();
    await expect(row).not.toContainText('Hello there, how are you today?');

    const nodes = await storedChatNodes(page);
    expect(nodes.map((n) => n.role)).toEqual(['user', 'assistant']);
    // The date and time travel in the turn's context block, kept with the question, never as text.
    expect(nodes[0].parts.map((p) => p.type)).toEqual(['text']);

    await page.reload();
    await expect(answers(page)).toHaveCount(1);
    await expect(answers(page).last().locator('.message-content')).toContainText(ANSWER);
    await expect(questions(page).first()).toContainText('Hello there, how are you today?');
    await expect(answers(page).last().locator('[data-answer-label="free"]')).toBeVisible();
  });

  test('stops a stalled answer and keeps what arrived', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await useServer(page);
    await page.goto('/');
    await ask(page, '[[fake-fault:stall-mid-stream]] Tell me a long story');
    const answer = answers(page).last();
    await expect(answer.locator('.message-content')).toContainText('simulated');
    await expect(page.locator('#stopBtn')).toBeVisible();
    await page.click('#stopBtn');
    await expect(page.locator('#stopBtn')).toBeHidden();
    await expect(page.locator('#sendBtn')).toBeEnabled();
    await expect(answer).toHaveAttribute('data-node-id', /.+/);
    const nodes = await storedChatNodes(page);
    expect(nodes.at(-1)?.role).toBe('assistant');
  });

  test('keeps an answer in its own chat when a new chat starts while it streams', async ({ page, isMobile, diagnostics: _diagnostics }) => {
    test.skip(isMobile, 'the conversation list is a drawer on phones');
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await useServer(page);
    await page.goto('/');
    await ask(page, '[[fake-fault:stall-mid-stream]] Tell me a long story');
    await expect(answers(page).last().locator('.message-content')).toContainText('simulated');
    await page.locator('#main [data-action="new-chat"]').click();
    await expect(answers(page)).toHaveCount(0);
    // The answer goes on in its chat until it is stopped; the new chat shows nothing of it.
    await expect(page.locator('#stopBtn')).toBeVisible();
    await page.click('#stopBtn');
    await expect(page.locator('#stopBtn')).toBeHidden();
    await expect(answers(page)).toHaveCount(0);
    await expect(page.locator('#chatMessages')).not.toContainText('could not be completed');
    await page.locator('#chat-sidebar [data-action="conv-open"]', { hasText: 'long story' }).click();
    await expect(answers(page)).toHaveCount(1);
    await expect(answers(page).last().locator('.message-content')).toContainText('simulated');
    await expect(answers(page).last()).toHaveAttribute('data-node-id', /.+/);
    const nodes = await storedChatNodes(page);
    expect(nodes.map((n) => n.role)).toEqual(['user', 'assistant']);
  });

  test('continues an answer cut at its length limit as a new turn', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await useServer(page);
    await page.goto('/');
    await ask(page, '[[fake:length]] Explain the tides');
    await settled(page);
    const cont = answers(page).last().locator('[data-action="msg-continue"]');
    await expect(cont).toBeVisible();
    await cont.click();
    await expect(page.locator('#chatMessages .continue-marker')).toContainText('Continued after the length limit');
    await expect(answers(page)).toHaveCount(2);
    await settled(page);
    await expect(answers(page).first().locator('[data-action="msg-continue"]')).toHaveCount(0);
    const nodes = await storedChatNodes(page);
    expect(nodes.map((n) => n.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  test('regenerates with another model and edits a question into a new branch', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await useServer(page);
    await page.goto('/');
    await ask(page, 'Name a colour');
    await settled(page);
    // The picker lists the server's models once it has answered.
    await expect(page.locator('#engineSelector option[value="local:fake-local-reasoner:4b"]')).toHaveCount(1);

    const first = answers(page).last();
    await first.locator('.regen-menu > summary').click();
    await first.locator('[data-action="msg-regenerate"][data-value="local:fake-local-reasoner:4b"]').click();
    await settled(page);
    const second = answers(page).last();
    await expect(second.locator('.engine-badge-label')).toHaveText('Your server · fake-local-reasoner:4b');
    await expect(second.locator('.branch-pos')).toHaveText('2/2');
    await second.locator('[data-action="msg-branch-prev"]').click();
    await expect(answers(page).last().locator('.branch-pos')).toHaveText('1/2');
    await expect(answers(page).last().locator('.engine-badge-label')).toHaveText('Your server · fake-local:8b');

    await questions(page).last().locator('[data-action="msg-edit"]').click();
    await page.fill('.message-editor textarea', 'Name a fruit');
    await page.click('.message-editor button[type="submit"]');
    await settled(page);
    await expect(questions(page).last()).toContainText('Name a fruit');
    await expect(questions(page).last().locator('.branch-pos')).toHaveText('2/2');
    await expect(answers(page).last().locator('.message-content')).toContainText(ANSWER);
    await questions(page).last().locator('[data-action="msg-branch-prev"]').click();
    await expect(questions(page).last()).toContainText('Name a colour');

    const results = await new AxeBuilder({ page }).include('#chatMessages').analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });

  test('scales an image down before it goes to a model that sees, and holds Send for one that does not', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const bodies = await routeAnthropic(page);
    await page.addInitScript(() => {
      if (sessionStorage.getItem('e2e_seeded')) return;
      sessionStorage.setItem('e2e_seeded', '1');
      sessionStorage.setItem('starpi_key_anthropic', 'sk-ant-e2e0123456789abcdefghijklmnop');
      localStorage.setItem('starpi_chat_mode', 'free');
      localStorage.setItem('starpi_assistant_v1', 'anthropic:claude-haiku-5-5');
    });
    await page.goto('/');
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 3000;
      canvas.height = 2000;
      const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
      ctx.fillStyle = '#3366cc';
      ctx.fillRect(0, 0, 3000, 2000);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.setInputFiles('#chatFileInput', { name: 'big.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await expect(page.locator('#attachedInfo')).toContainText('big.png · 1568×1045');
    await ask(page, 'What colour is this?');
    await settled(page);
    await expect(answers(page).last().locator('.engine-badge-label')).toContainText('Anthropic · ');
    await expect(questions(page).last().locator('.attachment-chip')).toContainText('big.png');
    const sent = bodies.find((b) => Array.isArray(b.messages));
    const image = sent.messages.at(-1).content.find((/** @type {any} */ b) => b.type === 'image');
    expect(image.source.media_type).toBe('image/jpeg');
    expect(jpegSize(Buffer.from(image.source.data, 'base64'))).toEqual({ width: 1568, height: 1045 });
    // The stable system prompt carries no date; the turn's context block does, before the question.
    expect(sent.system).not.toMatch(/\d{4}/);
    expect(sent.messages.at(-1).content.find((/** @type {any} */ b) => b.type === 'text').text).toContain('<<<CONTEXT>>>');
    expect(sent.cache_control).toEqual({ type: 'ephemeral' });

    // A model that cannot see images: Send waits and says why.
    await page.selectOption('#engineSelector', 'wasm:smollm2-135m');
    await page.setInputFiles('#chatFileInput', { name: 'small.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await expect(page.locator('#composerNotice')).toContainText('cannot see images');
    await expect(page.locator('#sendBtn')).toBeDisabled();
    await page.click('#attachedInfo [data-action="remove-attachment"]');
    await expect(page.locator('#sendBtn')).toBeEnabled();
  });

  test('keeps the Anthropic conversation append-only, with the answer content replayed unchanged', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const bodies = await routeAnthropic(page);
    await page.addInitScript(() => {
      if (sessionStorage.getItem('e2e_seeded')) return;
      sessionStorage.setItem('e2e_seeded', '1');
      sessionStorage.setItem('starpi_key_anthropic', 'sk-ant-e2e0123456789abcdefghijklmnop');
      localStorage.setItem('starpi_chat_mode', 'free');
      localStorage.setItem('starpi_assistant_v1', 'anthropic:claude-opus-5-5');
      localStorage.setItem('starpi_thinking_v1', 'on');
    });
    await page.goto('/');
    await ask(page, '[[fake:pause]] Look up the weather');
    await settled(page);
    const answer = answers(page).last();
    // The paused turn was sent back once and continued; the reasoning stays in the details.
    await expect(answer.locator('.message-content')).toContainText('example');
    await answer.locator('[data-action="toggle-thought"]').click();
    await expect(answer.locator('.thought-body')).toContainText('I recall the key facts first');
    await ask(page, 'And tomorrow?');
    await settled(page);
    // Chat calls only (the title of the conversation is a purpose call of its own).
    const posts = bodies.filter((b) => Array.isArray(b.messages) && !JSON.stringify(b.system ?? '').includes('starpi-purpose'));
    expect(posts.length).toBe(3);
    expect(posts[0].fallbacks).toBe('default');
    // The resumed call ends with the paused content; the next question replays all of it unchanged.
    const paused = posts[1].messages.at(-1);
    expect(paused.role).toBe('assistant');
    expect(paused.content.at(-1).type).toBe('server_tool_use');
    const replayed = posts[2].messages.find((/** @type {any} */ m) => m.role === 'assistant');
    expect(replayed.content.some((/** @type {any} */ b) => b.type === 'thinking' && typeof b.signature === 'string')).toBe(true);
    expect(replayed.content.filter((/** @type {any} */ b) => b.type === 'server_tool_use')).toHaveLength(1);
    expect(posts[2].system).toBe(posts[0].system);
  });
});

test.describe('answers and the other features', () => {
  test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, 'speech stand-ins run on desktop Chromium');

  test('reads an answer aloud while it streams and with its speaker button, and researches its question', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.route('**/api/voice/voices', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"route_missing"}' }));
    await useServer(page);
    // A speechSynthesis that records what it is asked to say; answers are read aloud as they stream.
    await page.addInitScript(() => {
      localStorage.setItem('starpi_voice_v1', JSON.stringify({ autoRead: true }));
      Object.assign(window, { __spoken: [] });
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        value: {
          speak(/** @type {SpeechSynthesisUtterance} */ u) {
            /** @type {any} */ (window).__spoken.push(u.text);
            setTimeout(() => u.onend?.(/** @type {any} */ (new Event('end'))), 10);
          },
          cancel() {},
          getVoices: () => [],
          addEventListener() {},
          removeEventListener() {},
        },
      });
    });
    const spoken = () => page.evaluate(() => /** @type {string[]} */ (/** @type {any} */ (window).__spoken).join(' | '));
    await page.goto('/');
    await ask(page, 'Hello, what can you do?');
    await settled(page);
    await expect.poll(spoken).toContain('Free answer, not checked.');
    await expect.poll(spoken).toContain(ANSWER);

    const answer = answers(page).last();
    const speaker = answer.locator('[data-action="voice-read-aloud"]');
    await expect(speaker).toHaveAccessibleName('Read aloud');
    await expect(questions(page).last().locator('[data-action="voice-read-aloud"]')).toHaveCount(0);
    await page.evaluate(() => {
      /** @type {any} */ (window).__spoken = [];
    });
    await speaker.click();
    await expect.poll(spoken).toContain(ANSWER);

    // "Research this" starts a job about the question of this answer; the side panel lists it.
    const research = answer.locator('[data-action="msg-extra"][data-extra="research"]');
    await expect(research).toHaveAccessibleName('Research this');
    await research.click();
    await expect(page.locator('#toastRegion')).toContainText('Research started');
    await expect(page.locator('#chat-aside-research')).toContainText('Hello, what can you do?');

    const results = await new AxeBuilder({ page }).include('#chatMessages').analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});

test.describe('grounded thread', () => {
  test('stays free without files in Auto, answers from an attached file with the source check and a receipt, and keeps the file when the question is edited', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    // A knowledge base without documents (the newest route answers first).
    await page.route(/^https:\/\/[a-z0-9]+\.supabase\.co\/rest\/v1\/knowledge_documents/, (route) =>
      route.request().method() === 'OPTIONS'
        ? route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } })
        : route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '[]' }),
    );
    await useServer(page, { mode: 'auto' });
    await page.goto('/');
    // No files anywhere: Auto answers freely, without a source check.
    await ask(page, 'What is a budget?');
    await settled(page);
    const free = answers(page).last();
    await expect(free.locator('[data-answer-label="free"]')).toBeVisible();
    await expect(free.locator('.grounding-bar')).toHaveCount(0);
    await expect(free.locator('[data-action="open-receipt"]')).toHaveCount(0);

    await page.setInputFiles('#chatFileInput', { name: 'budget.md', mimeType: 'text/markdown', buffer: Buffer.from('# Budget\n\nThe approved budget for Project Nebula is 480,000 EUR.') });
    await expect(page.locator('#attachedInfo')).toContainText('budget.md · 1 chunk');
    await ask(page, 'What is the approved budget?');
    const answer = answers(page).last();
    await expect(answer.locator('.grounding-bar')).toBeVisible();
    await expect(answer.locator('[data-action="open-receipt"]')).toBeVisible();
    await expect(answer.locator('[data-provenance="checked"]')).toBeVisible();
    await settled(page);
    await expect(questions(page).last().locator('.attachment-chip')).toContainText('budget.md');

    // The edited question keeps its file and is answered from it again, as a new branch.
    await questions(page).last().locator('[data-action="msg-edit"]').click();
    await page.fill('.message-editor textarea', 'What is the approved budget for Project Nebula?');
    await page.click('.message-editor button[type="submit"]');
    await settled(page);
    const edited = questions(page).last();
    await expect(edited).toContainText('What is the approved budget for Project Nebula?');
    await expect(edited.locator('.attachment-chip')).toContainText('budget.md');
    await expect(edited.locator('.branch-pos')).toHaveText('2/2');
    await expect(answers(page).last().locator('.grounding-bar')).toBeVisible();
    await expect(answers(page).last().locator('[data-action="open-receipt"]')).toBeVisible();
    await expect(answers(page).last().locator('.message-sources')).toContainText('budget.md');
    const nodes = await storedChatNodes(page);
    const asked = nodes.filter((n) => n.role === 'user' && n.parts.some((/** @type {any} */ p) => p.type === 'file'));
    expect(asked.map((n) => n.parts.find((/** @type {any} */ p) => p.type === 'file').name)).toEqual(['budget.md', 'budget.md']);
  });
});
