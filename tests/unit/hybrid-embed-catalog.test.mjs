// Embedding model catalog (src/js/models/embed-catalog.js): pinned revisions with every downloaded
// file, the default model matching the shared library's vectors, prefixes and URL pinning.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_EMBED_MODEL,
  EMBED_BATCH_SIZE,
  EMBED_CATALOG,
  embedFileUrl,
  embedInput,
  embedModelId,
  embedSource,
  findEmbedSource,
  pinnedEmbedUrl,
  suggestSemanticSearch,
} from '../../src/js/models/embed-catalog.js';
import { WASM_CATALOG } from '../../src/js/models/wasm-catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('embedding catalog', () => {
  for (const [key, src] of Object.entries(EMBED_CATALOG)) {
    it(`${key}: pins a revision and lists every downloaded file with size and SHA-256`, () => {
      assert.equal(src.key, key);
      assert.match(src.revision, /^[0-9a-f]{40}$/);
      assert.match(src.repo, /^Xenova\/[\w.-]+$/);
      assert.equal(src.dtype, 'q8');
      assert.equal(src.weights, 'onnx/model_quantized.onnx');
      const names = src.files.map(([name]) => name);
      for (const name of ['config.json', 'tokenizer.json', 'tokenizer_config.json', src.weights]) assert.ok(names.includes(name), `${key}: ${name} missing`);
      assert.equal(new Set(names).size, names.length);
      for (const [name, bytes, sha] of src.files) {
        assert.ok(Number.isInteger(bytes) && bytes > 0, `${key}: ${name} size`);
        assert.match(sha, /^[0-9a-f]{64}$/, `${key}: ${name} sha256`);
      }
      for (const name of src.cacheProbe) assert.ok(names.includes(name), `${key}: cache probe ${name}`);
      const mb = src.files.reduce((sum, [, bytes]) => sum + bytes, 0) / 1e6;
      assert.ok(src.approxDownloadMB >= Math.ceil(mb) && src.approxDownloadMB - mb < 5, `${key}: ${src.approxDownloadMB} MB vs ${mb} MB`);
      assert.equal(src.dim, 384);
      assert.equal(src.pooling, 'mean');
      assert.equal(src.normalize, true);
    });
  }

  it('defaults to the multilingual model the shared library was embedded with', () => {
    const src = embedSource(DEFAULT_EMBED_MODEL);
    assert.equal(src.repo, 'Xenova/multilingual-e5-small');
    assert.equal(src.revision, '761b726dd34fb83930e26aab4e9ac3899aa1fa78');
    const pins = Object.fromEntries(src.files.map(([name, bytes, sha]) => [name, { bytes, sha }]));
    assert.deepEqual(pins['tokenizer.json'], { bytes: 17_082_730, sha: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39' });
    assert.deepEqual(pins['onnx/model_quantized.onnx'], { bytes: 118_308_185, sha: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193' });
    assert.equal(src.library, true);
    assert.equal(EMBED_CATALOG['minilm-l6'].library, false);
    // The publisher pins the same files; a drift would put browser queries in another vector space.
    const publisher = readFileSync(path.join(ROOT, 'tools/library-publisher/publisher/model_files.py'), 'utf8');
    assert.ok(publisher.includes(`MODEL_REPO = "${src.repo}"`));
    assert.ok(publisher.includes(`MODEL_REVISION = "${src.revision}"`));
    for (const name of ['tokenizer.json', 'onnx/model_quantized.onnx']) assert.ok(publisher.includes(pins[name].sha), name);
    assert.equal(embedSource('nope'), src);
  });

  it('adds the e5 prefixes and none for the compact English model', () => {
    const e5 = EMBED_CATALOG['e5-small'];
    assert.equal(embedInput(e5, 'query', 'opening hours'), 'query: opening hours');
    assert.equal(embedInput(e5, 'passage', 'Open 9 to 5.'), 'passage: Open 9 to 5.');
    assert.equal(embedInput(EMBED_CATALOG['minilm-l6'], 'query', 'opening hours'), 'opening hours');
    assert.equal(EMBED_BATCH_SIZE, 16);
  });

  it('names a vector space by repository, revision and quantisation', () => {
    assert.equal(embedModelId(EMBED_CATALOG['e5-small']), 'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78/q8');
    assert.notEqual(embedModelId(EMBED_CATALOG['e5-small']), embedModelId(EMBED_CATALOG['minilm-l6']));
  });

  it('pins every download of Transformers.js to the model and its revision', () => {
    const src = EMBED_CATALOG['e5-small'];
    const base = `https://huggingface.co/${src.repo}/resolve`;
    const pinned = embedFileUrl(src, 'config.json');
    assert.equal(pinned, `${base}/${src.revision}/config.json`);
    assert.equal(pinnedEmbedUrl(src, `${base}/main/config.json`), pinned);
    assert.equal(pinnedEmbedUrl(src, `${base}/${src.revision}/onnx/model_quantized.onnx`), embedFileUrl(src, 'onnx/model_quantized.onnx'));
    assert.equal(pinnedEmbedUrl(src, `${base}/0000000000000000000000000000000000000000/config.json`), null);
    assert.equal(pinnedEmbedUrl(src, `${base}/main/../config.json`), null);
    assert.equal(pinnedEmbedUrl(src, `${base}/main/config.json?x=1`), null);
    assert.equal(pinnedEmbedUrl(src, `https://huggingface.co/${WASM_CATALOG['qwen-0.5b'].repo}/resolve/main/config.json`), null);
    assert.equal(pinnedEmbedUrl(src, 'https://example.com/config.json'), null);
  });

  it('finds only exact catalog entries', () => {
    const src = EMBED_CATALOG['minilm-l6'];
    assert.equal(findEmbedSource({ repo: src.repo, revision: src.revision, dtype: 'q8' }), src);
    assert.equal(findEmbedSource({ repo: src.repo, revision: 'main', dtype: 'q8' }), null);
    assert.equal(findEmbedSource({ repo: src.repo, revision: src.revision, dtype: 'fp32' }), null);
    assert.equal(findEmbedSource(null), null);
  });

  it('offers semantic search unprompted only on capable devices', () => {
    assert.equal(suggestSemanticSearch({ isMobile: false, deviceMemoryGB: 8, cores: 8 }), true);
    assert.equal(suggestSemanticSearch({ isMobile: false, deviceMemoryGB: null, cores: null }), true);
    assert.equal(suggestSemanticSearch({ isMobile: true, deviceMemoryGB: 8, cores: 8 }), false);
    assert.equal(suggestSemanticSearch({ isMobile: false, deviceMemoryGB: 2, cores: 8 }), false);
    assert.equal(suggestSemanticSearch({ isMobile: false, deviceMemoryGB: 8, cores: 2 }), false);
  });
});
