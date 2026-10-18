// Live conversations driven by the fakes: the Live socket session against the Gemini fake (token
// from the live-token route, setup first, audio and transcripts back, a refused setup falling back
// to push-to-talk turns), the controller in free mode (native audio, transcript labelled free, the
// spoken free notice) and in source mode (retrieval per turn, the gate decides what is spoken, the
// withheld count follows), its session limits (15 minutes, 3 minutes of silence, a hidden tab), and
// the default turn prompt.
import './setup.mjs';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { buildVoiceDeps } from '../../api/_lib/voice-routes.js';
import { handleLiveToken } from '../../api/voice/live-token.js';
import { createGeminiFake, FAKE_LIVE_ANSWERS } from '../../scripts/fakes/gemini.mjs';
import { pickTurnModel, TURN_INSTRUCTIONS, turnMessages } from '../../src/js/live/ask.js';
import { createLiveController, LIVE_LIMITS } from '../../src/js/live/controller.js';
import { createLiveSession, liveEventsOf, socketUrl } from '../../src/js/live/session.js';
import { createTranscript, renderTranscript } from '../../src/js/live/transcript.js';
import { liveEndpoint } from '../../src/js/voice/catalog.js';
import { createSpeechQueue } from '../../src/js/voice/tts.js';
import { encodeWav } from '../../src/js/voice/wav.js';
import { jsonRequest, testKey } from './relay-helpers.mjs';

const gemini = createGeminiFake({ gapMs: 0 });
let root = '';
before(async () => {
  root = (await gemini.listen()).url;
});
after(() => gemini.close());

const SOURCES = [{ label: '[Doc: plan.md, Chunk: 2]', text: 'The yearly budget is 480 EUR and the review is in May.' }];
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until a condition holds (polling), or fails after `ms`.
 * @param {() => boolean} condition
 * @param {number} [ms]
 */
async function until(condition, ms = 3000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(5);
  }
}

/** A token from the site's live-token route, with the fake as the Gemini API. */
async function routeToken() {
  const deps = buildVoiceDeps({ GEMINI_API_KEYS: testKey('plain', 4), STARPI_GEMINI_BASE_URL: root }, { fetch: (i, n) => fetch(i, n), now: () => Date.now() });
  const res = await handleLiveToken(jsonRequest('/api/voice/live-token', { voice: 'Kore', locale: 'en' }), deps);
  assert.equal(res.status, 200);
  return res.json();
}

/**
 * A token minted directly at the fake with a setup of the test's own (markers steer the fake).
 * @param {string} instruction
 * @param {string[]} [modalities]
 */
async function directToken(instruction, modalities = ['AUDIO']) {
  const setup = { model: 'models/gemini-fake-live', generationConfig: { responseModalities: modalities }, systemInstruction: { parts: [{ text: instruction }] } };
  const res = await fetch(`${root}/v1alpha/auth_tokens`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': testKey('plain', 5) }, body: JSON.stringify({ uses: 1, bidiGenerateContentSetup: setup }) });
  const { name } = await res.json();
  return { token: name, wsUrl: liveEndpoint('v1alpha', root.replace('http', 'ws')), model: 'gemini-fake-live', setup, expiresAt: '', connectBy: '' };
}

/** A microphone stand-in: start() sends a few frames to the frame listeners. */
function fakeCapture(frames = 5) {
  /** @type {Set<(pcm: Int16Array, level: number) => void>} */
  const frameFns = new Set();
  /** @type {Set<(level: number) => void>} */
  const levelFns = new Set();
  let state = /** @type {'idle' | 'recording'} */ ('idle');
  const capture = {
    started: 0,
    async start() {
      capture.started += 1;
      state = 'recording';
      for (let i = 0; i < frames; i += 1) {
        for (const fn of frameFns) fn(new Int16Array(320).fill(800), 0.1);
        for (const fn of levelFns) fn(0.1);
      }
    },
    async stop() {
      state = 'idle';
      return new Int16Array(8000);
    },
    async stopWav() {
      state = 'idle';
      return encodeWav(new Int16Array(8000), 16_000);
    },
    cancel() {
      state = 'idle';
    },
    state: () => state,
    setMuted() {},
    onFrame: (/** @type {any} */ fn) => (frameFns.add(fn), () => frameFns.delete(fn)),
    onLevel: (/** @type {any} */ fn) => (levelFns.add(fn), () => levelFns.delete(fn)),
    onEvent: () => () => {},
    durationMs: () => 500,
  };
  return capture;
}

/** A playback stand-in that records what it plays. */
function fakePlayback() {
  /** @type {number[]} */
  const played = [];
  return {
    played,
    flushed: 0,
    unlock: async () => true,
    async play(/** @type {Int16Array} */ pcm) {
      played.push(pcm.length);
      return true;
    },
    flush() {
      this.flushed += 1;
    },
    isPlaying: () => false,
    onStateChange: () => () => {},
    context: () => null,
  };
}

/** A speech queue whose engine records what is spoken. */
function spyQueue() {
  /** @type {string[]} */
  const spoken = [];
  const queue = createSpeechQueue({
    engines: () => [{ id: 'spy', prepare: async (/** @type {string} */ text) => ({ play: async () => void spoken.push(text) }) }],
    locale: () => 'en',
  });
  return { queue, spoken };
}

/**
 * @param {Partial<import('../../src/js/live/controller.js').LiveDeps>} over
 */
function controllerWith(over) {
  const { queue, spoken } = spyQueue();
  const playback = fakePlayback();
  const capture = fakeCapture();
  const controller = createLiveController({
    liveToken: routeToken,
    canUseLive: () => true,
    capture: () => capture,
    playback,
    queue,
    transcribe: async () => ({ text: 'What is the budget?', source: 'gemini', attempts: [] }),
    ask: async function* () {
      yield 'Nothing.';
    },
    retrieve: async () => SOURCES,
    locale: () => 'en',
    voice: () => 'Kore',
    doc: null,
    ...over,
  });
  return { controller, spoken, playback, capture, queue };
}

describe('Live session', () => {
  it('reads server messages into events', () => {
    const events = liveEventsOf({ serverContent: { inputTranscription: { text: 'Hi' }, modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAABAA==' } }, { text: 'Hello', thought: false }] }, outputTranscription: { text: 'Hello' }, turnComplete: true } });
    assert.deepEqual(events.map((e) => e.type), ['input_transcript', 'audio', 'text', 'output_transcript', 'turn_complete']);
    assert.deepEqual(liveEventsOf({ setupComplete: {} }), [{ type: 'ready' }]);
    assert.deepEqual(liveEventsOf({ goAway: { timeLeft: '9s' } }), [{ type: 'go_away', timeLeft: '9s' }]);
    assert.deepEqual(liveEventsOf(null), []);
  });

  it('opens only Google or a loopback fake, with the token as access_token and nothing else', () => {
    const token = { token: 'auth_tokens/abc123def', wsUrl: liveEndpoint('v1alpha'), model: 'm', setup: {}, expiresAt: '', connectBy: '' };
    assert.equal(socketUrl(token), `${liveEndpoint('v1alpha')}?access_token=auth_tokens%2Fabc123def`);
    assert.equal(socketUrl({ ...token, wsUrl: 'wss://evil.example/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained' }), null);
    assert.equal(socketUrl({ ...token, wsUrl: `${liveEndpoint('v1alpha')}?key=x` }), null);
    assert.equal(socketUrl({ ...token, token: 'bad token' }), null);
    /** @type {string[]} */
    const seen = [];
    const session = createLiveSession({ token: { ...token, wsUrl: 'wss://evil.example/x' }, WebSocket: null });
    session.onEvent((e) => seen.push(e.type));
    assert.equal(session.connect(), false);
    assert.deepEqual(seen, ['refused']);
  });

  it('sends the setup first, then audio, and receives audio and transcripts from the fake', async () => {
    const token = await routeToken();
    const session = createLiveSession({ token });
    /** @type {import('../../src/js/live/session.js').LiveEvent[]} */
    const events = [];
    session.onEvent((e) => events.push(e));
    session.sendAudio(new Int16Array(10)); // before connect: ignored
    assert.equal(session.connect(), true);
    session.sendAudio(new Int16Array(320).fill(5)); // queued until setupComplete
    await until(() => events.some((e) => e.type === 'ready'));
    session.endAudio();
    await until(() => events.some((e) => e.type === 'turn_complete'));
    assert.ok(events.some((e) => e.type === 'input_transcript' && e.text === 'This is a simulated transcript.'));
    assert.ok(events.some((e) => e.type === 'audio' && e.rate === 24_000));
    const said = events.filter((e) => e.type === 'output_transcript').map((e) => /** @type {any} */ (e).text).join('');
    assert.equal(said.replace(/\s+/g, ' ').trim(), FAKE_LIVE_ANSWERS.en);
    session.close();
    assert.equal(session.state(), 'closed');
    assert.deepEqual(events.at(-1), { type: 'closed', code: 1000, reason: 'done', by: 'client' });
  });

  it('reports a refused setup as fallback', async () => {
    const session = createLiveSession({ token: await directToken('[[fake:refuse]]') });
    /** @type {string[]} */
    const seen = [];
    session.onEvent((e) => seen.push(e.type));
    session.connect();
    await until(() => seen.includes('closed'));
    assert.deepEqual(seen, ['ready', 'fallback', 'closed']);
  });
});

describe('Live controller, free mode', () => {
  it('streams the microphone to Gemini Live, plays its audio and labels the transcript free', async () => {
    const { controller, spoken, playback, capture } = controllerWith({});
    await controller.start('free');
    assert.equal(controller.engine(), 'live');
    assert.equal(controller.state(), 'listening');
    assert.equal(capture.started, 1);
    await controller.say('Tell me something.');
    await until(() => controller.transcript.entries().some((e) => e.role === 'assistant' && !e.open));
    const [user, answer] = controller.transcript.entries();
    assert.deepEqual([user.role, user.text], ['user', 'Tell me something.']);
    assert.equal(answer.label, 'free');
    assert.equal(answer.text, FAKE_LIVE_ANSWERS.en);
    assert.ok(playback.played.length > 0, 'the native audio was played');
    await until(() => spoken.length > 0);
    assert.deepEqual(spoken, ['Free conversation, answers are not checked.']);
    controller.stop();
    assert.equal(controller.state(), 'ended');
    assert.equal(controller.reason(), 'stopped');
    assert.match(renderTranscript(controller.transcript.entries()).value, /data-live-label="free"/);
  });

  it('flushes the playback when the model is interrupted', async () => {
    const { controller, playback } = controllerWith({ liveToken: () => directToken('[[fake:interrupt]]') });
    await controller.start('free');
    await controller.say('Go on.');
    await until(() => playback.flushed > 0);
    controller.stop();
  });

  it('goes on as push-to-talk turns when the service refuses the session', async () => {
    const { controller, spoken } = controllerWith({
      liveToken: () => directToken('[[fake:refuse]]'),
      ask: async function* () {
        yield 'Paris is the capital ';
        yield 'of France.';
      },
    });
    await controller.start('free');
    await until(() => controller.engine() === 'turns' && controller.state() === 'ready');
    await controller.talk();
    assert.equal(controller.state(), 'listening');
    await controller.talk();
    await until(() => controller.state() === 'ready' && spoken.length >= 2);
    assert.deepEqual(spoken, ['Free conversation, answers are not checked.', 'Paris is the capital of France.']);
    controller.stop();
  });

  it('uses turns from the start without Gemini Live', async () => {
    const { controller } = controllerWith({ canUseLive: () => false });
    await controller.start('free');
    assert.equal(controller.engine(), 'turns');
    assert.equal(controller.state(), 'ready');
    controller.stop();
  });
});

describe('Live controller, source mode', () => {
  it('retrieves per turn and speaks only the sentences the gate releases, then the withheld count', async () => {
    /** @type {any[]} */
    const turns = [];
    const { controller, spoken } = controllerWith({
      ask: async function* (turn) {
        turns.push(turn);
        yield 'The yearly budget is 480 EUR. [Doc: plan.md, Chunk: 2]';
        yield ' The team has 12 members.';
      },
    });
    await controller.start('sources');
    assert.equal(controller.engine(), 'turns', 'native audio cannot be gated');
    await controller.talk();
    await controller.talk();
    await until(() => controller.state() === 'ready' && spoken.length >= 2);
    assert.equal(turns[0].mode, 'grounded');
    assert.deepEqual(turns[0].sources, SOURCES);
    assert.equal(turns[0].text, 'What is the budget?');
    assert.match(spoken[0], /^The yearly budget is 480/);
    assert.equal(spoken[1], '1 sentence withheld.');
    assert.equal(spoken.length, 2, 'no free notice and no unsupported sentence');
    const answer = controller.transcript.entries().find((e) => e.role === 'assistant');
    assert.equal(answer?.label, 'checked');
    assert.equal(answer?.withheld, 1);
    assert.doesNotMatch(answer?.text ?? '', /12 members/, 'the screen shows what was released');
    controller.stop();
  });

  it('a typed turn works the same way, and a press while it speaks interrupts', async () => {
    let release = () => {};
    const gate = new Promise((resolve) => (release = () => resolve(undefined)));
    const { controller, spoken } = controllerWith({
      ask: async function* () {
        yield 'The review is in May. [Doc: plan.md, Chunk: 2] It ';
        await gate;
        yield 'ends there.';
      },
    });
    await controller.start('sources');
    const pending = controller.say('When is the review?');
    await until(() => spoken.length === 1);
    assert.equal(spoken[0], 'The review is in May.');
    await controller.talk(); // interrupts
    release();
    await pending;
    assert.equal(controller.state(), 'ready');
    controller.stop();
  });
});

describe('Live session limits', () => {
  /** A clock and a page the test controls. */
  function world() {
    const clock = { t: 1_000_000 };
    /** @type {Array<() => void>} */
    const visibility = [];
    const doc = /** @type {any} */ ({ visibilityState: 'visible', addEventListener: (/** @type {string} */ _type, /** @type {() => void} */ fn) => visibility.push(fn), removeEventListener() {} });
    return { clock, doc, hide: () => ((doc.visibilityState = 'hidden'), visibility.forEach((fn) => fn())) };
  }

  it('ends after 3 minutes of silence and after 15 minutes', async () => {
    const w = world();
    const { controller } = controllerWith({ canUseLive: () => false, now: () => w.clock.t, doc: w.doc, tickMs: 5 });
    await controller.start('free');
    w.clock.t += LIVE_LIMITS.silenceMs + 1;
    await until(() => controller.state() === 'ended');
    assert.equal(controller.reason(), 'silence');

    const w2 = world();
    const long = controllerWith({ canUseLive: () => false, now: () => w2.clock.t, doc: w2.doc, tickMs: 5 });
    await long.controller.start('free');
    for (let i = 0; i < 6; i += 1) {
      w2.clock.t += LIVE_LIMITS.sessionMs / 5;
      await long.controller.say('Still here.');
    }
    await until(() => long.controller.state() === 'ended');
    assert.equal(long.controller.reason(), 'limit');
  });

  it('ends when the tab is hidden', async () => {
    const w = world();
    const { controller } = controllerWith({ canUseLive: () => false, doc: w.doc });
    await controller.start('sources');
    w.hide();
    assert.equal(controller.state(), 'ended');
    assert.equal(controller.reason(), 'hidden');
  });
});

describe('Live turns and transcript', () => {
  it('build a turn prompt with the excerpts as data', () => {
    const grounded = turnMessages({ text: 'What is the budget?', mode: 'grounded', sources: SOURCES, history: [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hello.' }], image: null, locale: 'de', signal: new AbortController().signal });
    assert.ok(grounded.system.startsWith(TURN_INSTRUCTIONS.de.grounded));
    assert.match(grounded.system, /<<<EXCERPT 1 \[Doc: plan\.md, Chunk: 2\]>>>/);
    assert.deepEqual(grounded.messages.map((m) => m.role), ['user', 'assistant', 'user']);
    const free = turnMessages({ text: 'Hi', mode: 'free', sources: [], history: [], image: { mime: 'image/jpeg', data: 'AAAA' }, locale: 'en', signal: new AbortController().signal });
    assert.equal(free.system, TURN_INSTRUCTIONS.en.free);
    assert.deepEqual(free.messages[0].content.map((p) => p.type), ['text', 'image']);
  });

  it('pick the first provider the user can reach', () => {
    assert.equal(pickTurnModel({ key: (id) => (id === 'groq' ? testKey('groq') : ''), pool: () => false })?.provider, 'groq');
    assert.equal(pickTurnModel({ key: () => '', pool: (id) => id === 'gemini' })?.provider, 'gemini');
    assert.equal(pickTurnModel({ key: () => '', pool: () => false }), null);
  });

  it('append fragments to the open entry and keep a bounded history', () => {
    const t = createTranscript({ limit: 3 });
    t.append('user', 'Hello');
    t.append('user', 'there');
    t.close('user');
    t.append('assistant', 'Hi', 'free');
    t.append('assistant', '!', 'free');
    t.close('assistant', { withheld: 0 });
    assert.deepEqual(t.history(), [
      { role: 'user', text: 'Hello there' },
      { role: 'assistant', text: 'Hi!' },
    ]);
    t.append('user', 'Again');
    t.close('user');
    t.ensure('assistant', 'checked');
    assert.equal(t.entries().length, 3);
    assert.match(renderTranscript(t.entries()).value, /data-i18n="live\.transcript\.thinking"/);
  });
});
