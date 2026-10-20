// Processor (WASM) model catalog (src/js/models/wasm-catalog.js): pinned revisions, the file
// manifest behind the download size, the README table, and what the app assumes about the pinned
// Transformers.js and ONNX Runtime packages.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findWasmSource, pinnedWasmUrl, WASM_CACHE_NAME, WASM_CATALOG, WASM_RUNTIME_MB, wasmFileUrl } from '../../src/js/models/wasm-catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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

  it('pins every download of Transformers.js to the model and its revision', () => {
    const src = WASM_CATALOG['smollm2-135m'];
    const repo = `https://huggingface.co/${src.repo}/resolve`;
    const pinned = wasmFileUrl(src, 'tokenizer_config.json');
    assert.equal(pinnedWasmUrl(src, `${repo}/${src.revision}/tokenizer_config.json`), pinned);
    // Transformers.js 4.3 checks this file at 'main' even when a revision is given.
    assert.equal(pinnedWasmUrl(src, `${repo}/main/tokenizer_config.json`), pinned);
    assert.equal(pinnedWasmUrl(src, `${repo}/main/onnx/model_quantized.onnx`), wasmFileUrl(src, 'onnx/model_quantized.onnx'));
    for (const url of [
      `${repo}/0123456789abcdef0123456789abcdef01234567/config.json`,
      `${repo}/refs%2Fpr%2F1/config.json`,
      `${repo}/main/`,
      `${repo}/main/../../other/resolve/main/config.json`,
      `${repo}/main/onnx/./model.onnx`,
      `${repo}/main/.gitattributes`,
      `${repo}/main/config.json?download=true`,
      `https://huggingface.co/${src.repo}-copy/resolve/main/config.json`,
      `https://huggingface.co/${WASM_CATALOG['qwen-0.5b'].repo}/resolve/main/config.json`,
      `https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm`,
      `/models/${src.repo}/config.json`,
    ]) {
      assert.equal(pinnedWasmUrl(src, url), null, url);
    }
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

/**
 * The directory Node (and esbuild) load `name` from for a module in `from`.
 * @param {string} name
 * @param {string} from
 */
function packageDir(name, from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`${name} is not installed for ${from}`);
  }
}

describe('Transformers.js and ONNX Runtime packages', () => {
  const transformers = packageDir('@huggingface/transformers', ROOT);
  const web = readFileSync(path.join(transformers, 'dist/transformers.web.js'), 'utf8');
  const ortDist = path.join(packageDir('onnxruntime-web', transformers), 'dist');
  const ort = readFileSync(path.join(ortDist, 'ort.wasm.bundle.min.mjs'), 'utf8');

  it('pins Transformers.js exactly', () => {
    assert.equal(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies['@huggingface/transformers'], '4.3.1');
    const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    assert.equal(lock.packages['node_modules/@huggingface/transformers'].version, '4.3.1');
  });

  it('caches and names model files the way the app checks for them', () => {
    assert.ok(web.includes('cacheKey: "transformers-cache"'), 'Cache API name');
    assert.ok(web.includes('remotePathTemplate: "{model}/resolve/{revision}/"'), 'download URL (also the cache key)');
    assert.ok(web.includes('[DATA_TYPES.q8]: "_quantized"'), 'q8 weights file suffix');
    assert.ok(web.includes('env.useWasmCache'), 'the switch that keeps the runtime from becoming a blob: module');
  });

  it('imports ONNX Runtime only through the two modules the build redirects', () => {
    // scripts/build.mjs (ort-wasm-only) resolves both to onnxruntime-web/wasm.
    const imports = [...web.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]).sort();
    assert.deepEqual(imports, ['onnxruntime-common', 'onnxruntime-web/webgpu']);
  });

  it('ships a WASM-only ONNX Runtime bundle that the CSP allows and that replaces both imports', () => {
    assert.ok(ort.includes('ort-wasm-simd-threaded.wasm'), 'the binary the build copies');
    assert.ok(existsSync(path.join(ortDist, 'ort-wasm-simd-threaded.wasm')));
    assert.doesNotMatch(ort, /\bnew Function\s*\(/);
    assert.doesNotMatch(ort, /(^|[^.\w$])eval\s*\(/);
    const exported = new Set([...ort.matchAll(/export\{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((e) => e.trim().split(/\s+as\s+/).pop())));
    for (const name of ['InferenceSession', 'Tensor', 'env']) assert.ok(exported.has(name), `onnxruntime-web/wasm exports ${name}`);
  });
});
