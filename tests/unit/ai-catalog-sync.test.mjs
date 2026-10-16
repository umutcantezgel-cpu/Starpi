// scripts/sync-model-catalog.mjs: the committed snapshot and NVIDIA mirror are what the script
// writes (--check, also through the nvidia:sync alias), the canonical form is stable, validation
// finds broken entries, a live list refreshes curated entries, and no output line ever carries a
// key.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAnthropicFake } from '../../scripts/fakes/anthropic.mjs';
import { keyFromEnv, main, normalizeSnapshot, refreshSection, SNAPSHOT_FILE, snapshotText, validateSnapshot } from '../../scripts/sync-model-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const committed = readFileSync(path.join(ROOT, SNAPSHOT_FILE), 'utf8');

describe('model catalog sync', () => {
  it('finds the committed files up to date, directly and through the NVIDIA alias', () => {
    for (const script of ['scripts/sync-model-catalog.mjs', 'scripts/sync-nvidia-catalog.mjs']) {
      const out = execFileSync(process.execPath, [script, '--check'], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
      assert.match(out, /snapshot\.json is up to date/);
      assert.match(out, /nvidia_catalog\.json is up to date/);
    }
  });

  it('keeps the committed snapshot in its canonical form', () => {
    assert.equal(snapshotText(normalizeSnapshot(JSON.parse(committed))), committed);
    assert.deepEqual(validateSnapshot(JSON.parse(committed)), []);
  });

  it('reports broken entries', () => {
    const broken = JSON.parse(committed);
    broken.providers.openai.roles.max = 'gone';
    broken.providers.openai.models.push({ ...broken.providers.openai.models[0] });
    broken.providers.groq.models[0].caps.contextTokens = 0;
    broken.providers.someone = { roles: {}, models: [] };
    const problems = validateSnapshot(broken);
    assert.ok(problems.some((p) => p.startsWith('openai: role max names gone')));
    assert.ok(problems.includes('openai: duplicate model ids'));
    assert.ok(problems.some((p) => p.startsWith('groq/') && p.includes('contextTokens')));
    assert.ok(problems.includes('someone: unknown provider'));
  });

  it('refreshes limits and prices from a live list and flags models it no longer names', () => {
    const section = { roles: { fast: 'a' }, models: [{ id: 'a', label: 'A', caps: { contextTokens: 100, maxOutput: 50 } }, { id: 'b', label: 'B', listed: false, caps: { contextTokens: 100, maxOutput: 50 } }, { id: 'c', label: 'C', caps: { contextTokens: 10, maxOutput: 5 } }] };
    const { section: next, listed, unlisted, added } = refreshSection(section, [{ id: 'a', contextTokens: 200, maxOutput: 400, hints: { priceIn: 1, priceOut: 2 } }, { id: 'b' }, { id: 'new' }]);
    assert.deepEqual(next.models[0].caps, { contextTokens: 200, maxOutput: 200, priceIn: 1, priceOut: 2 });
    assert.equal(next.models[1].listed, undefined);
    assert.equal(next.models[2].listed, false);
    assert.deepEqual([listed, unlisted, added], [2, 1, 1]);
  });

  it('reads the first key of a provider from the environment', () => {
    assert.equal(keyFromEnv('groq', { GROQ_API_KEY: ' one ' }), 'one');
    assert.equal(keyFromEnv('groq', { GROQ_API_KEYS: ' , two,three' }), 'two');
    assert.equal(keyFromEnv('groq', {}), null);
  });

  describe('with a live list', () => {
    /** @type {ReturnType<typeof createAnthropicFake>} */
    let fake;
    let url = '';
    before(async () => {
      fake = createAnthropicFake({ gapMs: 0 });
      url = (await fake.listen(0)).url;
    });
    after(() => fake.close());

    /** @type {import('../../src/js/ai/transport.js').FetchLike} */
    const toFake = (input, init) => fetch(String(input).replace('https://api.anthropic.com', url), init);

    it('asks providers with a key and never prints the key', async () => {
      const secret = `sk-ant-${'z'.repeat(40)}`;
      /** @type {string[]} */
      const lines = [];
      const code = await main([], { env: { ANTHROPIC_API_KEY: secret }, fetch: toFake, log: (l) => lines.push(l), error: (l) => lines.push(l), write: false });
      assert.equal(code, 0);
      assert.ok(lines.some((l) => /^anthropic: 3 curated models listed, 0 not listed, 0 more live models not curated$/.test(l)), lines.join('\n'));
      assert.equal(fake.requests.at(-1)?.headers['x-api-key'], secret);
      assert.ok(lines.every((l) => !l.includes(secret) && !l.includes('zzzz')));
    });

    it('keeps the curated entries when a list fails', async () => {
      /** @type {string[]} */
      const lines = [];
      const secret = `sk-ant-${'y'.repeat(40)}`;
      /** @type {import('../../src/js/ai/transport.js').FetchLike} */
      const failing = (input, init) => toFake(`${String(input)}`.replace('/v1/models', '/v1/models-missing'), init);
      const code = await main([], { env: { ANTHROPIC_API_KEY: secret }, fetch: failing, log: (l) => lines.push(l), error: (l) => lines.push(l), write: false });
      assert.equal(code, 0);
      assert.ok(lines.includes('anthropic: model list failed (HTTP 404); curated entries kept'), lines.join('\n'));
      assert.ok(lines.every((l) => !l.includes(secret)));
    });
  });
});
