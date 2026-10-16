// The custom rules of .gitleaks.toml (scripts/lib/secret-rules.mjs): each provider key format is
// found when it is real-shaped and left alone when it is a placeholder, personal paths are found,
// and no tracked file matches any rule. Every key here is assembled at run time, so the repository
// holds no key-shaped literal.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { credentialRules, parseGitleaksRules, readGitleaksRules } from '../../scripts/lib/secret-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RULES = readGitleaksRules(ROOT);
/** @param {string} id */
const rule = (id) => {
  const found = RULES.find((r) => r.id === id);
  assert.ok(found, `.gitleaks.toml has no rule ${id}`);
  return found;
};

const hex = (/** @type {number} */ n) => '0123456789abcdef'.repeat(Math.ceil(n / 16)).slice(0, n);
const alnum = (/** @type {number} */ n) => 'aB3dE5gH7jK9mN1pQ'.repeat(Math.ceil(n / 17)).slice(0, n);

/** id -> [keys it must find, look-alikes it must leave alone] */
const CASES = {
  'starpi-nvidia-api-key': [[`nvapi-${alnum(64)}`], ['nvapi-<64 characters>', `nvapi-${alnum(40)}`]],
  'starpi-anthropic-api-key': [[`sk-ant-api03-${alnum(93)}AA`, `sk-ant-admin01-${alnum(90)}`], ['sk-ant-…', 'sk-ant-api03-short']],
  'starpi-openai-project-key': [[`sk-proj-${alnum(120)}`], ['sk-proj-…', 'sk-proj-abc']],
  'starpi-openrouter-api-key': [[`sk-or-v1-${hex(64)}`], ['sk-or-v1-…', `sk-or-v1-${hex(32)}`]],
  'starpi-xai-api-key': [[`xai-${alnum(80)}`], ['xai-…', 'see xai-grok-2 in the catalog']],
  'starpi-groq-api-key': [[`gsk_${alnum(52)}`], ['gsk_…', `gsk_${alnum(20)}`]],
  'starpi-elevenlabs-api-key': [[`sk_${hex(48)}`], ['sk_…', `task_${hex(48)}`, `sk_${hex(40)}`]],
  'starpi-google-aq-api-key': [[`AQ.${alnum(53)}`], ['AQ.…', 'QA. AQ.short']],
  'starpi-live-ephemeral-token': [[`auth_tokens/${alnum(24)}`, `auth_tokens%2F${alnum(24)}`], ['auth_tokens/fake', 'auth_tokens']],
};

describe('.gitleaks.toml rules', () => {
  it('keeps the NVIDIA rule and adds one rule per provider key format, each a valid JavaScript RegExp', () => {
    for (const id of Object.keys(CASES)) assert.ok(rule(id).keywords.length > 0, `${id} needs keywords`);
    assert.deepEqual(rule('starpi-nvidia-api-key').keywords, ['nvapi-']);
    assert.deepEqual(credentialRules(ROOT).map((r) => r.id).sort(), Object.keys(CASES).sort());
  });

  for (const [id, [hits, misses]] of Object.entries(CASES)) {
    it(`${id} finds real-shaped keys and leaves placeholders alone`, () => {
      const { re, keywords } = rule(id);
      for (const key of hits) {
        assert.equal(re.exec(`token: "${key}"`)?.[0], key, key.slice(0, 12));
        // gitleaks only runs a rule on text that contains one of its keywords (case-insensitive).
        assert.ok(keywords.some((k) => key.toLowerCase().includes(k.toLowerCase())), `${id}: no keyword in ${key.slice(0, 12)}`);
      }
      for (const text of misses) assert.doesNotMatch(text, re, text);
    });
  }

  it('finds absolute paths into personal home directories, but not relative paths or URLs', () => {
    const posix = rule('starpi-personal-path-posix').re;
    const windows = rule('starpi-personal-path-windows').re;
    const home = ['', 'home', 'jane', 'project'].join('/');
    const mac = ['', 'Users', 'jane', 'Desktop'].join('/');
    for (const text of [`cd ${home}`, `"${mac}/a.txt"`, `file://${home}/x`, `${home}/x at line start`]) assert.match(text, posix, text);
    for (const text of ['~/project/x', 'https://example.org/home/jane/x', '/srv/app/home/', 'src/home/page.js', '/home/', 'the users/home folder']) assert.doesNotMatch(text, posix, text);
    for (const text of [['C:', 'Users', 'Jane Doe', 'x'].join('\\'), ['D:', 'Users', 'jane', ''].join('/'), ['C:', 'Users', 'jane', ''].join('\\\\')]) assert.match(text, windows, text);
    assert.doesNotMatch('C:\\Program Files\\x', windows);
  });

  it('refuses a rule without an id or a regex', () => {
    assert.throws(() => parseGitleaksRules('[[rules]]\nid = "x"\n'), /without id or regex/);
  });

  it('finds no match of any rule in a tracked text file', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
    assert.ok(tracked.length > 100, `only ${tracked.length} tracked files found`);
    /** @type {string[]} */
    const hits = [];
    for (const file of tracked) {
      if (/(^|\/)package-lock\.json$/.test(file)) continue; // allowlisted in .gitleaks.toml
      const full = path.join(ROOT, file);
      if (!statSync(full, { throwIfNoEntry: false })?.isFile()) continue;
      const bytes = readFileSync(full);
      if (bytes.includes(0)) continue;
      const text = bytes.toString('utf8');
      for (const { id, re } of RULES) if (re.test(text)) hits.push(`${file}: ${id}`);
    }
    assert.deepEqual(hits, []);
  });
});
