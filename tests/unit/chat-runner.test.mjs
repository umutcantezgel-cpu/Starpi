// The chat's answer runner (src/js/chat/runner.js): the next model is asked only while nothing was
// answered, every call is an attempt and the wheel hears every outcome, a paused Anthropic answer is
// sent back with its content and merged into one answer with one content block, and Stop ends it.
import './setup.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { AiError } = await import('../../src/js/ai/errors.js');
const { mergeOpaque, mergeResults, runAnswer } = await import('../../src/js/chat/runner.js');

/** @typedef {import('../../src/js/ai/contract.js').AiEvent} AiEvent */

/**
 * A complete() that plays scripted event lists, one per call, and records the requests.
 * @param {Array<AiEvent[]>} scripts
 */
function scripted(scripts) {
  /** @type {any[]} */
  const requests = [];
  const complete = (/** @type {any} */ req) => {
    requests.push(req);
    const events = scripts[Math.min(requests.length, scripts.length) - 1];
    const { createResultBuilder } = /** @type {any} */ (globalThis).__builder;
    const builder = createResultBuilder({ provider: req.provider, model: req.model });
    for (const ev of events) builder.add(ev);
    return {
      events: (async function* () {
        yield* events;
      })(),
      result: Promise.resolve(builder.result()),
      abort() {},
    };
  };
  return { complete: /** @type {any} */ (complete), requests };
}
/** @type {any} */ (globalThis).__builder = await import('../../src/js/ai/index.js');

function wheel() {
  /** @type {string[]} */
  const log = [];
  return {
    log,
    acquire: (/** @type {string} */ p, /** @type {string} */ m) => (log.push(`acquire ${p}/${m}`), null),
    release: (/** @type {string} */ p, /** @type {string} */ m) => void log.push(`release ${p}/${m}`),
    succeeded: (/** @type {string} */ p, /** @type {string} */ m) => void log.push(`ok ${p}/${m}`),
    failed: (/** @type {string} */ p, /** @type {string} */ m, /** @type {string} */ code) => void log.push(`fail ${p}/${m} ${code}`),
  };
}

const A = /** @type {import('../../src/js/chat/runner.js').Target} */ ({ provider: 'anthropic', model: 'claude-opus-5-5', route: 'key' });
const B = /** @type {import('../../src/js/chat/runner.js').Target} */ ({ provider: 'nvidia', model: 'nvidia/x', route: 'pool' });
const build = (/** @type {any} */ t) => ({ provider: t.provider, model: t.model, messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] });
const start = (/** @type {string} */ provider, /** @type {string} */ model) => /** @type {AiEvent} */ ({ type: 'start', provider: /** @type {any} */ (provider), model });

describe('runAnswer', () => {
  it('asks the next model when the first fails before answering, and records both attempts', async () => {
    const { complete, requests } = scripted([
      [start('anthropic', 'claude-opus-5-5'), { type: 'end', stopReason: 'error', error: new AiError('rate_limited', { retryAfterMs: 3000 }) }],
      [start('nvidia', 'nvidia/x'), { type: 'text', delta: 'Hello' }, { type: 'end', stopReason: 'end_turn' }],
    ]);
    const w = wheel();
    /** @type {string[]} */
    const seen = [];
    const run = await runAnswer({ candidates: [A, B], build, signal: new AbortController().signal, complete, wheel: w, onEvent: (ev) => seen.push(ev.type), onStart: (t, served) => seen.push(`start:${t.provider}:${served}`) });
    assert.equal(run.result.text, 'Hello');
    assert.equal(run.target, B);
    assert.deepEqual(run.attempts.map((a) => [a.provider, a.outcome, a.code]), [['anthropic', 'rate_limited', 'rate_limited'], ['nvidia', 'ok', undefined]]);
    assert.deepEqual(w.log, ['acquire anthropic/claude-opus-5-5', 'fail anthropic/claude-opus-5-5 rate_limited', 'acquire nvidia/nvidia/x', 'ok nvidia/nvidia/x']);
    assert.equal(requests.length, 2);
    assert.ok(seen.includes('start:anthropic:claude-opus-5-5'), 'the start of a failed call is reported too');
  });

  it('keeps an answer that started, even when it fails later, and never switches models then', async () => {
    const { complete, requests } = scripted([[start('anthropic', 'claude-opus-5-5'), { type: 'text', delta: 'Part' }, { type: 'end', stopReason: 'error', error: new AiError('stream_cut') }]]);
    const run = await runAnswer({ candidates: [A, B], build, signal: new AbortController().signal, complete, wheel: wheel() });
    assert.equal(run.result.text, 'Part');
    assert.equal(run.result.error?.code, 'stream_cut');
    assert.equal(requests.length, 1);
    assert.equal(run.attempts.at(-1)?.outcome, 'error');
  });

  it('reports a refusal and a cut at the length limit as outcomes, and the served model when it differs', async () => {
    const { complete } = scripted([[start('anthropic', 'claude-sonnet-5-5'), { type: 'text', delta: 'x' }, { type: 'end', stopReason: 'max_tokens' }]]);
    const run = await runAnswer({ candidates: [A], build, signal: new AbortController().signal, complete, wheel: wheel() });
    assert.equal(run.attempts[0].outcome, 'truncated');
    assert.equal(run.attempts[0].served, 'claude-sonnet-5-5');
    assert.equal(run.result.stopReason, 'max_tokens');
  });

  it('sends a paused answer back with its content and merges the parts into one answer', async () => {
    const paused = { kind: 'anthropic-content', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: {} }] };
    const resumed = { kind: 'anthropic-content', model: 'claude-opus-5-5', content: [{ type: 'web_search_tool_result', tool_use_id: 'srv1', content: [] }, { type: 'text', text: 'Done.' }] };
    const { complete, requests } = scripted([
      [start('anthropic', 'claude-opus-5-5'), { type: 'reasoning', delta: 't' }, { type: 'opaque', block: paused }, { type: 'usage', input: 10, output: 5 }, { type: 'end', stopReason: 'pause' }],
      [start('anthropic', 'claude-opus-5-5'), { type: 'text', delta: 'Done.' }, { type: 'opaque', block: resumed }, { type: 'usage', input: 20, output: 3 }, { type: 'end', stopReason: 'end_turn' }],
    ]);
    const run = await runAnswer({ candidates: [A], build, signal: new AbortController().signal, complete, wheel: wheel() });
    assert.equal(run.continued, 1);
    assert.equal(requests.length, 2);
    const last = requests[1].messages.at(-1);
    assert.equal(last.role, 'assistant');
    assert.deepEqual(last.content.at(-1).block, paused);
    assert.equal(run.result.text, 'Done.');
    assert.equal(run.result.stopReason, 'end_turn');
    assert.equal(run.result.opaque.length, 1, 'one content block for the whole turn');
    assert.deepEqual(/** @type {any} */ (run.result.opaque[0].block).content.map((/** @type {any} */ b) => b.type), ['thinking', 'server_tool_use', 'web_search_tool_result', 'text']);
    assert.deepEqual(run.result.usage, { input: 30, output: 8, reasoning: 0, cacheRead: 0 });
  });

  it('stops after the configured number of continuations', async () => {
    const block = { kind: 'anthropic-content', model: 'm', content: [{ type: 'text', text: 'x' }] };
    const { complete, requests } = scripted([[start('anthropic', 'claude-opus-5-5'), { type: 'text', delta: 'x' }, { type: 'opaque', block }, { type: 'end', stopReason: 'pause' }]]);
    const run = await runAnswer({ candidates: [A], build, signal: new AbortController().signal, complete, wheel: wheel(), maxPauses: 2 });
    assert.equal(requests.length, 3);
    assert.equal(run.continued, 2);
    assert.equal(run.result.text, 'xxx');
  });

  it('returns an error result when no model is set up or every one failed', async () => {
    const empty = await runAnswer({ candidates: [], build, signal: new AbortController().signal, complete: scripted([]).complete, wheel: wheel() });
    assert.equal(empty.target, null);
    assert.equal(empty.result.error?.code, 'auth');
    const { complete } = scripted([[start('nvidia', 'nvidia/x'), { type: 'end', stopReason: 'error', error: new AiError('network') }]]);
    const failed = await runAnswer({ candidates: [B], build, signal: new AbortController().signal, complete, wheel: wheel() });
    assert.equal(failed.result.error?.code, 'network');
    assert.equal(failed.attempts[0].outcome, 'unavailable');
  });

  it('skips a model the wheel holds back while others are left, and tries the last one anyway', async () => {
    const { complete, requests } = scripted([[start('nvidia', 'nvidia/x'), { type: 'text', delta: 'ok' }, { type: 'end', stopReason: 'end_turn' }]]);
    const w = { ...wheel(), acquire: (/** @type {string} */ p) => (p === 'anthropic' ? /** @type {const} */ ('cooldown') : null) };
    const run = await runAnswer({ candidates: [A, B], build, signal: new AbortController().signal, complete, wheel: w });
    assert.deepEqual(run.attempts.map((a) => a.outcome), ['skipped', 'ok']);
    assert.equal(requests.length, 1);
  });
});

describe('merging', () => {
  it('joins the content of one Anthropic answer and keeps other provider state apart', () => {
    const a = { type: /** @type {const} */ ('opaque'), provider: /** @type {const} */ ('anthropic'), model: 'm', block: { kind: 'anthropic-content', content: [1] } };
    const b = { type: /** @type {const} */ ('opaque'), provider: /** @type {const} */ ('anthropic'), model: 'm2', block: { kind: 'anthropic-content', content: [2] } };
    const g = { type: /** @type {const} */ ('opaque'), provider: /** @type {const} */ ('gemini'), model: 'g', block: { kind: 'gemini-grounding', html: '<div>' } };
    const merged = mergeOpaque([a, g], [b]);
    assert.equal(merged.length, 2);
    assert.deepEqual(/** @type {any} */ (merged[0].block).content, [1, 2]);
    assert.equal(merged[0].model, 'm2');
    assert.deepEqual(merged[1], g);
  });

  it('shifts the citations of a continuation behind the text before it', () => {
    const base = { text: 'abc', reasoning: '', reasoningTokens: 0, toolCalls: [], citations: [], images: [], opaque: [], stopReason: /** @type {const} */ ('pause'), provider: /** @type {const} */ ('anthropic'), model: 'm', requestId: null, usage: null, error: null };
    const next = { ...base, text: 'de', stopReason: /** @type {const} */ ('end_turn'), citations: [{ url: 'https://example.com/', title: 'x', start: 0, end: 2 }] };
    const merged = mergeResults(base, next);
    assert.equal(merged.text, 'abcde');
    assert.deepEqual(merged.citations[0], { url: 'https://example.com/', title: 'x', start: 3, end: 5 });
    assert.equal(merged.stopReason, 'end_turn');
  });
});
