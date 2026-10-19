// The local voice server's own Python tests (companion/voice-server/test_server.py: fake
// recognizer, fake Piper program, no models), run from `npm test` when Python 3.11 or newer is
// installed. CI also runs them on their own for several Python versions.
//
// A second test runs the real server code with an echoing recognizer and sends it what the app
// sends: the form of src/js/voice/sources/local.js with a glossary of the app's full size.
import './setup.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '../../src/js/voice/catalog.js';
import { parseGlossary } from '../../src/js/voice/gemini-wire.js';
import { serverTranscribe } from '../../src/js/voice/sources/local.js';
import { encodeWav } from '../../src/js/voice/wav.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER_DIR = path.join(ROOT, 'companion/voice-server');
const python = process.env.PYTHON ?? 'python3';
const probe = spawnSync(python, ['-I', '-c', 'import sys; print(sys.version_info >= (3, 11))'], { encoding: 'utf8' });
const usable = probe.status === 0 && probe.stdout.trim() === 'True';
const skip = !usable && `${python} 3.11 or newer is not installed`;
const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' };

it('passes the voice server tests with fake engines', { skip }, () => {
  const out = spawnSync(python, ['-I', '-B', '-m', 'unittest', 'discover', '-s', SERVER_DIR, '-p', 'test_*.py'], {
    encoding: 'utf8',
    timeout: 120_000,
    env,
  });
  assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
  assert.match(out.stderr, /^OK\b/m);
});

// Serves on an ephemeral loopback port, prints it, and stops when stdin closes. The recognizer
// answers with the hotwords the server planned, so the test sees what would reach Whisper.
const HARNESS = `
import sys, threading
sys.path.insert(0, sys.argv[1])
import server as vs

class Echo:
    name = "echo"
    ready = True
    counter = None

    def transcribe(self, audio, language, plan):
        return "hotwords: " + (plan.hotwords or "-")

settings = vs.ServerSettings(port=0, origins=frozenset(), allowlist=vs.load_allowlist(vs.DEFAULT_ALLOWLIST))
srv = vs.VoiceServer(("127.0.0.1", 0), settings, Echo(), None)
settings.port = srv.port
print(srv.port, flush=True)
threading.Thread(target=lambda: (sys.stdin.read(), srv.shutdown()), daemon=True).start()
srv.serve_forever(poll_interval=0.05)
`;

describe('the app against the voice server', { skip }, () => {
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
  let child;
  let base = '';

  before(async () => {
    child = spawn(python, ['-I', '-B', '-c', HARNESS, SERVER_DIR], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const port = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`the voice server did not start\n${stderr}`)), 20_000);
      child.stdout.on('data', (chunk) => {
        out += chunk;
        if (out.includes('\n')) {
          clearTimeout(timer);
          resolve(out.trim());
        }
      });
      child.on('exit', (code) => reject(new Error(`the voice server ended (${code})\n${stderr}`)));
    });
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (!child || child.exitCode !== null) return;
    const ended = new Promise((resolve) => child.once('exit', resolve));
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await ended;
    clearTimeout(timer);
  });

  /** @param {string[]} glossary */
  const transcribe = (glossary) =>
    serverTranscribe(/** @type {any} */ ({}), { base, headers: {} }, encodeWav(new Int16Array(4000), 16000), { locale: 'en-GB', glossary, signal: AbortSignal.timeout(20_000) });

  it('serves a glossary of the most terms and characters the app allows', async () => {
    const shapes = [
      [LIMITS.glossaryTerms, LIMITS.glossaryChars / LIMITS.glossaryTerms],
      [LIMITS.glossaryChars / 60, 60],
    ];
    for (const [count, length] of shapes) {
      const typed = Array.from({ length: count + 5 }, (_, i) => `${String(i).padStart(2, '0')}${'q'.repeat(length - 2)}`).join('\n');
      const glossary = parseGlossary(typed);
      assert.equal(glossary.join('').length, LIMITS.glossaryChars, 'the app keeps its full size');
      assert.ok(glossary.join(', ').length > LIMITS.glossaryChars, 'the prompt field is longer than the term text');
      const text = await transcribe(glossary);
      assert.match(text, new RegExp(`^hotwords: ${glossary[0]}(, |$)`));
    }
  });

  it('passes a short glossary on whole', async () => {
    assert.equal(await transcribe(['Kubernetes', 'pnpm', 'focaccia']), 'hotwords: Kubernetes, pnpm, focaccia');
    assert.equal(await transcribe([]), 'hotwords: -');
  });
});
