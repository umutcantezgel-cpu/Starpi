// CycloneDX SBOMs (scripts/sbom.mjs, scripts/lib/sbom.mjs): npm sbom output made deterministic and
// checked. The last test runs the real command twice on this repository's lockfile.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NAMESPACE_DNS, normalizeCoreSbom, normalizeSbom, SCHEMA_URL, SERIAL_PATTERN, uuidV5, validateSbom } from '../../scripts/lib/sbom.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PATH = 'cdx:npm:package:path';

const component = (ref, path, extra = {}) => {
  const at = ref.lastIndexOf('@');
  return { 'bom-ref': ref, type: 'library', name: ref.slice(0, at), version: ref.slice(at + 1), scope: 'required', purl: `pkg:npm/${ref}`, properties: [{ name: PATH, value: path }], ...extra };
};

/** A small npm sbom document with the quirks npm 10 produces. */
const raw = () => ({
  $schema: SCHEMA_URL,
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: 'urn:uuid:2b20c189-290c-4e53-adfc-ca3d37d0e8a4',
  version: 1,
  metadata: {
    timestamp: '2026-10-13T19:26:08.826Z',
    lifecycles: [{ phase: 'pre-build' }],
    tools: [{ vendor: 'npm', name: 'cli', version: '10.9.4' }],
    component: { ...component('starpi@1.3.0', ''), type: 'application', name: 'Starpi' },
  },
  components: [
    component('dompurify@3.4.16', 'node_modules/dompurify'),
    component('glob-parent@5.1.2', 'node_modules/chokidar/node_modules/glob-parent', { scope: 'optional' }),
    component('glob-parent@5.1.2', 'node_modules/fast-glob/node_modules/glob-parent', { scope: 'optional' }),
    { ...component('@starpi/core@1.3.0', 'packages/core'), name: 'core' },
    component('pdfjs-dist@6.4.299', 'node_modules/pdfjs-dist'),
  ],
  dependencies: [
    { ref: 'starpi@1.3.0', dependsOn: ['dompurify@3.4.16', 'pdfjs-dist@6.4.299'] },
    { ref: 'glob-parent@5.1.2', dependsOn: ['dompurify@3.4.16'] },
    { ref: 'glob-parent@5.1.2', dependsOn: ['pdfjs-dist@6.4.299', 'dompurify@3.4.16'] },
    { ref: '@starpi/core@1.3.0', dependsOn: ['pdfjs-dist@6.4.299'] },
  ],
});
const names = { '': 'starpi', 'packages/core': '@starpi/core' };
const APP = { name: 'starpi', version: '1.3.0', type: 'application' };
const CORE = {
  ref: '@starpi/core@1.3.0',
  manifest: { name: '@starpi/core', version: '1.3.0', peerDependencies: { 'pdfjs-dist': '^6.3.289' }, peerDependenciesMeta: { 'pdfjs-dist': { optional: true } } },
};
/** npm 11.3 and later write no cdx:npm:package:path and list each package once. */
const withoutPaths = (doc) => ({
  ...doc,
  metadata: { ...doc.metadata, component: { ...doc.metadata.component, properties: [] } },
  components: doc.components.filter((c, i, all) => all.findIndex((d) => d['bom-ref'] === c['bom-ref']) === i).map((c) => ({ ...c, properties: [] })),
});

describe('uuidV5', () => {
  it('matches the version 5 example of RFC 9562 (appendix A.4) and the CycloneDX serial number pattern', () => {
    assert.equal(uuidV5('www.example.com', NAMESPACE_DNS), '2ed6657d-e927-568b-95e1-2665a8aea6a2');
    for (const name of ['', 'a', 'starpi', 'ü'.repeat(100)]) assert.match(`urn:uuid:${uuidV5(name)}`, SERIAL_PATTERN);
    assert.notEqual(uuidV5('a'), uuidV5('b'));
  });
});

describe('normalizeSbom', () => {
  const doc = normalizeSbom(raw(), { names, timestamp: '2026-10-08T19:54:28.000Z' });

  it('names the root and the workspace after their packages, not their directories', () => {
    assert.equal(doc.metadata.component.name, 'starpi');
    assert.equal(doc.components.find((c) => c['bom-ref'] === '@starpi/core@1.3.0').name, '@starpi/core');
  });

  it('names them by bom-ref when npm writes no path property (npm 11)', () => {
    const byRef = normalizeSbom(withoutPaths(raw()), { names: { 'starpi@1.3.0': 'starpi', '@starpi/core@1.3.0': '@starpi/core' } });
    assert.equal(byRef.metadata.component.name, 'starpi');
    assert.equal(byRef.components.find((c) => c['bom-ref'] === '@starpi/core@1.3.0').name, '@starpi/core');
    assert.deepEqual(validateSbom(byRef, APP), []);
  });

  it('merges a package listed twice under one bom-ref, keeping both paths and all edges', () => {
    const globs = doc.components.filter((c) => c['bom-ref'] === 'glob-parent@5.1.2');
    assert.equal(globs.length, 1);
    assert.deepEqual(
      globs[0].properties.filter((p) => p.name === PATH).map((p) => p.value),
      ['node_modules/chokidar/node_modules/glob-parent', 'node_modules/fast-glob/node_modules/glob-parent'],
    );
    assert.deepEqual(doc.dependencies.filter((d) => d.ref === 'glob-parent@5.1.2'), [{ ref: 'glob-parent@5.1.2', dependsOn: ['dompurify@3.4.16', 'pdfjs-dist@6.4.299'] }]);
  });

  it('keeps a merged package required, and development-only, as soon as one copy says otherwise', () => {
    const doc = raw();
    doc.components.push(
      component('shared@1.0.0', 'node_modules/aaa-devtool/node_modules/shared', { scope: 'optional', properties: [{ name: PATH, value: 'node_modules/aaa-devtool/node_modules/shared' }, { name: 'cdx:npm:package:development', value: 'true' }] }),
      component('shared@1.0.0', 'node_modules/marked/node_modules/shared'),
    );
    const merged = normalizeSbom(doc, { names }).components.find((c) => c['bom-ref'] === 'shared@1.0.0');
    assert.equal(merged.scope, 'required');
    assert.deepEqual(merged.properties, [
      { name: PATH, value: 'node_modules/aaa-devtool/node_modules/shared' },
      { name: PATH, value: 'node_modules/marked/node_modules/shared' },
    ]);
  });

  it('replaces the timestamp and derives the serial number from the content', () => {
    assert.equal(doc.metadata.timestamp, '2026-10-08T19:54:28.000Z');
    assert.deepEqual(Object.keys(doc.metadata), ['timestamp', 'lifecycles', 'tools', 'component']);
    assert.deepEqual(Object.keys(doc), Object.keys(raw()));
    assert.match(doc.serialNumber, SERIAL_PATTERN);
    const again = normalizeSbom({ ...raw(), serialNumber: 'urn:uuid:00000000-0000-4000-8000-000000000000', metadata: { ...raw().metadata, timestamp: '2030-01-01T00:00:00.000Z' } }, { names, timestamp: '2026-10-08T19:54:28.000Z' });
    assert.deepEqual(again, doc);
    const other = normalizeSbom(raw(), { names, timestamp: '2026-10-09T00:00:00.000Z' });
    assert.notEqual(other.serialNumber, doc.serialNumber);
  });

  it('leaves the timestamp out when none is given', () => {
    assert.equal('timestamp' in normalizeSbom(raw(), { names }).metadata, false);
  });

  it('passes the validator, which the raw npm output does not', () => {
    assert.deepEqual(validateSbom(doc, { ...APP, required: ['dompurify'] }), []);
    const problems = validateSbom(raw(), APP);
    assert.ok(problems.includes('bom-ref glob-parent@5.1.2 is not unique'), problems.join('\n'));
    assert.ok(problems.some((p) => p.startsWith('main component is Starpi')), problems.join('\n'));
  });
});

describe('normalizeCoreSbom', () => {
  const doc = normalizeCoreSbom(normalizeSbom(raw(), { names }), CORE);

  it('describes the package alone, without the root project or its optional peer', () => {
    assert.equal(doc.metadata.component['bom-ref'], '@starpi/core@1.3.0');
    assert.equal(doc.metadata.component.type, 'library');
    assert.equal(doc.metadata.component.purl, 'pkg:npm/@starpi/core@1.3.0');
    assert.deepEqual(doc.components, []);
    assert.deepEqual(doc.dependencies, [{ ref: '@starpi/core@1.3.0', dependsOn: [] }]);
    assert.doesNotMatch(JSON.stringify(doc), /starpi@1\.3\.0|pdfjs-dist/);
    assert.deepEqual(validateSbom(doc, { name: '@starpi/core', version: '1.3.0', type: 'library', noComponents: true }), []);
  });

  it('refuses a package that would install anything, instead of dropping it', () => {
    const manifest = (extra) => ({ ...CORE, manifest: { ...CORE.manifest, ...extra } });
    assert.throws(() => normalizeCoreSbom(raw(), manifest({ dependencies: { marked: '18.0.14' } })), /installs marked/);
    assert.throws(() => normalizeCoreSbom(raw(), manifest({ optionalDependencies: { dompurify: '3.4.16' } })), /installs dompurify/);
    assert.throws(() => normalizeCoreSbom(raw(), manifest({ bundleDependencies: ['lucide'] })), /installs lucide/);
    assert.throws(() => normalizeCoreSbom(raw(), manifest({ peerDependenciesMeta: {} })), /installs pdfjs-dist/);
    const edge = raw();
    edge.dependencies.find((d) => d.ref === '@starpi/core@1.3.0').dependsOn.push('dompurify@3.4.16');
    assert.throws(() => normalizeCoreSbom(edge, CORE), /depends on dompurify@3\.4\.16, which is not an optional peer/);
    assert.throws(() => normalizeCoreSbom(raw(), { ...CORE, ref: '@starpi/core@9.9.9' }), /not a component/);
  });
});

describe('validateSbom', () => {
  const good = () => normalizeSbom(raw(), { names });

  it('reports dangling dependency edges, missing purls, bad serials and missing runtime dependencies', () => {
    const doc = good();
    doc.dependencies.push({ ref: 'ghost@1.0.0', dependsOn: ['dompurify@3.4.16'] }, { ref: 'dompurify@3.4.16', dependsOn: ['phantom@2.0.0'] });
    doc.components[0] = { ...doc.components[0], purl: undefined };
    doc.serialNumber = 'urn:uuid:not-a-uuid';
    const problems = validateSbom(doc, { ...APP, required: ['marked'] });
    for (const expected of [
      'dependency entry for unknown ref ghost@1.0.0',
      'dompurify@3.4.16 depends on unknown ref phantom@2.0.0',
      'component dompurify@3.4.16 has no npm purl',
      'serialNumber urn:uuid:not-a-uuid does not match the CycloneDX pattern',
      'runtime dependency marked is not listed with scope required',
    ]) {
      assert.ok(problems.includes(expected), `${expected}\n---\n${problems.join('\n')}`);
    }
  });

  it('checks the format, the version and the main component', () => {
    const problems = validateSbom({ ...good(), specVersion: '1.4', bomFormat: 'SPDX' }, { ...APP, version: '2.0.0', noComponents: true });
    assert.ok(problems.includes('specVersion is 1.4, expected 1.5'));
    assert.ok(problems.includes('bomFormat is SPDX'));
    assert.ok(problems.includes('main component version is 1.3.0, expected 2.0.0'));
    assert.ok(problems.some((p) => p.startsWith('expected no components')));
  });
});

describe('npm run sbom', () => {
  it('refuses a missing --out value and unknown arguments', () => {
    for (const argv of [['--out'], ['--out', '--json'], ['--out='], ['--bogus']]) {
      const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/sbom.mjs'), ...argv], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(result.status, 2, `${argv.join(' ')}: ${result.stderr}`);
    }
  });

  const run = () => {
    const out = mkdtempSync(path.join(tmpdir(), 'starpi-sbom-'));
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/sbom.mjs'), '--out', out], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, SOURCE_DATE_EPOCH: '1791849600' },
    });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(readdirSync(out).sort().map((file) => [file, readFileSync(path.join(out, file), 'utf8')]));
  };

  it('writes the same two SBOMs on every run, for the app and for @starpi/core', () => {
    const first = run();
    const root = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const core = JSON.parse(readFileSync(path.join(ROOT, 'packages/core/package.json'), 'utf8'));
    assert.deepEqual(Object.keys(first), [`starpi-${root.version}.cdx.json`, `starpi-core-${core.version}.cdx.json`]);
    assert.deepEqual(run(), first);

    const app = JSON.parse(first[`starpi-${root.version}.cdx.json`]);
    assert.equal(app.metadata.timestamp, '2026-10-13T00:00:00.000Z');
    assert.deepEqual(validateSbom(app, { name: 'starpi', version: root.version, type: 'application', required: Object.keys(root.dependencies) }), []);
    assert.ok(app.components.some((c) => c.name === 'esbuild' && c.scope === 'optional'), 'development tooling is listed and marked');

    const pkg = JSON.parse(first[`starpi-core-${core.version}.cdx.json`]);
    assert.equal(pkg.metadata.component.name, '@starpi/core');
    assert.deepEqual(pkg.components, []);
  });
});
