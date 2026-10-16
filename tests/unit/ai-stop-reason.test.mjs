// Stop-reason tables: every dialect maps onto the contract's stop reasons, unknown values fail
// closed to `error`, and the corrections for tool calls and blocked prompts apply.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STOP_REASONS } from '../../src/js/ai/contract.js';
import {
  ANTHROPIC_STOP_REASONS,
  fromAnthropic,
  fromGemini,
  fromLocal,
  fromOpenAiChat,
  fromOpenAiResponses,
  GEMINI_BLOCK_REASONS,
  GEMINI_FINISH_REASONS,
  LOCAL_STOP_REASONS,
  mapStopReason,
  OPENAI_CHAT_FINISH_REASONS,
  OPENAI_RESPONSES_INCOMPLETE_REASONS,
  OPENAI_RESPONSES_STATUS,
  STOP_NOTE_KEYS,
  stopReasonForError,
} from '../../src/js/ai/stop-reason.js';

describe('stop-reason tables', () => {
  it('only produce contract stop reasons', () => {
    for (const table of [ANTHROPIC_STOP_REASONS, OPENAI_CHAT_FINISH_REASONS, OPENAI_RESPONSES_STATUS, OPENAI_RESPONSES_INCOMPLETE_REASONS, GEMINI_FINISH_REASONS, GEMINI_BLOCK_REASONS, LOCAL_STOP_REASONS]) {
      for (const value of Object.values(table)) assert.ok(STOP_REASONS.includes(value), value);
    }
  });

  it('map Anthropic stop reasons, pause_turn to pause and refusal to refusal', () => {
    assert.equal(fromAnthropic('end_turn'), 'end_turn');
    assert.equal(fromAnthropic('stop_sequence'), 'end_turn');
    assert.equal(fromAnthropic('max_tokens'), 'max_tokens');
    assert.equal(fromAnthropic('model_context_window_exceeded'), 'max_tokens');
    assert.equal(fromAnthropic('tool_use'), 'tool_call');
    assert.equal(fromAnthropic('pause_turn'), 'pause');
    assert.equal(fromAnthropic('refusal'), 'refusal');
    assert.equal(fromAnthropic(null), 'error');
  });

  it('map Chat Completions finish reasons, with a missing one as a normal end', () => {
    assert.equal(fromOpenAiChat('stop'), 'end_turn');
    assert.equal(fromOpenAiChat('length'), 'max_tokens');
    assert.equal(fromOpenAiChat('model_length'), 'max_tokens');
    assert.equal(fromOpenAiChat('tool_calls'), 'tool_call');
    assert.equal(fromOpenAiChat('function_call'), 'tool_call');
    assert.equal(fromOpenAiChat('content_filter'), 'refusal');
    assert.equal(fromOpenAiChat(null), 'end_turn');
    assert.equal(fromOpenAiChat(undefined), 'end_turn');
    assert.equal(fromOpenAiChat('stop', { hasToolCalls: true }), 'tool_call');
    assert.equal(fromOpenAiChat('length', { hasToolCalls: true }), 'max_tokens');
  });

  it('map Responses API outcomes', () => {
    assert.equal(fromOpenAiResponses('completed'), 'end_turn');
    assert.equal(fromOpenAiResponses('completed', undefined, { hasToolCalls: true }), 'tool_call');
    assert.equal(fromOpenAiResponses('completed', undefined, { refused: true }), 'refusal');
    assert.equal(fromOpenAiResponses('incomplete', 'max_output_tokens'), 'max_tokens');
    assert.equal(fromOpenAiResponses('incomplete', 'content_filter'), 'refusal');
    assert.equal(fromOpenAiResponses('incomplete', 'something_new'), 'max_tokens');
    assert.equal(fromOpenAiResponses('failed'), 'error');
    assert.equal(fromOpenAiResponses('cancelled'), 'cancelled');
    assert.equal(fromOpenAiResponses('in_progress'), 'error');
  });

  it('map Gemini finish and block reasons', () => {
    assert.equal(fromGemini('STOP'), 'end_turn');
    assert.equal(fromGemini('STOP', { hasToolCalls: true }), 'tool_call');
    assert.equal(fromGemini('MAX_TOKENS'), 'max_tokens');
    for (const r of ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']) assert.equal(fromGemini(r), 'refusal', r);
    for (const r of ['MALFORMED_FUNCTION_CALL', 'OTHER', 'FINISH_REASON_UNSPECIFIED']) assert.equal(fromGemini(r), 'error', r);
    assert.equal(fromGemini(undefined, { blockReason: 'SAFETY' }), 'refusal');
    assert.equal(fromGemini('STOP', { blockReason: 'A_NEW_REASON' }), 'refusal');
    assert.equal(fromGemini('stop'), 'error', 'case matters');
  });

  it('map local server reasons, case-insensitively', () => {
    assert.equal(fromLocal('eos'), 'end_turn');
    assert.equal(fromLocal('LIMIT'), 'max_tokens');
    assert.equal(fromLocal('abort'), 'cancelled');
    assert.equal(fromLocal('timeout'), 'timeout');
    assert.equal(fromLocal(null), 'end_turn');
    assert.equal(fromLocal('stop', { hasToolCalls: true }), 'tool_call');
  });

  it('fail closed on unknown values and prototype keys', () => {
    for (const fn of [fromAnthropic, fromOpenAiChat, fromGemini, fromLocal]) {
      assert.equal(fn('surprise'), 'error');
      assert.equal(fn('constructor'), 'error');
      assert.equal(fn('__proto__'), 'error');
    }
    assert.equal(fromOpenAiResponses('toString'), 'error');
  });

  it('dispatch by dialect', () => {
    assert.equal(mapStopReason('anthropic', 'pause_turn'), 'pause');
    assert.equal(mapStopReason('openai-chat', 'tool_calls'), 'tool_call');
    assert.equal(mapStopReason('openai-responses', 'incomplete', { incompleteReason: 'max_output_tokens' }), 'max_tokens');
    assert.equal(mapStopReason('gemini', 'SAFETY'), 'refusal');
    assert.equal(mapStopReason('local', 'limit'), 'max_tokens');
    assert.equal(mapStopReason(/** @type {any} */ ('unknown'), 'stop'), 'error');
  });

  it('derive the stop reason of a failed call', () => {
    assert.equal(stopReasonForError('aborted'), 'cancelled');
    assert.equal(stopReasonForError('timeout'), 'timeout');
    assert.equal(stopReasonForError('refusal'), 'refusal');
    assert.equal(stopReasonForError('rate_limited'), 'error');
  });

  it('name an i18n note for every stop reason but the normal ones', () => {
    assert.deepEqual(Object.keys(STOP_NOTE_KEYS).sort(), STOP_REASONS.filter((r) => r !== 'end_turn' && r !== 'tool_call').sort());
    for (const [reason, key] of Object.entries(STOP_NOTE_KEYS)) assert.equal(key, `ai.stop.${reason}`);
  });
});
