// The @starpi/core package is built from the app's own modules (scripts/build-core.mjs). These tests
// build it into a temporary directory and use the result the way a consumer would.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PKG = path.join(ROOT, 'packages/core');
const OUT = mkdtempSync(path.join(tmpdir(), 'starpi-core-'));

const built = spawnSync(process.execPath, [path.join(ROOT, 'scripts/build-core.mjs'), '--out', OUT, '--no-types'], { encoding: 'utf8' });

describe('@starpi/core', () => {
  it('builds a bundle and the receipt verifier', () => {
    assert.equal(built.status, 0, built.stderr);
    assert.ok(existsSync(path.join(OUT, 'index.js')));
    assert.ok(readFileSync(path.join(OUT, 'verify-receipt.js'), 'utf8').startsWith('#!/usr/bin/env node'));
  });

  it('exports exactly what its entry declares, with no import outside the bundle except pdf.js', async () => {
    const bundle = await import(pathToFileURL(path.join(OUT, 'index.js')).href);
    const entry = await import(pathToFileURL(path.join(PKG, 'src/index.js')).href);
    assert.deepEqual(Object.keys(bundle).sort(), Object.keys(entry).sort());
    // JSDoc type imports (import('./facts.js').SourceIndex) stay in comments; only code counts.
    const source = readFileSync(path.join(OUT, 'index.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const imports = [...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)|\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1] ?? m[2]);
    assert.ok(imports.every((spec) => spec.startsWith('pdfjs-dist/')), imports.join(', '));
  });

  it('checks an answer and builds and verifies a receipt from the bundle alone', async () => {
    const core = await import(pathToFileURL(path.join(OUT, 'index.js')).href);
    const bytes = new TextEncoder().encode('# Plan\n\nThe approved budget is 480,000 EUR. The group meets every Tuesday.\n');
    const { text, kind, pages, pdfjs } = await core.extractText(new File([bytes], 'plan.md'));
    const [chunk] = core.chunkText(text);
    const label = core.citationLabel('plan.md', 1);
    const sources = [{ label, doc: 'plan.md', heading: '', text: chunk.text, delivered: 'full' }];
    const answer = `The budget is 520,000 EUR ${label}. The group meets on Tuesdays ${label}.`;
    const report = core.groundAnswer(core.blocksFromMarkdown(answer, sources), sources);
    assert.deepEqual(report.counts, { supported: 1, weak: 0, unsupported: 1, unchecked: 0 });

    const receipt = await core.buildReceipt({
      createdAt: '2026-09-24T12:00:00.000Z',
      version: 'test',
      answer: { text: answer, engine: 'cloud', locale: 'en' },
      question: 'What is the budget?',
      grounding: report,
      citations: [
        {
          label,
          doc: 'plan.md',
          heading: '',
          source: 'workspace',
          delivered: 'full',
          text: chunk.text,
          truncated: false,
          document: {
            name: 'plan.md',
            kind,
            bytes: bytes.length,
            fileSha256: await core.sha256Hex(bytes),
            textSha256: await core.sha256Hex(text),
            textChars: text.length,
            pages,
            extractor: { ...core.EXTRACTOR, pdfjs },
            chunker: { ...core.CHUNKER, size: core.DEFAULT_CHUNK_SIZE, overlap: core.DEFAULT_CHUNK_OVERLAP },
          },
          chunk: { index: chunk.index, start: chunk.start, end: chunk.end },
        },
      ],
    });
    assert.equal(core.validateReceipt(JSON.parse(JSON.stringify(receipt))).ok, true);

    const receiptPath = path.join(OUT, 'receipt.json');
    const filePath = path.join(OUT, 'renamed-copy.md');
    writeFileSync(receiptPath, JSON.stringify(receipt));
    writeFileSync(filePath, bytes);
    const cli = spawnSync(process.execPath, [path.join(OUT, 'verify-receipt.js'), receiptPath, filePath, '--json'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).summary.reproduced, 1);
  });

  it('declares the files it publishes', () => {
    const pkg = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8'));
    assert.equal(pkg.name, '@starpi/core');
    assert.equal(pkg.exports['.'].default, './dist/index.js');
    assert.equal(pkg.exports['.'].types, './dist/index.d.ts');
    assert.equal(pkg.bin['starpi-verify-receipt'], './dist/verify-receipt.js');
    assert.deepEqual(pkg.dependencies ?? {}, {});
    for (const file of ['README.md', 'LICENSE']) assert.ok(existsSync(path.join(PKG, file)), file);
    assert.equal(readFileSync(path.join(PKG, 'LICENSE'), 'utf8'), readFileSync(path.join(ROOT, 'LICENSE'), 'utf8'));
  });
});
