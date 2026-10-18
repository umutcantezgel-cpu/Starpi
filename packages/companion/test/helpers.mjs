// Shared helpers of the companion tests: temporary installations, a companion on a free port and
// small HTTP helpers that set the headers browsers set.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { startCompanion } from '../src/service.js';

/** A fresh temporary folder, removed by the returned cleanup. */
export function tempDir(prefix = 'companion-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A resolved configuration rooted in a temporary folder (no configuration file).
 * @param {string} root
 * @param {Record<string, unknown>} [raw]  members a config.json would hold
 */
export function testConfig(root, raw = {}) {
  const env = { XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state') };
  const base = loadConfig({ env, platform: 'linux', home: root });
  return { ...base, port: 0, ...raw, env };
}

/**
 * Starts a companion on a free port without the egress guard.
 * @param {string} root
 * @param {Record<string, unknown>} [raw]
 * @param {Record<string, unknown>} [options]
 */
export async function startTest(root, raw = {}, options = {}) {
  const config = testConfig(root, raw);
  const companion = await startCompanion({ config, env: {}, ...options });
  return { config, companion, base: companion.url };
}

/**
 * fetch against the companion with explicit browser-like headers.
 * @param {string} url
 * @param {{ method?: string, origin?: string, host?: string, body?: unknown, headers?: Record<string, string> }} [options]
 */
export async function call(url, { method = 'GET', origin, host, body, headers = {} } = {}) {
  const h = { ...headers };
  if (origin) h.origin = origin;
  if (host) h.host = host;
  if (body !== undefined) h['content-type'] = 'application/json';
  // node's fetch refuses a Host header, so a custom Host goes through http.request.
  if (host) {
    const http = await import('node:http');
    const u = new URL(url);
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method, headers: h }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  const res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: Object.fromEntries(res.headers), text, json: () => JSON.parse(text) };
}

/**
 * Pairs through the HTTP route with a code issued by the running companion.
 * @param {import('../src/service.js').Companion} companion
 * @param {{ role?: 'owner' | 'member', origin?: string }} [options]
 */
export async function pairOver(companion, { role = 'owner', origin } = {}) {
  const { code } = companion.sessions.issueCode({ role });
  const res = await call(`${companion.url}/v1/session/pair`, { method: 'POST', body: { code }, origin });
  return { res, body: res.json() };
}
