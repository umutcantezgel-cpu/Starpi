import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  catalogJson,
  findNvidiaModel,
  NVIDIA_CATALOG,
  NVIDIA_CLIENT_TIMEOUTS,
  NVIDIA_DEFAULT_MODEL,
  NVIDIA_LIMITS,
  NVIDIA_MODELS,
  NVIDIA_PROXY,
  normalizeNvidiaModel,
  publicCatalog,
} from '../../src/js/models/nvidia-catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The i18n test reads `: 'x.y'` and `? 'x.y'` in src/ as translation keys (tests/unit/i18n.test.mjs). */
const I18N_KEY_SHAPE = /^[a-z]\w*\.[\w.-]+$/;

describe('NVIDIA model catalog', () => {
  it('lists unique, well-formed ids and contains the default model', () => {
    const ids = NVIDIA_MODELS.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate model id');
    for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/);
    assert.ok(ids.includes(NVIDIA_DEFAULT_MODEL));
    assert.equal(NVIDIA_CATALOG.upstream, 'https://integrate.api.nvidia.com/v1/chat/completions');
  });

  it('keeps labels and vendors out of the i18n key shape and bounds every token budget', () => {
    for (const m of NVIDIA_MODELS) {
      assert.ok(m.label.trim().length > 0 && m.label.length <= 80, m.id);
      assert.doesNotMatch(m.label, I18N_KEY_SHAPE, m.id);
      assert.doesNotMatch(m.vendor, I18N_KEY_SHAPE, m.id);
      assert.ok(m.defaultMaxTokens >= 1 && m.defaultMaxTokens <= m.maxOutputTokens, m.id);
      assert.ok(m.maxOutputTokens <= NVIDIA_LIMITS.maxOutputTokens, m.id);
      for (const key of Object.keys(m.upstream ?? {})) assert.ok(['chat_template_kwargs', 'reasoning_effort'].includes(key), `${m.id}: ${key}`);
    }
  });

  it('is frozen, so no importer can change the allowlist at runtime', () => {
    assert.ok(Object.isFrozen(NVIDIA_CATALOG) && Object.isFrozen(NVIDIA_MODELS) && Object.isFrozen(NVIDIA_MODELS[0]));
    assert.throws(() => {
      /** @type {any} */ (NVIDIA_MODELS).push({ id: 'evil/model' });
    });
  });

  it('lets the proxy answer before the browser gives up', () => {
    assert.ok(NVIDIA_PROXY.attemptTimeoutMs <= NVIDIA_PROXY.failoverBudgetMs);
    assert.ok(NVIDIA_CLIENT_TIMEOUTS.firstByte > NVIDIA_PROXY.failoverBudgetMs);
    assert.ok(NVIDIA_CLIENT_TIMEOUTS.idle > NVIDIA_PROXY.idleTimeoutMs);
    assert.ok(NVIDIA_CLIENT_TIMEOUTS.total > NVIDIA_PROXY.streamMaxMs);
    assert.ok(NVIDIA_PROXY.streamMaxMs > NVIDIA_PROXY.failoverBudgetMs);
    const c = NVIDIA_PROXY.cooldownMs;
    assert.ok(c.rateLimitedMin <= c.rateLimitedDefault && c.rateLimitedDefault <= c.rateLimitedMax);
  });

  it('normalizes stored ids against the allowlist', () => {
    assert.equal(normalizeNvidiaModel('z-ai/glm-5.3'), 'z-ai/glm-5.3');
    for (const bad of ['evil/model', '', null, undefined, 42, '__proto__', 'constructor']) assert.equal(normalizeNvidiaModel(bad), NVIDIA_DEFAULT_MODEL);
    assert.equal(findNvidiaModel('nvidia/unknown'), undefined);
    assert.equal(findNvidiaModel('toString'), undefined);
  });

  it('publishes the model list without upstream extras', () => {
    const body = publicCatalog(true);
    assert.equal(body.configured, true);
    assert.equal(body.defaultModel, NVIDIA_DEFAULT_MODEL);
    assert.deepEqual(body.models.map((m) => m.id), NVIDIA_MODELS.map((m) => m.id));
    assert.ok(body.models.every((m) => !('upstream' in m)));
    assert.equal(publicCatalog(false).configured, false);
  });

  it('serializes to the JSON the Python backend reads', () => {
    assert.deepEqual(JSON.parse(catalogJson()), JSON.parse(JSON.stringify(NVIDIA_CATALOG)));
    assert.ok(catalogJson().endsWith('}\n'));
  });
});

describe('README NVIDIA model table', () => {
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  // | T4 | `nvidia/nemotron-3.5-lightning-30b-a3b` | Nemotron 3.5 Lightning 30B A3B | no |
  const rows = [...readme.matchAll(/^\| T4 \| `([a-z0-9][\w.-]*\/[\w.:-]+)` \| ([^|]+?) \| (yes|no) \|$/gm)].map(([, id, label, reasoning]) => ({ id, label, reasoning: reasoning === 'yes' }));

  it('lists every allowlisted model in catalog order, with its name and whether it reasons', () => {
    assert.deepEqual(rows.map((row) => row.id), NVIDIA_MODELS.map((m) => m.id));
    assert.deepEqual(rows, NVIDIA_MODELS.map(({ id, label, reasoning }) => ({ id, label, reasoning })));
  });
});

/**
 * The regex of a custom gitleaks rule, read from .gitleaks.toml (a TOML literal string, so no escapes).
 * @param {string} id
 */
function gitleaksRegex(id) {
  const toml = readFileSync(path.join(ROOT, '.gitleaks.toml'), 'utf8');
  const rule = toml.split(/^(?=\[)/m).find((table) => table.startsWith('[[rules]]') && table.includes(`\nid = "${id}"\n`));
  assert.ok(rule, `.gitleaks.toml has no rule ${id}`);
  assert.match(rule, /^keywords = \["nvapi-"\]$/m);
  const source = /^regex = '''(.+)'''$/m.exec(rule)?.[1];
  assert.ok(source, `rule ${id} has no regex`);
  return new RegExp(source);
}

describe('NVIDIA catalog mirror and key-leak guards', () => {
  it('keeps backend/core/nvidia_catalog.json an exact copy of the catalog', () => {
    const mirror = readFileSync(path.join(ROOT, 'backend/core/nvidia_catalog.json'), 'utf8');
    assert.ok(mirror === catalogJson(), 'backend/core/nvidia_catalog.json is outdated; run npm run nvidia:sync');
  });

  it('has a gitleaks rule that finds plain and Markdown-escaped keys but not the docs placeholder', () => {
    const rule = gitleaksRegex('starpi-nvidia-api-key');
    // Keys are built at runtime so that no key-shaped literal exists in the repository.
    const plain = `nvapi-${'t'.repeat(63)}1`;
    const escaped = `nvapi-${'a\\_'.repeat(32)}`;
    assert.equal(rule.exec(plain)?.[0], plain);
    assert.equal(rule.exec(`key: ${escaped}.`)?.[0], escaped);
    assert.doesNotMatch(`nvapi-${'t'.repeat(63)}`, rule);
    assert.doesNotMatch('NVIDIA_API_KEYS=nvapi-<64 characters>', rule);
  });

  it('finds no NVIDIA API key in any tracked text file', () => {
    const rule = gitleaksRegex('starpi-nvidia-api-key');
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
    assert.ok(tracked.length > 100, `only ${tracked.length} tracked files found`);
    const leaks = tracked.filter((file) => {
      const full = path.join(ROOT, file);
      // Files deleted in the working tree, and binaries (a NUL byte), are skipped.
      if (!statSync(full, { throwIfNoEntry: false })?.isFile()) return false;
      const bytes = readFileSync(full);
      return !bytes.includes(0) && rule.test(bytes.toString('utf8'));
    });
    assert.deepEqual(leaks, [], 'remove the key and revoke it');
  });
});
