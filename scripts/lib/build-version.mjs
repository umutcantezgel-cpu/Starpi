// Build version: a hash over everything the service worker serves from its cache, so any change
// (the page, a hashed asset, a public file such as the manifest, an icon or a sample document, the
// service worker itself, or a response header of scripts/headers.json, which the cached shell
// carries) makes returning visitors fetch the new version.
import { createHash } from 'node:crypto';

/**
 * @param {{ html: string, assetUrls: string[], publicFiles: Array<{ url: string, bytes: Uint8Array }>, swTemplate: string, headersDigest?: string }} input
 *   headersDigest: digest of the resolved header rules of the build's profile (scripts/lib/headers.mjs)
 * @returns {string} 12 hex characters
 */
export function buildVersion({ html, assetUrls, publicFiles, swTemplate, headersDigest = '' }) {
  const hash = createHash('sha256').update(html).update([...assetUrls].sort().join('\n'));
  for (const file of [...publicFiles].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))) {
    hash.update(`\n${file.url}\n`).update(file.bytes);
  }
  hash.update(swTemplate);
  // Without a digest the hash is the one of earlier builds, so their versions stay reproducible.
  if (headersDigest) hash.update(`\nheaders:${headersDigest}`);
  return hash.digest('hex').slice(0, 12);
}
