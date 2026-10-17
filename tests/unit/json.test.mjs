// JSON in model answers: found behind reasoning tags, inside code fences and in prose; checked
// against the schema subset of the purposes with stable error codes; turned into a retry hint.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decoderSchema, describeError, errorsFor, extractJson, MAX_ERRORS, readJsonAnswer, retryHint, stripReasoning, validateSchema } from '../../src/js/ai/json.js';

describe('stripReasoning', () => {
  it('removes paired blocks of every known tag, a lone closing tag and an unclosed opening tag', () => {
    assert.equal(stripReasoning('<think>step one</think>Answer'), 'Answer');
    assert.equal(stripReasoning('<thinking a="1">x</thinking> <reasoning>y</reasoning>Answer'), 'Answer');
    assert.equal(stripReasoning('chat template opened it\n</think>\nAnswer'), 'Answer');
    assert.equal(stripReasoning('Answer <thought>still going'), 'Answer');
    assert.equal(stripReasoning('No tags at all.'), 'No tags at all.');
  });
});

describe('extractJson', () => {
  it('reads plain JSON, objects and arrays', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson(' [1, 2] '), [1, 2]);
  });

  it('finds JSON behind reasoning, in fences and in prose', () => {
    assert.deepEqual(extractJson('<think>maybe {"a": 0}?</think>{"a": 1}'), { a: 1 });
    assert.deepEqual(extractJson('Here you go:\n```json\n{"a": 2}\n```\nAnything else?'), { a: 2 });
    assert.deepEqual(extractJson('```\nnote: {"a": 3} done\n```'), { a: 3 });
    assert.deepEqual(extractJson('The result is {"a": {"b": [4]}} as requested.'), { a: { b: [4] } });
    assert.deepEqual(extractJson('Answer: {"text": "a } inside { a string", "n": 5}'), { text: 'a } inside { a string', n: 5 });
  });

  it('skips broken structures and keeps looking', () => {
    assert.deepEqual(extractJson('{not json} then {"ok": true}'), { ok: true });
    assert.deepEqual(extractJson('[1, 2} and {"x": [1]}'), { x: [1] });
  });

  it('returns null when there is no object or array', () => {
    for (const text of ['', 'just words', '42', '"a string"', 'null', '<think>{"a":1}</think>', '{"open": ']) assert.equal(extractJson(text), null, text);
    assert.equal(extractJson(/** @type {any} */ (undefined)), null);
  });
});

describe('validateSchema', () => {
  /** @type {import('../../src/js/ai/json.js').JsonSchema} */
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 5 },
      score: { type: 'number', minimum: 0, maximum: 1 },
      count: { type: 'integer' },
      kind: { type: 'string', enum: ['a', 'b'] },
      tags: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string' } },
    },
    required: ['title', 'kind'],
    additionalProperties: false,
  };

  it('accepts a fitting value; an integer counts as a number', () => {
    assert.deepEqual(validateSchema({ title: 'ok', score: 1, count: 3, kind: 'a', tags: ['x'] }, schema), []);
  });

  it('names every problem with its path and rule', () => {
    const errors = validateSchema({ title: '   ', score: 1.5, count: 2.5, kind: 'c', tags: ['x', 'x', 'y'], extra: 1 }, schema);
    assert.deepEqual(errors, [
      'schema:$.title:minLength',
      'schema:$.score:maximum',
      'schema:$.count:type',
      'schema:$.kind:enum',
      'schema:$.tags:maxItems',
      'schema:$.tags:uniqueItems',
      'schema:$:additional:extra',
    ]);
    assert.deepEqual(validateSchema({}, schema), ['schema:$:required:title', 'schema:$:required:kind']);
    assert.deepEqual(validateSchema([], schema), ['schema:$:type'], 'a wrong type is not looked into');
    assert.deepEqual(validateSchema({ title: 'x', kind: 'a', tags: [1] }, schema), ['schema:$.tags[0]:type']);
  });

  it('reports at most MAX_ERRORS problems', () => {
    const many = { type: /** @type {const} */ ('array'), items: { type: /** @type {const} */ ('string') } };
    assert.equal(validateSchema(Array.from({ length: 50 }, (_, i) => i), many).length, MAX_ERRORS);
  });

  it('rejects numbers that are not finite', () => {
    assert.deepEqual(validateSchema(Number.POSITIVE_INFINITY, { type: 'number' }), ['schema:$:finite']);
  });
});

describe('decoderSchema', () => {
  it('drops string lengths, uniqueness and descriptions at every depth and keeps the rest', () => {
    const out = decoderSchema({ type: 'object', description: 'd', properties: { a: { type: 'array', uniqueItems: true, minItems: 1, items: { type: 'string', maxLength: 3, enum: ['x'] } } }, required: ['a'] });
    assert.deepEqual(out, { type: 'object', properties: { a: { type: 'array', minItems: 1, items: { type: 'string', enum: ['x'] } } }, required: ['a'] });
  });
});

describe('errorsFor, readJsonAnswer and retryHint', () => {
  /** @type {import('../../src/js/ai/json.js').JsonSchema} */
  const schema = { type: 'object', properties: { queries: { type: 'array', items: { type: 'string' } } }, required: ['queries'] };

  it('names no_json, schema problems, or nothing', () => {
    assert.deepEqual(errorsFor('no json', schema), ['no_json']);
    assert.deepEqual(errorsFor('{"q": 1}', schema), ['schema:$:required:queries']);
    assert.deepEqual(errorsFor('```json\n{"queries": ["a"]}\n```', schema), []);
    assert.deepEqual(readJsonAnswer({ queries: [] }, schema), { ok: true, value: { queries: [] }, errors: [] });
  });

  it('builds a hint in English and German that lists each problem once', () => {
    const en = retryHint(['schema:$:required:queries', 'schema:$.queries[0]:type', 'schema:$:required:queries'], 'en');
    assert.match(en, /^Your last answer could not be used:/);
    assert.match(en, /The field "queries" is missing\./);
    assert.match(en, /The field "\$\.queries\[0\]" has the wrong type\./);
    assert.equal(en.match(/is missing/g)?.length, 1);
    assert.match(en, /one JSON object/);
    const de = retryHint(['no_json'], 'de', { json: true });
    assert.match(de, /Die Antwort enthielt kein JSON-Objekt\./);
    assert.match(retryHint(['empty'], 'en', { json: false }), /Answer again in full/);
    assert.equal(describeError('truncated', 'de'), 'Die Antwort brach vor dem Ende ab.');
    assert.equal(describeError('schema:$.a:additional:b', 'en'), 'The field "$.a.b" is not allowed.');
  });
});
