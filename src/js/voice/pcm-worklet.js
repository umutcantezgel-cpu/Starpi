// @ts-check
// AudioWorklet processor of the microphone (build entry "pcm-worklet"; capture.js loads it from
// PCM_WORKLET_URL). It runs in the AudioWorkletGlobalScope and imports nothing. It turns the
// microphone, at the context's rate (usually 48 or 44.1 kHz), into 16 kHz PCM16 frames of 20 ms and
// posts each with its level through the port. Nothing is kept beyond the frame being filled.
//
// Resampling: two cascaded second-order low-pass sections (a fourth-order Butterworth response)
// cut off below the output's Nyquist frequency, then each output sample is read at its fractional
// input position by linear interpolation. That is plenty for speech recognition and costs a few
// multiplications per input sample.
//
// Port messages in: { type: 'flush' } posts the partial frame, then { type: 'flushed' }; 'stop' does
// the same and ends the processor. Out: { type: 'frame', pcm: ArrayBuffer (Int16, transferred),
// level: RMS in [0, 1] }.

/**
 * @typedef {{ readonly port: MessagePort }} ProcessorBase
 * @typedef {{ processorOptions?: { outputRate?: unknown, frameMs?: unknown } }} ProcessorInit
 * @typedef {{
 *   AudioWorkletProcessor: new (options?: ProcessorInit) => ProcessorBase,
 *   registerProcessor: (name: string, ctor: new (options?: ProcessorInit) => ProcessorBase) => void,
 *   sampleRate: number,
 * }} WorkletGlobals
 */

const scope = /** @type {WorkletGlobals} */ (/** @type {unknown} */ (globalThis));

/** The processor name capture.js asks for (PCM_PROCESSOR there). */
export const PROCESSOR_NAME = 'starpi-pcm';
const DEFAULT_OUTPUT_RATE = 16_000;
const DEFAULT_FRAME_MS = 20;
/** Cut-off as a share of the output Nyquist frequency. */
const CUTOFF_SHARE = 0.9;
/** Quality factors of the two sections of a fourth-order Butterworth low-pass. */
const BUTTERWORTH_Q = [0.5412, 1.3066];

/**
 * One second-order low-pass section (transposed direct form II).
 * @param {number} rate input rate
 * @param {number} cutoff Hz
 * @param {number} q
 */
function lowPass(rate, cutoff, q) {
  const w = (2 * Math.PI * cutoff) / rate;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0;
  const b1 = (1 - cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let z1 = 0;
  let z2 = 0;
  return (/** @type {number} */ x) => {
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    return y;
  };
}

/**
 * A streaming mono resampler from `inputRate` to `outputRate` (down-sampling with a low-pass, or a
 * plain copy when both rates are equal).
 * @param {number} inputRate
 * @param {number} outputRate
 * @returns {(input: Float32Array, emit: (sample: number) => void) => void}
 */
export function createResampler(inputRate, outputRate) {
  if (inputRate === outputRate) return (input, emit) => input.forEach((s) => emit(s));
  const step = inputRate / outputRate;
  const cutoff = (Math.min(inputRate, outputRate) / 2) * CUTOFF_SHARE;
  const sections = BUTTERWORTH_Q.map((q) => lowPass(inputRate, cutoff, q));
  let previous = 0;
  // Input samples seen so far, and the input position of the next output sample.
  let index = 0;
  let next = 0;
  return (input, emit) => {
    for (let i = 0; i < input.length; i += 1) {
      let x = input[i];
      for (const section of sections) x = section(x);
      // Output samples that fall between the previous input sample (index - 1) and this one.
      while (next <= index) {
        const frac = next - (index - 1);
        emit(previous + (x - previous) * frac);
        next += step;
      }
      previous = x;
      index += 1;
    }
  };
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function within(value, fallback, min, max) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/**
 * The processor class, built on the scope's AudioWorkletProcessor.
 * @param {WorkletGlobals} globals
 */
export function defineProcessor(globals) {
  // The context's rate is fixed for the life of the scope.
  const inputRate = globals.sampleRate;
  return class PcmCaptureProcessor extends globals.AudioWorkletProcessor {
    /** @param {ProcessorInit} [options] */
    constructor(options) {
      super(options);
      const opts = options?.processorOptions ?? {};
      const outputRate = within(opts.outputRate, DEFAULT_OUTPUT_RATE, 8000, 48_000);
      const frameMs = within(opts.frameMs, DEFAULT_FRAME_MS, 10, 100);
      this.resample = createResampler(inputRate, outputRate);
      this.frame = new Int16Array(Math.round((outputRate * frameMs) / 1000));
      this.fill = 0;
      this.energy = 0;
      this.ended = false;
      this.push = (/** @type {number} */ sample) => {
        const v = Math.max(-1, Math.min(1, sample));
        this.frame[this.fill++] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
        this.energy += v * v;
        if (this.fill === this.frame.length) this.post();
      };
      this.port.onmessage = (event) => {
        const type = event.data?.type;
        if (type !== 'flush' && type !== 'stop') return;
        this.post();
        this.port.postMessage({ type: 'flushed' });
        if (type === 'stop') this.ended = true;
      };
    }

    /** Sends what the frame holds (a partial frame on flush). */
    post() {
      if (this.fill === 0) return;
      const pcm = this.frame.slice(0, this.fill);
      const level = Math.sqrt(this.energy / this.fill);
      this.fill = 0;
      this.energy = 0;
      this.port.postMessage({ type: 'frame', pcm: pcm.buffer, level }, [pcm.buffer]);
    }

    /**
     * @param {Float32Array[][]} inputs
     * @returns {boolean} true while the processor should keep running
     */
    process(inputs) {
      if (this.ended) return false;
      const channels = inputs[0];
      if (!channels?.length || !channels[0]) return true;
      let mono = channels[0];
      if (channels.length > 1) {
        mono = new Float32Array(channels[0].length);
        for (const channel of channels) for (let i = 0; i < mono.length; i += 1) mono[i] += channel[i] / channels.length;
      }
      this.resample(mono, this.push);
      return true;
    }
  };
}

if (typeof scope.registerProcessor === 'function' && typeof scope.AudioWorkletProcessor === 'function') {
  scope.registerProcessor(PROCESSOR_NAME, defineProcessor(scope));
}
