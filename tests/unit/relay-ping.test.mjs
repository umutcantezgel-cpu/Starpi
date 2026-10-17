// scripts/provider-ping.mjs: "skipped" and exit 0 without a key; with a key, the list, the CORS
// preflight and one stream per pool model against the local fakes, statuses only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findPoolSpec } from '../../api/_lib/pool/allowlist.js';
import { createGeminiFake } from '../../scripts/fakes/gemini.mjs';
import { createOpenAiFake } from '../../scripts/fakes/openai.mjs';
import { pingProvider } from '../../scripts/provider-ping.mjs';
import { testKey } from './relay-helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/provider-ping.mjs');

describe('provider ping without keys', () => {
  it('prints skipped and exits 0', () => {
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
    const run = spawnSync(process.execPath, [SCRIPT, '--provider', 'anthropic'], { env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'anthropic: skipped (no key in ANTHROPIC_API_KEY)');
    const pool = spawnSync(process.execPath, [SCRIPT, '--provider=nvidia'], { env, encoding: 'utf8' });
    assert.equal(pool.status, 0);
    assert.match(pool.stdout, /nvidia: skipped \(no key in NVIDIA_API_KEYS or NVIDIA_API_KEY\)/);
  });

  it('exits 2 without a provider and 1 for an unknown one', () => {
    const env = { PATH: process.env.PATH ?? '' };
    assert.equal(spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync(process.execPath, [SCRIPT, '--provider', 'local'], { env, encoding: 'utf8' }).status, 1);
  });
});

describe('provider ping against the fakes', () => {
  const openai = createOpenAiFake({ gapMs: 0 });
  const gemini = createGeminiFake({ gapMs: 0 });
  let openaiUrl = '';
  let geminiUrl = '';
  before(async () => {
    openaiUrl = (await openai.listen(0)).url;
    geminiUrl = (await gemini.listen(0)).url;
  });
  after(async () => {
    await Promise.all([openai.close(), gemini.close()]);
  });

  it('streams once per pool model and reports the ids the list lacks', async () => {
    /** @type {string[]} */
    const printed = [];
    const key = testKey('groq');
    const result = await pingProvider({ id: 'groq', env: { GROQ_API_KEYS: key, STARPI_GROQ_BASE_URL: `${openaiUrl}/flavor/groq/openai` }, print: (l) => printed.push(l) });
    const models = /** @type {{ models: Array<{ id: string }> }} */ (findPoolSpec('groq')).models;
    assert.equal(printed[0], 'groq: 1 key, simulated provider');
    assert.match(printed[1], /^list: 200 \(2 entries\)$/);
    assert.equal(printed[2], 'browser access (CORS): yes');
    assert.match(printed[3], /^not listed: /, 'the fake lists its own ids');
    for (const m of models) assert.ok(printed.some((l) => l.startsWith(`${m.id} | 200 | `) && l.endsWith('| yes')), m.id);
    assert.equal(result.status, 'failed', 'missing ids fail the check');
    assert.ok(!printed.join('\n').includes(key));
  });

  it('checks one Gemini model with the key in its header', async () => {
    /** @type {string[]} */
    const printed = [];
    const result = await pingProvider({ id: 'gemini', env: { GEMINI_API_KEYS: testKey('gemini'), STARPI_GEMINI_BASE_URL: geminiUrl }, model: 'gemini-2.5-flash', print: (l) => printed.push(l) });
    assert.ok(printed.some((l) => /^gemini-2\.5-flash \| 200 \| \d+ \| yes$/.test(l)), printed.join('\n'));
    assert.equal(gemini.requests.at(-1)?.headers['x-goog-api-key'], testKey('gemini'));
    assert.equal(result.status, 'failed', 'the fake does not list the real ids');
  });

  it('pings a provider without a pool with its single key', async () => {
    /** @type {string[]} */
    const printed = [];
    const result = await pingProvider({ id: 'openai', env: { OPENAI_API_KEY: testKey('openai'), STARPI_OPENAI_BASE_URL: openaiUrl }, print: (l) => printed.push(l) });
    assert.deepEqual(printed, ['openai: 1 key, simulated provider', 'list: 200 (6 entries)', 'browser access (CORS): yes']);
    assert.equal(result.status, 'ok');
  });
});
