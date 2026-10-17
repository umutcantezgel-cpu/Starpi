// model-lock.json and its generator (scripts/models-lock.mjs). The committed lock covers every file
// the app's runtimes download: each WebLLM preset (config, tensor index, shards, model library), each
// file of the processor and embedding catalogs with the catalog's size (and SHA-256 where the
// catalog names one), and the self-hosted ONNX Runtime binary as installed. The generator runs
// against a stand-in model host: large files get their hash from the LFS listing without being
// downloaded, small files and libraries are hashed, a refresh is stable, --check notices an upstream
// change, a model that fails keeps its earlier entries, and without network the file stays as it is.
import './setup.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appSources, hfFileUrl, LOCK_FILE, LOCK_FORMAT, lockText, main, ortKey, validateLock, webllmSources } from '../../scripts/models-lock.mjs';
import { EMBED_CATALOG } from '../../src/js/models/embed-catalog.js';
import { WASM_CATALOG, wasmFileUrl } from '../../src/js/models/wasm-catalog.js';
import { ALL_MODEL_IDS } from '../../src/js/webgpu/models.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCK = JSON.parse(readFileSync(path.join(ROOT, LOCK_FILE), 'utf8'));

/** @param {string} text */
const bytes = (text) => new TextEncoder().encode(text);
/** @param {Uint8Array} data */
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

describe('the committed model lock', () => {
  it('is valid and covers every model the app can download', async () => {
    const sources = await appSources();
    const { problems } = validateLock(LOCK, sources);
    assert.deepEqual(problems, []);
    assert.equal(LOCK.format, LOCK_FORMAT);
    assert.equal(sources.filter((s) => s.kind === 'webllm').length, ALL_MODEL_IDS.length);
  });

  it('pins every processor and embedding file at the catalog size and hash', () => {
    for (const src of Object.values(WASM_CATALOG)) {
      for (const [file, size] of src.files) assert.equal(LOCK.files[wasmFileUrl(src, file)]?.size, size, `${src.key} ${file}`);
    }
    for (const src of Object.values(EMBED_CATALOG)) {
      for (const [file, size, hash] of src.files) assert.deepEqual(LOCK.files[hfFileUrl(src, file)], { sha256: hash, size }, `${src.key} ${file}`);
    }
  });

  it('pins the ONNX Runtime binary the build ships', async () => {
    const ort = (await appSources()).find((s) => s.kind === 'ort');
    assert.ok(ort && ort.kind === 'ort');
    const data = readFileSync(ort.file);
    assert.deepEqual(LOCK.files[ortKey(ort)], { sha256: sha256(data), size: data.byteLength });
  });

  it('is written in its canonical form: sorted, one file per line', () => {
    assert.equal(lockText(LOCK.files), readFileSync(path.join(ROOT, LOCK_FILE), 'utf8'));
  });

  it('reports a missing file, a wrong size and a malformed entry', async () => {
    const sources = await appSources();
    const src = WASM_CATALOG['qwen-0.5b'];
    const files = { ...LOCK.files };
    delete files[wasmFileUrl(src, 'tokenizer.json')];
    files[wasmFileUrl(src, 'config.json')] = { ...files[wasmFileUrl(src, 'config.json')], size: 1 };
    files['https://example.test/x'] = { sha256: 'nope', size: 0 };
    const { problems, stale } = validateLock({ format: LOCK_FORMAT, files }, sources);
    assert.ok(problems.includes(`missing ${wasmFileUrl(src, 'tokenizer.json')}`), problems.join('\n'));
    assert.ok(problems.some((p) => p.startsWith(`${wasmFileUrl(src, 'config.json')}: size 1`)));
    assert.ok(problems.some((p) => p.startsWith('https://example.test/x: sha256')));
    assert.deepEqual(stale, ['https://example.test/x']);
    assert.ok(validateLock({ format: 'other', files: {} }, []).problems.includes(`format is not ${LOCK_FORMAT}`));
  });

  it('reads the model directories and libraries from WebLLM records', () => {
    const [src] = webllmSources([{ model_id: 'A-MLC', model: 'https://huggingface.co/mlc-ai/A-MLC', model_lib: 'https://example.test/A.wasm' }], ['A-MLC']);
    assert.deepEqual(src, { kind: 'webllm', id: 'webllm:A-MLC', repo: 'mlc-ai/A-MLC', base: 'https://huggingface.co/mlc-ai/A-MLC/resolve/main/', lib: 'https://example.test/A.wasm' });
    assert.throws(() => webllmSources([], ['B-MLC']), /not in WebLLM's prebuilt model list/);
  });
});

// ---------------------------------------------------------------------------------------------
// A stand-in model host

const COMMIT = 'c0ffee0000000000000000000000000000000001';
const PINNED = 'beef000000000000000000000000000000000002';

/**
 * Two repositories as the Hugging Face API lists them, a model library and the runtime binary on
 * the npm CDN. Shards are LFS files: the listing names their hash, and downloading one fails the test.
 */
function fakeHost() {
  const config = bytes(JSON.stringify({ tokenizer_files: ['tokenizer.model', 'tokenizer_config.json'] }));
  const tensors = bytes(JSON.stringify({ records: [{ dataPath: 'params_shard_0.bin' }, { dataPath: 'params_shard_1.bin' }, { dataPath: 'params_shard_1.bin' }] }));
  const tokenizer = bytes('sentencepiece');
  const lib = bytes('\0asm library');
  const ort = bytes('\0asm runtime');
  const small = { 'config.json': bytes('{"a":1}'), 'onnx/model.onnx': bytes('weights') };
  const lfs = { 'params_shard_0.bin': { sha256: 'a'.repeat(64), size: 1_000 }, 'params_shard_1.bin': { sha256: 'b'.repeat(64), size: 2_000 } };
  /** @type {string[]} */
  const requests = [];
  const state = { offline: false, shardHash: lfs['params_shard_1.bin'].sha256 };
  /** @param {string} url */
  const fetch = async (url) => {
    requests.push(url);
    if (state.offline) throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    const json = (/** @type {unknown} */ value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (url === 'https://huggingface.co/api/models/mlc-ai/Tiny-MLC/revision/main?blobs=true') {
      return json({
        sha: COMMIT,
        siblings: [
          { rfilename: 'mlc-chat-config.json', size: config.byteLength, blobId: 'b1' },
          { rfilename: 'tensor-cache.json', size: tensors.byteLength, blobId: 'b2' },
          { rfilename: 'tokenizer.model', size: tokenizer.byteLength, blobId: 'b3' },
          { rfilename: 'params_shard_0.bin', size: 1_000, lfs: lfs['params_shard_0.bin'] },
          { rfilename: 'params_shard_1.bin', size: 2_000, lfs: { sha256: state.shardHash, size: 2_000 } },
        ],
      });
    }
    if (url === `https://huggingface.co/api/models/org/tiny/revision/${PINNED}?blobs=true`) {
      return json({ sha: PINNED, siblings: Object.entries(small).map(([rfilename, data], i) => ({ rfilename, size: data.byteLength, blobId: `s${i}` })) });
    }
    const files = {
      [`https://huggingface.co/mlc-ai/Tiny-MLC/resolve/${COMMIT}/mlc-chat-config.json`]: config,
      [`https://huggingface.co/mlc-ai/Tiny-MLC/resolve/${COMMIT}/tensor-cache.json`]: tensors,
      [`https://huggingface.co/mlc-ai/Tiny-MLC/resolve/${COMMIT}/tokenizer.model`]: tokenizer,
      [`https://huggingface.co/org/tiny/resolve/${PINNED}/config.json`]: small['config.json'],
      [`https://huggingface.co/org/tiny/resolve/${PINNED}/onnx/model.onnx`]: small['onnx/model.onnx'],
      'https://raw.githubusercontent.com/mlc-ai/libs/main/Tiny-webgpu.wasm': lib,
      'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.0.0/dist/ort-wasm-simd-threaded.wasm': ort,
    };
    if (/params_shard/.test(url)) throw new Error(`downloaded an LFS file: ${url}`);
    const body = files[url];
    return body ? new Response(body.slice()) : new Response('missing', { status: 404 });
  };
  return { fetch, requests, state, config, tensors, tokenizer, lib, ort, small, lfs };
}

/** A temporary checkout with the runtime binary installed. */
function workspace(/** @type {Uint8Array} */ ortBytes) {
  const root = mkdtempSync(path.join(tmpdir(), 'models-lock-'));
  mkdirSync(path.join(root, 'src/js/models'), { recursive: true });
  const ortFile = path.join(root, 'ort.wasm');
  writeFileSync(ortFile, ortBytes);
  return { root, ortFile, lockPath: path.join(root, LOCK_FILE) };
}

/**
 * @param {string} ortFile
 * @param {{ embedHash?: string }} [options]
 * @returns {import('../../scripts/models-lock.mjs').LockSource[]}
 */
function sources(ortFile, options = {}) {
  return [
    { kind: 'webllm', id: 'webllm:Tiny-MLC', repo: 'mlc-ai/Tiny-MLC', base: 'https://huggingface.co/mlc-ai/Tiny-MLC/resolve/main/', lib: 'https://raw.githubusercontent.com/mlc-ai/libs/main/Tiny-webgpu.wasm' },
    {
      kind: 'hf',
      id: 'embed:tiny',
      repo: 'org/tiny',
      revision: PINNED,
      files: [
        ['config.json', 7, options.embedHash ?? sha256(bytes('{"a":1}'))],
        ['onnx/model.onnx', 7],
      ],
    },
    { kind: 'ort', id: 'ort', version: '1.0.0', file: ortFile },
  ];
}

/** Collects what a run prints. */
function output() {
  /** @type {string[]} */
  const lines = [];
  return { lines, log: (/** @type {string} */ l) => lines.push(l), error: (/** @type {string} */ l) => lines.push(`ERR ${l}`) };
}

describe('the lock generator', () => {
  it('writes the hashes of every downloaded file without downloading large ones', async () => {
    const host = fakeHost();
    const ws = workspace(host.ort);
    const out = output();
    assert.equal(await main([], { root: ws.root, sources: sources(ws.ortFile), fetch: host.fetch, ...out }), 0, out.lines.join('\n'));
    const lock = JSON.parse(readFileSync(ws.lockPath, 'utf8'));
    const base = 'https://huggingface.co/mlc-ai/Tiny-MLC/resolve/main/';
    assert.deepEqual(lock, {
      format: LOCK_FORMAT,
      files: {
        [`${base}mlc-chat-config.json`]: { sha256: sha256(host.config), size: host.config.byteLength },
        [`${base}params_shard_0.bin`]: host.lfs['params_shard_0.bin'],
        [`${base}params_shard_1.bin`]: host.lfs['params_shard_1.bin'],
        [`${base}tensor-cache.json`]: { sha256: sha256(host.tensors), size: host.tensors.byteLength },
        [`${base}tokenizer.model`]: { sha256: sha256(host.tokenizer), size: host.tokenizer.byteLength },
        [`https://huggingface.co/org/tiny/resolve/${PINNED}/config.json`]: { sha256: sha256(host.small['config.json']), size: 7 },
        [`https://huggingface.co/org/tiny/resolve/${PINNED}/onnx/model.onnx`]: { sha256: sha256(host.small['onnx/model.onnx']), size: 7 },
        'https://raw.githubusercontent.com/mlc-ai/libs/main/Tiny-webgpu.wasm': { sha256: sha256(host.lib), size: host.lib.byteLength },
        'npm:onnxruntime-web@1.0.0/dist/ort-wasm-simd-threaded.wasm': { sha256: sha256(host.ort), size: host.ort.byteLength },
      },
    });
    assert.ok(!host.requests.some((u) => /params_shard/.test(u)), 'shards come from the LFS listing');
    assert.ok(host.requests.every((u) => !u.includes('/resolve/main/')), 'small files are downloaded at the listed commit');
    assert.equal(lockText(lock.files), readFileSync(ws.lockPath, 'utf8'));

    // A second run changes nothing.
    const again = output();
    assert.equal(await main([], { root: ws.root, sources: sources(ws.ortFile), fetch: host.fetch, ...again }), 0);
    assert.ok(again.lines.some((l) => l.includes('is up to date')), again.lines.join('\n'));
  });

  it('--check passes while the hosts match and fails when a file changed upstream', async () => {
    const host = fakeHost();
    const ws = workspace(host.ort);
    await main([], { root: ws.root, sources: sources(ws.ortFile), fetch: host.fetch, ...output() });
    const before = readFileSync(ws.lockPath, 'utf8');

    const ok = output();
    assert.equal(await main(['--check'], { root: ws.root, sources: sources(ws.ortFile), fetch: host.fetch, ...ok }), 0, ok.lines.join('\n'));
    assert.ok(ok.lines.some((l) => l.includes('matches the model hosts')));

    host.state.shardHash = 'c'.repeat(64);
    const changed = output();
    assert.equal(await main(['--check'], { root: ws.root, sources: sources(ws.ortFile), fetch: host.fetch, ...changed }), 1);
    assert.ok(changed.lines.includes('ERR changed upstream: https://huggingface.co/mlc-ai/Tiny-MLC/resolve/main/params_shard_1.bin'), changed.lines.join('\n'));
    assert.equal(readFileSync(ws.lockPath, 'utf8'), before, '--check writes nothing');
  });

  it('--check fails offline on a lock that misses a catalog file or another runtime binary', async () => {
    const host = fakeHost();
    const ws = workspace(host.ort);
    writeFileSync(ws.lockPath, lockText({}));
    host.state.offline = true;
    const out = output();
    assert.equal(await main(['--check'], { root: ws.root, sources: sources(ws.ortFile), fetch: host.fetch, ...out }), 1);
    assert.ok(out.lines.some((l) => l.includes('missing https://raw.githubusercontent.com/mlc-ai/libs/main/Tiny-webgpu.wasm')), out.lines.join('\n'));
  });

  it('keeps the earlier entries of a model that fails, and says why', async () => {
    const host = fakeHost();
    const ws = workspace(host.ort);
    await main([], { root: ws.root, sources: sources(ws.ortFile), fetch: host.fetch, ...output() });
    const before = JSON.parse(readFileSync(ws.lockPath, 'utf8'));

    host.state.shardHash = 'd'.repeat(64);
    const out = output();
    // The catalog names another hash for config.json than the host serves: that model fails.
    assert.equal(await main([], { root: ws.root, sources: sources(ws.ortFile, { embedHash: 'e'.repeat(64) }), fetch: host.fetch, ...out }), 1);
    assert.ok(out.lines.some((l) => l.startsWith('ERR embed:tiny:') && l.includes('another SHA-256 upstream than the catalog names')), out.lines.join('\n'));
    const after = JSON.parse(readFileSync(ws.lockPath, 'utf8'));
    const embedKey = `https://huggingface.co/org/tiny/resolve/${PINNED}/config.json`;
    assert.deepEqual(after.files[embedKey], before.files[embedKey], 'kept');
    assert.equal(after.files['https://huggingface.co/mlc-ai/Tiny-MLC/resolve/main/params_shard_1.bin'].sha256, 'd'.repeat(64), 'the others are refreshed');
  });

  it('refuses an installed runtime binary that differs from the published one', async () => {
    const host = fakeHost();
    const ws = workspace(bytes('patched runtime'));
    const out = output();
    assert.equal(await main([], { root: ws.root, sources: sources(ws.ortFile), fetch: host.fetch, ...out }), 1);
    assert.ok(out.lines.some((l) => l.includes('differs from the published package')), out.lines.join('\n'));
  });

  it('keeps the file and exits 0 without network', async () => {
    const host = fakeHost();
    const ws = workspace(host.ort);
    await main([], { root: ws.root, sources: sources(ws.ortFile), fetch: host.fetch, ...output() });
    const before = readFileSync(ws.lockPath, 'utf8');
    host.state.offline = true;
    for (const argv of [[], ['--check']]) {
      const out = output();
      assert.equal(await main(argv, { root: ws.root, sources: sources(ws.ortFile), fetch: host.fetch, ...out }), 0, out.lines.join('\n'));
      assert.ok(out.lines.some((l) => l.startsWith('No network:')), out.lines.join('\n'));
      assert.equal(readFileSync(ws.lockPath, 'utf8'), before);
    }
  });

  it('exits 2 on a lock that is not JSON', async () => {
    const host = fakeHost();
    const ws = workspace(host.ort);
    writeFileSync(ws.lockPath, '{ not json');
    const out = output();
    assert.equal(await main(['--check'], { root: ws.root, sources: sources(ws.ortFile), fetch: host.fetch, ...out }), 2);
  });
});
