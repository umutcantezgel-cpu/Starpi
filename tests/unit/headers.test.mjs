// Response headers from one source (scripts/headers.json through scripts/lib/headers.mjs): the
// profiles, cross-origin isolation, the sandboxed frame rules, header parity, the digest that
// versions the build and the generated vercel.json.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderVercelJson } from '../../scripts/gen-headers.mjs';
import {
  BUILD_PROFILES,
  CORE_PROFILES,
  cspFor,
  DEFAULT_PROFILE,
  expectedParity,
  FRAME_PATHS,
  headersDigest,
  headersFor,
  loadHeaderConfig,
  parityOf,
  parseCsp,
  PROFILES,
  resolveHeaderRules,
  toRegExp,
} from '../../scripts/lib/headers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIVE_SOCKET = 'wss://generativelanguage.googleapis.com';

/** @param {string} profile @param {string} [pathname] */
const served = (profile, pathname = '/') => Object.fromEntries([...headersFor(resolveHeaderRules(profile), pathname)].map(([name, h]) => [name, h.value]));
/** @param {string} profile @param {string} [pathname] */
const cspOf = (profile, pathname = '/') => parseCsp(served(profile, pathname)['content-security-policy'] ?? '');

describe('header profiles', () => {
  it('knows the static hosts, the test build and the companion', () => {
    assert.deepEqual([...PROFILES], ['public', 'self-host', 'test']);
    assert.deepEqual([...CORE_PROFILES], ['companion']);
    assert.deepEqual([...BUILD_PROFILES], ['public', 'self-host', 'test', 'companion']);
    assert.equal(DEFAULT_PROFILE, 'public');
    assert.throws(() => resolveHeaderRules('staging'), /unknown header profile "staging"/);
  });

  it('isolates every profile across origins and sends no referrer', () => {
    for (const profile of BUILD_PROFILES) {
      const page = served(profile);
      assert.equal(page['cross-origin-opener-policy'], 'same-origin', profile);
      assert.equal(page['cross-origin-embedder-policy'], 'require-corp', profile);
      assert.equal(page['cross-origin-resource-policy'], 'same-origin', profile);
      assert.equal(page['origin-agent-cluster'], '?1', profile);
      assert.equal(page['referrer-policy'], 'no-referrer', profile);
      assert.equal(page['x-frame-options'], 'DENY', profile);
      const csp = cspOf(profile);
      assert.deepEqual(csp['script-src'], ["'self'", "'wasm-unsafe-eval'"], profile);
      assert.deepEqual(csp['frame-src'], ["'self'"], profile);
      assert.deepEqual(csp['frame-ancestors'], ["'none'"], profile);
      assert.deepEqual(csp['media-src'], ["'none'"], profile);
      assert.doesNotMatch(page['content-security-policy'], /'unsafe-(?:inline|eval|hashes)'/, profile);
    }
  });

  it('names the Live socket only in the profile public, and loopback sockets only in the test build', () => {
    const google = (/** @type {string} */ profile) => (cspOf(profile)['connect-src'] ?? []).filter((s) => /google/i.test(s));
    assert.deepEqual(google('public'), [LIVE_SOCKET]);
    for (const profile of ['self-host', 'test', 'companion']) assert.deepEqual(google(profile), [], profile);
    assert.ok(cspOf('test')['connect-src'].includes('ws://127.0.0.1:*'));
    assert.ok(!cspOf('public')['connect-src'].some((s) => s.startsWith('ws:')));
    assert.deepEqual(cspOf('companion')['connect-src'], ["'self'", 'data:']);
  });

  it('allows microphone and camera for the app itself, the camera nowhere in the companion build', () => {
    for (const profile of PROFILES) {
      const policy = served(profile)['permissions-policy'].split(',').map((d) => d.trim());
      assert.ok(policy.includes('microphone=(self)') && policy.includes('camera=(self)'), profile);
      assert.ok(policy.includes('geolocation=()'), profile);
    }
    assert.ok(served('companion')['permissions-policy'].includes('camera=()'));
  });

  it('keeps the existing cache rules', () => {
    assert.equal(served('public', '/assets/main-ABC.js')['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(served('public', '/sw.js')['cache-control'], 'no-cache, no-store, must-revalidate');
    assert.equal(served('public', '/sw.js')['service-worker-allowed'], '/');
    assert.equal(served('public', '/')['cache-control'], 'no-cache');
    assert.equal(served('public', '/manifest.webmanifest')['content-type'], 'application/manifest+json');
    assert.equal(served('companion', '/build-manifest.json')['cache-control'], 'no-cache');
    assert.equal(served('public', '/build-manifest.json')['cache-control'], undefined);
  });
});

describe('sandboxed frames', () => {
  it('serves the render frame in an opaque origin that cannot connect anywhere', () => {
    for (const url of ['/render-frame', '/render-frame.html', '/render-frame.js']) {
      for (const profile of BUILD_PROFILES) {
        const csp = cspOf(profile, url);
        assert.deepEqual(csp, {
          'default-src': ["'none'"],
          'script-src': ["'self'", "'unsafe-inline'"],
          'style-src': ["'unsafe-inline'"],
          'img-src': ['data:', 'blob:'],
          'connect-src': ["'none'"],
          'form-action': ["'none'"],
          'frame-ancestors': ["'self'"],
          sandbox: ['allow-scripts'],
        }, `${profile} ${url}`);
        const headers = served(profile, url);
        assert.equal(headers['x-frame-options'], 'SAMEORIGIN');
        // Its script is requested from the opaque origin: a cross-origin request under COEP.
        assert.equal(headers['cross-origin-resource-policy'], 'cross-origin');
        assert.equal(headers['cross-origin-embedder-policy'], 'require-corp');
      }
    }
  });

  it('serves the grounding frame without inline scripts, and not at all in the companion build', () => {
    for (const url of ['/grounding-frame', '/grounding-frame.html', '/grounding-frame.js']) {
      const csp = cspOf('public', url);
      assert.deepEqual(csp['script-src'], ["'self'"]);
      assert.deepEqual(csp['default-src'], ["'none'"]);
      assert.deepEqual(csp['frame-ancestors'], ["'self'"]);
      assert.ok(!csp.sandbox.includes('allow-same-origin'));
      assert.equal(served('companion', url)['content-security-policy'], served('companion')['content-security-policy']);
    }
  });

  it('matches exact paths only, so no other spelling picks up the relaxed headers', () => {
    const page = served('public')['content-security-policy'];
    for (const url of ['/render-frame/', '/render-frame.html/x', '/render-frame%2F..%2Findex.html', '/assets/render-frame.js', '/x/grounding-frame']) {
      assert.equal(served('public', url)['content-security-policy'], page, url);
    }
    assert.ok(toRegExp('/assets/(.*)').test('/assets/a/b.js'));
    assert.ok(!toRegExp('/sw.js').test('/swXjs'));
  });
});

describe('header parity', () => {
  it('expects the page headers everywhere but at the frame paths', () => {
    const rules = resolveHeaderRules('public');
    const page = parityOf(headersFor(rules, '/'));
    for (const url of ['/index.html', '/sw.js', '/assets/main-ABC.js', '/icons/icon.svg', '/api/health']) {
      assert.deepEqual(expectedParity(rules, url), page, url);
      assert.deepEqual(parityOf(headersFor(rules, url)), page, url);
    }
    for (const url of FRAME_PATHS) {
      const expected = expectedParity(rules, url);
      assert.deepEqual(parityOf(headersFor(rules, url)), expected, url);
      assert.notEqual(expected['content-security-policy'], page['content-security-policy']);
      assert.equal(expected['permissions-policy'], page['permissions-policy']);
      assert.equal(expected['cross-origin-opener-policy'], page['cross-origin-opener-policy']);
    }
  });
});

describe('header digest', () => {
  it('is stable for the same rules and changes with any header', () => {
    const config = loadHeaderConfig();
    const digest = headersDigest(resolveHeaderRules('public', config));
    assert.match(digest, /^[0-9a-f]{16}$/);
    assert.equal(headersDigest(resolveHeaderRules('public', loadHeaderConfig())), digest);
    assert.notEqual(headersDigest(resolveHeaderRules('self-host', config)), digest);
    const changed = structuredClone(config);
    changed.rules[0].headers['Referrer-Policy'] = 'same-origin';
    assert.notEqual(headersDigest(resolveHeaderRules('public', changed)), digest);
  });

  it('refuses a value missing for a profile and an unknown placeholder', () => {
    const config = loadHeaderConfig();
    assert.throws(() => cspFor({ 'connect-src': { public: "'self'" } }, 'test'), /csp\.connect-src has no value for the profile "test"/);
    const broken = structuredClone(config);
    broken.rules[0].headers['X-Probe'] = '{{nonce}}';
    assert.throws(() => resolveHeaderRules('public', broken), /unknown placeholder \{\{nonce\}\}/);
  });
});

describe('vercel.json', () => {
  const vercel = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

  it('carries the generated headers of the profile public', () => {
    assert.deepEqual(vercel.headers, resolveHeaderRules('public'));
    assert.equal(renderVercelJson(vercel), readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'), 'run npm run headers:gen');
  });

  it('npm run headers:check passes now, fails for a stale file, and headers:gen repairs it', () => {
    const run = (/** @type {string[]} */ args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/gen-headers.mjs'), ...args], { cwd: ROOT, encoding: 'utf8' });
    const ok = run(['--check']);
    assert.equal(ok.status, 0, ok.stderr);
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'starpi-headers-')), 'vercel.json');
    const stale = { ...vercel, headers: vercel.headers.map((/** @type {{ source: string }} */ rule) => (rule.source === '/(.*)' ? { ...rule, headers: [] } : rule)) };
    writeFileSync(file, JSON.stringify(stale, null, 2));
    const refused = run(['--check', '--file', file]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /out of date/);
    assert.equal(run(['--file', file]).status, 0);
    const repaired = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(repaired, vercel, 'every other key is kept and the headers are regenerated');
  });
});
