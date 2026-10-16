// @ts-check
// Server-sent events (text/event-stream): an incremental line parser, a reader that turns a
// response body into events with an idle limit and a size cap, and the writer the fake providers
// and tests use. No DOM and no I/O of its own, so the browser, workers and server code share it.

/** Longest unterminated line or pending event the parser holds before it gives up. */
export const MAX_SSE_BUFFER_CHARS = 1_000_000;
/** Largest event stream readSse() accepts (bytes on the wire). */
export const MAX_SSE_STREAM_BYTES = 16 * 1024 * 1024;

/**
 * One dispatched event. `id` is the last event id seen so far (the id persists across events, as
 * in the EventSource standard); it is present only when the parser was created with `ids: true`.
 * @typedef {{ event: string, data: string, id?: string }} SseEvent
 */

/**
 * @typedef {object} SseParserOptions
 * @property {number} [maxChars]  limit for one unterminated line plus the event it belongs to
 * @property {boolean} [ids]      report the last event id on every event
 */

/** Thrown by readSse() when no byte arrived within the idle limit. */
export class SseIdleError extends Error {
  /** @param {number} ms */
  constructor(ms) {
    super(`The event stream sent nothing for ${ms} ms`);
    this.name = 'SseIdleError';
    this.idleMs = ms;
  }
}

/**
 * Incremental text/event-stream parser. Lines end in \n, \r\n or \r; a chunk that ends in \r waits
 * for the next one, which may start with the \n of the same line end. A leading byte order mark is
 * skipped. Comments and the `retry` field are ignored, `id` is ignored unless `ids` is set (an id
 * containing NUL is ignored as the standard says); a blank line dispatches the event, and an event
 * without data lines is dropped.
 * @param {(ev: SseEvent) => void} onEvent
 * @param {SseParserOptions} [options]
 * @returns {{ push(text: string): void, end(): void }}
 */
export function createSseParser(onEvent, options = {}) {
  const maxChars = options.maxChars ?? MAX_SSE_BUFFER_CHARS;
  const withIds = options.ids === true;
  let buffer = '';
  let event = '';
  let lastId = '';
  /** @type {string[]} */
  let data = [];
  let pending = 0;
  let started = false;

  const dispatch = () => {
    if (data.length) {
      const ev = { event: event || 'message', data: data.join('\n') };
      onEvent(withIds ? { ...ev, id: lastId } : ev);
    }
    event = '';
    data = [];
    pending = 0;
  };

  /** @param {string} line */
  const processLine = (line) => {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? '' : line.slice(colon + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;
    if (field === 'data') {
      data.push(value);
      pending += value.length;
    } else if (field === 'event') event = value;
    else if (field === 'id' && !value.includes('\0')) lastId = value;
  };

  /** @param {boolean} final */
  const drain = (final) => {
    const lineEnd = /\r\n|\r|\n/g;
    let start = 0;
    for (let m = lineEnd.exec(buffer); m; m = lineEnd.exec(buffer)) {
      // A lone \r at the end may be the first half of \r\n.
      if (!final && m[0] === '\r' && m.index === buffer.length - 1) break;
      processLine(buffer.slice(start, m.index));
      start = m.index + m[0].length;
    }
    buffer = buffer.slice(start);
  };

  return {
    push(text) {
      if (!started && text) {
        started = true;
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      }
      buffer += text;
      drain(false);
      if (buffer.length + pending > maxChars) throw new RangeError('The event stream sent an event that is too long');
    },
    // Lenient on purpose: a stream cut off before its final blank line still delivers its last event.
    end() {
      drain(true);
      if (buffer) processLine(buffer);
      buffer = '';
      dispatch();
    },
  };
}

const IDLE = Symbol('idle');

/**
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {number} ms
 * @returns {Promise<ReadableStreamReadResult<Uint8Array> | typeof IDLE>}
 */
function readWithin(reader, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const idle = new Promise((resolve) => {
    timer = setTimeout(() => resolve(IDLE), ms);
  });
  return /** @type {Promise<ReadableStreamReadResult<Uint8Array> | typeof IDLE>} */ (Promise.race([reader.read(), idle])).finally(() => clearTimeout(timer));
}

/**
 * @typedef {object} ReadSseOptions
 * @property {number} [idleMs]    throw SseIdleError when no byte arrives for this long (0: no limit)
 * @property {number} [maxBytes]  throw RangeError beyond this many bytes
 * @property {number} [maxChars]  parser limit for one event
 * @property {boolean} [ids]      report event ids (default true)
 */

/**
 * The events of a text/event-stream body, in order. Stopping early (break, return) cancels the
 * body, which closes the connection. A body that ends without a final blank line still delivers
 * its last event; a read failure is thrown as it is.
 * @param {ReadableStream<Uint8Array> | null | undefined} body
 * @param {ReadSseOptions} [options]
 * @returns {AsyncGenerator<SseEvent, void, undefined>}
 */
export async function* readSse(body, options = {}) {
  if (!body) return;
  const { idleMs = 0, maxBytes = MAX_SSE_STREAM_BYTES, maxChars = MAX_SSE_BUFFER_CHARS, ids = true } = options;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  /** @type {SseEvent[]} */
  const queue = [];
  const parser = createSseParser((ev) => queue.push(ev), { maxChars, ids });
  let bytes = 0;
  let finished = false;
  try {
    for (;;) {
      const result = idleMs > 0 ? await readWithin(reader, idleMs) : await reader.read();
      if (result === IDLE) throw new SseIdleError(idleMs);
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maxBytes) throw new RangeError('The event stream is too large');
      parser.push(decoder.decode(result.value, { stream: true }));
      for (const ev of queue.splice(0)) yield ev;
    }
    finished = true;
    parser.push(decoder.decode());
    parser.end();
    for (const ev of queue.splice(0)) yield ev;
  } finally {
    if (!finished) reader.cancel().catch(() => {});
  }
}

/**
 * A whole (non-event-stream) body as text, read with the same idle limit. With `truncate`, reading
 * stops at `maxBytes` and the prefix is returned (for error bodies, which are only peeked at);
 * without it a larger body throws RangeError.
 * @param {ReadableStream<Uint8Array> | null | undefined} body
 * @param {{ maxBytes: number, idleMs?: number, truncate?: boolean }} options
 * @returns {Promise<string>}
 */
export async function readText(body, { maxBytes, idleMs = 0, truncate = false }) {
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let finished = false;
  try {
    for (;;) {
      const result = idleMs > 0 ? await readWithin(reader, idleMs) : await reader.read();
      if (result === IDLE) throw new SseIdleError(idleMs);
      if (result.done) break;
      const room = maxBytes - bytes;
      bytes += result.value.byteLength;
      if (bytes > maxBytes) {
        if (!truncate) throw new RangeError('The response body is too large');
        text += decoder.decode(result.value.subarray(0, Math.max(0, room)));
        return text;
      }
      text += decoder.decode(result.value, { stream: true });
    }
    finished = true;
    return text + decoder.decode();
  } finally {
    if (!finished) reader.cancel().catch(() => {});
  }
}

/**
 * One event in wire form. Objects are sent as JSON; line breaks inside the data become several
 * data lines, so the parser joins them back.
 * @param {{ event?: string, data: unknown, id?: string }} ev
 */
export function formatSse(ev) {
  const data = typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data);
  const lines = [];
  if (ev.id !== undefined) lines.push(`id: ${String(ev.id).replace(/[\r\n]/g, '')}`);
  if (ev.event) lines.push(`event: ${ev.event.replace(/[\r\n]/g, '')}`);
  for (const line of String(data).split(/\r\n|\r|\n/)) lines.push(`data: ${line}`);
  return `${lines.join('\n')}\n\n`;
}
