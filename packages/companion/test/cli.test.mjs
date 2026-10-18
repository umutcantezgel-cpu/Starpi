import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli/main.js';
import { tempDir } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/starpi-companion.mjs', import.meta.url));

/** @param {string} root */
const envFor = (root) => ({ XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), HOME: root, PATH: process.env.PATH ?? '' });

/**
 * Runs the command line in-process.
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [input]
 */
async function run(argv, env, input) {
  let out = '';
  let err = '';
  const stdin = /** @type {any} */ (Readable.from(input === undefined ? [] : [Buffer.from(input)]));
  const code = await main(argv, { env, stdout: (t) => (out += t), stderr: (t) => (err += t), stdin, onSignal: () => {} });
  return { code, out, err };
}

/** A free TCP port on loopback. */
function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (s.address());
      s.close(() => resolve(port));
    });
  });
}

test('help, version and usage errors', async () => {
  assert.equal((await run(['--version'], {})).code, 0);
  const help = await run(['help'], {});
  assert.match(help.out, /verify-audit/);
  assert.equal((await run(['nope'], {})).code, 2);
  assert.equal((await run(['pair', '--bogus'], {})).code, 2);
});

test('start in a child process, pair, status, verify-audit, then stop cleanly on SIGTERM', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const env = envFor(dir);
  const port = await freePort();
  const child = spawn(process.execPath, [BIN, 'start', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  t.after(() => child.kill('SIGKILL'));
  for (let i = 0; i < 100 && !stdout.includes('listening on'); i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.match(stdout, new RegExp(`listening on http://127.0.0.1:${port}`), stderr);
  assert.equal(stderr.includes('ExperimentalWarning'), false, 'the sqlite warning is hidden');

  const paired = await run(['pair', '--json', '--role', 'member', '--label', 'laptop'], env);
  assert.equal(paired.code, 0, paired.err);
  const { code } = JSON.parse(paired.out);
  const res = await fetch(`http://127.0.0.1:${port}/v1/session/pair`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://www.starpi.app' }, body: JSON.stringify({ code }) });
  assert.equal(res.status, 200);
  const session = await res.json();
  assert.equal(session.role, 'member');

  const status = await run(['status', '--json', '--port', String(port)], env);
  assert.equal(status.code, 0, status.err);
  assert.equal(JSON.parse(status.out).running, true);
  const listed = await run(['token-revoke', '--list', '--json'], env);
  assert.equal(JSON.parse(listed.out).sessions.length, 1);

  child.kill('SIGTERM');
  const exit = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(exit, 0, stderr);
  assert.match(stderr, /companion_stopped/);
  const verified = await run(['verify-audit', '--json'], env);
  assert.equal(verified.code, 0, verified.out);
  const report = JSON.parse(verified.out);
  assert.equal(report.ok, true);
  assert.ok(report.anchors.count >= 2, 'an anchor at start and one at stop');
  const revoked = await run(['token-revoke', '--all'], env);
  assert.match(revoked.out, /revoked 1 session/);
});

test('secret set/list/remove read the value from stdin; erase and backup work from the command line', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const env = envFor(dir);
  assert.equal((await run(['status'], env)).code, 1, 'no installation before the first start');
  const port = await freePort();
  const child = spawn(process.execPath, [BIN, 'start', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (c) => (stdout += c));
  for (let i = 0; i < 100 && !stdout.includes('listening on'); i += 1) await new Promise((r) => setTimeout(r, 50));
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));

  assert.equal((await run(['secret', 'set', 'anthropic'], env, 'sk-ant-test\n')).code, 0);
  const list = await run(['secret', 'list', '--json'], env);
  assert.deepEqual(JSON.parse(list.out).secrets.map((/** @type {any} */ s) => s.name), ['anthropic']);
  assert.equal(list.out.includes('sk-ant-test'), false);
  assert.equal((await run(['secret', 'remove', 'anthropic'], env)).code, 0);
  assert.equal((await run(['erase', 'notes'], env)).code, 2, 'needs --yes');
  assert.equal((await run(['erase', 'notes', '--yes'], env)).code, 0);
  const out = join(dir, 'b1');
  const backup = await run(['backup', 'create', '--out', out, '--json'], env);
  assert.equal(backup.code, 0, backup.err);
  assert.equal((await run(['backup', 'verify', out], env)).code, 0);
  const verified = await run(['verify-audit'], env);
  assert.match(verified.out, /OK: everything verifies/);
});
