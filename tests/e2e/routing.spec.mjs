// Auto routing end to end against the user's own server (the OpenAI-compatible fake as an Ollama
// server): with a file in the workspace, a question it does not match is answered freely, a
// question it matches well is answered from it through a context pack (short [S1] labels, expanded
// to the file's citation before the source check, which passes), and a question it matches weakly
// gets a mixed answer with its checked parts marked. Every answer carries its label. Without a file
// or a library document, a question that names files stays free; with one, a how-to question about
// files stays free and a reference to the user's notes goes to the sources.
import { expect, mockSupabase, sseBody, storedChatNodes, test } from './fixtures.mjs';

const FAKES = Number(process.env.STARPI_FAKES_PORT || 4610);
const SERVER = `http://127.0.0.1:${FAKES + 1}/flavor/ollama/v1`;
const HANDBOOK = [
  '# Team handbook',
  '',
  '## Budget',
  '',
  'The steering board approved a budget of 480,000 EUR for Project Nebula in March. Hardware takes 120,000 EUR and staff costs take 300,000 EUR. The finance team reviews spending every quarter and reports to the steering board.',
  '',
  '## Remote work',
  '',
  'Staff may work remotely on up to two days per week after approval by their team lead. Core hours are from 10:00 to 15:00. The company provides a laptop and a headset; a second monitor can be requested through the service desk.',
  '',
  '## Canteen',
  '',
  'The canteen opens at 08:00 and serves lunch from 11:30 to 14:00. A vegetarian dish is offered every day and there is a fish menu on Fridays.',
].join('\n');

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };

/** @param {import('@playwright/test').Page} page @param {string} text */
async function ask(page, text) {
  await page.fill('#chatInput', text);
  await page.press('#chatInput', 'Enter');
}

/** @param {import('@playwright/test').Page} page */
const answers = (page) => page.locator('#chatMessages .message-row[data-role="assistant"]');

/** @param {import('@playwright/test').Page} page */
async function settled(page) {
  await expect(page.locator('#stopBtn')).toBeHidden();
  await expect(answers(page).last()).toHaveAttribute('data-node-id', /.+/);
  await expect(answers(page).last().locator('[data-action="msg-copy"]')).toBeVisible();
}

/** @param {import('@playwright/test').Page} page @param {'chat' | 'ingest'} tab */
async function openTab(page, tab) {
  const isMobile = (page.viewportSize()?.width ?? 1280) < 768;
  await page.click(isMobile ? `#mobile-nav-${tab}` : `#nav-${tab}`);
  await expect(page.locator(`#tab-${tab}`)).toBeVisible();
}

/** @param {any} message */
const textOf = (message) => (typeof message?.content === 'string' ? message.content : (message?.content ?? []).map((/** @type {any} */ p) => p.text ?? '').join(''));

/**
 * The own server in Auto with an empty knowledge base; chat requests are recorded, and a request
 * with a context pack is answered with a short label.
 * @param {import('@playwright/test').Page} page
 */
async function ownServer(page) {
  await mockSupabase(page, { hardened: true, anonymousAuth: true });
  await page.route(/^https:\/\/[a-z0-9]+\.supabase\.co\/rest\/v1\/knowledge_documents/, (route) =>
    route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-methods': '*' } }) : route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: '[]' }),
  );
  await page.addInitScript(
    ([url]) => {
      if (sessionStorage.getItem('e2e_seeded')) return;
      sessionStorage.setItem('e2e_seeded', '1');
      localStorage.setItem('starpi_llm_url', url);
      localStorage.setItem('starpi_assistant_v1', 'local:*');
      localStorage.setItem('starpi_chat_mode', 'auto');
    },
    [SERVER],
  );
  /** @type {any[]} */
  const bodies = [];
  await page.route(`${SERVER}/chat/completions`, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const body = JSON.parse(req.postData() ?? '{}');
    bodies.push(body);
    if (!textOf(body.messages.at(-1)).includes('<<<SOURCES>>>')) return route.continue();
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: sseBody({ content: ['Core hours are from 10:00 to 15:00 [S1].'] }) });
  });
  return bodies;
}

test.describe('Auto routing', () => {
  test('stays free without files whatever the question names, and with a file keeps how-to questions free', async ({ page, diagnostics: _diagnostics }) => {
    const bodies = await ownServer(page);
    await page.goto('/');
    const packed = () => bodies.filter((b) => textOf(b.messages.at(-1)).includes('<<<SOURCES>>>'));

    // Nothing to answer from: questions that mention files or notes are answered freely.
    for (const question of ['How do I replace a string in the file using sed?', 'Summarize my notes, please.']) {
      await ask(page, question);
      await settled(page);
      await expect(answers(page).last().locator('[data-answer-label="free"]')).toHaveText('Free chat · not checked');
    }
    expect(packed()).toHaveLength(0);
    expect(bodies.some((b) => textOf(b.messages[0]).includes('Answer only from the context below'))).toBe(false);

    // With a file: a how-to question about files stays free, a reference to the notes is answered from them.
    await openTab(page, 'ingest');
    await page.setInputFiles('#workspaceFileInput', { name: 'handbook.md', mimeType: 'text/markdown', buffer: Buffer.from(HANDBOOK) });
    await expect(page.locator('#workspaceList li')).toHaveCount(1);
    await openTab(page, 'chat');
    await ask(page, 'How do I search for a word in the file with grep?');
    await settled(page);
    await expect(answers(page).last().locator('[data-answer-label="free"]')).toBeVisible();
    expect(packed()).toHaveLength(0);
    await ask(page, 'According to my notes, when do the core hours start?');
    await settled(page);
    await expect(answers(page).last().locator('[data-answer-label="grounded"]')).toHaveText('Checked against your sources');
    expect(packed()).toHaveLength(1);

    const nodes = (await storedChatNodes(page)).filter((/** @type {any} */ n) => n.role === 'assistant');
    expect(nodes.map((/** @type {any} */ n) => n.label)).toEqual(['free', 'free', 'free', 'grounded']);
    expect(nodes[3].meta.route_reasons).toEqual(['reference']);
  });

  test('answers freely without a match, from the workspace file through a context pack on a strong match, and mixed on a weak one', async ({ page, diagnostics: _diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    // A knowledge base without documents.
    await page.route(/^https:\/\/[a-z0-9]+\.supabase\.co\/rest\/v1\/knowledge_documents/, (route) =>
      route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-methods': '*' } }) : route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: '[]' }),
    );
    await page.addInitScript(
      ([url]) => {
        if (sessionStorage.getItem('e2e_seeded')) return;
        sessionStorage.setItem('e2e_seeded', '1');
        localStorage.setItem('starpi_llm_url', url);
        localStorage.setItem('starpi_assistant_v1', 'local:*');
        localStorage.setItem('starpi_chat_mode', 'auto');
      },
      [SERVER],
    );
    // The own server answers questions that come with a context pack with the pack's short labels;
    // everything else goes on to the fake. Every chat request is recorded.
    /** @type {any[]} */
    const bodies = [];
    await page.route(`${SERVER}/chat/completions`, async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const body = JSON.parse(req.postData() ?? '{}');
      bodies.push(body);
      const last = textOf(body.messages.at(-1));
      if (!last.includes('<<<SOURCES>>>')) return route.continue();
      const content = /general knowledge/.test(String(body.messages[0]?.role === 'system' ? textOf(body.messages[0]) : ''))
        ? ['The steering board approved a budget of 480,000 EUR for Project Nebula [S1]. ', 'In general, a plan for the next year starts from what was actually spent.']
        : ['The steering board approved a budget of ', '480,000 EUR for Project Nebula [S1].'];
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: sseBody({ content }) });
    });
    await page.goto('/');

    await openTab(page, 'ingest');
    await page.setInputFiles('#workspaceFileInput', { name: 'handbook.md', mimeType: 'text/markdown', buffer: Buffer.from(HANDBOOK) });
    await expect(page.locator('#workspaceList li')).toHaveCount(1);
    await openTab(page, 'chat');

    // Nothing in the workspace matches: a free answer, labelled as such, without a source check.
    await ask(page, 'What is the capital of France?');
    await settled(page);
    const free = answers(page).last();
    await expect(free.locator('[data-answer-label="free"]')).toHaveText('Free chat · not checked');
    await expect(free.locator('.grounding-bar')).toHaveCount(0);
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.some((b) => textOf(b.messages.at(-1)).includes('<<<SOURCES>>>'))).toBe(false);

    // A strong match: the answer comes from the file through a context pack.
    await ask(page, 'What budget did the steering board approve for Project Nebula?');
    await settled(page);
    const grounded = answers(page).last();
    await expect(grounded.locator('[data-answer-label="grounded"]')).toHaveText('Checked against your sources');
    await expect(grounded.locator('[data-provenance="checked"]')).toBeVisible();
    const bar = grounded.locator('.grounding-bar');
    await expect(bar).toHaveClass(/grounding-ok/);
    await expect(bar).toContainText('1/1 statements');
    await expect(grounded.locator('.message-content [data-action="open-citation"]')).toContainText('handbook.md');
    await expect(grounded.locator('.message-content')).not.toContainText('[S1]');
    await expect(grounded.locator('[data-action="open-receipt"]')).toBeVisible();
    const packedBodies = () => bodies.filter((b) => textOf(b.messages.at(-1)).includes('<<<SOURCES>>>'));
    const packed = packedBodies().at(-1);
    expect(textOf(packed.messages[0])).toContain('Answer only from the context below');
    const user = textOf(packed.messages.at(-1));
    expect(user).toMatch(/^Context:\n<<<SOURCES>>>\n\[S1\] handbook\.md — /);
    expect(user).toContain('480,000 EUR');
    expect(user.endsWith('Question: What budget did the steering board approve for Project Nebula?')).toBe(true);
    expect(JSON.stringify(packed)).not.toContain('<<<EXCERPT');

    // A weaker match: sources for what they cover, general knowledge marked.
    await ask(page, 'How should the steering board plan the Nebula budget for next year?');
    await settled(page);
    const mixed = answers(page).last();
    await expect(mixed.locator('[data-answer-label="mixed"]')).toHaveText('Partly from sources (checked parts marked)');
    const marks = mixed.locator('.mixed-marks');
    await expect(marks).toContainText('1 of 2 statements found in your sources');
    await marks.locator('summary').click();
    await expect(marks.locator('[data-mark="from_sources"]')).toHaveCount(1);
    await expect(marks.locator('[data-mark="not_in_sources"]')).toHaveCount(1);
    expect(packedBodies().length).toBe(2);
    expect(textOf(packedBodies()[1].messages[0])).toContain('general knowledge');

    const nodes = (await storedChatNodes(page)).filter((/** @type {any} */ n) => n.role === 'assistant');
    expect(nodes.map((/** @type {any} */ n) => n.label)).toEqual(['free', 'grounded', 'mixed']);
    expect(nodes[1].meta.route_reasons).toEqual(['probe_strong']);
    expect(nodes[2].meta.route_reasons).toEqual(['probe_weak']);
    expect(nodes[1].parts[0].text).toBe('The steering board approved a budget of 480,000 EUR for Project Nebula [Doc: handbook.md, Chunk: 1].');
  });
});
