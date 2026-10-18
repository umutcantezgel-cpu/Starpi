// The local voice server's own Python tests (companion/voice-server/test_server.py: fake
// recognizer, fake Piper program, no models), run from `npm test` when Python 3.11 or newer is
// installed. CI also runs them on their own for several Python versions.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const python = process.env.PYTHON ?? 'python3';
const probe = spawnSync(python, ['-I', '-c', 'import sys; print(sys.version_info >= (3, 11))'], { encoding: 'utf8' });
const usable = probe.status === 0 && probe.stdout.trim() === 'True';

it('passes the voice server tests with fake engines', { skip: !usable && `${python} 3.11 or newer is not installed` }, () => {
  const out = spawnSync(python, ['-I', '-B', '-m', 'unittest', 'discover', '-s', path.join(ROOT, 'companion/voice-server'), '-p', 'test_*.py'], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' },
  });
  assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
  assert.match(out.stderr, /^OK\b/m);
});
