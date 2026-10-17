#!/usr/bin/env node
// Writes src/js/models/model-lock.json: the SHA-256 and size of every file the on-device runtimes
// download, keyed by the URL the browser stores the file under in Cache Storage. The app checks each
// downloaded file against it before the model answers (src/js/models/integrity.js).
//
// What it covers:
// - every WebLLM preset of src/js/webgpu/models.js (both precisions): mlc-chat-config.json,
//   tensor-cache.json, the tokenizer file WebLLM reads and every parameter shard from Hugging Face
//   (at "main", which WebLLM requests unpinned: the lock is what pins it), plus the compiled model
//   library from WebLLM's prebuilt list;
// - every file of the Transformers.js models in src/js/models/wasm-catalog.js at its pinned commit,
//   and of the embedding and NLI models in src/js/models/embed-catalog.js once that file exists;
// - the ONNX Runtime binary the build self-hosts, hashed from node_modules and compared with the
//   copy published on the npm CDN.
//
// Large files come with their SHA-256 from the Hugging Face API (Git LFS metadata), so nothing big is
// downloaded; small files, the model libraries and the runtime binary are downloaded and hashed.
// When a model cannot be fetched, its earlier entries are kept and the run says which.
//
// Usage: node scripts/models-lock.mjs           refresh the lock from the model hosts
//        node scripts/models-lock.mjs --check   exit 1 when the lock is invalid, misses a catalog file
//                                               or no longer matches the hosts (changes nothing)
// Without network both modes keep the file, print a notice and exit 0 (the offline part of --check
// still runs). Exit codes: 0 ok, 1 outdated, invalid or a model failed, 2 the lock cannot be read.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { webllmBase } from '../src/js/models/integrity.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOCK_FILE = 'src/js/models/model-lock.json';
export const LOCK_FORMAT = 'starpi.model-lock/v1';
const EMBED_CATALOG_FILE = 'src/js/models/embed-catalog.js';
const HF = 'https://huggingface.co';
const NPM_CDN = 'https://cdn.jsdelivr.net/npm';
const ORT_PACKAGE = 'onnxruntime-web';
const ORT_FILE = 'dist/ort-wasm-simd-threaded.wasm';
/** Files downloaded at once within one model. */
const CONCURRENCY = 4;
const TIMEOUT_MS = 120_000;

/**
 * @typedef {{ sha256: string, size: number }} LockEntry
 * @typedef {{ format: string, files: Record<string, LockEntry> }} ModelLock
 * @typedef {(url: string, init?: RequestInit) => Promise<Response>} FetchLike
 *
 * @typedef {{ kind: 'webllm', id: string, repo: string, base: string, lib: string }} WebllmSource
 * @typedef {{ kind: 'hf', id: string, repo: string, revision: string, files: ReadonlyArray<readonly [string, number, string?]> }} HfSource
 * @typedef {{ kind: 'ort', id: string, version: string, file: string }} OrtSource
 * @typedef {WebllmSource | HfSource | OrtSource} LockSource
 *
 * @typedef {object} Context
 * @property {FetchLike} fetch
 * @property {Map<string, Promise<LockEntry & { bytes?: Uint8Array }>>} blobs  digests by Git blob id, shared across repositories
 */

/** A model host could not be reached at all (as opposed to answering with an error). */
export class OfflineError extends Error {
  /** @param {string} message @param {unknown} [cause] */
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'OfflineError';
  }
}

// ---------------------------------------------------------------------------------------------
// Sources

/**
 * Download URL (and Transformers.js cache key) of a file at a pinned commit.
 * @param {{ repo: string, revision: string }} src
 * @param {string} file
 */
export function hfFileUrl(src, file) {
  return `${HF}/${src.repo}/resolve/${encodeURIComponent(src.revision)}/${file}`;
}

/**
 * @param {ReadonlyArray<{ model_id: string, model: string, model_lib: string }>} records WebLLM's prebuilt model list
 * @param {readonly string[]} ids the model ids the app may load
 * @returns {WebllmSource[]}
 */
export function webllmSources(records, ids) {
  return ids.map((id) => {
    const record = records.find((m) => m.model_id === id);
    if (!record) throw new Error(`${id} is not in WebLLM's prebuilt model list`);
    const base = webllmBase(record.model);
    const repo = new URL(base).pathname.split('/resolve/')[0].slice(1);
    return { kind: 'webllm', id: `webllm:${id}`, repo, base, lib: record.model_lib };
  });
}

/**
 * @param {string} prefix id prefix ('wasm', 'embed', 'nli')
 * @param {Record<string, { repo: string, revision: string, files: ReadonlyArray<readonly [string, number, string?]> }>} catalog
 * @returns {HfSource[]}
 */
export function hfSources(prefix, catalog) {
  return Object.entries(catalog).map(([key, src]) => ({ kind: 'hf', id: `${prefix}:${key}`, repo: src.repo, revision: src.revision, files: src.files }));
}

/** The onnxruntime-web package the build bundles (the copy next to Transformers.js wins). */
function ortPackageDir() {
  const nested = path.join(ROOT, 'node_modules/@huggingface/transformers/node_modules', ORT_PACKAGE);
  return existsSync(path.join(nested, 'package.json')) ? nested : path.join(ROOT, 'node_modules', ORT_PACKAGE);
}

/** @returns {OrtSource} */
export function ortSource() {
  const dir = ortPackageDir();
  const { version } = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  return { kind: 'ort', id: 'ort', version, file: path.join(dir, ORT_FILE) };
}

/** Lock key of the self-hosted runtime binary: the published package file it must equal. */
export function ortKey(/** @type {{ version: string }} */ src) {
  return `npm:${ORT_PACKAGE}@${src.version}/${ORT_FILE}`;
}

/**
 * Every source of the lock: the app's catalogs, WebLLM's prebuilt list for the presets, and the
 * embedding catalog when it exists.
 * @returns {Promise<LockSource[]>}
 */
export async function appSources() {
  const [{ prebuiltAppConfig }, { ALL_MODEL_IDS }, { WASM_CATALOG }] = await Promise.all([
    import('@mlc-ai/web-llm'),
    import('../src/js/webgpu/models.js'),
    import('../src/js/models/wasm-catalog.js'),
  ]);
  /** @type {LockSource[]} */
  const sources = [...webllmSources(prebuiltAppConfig.model_list, ALL_MODEL_IDS), ...hfSources('wasm', WASM_CATALOG)];
  if (existsSync(path.join(ROOT, EMBED_CATALOG_FILE))) {
    const embed = await import(pathToFileURL(path.join(ROOT, EMBED_CATALOG_FILE)).href);
    if (embed.EMBED_CATALOG) sources.push(...hfSources('embed', embed.EMBED_CATALOG));
    if (embed.NLI_CATALOG) sources.push(...hfSources('nli', embed.NLI_CATALOG));
  }
  sources.push(ortSource());
  return sources;
}

/**
 * Whether a lock key belongs to a source (entries of failed sources are kept by this).
 * @param {LockSource} src
 * @param {string} key
 */
export function ownsKey(src, key) {
  if (src.kind === 'webllm') return key === src.lib || key.startsWith(src.base);
  if (src.kind === 'hf') return key.startsWith(`${HF}/${src.repo}/resolve/${encodeURIComponent(src.revision)}/`);
  return key === ortKey(src);
}

// ---------------------------------------------------------------------------------------------
// Fetching

/** @param {unknown} err */
function isNetworkError(err) {
  if (err instanceof OfflineError) return true;
  const cause = /** @type {{ cause?: { code?: string }, code?: string, name?: string }} */ (err);
  const code = cause?.cause?.code ?? cause?.code ?? '';
  return (err instanceof TypeError && /fetch failed/i.test(err.message)) || /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(code) || cause?.name === 'TimeoutError';
}

/**
 * GET with retries on 429 and 5xx; a host that cannot be reached throws OfflineError.
 * @param {Context} ctx
 * @param {string} url
 */
async function get(ctx, url) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await ctx.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      if (attempt < 3 && isNetworkError(err)) continue;
      throw isNetworkError(err) ? new OfflineError(`${new URL(url).host} cannot be reached`, err) : err;
    }
    if (res.ok) return res;
    await res.body?.cancel().catch(() => {});
    if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
}

/**
 * Downloads a file and hashes it while it streams.
 * @param {Context} ctx
 * @param {string} url
 * @param {{ keep?: boolean }} [options] keep the bytes (small files that are parsed too)
 * @returns {Promise<LockEntry & { bytes?: Uint8Array }>}
 */
async function download(ctx, url, options = {}) {
  const res = await get(ctx, url);
  const hash = createHash('sha256');
  /** @type {Uint8Array[]} */
  const parts = [];
  let size = 0;
  if (res.body) {
    for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (/** @type {unknown} */ (res.body))) {
      hash.update(chunk);
      size += chunk.byteLength;
      if (options.keep) parts.push(chunk);
    }
  }
  const entry = { sha256: hash.digest('hex'), size };
  return options.keep ? { ...entry, bytes: Buffer.concat(parts) } : entry;
}

/**
 * The files of a repository at a revision, with the commit it resolves to.
 * @param {Context} ctx
 * @param {string} repo
 * @param {string} revision
 * @returns {Promise<{ sha: string, files: Map<string, { size: number, blobId?: string, lfs?: { sha256: string, size: number } }> }>}
 */
async function hfTree(ctx, repo, revision) {
  const res = await get(ctx, `${HF}/api/models/${repo}/revision/${encodeURIComponent(revision)}?blobs=true`);
  const data = /** @type {{ sha?: string, siblings?: Array<{ rfilename: string, size: number, blobId?: string, lfs?: { sha256: string, size: number } }> }} */ (await res.json());
  if (!data.sha || !Array.isArray(data.siblings)) throw new Error(`${repo}@${revision}: unexpected answer from the Hugging Face API`);
  return { sha: data.sha, files: new Map(data.siblings.map((s) => [s.rfilename, s])) };
}

/**
 * SHA-256 and size of one repository file: from the LFS metadata when the file is stored in LFS,
 * otherwise downloaded at the resolved commit (once per Git blob across repositories).
 * @param {Context} ctx
 * @param {string} repo
 * @param {{ sha: string, files: Awaited<ReturnType<typeof hfTree>>['files'] }} tree
 * @param {string} file
 * @param {{ keep?: boolean }} [options]
 */
async function hfDigest(ctx, repo, tree, file, options = {}) {
  const info = tree.files.get(file);
  if (!info) throw new Error(`${repo}: ${file} is missing upstream`);
  if (info.lfs && !options.keep) return { sha256: info.lfs.sha256, size: info.lfs.size };
  const memoKey = info.blobId && `${info.blobId}${options.keep ? ':bytes' : ''}`;
  const pending = (memoKey && ctx.blobs.get(memoKey)) || download(ctx, `${HF}/${repo}/resolve/${tree.sha}/${file}`, options);
  if (memoKey) ctx.blobs.set(memoKey, pending);
  const entry = await pending;
  const expected = info.lfs?.size ?? info.size;
  if (entry.size !== expected) throw new Error(`${repo}: ${file} downloaded with ${entry.size} bytes, the listing says ${expected}`);
  return entry;
}

/**
 * Runs `fn` over the items, a few at a time.
 * @template T, R
 * @param {readonly T[]} items
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function pool(items, fn) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** @param {LockEntry & { bytes?: unknown }} entry @returns {LockEntry} */
const plain = ({ sha256, size }) => ({ sha256, size });

/**
 * @param {Context} ctx
 * @param {WebllmSource} src
 * @returns {Promise<Record<string, LockEntry>>}
 */
async function lockWebllm(ctx, src) {
  const tree = await hfTree(ctx, src.repo, 'main');
  const [config, tensorCache] = await Promise.all([hfDigest(ctx, src.repo, tree, 'mlc-chat-config.json', { keep: true }), hfDigest(ctx, src.repo, tree, 'tensor-cache.json', { keep: true })]);
  const chat = JSON.parse(new TextDecoder().decode(config.bytes));
  const tensors = JSON.parse(new TextDecoder().decode(tensorCache.bytes));
  /** @type {string[]} */
  const tokenizerFiles = Array.isArray(chat.tokenizer_files) ? chat.tokenizer_files : [];
  // WebLLM reads tokenizer.json, or tokenizer.model when the model has no tokenizer.json.
  const tokenizer = ['tokenizer.json', 'tokenizer.model'].find((f) => tokenizerFiles.includes(f));
  if (!tokenizer) throw new Error(`${src.repo}: mlc-chat-config.json names no tokenizer WebLLM can read`);
  const shards = [...new Set((Array.isArray(tensors.records) ? tensors.records : []).map((/** @type {{ dataPath: string }} */ r) => r.dataPath))];
  if (shards.length === 0) throw new Error(`${src.repo}: tensor-cache.json lists no shards`);

  const files = [tokenizer, ...shards];
  const digests = await pool(files, (file) => hfDigest(ctx, src.repo, tree, file));
  /** @type {Record<string, LockEntry>} */
  const entries = {
    [`${src.base}mlc-chat-config.json`]: plain(config),
    [`${src.base}tensor-cache.json`]: plain(tensorCache),
  };
  files.forEach((file, i) => {
    entries[new URL(file, src.base).href] = plain(digests[i]);
  });
  entries[src.lib] = plain(await download(ctx, src.lib));
  return entries;
}

/**
 * @param {Context} ctx
 * @param {HfSource} src
 * @returns {Promise<Record<string, LockEntry>>}
 */
async function lockHf(ctx, src) {
  const tree = await hfTree(ctx, src.repo, src.revision);
  if (tree.sha !== src.revision) throw new Error(`${src.repo}: revision ${src.revision} resolves to ${tree.sha}; pin a full commit id`);
  const digests = await pool(src.files, ([file]) => hfDigest(ctx, src.repo, tree, file));
  /** @type {Record<string, LockEntry>} */
  const entries = {};
  src.files.forEach(([file, size, sha256], i) => {
    const d = digests[i];
    if (d.size !== size) throw new Error(`${src.repo}: ${file} has ${d.size} bytes upstream, the catalog says ${size}`);
    if (sha256 && sha256 !== d.sha256) throw new Error(`${src.repo}: ${file} has another SHA-256 upstream than the catalog names`);
    entries[hfFileUrl(src, file)] = plain(d);
  });
  return entries;
}

/**
 * @param {OrtSource} src
 * @returns {LockEntry}
 */
export function ortLocalEntry(src) {
  const bytes = readFileSync(src.file);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength };
}

/**
 * The installed binary, which must equal the published one.
 * @param {Context} ctx
 * @param {OrtSource} src
 */
async function lockOrt(ctx, src) {
  const local = ortLocalEntry(src);
  const published = await download(ctx, `${NPM_CDN}/${ORT_PACKAGE}@${src.version}/${ORT_FILE}`);
  if (published.sha256 !== local.sha256 || published.size !== local.size) {
    throw new Error(`the installed ${ORT_PACKAGE}@${src.version} binary differs from the published package`);
  }
  return { [ortKey(src)]: local };
}

/**
 * Fetches every source. A source that fails keeps its entries from `previous`.
 * @param {readonly LockSource[]} sources
 * @param {{ fetch: FetchLike, previous?: Record<string, LockEntry>, log?: (line: string) => void }} options
 * @returns {Promise<{ files: Record<string, LockEntry>, offline: string[], failed: Array<{ id: string, message: string }> }>}
 */
export async function collectLock(sources, options) {
  /** @type {Context} */
  const ctx = { fetch: options.fetch, blobs: new Map() };
  const log = options.log ?? (() => {});
  const previous = options.previous ?? {};
  /** @type {Record<string, LockEntry>} */
  const files = {};
  /** @type {string[]} */
  const offline = [];
  /** @type {Array<{ id: string, message: string }>} */
  const failed = [];
  for (const src of sources) {
    try {
      const entries = src.kind === 'webllm' ? await lockWebllm(ctx, src) : src.kind === 'hf' ? await lockHf(ctx, src) : await lockOrt(ctx, src);
      Object.assign(files, entries);
      log(`${src.id}: ${Object.keys(entries).length} files`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isNetworkError(err)) offline.push(src.id);
      else failed.push({ id: src.id, message });
      for (const [key, entry] of Object.entries(previous)) if (ownsKey(src, key)) files[key] = entry;
      // Once a host is unreachable the next model would wait for the same timeouts: stop early.
      if (isNetworkError(err) && offline.length === 1 && Object.keys(files).length === 0) {
        for (const rest of sources.slice(sources.indexOf(src) + 1)) {
          offline.push(rest.id);
          for (const [key, entry] of Object.entries(previous)) if (ownsKey(rest, key)) files[key] = entry;
        }
        break;
      }
    }
  }
  return { files, offline, failed };
}

// ---------------------------------------------------------------------------------------------
// The lock file

/**
 * One entry per line, keys sorted, so a refresh shows as a readable diff.
 * @param {Record<string, LockEntry>} files
 */
export function lockText(files) {
  const keys = Object.keys(files).sort();
  const lines = keys.map((key, i) => `    ${JSON.stringify(key)}: { "sha256": ${JSON.stringify(files[key].sha256)}, "size": ${files[key].size} }${i < keys.length - 1 ? ',' : ''}`);
  return `{\n  "format": ${JSON.stringify(LOCK_FORMAT)},\n  "files": {${lines.length ? `\n${lines.join('\n')}\n  ` : ''}}\n}\n`;
}

/**
 * Problems a lock has without asking any host: its shape, catalog files it misses or pins with
 * another size, and a runtime binary that is not the installed one.
 * @param {unknown} lock
 * @param {readonly LockSource[]} sources
 * @returns {{ problems: string[], stale: string[] }} stale: entries no source owns (kept, but unused)
 */
export function validateLock(lock, sources) {
  /** @type {string[]} */
  const problems = [];
  const value = /** @type {Partial<ModelLock> | null} */ (lock && typeof lock === 'object' ? lock : null);
  if (!value || value.format !== LOCK_FORMAT) problems.push(`format is not ${LOCK_FORMAT}`);
  const files = value?.files && typeof value.files === 'object' ? value.files : {};
  for (const [key, entry] of Object.entries(files)) {
    if (!/^(https:\/\/|npm:)/.test(key)) problems.push(`${key}: not an https URL or npm file`);
    if (!entry || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) problems.push(`${key}: sha256 is not 64 lowercase hex digits`);
    if (!entry || !Number.isSafeInteger(entry.size) || entry.size <= 0) problems.push(`${key}: size is not a positive integer`);
  }
  /** @param {string} key */
  const need = (key) => {
    if (!files[key]) problems.push(`missing ${key}`);
    return files[key];
  };
  for (const src of sources) {
    if (src.kind === 'webllm') {
      need(`${src.base}mlc-chat-config.json`);
      need(`${src.base}tensor-cache.json`);
      need(src.lib);
      if (!Object.keys(files).some((key) => key.startsWith(src.base) && /\.bin$/.test(key))) problems.push(`${src.id}: no parameter shards`);
    } else if (src.kind === 'hf') {
      for (const [file, size, sha256] of src.files) {
        const entry = need(hfFileUrl(src, file));
        if (entry && entry.size !== size) problems.push(`${hfFileUrl(src, file)}: size ${entry.size}, the catalog says ${size}`);
        if (entry && sha256 && entry.sha256 !== sha256) problems.push(`${hfFileUrl(src, file)}: another SHA-256 than the catalog names`);
      }
    } else {
      const entry = need(ortKey(src));
      if (entry && existsSync(src.file)) {
        const local = ortLocalEntry(src);
        if (local.sha256 !== entry.sha256 || local.size !== entry.size) problems.push(`${ortKey(src)}: the installed binary is not the locked one`);
      }
    }
  }
  const stale = Object.keys(files).filter((key) => !sources.some((src) => ownsKey(src, key)));
  return { problems, stale };
}

/**
 * @param {Record<string, LockEntry>} have
 * @param {Record<string, LockEntry>} want
 */
function differences(have, want) {
  /** @type {string[]} */
  const out = [];
  for (const key of Object.keys(want)) {
    if (!have[key]) out.push(`new upstream: ${key}`);
    else if (have[key].sha256 !== want[key].sha256 || have[key].size !== want[key].size) out.push(`changed upstream: ${key}`);
  }
  for (const key of Object.keys(have)) if (!want[key]) out.push(`gone upstream: ${key}`);
  return out;
}

/**
 * @param {string[]} argv
 * @param {{ fetch?: FetchLike, sources?: readonly LockSource[], root?: string, log?: (line: string) => void, error?: (line: string) => void, write?: boolean }} [io]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, io = {}) {
  const log = io.log ?? ((line) => console.log(line));
  const error = io.error ?? ((line) => console.error(line));
  const check = argv.includes('--check');
  const file = path.join(io.root ?? ROOT, LOCK_FILE);

  const currentText = existsSync(file) ? readFileSync(file, 'utf8') : null;
  /** @type {ModelLock} */
  let current = { format: LOCK_FORMAT, files: {} };
  if (currentText !== null) {
    try {
      current = JSON.parse(currentText);
    } catch {
      error(`${LOCK_FILE} cannot be read as JSON`);
      return 2;
    }
  }
  const sources = io.sources ?? (await appSources());

  if (check) {
    const { problems, stale } = validateLock(current, sources);
    for (const p of problems) error(`${LOCK_FILE}: ${p}`);
    if (stale.length) log(`${LOCK_FILE}: ${stale.length} entries belong to no current model (kept until the next refresh)`);
    if (problems.length) return 1;
  }

  const { files, offline, failed } = await collectLock(
    // --check compares the hosts with the lock only for the sources it covers.
    sources,
    { fetch: io.fetch ?? fetch, previous: current.files ?? {}, log },
  );
  for (const f of failed) error(`${f.id}: ${f.message}; earlier entries kept`);
  if (offline.length === sources.length) {
    log(`No network: ${LOCK_FILE} kept as it is${check ? ' (checked offline only)' : ''}.`);
    return failed.length ? 1 : 0;
  }
  if (offline.length) log(`Not reachable, earlier entries kept: ${offline.join(', ')}`);

  if (check) {
    const owned = Object.fromEntries(Object.entries(current.files ?? {}).filter(([key]) => sources.some((src) => ownsKey(src, key))));
    const diff = differences(owned, files);
    for (const line of diff) error(line);
    if (diff.length) error(`${LOCK_FILE} is outdated; run node scripts/models-lock.mjs`);
    else log(`${LOCK_FILE} matches the model hosts`);
    return diff.length || failed.length ? 1 : 0;
  }

  const text = lockText(files);
  if (text === currentText) {
    log(`${LOCK_FILE} is up to date (${Object.keys(files).length} files)`);
  } else {
    if (io.write !== false) writeFileSync(file, text);
    log(`${LOCK_FILE} written (${Object.keys(files).length} files)`);
  }
  return failed.length ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
