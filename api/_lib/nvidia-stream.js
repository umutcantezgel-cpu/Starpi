// @ts-check
// Relays a committed upstream SSE stream to the browser, byte for byte, with an idle timeout, a size cap
// and a hard deadline. A failure after the first byte can no longer change the HTTP status, so it ends
// the stream with an SSE error event the browser client maps to a message.

/** @typedef {'stream_timeout' | 'stream_too_large' | 'upstream_interrupted'} StreamErrorCode */

const encoder = new TextEncoder();
const TIMEOUT = Symbol('timeout');

/**
 * The event starts with a blank line, which ends any event the upstream left half-written.
 * @param {StreamErrorCode} code
 */
export function sseError(code) {
  return encoder.encode(`\n\ndata: ${JSON.stringify({ error: { code } })}\n\n`);
}

/**
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {number} ms
 * @returns {Promise<ReadableStreamReadResult<Uint8Array> | typeof TIMEOUT>}
 */
function readWithin(reader, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  return /** @type {Promise<ReadableStreamReadResult<Uint8Array> | typeof TIMEOUT>} */ (Promise.race([reader.read(), timeout])).finally(() => clearTimeout(timer));
}

/**
 * @param {{ first: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array>, abort: () => void, now: () => number,
 *   idleMs: number, hardDeadline: number, maxBytes: number }} options `abort` releases the upstream request;
 *   `hardDeadline` is a time on the `now` clock
 * @returns {ReadableStream<Uint8Array>}
 */
export function relayStream({ first, reader, abort, now, idleMs, hardDeadline, maxBytes }) {
  let size = first.byteLength;
  let ended = false;

  function stopUpstream() {
    reader.cancel().catch(() => {});
    abort();
  }

  return new ReadableStream({
    start(controller) {
      controller.enqueue(first);
    },
    async pull(controller) {
      /** @param {StreamErrorCode} [code] */
      const end = (code) => {
        if (ended) return;
        ended = true;
        if (code) controller.enqueue(sseError(code));
        controller.close();
        stopUpstream();
      };
      const wait = Math.min(idleMs, hardDeadline - now());
      if (wait <= 0) return end('stream_timeout');
      let result;
      try {
        result = await readWithin(reader, wait);
      } catch {
        return end('upstream_interrupted');
      }
      // The browser may have cancelled while the read was pending.
      if (ended) return;
      if (result === TIMEOUT) return end('stream_timeout');
      if (result.done) return end();
      size += result.value.byteLength;
      if (size > maxBytes) return end('stream_too_large');
      controller.enqueue(result.value);
    },
    // The browser closed the connection or pressed Stop.
    cancel() {
      ended = true;
      stopUpstream();
    },
  });
}
