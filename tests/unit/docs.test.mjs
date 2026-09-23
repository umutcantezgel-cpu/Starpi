// docs/ARCHITECTURE.md is the single source of every documentation diagram. Other Markdown files
// may embed a diagram under the same `<!-- diagram: <id> -->` marker, but only as an exact copy, so
// the README and the guides cannot drift from the atlas. Relative links in every Markdown file must
// resolve, including #anchors into Markdown files.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ATLAS = 'docs/ARCHITECTURE.md';
const SKIP = new Set(['node_modules', 'dist', '.git', '.build', 'playwright-report', 'test-results']);
const MARKER = /^<!-- diagram: ([a-z0-9-]+) -->$/;

/** @param {string} dir @returns {string[]} */
function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith('.md') ? [path.relative(ROOT, full)] : [];
  });
}

/**
 * @param {string} file repository-relative path
 * @returns {Array<{ id: string | null, line: number, source: string }>}
 */
function mermaidBlocks(file) {
  const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '```mermaid') continue;
    const marker = i > 0 ? MARKER.exec(lines[i - 1].trim()) : null;
    let end = i + 1;
    while (end < lines.length && lines[end].trim() !== '```') end++;
    blocks.push({ id: marker ? marker[1] : null, line: i + 1, source: lines.slice(i + 1, end).join('\n') });
    i = end;
  }
  return blocks;
}

/** @param {string} text */
function withoutFences(text) {
  return text.replace(/```[\s\S]*?```/g, '');
}

/** @param {string} text */
function withoutCode(text) {
  return withoutFences(text).replace(/`[^`\n]*`/g, '');
}

/**
 * GitHub heading anchors: lowercase, punctuation removed, spaces to hyphens, -1, -2 for repeats.
 * @param {string} file absolute path
 */
function headingSlugs(file) {
  const seen = new Map();
  const slugs = new Set();
  for (const line of withoutFences(readFileSync(file, 'utf8')).split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (!m) continue;
    const base = m[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    slugs.add(n ? `${base}-${n}` : base);
  }
  return slugs;
}

const atlas = mermaidBlocks(ATLAS);
const byId = new Map(atlas.map((b) => [b.id, b]));

describe('documentation diagrams', () => {
  it('gives every atlas diagram a unique id marker', () => {
    assert.ok(atlas.length > 0, `${ATLAS} has no diagrams`);
    for (const block of atlas) assert.ok(block.id, `${ATLAS}:${block.line}: diagram without <!-- diagram: id --> marker`);
    assert.equal(byId.size, atlas.length, 'duplicate diagram ids in the atlas');
  });

  it('embeds diagrams elsewhere only as exact copies of the atlas', () => {
    for (const file of markdownFiles(ROOT).filter((f) => f !== ATLAS)) {
      for (const block of mermaidBlocks(file)) {
        assert.ok(block.id, `${file}:${block.line}: add a <!-- diagram: id --> marker and put the diagram in ${ATLAS}`);
        const original = byId.get(block.id);
        assert.ok(original, `${file}:${block.line}: diagram "${block.id}" is not in ${ATLAS}`);
        assert.equal(block.source, original.source, `${file}:${block.line}: "${block.id}" differs from ${ATLAS}:${original.line}`);
      }
    }
  });

  it('links only to files and headings that exist', () => {
    for (const file of markdownFiles(ROOT)) {
      const text = withoutCode(readFileSync(path.join(ROOT, file), 'utf8'));
      for (const [, target, anchor] of text.matchAll(/\]\(([^)#\s]*)(?:#([^)\s]*))?\)/g)) {
        if (/^[a-z]+:/i.test(target)) continue;
        const resolved = target ? path.resolve(ROOT, path.dirname(file), target) : path.join(ROOT, file);
        assert.ok(existsSync(resolved), `${file}: broken link ${target}`);
        if (anchor && resolved.endsWith('.md')) {
          assert.ok(headingSlugs(resolved).has(anchor), `${file}: no heading for #${anchor} in ${path.relative(ROOT, resolved)}`);
        }
      }
    }
  });
});
