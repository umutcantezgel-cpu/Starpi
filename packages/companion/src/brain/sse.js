// @ts-check
// Server-sent events from a fetch body: one {event, data} per blank-line-terminated block, with
// multi-line data joined by newlines, comments skipped, and CRLF or LF line ends. A block cut off
// by the end of the stream is still delivered.

/**
 * @param {ReadableStream<Uint8Array> | null} body
 * @returns {AsyncGenerator<{ event: string, data: string }>}
 */
export async function* readSse(body) {
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  /** @type {string[]} */
  let data = [];
  const flush = function* () {
    if (data.length > 0) yield { event: event || 'message', data: data.join('\n') };
    event = '';
    data = [];
  };
  /** @param {string} line */
  function* takeLine(line) {
    if (line === '') {
      yield* flush();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (/** @type {unknown} */ (body))) {
    buffer += decoder.decode(chunk, { stream: true });
    let at;
    while ((at = buffer.search(/\r\n|\n|\r/)) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + (buffer.startsWith('\r\n', at) ? 2 : 1));
      yield* takeLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer !== '') yield* takeLine(buffer);
  yield* flush();
}

/**
 * Passes events of a stream on and turns a broken connection into a stable error code.
 * @template T
 * @param {AsyncIterable<T>} events
 * @param {string} brain
 * @param {AbortSignal} signal
 * @returns {AsyncGenerator<T>}
 */
export async function* guardStream(events, brain, signal) {
  try {
    yield* events;
  } catch (err) {
    throw transportError(brain, err, signal);
  }
}
