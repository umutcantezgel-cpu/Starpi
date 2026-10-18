// The built-in tools: the calculator's own parser (never eval), date and time, the workspace,
// memory and web search tools with their dependencies, and the tool switches.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { builtinTools, CalcError, DEFAULT_TOOL_SWITCHES, evaluateExpression, formatResult, readToolSwitches } from '../../src/js/ai/tools/builtin.js';
import { validateArgs } from '../../src/js/ai/tools/registry.js';

const ctx = { signal: new AbortController().signal, locale: 'en' };

/**
 * @param {import('../../src/js/ai/tools/builtin.js').BuiltinDeps} deps
 * @param {string} name
 */
const toolOf = (deps, name) => {
  const def = builtinTools(deps).find((d) => d.name === name);
  assert.ok(def, name);
  return def;
};

describe('calculator', () => {
  it('follows precedence, signs and right-associative powers', () => {
    assert.equal(evaluateExpression('1 + 2 * 3'), 7);
    assert.equal(evaluateExpression('(1 + 2) * 3'), 9);
    assert.equal(evaluateExpression('2 ^ 3 ^ 2'), 512);
    assert.equal(evaluateExpression('2 ** 10'), 1024);
    assert.equal(evaluateExpression('-2 ^ 2'), -4);
    assert.equal(evaluateExpression('2 ^ -1'), 0.5);
    assert.equal(evaluateExpression('--3'), 3);
    assert.equal(evaluateExpression('17 % 5'), 2);
    assert.equal(evaluateExpression('1.5e3 / 3'), 500);
    assert.equal(evaluateExpression('6 × 7 ÷ 2'), 21);
  });

  it('knows its functions and constants', () => {
    assert.equal(evaluateExpression('sqrt(16) + abs(-2)'), 6);
    assert.equal(evaluateExpression('round(2.71828, 2)'), 2.72);
    assert.equal(evaluateExpression('max(1, 9, 4) - min(3, 2)'), 7);
    assert.equal(evaluateExpression('log(1000) + ln(e) + log2(8)'), 7);
    assert.ok(Math.abs(evaluateExpression('sin(pi / 2)') - 1) < 1e-12);
    assert.equal(evaluateExpression('PI') > 3.14, true);
    assert.equal(formatResult(evaluateExpression('0.1 + 0.2')), 0.3);
  });

  it('refuses what is not arithmetic, without running anything', () => {
    /** @param {string} text @param {string} code */
    const fails = (text, code) => assert.throws(() => evaluateExpression(text), (/** @type {any} */ err) => err instanceof CalcError && err.code === code, text);
    fails('', 'syntax');
    fails('1 +', 'syntax');
    fails('(1 + 2', 'syntax');
    fails('1; 2', 'syntax');
    fails('constructor', 'unknown_name');
    fails('process.exit(1)', 'syntax');
    fails('alert(1)', 'unknown_name');
    fails('this', 'unknown_name');
    fails('sqrt()', 'arguments');
    fails('pow(2)', 'arguments');
    fails('1 / 0', 'not_finite');
    fails('sqrt(-1)', 'not_finite');
    fails('1+'.repeat(300) + '1', 'too_long');
    fails('('.repeat(100) + '1' + ')'.repeat(100), 'too_long');
    fails('"a"', 'syntax');
  });

  it('answers as a tool with the result or the error code', async () => {
    const calc = toolOf({}, 'calculator');
    assert.deepEqual(JSON.parse((await calc.run({ expression: '(17.5 * 3) / 2' }, ctx)).content), { expression: '(17.5 * 3) / 2', result: 26.25 });
    const bad = await calc.run({ expression: 'nope(1)' }, ctx);
    assert.equal(bad.isError, true);
    assert.match(JSON.parse(bad.content).error, /unknown_name/);
    assert.deepEqual(validateArgs(calc.schema, {}), ['arguments.expression: required']);
  });
});

describe('date and time', () => {
  const now = () => new Date('2026-03-01T12:34:56Z');
  it('reports UTC, the local time and weekday of a zone', async () => {
    const dt = toolOf({ now, timeZone: () => 'Europe/Berlin' }, 'datetime');
    const own = JSON.parse((await dt.run({}, ctx)).content);
    assert.deepEqual(own, { utc: '2026-03-01T12:34:56.000Z', local: '2026-03-01 13:34:56', weekday: 'Sunday', timeZone: 'Europe/Berlin', unix: 1772368496 });
    const tokyo = JSON.parse((await dt.run({ timeZone: 'Asia/Tokyo' }, ctx)).content);
    assert.equal(tokyo.local, '2026-03-01 21:34:56');
    const bad = await dt.run({ timeZone: 'Mars/Olympus' }, ctx);
    assert.equal(bad.isError, true);
  });
});

describe('workspace, memory and web search', () => {
  it('searches the files on this device when there are some', async () => {
    const none = await toolOf({}, 'workspace_search').run({ query: 'plan' }, ctx);
    assert.match(none.content, /No files/);
    /** @type {Array<[string, number]>} */
    const asked = [];
    const ws = toolOf({ searchWorkspace: async (q, k) => (asked.push([q, k]), [{ docName: 'notes.md', chunkIndex: 1, text: 'The plan is ready.' }]) }, 'workspace_search');
    const out = JSON.parse((await ws.run({ query: 'plan', limit: 3 }, ctx)).content);
    assert.deepEqual(out.results, [{ file: 'notes.md', part: 2, text: 'The plan is ready.' }]);
    assert.deepEqual(asked, [['plan', 3]]);
  });

  it('reports memory as off until a lookup is set', async () => {
    assert.match((await toolOf({}, 'memory_lookup').run({ query: 'x' }, ctx)).content, /Memory is off/);
    const mem = toolOf({ memoryLookup: async () => [{ text: 'Prefers metric units.', updatedAt: '2026-01-01' }] }, 'memory_lookup');
    const out = JSON.parse((await mem.run({ query: 'units' }, ctx)).content);
    assert.deepEqual(out.facts, [{ text: 'Prefers metric units.', updated: '2026-01-01' }]);
    assert.match(out.note, /may be outdated/);
  });

  it('offers web search only with a search behind it, and returns the pages as sources', async () => {
    assert.equal(builtinTools({}).some((d) => d.name === 'web_search'), false);
    const web = toolOf({ webSearch: async (q, n) => [{ title: `About ${q}`, url: 'https://example.com/a', snippet: `${n} results` }] }, 'web_search');
    const out = await web.run({ query: 'tides', count: 2 }, ctx);
    assert.deepEqual(JSON.parse(out.content).results, [{ n: 1, title: 'About tides', url: 'https://example.com/a', snippet: '2 results' }]);
    assert.deepEqual(out.sources, [{ url: 'https://example.com/a', title: 'About tides', snippet: '2 results' }]);
    assert.ok(builtinTools({ webSearch: async () => [] }).every((d) => d.effect === 'read'));
  });

  it('keeps the switches over the defaults', () => {
    assert.deepEqual(readToolSwitches(null), DEFAULT_TOOL_SWITCHES);
    assert.deepEqual(readToolSwitches({ workspace_search: true, calculator: 'yes', other: true }), { ...DEFAULT_TOOL_SWITCHES, workspace_search: true });
    assert.equal(DEFAULT_TOOL_SWITCHES.workspace_search, false);
    assert.equal(DEFAULT_TOOL_SWITCHES.generate_image, false);
  });
});
