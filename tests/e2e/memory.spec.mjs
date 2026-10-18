// Projects, memory and assistants against the Anthropic fake (scripts/fakes): a project created in
// the sidebar keeps its chat, its instructions go into the system prompt and the chip names it;
// memory stays off until switched on in Settings, and only then do saved notes go along with a
// question (in the turn, never in the stable system prompt), with "Remember this" on messages; an
// assistant brings its instructions and conversation starters, and exports and imports as
// starpi.assistant/v1 without tools it may not use. No page error, the sidebar passes axe.
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, mockSupabase, test } from './fixtures.mjs';

const FAKES = Number(process.env.STARPI_FAKES_PORT || 4610);
const ANTHROPIC_FAKE = `http://127.0.0.1:${FAKES + 2}`;

test.skip(({ isMobile }) => isMobile, 'the sidebar sections and dialogs are checked on desktop');

/**
 * Sends Anthropic calls to the fake and records the bodies of the chat calls (purpose calls such as
 * the chat title carry a purpose marker and are left out).
 * @param {import('@playwright/test').Page} page
 */
async function routeAnthropic(page) {
  /** @type {any[]} */
  const chats = [];
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-expose-headers': 'request-id' };
  await page.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = new URL(req.url());
    if (req.method() === 'POST') {
      const body = JSON.parse(req.postData() ?? '{}');
      if (Array.isArray(body.messages) && !JSON.stringify(body.system ?? '').includes('starpi-purpose')) chats.push(body);
    }
    const res = await route.fetch({ url: `${ANTHROPIC_FAKE}${url.pathname}${url.search}` });
    return route.fulfill({ response: res, headers: { ...res.headers(), ...cors } });
  });
  return chats;
}

/** A returning visitor with an Anthropic key, free chat and a fast model picked. @param {import('@playwright/test').Page} page */
async function useAnthropic(page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e_seeded')) return;
    sessionStorage.setItem('e2e_seeded', '1');
    sessionStorage.setItem('starpi_key_anthropic', 'sk-ant-e2e0123456789abcdefghijklmnop');
    localStorage.setItem('starpi_chat_mode', 'free');
    localStorage.setItem('starpi_assistant_v1', 'anthropic:claude-haiku-5-5');
  });
}

/** @param {import('@playwright/test').Page} page @param {string} text */
async function ask(page, text) {
  await page.fill('#chatInput', text);
  await page.press('#chatInput', 'Enter');
}

/** @param {import('@playwright/test').Page} page */
const answers = (page) => page.locator('#chatMessages .message-row[data-role="assistant"]');

/** Waits until the newest answer is stored and finished. @param {import('@playwright/test').Page} page */
async function settled(page) {
  await expect(page.locator('#stopBtn')).toBeHidden();
  await expect(answers(page).last()).toHaveAttribute('data-node-id', /.+/);
  await expect(answers(page).last().locator('[data-action="msg-copy"]')).toBeVisible();
}

/** The system prompt of a recorded call as one string. @param {any} body */
const systemOf = (body) => (typeof body.system === 'string' ? body.system : (body.system ?? []).map((/** @type {any} */ b) => b.text ?? '').join('\n'));
/** The text of the question of a recorded call. @param {any} body */
const questionOf = (body) => {
  const last = body.messages.at(-1);
  return typeof last.content === 'string' ? last.content : last.content.map((/** @type {any} */ b) => b.text ?? '').join('\n');
};

test.describe('projects, memory and assistants', () => {
  test('a project keeps its chat, instructions and memory setting', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const chats = await routeAnthropic(page);
    await useAnthropic(page);
    await page.goto('/');

    await page.click('#chat-sidebar [data-pj="new"]');
    const dialog = page.locator('#projectDialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#pjName')).toBeFocused();
    await dialog.locator('#pjName').fill('Thesis');
    await dialog.locator('#pjInstructions').fill('Answer like a thesis supervisor would.');
    await dialog.locator('input[name="memoryScope"][value="project"]').check();
    await dialog.locator('button[type="submit"]').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#toastRegion')).toContainText('Project Thesis created');

    const project = page.locator('#chat-sidebar [data-project-id]');
    await expect(project).toContainText('Thesis');
    await project.locator('[data-pj="toggle"]').click();
    await project.locator('[data-pj="new-chat"]').click();
    await expect(page.locator('#chatInput')).toBeFocused();
    await expect(page.locator('#chatToolbarExtras [data-context-chip="project"]')).toContainText('Thesis');
    await ask(page, 'What should chapter one cover?');
    await settled(page);
    expect(systemOf(chats.at(-1))).toContain('Answer like a thesis supervisor would.');
    expect(systemOf(chats.at(-1))).toContain('project "Thesis"');

    // The chat is stored in the project, listed under it, and the list offers "Move to project".
    await expect(project.locator('[data-pj="open"]')).toHaveCount(1);
    const row = page.locator('#chat-sidebar [data-chat-list] li[data-conv-id]').first();
    await row.locator('[data-action="conv-menu"]').click();
    await expect(page.locator('#chat-sidebar [data-action="conv-move"]')).toBeVisible();
    await page.keyboard.press('Escape');

    // A new chat outside the project carries no project instructions.
    await page.click('#chat-sidebar [data-action="new-chat"]');
    await expect(page.locator('#chatToolbarExtras [data-context-chip]')).toHaveCount(0);
    await ask(page, 'Something else entirely');
    await settled(page);
    expect(systemOf(chats.at(-1))).not.toContain('thesis supervisor');

    const results = await new AxeBuilder({ page }).include('#sidebar').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });

  test('memory stays off until switched on; then saved notes go along in the turn', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const chats = await routeAnthropic(page);
    await useAnthropic(page);
    await page.goto('/');

    await ask(page, 'Hello there');
    await settled(page);
    expect(questionOf(chats.at(-1))).not.toContain('User notes');
    await expect(answers(page).last().locator('[data-extra="remember"]')).toHaveCount(0);

    // A note saved in Settings while memory is off is kept but not sent.
    await page.click('#nav-settings');
    const card = page.locator('[data-memory-settings]');
    await expect(card.locator('#mvEnabled')).not.toBeChecked();
    await expect(card.locator('#mvSuggest')).toBeDisabled();
    await card.locator('#mvAddText').fill('I live in Lisbon');
    await card.locator('[data-mv-add] button[type="submit"]').click();
    await expect(card.locator('[data-fact]')).toHaveCount(1);
    await page.click('#nav-chat');
    await ask(page, 'Where do I live?');
    await settled(page);
    expect(questionOf(chats.at(-1))).not.toContain('Lisbon');

    await page.click('#nav-settings');
    await card.locator('#mvEnabled').check();
    await expect(page.locator('#toastRegion')).toContainText('Memory is on');
    await page.click('#nav-chat');
    await ask(page, 'Where do I live again?');
    await settled(page);
    const turn = questionOf(chats.at(-1));
    expect(turn).toContain('User notes (may be outdated):');
    expect(turn).toContain('- I live in Lisbon');
    // The notes are part of the turn; the system prompt stays the same.
    expect(systemOf(chats.at(-1))).toBe(systemOf(chats[0]));
    expect(systemOf(chats.at(-1))).not.toContain('Lisbon');

    // "Remember this" on a message: the note is the message's text, editable, saved on Save only.
    const remember = answers(page).last().locator('[data-extra="remember"]');
    await expect(remember).toBeVisible();
    await remember.click();
    const dialog = page.locator('#rememberDialog');
    await expect(dialog.locator('#rmText')).not.toHaveValue('');
    await dialog.locator('#rmText').fill('I prefer short answers');
    await dialog.locator('button[type="submit"]').click();
    await expect(dialog).toHaveCount(0);
    await page.click('#nav-settings');
    await expect(card.locator('[data-fact]')).toHaveCount(2);
    await expect(card).toContainText('I prefer short answers');
  });

  test('suggests notes after a free answer only with suggestions on, and keeps one only when accepted', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    /** @type {string[]} */
    const purposes = [];
    page.on('request', (req) => {
      const m = /starpi-purpose:(\w+)/.exec(req.postData() ?? '');
      if (req.url().startsWith('https://api.anthropic.com/') && m) purposes.push(m[1]);
    });
    await routeAnthropic(page);
    await useAnthropic(page);
    await page.goto('/');
    await page.click('#nav-settings');
    const card = page.locator('[data-memory-settings]');
    await card.locator('#mvEnabled').check();
    await expect(card.locator('#mvSuggest')).toBeEnabled();
    await page.click('#nav-chat');
    await ask(page, 'I teach biology at a school in Porto. What is osmosis?');
    await settled(page);
    // Memory on, suggestions off: no suggestion call at all.
    await page.waitForTimeout(300);
    expect(purposes).not.toContain('memory_suggest');

    await page.click('#nav-settings');
    await card.locator('#mvSuggest').check();
    await page.click('#nav-chat');
    await ask(page, 'And what is diffusion?');
    await settled(page);
    const strip = page.locator('#chatMessages [data-memory-suggest]');
    await expect(strip).toBeVisible();
    expect(purposes).toContain('memory_suggest');
    // Shown, not stored.
    await page.click('#nav-settings');
    await expect(card.locator('[data-fact]')).toHaveCount(0);
    await page.click('#nav-chat');
    await strip.locator('[data-ms="keep"]').first().click();
    await expect(page.locator('#toastRegion')).toContainText('Note saved');
    await page.click('#nav-settings');
    await expect(card.locator('[data-fact]')).toHaveCount(1);
    await expect(card.locator('[data-fact]')).toContainText('Suggested');
  });

  test('an assistant brings its instructions and starters, and exports and imports as a file', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const chats = await routeAnthropic(page);
    await useAnthropic(page);
    await page.goto('/');

    await page.click('#chat-sidebar [data-as="new"]');
    const dialog = page.locator('#assistantDialog');
    await dialog.locator('#asName').fill('Latin tutor');
    await dialog.locator('label:has(input[name="icon"][value="graduation-cap"])').click();
    await dialog.locator('#asInstructions').fill('Answer in simple Latin first, then in English.');
    await dialog.locator('input[name="starter"]').first().fill('Decline the word rosa');
    await dialog.locator('button[type="submit"]').click();
    await expect(dialog).toHaveCount(0);

    const row = page.locator('#chat-sidebar [data-assistant-id]');
    await expect(row).toContainText('Latin tutor');
    await row.locator('[data-as="start"]').click();
    await expect(page.locator('#chatToolbarExtras [data-context-chip="assistant"]')).toContainText('Latin tutor');
    const starter = page.locator('#chatMessages [data-assistant-intro] [data-starter]');
    await expect(starter).toHaveText('Decline the word rosa');
    await starter.click();
    await settled(page);
    expect(questionOf(chats.at(-1))).toContain('Decline the word rosa');
    expect(systemOf(chats.at(-1))).toContain('Answer in simple Latin first, then in English.');
    expect(systemOf(chats.at(-1))).toContain('"Latin tutor"');

    // Export from the editor.
    await row.locator('[data-as="edit"]').click();
    const downloading = page.waitForEvent('download');
    await page.locator('#assistantDialog [data-fd-export]').click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('latin-tutor.assistant.json');
    const doc = JSON.parse(readFileSync(/** @type {string} */ (await download.path()), 'utf8'));
    expect(doc.schema).toBe('starpi.assistant/v1');
    expect(doc.assistant).toMatchObject({ name: 'Latin tutor', icon: 'graduation-cap', starters: ['Decline the word rosa'], tools: [] });
    await page.keyboard.press('Escape');
    await expect(page.locator('#assistantDialog')).toHaveCount(0);

    // Import: tools an assistant may not use (code execution) are left out and named.
    const file = { schema: 'starpi.assistant/v1', assistant: { name: 'Coach', instructions: 'Ask one question at a time.', tools: ['code_interpreter', 'thinking'] } };
    await page.setInputFiles('#chat-sidebar [data-as-file]', { name: 'coach.assistant.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
    await expect(row).toHaveCount(2);
    await expect(page.locator('#toastRegion')).toContainText('without the tools it may not use: code_interpreter');
    await page.setInputFiles('#chat-sidebar [data-as-file]', { name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{"schema":"something/else"}') });
    await expect(page.locator('#toastRegion')).toContainText('This file is not a Starpi assistant.');
  });
});
