// End-to-end tests for the chat modes: the toggle (Auto, Free, Grounded), the free chat (no
// retrieval, no source check, copyable code, the conversation as history, an attached file in the
// question), the chat menu (Markdown and JSON export, deleting the chat) and answers of the site's
// free NVIDIA models through a mocked pool in both modes.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NVIDIA_MODELS } from '../../src/js/models/nvidia-catalog.js';
import { expect, mockNvidia, mockSupabase, test, useNvidia } from './fixtures.mjs';

const BUDGET_MD = '# Budget\n\nThe approved budget for Project Nebula is 480,000 EUR. The steering group meets every Tuesday at 10:00.';

/** @param {import('@playwright/test').Page} page @param {string} text */
async function ask(page, text) {
  await page.fill('#chatInput', text);
  await page.press('#chatInput', 'Enter');
}

/** @param {import('@playwright/test').Page} page @param {string} name @param {string} content */
async function attach(page, name, content) {
  await page.setInputFiles('#chatFileInput', { name, mimeType: 'text/markdown', buffer: Buffer.from(content) });
  await expect(page.locator('#attachedInfo')).toContainText(name);
  await expect(page.locator('#attachedInfo')).toContainText('chunk');
}

/**
 * Answers OpenRouter chat requests (with a key for this tab) with the given replies in turn (the
 * last one repeats) and records the request bodies. Requests of the app's own tasks (the chat
 * title) are refused, so the title stays the question and the replies stay in order.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} replies
 */
async function mockOpenRouter(page, replies) {
  await page.addInitScript(() => sessionStorage.setItem('starpi_openrouter_key', 'test-key'));
  /** @type {Array<{ model: string, messages: Array<{ role: string, content: string }> }>} */
  const bodies = [];
  await page.route('https://openrouter.ai/**', async (route) => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = JSON.parse(route.request().postData() ?? '{}');
    if (JSON.stringify(body.messages ?? []).includes('starpi-purpose')) return route.fulfill({ status: 400, contentType: 'application/json', headers, body: '{"error":{"message":"no"}}' });
    bodies.push(body);
    const content = replies[Math.min(bodies.length, replies.length) - 1];
    return route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }) });
  });
  return bodies;
}

/** The context block a free-chat question starts with (date and time, notes). */
const CONTEXT = /^<<<CONTEXT>>>\nCurrent date and time: .+\n<<<END CONTEXT>>>\n\n/;

/** @param {import('@playwright/test').Page} page */
const modeButton = (page, /** @type {'auto' | 'free' | 'grounded'} */ mode) => page.locator(`[data-action="set-chat-mode"][data-arg="${mode}"]`);

/** @param {import('@playwright/test').Page} page */
const lastMessage = (page) => page.locator('#chatMessages > div').last();

const CODE_ANSWER = "Here you go:\n\n```python\nprint('hi')\n```";

test.describe('chat mode toggle', () => {
  test('remembers the chosen mode across reloads and relabels the composer', async ({ page, diagnostics: _diagnostics }) => {
    const calls = await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    const input = page.locator('#chatInput');
    await expect(modeButton(page, 'auto')).toHaveAttribute('aria-pressed', 'true');
    await expect(modeButton(page, 'grounded')).toHaveAttribute('aria-pressed', 'false');
    await expect(modeButton(page, 'free')).toHaveAttribute('aria-pressed', 'false');
    await expect(input).toHaveAttribute('placeholder', 'Ask anything…');
    await expect(page.locator('#chatModeHint')).toHaveText('Answers from your files when you have some, otherwise a free conversation.');
    await expect(page.locator('#privacyNotice')).toContainText('No model configured');

    await modeButton(page, 'free').click();
    await expect(modeButton(page, 'free')).toHaveAttribute('aria-pressed', 'true');
    await expect(modeButton(page, 'auto')).toHaveAttribute('aria-pressed', 'false');
    await expect(modeButton(page, 'grounded')).toHaveAttribute('aria-pressed', 'false');
    await expect(input).toHaveAttribute('placeholder', 'Message Starpi…');
    await expect(page.locator('#privacyNotice')).toContainText('Free chat');

    // Without a model the free chat explains itself instead of quoting sources, and searches nothing.
    await ask(page, 'Tell me a joke.');
    await expect(lastMessage(page)).toContainText('The free chat needs a model');
    expect(calls.some((c) => c.url.startsWith('/rest/v1/rpc/search_knowledge'))).toBe(false);

    await page.reload();
    await expect(modeButton(page, 'free')).toHaveAttribute('aria-pressed', 'true');
    await expect(input).toHaveAttribute('placeholder', 'Message Starpi…');

    await page.click('[data-action="set-locale"][data-arg="de"]');
    await expect(input).toHaveAttribute('placeholder', 'Nachricht an Starpi…');
    await expect(modeButton(page, 'auto')).toContainText('Auto');
    await expect(modeButton(page, 'free')).toContainText('Frei');
    await expect(modeButton(page, 'grounded')).toContainText('Quellen');
    await expect(page.locator('#privacyNotice')).toContainText('Freier Chat');

    // Quick prompts ask about the sources, so they run in source mode, and the toggle and the
    // privacy notice switch along to say so.
    await page.click('[data-action="quick-prompt"][data-arg="chat.prompt_docs_question"]');
    await expect(page.locator('#chatMessages')).toContainText('Verfügbare Dokumente (2)');
    await expect(modeButton(page, 'grounded')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#privacyNotice')).not.toContainText('Freier Chat');
  });
});

test.describe('free chat', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('answers from the conversation with a copyable code block and no source check', async ({ page, diagnostics: _diagnostics }) => {
    const calls = await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const bodies = await mockOpenRouter(page, [CODE_ANSWER, 'Use `print` again.']);
    await page.goto('/');
    await modeButton(page, 'free').click();
    await ask(page, 'Write hello world in Python.');

    const answer = lastMessage(page);
    await expect(answer.locator('.message-content pre')).toContainText("print('hi')");
    await expect(answer.locator('[data-answer-label="free"]')).toContainText('Free chat · not checked');
    await expect(answer.locator('.engine-badge-label')).toHaveText(/^OpenRouter · .+/);
    await expect(answer.locator('.grounding-bar')).toHaveCount(0);
    await expect(answer.locator('[data-action="open-receipt"]')).toHaveCount(0);
    // The details name the answer, not a retrieval that never happened.
    await answer.locator('[data-action="toggle-thought"]').click();
    await expect(answer.locator('.thought-body')).toContainText('Free chat, not checked against sources');
    await expect(answer.locator('.thought-body')).not.toContainText('Retrieval');

    const copy = answer.locator('.code-copy');
    await expect(copy).toHaveAccessibleName('Copy code');
    await copy.click();
    await expect(copy).toContainText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("print('hi')");

    await ask(page, 'And once more?');
    await expect(lastMessage(page)).toContainText('Use print again.');
    expect(bodies.length).toBe(2);
    expect(bodies[1].model).toBe(bodies[0].model);
    const [first, second] = bodies.map((b) => b.messages);
    expect(first.map((m) => m.role)).toEqual(['system', 'user']);
    expect(first[0].content).toContain('fenced code blocks');
    expect(first[0].content).not.toContain('<<<EXCERPT');
    // The system prompt stays the same from turn to turn; the date and time travel in the question.
    expect(second[0].content).toBe(first[0].content);
    expect(first[1].content).toMatch(CONTEXT);
    expect(second.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    // The earlier turns are sent again unchanged.
    expect(second[1].content).toBe(first[1].content);
    expect(second[1].content.replace(CONTEXT, '')).toBe('Write hello world in Python.');
    expect(second[2].content).toBe(CODE_ANSWER);
    expect(second[3].content).toMatch(CONTEXT);
    expect(second[3].content.replace(CONTEXT, '')).toBe('And once more?');
    expect(calls.some((c) => c.url.startsWith('/rest/v1/rpc/search_knowledge'))).toBe(false);
  });

  test('sends an attached file with its question, without the source check, and keeps the chat on this device', async ({ page, diagnostics: _diagnostics }) => {
    const calls = await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const bodies = await mockOpenRouter(page, ['The contract sets the salary of Jane Roe.', 'Noted.']);
    await page.goto('/');
    await modeButton(page, 'free').click();
    await attach(page, 'salary.md', '# Contract\n\nThe annual salary of Jane Roe is 187,500 EUR.');
    await ask(page, 'Summarize it');

    const answer = lastMessage(page);
    await expect(answer).toContainText('The contract sets the salary of Jane Roe.');
    await expect(answer.locator('[data-answer-label="free"]')).toBeVisible();
    await expect(answer.locator('.grounding-bar')).toHaveCount(0);
    await expect(page.locator('#chatMessages')).toContainText('salary.md');
    // The file travels in the question it was attached to, never in the stable system prompt.
    expect(bodies[0].messages[0].content).not.toContain('Jane Roe');
    const question = bodies[0].messages[1].content.replace(CONTEXT, '');
    expect(question).toBe('Attached file:\n<<<FILE salary.md>>>\n# Contract\n\nThe annual salary of Jane Roe is 187,500 EUR.\n<<<END FILE>>>\n\nSummarize it');

    await ask(page, 'Thanks. What else should I know?');
    await expect(lastMessage(page)).toContainText('Noted.');
    // The conversation goes again as it was, the file once, in its question.
    const second = bodies[1].messages;
    expect(second.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(second[1].content).toBe(bodies[0].messages[1].content);
    expect(JSON.stringify(second).split('<<<FILE salary.md>>>')).toHaveLength(2);
    // The chat is kept on this device; nothing of it reaches the knowledge base.
    expect(calls.some((c) => c.method === 'POST' && c.url.startsWith('/rest/v1/chat_history'))).toBe(false);
  });
});

test.describe('chat menu', () => {
  test('exports the conversation as Markdown and JSON, then deletes it', async ({ page, diagnostics: _diagnostics }, testInfo) => {
    const calls = await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await mockOpenRouter(page, [CODE_ANSWER]);
    await page.goto('/');
    await expect(page.locator('#dbStatusBadge')).toHaveText('Live');
    await modeButton(page, 'free').click();
    await ask(page, 'Write hello world in Python.');
    await expect(lastMessage(page).locator('[data-answer-label="free"]')).toBeVisible();

    const menu = page.locator('details.chat-menu');
    /** @param {'md' | 'json'} format */
    const exportAs = async (format) => {
      await menu.locator('summary').click();
      const [download] = await Promise.all([page.waitForEvent('download'), menu.locator(`[data-action="export-chat"][data-arg="${format}"]`).click()]);
      await expect(menu).not.toHaveAttribute('open', '');
      const file = testInfo.outputPath(download.suggestedFilename());
      await download.saveAs(file);
      return { name: download.suggestedFilename(), text: readFileSync(file, 'utf8') };
    };

    const md = await exportAs('md');
    expect(md.name).toMatch(/^starpi-chat-\d{4}-\d{2}-\d{2}-[\w-]{1,8}\.md$/);
    expect(md.text).toMatch(/^# Starpi chat\n\n_Exported on .+ · 2 messages_\n\n## You\n\nWrite hello world in Python\.\n\n## Starpi · OpenRouter · .+\n\n/);
    expect(md.text).toContain("```python\nprint('hi')\n```");

    const json = await exportAs('json');
    expect(json.name).toMatch(/^starpi-chat-\d{4}-\d{2}-\d{2}-[\w-]{1,8}\.json$/);
    const doc = JSON.parse(json.text);
    // The stored message tree (schema v2): every node with its parent, and the thread shown.
    expect(doc.schema).toBe('starpi.chat/v2');
    expect(doc.generator.name).toBe('starpi');
    expect(doc.locale).toBe('en');
    expect(doc.nodes.map((/** @type {{ role: string }} */ m) => m.role)).toEqual(['user', 'assistant']);
    expect(doc.nodes[1]).toMatchObject({ parentId: doc.nodes[0].id, parts: [{ type: 'text', text: CODE_ANSWER }], engine: 'cloud', provider: 'openrouter', label: 'free' });
    expect(typeof doc.nodes[1].model).toBe('string');
    expect(doc.activePath).toEqual(doc.nodes.map((/** @type {{ id: string }} */ m) => m.id));
    expect(doc.conversation).toMatchObject({ title: 'Write hello world in Python.', mode: 'free' });
    const sessionId = doc.conversation.id;
    expect(sessionId).toMatch(/^starpi_[\w-]+$/);
    expect(await page.evaluate(() => localStorage.getItem('starpi_chat_session_id'))).toBe(sessionId);

    await menu.locator('summary').click();
    page.once('dialog', (dialog) => void dialog.accept());
    await menu.locator('[data-action="delete-chat"]').click();
    await expect(lastMessage(page)).toContainText('Chat deleted');
    await expect(page.locator('#chatMessages')).not.toContainText('Write hello world');
    expect(calls.some((c) => c.method === 'DELETE' && c.url.startsWith('/rest/v1/chat_history') && c.url.includes(`session_id=eq.${sessionId}`))).toBe(true);
    // A new chat starts; the deleted one is not restored after a reload.
    expect(await page.evaluate(() => localStorage.getItem('starpi_chat_session_id'))).not.toBe(sessionId);
    await page.reload();
    await expect(page.locator('#dbStatusBadge')).toHaveText('Live');
    await expect(page.locator('#chatMessages')).not.toContainText('Write hello world');
  });
});

/**
 * The requests of a mocked pool that asked for an answer (not for the chat title).
 * @param {{ bodies: Array<{ messages: unknown }> }} nvidia
 */
const answerRequests = (nvidia) => nvidia.bodies.filter((b) => !JSON.stringify(b.messages).includes('starpi-purpose'));

test.describe('free NVIDIA models of the site', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });
  // A reasoning model that is not the default, so the stored choice is what gets asked.
  const MODEL = /** @type {(typeof NVIDIA_MODELS)[number]} */ (NVIDIA_MODELS.find((m) => m.reasoning));

  test('streams a free-chat answer with hidden reasoning and copyable code, and sends the conversation as history', async ({ page, diagnostics: _diagnostics }) => {
    const calls = await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const nvidia = await mockNvidia(page, {
      reply: [{ reasoning: ['Plan the answer.'], content: ['Here you go:\n\n```python\n', "print('hi')\n```"] }, { content: ['A title'] }, { content: ['Use `print` again.'] }],
    });
    await useNvidia(page, MODEL.id);
    await page.goto('/');
    // Both pickers name the stored model once the device is known.
    await expect(page.locator('#engineSelector[data-ready="true"]')).toHaveValue(`nvidia:${MODEL.id}`);
    await expect(page.locator('#cfgComputeMode[data-ready="true"]')).toHaveValue(`nvidia:${MODEL.id}`);
    await modeButton(page, 'free').click();
    await expect(page.locator('#privacyNotice')).toContainText("go through Starpi's server to NVIDIA");
    await ask(page, 'Write hello world in Python.');

    const answer = lastMessage(page);
    await expect(answer.locator('.message-content pre')).toContainText("print('hi')");
    await expect(answer.locator('.engine-badge-label')).toHaveText(`NVIDIA via Starpi · ${MODEL.label}`);
    await expect(answer.locator('.message-content')).not.toContainText('Plan the answer');
    await expect(answer.locator('[data-answer-label="free"]')).toContainText('Free chat · not checked');
    await expect(answer.locator('.grounding-bar')).toHaveCount(0);
    await expect(answer.locator('[data-action="open-receipt"]')).toHaveCount(0);
    // The model's reasoning is kept in the details, labelled as such.
    await expect(answer.locator('.thought-container')).toHaveCount(1);
    await answer.locator('[data-action="toggle-thought"]').click();
    await expect(answer.locator('.thought-body')).toContainText('Plan the answer.');

    const copy = answer.locator('.code-copy');
    await copy.click();
    await expect(copy).toContainText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("print('hi')");

    // The chat's title comes from the same model before the next question.
    await expect.poll(() => nvidia.bodies.length).toBe(2);
    await ask(page, 'And once more?');
    await expect(lastMessage(page)).toContainText('Use print again.');
    const asked = answerRequests(nvidia);
    expect(asked.length).toBe(2);
    const [first, second] = asked;
    expect(first).toMatchObject({ model: MODEL.id, stream: true });
    // No key leaves the browser: the site's pool adds its own.
    expect(nvidia.auth.every((a) => a === undefined)).toBe(true);
    expect(first.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(first.messages[0].content).toContain('fenced code blocks');
    expect(first.messages[0].content).not.toContain('<<<EXCERPT');
    expect(second.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(String(second.messages[1].content).replace(CONTEXT, '')).toBe('Write hello world in Python.');
    expect(second.messages[2].content).toBe("Here you go:\n\n```python\nprint('hi')\n```");
    expect(JSON.stringify(second.messages)).not.toContain('<think>');
    expect(JSON.stringify(second.messages)).not.toContain('Plan the answer');
    expect(calls.some((c) => c.url.startsWith('/rest/v1/rpc/search_knowledge'))).toBe(false);
  });

  test('checks an NVIDIA answer against the attached file in Auto and issues a receipt', async ({ page, diagnostics: _diagnostics }, testInfo) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const nvidia = await mockNvidia(page, {
      reply: { reasoning: ['Check the excerpt.'], content: ['The approved budget for Project Nebula is ', '480,000 EUR [Doc: budget.md, Chunk: 1].'] },
    });
    await useNvidia(page, MODEL.id);
    await page.goto('/');
    await attach(page, 'budget.md', BUDGET_MD);
    await ask(page, 'What is the approved budget?');

    const answer = lastMessage(page);
    const bar = answer.locator('.grounding-bar');
    await expect(bar).toHaveClass(/grounding-ok/);
    await expect(bar).toContainText('1/1 statements');
    await expect(answer.locator('.engine-badge-label')).toHaveText(`NVIDIA via Starpi · ${MODEL.label}`);
    await expect(answer.locator('.message-content')).toContainText('480,000 EUR');
    await expect(answer.locator('.message-content')).not.toContainText('Check the excerpt');
    const asked = answerRequests(nvidia);
    expect(asked.length).toBe(1);
    expect(asked[0]).toMatchObject({ model: MODEL.id, temperature: 0.2 });
    expect(asked[0].messages[0].content).toContain('<<<EXCERPT 1 [Doc: budget.md, Chunk: 1]');

    await answer.locator('[data-action="open-receipt"]').click();
    const dialog = page.locator('#receiptModal');
    await expect(dialog).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), dialog.locator('[data-action="download-receipt"]').click()]);
    const receiptPath = testInfo.outputPath('receipt.json');
    await download.saveAs(receiptPath);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    expect(receipt.schema).toBe('starpi.receipt/v3');
    expect(receipt.signer?.keyId).toBe(receipt.signature?.keyId);
    expect(receipt.answer.engine).toBe('nvidia');
    expect(receipt.answer.text).toBe('The approved budget for Project Nebula is 480,000 EUR [Doc: budget.md, Chunk: 1].');
    expect(receipt.citations[0].document.fileSha256).toBe(createHash('sha256').update(BUDGET_MD).digest('hex'));
  });

  test('says when the site serves no free NVIDIA models and quotes the sources instead', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const nvidia = await mockNvidia(page, { configured: false });
    await useNvidia(page);
    await page.goto('/');
    await expect(page.locator('#assistantStatusText')).toHaveText('This model is not set up: add its key in Settings or pick another one');
    await attach(page, 'budget.md', BUDGET_MD);
    await ask(page, 'What is the approved budget?');

    const answer = lastMessage(page);
    await expect(answer).toContainText('480,000 EUR');
    await expect(answer).toContainText('no AI model was used');
    await expect(answer.locator('.grounding-bar')).toBeVisible();
    expect(nvidia.catalogRequests).toBeGreaterThan(0);
    expect(nvidia.bodies.length).toBe(0);
  });

  test('shows a rate-limit notice with the wait time and without the server text', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const nvidia = await mockNvidia(page, { error: { status: 429, headers: { 'retry-after': '7' }, body: { error: 'rate_limited', message: 'test-key-1 detail' } } });
    await useNvidia(page);
    await page.goto('/');
    await modeButton(page, 'free').click();
    await ask(page, 'Hello?');

    await expect(page.locator('#chatMessages')).toContainText('please wait 7 s');
    await expect(page.locator('#chatMessages')).not.toContainText('test-key-1');
    await expect(page.locator('#chatMessages .grounding-bar')).toHaveCount(0);
    expect(answerRequests(nvidia).length).toBeGreaterThanOrEqual(1);
  });
});
