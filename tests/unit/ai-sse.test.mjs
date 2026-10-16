// The AI layer's event-stream plumbing: the line parser (ids, byte order mark, limits), the body
// reader with its idle limit and size cap, the capped text reader and the writer.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSseParser as legacyParser } from '../../src/js/chat-stream.js';
import { createSseParser, formatSse, MAX_SSE_BUFFER_CHARS, readSse, readText, SseIdleError } from '../../src/js/ai/sse.js';

const encoder = new TextEncoder();

/**
 * @param {string[]} chunks
 * @param {import('../../src/js/ai/sse.js').SseParserOptions} [options]
 */
function parse(chunks, options) {
  /** @type {import('../../src/js/ai/sse.js').SseEvent[]} */
  const events = [];
  const parser = createSseParser((ev) => events.push(ev), options);
  for (const chunk of chunks) parser.push(chunk);
  parser.end();
  return events;
}

/**
 * A byte stream of the given pieces; with `hold` it stays open after them.
 * @param {Array<string | Uint8Array>} pieces
 * @param {{ hold?: boolean }} [options]
 */
function body(pieces, options = {}) {
  const state = { cancelled: false };
  const stream = new ReadableStream({
    start(controller) {
      for (const p of pieces) controller.enqueue(typeof p === 'string' ? encoder.encode(p) : p);
      if (!options.hold) controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

/** @param {AsyncIterable<unknown>} it */
async function all(it) {
  const out = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('createSseParser (ai/sse.js)', () => {
  it('is the parser chat-stream.js exports', () => {
    assert.equal(legacyParser, createSseParser);
  });

  it('reports the last event id when asked, and keeps it across events', () => {
    const events = parse(['id: 7\ndata: a\n\ndata: b\n\nid: 8\nevent: x\ndata: c\n\n'], { ids: true });
    assert.deepEqual(events, [
      { event: 'message', data: 'a', id: '7' },
      { event: 'message', data: 'b', id: '7' },
      { event: 'x', data: 'c', id: '8' },
    ]);
  });

  it('ignores an id that contains NUL and leaves ids out by default', () => {
    assert.deepEqual(parse(['id: 1\n\nid: a\0b\ndata: x\n\n'], { ids: true }), [{ event: 'message', data: 'x', id: '1' }]);
    assert.deepEqual(parse(['id: 1\ndata: x\n\n']), [{ event: 'message', data: 'x' }]);
  });

  it('skips a leading byte order mark only at the very start', () => {
    assert.deepEqual(parse(['﻿data: a\n\n']), [{ event: 'message', data: 'a' }]);
    assert.deepEqual(parse(['data: a\n\n', '﻿data: b\n\n']), [{ event: 'message', data: 'a' }]);
  });

  it('keeps empty data lines, joins multi-line data and treats a field without colon as empty', () => {
    assert.deepEqual(parse(['data\ndata:\ndata: x\n\n']), [{ event: 'message', data: '\n\nx' }]);
    assert.deepEqual(parse(['event: only-name\n\n']), []);
  });

  it('honours a smaller size limit', () => {
    const parser = createSseParser(() => {}, { maxChars: 10 });
    assert.throws(() => parser.push('data: 0123456789abc'), RangeError);
    assert.equal(MAX_SSE_BUFFER_CHARS, 1_000_000);
  });
});

describe('readSse', () => {
  it('decodes multi-byte characters split across chunks', async () => {
    const bytes = encoder.encode('data: Grüße\n\n');
    const { stream } = body([bytes.slice(0, 9), bytes.slice(9)]);
    assert.deepEqual(await all(readSse(stream)), [{ event: 'message', data: 'Grüße', id: '' }]);
  });

  it('delivers a last event without its blank line', async () => {
    const { stream } = body(['data: one\n\ndata: two']);
    assert.deepEqual((await all(readSse(stream))).map((e) => /** @type {{ data: string }} */ (e).data), ['one', 'two']);
  });

  it('throws SseIdleError when the body goes quiet and cancels it', async () => {
    const { stream, state } = body(['data: first\n\n'], { hold: true });
    const seen = [];
    await assert.rejects(async () => {
      for await (const ev of readSse(stream, { idleMs: 30 })) seen.push(ev);
    }, SseIdleError);
    assert.equal(seen.length, 1);
    assert.equal(state.cancelled, true);
  });

  it('throws RangeError beyond maxBytes', async () => {
    const { stream } = body(['data: 1234567890\n\n', 'data: 1234567890\n\n']);
    await assert.rejects(all(readSse(stream, { maxBytes: 25 })), RangeError);
  });

  it('cancels the body when the consumer stops early', async () => {
    const { stream, state } = body(['data: a\n\ndata: b\n\n'], { hold: true });
    for await (const ev of readSse(stream)) {
      assert.equal(/** @type {{ data: string }} */ (ev).data, 'a');
      break;
    }
    assert.equal(state.cancelled, true);
  });

  it('yields nothing for a missing body', async () => {
    assert.deepEqual(await all(readSse(null)), []);
  });
});

describe('readText', () => {
  it('returns the prefix up to maxBytes with truncate, and throws without', async () => {
    assert.equal(await readText(body(['abcdef', 'ghij']).stream, { maxBytes: 8, truncate: true }), 'abcdefgh');
    await assert.rejects(readText(body(['abcdef', 'ghij']).stream, { maxBytes: 8 }), RangeError);
    assert.equal(await readText(body(['ab', 'cd']).stream, { maxBytes: 8 }), 'abcd');
  });
});

describe('formatSse', () => {
  it('round-trips through the parser, including line breaks and ids', () => {
    const wire = formatSse({ event: 'message_start', id: '3', data: { type: 'x', text: 'a\nb' } }) + formatSse({ data: 'line one\r\nline two' });
    assert.deepEqual(parse([wire], { ids: true }), [
      { event: 'message_start', data: JSON.stringify({ type: 'x', text: 'a\nb' }), id: '3' },
      { event: 'message', data: 'line one\nline two', id: '3' },
    ]);
  });
});
