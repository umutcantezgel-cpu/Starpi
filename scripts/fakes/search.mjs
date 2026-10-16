#!/usr/bin/env node
// Fake web search APIs on 127.0.0.1, answering with results on reserved example domains built from
// the query:
//   GET  /res/v1/web/search?q=&count=   Brave-like; key in X-Subscription-Token
//   POST /search  { query, max_results } Tavily-like; key as Bearer token or api_key in the body
//   GET  /search?q=&format=json          SearXNG-like; no key (format other than json: 403)
// Scenarios (see shared.mjs): results (default), empty (no results). Faults: see shared.mjs.
//
// Usage: node scripts/fakes/search.mjs [--port 4617]
import { createFakeServer, isMain, runStandalone } from './shared.mjs';

export const DEFAULT_PORT = 4617;
const DOMAINS = ['example.com', 'example.org', 'example.net'];
export const MAX_RESULTS = 10;

/** @param {string} q */
const slug = (q) => q.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'topic';

/**
 * Deterministic results for a query.
 * @param {string} query
 * @param {number} count
 */
export function resultsFor(query, count) {
  const q = query.trim().slice(0, 200);
  const n = Math.max(0, Math.min(MAX_RESULTS, Math.floor(count)));
  return Array.from({ length: n }, (_, i) => ({
    title: `${i === 0 ? 'Overview' : `Article ${i + 1}`}: ${q}`,
    url: `https://${DOMAINS[i % DOMAINS.length]}/articles/${slug(q)}-${i + 1}`,
    snippet: `Simulated search result ${i + 1} about ${q}.`,
  }));
}

/**
 * Creates the fake (not yet listening).
 * @param {{ gapMs?: number, latencyMs?: number, cors?: boolean, log?: (line: string) => void }} [options]
 */
export function createSearchFake(options = {}) {
  let counter = 0;
  return createFakeServer(
    {
      name: 'search',
      auth: ({ req, url, path }) => {
        if (path === '/res/v1/web/search') {
          if (url.searchParams.has('key') || url.searchParams.has('api_key')) return 'in_query';
          const token = req.headers['x-subscription-token'];
          return typeof token === 'string' && token.length > 0 ? 'ok' : 'missing';
        }
        return 'ok'; // Tavily checks its key with the body below; SearXNG has none
      },
      errorBody: (status, kind) => ({ type: 'ErrorResponse', error: { status, code: kind === 'auth' ? 'SUBSCRIPTION_TOKEN_INVALID' : kind.toUpperCase(), detail: `Simulated ${kind} error.` } }),
      async handle(ctx) {
        const method = ctx.req.method;
        const empty = ctx.control.scenario === 'empty';
        counter += 1;
        if (method === 'GET' && ctx.path === '/res/v1/web/search') {
          const q = ctx.url.searchParams.get('q') ?? '';
          if (!q.trim()) return ctx.send(422, { type: 'ErrorResponse', error: { status: 422, code: 'VALIDATION', detail: 'q is required' } });
          const results = empty ? [] : resultsFor(q, Number(ctx.url.searchParams.get('count') ?? 5));
          return ctx.send(200, {
            type: 'search',
            query: { original: q, more_results_available: false },
            web: {
              type: 'search',
              family_friendly: true,
              results: results.map((r) => ({ type: 'search_result', title: r.title, url: r.url, description: r.snippet, age: 'January 1, 2026', language: 'en', meta_url: { hostname: new URL(r.url).hostname } })),
            },
          });
        }
        if (method === 'POST' && ctx.path === '/search') {
          const bearer = /^Bearer (\S+)$/.exec(String(ctx.req.headers.authorization ?? ''))?.[1];
          const key = bearer ?? (typeof ctx.json?.api_key === 'string' ? ctx.json.api_key : '');
          if (!key) return ctx.send(401, { detail: { error: 'Unauthorized: missing or invalid API key.' } });
          const query = typeof ctx.json?.query === 'string' ? ctx.json.query : '';
          if (!query.trim()) return ctx.send(400, { detail: { error: 'query is required' } });
          const results = empty ? [] : resultsFor(query, Number(ctx.json.max_results ?? 5));
          return ctx.send(200, {
            query,
            answer: ctx.json.include_answer && !empty ? `A simulated short answer about ${query.slice(0, 60)}.` : null,
            images: [],
            results: results.map((r, i) => ({ title: r.title, url: r.url, content: r.snippet, score: Math.round((0.95 - i * 0.05) * 100) / 100, raw_content: null })),
            response_time: '0.12',
            request_id: `req_${counter}fake`,
          });
        }
        if (method === 'GET' && ctx.path === '/search') {
          if (ctx.url.searchParams.get('format') !== 'json') return ctx.sendBytes(403, Buffer.from('Forbidden'), 'text/plain');
          const q = ctx.url.searchParams.get('q') ?? '';
          const results = empty || !q.trim() ? [] : resultsFor(q, 5);
          return ctx.send(200, { query: q, number_of_results: results.length, results: results.map((r, i) => ({ url: r.url, title: r.title, content: r.snippet, engine: 'fake', score: 1 / (i + 1) })), answers: [], suggestions: [], unresponsive_engines: [] });
        }
        return false;
      },
    },
    options,
  );
}

if (isMain(import.meta.url)) {
  await runStandalone('search', (common) => createSearchFake({ ...common, log: (l) => console.log(l) }), { envPort: 'FAKE_SEARCH_PORT', defaultPort: DEFAULT_PORT });
}
