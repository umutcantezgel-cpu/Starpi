#!/usr/bin/env node
// Writes tests/fixtures/grounding/paraphrase-vectors.json: the embeddings behind the hybrid
// retrieval test (tests/unit/hybrid-paraphrase.test.mjs). Every source section of the paraphrase
// corpora (kb-sample.json, sources-v2.json, paraphrases.json) is embedded as a passage, and every
// statement of paraphrases.json, without its citation, as a query; the test asks whether the cited
// section is found. The vectors come from the app's default embedding model
// (src/js/models/embed-catalog.js) through Transformers.js, one text per call like a query in the
// browser, and are stored int8-quantised exactly as the app stores them (src/js/rag/vectors.js).
//
// Needs the network (Hugging Face, about 136 MB on the first run) and onnxruntime-node, which
// @huggingface/transformers installs:  node scripts/embed-paraphrases.mjs [--cache <dir>]
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EMBED_MODEL, embedInput, embedModelId, embedSource, pinnedEmbedUrl } from '../src/js/models/embed-catalog.js';
import { quantizeInt8 } from '../src/js/rag/vectors.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'tests/fixtures/grounding');
const OUT = path.join(FIXTURES, 'paraphrase-vectors.json');
const LABEL = /\s*\[Doc: [^\]]+\]/g;

/** @param {string} name */
async function readFixture(name) {
  return JSON.parse(await readFile(path.join(FIXTURES, name), 'utf8'));
}

/** @param {{ data: Int8Array, scale: number }} q */
function pack(q) {
  return [Number(q.scale.toPrecision(9)), Buffer.from(q.data.buffer, q.data.byteOffset, q.data.byteLength).toString('base64')];
}

async function main() {
  const cacheAt = process.argv.indexOf('--cache');
  const cacheDir = cacheAt > 0 ? process.argv[cacheAt + 1] : path.join(os.tmpdir(), 'starpi-embed-cache');
  const { env, pipeline } = await import('@huggingface/transformers');
  const src = embedSource(DEFAULT_EMBED_MODEL);
  env.allowLocalModels = false;
  env.cacheDir = cacheDir;
  const upstream = env.fetch ?? fetch;
  // The same pinning as the browser worker: only this model's files, at its revision.
  env.fetch = async (/** @type {RequestInfo | URL} */ input, /** @type {RequestInit | undefined} */ init) => {
    const url = input instanceof Request ? input.url : String(input);
    const pinned = pinnedEmbedUrl(src, url);
    if (!pinned) throw new TypeError(`Blocked a request outside the pinned model: ${url}`);
    return upstream(pinned, init);
  };
  const extract = await pipeline('feature-extraction', src.repo, { revision: src.revision, dtype: src.dtype, device: 'cpu' });
  /** @param {'query' | 'passage'} kind @param {string} text */
  const embed = async (kind, text) => {
    const out = await extract([embedInput(src, kind, text)], { pooling: src.pooling, normalize: src.normalize });
    return pack(quantizeInt8(/** @type {Float32Array} */ (out.data)));
  };

  const paraphrases = await readFixture('paraphrases.json');
  const corpora = { ...(await readFixture('kb-sample.json')), ...(await readFixture('sources-v2.json')), ...paraphrases.corpora };
  /** @type {Record<string, [number, string]>} */
  const passages = {};
  for (const [corpus, sections] of Object.entries(corpora)) {
    for (const s of /** @type {Array<{ label: string, text: string }>} */ (sections)) passages[`${corpus}|${s.label}`] = await embed('passage', s.text);
  }
  /** @type {Record<string, [number, string]>} */
  const queries = {};
  for (const item of /** @type {Array<{ id: string, answer: string }>} */ (paraphrases.items)) queries[item.id] = await embed('query', item.answer.replace(LABEL, '').trim());

  const fixture = {
    description:
      'Embeddings for tests/unit/hybrid-paraphrase.test.mjs, written by scripts/embed-paraphrases.mjs: every section of kb-sample.json, sources-v2.json and paraphrases.json as a passage (key "<corpus>|<label>"), every statement of paraphrases.json without its citation as a query (key: item id). Each entry is [scale, base64 of the int8 values], value = int8 * scale.',
    model: embedModelId(src),
    dim: src.dim,
    passages,
    queries,
  };
  await writeFile(OUT, `${JSON.stringify(fixture)}\n`);
  console.log(`${Object.keys(passages).length} passages and ${Object.keys(queries).length} queries written to ${path.relative(ROOT, OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
