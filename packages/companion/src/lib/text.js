// @ts-check
// Small text helpers of the companion.

/**
 * The text without trailing slashes. A loop instead of /\/+$/, so a long run of slashes costs
 * linear time.
 * @param {string} text
 */
export function trimTrailingSlashes(text) {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 47) end -= 1;
  return text.slice(0, end);
}
