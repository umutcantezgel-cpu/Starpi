// The council: up to three members from different providers draft in parallel, the judge is the
// strongest other model (never a member, reasoning preferred), it chooses or merges with
// { chosen, reasons[], merged? }; with fewer than two valid drafts, or a judge that fails, the best
// draft stands. Every change reaches onUpdate as a snapshot. Scripted providers answer the calls.
import './setup.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findModel } from '../../src/js/ai/catalog/models.js';
import { liveCouncil, pickJudge, pickMembers, runCouncil, strengthScore } from '../../src/js/ai/council.js';
import { purposeMarker } from '../../src/js/ai/purposes.js';
import { fakeClock, scriptedProviders, systemText, testDeps } from './router-fakes.mjs';

/** @typedef {import('../../src/js/ai/roles.js').PoolEntry} PoolEntry */
/** @typedef {import('./router-fakes.mjs').Scripted} Scripted */

/** @param {any} provider @param {string} model @param {Array<import('../../src/js/ai/roles.js').ModelRole>} roles @returns {PoolEntry} */
const entry = (provider, model, roles) => ({ provider, model, roles, pinned: false });

const POOL = [
  entry('openai', 'gpt-5-mini', ['reasoning', 'fast']),
  entry('anthropic', 'claude-sonnet-5-5', ['reasoning']),
  entry('gemini', 'gemini-2.5-flash', ['reasoning', 'vision']),
  entry('openai', 'gpt-5', ['judge', 'reasoning']),
  entry('groq', 'llama-3.1-8b-instant', ['fast']),
];

const caps = (/** @type {any} */ provider, /** @type {string} */ model) => findModel(provider, model)?.caps ?? null;

const BRIEF_INPUT = { question: 'Which bridge is older?', notes: [{ id: 'n1', text: 'The old bridge was built in 1820.' }, { id: 'n2', text: 'The new bridge opened in 1990.' }] };
/** @param {string} summary */
const brief = (summary) => JSON.stringify({ summary, details: [], sources: ['n1'], open_questions: [] });

/**
 * A council world: `drafts` answers the members by model, `judge` answers council_judge calls.
 * @param {Record<string, Scripted | ((i: number) => Scripted)>} drafts
 * @param {Scripted | ((i: number) => Scripted)} judge
 */
function world(drafts, judge) {
  const clock = fakeClock();
  const providers = scriptedProviders((call, i) => {
    const answer = systemText(call.req).includes(purposeMarker('council_judge')) ? judge : (drafts[call.model] ?? { error: 'server' });
    return typeof answer === 'function' ? answer(i) : answer;
  }, clock);
  const deps = testDeps(providers, clock, { caps });
  return { clock, providers, deps };
}

describe('choosing members and the judge', () => {
  it('takes members from different providers and keeps the judge out', () => {
    const members = pickMembers(POOL, { role: 'reasoning', caps });
    assert.deepEqual(
      members.map((m) => `${m.provider}:${m.model}`),
      ['openai:gpt-5-mini', 'anthropic:claude-sonnet-5-5', 'gemini:gemini-2.5-flash'],
    );
    const judge = pickJudge(POOL, members, { caps });
    assert.equal(judge?.model, 'gpt-5', 'the strongest other model, with judge and reasoning roles');
    assert.ok(!members.some((m) => m.model === judge?.model), 'the judge is never a member');
  });

  it('fills up from the same provider only when the others are used', () => {
    const pool = [entry('openai', 'a', ['reasoning']), entry('openai', 'b', ['reasoning']), entry('anthropic', 'c', ['reasoning']), entry('openai', 'd', ['reasoning'])];
    assert.deepEqual(pickMembers(pool, { count: 3 }).map((m) => m.model), ['b', 'c', 'd'], 'the judge pick (a) stays out; b and c first, one per provider');
    assert.equal(pickMembers(pool, { count: 9 }).length, 3, 'never more than three');
    const three = pool.slice(0, 3);
    assert.deepEqual(pickMembers(three, { count: 3 }).map((m) => m.model), ['b', 'c'], 'two members and a judge rather than three members and none');
    assert.deepEqual(pickMembers(three.slice(0, 1), { count: 3 }).map((m) => m.model), ['a'], 'too few models: the judge pick drafts too');
  });

  it('prefers reasoning models as judge and never takes a vision-only or on-device model first', () => {
    const pool = [entry('groq', 'llama-3.1-8b-instant', ['fast']), entry('gemini', 'eyes', ['vision']), entry('webgpu', 'webgpu:qwen-3b', ['reasoning', 'judge']), entry('deepseek', 'deepseek-reasoner', ['reasoning'])];
    assert.equal(pickJudge(pool, [], { caps })?.model, 'deepseek-reasoner');
    assert.equal(pickJudge(pool, [{ provider: 'deepseek', model: 'deepseek-reasoner' }], { caps })?.model, 'llama-3.1-8b-instant', 'any cloud model ranks above an on-device one');
    assert.equal(pickJudge(pool.slice(1, 3), [], { caps })?.model, 'webgpu:qwen-3b', 'the device judges when nothing else can');
    assert.equal(pickJudge([entry('gemini', 'eyes', ['vision'])], []), null);
    assert.ok(strengthScore(entry('openai', 'gpt-5', ['judge']), caps) > strengthScore(entry('openai', 'gpt-5-nano', ['fast']), caps));
  });

  it('skips models the wheel holds back', () => {
    const usable = (/** @type {PoolEntry} */ e) => e.provider !== 'anthropic';
    assert.ok(!pickMembers(POOL, { usable }).some((m) => m.provider === 'anthropic'));
  });
});

describe('runCouncil with a purpose', () => {
  it('lets the judge choose among valid drafts and reports every step', async () => {
    const { deps, providers } = world(
      { 'gpt-5-mini': { text: brief('The old bridge, built in 1820.') }, 'claude-sonnet-5-5': { text: brief('The old bridge is older.') }, 'gemini-2.5-flash': { text: brief('1820 beats 1990.') } },
      { text: '{"chosen": 1, "reasons": ["Clear and sourced."]}' },
    );
    /** @type {Array<[string, string[]]>} */
    const updates = [];
    const res = await runCouncil({ purpose: 'research_brief', input: BRIEF_INPUT, pool: POOL, deps, onUpdate: (r, phase) => updates.push([phase, r.members.map((m) => m.status)]) });
    assert.equal(res.decidedBy, 'judge');
    assert.equal(res.validCount, 3);
    assert.equal(res.judge?.model, 'gpt-5');
    assert.equal(res.judge?.chosen, 1);
    assert.deepEqual(res.judge?.reasons, ['Clear and sourced.']);
    assert.equal(res.bestIndex, 1);
    assert.deepEqual(/** @type {any} */ (res.output?.value).summary, 'The old bridge is older.');
    assert.equal(providers.calls.length, 4, 'three drafts, one verdict');
    const judgeCall = providers.calls.find((c) => c.model === 'gpt-5');
    assert.match(String(judgeCall?.req.messages.at(-1)?.content.map((p) => (p.type === 'text' ? p.text : '')).join('')), /Draft 2/);
    assert.equal(updates[0][0], 'members');
    assert.deepEqual(updates[0][1], ['pending', 'pending', 'pending']);
    assert.deepEqual(updates.map((u) => u[0]).slice(-2), ['judge', 'done']);
    assert.equal(updates.filter((u) => u[0] === 'members').length, 4, 'one snapshot before and one per finished draft');
    assert.equal(typeof res.finishedAt, 'number');
  });

  it('takes a merged answer only when it passes the purpose validation', async () => {
    const drafts = { 'gpt-5-mini': { text: brief('Old one.') }, 'claude-sonnet-5-5': { text: brief('The 1820 bridge.') }, 'gemini-2.5-flash': { error: /** @type {const} */ ('server') } };
    const merged = await runCouncil({ purpose: 'research_brief', input: BRIEF_INPUT, pool: POOL, deps: world(drafts, { text: JSON.stringify({ chosen: 0, reasons: ['Both agree.'], merged: brief('The old bridge from 1820 is older.') }) }).deps });
    assert.equal(merged.decidedBy, 'merged');
    assert.equal(merged.judge?.merged, true);
    assert.equal(/** @type {any} */ (merged.output?.value).summary, 'The old bridge from 1820 is older.');
    assert.equal(merged.members[2].status, 'error');
    assert.deepEqual(merged.members[2].errors, ['server']);

    const badMerge = await runCouncil({ purpose: 'research_brief', input: BRIEF_INPUT, pool: POOL, deps: world(drafts, { text: JSON.stringify({ chosen: 1, reasons: ['ok'], merged: 'not json' }) }).deps });
    assert.equal(badMerge.decidedBy, 'judge', 'an unusable merge falls back to the chosen draft');
    assert.equal(/** @type {any} */ (badMerge.output?.value).summary, 'The 1820 bridge.');
  });

  it('lets the best draft stand without a judge when fewer than two drafts are valid', async () => {
    const { deps, providers } = world({ 'gpt-5-mini': { text: brief('Old one.') }, 'claude-sonnet-5-5': { text: 'no json' }, 'gemini-2.5-flash': { error: 'timeout' } }, { text: '{"chosen":0,"reasons":["x"]}' });
    const res = await runCouncil({ purpose: 'research_brief', input: BRIEF_INPUT, pool: POOL, deps });
    assert.equal(res.decidedBy, 'best');
    assert.equal(res.fallbackReason, 'one_valid_draft');
    assert.equal(res.judge, null);
    assert.equal(res.bestIndex, 0);
    assert.deepEqual(res.members.map((m) => m.status), ['ok', 'invalid', 'timeout']);
    assert.ok(!providers.calls.some((c) => c.model === 'gpt-5'), 'no judge is asked');
    assert.deepEqual(res.members[1].errors, ['no_json']);
  });

  it('lets the best draft stand when the judge fails or gives no usable verdict', async () => {
    const drafts = { 'gpt-5-mini': { text: brief('Mini.') }, 'claude-sonnet-5-5': { text: brief('Sonnet.') }, 'gemini-2.5-flash': { text: brief('Flash.') } };
    const failed = await runCouncil({ purpose: 'research_brief', input: BRIEF_INPUT, pool: POOL, deps: world(drafts, { error: 'server' }).deps });
    assert.equal(failed.decidedBy, 'best');
    assert.equal(failed.fallbackReason, 'judge_error');
    assert.equal(failed.judge?.status, 'error');
    assert.ok(failed.output, 'the best draft is the output');

    const invalid = await runCouncil({ purpose: 'research_brief', input: BRIEF_INPUT, pool: POOL, deps: world(drafts, { text: '{"chosen": 7, "reasons": []}' }).deps });
    assert.equal(invalid.fallbackReason, 'judge_invalid');
    assert.equal(invalid.judge?.status, 'invalid');

    const lonely = await runCouncil({ purpose: 'research_brief', input: BRIEF_INPUT, members: 2, pool: POOL.slice(0, 2), deps: world(drafts, { text: '{}' }).deps });
    assert.equal(lonely.fallbackReason, 'no_judge', 'no model outside the members is left');
    assert.equal(lonely.decidedBy, 'best');
  });

  it('ends with no_models or no_valid_draft and never rejects for failed calls', async () => {
    const empty = await runCouncil({ purpose: 'research_brief', input: BRIEF_INPUT, pool: [], deps: world({}, {}).deps });
    assert.equal(empty.fallbackReason, 'no_models');
    assert.equal(empty.output, null);
    const none = await runCouncil({ purpose: 'research_brief', input: BRIEF_INPUT, pool: POOL, deps: world({}, {}).deps });
    assert.equal(none.fallbackReason, 'no_valid_draft');
    assert.equal(none.decidedBy, 'none');
    await assert.rejects(runCouncil({ purpose: 'nope', deps: world({}, {}).deps }), TypeError);
  });

  it('pins every member: a failing member does not fall back to another model', async () => {
    const { deps, providers } = world({ 'claude-sonnet-5-5': { text: brief('Sonnet.') }, 'gemini-2.5-flash': { text: brief('Flash.') } }, { text: '{"chosen":0,"reasons":["x"]}' });
    await runCouncil({ purpose: 'research_brief', input: BRIEF_INPUT, pool: POOL, deps });
    assert.equal(providers.calls.filter((c) => c.provider === 'openai' && c.model !== 'gpt-5').length, 1, 'gpt-5-mini is called once and not replaced');
  });
});

describe('runCouncil in free chat', () => {
  it('drafts the conversation with each member and lets the judge choose', async () => {
    const { deps, providers } = world({ 'gpt-5-mini': { text: 'Light becomes sugar.' }, 'claude-sonnet-5-5': { text: 'Plants make food from light.' }, 'gemini-2.5-flash': { text: '' } }, { text: '{"chosen":1,"reasons":["More precise."]}' });
    const messages = [{ role: /** @type {const} */ ('user'), content: [{ type: /** @type {const} */ ('text'), text: 'What is photosynthesis?' }] }];
    const res = await runCouncil({ messages, system: 'Answer in one sentence.', pool: POOL, deps, thinking: false });
    assert.equal(res.mode, 'free');
    assert.deepEqual(res.members.map((m) => m.status), ['ok', 'ok', 'invalid']);
    assert.deepEqual(res.members[2].errors, ['empty']);
    assert.equal(res.output?.text, 'Plants make food from light.');
    const draftCall = providers.calls.find((c) => c.model === 'gpt-5-mini');
    assert.equal(draftCall?.req.system, 'Answer in one sentence.');
    const judgeCall = providers.calls.find((c) => c.model === 'gpt-5');
    assert.match(systemText(/** @type {any} */ (judgeCall).req), /compare several drafts/);
  });

  it('marks thinking members and passes the thinking request on', async () => {
    const { deps, providers } = world({ 'gpt-5-mini': { text: 'A.' }, 'claude-sonnet-5-5': { text: 'B.' }, 'gemini-2.5-flash': { text: 'C.' } }, { text: '{"chosen":0,"reasons":["x"]}' });
    const messages = [{ role: /** @type {const} */ ('user'), content: [{ type: /** @type {const} */ ('text'), text: 'Hi' }] }];
    const res = await runCouncil({ messages, pool: POOL, deps, thinking: true });
    assert.equal(res.thinking, true);
    assert.ok(res.members.every((m) => m.thinking === true));
    assert.equal(providers.calls.find((c) => c.model === 'claude-sonnet-5-5')?.req.thinking?.mode, 'on');
  });
});

describe('following a council', () => {
  it('replays the latest snapshot to a late subscriber and stops on abort', async () => {
    const { deps } = world({ 'gpt-5-mini': { text: 'A.' }, 'claude-sonnet-5-5': { text: 'B.' }, 'gemini-2.5-flash': { text: 'C.' } }, { text: '{"chosen":2,"reasons":["x"]}' });
    const messages = [{ role: /** @type {const} */ ('user'), content: [{ type: /** @type {const} */ ('text'), text: 'Hi' }] }];
    const run = liveCouncil({ messages, pool: POOL, deps });
    const result = await run;
    /** @type {string[]} */
    const late = [];
    run.subscribe((r, phase) => late.push(`${phase}:${r.decidedBy}`));
    assert.deepEqual(late, ['done:judge']);
    assert.equal(result.output?.text, 'C.');

    const controller = new AbortController();
    const aborting = world({ 'gpt-5-mini': () => (controller.abort(), { text: 'A.' }) }, {});
    await assert.rejects(runCouncil({ messages, pool: POOL, deps: aborting.deps, signal: controller.signal }), { name: 'AbortError' });
  });
});
