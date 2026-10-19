// The app SBOM lists what the render frame bundles (mermaid and what it needs at run time) as
// shipped, although package.json names mermaid as a development dependency; the optional layout
// engine the build replaces with a stub stays a development package.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { productionTree } from '../../scripts/license-gate.mjs';
import { markShipped } from '../../scripts/lib/sbom.mjs';

const DEV = { name: 'cdx:npm:package:development', value: 'true' };

/** @param {string} ref @param {boolean} dev */
const component = (ref, dev) => ({ 'bom-ref': ref, name: ref.split('@')[0], version: ref.split('@')[1], scope: dev ? 'optional' : 'required', properties: dev ? [DEV] : [] });

describe('markShipped', () => {
  const doc = {
    serialNumber: 'urn:uuid:00000000-0000-5000-8000-000000000000',
    metadata: { component: component('starpi@3.0.0', false) },
    components: [component('mermaid@12.1.0', true), component('khroma@2.1.0', true), component('eslint@10.12.0', true), component('marked@18.0.14', false)],
  };

  it('clears the development mark of the shipped packages only, and gives them scope required', () => {
    const { doc: out, missing } = markShipped(doc, ['mermaid@12.1.0', 'khroma@2.1.0']);
    assert.deepEqual(missing, []);
    const byRef = Object.fromEntries(out.components.map((c) => [c['bom-ref'], c]));
    assert.deepEqual([byRef['mermaid@12.1.0'].scope, byRef['mermaid@12.1.0'].properties], ['required', []]);
    assert.deepEqual([byRef['khroma@2.1.0'].scope, byRef['khroma@2.1.0'].properties], ['required', []]);
    assert.deepEqual(byRef['eslint@10.12.0'].properties, [DEV]);
    assert.equal(byRef['marked@18.0.14'].scope, 'required');
    assert.notEqual(out.serialNumber, doc.serialNumber, 'a changed document gets a new serial number');
  });

  it('reports a shipped package the document does not list', () => {
    assert.deepEqual(markShipped(doc, ['mermaid@12.1.0', 'd3@7.9.0']).missing, ['d3@7.9.0']);
  });

  it('finds mermaid and its run-time tree in the lockfile, without the stubbed layout engine', () => {
    const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
    const policy = JSON.parse(readFileSync(new URL('../../scripts/license-allowlist.json', import.meta.url), 'utf8'));
    const tree = productionTree({ packages: { ...lock.packages, '': { dependencies: { mermaid: '*' } } } }, { skip: Object.keys(policy.excluded ?? {}) });
    assert.deepEqual(tree.problems, []);
    assert.ok(tree.keys.includes('node_modules/mermaid'));
    assert.ok(tree.keys.some((k) => k.endsWith('node_modules/khroma')));
    assert.ok(!tree.keys.some((k) => k.endsWith('node_modules/elkjs')), 'elkjs is replaced by a stub in the build');
  });
});
