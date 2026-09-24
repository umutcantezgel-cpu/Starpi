import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildVersion } from '../../scripts/lib/build-version.mjs';

describe('buildVersion', () => {
  const base = {
    html: '<html></html>',
    assetUrls: ['/assets/b.js', '/assets/a.css'],
    publicFiles: [{ url: '/manifest.webmanifest', bytes: new TextEncoder().encode('{}') }],
    swTemplate: 'self.addEventListener("fetch", () => {});',
  };

  it('is stable under reordering', () => {
    assert.equal(buildVersion(base), buildVersion({ ...base, assetUrls: [...base.assetUrls].reverse() }));
    assert.match(buildVersion(base), /^[0-9a-f]{12}$/);
  });

  it('changes when a public file, the page, an asset or the service worker changes', () => {
    const v = buildVersion(base);
    assert.notEqual(buildVersion({ ...base, publicFiles: [{ url: '/manifest.webmanifest', bytes: new TextEncoder().encode('{"a":1}') }] }), v);
    assert.notEqual(buildVersion({ ...base, publicFiles: [...base.publicFiles, { url: '/samples/a.md', bytes: new Uint8Array() }] }), v);
    assert.notEqual(buildVersion({ ...base, html: '<html> </html>' }), v);
    assert.notEqual(buildVersion({ ...base, assetUrls: ['/assets/c.js'] }), v);
    assert.notEqual(buildVersion({ ...base, swTemplate: `${base.swTemplate}\n` }), v);
  });
});
