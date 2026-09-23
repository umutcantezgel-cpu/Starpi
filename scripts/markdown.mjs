// Markdown helpers shared by scripts/sync-diagrams.mjs and the documentation tests
// (tests/unit/docs.test.mjs, tests/e2e/docs-diagrams.spec.mjs): the repository's Markdown files,
// fenced code blocks as CommonMark delimits them, Mermaid blocks with their `<!-- diagram: <id> -->`
// markers, relative link targets and GitHub heading anchors.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'dist', '.git', '.build', 'playwright-report', 'test-results']);
const MARKER = /^<!-- diagram: ([a-z0-9-]+) -->$/;

/**
 * @param {string} [dir] absolute directory, default the repository root
 * @returns {string[]} repository-relative paths of every Markdown file
 */
export function markdownFiles(dir = ROOT) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith('.md') ? [path.relative(ROOT, full)] : [];
  });
}

/** @param {string} file repository-relative path */
export function readLines(file) {
  return readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n?/g, '\n').split('\n');
}

/**
 * Fenced code blocks: a run of three or more ` or ~ opens a fence, and only a line of the same
 * character, at least as long, closes it (an unclosed fence runs to the end of the file).
 * @param {string[]} lines
 * @returns {Array<{ start: number, end: number, info: string }>} opener and closer line indexes
 */
export function fences(lines) {
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!open || (open[1][0] === '`' && open[2].includes('`'))) continue;
    const [, fence, rest] = open;
    let end = i + 1;
    while (end < lines.length) {
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(lines[end]);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) break;
      end++;
    }
    found.push({ start: i, end, info: (rest.trim().split(/\s+/)[0] ?? '').toLowerCase() });
    i = end;
  }
  return found;
}

/**
 * @param {string} file repository-relative path
 * @returns {Array<{ id: string | null, line: number, source: string }>} every ```mermaid / ~~~mermaid block
 */
export function mermaidBlocks(file) {
  const lines = readLines(file);
  return fences(lines)
    .filter((f) => f.info === 'mermaid')
    .map(({ start, end }) => {
      const marker = start > 0 ? MARKER.exec(lines[start - 1].trim()) : null;
      return { id: marker ? marker[1] : null, line: start + 1, source: lines.slice(start + 1, end).join('\n') };
    });
}

/** @param {string[]} lines @returns {string[]} the lines with fenced blocks blanked out */
function withoutFences(lines) {
  const out = lines.slice();
  for (const { start, end } of fences(lines)) {
    for (let i = start; i <= end && i < out.length; i++) out[i] = '';
  }
  return out;
}

/**
 * Relative link targets outside code: inline links (with optional <angle brackets> and titles) and
 * reference definitions. External URLs and mail links are skipped.
 * @param {string} file repository-relative path
 * @returns {Array<{ target: string, anchor: string | null }>} target '' means the file itself
 */
export function relativeLinks(file) {
  return linkTargets(readLines(file));
}

/**
 * @param {string[]} lines
 * @returns {Array<{ target: string, anchor: string | null }>}
 */
export function linkTargets(lines) {
  const text = withoutFences(lines)
    .join('\n')
    .replace(/`[^`\n]*`/g, '');
  const inline = /\]\(\s*<?([^()#\s<>]*)(?:#([^()\s<>]*))?>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  const refdef = /^ {0,3}\[(?!\^)[^\]]+\]:\s*<?([^\s#<>]*)(?:#([^\s<>]*))?>?/gm;
  return [...text.matchAll(inline), ...text.matchAll(refdef)]
    .map(([, target, anchor]) => ({ target, anchor: anchor ?? null }))
    .filter(({ target }) => !/^[a-z][a-z0-9+.-]*:/i.test(target));
}

/**
 * GitHub heading anchors, computed from the rendered heading text: link targets, inline HTML and
 * emphasis markers dropped, code spans kept, punctuation removed, spaces to hyphens, and -1, -2 …
 * for repeats.
 * @param {string} file repository-relative path
 * @returns {Set<string>}
 */
export function headingSlugs(file) {
  return slugsOf(readLines(file));
}

/**
 * @param {string[]} lines
 * @returns {Set<string>}
 */
export function slugsOf(lines) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {Set<string>} */
  const slugs = new Set();
  for (const line of withoutFences(lines)) {
    const m = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (!m) continue;
    const text = m[1]
      .split(/(`[^`]*`)/)
      .map((part, i) =>
        i % 2
          ? part
          : part
              .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
              .replace(/<[^>]+>/g, '')
              .replace(/(^|[^\p{L}\p{N}])[*_]+|[*_]+(?=[^\p{L}\p{N}]|$)/gu, '$1'),
      )
      .join('');
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N} _-]/gu, '').replace(/ /g, '-');
    let n = seen.get(base) ?? 0;
    let slug = n ? `${base}-${n}` : base;
    while (slugs.has(slug)) slug = `${base}-${++n}`;
    seen.set(base, n + 1);
    slugs.add(slug);
  }
  return slugs;
}
