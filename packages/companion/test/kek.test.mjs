import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { kekProvider } from '../src/vault/kek/index.js';
import { fileKek } from '../src/vault/kek/file.js';
import { systemdCredsKek } from '../src/vault/kek/systemd-creds.js';
import { keychainKek } from '../src/vault/kek/keychain-macos.js';
import { runProgram } from '../src/vault/kek/runner.js';
import { tempDir } from './helpers.mjs';

const HEX = 'ab'.repeat(32);

test('file provider: creates once, refuses a readable or malformed key file', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const path = join(dir, 'cfg', 'kek.key');
  const kek = fileKek({ path });
  assert.equal(kek.exists(), false);
  const made = await kek.init();
  assert.equal(made.length, 32);
  assert.deepEqual(await kek.load(), made);
  await assert.rejects(kek.init(), (err) => /** @type {any} */ (err).code === 'file_exists');
  if (process.platform !== 'win32') {
    chmodSync(path, 0o644);
    await assert.rejects(kek.load(), (err) => /** @type {any} */ (err).code === 'kek_file_mode');
    chmodSync(path, 0o600);
  }
  writeFileSync(path, 'nope\n', { mode: 0o600 });
  await assert.rejects(kek.load(), (err) => /** @type {any} */ (err).code === 'kek_invalid');
});

test('the default key file lies outside the data folder; inside is refused', () => {
  assert.equal(kekProvider({ configDir: '/srv/cfg', dataDir: '/srv/data' }).describe(), 'file /srv/cfg/kek.key');
  assert.throws(() => kekProvider({ config: { provider: 'file', path: '/srv/data/kek.key' }, configDir: '/srv/cfg', dataDir: '/srv/data' }), (err) => /** @type {any} */ (err).code === 'kek_config');
  assert.throws(() => kekProvider({ config: { provider: 'magic' }, configDir: '/srv/cfg', dataDir: '/srv/data' }), (err) => /** @type {any} */ (err).code === 'kek_config');
});

test('systemd-creds provider: the unit-loaded credential first, else systemd-creds decrypt with stdin-free arguments', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  mkdirSync(join(dir, 'creds'));
  writeFileSync(join(dir, 'creds', 'starpi-companion-kek'), `${HEX}\n`);
  /** @type {Array<{ file: string, args: readonly string[], input?: unknown }>} */
  const calls = [];
  const run = async (/** @type {string} */ file, /** @type {readonly string[]} */ args, /** @type {any} */ options = {}) => {
    calls.push({ file, args, input: options.input });
    return { code: 0, stdout: Buffer.from(`${'cd'.repeat(32)}\n`), stderr: '' };
  };
  const fromUnit = systemdCredsKek({ env: { CREDENTIALS_DIRECTORY: join(dir, 'creds') }, run });
  assert.equal((await fromUnit.load()).toString('hex'), HEX);
  assert.equal(calls.length, 0, 'no program runs under the unit');
  const fromFile = systemdCredsKek({ env: {}, credential: join(dir, 'kek.cred'), run });
  assert.equal((await fromFile.load()).toString('hex'), 'cd'.repeat(32));
  assert.deepEqual(calls[0], { file: '/usr/bin/systemd-creds', args: ['--user', '--name=starpi-companion-kek', 'decrypt', join(dir, 'kek.cred'), '-'], input: undefined });
  await fromFile.init();
  assert.deepEqual(calls[1].args, ['--user', '--name=starpi-companion-kek', 'encrypt', '-', join(dir, 'kek.cred')]);
  assert.match(String(calls[1].input), /^[0-9a-f]{64}\n$/, 'the new key goes on stdin');
  assert.equal(calls[1].args.some((a) => /^[0-9a-f]{64}$/.test(a)), false, 'never as an argument');
});

test('keychain provider: reads the item, reports a missing one', async () => {
  const run = async (/** @type {string} */ _file, /** @type {readonly string[]} */ args) =>
    args[0] === 'find-generic-password' ? { code: 44, stdout: Buffer.alloc(0), stderr: '' } : { code: 0, stdout: Buffer.alloc(0), stderr: '' };
  const kek = keychainKek({ run });
  await assert.rejects(kek.load(), (err) => /** @type {any} */ (err).code === 'kek_missing');
  const ok = keychainKek({ run: async () => ({ code: 0, stdout: Buffer.from(`${HEX}\n`), stderr: '' }) });
  assert.equal((await ok.load()).toString('hex'), HEX);
});

test('the kernel runner runs only its fixed programs', async () => {
  await assert.rejects(runProgram('/bin/sh', ['-c', 'true']), (err) => /** @type {any} */ (err).code === 'program_not_allowed');
});
