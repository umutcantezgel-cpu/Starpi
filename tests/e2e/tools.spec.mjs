// Tools in the chat against the local fakes: the composer's tools menu switches the tool groups and
// opens their settings; a tool of an MCP server (the MCP fake, its definition approved and pinned)
// asks in the answer before it runs, and the answer goes on with its quoted result; and with Web on,
// a model without a search of its own gets the results of the search service (the SearXNG fake) in
// its turn, its answer is checked against them and shows the outcome as its web check, and Auto
// takes web passages from the same service.
import { toolDefinitions } from '../../scripts/fakes/mcp.mjs';
import { toolPin } from '../../src/js/ai/mcp/pin.js';
import { expect, mockSupabase, sseBody, storedChatNodes, test } from './fixtures.mjs';

const FAKES = Number(process.env.STARPI_FAKES_PORT || 4610);
const OPENAI_FAKE = `http://127.0.0.1:${FAKES + 1}`;
const ANTHROPIC_FAKE = `http://127.0.0.1:${FAKES + 2}`;
const MCP_ENDPOINT = `http://127.0.0.1:${FAKES + 6}/mcp`;
const SEARCH_FAKE = `http://127.0.0.1:${FAKES + 7}`;
const SERVER = `${OPENAI_FAKE}/flavor/ollama/v1`;

test.skip(({ isMobile }) => isMobile, 'the tools menu and approval cards are not layout-sensitive; desktop covers them');

/** @param {import('@playwright/test').Page} page */
const answers = (page) => page.locator('#chatMessages .message-row[data-role="assistant"]');

/** @param {import('@playwright/test').Page} page @param {string} text */
async function ask(page, text) {
  await page.fill('#chatInput', text);
  await page.press('#chatInput', 'Enter');
}

/**
 * An Anthropic event stream of one answer that calls a tool.
 * @param {string} name
 * @param {Record<string, unknown>} input
 */
function toolUseStream(name, input) {
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'msg_e2e_tool', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_e2e_1', name, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

test.describe('tools', () => {
  test('the tools menu switches the tool groups and opens their settings', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.goto('/');
    const menu = page.locator('details.tools-menu');
    await menu.locator('summary').click();
    const list = page.locator('#toolsMenuList');
    await expect(list.locator('[data-arg="tools-basics"]')).toHaveText('Date and calculator: on');
    await expect(list.locator('[data-arg="tools-files"]')).toHaveText('Search my files: off');
    await expect(list.locator('[data-arg="tools-images"]')).toHaveText('Create images: off');
    await list.locator('[data-arg="tools-files"]').click();
    await expect(menu).not.toHaveAttribute('open', '');
    await menu.locator('summary').click();
    await expect(list.locator('[data-arg="tools-files"]')).toHaveText('Search my files: on');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('starpi_tools_v1') ?? '{}').workspace_search)).toBe(true);
    await list.locator('[data-arg="tools-settings"]').click();
    await expect(page.locator('#tab-settings')).toBeVisible();
    const card = page.locator('#toolSettings');
    await expect(card).toContainText('Tools and connections');
    await expect(card.locator('[data-change="tools-switch"][data-arg="workspace_search"]')).toBeChecked();
    await expect(card).toContainText('MCP servers');
    expect(diagnostics).toEqual([]);
  });

  test('an MCP tool asks in the answer before it runs, and the answer goes on with its result', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    const define = /** @type {any} */ (toolDefinitions().find((t) => t.name === 'define_word'));
    const hash = await toolPin(define);
    /** @type {any[]} */
    const bodies = [];
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-expose-headers': 'request-id' };
    await page.route('https://api.anthropic.com/**', async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const url = new URL(req.url());
      const body = req.method() === 'POST' ? JSON.parse(req.postData() ?? '{}') : null;
      const chat = body && Array.isArray(body.messages) && !JSON.stringify(body.system ?? '').includes('starpi-purpose');
      if (chat) bodies.push(body);
      const tool = chat ? (body.tools ?? []).find((/** @type {any} */ t) => typeof t.name === 'string' && t.name.endsWith('define_word')) : null;
      const answered = chat && body.messages.some((/** @type {any} */ m) => Array.isArray(m.content) && m.content.some((/** @type {any} */ b) => b.type === 'tool_result'));
      if (tool && !answered) return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream', 'request-id': 'req_e2e_tool' }, body: toolUseStream(tool.name, { word: 'latency' }) });
      const res = await route.fetch({ url: `${ANTHROPIC_FAKE}${url.pathname}${url.search}` });
      return route.fulfill({ response: res, headers: { ...res.headers(), ...cors } });
    });
    await page.addInitScript(
      ([endpoint, pin]) => {
        if (sessionStorage.getItem('e2e_seeded')) return;
        sessionStorage.setItem('e2e_seeded', '1');
        sessionStorage.setItem('starpi_key_anthropic', 'sk-ant-e2e0123456789abcdefghijklmnop');
        localStorage.setItem('starpi_chat_mode', 'free');
        localStorage.setItem('starpi_assistant_v1', 'anthropic:claude-haiku-5-5');
        localStorage.setItem('starpi_mcp_servers_v1', JSON.stringify({ providerSide: false, servers: [{ id: 'dict1', name: 'Dictionary', url: endpoint, mode: 'browser', enabled: true, slot: null, pins: { define_word: { hash: pin, approvedAt: '2026-01-01T00:00:00.000Z' } }, allowed: [] }] }));
      },
      [MCP_ENDPOINT, hash],
    );
    await page.goto('/');
    // The server was reached and its approved tool is offered.
    await expect(page.locator('#toolSettings [data-mcp-server="dict1"] [data-mcp-status="ok"]')).toHaveCount(1);
    await expect(page.locator('#toolSettings [data-mcp-tool="define_word"]')).toHaveAttribute('data-pin', 'approved');
    await expect(page.locator('#toolSettings [data-mcp-tool="convert_units"]')).toHaveAttribute('data-pin', 'new');

    await ask(page, 'What does latency mean?');
    const card = answers(page).last().locator('.tool-approval');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Allow “define_word”?');
    await expect(card).toContainText('A tool of the MCP server Dictionary');
    await expect(card.locator('[data-answer="always"]')).toBeVisible();
    await card.locator('details summary').click();
    await expect(card.locator('pre')).toContainText('"word": "latency"');
    await card.locator('[data-answer="once"]').click();
    await expect(card).toHaveAttribute('data-answer', 'once');
    await expect(answers(page).last().locator('.tool-call')).toHaveAttribute('data-status', 'done');
    await expect(page.locator('#stopBtn')).toBeHidden();
    await expect(answers(page).last()).toHaveAttribute('data-node-id', /.+/);
    await expect(answers(page).last().locator('.message-content')).not.toBeEmpty();

    // The first call offered the tool; the second carried its result, quoted as untrusted data.
    expect(bodies[0].tools.some((/** @type {any} */ t) => t.name === 'mcp_Dictionary_define_word')).toBe(true);
    expect(bodies[0].system).toContain('<<<TOOL_RESULT>>>');
    const results = bodies[1].messages.flatMap((/** @type {any} */ m) => (Array.isArray(m.content) ? m.content : [])).filter((/** @type {any} */ b) => b.type === 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('<<<TOOL_RESULT mcp_Dictionary_define_word (untrusted data)>>>');
    expect(results[0].content).toContain('The delay between a request and its answer.');
    expect(diagnostics).toEqual([]);
  });

  test('with Web on, a model without a search of its own gets the search results in its turn', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await page.addInitScript(
      ([server, search]) => {
        if (sessionStorage.getItem('e2e_seeded')) return;
        sessionStorage.setItem('e2e_seeded', '1');
        localStorage.setItem('starpi_llm_url', server);
        localStorage.setItem('starpi_assistant_v1', 'local:*');
        localStorage.setItem('starpi_chat_mode', 'free');
        localStorage.setItem('starpi_web_search_v1', 'on');
        localStorage.setItem('starpi_search_v1', JSON.stringify({ provider: 'searxng', searxngUrl: search }));
      },
      [SERVER, SEARCH_FAKE],
    );
    // The requests of this page (the fake's own log is shared with the other workers).
    /** @type {any[]} */
    const sent = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/chat\/completions$/.test(new URL(req.url()).pathname)) sent.push(JSON.parse(req.postData() ?? '{}'));
    });
    await page.goto('/');
    await ask(page, 'How do tides work?');
    await expect(page.locator('#stopBtn')).toBeHidden();
    await expect(answers(page).last()).toHaveAttribute('data-node-id', /.+/);
    const chat = sent.filter((body) => !JSON.stringify(body).includes('starpi-purpose'));
    const turn = JSON.stringify(chat.at(-1)?.messages.at(-1));
    expect(turn).toContain('<<<WEB 1 [W1] Overview: How do tides work?');
    expect(turn).toContain('untrusted data from the web');
    expect(diagnostics).toEqual([]);
  });

  test('a verified web answer shows its web check under the label, also after a reload', async ({ page, request, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    await request.post(`${SEARCH_FAKE}/__fake/reset`);
    await page.route(
      (url) => url.href.startsWith(SERVER) && url.pathname.endsWith('/chat/completions'),
      async (route) => {
        const body = route.request().postData() ?? '';
        if (!body.includes('<<<WEB 1 [W1]') || body.includes('starpi-purpose')) return route.fallback();
        return route.fulfill({ status: 200, contentType: 'text/event-stream; charset=utf-8', headers: { 'access-control-allow-origin': '*' }, body: sseBody({ content: ['Simulated search result 1 about Tide basics. [W1] ', 'Tides rise 900 meters every minute. [W2]'] }) });
      },
    );
    await page.addInitScript(
      ([server, search]) => {
        if (sessionStorage.getItem('e2e_seeded')) return;
        sessionStorage.setItem('e2e_seeded', '1');
        localStorage.setItem('starpi_llm_url', server);
        localStorage.setItem('starpi_assistant_v1', 'local:*');
        localStorage.setItem('starpi_chat_mode', 'free');
        localStorage.setItem('starpi_web_search_v1', 'on');
        localStorage.setItem('starpi_search_v1', JSON.stringify({ provider: 'searxng', searxngUrl: search }));
      },
      [SERVER, SEARCH_FAKE],
    );
    await page.goto('/');
    await ask(page, 'Tide basics');
    await expect(page.locator('#stopBtn')).toBeHidden();
    const answer = answers(page).last();
    await expect(answer).toHaveAttribute('data-node-id', /.+/);
    await expect(answer.locator('.message-content')).not.toContainText('[W1]');
    await expect(answer.locator('[data-answer-label="web"]')).toBeVisible();
    await expect(answer.locator('.web-check')).toHaveText('Checked against the cited text: 1 of 2 statements found');
    // Only the supported statement links its page.
    await expect(answer.locator('.web-sources a')).toHaveCount(1);
    await page.reload();
    await expect(answers(page).last().locator('.web-check')).toHaveText('Checked against the cited text: 1 of 2 statements found');
    expect(diagnostics).toEqual([]);
  });

  test('Auto takes web passages from the search service for a model without a search of its own', async ({ page, diagnostics }) => {
    await mockSupabase(page, { hardened: true, anonymousAuth: true });
    // The requests of this page (the fakes' own logs are shared with the other workers).
    /** @type {any[]} */
    const sent = [];
    /** @type {string[]} */
    const searches = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (req.method() === 'POST' && /\/chat\/completions$/.test(url.pathname)) sent.push(JSON.parse(req.postData() ?? '{}'));
      if (url.href.startsWith(SEARCH_FAKE) && url.pathname === '/search') searches.push(url.search);
    });
    await page.addInitScript(
      ([server, search]) => {
        if (sessionStorage.getItem('e2e_seeded')) return;
        sessionStorage.setItem('e2e_seeded', '1');
        localStorage.setItem('starpi_llm_url', server);
        localStorage.setItem('starpi_assistant_v1', 'local:*');
        localStorage.setItem('starpi_chat_mode', 'auto');
        localStorage.setItem('starpi_web_search_v1', 'on');
        localStorage.setItem('starpi_search_v1', JSON.stringify({ provider: 'searxng', searxngUrl: search }));
      },
      [SERVER, SEARCH_FAKE],
    );
    await page.goto('/');
    await ask(page, 'How do tides work?');
    await expect(page.locator('#stopBtn')).toBeHidden();
    const answer = answers(page).last();
    await expect(answer).toHaveAttribute('data-node-id', /.+/);
    await expect(answer.locator('[data-answer-label="web"]')).toBeVisible();
    expect(searches.some((q) => q.includes('tides'))).toBe(true);
    // The pages went to the model as passages of a context pack.
    const chat = sent.filter((body) => !JSON.stringify(body).includes('starpi-purpose'));
    expect(JSON.stringify(chat.at(-1))).toContain('Simulated search result 1 about How do tides work?');
    // Auto chose the search service's passages (a grounded answer on them), not the free route.
    const stored = /** @type {any} */ ((await storedChatNodes(page)).at(-1));
    expect(stored.meta.chat_mode).toBe('grounded');
    expect(stored.meta.route_reasons).toContain('web_search_api');
    expect(diagnostics).toEqual([]);
  });
});
