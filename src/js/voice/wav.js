// @ts-check
// PCM and WAV helpers of the voice features. Audio moves as 16-bit little-endian mono PCM: from the
// microphone (16 kHz), from cloud voices (24 kHz) and inside WAV files (a local voice server, the
// site's speech route). This module converts between floats and PCM16, writes and reads WAV,
// encodes PCM for JSON bodies and Live frames as base64, and measures a frame's level. Pure: no
// DOM; runs in the browser, in workers and in Node.

/** Size of the RIFF/WAVE header encodeWav() writes. */
export const WAV_HEADER_BYTES = 44;

/**
 * Floats in [-1, 1] to PCM16 (values outside are clipped).
 * @param {Float32Array} samples
 * @returns {Int16Array}
 */
export function floatToPcm16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i] || 0));
    out[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
  }
  return out;
}

/**
 * PCM16 to floats in [-1, 1].
 * @param {Int16Array} pcm
 * @returns {Float32Array}
 */
export function pcm16ToFloat(pcm) {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) out[i] = pcm[i] / (pcm[i] < 0 ? 0x8000 : 0x7fff);
  return out;
}

/**
 * Joins PCM chunks into one.
 * @param {readonly Int16Array[]} chunks
 * @returns {Int16Array}
 */
export function concatPcm(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Int16Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Root mean square of a frame, 0 (silence) to 1.
 * @param {Int16Array} pcm
 */
export function levelOf(pcm) {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const v = pcm[i] / 0x8000;
    sum += v * v;
  }
  return Math.sqrt(sum / pcm.length);
}

/**
 * Milliseconds of audio in a PCM buffer.
 * @param {Int16Array} pcm
 * @param {number} rate
 */
export function durationMs(pcm, rate) {
  return rate > 0 ? Math.round((pcm.length / rate) * 1000) : 0;
}

/**
 * Bytes of PCM16 little endian (whatever the platform's own byte order).
 * @param {Int16Array} pcm
 * @returns {Uint8Array}
 */
export function pcm16ToBytes(pcm) {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i += 1) view.setInt16(i * 2, pcm[i], true);
  return bytes;
}

/**
 * PCM16 little endian from bytes; a trailing odd byte is ignored.
 * @param {Uint8Array} bytes
 * @returns {Int16Array}
 */
export function bytesToPcm16(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = view.getInt16(i * 2, true);
  return out;
}

/**
 * A mono PCM16 WAV file.
 * @param {Int16Array} pcm
 * @param {number} rate samples per second
 * @returns {Uint8Array}
 */
export function encodeWav(pcm, rate) {
  const data = pcm.length * 2;
  const bytes = new Uint8Array(WAV_HEADER_BYTES + data);
  const view = new DataView(bytes.buffer);
  const ascii = (/** @type {number} */ at, /** @type {string} */ text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + data, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // size of the format chunk
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, data, true);
  for (let i = 0; i < pcm.length; i += 1) view.setInt16(WAV_HEADER_BYTES + i * 2, pcm[i], true);
  return bytes;
}

/**
 * Reads a PCM16 WAV file (mono, or several channels mixed down to one). Chunks other than the
 * format and the data chunk are skipped. Null for anything else: another sample format, a broken
 * header, no data chunk.
 * @param {Uint8Array | ArrayBuffer} input
 * @returns {{ rate: number, samples: Int16Array } | null}
 */
export function decodeWav(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (/** @type {number} */ at) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let at = 12;
  /** @type {{ format: number, channels: number, rate: number, bits: number } | null} */
  let fmt = null;
  while (at + 8 <= bytes.byteLength) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= bytes.byteLength) {
      let format = view.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE carries the real format in the first two bytes of its sub-format GUID.
      if (format === 0xfffe && size >= 40 && body + 26 <= bytes.byteLength) format = view.getUint16(body + 24, true);
      fmt = { format, channels: view.getUint16(body + 2, true), rate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16 || fmt.channels < 1 || fmt.rate < 1) return null;
      // A streamed WAV may declare a size larger than what arrived (or 0xFFFFFFFF): read what is there.
      const end = Math.min(bytes.byteLength, body + size);
      const frames = Math.floor((end - body) / (2 * fmt.channels));
      const samples = new Int16Array(frames);
      for (let f = 0; f < frames; f += 1) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c += 1) sum += view.getInt16(body + (f * fmt.channels + c) * 2, true);
        samples[f] = Math.round(sum / fmt.channels);
      }
      return { rate: fmt.rate, samples };
    }
    at = body + size + (size % 2); // chunks are padded to an even size
  }
  return null;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** @type {Int16Array} */
const B64_INDEX = (() => {
  const index = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i += 1) index[B64.charCodeAt(i)] = i;
  index['-'.charCodeAt(0)] = 62; // base64url
  index['_'.charCodeAt(0)] = 63;
  return index;
})();

/**
 * Standard base64 (with padding) of bytes.
 * @param {Uint8Array} bytes
 */
export function bytesToBase64(bytes) {
  const parts = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    chunk += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] + (i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=') + (i + 2 < bytes.length ? B64[c & 63] : '=');
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = '';
    }
  }
  parts.push(chunk);
  return parts.join('');
}

/**
 * Bytes of a base64 or base64url text; white space is ignored. Null when the text has other
 * characters or a broken length.
 * @param {string} text
 * @returns {Uint8Array | null}
 */
export function base64ToBytes(text) {
  const clean = String(text ?? '').replace(/[\s=]+$/g, '').replace(/\s+/g, '');
  if (clean.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let at = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const code = clean.charCodeAt(i);
    const value = code < 128 ? B64_INDEX[code] : -1;
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

/**
 * Base64 of PCM16 little endian (the audio of Live frames and of speech answers).
 * @param {Int16Array} pcm
 */
export function pcm16ToBase64(pcm) {
  return bytesToBase64(pcm16ToBytes(pcm));
}

/**
 * PCM16 from base64; an unreadable text gives no samples.
 * @param {string} text
 * @returns {Int16Array}
 */
export function base64ToPcm16(text) {
  const bytes = base64ToBytes(text);
  return bytes ? bytesToPcm16(bytes) : new Int16Array(0);
}

/**
 * The sample rate a PCM media type names ("audio/L16;codec=pcm;rate=24000", "audio/pcm;rate=16000").
 * @param {unknown} mime
 * @returns {number | null}
 */
export function pcmRate(mime) {
  if (typeof mime !== 'string' || !/^audio\/(?:l16|pcm)\b/i.test(mime.trim())) return null;
  const m = /;\s*rate=(\d{4,6})\b/i.exec(mime);
  const rate = m ? Number(m[1]) : null;
  return rate && rate >= 8000 && rate <= 96_000 ? rate : null;
}
