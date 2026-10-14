// Processor (WASM) model catalog (src/js/models/wasm-catalog.js): pinned revisions, the file
// manifest behind the download size, and the README table.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { findWasmSource, WASM_CACHE_NAME, WASM_CATALOG, WASM_RUNTIME_MB, wasmFileUrl } from '../../src/js/models/wasm-catalog.js';

const REQUIRED_FILES = ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json'];

describe('WASM catalog', () => {
  for (const [key, src] of Object.entries(WASM_CATALOG)) {
    it(`${key}: pins a repository revision and lists every downloaded file`, () => {
      assert.equal(src.key, key);
      assert.match(src.revision, /^[0-9a-f]{40}$/);
      assert.match(src.repo, /^(HuggingFaceTB|onnx-community)\/[\w.-]+$/);
      assert.equal(src.dtype, 'q8');
      assert.equal(src.weights, 'onnx/model_quantized.onnx');
      const names = src.files.map(([name]) => name);
      for (const name of [...REQUIRED_FILES, src.weights]) assert.ok(names.includes(name), `${key}: ${name} missing`);
      assert.equal(new Set(names).size, names.length, `${key}: duplicate file`);
      for (const [name, bytes] of src.files) assert.ok(Number.isInteger(bytes) && bytes > 0, `${key}: ${name} size`);
      for (const name of src.cacheProbe) assert.ok(names.includes(name), `${key}: cache probe ${name} is not downloaded`);
      assert.ok(src.cacheProbe.includes(src.weights), `${key}: the cache probe must cover the weights`);
    });

    it(`${key}: states the download size and a context the model supports`, () => {
      const mb = src.files.reduce((sum, [, bytes]) => sum + bytes, 0) / 1e6;
      assert.ok(src.approxDownloadMB >= Math.ceil(mb), `${key}: ${src.approxDownloadMB} MB < ${mb} MB`);
      assert.ok(src.approxDownloadMB - mb < 10, `${key}: ${src.approxDownloadMB} MB overstates ${mb} MB`);
      assert.ok(src.contextWindow <= 2048 && src.contextWindow <= src.maxPositionEmbeddings, `${key}: context`);
      assert.ok(src.maxOutputTokens > 0 && src.maxOutputTokens <= src.contextWindow / 4, `${key}: output tokens`);
    });
  }

  it('caches outside the service worker prefix', () => {
    // sw.js deletes every "starpi-" cache when a new build activates.
    assert.equal(WASM_CACHE_NAME, 'transformers-cache');
    assert.ok(!WASM_CACHE_NAME.startsWith('starpi-'));
    assert.equal(WASM_RUNTIME_MB, 15);
  });

  it('builds the URL Transformers.js downloads and caches', () => {
    assert.equal(
      wasmFileUrl(WASM_CATALOG['smollm2-135m'], 'onnx/model_quantized.onnx'),
      'https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct/resolve/12fd25f77366fa6b3b4b768ec3050bf629380bac/onnx/model_quantized.onnx',
    );
  });

  it('finds only exact catalog sources', () => {
    const src = WASM_CATALOG['qwen-0.5b'];
    assert.equal(findWasmSource({ repo: src.repo, revision: src.revision, dtype: 'q8' }), src);
    assert.equal(findWasmSource({ repo: src.repo, revision: 'main', dtype: 'q8' }), null);
    assert.equal(findWasmSource({ repo: src.repo, revision: src.revision.slice(0, 7), dtype: 'q8' }), null);
    assert.equal(findWasmSource({ repo: src.repo, revision: src.revision, dtype: 'fp32' }), null);
    assert.equal(findWasmSource({ repo: 'attacker/model', revision: src.revision, dtype: 'q8' }), null);
    assert.equal(findWasmSource(null), null);
    assert.equal(findWasmSource({}), null);
  });
});

describe('README WASM model table', () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  // | T1 | `qwen-0.5b` (…) | `onnx-community/Qwen2.5-0.5B-Instruct` @ `22942cb` | `onnx/model_quantized.onnx` | 0.52 GB | 2,048 |
  const rows = new Map(
    [...readme.matchAll(/^\| T1 \| `([\w.-]+)`[^|]*\| `([\w-]+\/[\w.-]+)` @ `([0-9a-f]{7})` \| `(onnx\/[\w.]+\.onnx)` \| ([\d.]+) GB \| ([\d,]+) \|$/gm)].map(
      ([, key, repo, rev, weights, gb, ctx]) => [key, { repo, rev, weights, gb: Number(gb), ctx: Number(ctx.replaceAll(',', '')) }],
    ),
  );

  it('has one row per preset that matches the catalog', () => {
    assert.deepEqual([...rows.keys()].sort(), Object.keys(WASM_CATALOG).sort());
    for (const [key, src] of Object.entries(WASM_CATALOG)) {
      const row = rows.get(key);
      assert.equal(row.repo, src.repo, key);
      assert.equal(row.rev, src.revision.slice(0, 7), key);
      assert.equal(row.weights, src.weights, key);
      assert.equal(row.gb, src.approxDownloadMB / 1000, key);
      assert.equal(row.ctx, src.contextWindow, key);
    }
  });
});
