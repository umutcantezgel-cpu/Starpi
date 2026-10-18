// The companion signs canonical JSON that the browser must be able to rebuild with the library it
// already has (@starpi/core). These cases pin the two implementations to the same bytes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '../src/lib/canonical.js';
import { canonicalJson as coreCanonical } from '../../core/src/index.js';

test('canonical JSON matches @starpi/core byte for byte', () => {
  const cases = [
    { b: 2, a: 1, nested: { z: [3, { y: true, x: null }], w: 'ü' } },
    { v: 1, kind: 'starpi.companion.audit-head', key: 'ab'.repeat(32), seq: 42, hash: 'cd'.repeat(32) },
    ['x', 1, -0.5, { k: 'line\nbreak "quoted"' }],
    { emoji: '\u{1F600}', control: '\u0001', big: 1e21, small: 1e-7 },
    { dropped: undefined, kept: 0 },
  ];
  for (const value of cases) assert.equal(canonicalJson(value), coreCanonical(value), JSON.stringify(value));
});
