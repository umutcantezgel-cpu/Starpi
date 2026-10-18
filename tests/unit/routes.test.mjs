// The function routes: vercel.json (functions and rewrites) is the route table, scripts/lib/routes.mjs
// reads it, and scripts/serve.mjs --functions serves it locally under the production headers. The
// routes that later work packages fill in answer 501 until then.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { headersFor, resolveHeaderRules } from '../../scripts/lib/headers.mjs';
import { compilePattern, functionPath, functionRoutes, matchRoute } from '../../scripts/lib/routes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const vercel = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

/** Routes that later work packages implement; until then each answers 501 (none left since voice and research). */
/** @type {string[]} */
const STUBS = [];

describe('route patterns', () => {
  it('maps a function file to its path', () => {
    assert.equal(functionPath('api/health.js'), '/api/health');
    assert.equal(functionPath('api/models/pool.js'), '/api/models/pool');
    assert.throws(() => functionPath('api/../x.js'), /unexpected function file/);
  });

  it('matches one segment, the rest, and literals', () => {
    const { re, names } = compilePattern('/api/relay/:provider/:path*');
    assert.deepEqual(names, ['provider', 'path']);
    assert.deepEqual(re.exec('/api/relay/openai/v1/chat/completions')?.slice(1), ['openai', 'v1/chat/completions']);
    assert.deepEqual(re.exec('/api/relay/openai')?.slice(1), ['openai', undefined]);
    assert.equal(re.test('/api/relay'), false);
    assert.equal(re.test('/api/relayx/openai/v1'), false);
    assert.equal(compilePattern('/api/a/:rest+').re.test('/api/a'), false);
    assert.equal(compilePattern('/api/a.b').re.test('/api/aXb'), false);
    assert.throws(() => compilePattern('/api/:rest*/x'), /must be the last segment/);
    assert.throws(() => compilePattern('api/x'), /must start with/);
  });

  it('prefers the exact function path over a rewrite, and reports parameters', () => {
    const routes = functionRoutes(vercel);
    assert.equal(matchRoute(routes, '/api/relay')?.route.file, 'api/relay.js');
    const relay = matchRoute(routes, '/api/relay/anthropic/v1/messages');
    assert.equal(relay?.route.file, 'api/relay.js');
    assert.deepEqual(relay?.params, { provider: 'anthropic', path: 'v1/messages' });
    assert.deepEqual(matchRoute(routes, '/api/relay/anthropic')?.params, { provider: 'anthropic', path: '' });
    assert.equal(matchRoute(routes, '/api/unknown'), null);
    assert.throws(() => functionRoutes({ functions: {}, rewrites: [{ source: '/x', destination: '/api/none' }] }), /which is no function/);
  });
});

describe('vercel.json route table', () => {
  const functions = vercel.functions;

  it('lists every function file under api/, and every listed file exists', () => {
    const files = readdirSync(path.join(ROOT, 'api'), { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.js'))
      .map((d) => path.relative(ROOT, path.join(d.parentPath, d.name)).split(path.sep).join('/'))
      .filter((f) => !f.startsWith('api/_lib/'))
      .sort();
    assert.deepEqual(Object.keys(functions).sort(), files);
    for (const file of STUBS) assert.ok(existsSync(path.join(ROOT, file)), file);
  });

  it('gives streaming routes five minutes with cancellation and quick routes ten seconds', () => {
    for (const file of ['api/relay.js', 'api/pool.js', 'api/research/step.js', 'api/chat/nvidia.js']) {
      assert.deepEqual(functions[file], { maxDuration: 300, supportsCancellation: true }, file);
    }
    for (const file of ['api/health.js', 'api/models/pool.js', 'api/models/nvidia.js', 'api/voice/live-token.js', 'api/voice/voices.js']) {
      assert.equal(functions[file].maxDuration, 10, file);
    }
  });

  it('rewrites provider paths of the relay to the relay function', () => {
    assert.deepEqual(vercel.rewrites, [{ source: '/api/relay/:provider/:path*', destination: '/api/relay' }]);
  });

  it('has stubs that answer every method with 501 not_implemented', async () => {
    for (const file of STUBS) {
      const mod = await import(pathToFileURL(path.join(ROOT, file)).href);
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const res = await mod[method](new Request('http://127.0.0.1/x', { method }));
        assert.equal(res.status, 501, `${method} ${file}`);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        if (method !== 'HEAD') assert.deepEqual(await res.json(), { error: 'not_implemented' });
      }
    }
  });
});

describe('scripts/serve.mjs --functions', () => {
  /** @type {import('node:child_process').ChildProcess} */
  let server;
  let base = '';
  const profile = 'self-host';

  before(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'starpi-serve-'));
    writeFileSync(path.join(dir, 'index.html'), '<!DOCTYPE html><title>t</title>');
    writeFileSync(path.join(dir, 'build-manifest.json'), JSON.stringify({ profile }));
    const env = { ...process.env, NVIDIA_API_KEYS: '', GEMINI_API_KEYS: '', STARPI_ALLOWED_ORIGINS: '', NVIDIA_ALLOWED_ORIGINS: '', RELAY_ALLOWED_ORIGINS: '', STARPI_ACCESS_CODE: '' };
    server = spawn(process.execPath, [path.join(ROOT, 'scripts/serve.mjs'), '--port', '0', '--dir', dir, '--functions'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    server.stdout?.setEncoding('utf8');
    for await (const chunk of /** @type {import('node:stream').Readable} */ (server.stdout)) {
      out += chunk;
      const m = /at (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) {
        base = m[1];
        break;
      }
    }
    assert.match(out, new RegExp(`profile ${profile}`));
  });

  after(async () => {
    server.kill();
    await once(server, 'exit');
  });

  it('answers the new routes under the production headers of the build profile', async () => {
    const expected = headersFor(resolveHeaderRules(profile), '/api/health');
    for (const [method, url, status, error] of [
      ['GET', '/api/health', 200],
      ['POST', '/api/pool', 404, 'unknown_pool'],
      ['GET', '/api/models/pool', 200],
      ['POST', '/api/relay/openai/v1/chat/completions', 401, 'key_required'],
      ['GET', '/api/relay/gemini/v1beta/models', 401, 'key_required'],
      ['POST', '/api/voice/speak', 415, 'unsupported_media_type'],
      ['POST', '/api/voice/transcribe', 415, 'unsupported_media_type'],
      ['GET', '/api/voice/voices', 200],
      ['POST', '/api/voice/live-token', 415, 'unsupported_media_type'],
      ['POST', '/api/research/step', 503, 'research_not_configured'],
    ]) {
      const res = await fetch(base + url, { method, headers: { origin: base } });
      assert.equal(res.status, status, `${method} ${url}`);
      const body = await res.json();
      if (error) assert.deepEqual(body, { error }, `${method} ${url}`);
      for (const name of ['content-security-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'referrer-policy']) {
        assert.equal(res.headers.get(name), expected.get(name)?.value, `${url} ${name}`);
      }
    }
  });

  it('keeps the NVIDIA routes working', async () => {
    const models = await fetch(`${base}/api/models/nvidia`);
    assert.equal(models.status, 200);
    assert.equal((await models.json()).configured, false);
    const chat = await fetch(`${base}/api/chat/nvidia`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(chat.status, 403);
    assert.deepEqual(await chat.json(), { error: 'origin_required' });
  });

  /**
   * A request sent as written (fetch would normalize the path first).
   * @param {string} rawPath
   * @param {Record<string, string>} [headers]
   * @returns {Promise<number | undefined>}
   */
  const rawStatus = (rawPath, headers = {}) =>
    new Promise((resolve, reject) => {
      const { hostname, port } = new URL(base);
      const req = httpRequest({ hostname, port, path: rawPath, headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });

  it('serves no function for an unknown route, a foreign host name or an ambiguous path', async () => {
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    // An encoded separator would let one file be requested under another path's headers.
    for (const url of ['/render-frame%2F..%2Findex.html', '/assets/%5c..%5cindex.html', '/assets%2fx.js']) {
      assert.equal(await rawStatus(url), 400, url);
    }
    // Dot segments are resolved before anything else, so the path and its headers name the same file.
    assert.equal(await rawStatus('/assets/%2e%2e/index.html'), 200);
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(await rawStatus('/api/health', { host: 'rebound.example' }), 403);
    assert.equal(await rawStatus('/api/health', { host: 'localhost' }), 200);
  });
});
