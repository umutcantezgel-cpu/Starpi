import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trimTrailingSlashes } from '../src/lib/text.js';

test('trimTrailingSlashes drops only the slashes at the end, also a long run, in linear time', () => {
  assert.equal(trimTrailingSlashes('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434/v1');
  assert.equal(trimTrailingSlashes('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
  assert.equal(trimTrailingSlashes('///'), '');
  assert.equal(trimTrailingSlashes(''), '');
  const long = `x${'/'.repeat(200_000)}`;
  const started = performance.now();
  assert.equal(trimTrailingSlashes(long), 'x');
  assert.ok(performance.now() - started < 1000);
});
