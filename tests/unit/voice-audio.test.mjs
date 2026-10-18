// Audio plumbing of the voice features: PCM and WAV conversion, base64 for JSON bodies and Live
// frames, the sample rate of PCM media types, and the microphone worklet's resampler (loaded under
// a stand-in AudioWorkletGlobalScope).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  base64ToBytes,
  base64ToPcm16,
  bytesToBase64,
  concatPcm,
  decodeWav,
  durationMs,
  encodeWav,
  floatToPcm16,
  levelOf,
  pcm16ToBase64,
  pcm16ToFloat,
  pcmRate,
} from '../../src/js/voice/wav.js';

/** @param {number} n @param {number} freq @param {number} rate */
const sine = (n, freq, rate, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));

describe('PCM and WAV', () => {
  it('converts floats to PCM16 and back, clipping out-of-range values', () => {
    const pcm = floatToPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
    assert.deepEqual([...pcm], [0, 32767, -32768, 32767, -32768, 16384]);
    const back = pcm16ToFloat(pcm);
    assert.equal(back[1], 1);
    assert.equal(back[2], -1);
  });

  it('writes a mono WAV that reads back to the same samples', () => {
    const pcm = Int16Array.from([0, 1000, -1000, 32767, -32768]);
    const wav = encodeWav(pcm, 16_000);
    assert.equal(wav.byteLength, 44 + pcm.length * 2);
    assert.equal(Buffer.from(wav.subarray(0, 4)).toString('ascii'), 'RIFF');
    const read = decodeWav(wav);
    assert.equal(read?.rate, 16_000);
    assert.deepEqual([...(read?.samples ?? [])], [...pcm]);
    assert.equal(durationMs(new Int16Array(16_000), 16_000), 1000);
  });

  it('mixes stereo down, skips foreign chunks and refuses other sample formats', () => {
    const data = Buffer.alloc(8);
    data.writeInt16LE(100, 0);
    data.writeInt16LE(300, 2);
    data.writeInt16LE(-200, 4);
    data.writeInt16LE(-400, 6);
    const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([3, 0, 0, 0]), Buffer.from('abc'), Buffer.from([0])]);
    const fmt = Buffer.alloc(24);
    fmt.write('fmt ', 0, 'ascii');
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt16LE(1, 8);
    fmt.writeUInt16LE(2, 10);
    fmt.writeUInt32LE(22_050, 12);
    fmt.writeUInt32LE(22_050 * 4, 16);
    fmt.writeUInt16LE(4, 20);
    fmt.writeUInt16LE(16, 22);
    const dataHead = Buffer.alloc(8);
    dataHead.write('data', 0, 'ascii');
    dataHead.writeUInt32LE(data.length, 4);
    const body = Buffer.concat([Buffer.from('WAVE'), list, fmt, dataHead, data]);
    const riff = Buffer.concat([Buffer.from('RIFF'), Buffer.from(new Uint32Array([body.length]).buffer), body]);
    const read = decodeWav(new Uint8Array(riff));
    assert.equal(read?.rate, 22_050);
    assert.deepEqual([...(read?.samples ?? [])], [200, -300]);
    const float = Buffer.from(riff);
    float.writeUInt16LE(3, 12 + list.length + 8); // format tag of the fmt chunk: IEEE float
    assert.equal(decodeWav(new Uint8Array(float)), null);
    assert.equal(decodeWav(new Uint8Array(10)), null);
  });

  it('encodes base64 like the platform and reads base64url too', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 255, 1000]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256);
      const text = bytesToBase64(bytes);
      assert.equal(text, Buffer.from(bytes).toString('base64'));
      assert.deepEqual([...(base64ToBytes(text) ?? [])], [...bytes]);
      assert.deepEqual([...(base64ToBytes(Buffer.from(bytes).toString('base64url')) ?? [])], [...bytes]);
    }
    assert.equal(base64ToBytes('a$b='), null);
    const pcm = Int16Array.from([1, -2, 300, -32768]);
    assert.deepEqual([...base64ToPcm16(pcm16ToBase64(pcm))], [...pcm]);
    assert.equal(base64ToPcm16('not base64!').length, 0);
  });

  it('reads the rate of PCM media types only', () => {
    assert.equal(pcmRate('audio/L16;codec=pcm;rate=24000'), 24_000);
    assert.equal(pcmRate('audio/pcm;rate=16000'), 16_000);
    assert.equal(pcmRate('audio/mpeg'), null);
    assert.equal(pcmRate('audio/pcm;rate=12'), null);
  });

  it('measures levels and joins chunks', () => {
    assert.equal(levelOf(new Int16Array(10)), 0);
    assert.ok(levelOf(floatToPcm16(sine(1600, 440, 16_000))) > 0.3);
    assert.deepEqual([...concatPcm([Int16Array.from([1, 2]), Int16Array.from([3])])], [1, 2, 3]);
  });
});

describe('microphone worklet', () => {
  /** Loads the worklet under a stand-in scope and returns its processor class. */
  async function loadProcessor(rate = 48_000) {
    /** @type {any} */
    const g = globalThis;
    /** @type {any} */
    let registered = null;
    const saved = { AudioWorkletProcessor: g.AudioWorkletProcessor, registerProcessor: g.registerProcessor, sampleRate: g.sampleRate };
    g.AudioWorkletProcessor = class {
      constructor() {
        /** @type {any[]} */
        this.sent = [];
        this.port = { onmessage: null, postMessage: (/** @type {any} */ m) => this.sent.push(m) };
      }
    };
    g.registerProcessor = (/** @type {string} */ name, /** @type {any} */ ctor) => (registered = { name, ctor });
    g.sampleRate = rate;
    try {
      const mod = await import(`../../src/js/voice/pcm-worklet.js?rate=${rate}`);
      return { mod, registered };
    } finally {
      Object.assign(g, saved);
    }
  }

  it('registers its processor and posts 20 ms frames of 16 kHz PCM16 with their level', async () => {
    const { registered } = await loadProcessor(48_000);
    assert.equal(registered.name, 'starpi-pcm');
    const processor = new registered.ctor({ processorOptions: { outputRate: 16_000, frameMs: 20 } });
    const input = sine(48_000, 440, 48_000);
    for (let at = 0; at < input.length; at += 128) assert.equal(processor.process([[input.subarray(at, at + 128)]]), true);
    const frames = processor.sent.filter((/** @type {any} */ m) => m.type === 'frame');
    const total = frames.reduce((/** @type {number} */ n, /** @type {any} */ f) => n + new Int16Array(f.pcm).length, 0);
    assert.ok(Math.abs(total - 16_000) <= 320, `about one second at 16 kHz, got ${total}`);
    assert.ok(frames.every((/** @type {any} */ f) => new Int16Array(f.pcm).length === 320));
    assert.ok(frames.at(-1).level > 0.25 && frames.at(-1).level < 0.45);
    processor.port.onmessage({ data: { type: 'stop' } });
    assert.equal(processor.sent.at(-1).type, 'flushed');
    assert.equal(processor.process([[new Float32Array(128)]]), false);
  });

  it('keeps speech-band tones and damps tones above the output Nyquist frequency', async () => {
    const { mod } = await loadProcessor(48_000);
    /** @param {number} freq */
    const outLevel = (freq) => {
      /** @type {number[]} */
      const out = [];
      mod.createResampler(48_000, 16_000)(sine(48_000, freq, 48_000), (/** @type {number} */ s) => out.push(s));
      const tail = out.slice(4000);
      return Math.sqrt(tail.reduce((a, s) => a + s * s, 0) / tail.length);
    };
    assert.ok(outLevel(1000) > 0.3, 'a 1 kHz tone passes');
    assert.ok(outLevel(12_000) < 0.05, 'a 12 kHz tone does not fold back into the speech band');
    /** @type {number[]} */
    const same = [];
    mod.createResampler(16_000, 16_000)(Float32Array.from([0.1, 0.2]), (/** @type {number} */ s) => same.push(s));
    assert.deepEqual(same.map((v) => Math.round(v * 10) / 10), [0.1, 0.2]);
  });
});
