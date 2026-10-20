// The service fakes (ElevenLabs, local voice server, MCP over Streamable HTTP, web search), the
// shared helpers, and the launcher that starts every fake for the e2e suite.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createElevenLabsFake, PREMADE_VOICES } from '../../scripts/fakes/elevenlabs.mjs';
import { startAllFakes } from '../../scripts/fakes/index.mjs';
import { createMcpFake, PROTOCOL_VERSION } from '../../scripts/fakes/mcp.mjs';
import { createSearchFake } from '../../scripts/fakes/search.mjs';
import { chunkText, createAnswerBook, exampleFromSchema, FAULTS, mp3Silence, parseArgs, readControl, wavSilence } from '../../scripts/fakes/shared.mjs';
import { createVoiceFake } from '../../scripts/fakes/voice.mjs';

/** @type {Record<string, import('../../scripts/fakes/shared.mjs').Fake>} */
const fakes = {};
/** @type {Record<string, string>} */
const url = {};

before(async () => {
  fakes.elevenlabs = createElevenLabsFake({ gapMs: 0 });
  fakes.voice = createVoiceFake({ gapMs: 0 });
  fakes.lockedVoice = createVoiceFake({ gapMs: 0, token: 'voice-token' });
  fakes.mcp = createMcpFake({ gapMs: 0 });
  fakes.search = createSearchFake({ gapMs: 0 });
  for (const [name, fake] of Object.entries(fakes)) url[name] = (await fake.listen(0)).url;
});

after(async () => {
  await Promise.all(Object.values(fakes).map((f) => f.close()));
});

const XI = { 'xi-api-key': 'test-key' };

describe('elevenlabs fake', () => {
  it('lists premade voices and models with the key header only', async () => {
    assert.equal((await fetch(`${url.elevenlabs}/v1/voices`)).status, 401);
    assert.equal((await fetch(`${url.elevenlabs}/v1/voices?xi-api-key=x`)).status, 400);
    const { voices } = await (await fetch(`${url.elevenlabs}/v1/voices`, { headers: XI })).json();
    assert.deepEqual(voices.map((/** @type {any} */ v) => v.voice_id), PREMADE_VOICES.map((v) => v.voice_id));
    assert.ok(voices.every((/** @type {any} */ v) => v.category === 'premade'));
    const models = await (await fetch(`${url.elevenlabs}/v1/models`, { headers: XI })).json();
    assert.ok(models.every((/** @type {any} */ m) => m.can_do_text_to_speech));
  });

  it('speaks in the requested output format and refuses unknown voices', async () => {
    const voice = PREMADE_VOICES[0].voice_id;
    /** @param {string} path */
    const speak = (path, text = 'Hello there') => fetch(`${url.elevenlabs}${path}`, { method: 'POST', headers: { ...XI, 'content-type': 'application/json' }, body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }) });
    const mp3 = await speak(`/v1/text-to-speech/${voice}`);
    assert.equal(mp3.headers.get('content-type'), 'audio/mpeg');
    assert.equal(new Uint8Array(await mp3.arrayBuffer())[0], 0xff);
    const pcm = await speak(`/v1/text-to-speech/${voice}/stream?output_format=pcm_16000`);
    assert.equal(pcm.headers.get('content-type'), 'audio/pcm');
    assert.equal((await pcm.arrayBuffer()).byteLength % 2, 0);
    assert.equal((await speak('/v1/text-to-speech/unknownVoice')).status, 404);
    assert.equal((await speak(`/v1/text-to-speech/${voice}`, ' ')).status, 400);
    const limited = await fetch(`${url.elevenlabs}/v1/text-to-speech/${voice}`, { method: 'POST', headers: { ...XI, 'x-fake-fault': '429' }, body: '{}' });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).detail.status, 'too_many_concurrent_requests');
  });

  it('transcribes a multipart upload', async () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(32)], { type: 'audio/webm' }), 'a.webm');
    form.append('model_id', 'scribe_v1');
    const res = await (await fetch(`${url.elevenlabs}/v1/speech-to-text`, { method: 'POST', headers: XI, body: form })).json();
    assert.equal(res.text, 'This is a simulated transcript.');
  });
});

describe('voice fake', () => {
  it('lists voices, speaks WAV and transcribes raw audio', async () => {
    const { voices } = await (await fetch(`${url.voice}/voices`)).json();
    assert.ok(voices.length >= 2);
    const wav = await fetch(`${url.voice}/speak`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Read this aloud.', voice: voices[1].id }) });
    assert.equal(wav.headers.get('content-type'), 'audio/wav');
    assert.equal(Buffer.from(await wav.arrayBuffer()).subarray(0, 4).toString('ascii'), 'RIFF');
    const bad = await fetch(`${url.voice}/speak`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x', voice: 'missing' }) });
    assert.equal((await bad.json()).error, 'unknown_voice');
    const text = await (await fetch(`${url.voice}/transcribe?language=de`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array(3200) })).json();
    assert.deepEqual(text, { text: 'Dies ist ein simuliertes Transkript.', language: 'de', durationMs: 100 });
    assert.equal((await fetch(`${url.voice}/transcribe`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })).status, 415);
  });

  it('needs the token when one is set, except for health', async () => {
    assert.equal((await fetch(`${url.lockedVoice}/voices`)).status, 401);
    assert.equal((await fetch(`${url.lockedVoice}/voices`, { headers: { authorization: 'Bearer voice-token' } })).status, 200);
    assert.equal((await fetch(`${url.lockedVoice}/health`)).status, 200);
  });
});

describe('mcp fake', () => {
  const endpoint = () => `${url.mcp}/mcp`;
  const ACCEPT = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
  /** @param {unknown} msg @param {Record<string, string>} [headers] @param {string} [query] */
  const rpc = (msg, headers = {}, query = '') => fetch(`${endpoint()}${query}`, { method: 'POST', headers: { ...ACCEPT, ...headers }, body: JSON.stringify(msg) });

  /** @returns {Promise<Record<string, string>>} */
  async function session() {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    const body = await res.json();
    assert.equal(body.result.protocolVersion, PROTOCOL_VERSION);
    assert.deepEqual(body.result.capabilities, { tools: { listChanged: false } });
    const id = res.headers.get('mcp-session-id');
    assert.ok(id);
    const headers = { 'mcp-session-id': id, 'mcp-protocol-version': PROTOCOL_VERSION };
    assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, headers)).status, 202);
    return headers;
  }

  it('opens a session, lists two read-only tools and calls them', async () => {
    const headers = await session();
    const { result } = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, headers)).json();
    assert.deepEqual(result.tools.map((/** @type {any} */ t) => t.name), ['define_word', 'convert_units']);
    assert.ok(result.tools.every((/** @type {any} */ t) => t.annotations.readOnlyHint === true && t.inputSchema.type === 'object'));
    const defined = (await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'define_word', arguments: { word: 'Latency' } } }, headers)).json()).result;
    assert.equal(defined.isError, false);
    assert.equal(defined.structuredContent.definition, 'The delay between a request and its answer.');
    const converted = (await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'convert_units', arguments: { value: 100, from: 'c', to: 'f' } } }, headers)).json()).result;
    assert.deepEqual(converted.structuredContent, { value: 212, unit: 'f' });
    const wrong = (await (await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'convert_units', arguments: { value: 1, from: 'kg', to: 'km' } } }, headers)).json()).result;
    assert.equal(wrong.isError, true);
    const unknown = await (await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'delete_all' } }, headers)).json();
    assert.equal(unknown.error.code, -32602);
    assert.equal((await (await rpc({ jsonrpc: '2.0', id: 7, method: 'resources/list' }, headers)).json()).error.code, -32601);
  });

  it('enforces the transport rules', async () => {
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 400, 'no session');
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-session-id': 'nope' })).status, 404);
    const headers = await session();
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { ...headers, 'mcp-protocol-version': '1999-01-01' })).status, 400);
    assert.equal((await fetch(endpoint(), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{}' })).status, 406);
    assert.equal((await rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }], headers)).status, 400, 'no batches in 2025-06-18');
    assert.equal((await fetch(endpoint(), { headers: ACCEPT })).status, 405);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { ...headers, origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(endpoint(), { method: 'DELETE', headers })).status, 204);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, headers)).status, 404, 'the session is gone');
  });

  it('answers as an event stream on request, allows loopback browsers and changes a tool on demand', async () => {
    const headers = await session();
    const res = await rpc({ jsonrpc: '2.0', id: 9, method: 'ping' }, headers, '?sse=1');
    assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
    assert.match(await res.text(), /^id: 9\nevent: message\ndata: \{"jsonrpc":"2.0","id":9,"result":\{\}\}\n\n$/);
    const preflight = await fetch(endpoint(), { method: 'OPTIONS', headers: { origin: 'http://localhost:4173', 'access-control-request-method': 'POST', 'access-control-request-headers': 'mcp-session-id,content-type' } });
    assert.equal(preflight.status, 204);
    const browser = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { origin: 'http://localhost:4173' });
    assert.match(browser.headers.get('access-control-expose-headers') ?? '', /mcp-session-id/);
    const before = (await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, headers)).json()).result.tools[0].description;
    const changed = (await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, headers, '?variant=changed')).json()).result.tools[0].description;
    assert.notEqual(before, changed);
  });
});

describe('search fake', () => {
  it('answers Brave-like, Tavily-like and SearXNG-like queries', async () => {
    assert.equal((await fetch(`${url.search}/res/v1/web/search?q=test`)).status, 401);
    const brave = await (await fetch(`${url.search}/res/v1/web/search?q=Solar%20power&count=3`, { headers: { 'x-subscription-token': 't' } })).json();
    assert.equal(brave.web.results.length, 3);
    assert.match(brave.web.results[0].url, /^https:\/\/example\.com\/articles\/solar-power-1$/);
    const tavily = await (await fetch(`${url.search}/search`, { method: 'POST', headers: { authorization: 'Bearer tvly-test', 'content-type': 'application/json' }, body: JSON.stringify({ query: 'Solar power', max_results: 2, include_answer: true }) })).json();
    assert.equal(tavily.results.length, 2);
    assert.ok(tavily.answer);
    assert.equal((await fetch(`${url.search}/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"x"}' })).status, 401);
    const searx = await (await fetch(`${url.search}/search?q=Solar&format=json`)).json();
    assert.equal(searx.results[0].engine, 'fake');
    assert.equal((await fetch(`${url.search}/search?q=Solar`)).status, 403);
    const empty = await (await fetch(`${url.search}/res/v1/web/search?q=x`, { headers: { 'x-subscription-token': 't', 'x-fake-scenario': 'empty' } })).json();
    assert.deepEqual(empty.web.results, []);
  });
});

describe('shared helpers', () => {
  it('build schema-shaped values', () => {
    assert.deepEqual(
      exampleFromSchema({
        type: 'object',
        properties: { a: { type: 'string', minLength: 10 }, b: { type: ['null', 'number'], minimum: 2 }, c: { type: 'array', minItems: 2, items: { const: 'x' } }, d: { anyOf: [{ type: 'null' }, { type: 'boolean' }] }, e: { type: 'string', format: 'date-time' }, f: { type: 'string' } },
        required: ['a', 'b', 'c', 'd', 'e'],
      }),
      { a: 'examplexxx', b: 2, c: ['x', 'x'], d: true, e: '2026-01-01T00:00:00Z' },
    );
    assert.deepEqual(exampleFromSchema({ properties: { only: { type: 'integer', maximum: 0 } } }), { only: 0 });
  });

  it('pick purposes by the configured marker and refuse odd markers', () => {
    const book = createAnswerBook({ marker: 'my-app', fixtures: { greet: [{ text: 'hello' }] } });
    assert.equal(book.purposeOf('x [[my-app:greet]] y'), 'greet');
    assert.equal(book.purposeOf('[[starpi-purpose:greet]]'), null);
    assert.equal(book.answer({ system: '[[my-app:greet]]', user: 'q' }).text, 'hello');
    assert.throws(() => createAnswerBook({ marker: 'Bad Marker' }));
  });

  it('read controls from headers, query and markers in that order', () => {
    const req = /** @type {any} */ ({ headers: { 'x-fake-fault': '503' } });
    assert.equal(readControl(req, new URL('http://h/?fault=429'), ['[[fake-fault:401]]']).fault, '503');
    assert.equal(readControl(/** @type {any} */ ({ headers: {} }), new URL('http://h/?fault=429'), ['[[fake-fault:401]]']).fault, '429');
    const marked = readControl(/** @type {any} */ ({ headers: {} }), new URL('http://h/'), ['ask [[fake-fault:401]] [[fake:tool]]']);
    assert.equal(marked.fault, '401');
    assert.equal(marked.scenario, 'tool');
    assert.ok(FAULTS.includes('cut-mid-stream'));
  });

  it('chunk text losslessly and make playable silence', () => {
    const text = 'One two  three, four five.';
    assert.equal(chunkText(text).join(''), text);
    assert.equal(wavSilence(100).length, 44 + 3200);
    assert.equal(mp3Silence(260).length, 417 * 10);
    assert.deepEqual(parseArgs(['--port', '1', '--sse', '--marker=x']), { port: '1', sse: 'true', marker: 'x' });
  });
});

describe('startAllFakes', () => {
  it('starts every fake, lists them and stops them', async () => {
    const all = await startAllFakes({ basePort: 0, gapMs: 0 });
    try {
      assert.deepEqual(Object.keys(all.urls).sort(), ['anthropic', 'elevenlabs', 'gemini', 'mcp', 'openai', 'search', 'voice']);
      const list = await (await fetch(all.listUrl)).json();
      assert.deepEqual(list.urls, all.urls);
      for (const origin of Object.values(all.origins)) assert.equal((await fetch(`${origin}/__fake/health`)).status, 200);
      const res = await fetch(`${all.urls.anthropic}/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'k', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
      assert.match(await res.text(), /event: message_stop/);
    } finally {
      await all.close();
    }
  });
});
