// The shared front guards (api/_lib/origins.js, api/_lib/access.js): the origin allowlist and its
// aliases, the daily budget, the guard order, the optional access code with its constant-time
// comparison (the voice and research routes have their own tests: voice-routes, research-step).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkAccess, readAccessCode, sameSecret } from '../../api/_lib/access.js';
import { createRateLimiter } from '../../api/_lib/guards.js';
import { allowedOrigins, createDailyLimiter, guardRequest } from '../../api/_lib/origins.js';
import { siteRequest } from './relay-helpers.mjs';

describe('allowed origins', () => {
  it('merges STARPI_ALLOWED_ORIGINS with the older NVIDIA_ and RELAY_ names', () => {
    assert.deepEqual(allowedOrigins({}), []);
    assert.deepEqual(
      allowedOrigins({ STARPI_ALLOWED_ORIGINS: 'https://a.example, https://b.example/path', NVIDIA_ALLOWED_ORIGINS: 'https://c.example', RELAY_ALLOWED_ORIGINS: 'https://a.example,ftp://x,not a url' }),
      ['https://a.example', 'https://b.example', 'https://c.example'],
    );
  });
});

describe('daily budget', () => {
  it('counts per address and UTC day, and is off at 0', () => {
    const clock = { t: Date.UTC(2026, 0, 1, 12, 0, 0) };
    const daily = createDailyLimiter({ limit: 2, now: () => clock.t });
    assert.ok(daily.hit('a').ok && daily.hit('a').ok);
    const over = daily.hit('a');
    assert.deepEqual(over, { ok: false, retryAfterS: 12 * 3600 });
    assert.ok(daily.hit('b').ok);
    clock.t = Date.UTC(2026, 0, 2, 0, 0, 1);
    assert.ok(daily.hit('a').ok, 'a new day');
    const off = createDailyLimiter({ limit: 0, now: () => clock.t });
    for (let i = 0; i < 1000; i++) assert.ok(off.hit('a').ok);
  });

  it('forgets earlier days, then the oldest addresses, when full', () => {
    const clock = { t: Date.UTC(2026, 0, 1) };
    const daily = createDailyLimiter({ limit: 1, now: () => clock.t, maxEntries: 2 });
    daily.hit('a');
    daily.hit('b');
    assert.ok(daily.hit('c').ok);
    assert.ok(daily.hit('a').ok, 'the oldest address was dropped and starts again');
  });
});

describe('access code', () => {
  it('compares in constant time over digests, whatever the lengths', async () => {
    assert.equal(await sameSecret('correct horse battery', 'correct horse battery'), true);
    assert.equal(await sameSecret('correct horse batterx', 'correct horse battery'), false);
    assert.equal(await sameSecret('', 'correct horse battery'), false);
    assert.equal(await sameSecret('correct horse battery staple', 'correct horse battery'), false);
  });

  it('is off without STARPI_ACCESS_CODE and wants the x-starpi-access header with it', async () => {
    assert.equal(readAccessCode({ STARPI_ACCESS_CODE: '  code-for-tests-01  ' }), 'code-for-tests-01');
    assert.equal(readAccessCode({}), '');
    const bare = siteRequest('/api/relay/openai/v1/models', { method: 'GET' });
    assert.equal(await checkAccess(bare, ''), null);
    assert.deepEqual(await checkAccess(bare, 'code-for-tests-01'), { status: 401, error: 'access_required' });
    assert.deepEqual(await checkAccess(siteRequest('/x', { method: 'GET', headers: { 'x-starpi-access': 'code-for-tests-02' } }), 'code-for-tests-01'), { status: 401, error: 'access_denied' });
    assert.equal(await checkAccess(siteRequest('/x', { method: 'GET', headers: { 'x-starpi-access': 'code-for-tests-01' } }), 'code-for-tests-01'), null);
  });

  it('runs after the origin check and the rate limit', async () => {
    const guards = { extraOrigins: [], limiter: createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 }), accessCode: 'code-for-tests-01' };
    assert.deepEqual(await guardRequest(siteRequest('/x', { headers: { origin: 'https://evil.example', 'sec-fetch-site': undefined } }), guards), { status: 403, error: 'origin_not_allowed' });
    assert.deepEqual(await guardRequest(siteRequest('/x'), guards), { status: 401, error: 'access_required' });
    assert.equal((await guardRequest(siteRequest('/x', { headers: { 'x-starpi-access': 'code-for-tests-01' } }), guards))?.error, 'rate_limited');
  });
});
