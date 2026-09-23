// docs/ARCHITECTURE.md is the single source of every documentation diagram. Other Markdown files
// may embed a diagram under the same `<!-- diagram: <id> -->` marker, but only as an exact copy, so
// the README and the guides cannot drift from the atlas (`npm run docs:sync` refreshes the copies).
// Relative links in every Markdown file must resolve, including #anchors into Markdown files.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fences, headingSlugs, linkTargets, markdownFiles, mermaidBlocks, relativeLinks, ROOT, slugsOf } from '../../scripts/markdown.mjs';

const ATLAS = 'docs/ARCHITECTURE.md';
const atlas = mermaidBlocks(ATLAS);
const byId = new Map(atlas.map((b) => [b.id, b]));

describe('documentation diagrams', () => {
  it('gives every atlas diagram a unique id marker', () => {
    assert.ok(atlas.length > 0, `${ATLAS} has no diagrams`);
    for (const block of atlas) assert.ok(block.id, `${ATLAS}:${block.line}: diagram without <!-- diagram: id --> marker`);
    assert.equal(byId.size, atlas.length, 'duplicate diagram ids in the atlas');
  });

  it('embeds diagrams elsewhere only as exact copies of the atlas', () => {
    for (const file of markdownFiles().filter((f) => f !== ATLAS)) {
      for (const block of mermaidBlocks(file)) {
        assert.ok(block.id, `${file}:${block.line}: add a <!-- diagram: id --> marker and put the diagram in ${ATLAS}`);
        const original = byId.get(block.id);
        assert.ok(original, `${file}:${block.line}: diagram "${block.id}" is not in ${ATLAS}`);
        assert.equal(block.source, original.source, `${file}:${block.line}: "${block.id}" differs from ${ATLAS}:${original.line}; run npm run docs:sync`);
      }
    }
  });

  it('links only to files and headings that exist', () => {
    for (const file of markdownFiles()) {
      for (const { target, anchor } of relativeLinks(file)) {
        const resolved = target ? path.resolve(ROOT, path.dirname(file), decodeURI(target)) : path.join(ROOT, file);
        assert.ok(existsSync(resolved), `${file}: broken link ${target}`);
        if (anchor && resolved.endsWith('.md')) {
          const rel = path.relative(ROOT, resolved);
          assert.ok(headingSlugs(rel).has(decodeURIComponent(anchor)), `${file}: no heading for #${anchor} in ${rel}`);
        }
      }
    }
  });
});

describe('markdown helpers', () => {
  it('finds backtick and tilde fences, longer closers and unclosed fences', () => {
    const lines = ['~~~mermaid', 'a', '~~~', '````md', '```', 'b', '````', '```js', 'c'];
    assert.deepEqual(fences(lines), [
      { start: 0, end: 2, info: 'mermaid' },
      { start: 3, end: 6, info: 'md' },
      { start: 7, end: 9, info: 'js' },
    ]);
  });

  it('reads inline links with titles and angle brackets, reference definitions, and skips code and URLs', () => {
    const lines = [
      '[a](docs/x.md "Title") [b](<SECURITY.md#scope>) [c](#local) [d](https://example.com/y.md)',
      '`[e](not-a-link.md)`',
      '[r]: backend/README.md#endpoints',
      '~~~bash',
      '[f](inside-fence.md)',
      '~~~',
    ];
    assert.deepEqual(linkTargets(lines), [
      { target: 'docs/x.md', anchor: null },
      { target: 'SECURITY.md', anchor: 'scope' },
      { target: '', anchor: 'local' },
      { target: 'backend/README.md', anchor: 'endpoints' },
    ]);
  });

  it('computes GitHub anchors from the rendered heading text', () => {
    const slugs = slugsOf([
      '## See [the guide](docs/x.md)',
      '## _Note_ on *x*',
      '### Frontend modules (`src/js`)',
      '# Foo',
      '# Foo 1',
      '# Foo',
      '## ingest_raw_information: structuring',
      '```bash',
      '# not a heading',
      '```',
    ]);
    assert.deepEqual([...slugs], ['see-the-guide', 'note-on-x', 'frontend-modules-srcjs', 'foo', 'foo-1', 'foo-2', 'ingest_raw_information-structuring']);
  });
});
