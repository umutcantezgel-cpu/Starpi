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

  it('changes when the response headers change, so the cached shell never keeps an old policy', () => {
    const v = buildVersion({ ...base, headersDigest: '0123456789abcdef' });
    assert.notEqual(v, buildVersion(base));
    assert.notEqual(v, buildVersion({ ...base, headersDigest: 'fedcba9876543210' }));
    assert.equal(v, buildVersion({ ...base, headersDigest: '0123456789abcdef' }));
    // Without a digest the version is the one earlier builds computed.
    assert.equal(buildVersion({ ...base, headersDigest: '' }), buildVersion(base));
  });
});
