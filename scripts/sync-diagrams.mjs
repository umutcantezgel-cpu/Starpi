#!/usr/bin/env node
// Copies every diagram of docs/ARCHITECTURE.md into the other Markdown files that embed it under the
// same `<!-- diagram: <id> -->` marker, so the README and the guides stay exact copies of the atlas.
//
// Usage: npm run docs:sync            rewrite outdated copies
//        npm run docs:sync -- --check exit 1 if any copy is outdated or unknown, change nothing
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fences, markdownFiles, mermaidBlocks, ROOT } from './markdown.mjs';

const ATLAS = 'docs/ARCHITECTURE.md';
const check = process.argv.includes('--check');
const MARKER = /^<!-- diagram: ([a-z0-9-]+) -->$/;

const sources = new Map(mermaidBlocks(ATLAS).map((b) => [b.id, b.source]));
let outdated = 0;
let unknown = 0;

for (const file of markdownFiles().filter((f) => f !== ATLAS)) {
  const full = path.join(ROOT, file);
  const original = readFileSync(full, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.replace(/\r\n?/g, '\n').split('\n');
  let changed = false;
  // Replace from the bottom so earlier line numbers stay valid.
  for (const { start, end, info } of fences(lines).reverse()) {
    const marker = info === 'mermaid' && start > 0 ? MARKER.exec(lines[start - 1].trim()) : null;
    if (!marker) continue;
    const source = sources.get(marker[1]);
    if (source === undefined) {
      console.error(`${file}:${start + 1}: diagram "${marker[1]}" is not in ${ATLAS}`);
      unknown++;
      continue;
    }
    if (lines.slice(start + 1, end).join('\n') === source) continue;
    console.log(`${file}:${start + 1}: ${check ? 'outdated' : 'updated'} "${marker[1]}"`);
    lines.splice(start + 1, end - start - 1, ...source.split('\n'));
    outdated++;
    changed = true;
  }
  if (changed && !check) writeFileSync(full, lines.join(eol));
}

if (unknown || (check && outdated)) process.exit(1);
console.log(outdated ? `${outdated} diagram copies ${check ? 'outdated' : 'updated'}` : 'all diagram copies match the atlas');
