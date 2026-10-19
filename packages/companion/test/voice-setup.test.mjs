// The voice relay to a voice server on this machine, and the first-start checks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDir } from './helpers.mjs';
import { chatModel, client, localServer, startModules } from './module-helpers.mjs';
import { sizeHint } from '../src/setup/models.js';

/** A WAV file of silence. @param {number} samples */
function wav(samples) {
  const data = Buffer.alloc(samples * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'latin1');
  head.write('fmt ', 12, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24);
  head.writeUInt32LE(32000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

test('voice relay: voices, speech and transcriptions pass through to the local voice server', async (t) => {
  const voice = await localServer((req, body, res) => {
    if (req.url === '/v1/audio/voices') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ voices: [{ id: 'en_US-test-medium', label: 'Test' }] }));
    } else if (req.url === '/v1/audio/speech') {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(wav(160));
    } else if (req.url === '/v1/audio/transcriptions') {
      const form = Buffer.isBuffer(body) ? body.toString('latin1') : '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: form.includes('name="language"') ? 'hello from the kitchen' : 'no form' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const { dir, cleanup } = tempDir();
  const { companion } = await startModules(dir, { only: ['voice', 'setup'], raw: { modules: { voice: { url: voice.url } } } });
  t.after(async () => {
    await companion.stop();
    await voice.close();
    cleanup();
  });
  const c = await client(companion, { role: 'member' });
  const voices = (await c.get('/v1/voice/v1/audio/voices')).json();
  assert.equal(voices.voices[0].id, 'en_US-test-medium');

  const speech = await c.post('/v1/voice/v1/audio/speech', { model: 'local', input: 'Dinner is ready.', voice: 'en_US-test-medium', response_format: 'wav', speed: 1 });
  assert.equal(speech.status, 200);
  assert.equal(speech.headers.get('content-type'), 'audio/wav');
  assert.equal(speech.buffer.toString('latin1', 0, 4), 'RIFF');
  const sent = voice.seen.find((s) => s.url === '/v1/audio/speech');
  assert.deepEqual(sent?.body, { model: 'local', input: 'Dinner is ready.', voice: 'en_US-test-medium', speed: 1, response_format: 'wav' });
  assert.equal(sent?.headers.origin, undefined, 'the relay sends no Origin to the voice server');
  assert.equal(sent?.headers.authorization, undefined, 'the pairing token stays with the companion');

  const form = new FormData();
  form.append('file', new Blob([wav(1600)], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', 'whisper');
  form.append('language', 'en');
  const request = new Request('http://x/', { method: 'POST', body: form });
  const bytes = Buffer.from(await request.arrayBuffer());
  const type = /** @type {string} */ (request.headers.get('content-type'));
  const text = await c.request('POST', '/v1/voice/v1/audio/transcriptions', { raw: bytes, type });
  assert.equal(text.status, 200);
  assert.equal(text.json().text, 'hello from the kitchen');
  const forwarded = voice.seen.find((s) => s.url === '/v1/audio/transcriptions');
  assert.equal(forwarded?.headers['content-type'], type, 'the form goes on with its boundary');
  assert.equal(Buffer.compare(/** @type {Buffer} */ (forwarded?.body), bytes), 0);

  assert.equal((await c.post('/v1/voice/v1/audio/speech', { input: '' })).status, 400);
  assert.equal((await c.post('/v1/voice/v1/audio/speech', { input: 'x', response_format: 'mp3' })).status, 400);
  assert.equal((await c.request('POST', '/v1/voice/v1/audio/transcriptions', { raw: bytes, type: 'audio/wav' })).status, 415);

  const owner = await client(companion);
  const setup = (await owner.get('/v1/setup?fresh=1')).json();
  assert.equal(setup.checks.find((/** @type {any} */ x) => x.id === 'voice').code, 'voice_ready');
});

test('voice relay without a configured voice server answers 503', async (t) => {
  const { dir, cleanup } = tempDir();
  const { companion } = await startModules(dir, { only: ['voice'] });
  t.after(async () => {
    await companion.stop();
    cleanup();
  });
  const c = await client(companion);
  const res = await c.get('/v1/voice/v1/audio/voices');
  assert.equal(res.status, 503);
  assert.equal(res.json().error.code, 'voice_not_configured');
});

test('setup checks: a reachable model server, a missing model, an unreachable one, keyword-only search', async (t) => {
  const model = await chatModel(() => 'hi');
  const { dir, cleanup } = tempDir();
  const raw = {
    brains: [
      { id: 'local', type: 'openai-compat', baseUrl: `${model.url}/v1`, model: 'test-model' },
      { id: 'other', type: 'openai-compat', baseUrl: `${model.url}/v1`, model: 'not-there' },
      { id: 'gone', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', model: 'x' },
    ],
  };
  const { companion } = await startModules(dir, { only: ['retrieval', 'voice', 'setup'], raw });
  t.after(async () => {
    await companion.stop();
    await model.close();
    cleanup();
  });
  const owner = await client(companion);
  const result = (await owner.get('/v1/setup?fresh=1')).json();
  const codes = Object.fromEntries(result.checks.map((/** @type {any} */ x) => [x.id, x.code]));
  assert.equal(codes['brain:local'], 'model_server_ready');
  assert.equal(codes['brain:other'], 'model_missing');
  assert.equal(codes['brain:gone'], 'model_server_unreachable');
  assert.equal(codes.search, 'keyword_only');
  assert.equal(codes.voice, 'voice_off');
  assert.equal(result.ready, false);
  const models = (await owner.get('/v1/setup/models')).json();
  assert.deepEqual(models.servers[0].models, ['test-model']);
  assert.ok(models.memory.totalMb > 0);
  const member = await client(companion, { role: 'member' });
  assert.equal((await member.get('/v1/setup')).status, 403);
  assert.equal(sizeHint(4000).maxParameters, '1-3 billion');
  assert.equal(sizeHint(64_000).maxParameters, '32-70 billion');
});
