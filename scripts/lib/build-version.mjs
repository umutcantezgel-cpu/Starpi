// Build version: a hash over everything the service worker serves from its cache, so any change
// (the page, a hashed asset, a public file such as the manifest, an icon or a sample document, or
// the service worker itself) makes returning visitors fetch the new version.
import { createHash } from 'node:crypto';

/**
 * @param {{ html: string, assetUrls: string[], publicFiles: Array<{ url: string, bytes: Uint8Array }>, swTemplate: string }} input
 * @returns {string} 12 hex characters
 */
export function buildVersion({ html, assetUrls, publicFiles, swTemplate }) {
  const hash = createHash('sha256').update(html).update([...assetUrls].sort().join('\n'));
  for (const file of [...publicFiles].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))) {
    hash.update(`\n${file.url}\n`).update(file.bytes);
  }
  return hash.update(swTemplate).digest('hex').slice(0, 12);
}
