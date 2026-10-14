// Streamed chat completions: the event-stream parser, the chunk assembler and the reasoning split.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createChatStreamAssembler,
  createSseParser,
  MAX_SSE_BUFFER_CHARS,
  MAX_STREAM_CHARS,
  splitReasoning,
  splitStreamingText,
} from '../../src/js/chat-stream.js';

/**
 * Feeds the chunks to a parser and returns the events it dispatched.
 * @param {string[]} chunks
 */
function parse(chunks) {
  /** @type {Array<{ event: string, data: string }>} */
  const events = [];
  const parser = createSseParser((ev) => events.push(ev));
  for (const chunk of chunks) parser.push(chunk);
  parser.end();
  return events;
}

/** @param {Record<string, unknown>} delta @param {string | null} [finish] */
const chunk = (delta, finish = null) => JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] });

const STREAM = [
  ': keep-alive',
  `data: ${chunk({ role: 'assistant' })}`,
  '',
  `data: ${chunk({ content: 'Hello' })}`,
  '',
  'event: ping',
  'data: {}',
  '',
  `data: ${chunk({ content: ' world' }, 'stop')}`,
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

describe('createSseParser', () => {
  it('parses events split at every chunk boundary', () => {
    const whole = parse([STREAM]);
    assert.equal(whole.length, 5);
    assert.deepEqual(parse([...STREAM]), whole);
    assert.deepEqual(whole[2], { event: 'ping', data: '{}' });
  });

  it('handles CRLF and CR endings, including a CRLF split across chunks', () => {
    const expected = [
      { event: 'message', data: 'a' },
      { event: 'message', data: 'b' },
    ];
    assert.deepEqual(parse(['data: a\r\n\r\ndata: b\r\n\r\n']), expected);
    assert.deepEqual(parse(['data: a\r\r', 'data: b\r\r']), expected);
    assert.deepEqual(parse(['data: a\r', '\n\r', '\ndata: b\r', '\n\r\n']), expected);
  });

  it('joins multi-line data and ignores comments, id and retry', () => {
    assert.deepEqual(parse([': comment\nid: 7\nretry: 1000\ndata: first\ndata:second\ndata\n\n']), [{ event: 'message', data: 'first\nsecond\n' }]);
  });

  it('reads event names, defaulting to message, and skips events without data', () => {
    assert.deepEqual(parse(['event: error\ndata: {"error":{"code":"stream_timeout"}}\n\nevent: empty\n\ndata: x\n\n']), [
      { event: 'error', data: '{"error":{"code":"stream_timeout"}}' },
      { event: 'message', data: 'x' },
    ]);
  });

  it('dispatches a final unterminated event on end()', () => {
    assert.deepEqual(parse(['data: [DO', 'NE]']), [{ event: 'message', data: '[DONE]' }]);
  });

  it('throws on an unbounded line or event', () => {
    const parser = createSseParser(() => {});
    assert.throws(() => parser.push(`data: ${'x'.repeat(MAX_SSE_BUFFER_CHARS)}`), RangeError);
    const lines = createSseParser(() => {});
    const line = `data: ${'y'.repeat(1000)}\n`;
    assert.throws(() => {
      for (let i = 0; i < MAX_SSE_BUFFER_CHARS / 1000 + 1; i += 1) lines.push(line);
    }, RangeError);
  });
});

describe('createChatStreamAssembler', () => {
  it('accumulates content deltas, ignoring role-only and usage chunks', () => {
    const a = createChatStreamAssembler();
    assert.equal(a.push(chunk({ role: 'assistant' })), false);
    assert.equal(a.push(chunk({ content: 'Hel' })), true);
    assert.equal(a.push(chunk({ content: 'lo' })), true);
    assert.equal(a.push(JSON.stringify({ choices: [], usage: { total_tokens: 9 } })), false);
    assert.equal(a.text(), 'Hello');
    assert.equal(a.content, 'Hello');
    assert.equal(a.reasoning, '');
  });

  it('wraps reasoning_content and reasoning in <think>, which splitReasoning reads back', () => {
    const a = createChatStreamAssembler();
    a.push(chunk({ reasoning_content: 'Plan the ' }));
    a.push(chunk({ reasoning: 'answer.</think>' }));
    a.push(chunk({ content: 'Done.' }));
    assert.equal(a.text(), '<think>Plan the answer.</think>\n\nDone.');
    assert.deepEqual(splitReasoning(a.text()), { thoughts: 'Plan the answer.', answer: 'Done.' });
  });

  it('keeps reasoning tags split over two deltas out of the answer', () => {
    const a = createChatStreamAssembler();
    a.push(chunk({ reasoning_content: 'First idea.</th' }));
    a.push(chunk({ reasoning_content: 'ink> Second idea. <denkprozess>x</Denkprozess>' }));
    a.push(chunk({ content: 'The answer.' }));
    const split = splitReasoning(a.text());
    assert.equal(split.answer, 'The answer.');
    assert.equal(split.thoughts, 'First idea. Second idea. x');
    assert.equal(a.reasoning, 'First idea. Second idea. x');
  });

  it('records finish_reason and [DONE]', () => {
    const a = createChatStreamAssembler();
    a.push(chunk({ content: 'x' }, 'length'));
    assert.equal(a.finishReason, 'length');
    assert.equal(a.done, false);
    assert.equal(a.push(' [DONE] '), false);
    assert.equal(a.done, true);
  });

  it('ignores malformed JSON and non-object chunks', () => {
    const a = createChatStreamAssembler();
    for (const data of ['{', 'null', '[1]', '"text"', JSON.stringify({ choices: [null] }), JSON.stringify({ choices: [{ delta: 'x' }] })]) {
      assert.equal(a.push(data), false);
    }
    assert.equal(a.text(), '');
    assert.equal(a.error, null);
  });

  it('keeps only an error code, never server text', () => {
    const a = createChatStreamAssembler();
    a.push(JSON.stringify({ error: { code: 'upstream_interrupted', message: 'test-key-1 detail' } }));
    assert.equal(a.error, 'upstream_interrupted');
    const b = createChatStreamAssembler();
    b.push(JSON.stringify({ error: 'Key test-key-1 was rejected' }));
    assert.equal(b.error, 'stream_error');
    const c = createChatStreamAssembler();
    c.fail('rate_limited');
    assert.equal(c.error, 'rate_limited');
    c.fail({ code: 'x' });
    assert.equal(c.error, 'stream_error');
  });

  it('flags an answer that outgrows the limit', () => {
    const a = createChatStreamAssembler();
    a.push(chunk({ content: 'x'.repeat(MAX_STREAM_CHARS) }));
    assert.equal(a.overflow, false);
    a.push(chunk({ reasoning_content: 'y' }));
    assert.equal(a.overflow, true);
  });
});

describe('splitReasoning', () => {
  it('keeps its v2.0 behaviour', () => {
    assert.deepEqual(splitReasoning('<think> a </think> b'), { thoughts: 'a', answer: 'b' });
    assert.deepEqual(splitReasoning('<thought>x</thought><antwort>y</antwort>'), { thoughts: 'x', answer: 'y' });
    assert.deepEqual(splitReasoning('<DENKPROZESS>p</DENKPROZESS> <think>q</think> r'), { thoughts: 'p', answer: '<think>q</think> r' });
    assert.deepEqual(splitReasoning(' plain '), { thoughts: '', answer: 'plain' });
    assert.deepEqual(splitReasoning(/** @type {string} */ (/** @type {unknown} */ (null))), { thoughts: '', answer: '' });
  });
});

describe('splitStreamingText', () => {
  it('marks an unclosed leading <think> as thinking', () => {
    assert.deepEqual(splitStreamingText('<think>Let me see'), { answer: '', thinking: true });
    assert.deepEqual(splitStreamingText('  <Thought>'), { answer: '', thinking: true });
  });

  it('shows the answer once the reasoning is closed, and keeps thinking until it starts', () => {
    assert.deepEqual(splitStreamingText('<think>plan</think>\n\n'), { answer: '', thinking: true });
    assert.deepEqual(splitStreamingText('<think>plan</think>\n\nThe answer'), { answer: 'The answer', thinking: false });
    assert.deepEqual(splitStreamingText('<think>\n\n</think>Hi'), { answer: 'Hi', thinking: false });
  });

  it('passes plain text through', () => {
    assert.deepEqual(splitStreamingText('A <think> mid-answer'), { answer: 'A <think> mid-answer', thinking: false });
    assert.deepEqual(splitStreamingText(''), { answer: '', thinking: false });
  });
});
